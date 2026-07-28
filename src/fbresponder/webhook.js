import crypto from "node:crypto";
import http from "node:http";
import { config } from "../config.js";
import {
  createEvent,
  eventExists,
  findPendingNudge,
  FOLLOW_UP_TOPICS,
  getEvent,
  getSenderLocale,
  hasNewerMessageFrom,
  isPaused,
  recentEventsFrom,
  setSenderLocale,
  updateEvent,
} from "./db.js";
import { generateReply } from "./generateReply.js";
import {
  fetchPostContext,
  fetchUserLocale,
  replyToComment,
  sendMessengerMessage,
  sendTypingOn,
} from "./graph.js";
import { getMentionReplyText } from "./mentionTemplates.js";
import { getPageByFbId } from "./pages.js";
import { notifyFbSendFailed, notifyFbSent, notifyPausedIncoming, sendForFbApproval } from "./review.js";

// A sender currently under human takeover gets no AI call at all (that's the
// whole point — stop paying for and sending bot replies to them) and no
// follow-up-nudge tracking. The message is just logged and passed through to
// Telegram so the "resume" button is right there when the human's done.
async function recordPausedIncoming({ eventType, platformEventId, fromId, fromName, content, postContext, page }) {
  const eventId = createEvent({
    platform_event_id: platformEventId,
    event_type: eventType,
    from_id: fromId ?? null,
    from_name: fromName ?? null,
    content,
    post_context: postContext ?? null,
    proposed_reply: null,
    topic: null,
    status: "human_takeover",
    page_key: page.key,
  });
  await notifyPausedIncoming(getEvent(eventId));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A DM is held this long before we generate a reply. If the sender fires off
// more messages in the meantime (two quick bubbles, or a photo plus text),
// they land as their own rows and only the last one actually replies — see
// handleMessagingEvent — so a burst gets one combined answer and one Claude
// call instead of one reply per message. Stacks before routeGeneratedReply's
// own 2–9s typing delay. Env-overridable mainly so tests can shrink it.
// Was 10000 until 2026-07-28: production data showed real consecutive-bubble
// gaps of 11s and 20s both landing just outside a 10s window, splitting one
// burst into 3 separate replies (see fbresponder memory) — 30s comfortably
// covers that gap distribution at the cost of 30s of added latency on every
// reply, burst or not.
const COALESCE_WINDOW_MS = Number(process.env.FB_COALESCE_WINDOW_MS) || 30000;

// Placeholder stored/shown for a photo-only DM (no caption) so the row, the
// model context, and the Telegram notification all read sensibly.
const IMAGE_ONLY_CONTENT = "[photo, no caption]";

// The AI call itself only takes ~3s, and replies are often 100+ characters -
// sent that fast, back to back, it reads as obviously automated rather than
// a person typing. Hold the send back a bit longer, scaled to roughly how
// long a person would take to type the reply, with jitter so the pacing
// isn't suspiciously uniform.
function typingDelayMs(text) {
  const base = 1500 + text.length * 60; // ~1.5s "read + think" + ~60ms/char
  const jitter = 0.85 + Math.random() * 0.3; // +/-15%
  return Math.min(Math.max(base * jitter, 2000), 9000);
}

function verifySignature(rawBody, signatureHeader) {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const expected = crypto
    .createHmac("sha256", config.facebookAppSecret)
    .update(rawBody)
    .digest("hex");
  const expectedBuf = Buffer.from(expected, "hex");
  const givenBuf = Buffer.from(signatureHeader.slice("sha256=".length), "hex");
  return expectedBuf.length === givenBuf.length && crypto.timingSafeEqual(expectedBuf, givenBuf);
}

async function routeGeneratedReply(event, page) {
  const autoReply =
    event.event_type === "message"
      ? config.fbAutoReplyMessages
      : event.event_type === "mention"
        ? config.fbAutoReplyMentions
        : config.fbAutoReplyComments;
  if (autoReply) {
    try {
      if (event.event_type === "message") {
        await sendTypingOn(event.from_id, page.token);
        await wait(typingDelayMs(event.proposed_reply));
        await sendMessengerMessage(event.from_id, event.proposed_reply, page.token);
      } else {
        // "comment" and "mention" both reply as a comment on the relevant
        // post/comment object — a mention reply is posted on the mentioning
        // post, since that's the only public reply surface for a mention.
        await wait(typingDelayMs(event.proposed_reply));
        await replyToComment(event.platform_event_id, event.proposed_reply, page.token);
      }
      updateEvent(event.id, { status: "sent" });
      await notifyFbSent({ ...event, status: "sent" });
    } catch (err) {
      updateEvent(event.id, { status: "failed" });
      console.error(`[fbresponder/webhook] auto-reply failed for #${event.id}:`, err);
      try {
        await notifyFbSendFailed({ ...event, status: "failed" }, err);
      } catch (notifyErr) {
        console.error(`[fbresponder/webhook] failed to notify about #${event.id} failure:`, notifyErr);
      }
    }
  } else {
    await sendForFbApproval(event);
  }
}

// New posts placed directly on the Page's own timeline by someone else (not
// a comment on our content). Same "feed" webhook field as comments, but Meta
// reports these with one of these `item` values instead of "comment", and no
// comment_id. People often post their lost/found plea straight to the Page
// wall instead of using the app — same misunderstanding as comments/DMs, so
// it gets the same treatment: reply with a comment on their post.
const PAGE_POST_ITEMS = new Set(["status", "photo", "video", "link", "note", "share"]);

async function handleCommentChange(change, page) {
  const value = change.value ?? {};
  if (value.verb !== "add") return;

  const fromId = value.from?.id;
  if (fromId && fromId === page.pageId) return; // our own post/reply, re-delivered

  if (value.item === "comment") return handleComment(value, fromId, page);
  if (PAGE_POST_ITEMS.has(value.item) && value.post_id && !value.comment_id) {
    return handlePagePost(value, fromId, page);
  }
}

async function handleComment(value, fromId, page) {
  const commentId = value.comment_id;
  if (!commentId || eventExists(commentId)) return;

  // Photo/sticker-only comments (e.g. someone attaching extra pet photos as
  // follow-up comments) arrive as separate "add" events with no text. There's
  // nothing to reply to, and generating one anyway just spams Telegram with
  // near-duplicate review cards where the model invents a reply from history.
  const message = (value.message ?? "").trim();
  if (!message) return;

  const postContext = value.post_id ? await fetchPostContext(value.post_id, page.token) : "";

  if (isPaused(fromId)) {
    return recordPausedIncoming({
      eventType: "comment",
      platformEventId: commentId,
      fromId,
      fromName: value.from?.name,
      content: message,
      postContext,
      page,
    });
  }

  const history = recentEventsFrom(fromId, "comment");
  const { reply: proposedReply, topic } = await generateReply({
    eventType: "comment",
    content: message,
    postContext,
    fromName: value.from?.name,
    history,
    page,
  });

  const eventId = createEvent({
    platform_event_id: commentId,
    event_type: "comment",
    from_id: fromId ?? null,
    from_name: value.from?.name ?? null,
    content: message,
    post_context: postContext,
    proposed_reply: proposedReply,
    topic,
    page_key: page.key,
  });

  await routeGeneratedReply(getEvent(eventId), page);
}

async function handlePagePost(value, fromId, page) {
  const postId = value.post_id;
  if (eventExists(postId)) return;

  const message = (value.message ?? "").trim();
  if (!message) return; // photo/video-only post with no caption, nothing to reply to

  if (isPaused(fromId)) {
    return recordPausedIncoming({
      eventType: "comment",
      platformEventId: postId,
      fromId,
      fromName: value.from?.name,
      content: message,
      page,
    });
  }

  const history = recentEventsFrom(fromId, "comment");
  const { reply: proposedReply, topic } = await generateReply({
    eventType: "comment",
    content: message,
    fromName: value.from?.name,
    history,
    page,
  });

  const eventId = createEvent({
    platform_event_id: postId,
    event_type: "comment",
    from_id: fromId ?? null,
    from_name: value.from?.name ?? null,
    content: message,
    post_context: null,
    proposed_reply: proposedReply,
    topic,
    page_key: page.key,
  });

  await routeGeneratedReply(getEvent(eventId), page);
}

// Someone tags/mentions the Page in their own post or comment — distinct
// from a comment on our own content. Never seen live in this codebase before
// (unlike "feed"/"messaging", both validated against real Meta traffic
// during the original rollout) — field names below are best-effort per
// general Meta Page-webhook convention, not a captured real payload. Log the
// raw change object on the first several live firings to confirm the actual
// shape before trusting this parsing.
async function handleMentionChange(change, page) {
  const value = change.value ?? {};
  if (value.verb && value.verb !== "add") return;

  const objectId = value.comment_id ?? value.post_id;
  if (!objectId || eventExists(objectId)) return;

  const fromId = value.sender_id ?? value.from?.id;
  if (fromId && fromId === page.pageId) return; // defensive echo filter, unconfirmed whether this field even echoes

  const fromName = value.sender_name ?? value.from?.name ?? null;

  if (isPaused(fromId)) {
    return recordPausedIncoming({
      eventType: "mention",
      platformEventId: objectId,
      fromId,
      fromName,
      content: "[mention]",
      page,
    });
  }

  // Fetched purely for a readable Telegram notification — the reply itself
  // is a fixed template, no AI call reads this.
  const postText = await fetchPostContext(objectId, page.token);
  const proposedReply = getMentionReplyText(page);

  const eventId = createEvent({
    platform_event_id: objectId,
    event_type: "mention",
    from_id: fromId ?? null,
    from_name: fromName,
    content: postText || "[mention, no readable text]",
    post_context: null,
    proposed_reply: proposedReply,
    topic: null,
    page_key: page.key,
  });

  await routeGeneratedReply(getEvent(eventId), page);
}

async function handleMessagingEvent(messaging, page) {
  const msg = messaging.message;
  const mid = msg?.mid;
  const senderId = messaging.sender?.id;
  if (!msg || !mid || msg.is_echo) return; // is_echo = our own sent message, re-delivered

  const text = (msg.text ?? "").trim();
  // Only real photos count as "they want to report something" — stickers, GIF
  // reactions and thumbs-up/like taps (other attachment types) are noise and
  // stay ignored, same as before.
  const hasImage = (msg.attachments ?? []).some((a) => a.type === "image");
  if (!text && !hasImage) return; // nothing actionable (empty, or sticker/like only)
  if (eventExists(mid)) return; // already processed (Meta re-delivery)

  const content = text || IMAGE_ONLY_CONTENT;
  const imageOnly = !text && hasImage;

  if (isPaused(senderId)) {
    return recordPausedIncoming({ eventType: "message", platformEventId: mid, fromId: senderId, content, page });
  }

  // Record the message straight away — before the coalescing hold and the AI
  // call. This (a) makes the mid dedup via the UNIQUE constraint even against
  // a re-delivery that races us, so we never pay for a duplicate Claude call,
  // and (b) makes this message visible to any sibling in the same burst so
  // exactly one of them ends up replying.
  const eventId = createEvent({
    platform_event_id: mid,
    event_type: "message",
    from_id: senderId ?? null,
    from_name: null,
    content,
    post_context: null,
    proposed_reply: null,
    topic: null,
    status: "received",
    page_key: page.key,
  });

  // Hold briefly, then bow out if the sender has since said something newer —
  // that later message is the one that answers the whole burst (this row stays
  // as unanswered context for it). Only the latest message in a burst survives
  // to the single generateReply call below.
  await wait(COALESCE_WINDOW_MS);
  if (hasNewerMessageFrom(senderId, eventId)) {
    updateEvent(eventId, { status: "coalesced" });
    return;
  }

  // If we're waiting on a reply to a check-in nudge from this sender, this
  // message closes that loop — the reply should react to whatever the nudge
  // was about (see FOLLOW_UP_NOTES in generateReply.js), and the nudge stops
  // being "pending" either way (whether or not the topic repeats, we don't
  // want to re-nudge on it).
  const pendingNudge = findPendingNudge(senderId);

  // Exclude this row from its own history; the earlier, still-unanswered burst
  // messages remain so the single reply addresses everything they said.
  const history = recentEventsFrom(senderId, "message", { excludeId: eventId });

  // Image-only DMs have no text to detect language from, and if this is also
  // the sender's first message, no history either — the account's own
  // Messenger locale is a real signal instead of blindly guessing. Cached
  // indefinitely per sender (see db.js), so this only ever costs one Graph
  // API call per sender's lifetime, not per message.
  let accountLocale = null;
  if (imageOnly) {
    const cached = getSenderLocale(senderId);
    if (cached.cached) {
      accountLocale = cached.locale;
    } else {
      accountLocale = await fetchUserLocale(senderId, page.token);
      setSenderLocale(senderId, accountLocale);
    }
  }

  let proposedReply;
  let topic;
  try {
    ({ reply: proposedReply, topic } = await generateReply({
      eventType: "message",
      content,
      history,
      followUpTopic: pendingNudge?.topic ?? null,
      imageOnly,
      accountLocale,
      page,
    }));
  } catch (err) {
    updateEvent(eventId, { status: "failed" });
    throw err;
  }
  updateEvent(eventId, { proposed_reply: proposedReply, topic });

  if (pendingNudge) updateEvent(pendingNudge.id, { followup_status: "replied" });

  await routeGeneratedReply(getEvent(eventId), page);

  // Only schedule a follow-up once the answer has actually reached them —
  // not while it's stuck pending Telegram review or if the send failed.
  const finalEvent = getEvent(eventId);
  if (!pendingNudge && FOLLOW_UP_TOPICS.includes(topic) && finalEvent.status === "sent") {
    updateEvent(eventId, { followup_status: "awaiting" });
  }
}

// Pages whose entry.id showed up in a webhook but aren't configured (missing
// id/token env vars, or a stray Page not meant for this app) — warned once
// each so a flood of events from an unconfigured Page doesn't spam the logs.
const warnedUnconfiguredPageIds = new Set();

async function processPayload(body) {
  for (const entry of body.entry ?? []) {
    const page = getPageByFbId(entry.id);
    if (!page) {
      if (!warnedUnconfiguredPageIds.has(entry.id)) {
        warnedUnconfiguredPageIds.add(entry.id);
        console.warn(`[fbresponder/webhook] entry for unconfigured Page id ${entry.id} — skipping`);
      }
      continue;
    }

    for (const change of entry.changes ?? []) {
      try {
        if (change.field === "feed") await handleCommentChange(change, page);
        else if (change.field === "mention") await handleMentionChange(change, page);
      } catch (err) {
        console.error("[fbresponder/webhook] comment/mention handling failed:", err);
      }
    }
    for (const messaging of entry.messaging ?? []) {
      try {
        await handleMessagingEvent(messaging, page);
      } catch (err) {
        console.error("[fbresponder/webhook] message handling failed:", err);
      }
    }
  }
}

/**
 * Receives Meta Page webhooks (comments/mentions via the "feed"/"mention"
 * fields, Messenger DMs via "messaging") for every configured ifound Page
 * (see pages.js) — Meta batches every subscribed Page of this app into the
 * same POST's entry[], disambiguated by entry.id. GET handles the
 * subscription verification handshake; POST verifies X-Hub-Signature-256
 * before trusting the payload, acks immediately (Meta expects a fast
 * response), then generates a reply and either queues it for Telegram
 * approval or sends it directly when the relevant auto-reply flag is set
 * (FB_AUTO_REPLY_MESSAGES / FB_AUTO_REPLY_COMMENTS / FB_AUTO_REPLY_MENTIONS,
 * checked independently per event type).
 */
export function startWebhookServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");

    if (req.method === "GET" && url.pathname === "/webhook") {
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");
      if (mode === "subscribe" && token === config.facebookWebhookVerifyToken) {
        res.writeHead(200, { "Content-Type": "text/plain" }).end(challenge ?? "");
      } else {
        res.writeHead(403).end("forbidden");
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/webhook") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const rawBody = Buffer.concat(chunks);
        console.log(
          `[fbresponder/webhook] POST received, ${rawBody.length} bytes, signature header ${
            req.headers["x-hub-signature-256"] ? "present" : "MISSING"
          }`,
        );
        if (!verifySignature(rawBody, req.headers["x-hub-signature-256"])) {
          console.error("[fbresponder/webhook] signature verification failed — rejecting");
          res.writeHead(403).end("invalid signature");
          return;
        }
        res.writeHead(200).end("EVENT_RECEIVED");

        let body;
        try {
          body = JSON.parse(rawBody.toString("utf8"));
        } catch (err) {
          console.error("[fbresponder/webhook] invalid JSON payload:", err);
          return;
        }
        processPayload(body).catch((err) =>
          console.error("[fbresponder/webhook] payload processing failed:", err),
        );
      });
      return;
    }

    res.writeHead(404).end("not found");
  });

  server.listen(config.fbWebhookPort, () => {
    console.log(`[fbresponder/webhook] listening on http://0.0.0.0:${config.fbWebhookPort}/webhook`);
  });
  return server;
}
