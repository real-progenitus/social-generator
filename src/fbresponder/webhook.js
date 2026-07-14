import crypto from "node:crypto";
import http from "node:http";
import { config } from "../config.js";
import {
  createEvent,
  eventExists,
  findPendingNudge,
  FOLLOW_UP_TOPICS,
  getEvent,
  isPaused,
  recentEventsFrom,
  updateEvent,
} from "./db.js";
import { generateReply } from "./generateReply.js";
import { fetchPostContext, replyToComment, sendMessengerMessage, sendTypingOn } from "./graph.js";
import { notifyFbSent, notifyPausedIncoming, sendForFbApproval } from "./review.js";

// A sender currently under human takeover gets no AI call at all (that's the
// whole point — stop paying for and sending bot replies to them) and no
// follow-up-nudge tracking. The message is just logged and passed through to
// Telegram so the "resume" button is right there when the human's done.
async function recordPausedIncoming({ eventType, platformEventId, fromId, fromName, content, postContext }) {
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
  });
  await notifyPausedIncoming(getEvent(eventId));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

async function routeGeneratedReply(event) {
  const autoReply =
    event.event_type === "message" ? config.fbAutoReplyMessages : config.fbAutoReplyComments;
  if (autoReply) {
    try {
      if (event.event_type === "comment") {
        await wait(typingDelayMs(event.proposed_reply));
        await replyToComment(event.platform_event_id, event.proposed_reply);
      } else {
        await sendTypingOn(event.from_id);
        await wait(typingDelayMs(event.proposed_reply));
        await sendMessengerMessage(event.from_id, event.proposed_reply);
      }
      updateEvent(event.id, { status: "sent" });
      await notifyFbSent({ ...event, status: "sent" });
    } catch (err) {
      updateEvent(event.id, { status: "failed" });
      console.error(`[fbresponder/webhook] auto-reply failed for #${event.id}:`, err);
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

async function handleCommentChange(change) {
  const value = change.value ?? {};
  if (value.verb !== "add") return;

  const fromId = value.from?.id;
  if (fromId && fromId === config.facebookPageId) return; // our own post/reply, re-delivered

  if (value.item === "comment") return handleComment(value, fromId);
  if (PAGE_POST_ITEMS.has(value.item) && value.post_id && !value.comment_id) {
    return handlePagePost(value, fromId);
  }
}

async function handleComment(value, fromId) {
  const commentId = value.comment_id;
  if (!commentId || eventExists(commentId)) return;

  // Photo/sticker-only comments (e.g. someone attaching extra pet photos as
  // follow-up comments) arrive as separate "add" events with no text. There's
  // nothing to reply to, and generating one anyway just spams Telegram with
  // near-duplicate review cards where the model invents a reply from history.
  const message = (value.message ?? "").trim();
  if (!message) return;

  const postContext = value.post_id ? await fetchPostContext(value.post_id) : "";

  if (isPaused(fromId)) {
    return recordPausedIncoming({
      eventType: "comment",
      platformEventId: commentId,
      fromId,
      fromName: value.from?.name,
      content: message,
      postContext,
    });
  }

  const history = recentEventsFrom(fromId, "comment");
  const { reply: proposedReply, topic } = await generateReply({
    eventType: "comment",
    content: message,
    postContext,
    fromName: value.from?.name,
    history,
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
  });

  await routeGeneratedReply(getEvent(eventId));
}

async function handlePagePost(value, fromId) {
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
    });
  }

  const history = recentEventsFrom(fromId, "comment");
  const { reply: proposedReply, topic } = await generateReply({
    eventType: "comment",
    content: message,
    fromName: value.from?.name,
    history,
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
  });

  await routeGeneratedReply(getEvent(eventId));
}

async function handleMessagingEvent(messaging) {
  const text = messaging.message?.text;
  const mid = messaging.message?.mid;
  const senderId = messaging.sender?.id;
  if (!text || !mid || messaging.message?.is_echo) return; // is_echo = our own sent message, re-delivered
  if (eventExists(mid)) return;

  if (isPaused(senderId)) {
    return recordPausedIncoming({ eventType: "message", platformEventId: mid, fromId: senderId, content: text });
  }

  // If we're waiting on a reply to a check-in nudge from this sender, this
  // message closes that loop — the reply should react to whatever the nudge
  // was about (see FOLLOW_UP_NOTES in generateReply.js), and the nudge stops
  // being "pending" either way (whether or not the topic repeats, we don't
  // want to re-nudge on it).
  const pendingNudge = findPendingNudge(senderId);

  const history = recentEventsFrom(senderId, "message");
  const { reply: proposedReply, topic } = await generateReply({
    eventType: "message",
    content: text,
    history,
    followUpTopic: pendingNudge?.topic ?? null,
  });

  const eventId = createEvent({
    platform_event_id: mid,
    event_type: "message",
    from_id: senderId ?? null,
    from_name: null,
    content: text,
    post_context: null,
    proposed_reply: proposedReply,
    topic,
  });

  if (pendingNudge) updateEvent(pendingNudge.id, { followup_status: "replied" });

  await routeGeneratedReply(getEvent(eventId));

  // Only schedule a follow-up once the answer has actually reached them —
  // not while it's stuck pending Telegram review or if the send failed.
  const finalEvent = getEvent(eventId);
  if (!pendingNudge && FOLLOW_UP_TOPICS.includes(topic) && finalEvent.status === "sent") {
    updateEvent(eventId, { followup_status: "awaiting" });
  }
}

async function processPayload(body) {
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "feed") continue;
      try {
        await handleCommentChange(change);
      } catch (err) {
        console.error("[fbresponder/webhook] comment handling failed:", err);
      }
    }
    for (const messaging of entry.messaging ?? []) {
      try {
        await handleMessagingEvent(messaging);
      } catch (err) {
        console.error("[fbresponder/webhook] message handling failed:", err);
      }
    }
  }
}

/**
 * Receives Meta Page webhooks (comments via the "feed" field, Messenger DMs
 * via "messaging") for the ifound Page. GET handles the subscription
 * verification handshake; POST verifies X-Hub-Signature-256 before trusting
 * the payload, acks immediately (Meta expects a fast response), then
 * generates a reply and either queues it for Telegram approval or sends it
 * directly when the relevant auto-reply flag is set (FB_AUTO_REPLY_MESSAGES
 * / FB_AUTO_REPLY_COMMENTS, checked independently per event type).
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
