import crypto from "node:crypto";
import http from "node:http";
import { config } from "../config.js";
import {
  createEvent,
  eventExists,
  findPendingNudge,
  getEvent,
  recentEventsFrom,
  updateEvent,
} from "./db.js";
import { generateReply } from "./generateReply.js";
import { fetchPostContext, replyToComment, sendMessengerMessage } from "./graph.js";
import { notifyFbSent, sendForFbApproval } from "./review.js";

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
        await replyToComment(event.platform_event_id, event.proposed_reply);
      } else {
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

  // If we're waiting on a reply to a "did everything go ok?" nudge from this
  // sender, this message closes that loop — the reply should suggest post
  // promotion, and the nudge stops being "pending" either way (whether or
  // not the topic is still photo_help, we don't want to re-nudge on it).
  const pendingNudge = findPendingNudge(senderId);

  const history = recentEventsFrom(senderId, "message");
  const { reply: proposedReply, topic } = await generateReply({
    eventType: "message",
    content: text,
    history,
    suggestPromotion: !!pendingNudge,
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
  if (!pendingNudge && topic === "photo_help" && finalEvent.status === "sent") {
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
