import { config } from "../config.js";
import { tg } from "../lib/telegram.js";
import { getEvent, updateEvent } from "./db.js";
import { replyToComment, sendMessengerMessage } from "./graph.js";

function label(eventType) {
  return eventType === "comment" ? "💬 Comment" : "✉️ Message";
}

async function deliver(event) {
  if (event.event_type === "comment") {
    return replyToComment(event.platform_event_id, event.proposed_reply);
  }
  return sendMessengerMessage(event.from_id, event.proposed_reply);
}

/**
 * Send a generated reply to the review chat with Approve / Reject buttons.
 * The webhook server then exits back to Meta; `npm run fb-bot`'s polling
 * loop (same process) processes the decision.
 */
export async function sendForFbApproval(event) {
  await tg("sendMessage", {
    chat_id: config.telegramChatId,
    text:
      `${label(event.event_type)} from ${event.from_name || "someone"} (#${event.id})\n\n` +
      (event.post_context ? `On post: "${event.post_context}"\n\n` : "") +
      `Them: ${event.content}\n\n` +
      `Proposed reply:\n${event.proposed_reply}`,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Approve & send", callback_data: `fbapprove:${event.id}` },
          { text: "❌ Reject", callback_data: `fbreject:${event.id}` },
        ],
      ],
    },
  });
}

// Only used when FB_AUTO_REPLY=true — posted after the fact for visibility,
// not as a gate (the reply has already gone out by the time this sends).
export async function notifyFbSent(event) {
  await tg("sendMessage", {
    chat_id: config.telegramChatId,
    text: `🚀 Auto-replied to ${label(event.event_type).toLowerCase()} from ${event.from_name || "someone"} (#${event.id}):\n${event.proposed_reply}`,
  });
}

async function handleCallback(cb) {
  const [action, idStr] = String(cb.data ?? "").split(":");
  if (action !== "fbapprove" && action !== "fbreject") return;

  const eventId = Number(idStr);
  const event = getEvent(eventId);

  const reply = async (text) => {
    await tg("answerCallbackQuery", { callback_query_id: cb.id });
    await tg("sendMessage", { chat_id: config.telegramChatId, text });
  };

  if (!event) return reply(`Event #${eventId} not found.`);
  if (event.status !== "pending_review")
    return reply(`Event #${eventId} is '${event.status}', not pending review — ignoring.`);

  if (action === "fbapprove") {
    // Flip status before the async send closes the idempotency window
    // immediately, so a double-tap during the request can't send twice.
    updateEvent(eventId, { status: "approved" });
    try {
      await deliver(event);
      updateEvent(eventId, { status: "sent" });
      await reply(`✅ Reply sent for #${eventId}.`);
    } catch (err) {
      updateEvent(eventId, { status: "failed" });
      await reply(`⚠️ Send failed for #${eventId}: ${err.message}`);
    }
  } else if (action === "fbreject") {
    updateEvent(eventId, { status: "rejected" });
    await reply(`❌ #${eventId} rejected — no reply sent.`);
  }
}

/**
 * Long-poll Telegram for approve/reject button presses on generated fb
 * replies. Runs inside the same process as the webhook server (fbresponder
 * main.js), not a separate systemd unit.
 */
export async function pollFbApprovals() {
  console.log("[fbresponder/review] polling Telegram for approvals…");
  let offset = 0;
  for (;;) {
    const updates = await tg("getUpdates", {
      offset,
      timeout: 50,
      allowed_updates: ["callback_query"],
    });
    for (const update of updates) {
      offset = update.update_id + 1;
      if (update.callback_query) {
        try {
          await handleCallback(update.callback_query);
        } catch (err) {
          console.error("[fbresponder/review] callback handling failed:", err);
        }
      }
    }
  }
}
