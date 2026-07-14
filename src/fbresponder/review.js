import { config } from "../config.js";
import { tg } from "../lib/telegram.js";
import { getEvent, isPaused, pauseSender, resumeSender, updateEvent } from "./db.js";
import { replyToComment, sendMessengerMessage } from "./graph.js";

function label(eventType) {
  return eventType === "comment" ? "💬 Comment" : "✉️ Message";
}

// Same button in both states, toggled in place by editing the message's
// reply_markup rather than needing a fresh message to show the opposite
// action — see handleTakeoverCallback.
function takeoverKeyboard(fromId, paused) {
  return {
    inline_keyboard: [
      [
        paused
          ? { text: "▶️ Resume bot", callback_data: `resume:${fromId}` }
          : { text: "⏸ Take over", callback_data: `pause:${fromId}` },
      ],
    ],
  };
}

// Sent instead of the normal auto-reply notification when a sender is
// already paused — no AI call happens for them (see webhook.js), so this is
// just a passthrough of what they said, with the button to hand back to the
// bot right there.
export async function notifyPausedIncoming(event) {
  if (!event.from_id) return; // no sender id to resume on later, nothing to attach the button to
  await tg("sendMessage", {
    chat_id: config.telegramChatId,
    text:
      `🙋 ${label(event.event_type)} from ${event.from_name || "someone"} (#${event.id}) — you're handling this one:\n\n` +
      event.content,
    reply_markup: takeoverKeyboard(event.from_id, true),
  });
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
// Carries the "take over" button so a bad reply can be caught mid-conversation
// and handed to a human for the rest of that thread.
export async function notifyFbSent(event) {
  await tg("sendMessage", {
    chat_id: config.telegramChatId,
    text: `🚀 Auto-replied to ${label(event.event_type).toLowerCase()} from ${event.from_name || "someone"} (#${event.id}):\n${event.proposed_reply}`,
    reply_markup: event.from_id ? takeoverKeyboard(event.from_id, false) : undefined,
  });
}

// Toggles pause/resume for a sender and flips the button in place on the
// same Telegram message, so there's no separate "list" to manage — whichever
// notification you're looking at is always up to date.
async function handleTakeoverCallback(action, fromId, cb) {
  if (!fromId) return;
  if (action === "pause") {
    pauseSender(fromId);
  } else {
    resumeSender(fromId);
  }
  await tg("answerCallbackQuery", {
    callback_query_id: cb.id,
    text:
      action === "pause"
        ? "⏸ Paused — bot will stay quiet for this person until you resume."
        : "▶️ Resumed — bot is back on for this person.",
  });
  await tg("editMessageReplyMarkup", {
    chat_id: cb.message.chat.id,
    message_id: cb.message.message_id,
    reply_markup: takeoverKeyboard(fromId, action === "pause"),
  });
}

async function handleCallback(cb) {
  const [action, arg] = String(cb.data ?? "").split(":");
  if (action === "pause" || action === "resume") return handleTakeoverCallback(action, arg, cb);
  if (action !== "fbapprove" && action !== "fbreject") return;

  const eventId = Number(arg);
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
