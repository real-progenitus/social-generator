import crypto from "node:crypto";
import http from "node:http";
import { config } from "../config.js";
import { createEvent, eventExists, getEvent, updateEvent } from "./db.js";
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
  if (config.fbAutoReply) {
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

async function handleCommentChange(change) {
  const value = change.value ?? {};
  if (value.item !== "comment" || value.verb !== "add") return;

  const commentId = value.comment_id;
  const fromId = value.from?.id;
  if (!commentId || eventExists(commentId)) return;
  if (fromId && fromId === config.facebookPageId) return; // our own reply, re-delivered

  const postContext = value.post_id ? await fetchPostContext(value.post_id) : "";
  const proposedReply = await generateReply({
    eventType: "comment",
    content: value.message ?? "",
    postContext,
    fromName: value.from?.name,
  });

  const eventId = createEvent({
    platform_event_id: commentId,
    event_type: "comment",
    from_id: fromId ?? null,
    from_name: value.from?.name ?? null,
    content: value.message ?? "",
    post_context: postContext,
    proposed_reply: proposedReply,
  });

  await routeGeneratedReply(getEvent(eventId));
}

async function handleMessagingEvent(messaging) {
  const text = messaging.message?.text;
  const mid = messaging.message?.mid;
  const senderId = messaging.sender?.id;
  if (!text || !mid || messaging.message?.is_echo) return; // is_echo = our own sent message, re-delivered
  if (eventExists(mid)) return;

  const proposedReply = await generateReply({ eventType: "message", content: text });

  const eventId = createEvent({
    platform_event_id: mid,
    event_type: "message",
    from_id: senderId ?? null,
    from_name: null,
    content: text,
    post_context: null,
    proposed_reply: proposedReply,
  });

  await routeGeneratedReply(getEvent(eventId));
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
 * directly when FB_AUTO_REPLY=true.
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
