import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { tg } from "../lib/telegram.js";
import { findDueFollowUps, updateEvent } from "./db.js";
import { sendMessengerMessage } from "./graph.js";

// How long to wait after answering a photo_help DM with no reply before
// proactively checking in, and how often the loop scans for due nudges.
// 1h keeps every send comfortably inside Meta's 24h messaging window, so no
// message tag is needed.
const FOLLOW_UP_DELAY_MINUTES = 60;
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

const NUDGE_INSTRUCTION =
  "Detect the language of the message below and reply with ONLY a short, warm check-in in that same " +
  "language, asking if everything went okay with adding their photo. One short sentence, at most one " +
  "emoji. Output only the translated check-in text - no preamble, no quotation marks.";

async function craftNudgeText(originalContent) {
  if (config.mockMode) return "Hey, just checking in — did everything work out with the photo?";

  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const response = await client.messages.create({
    model: config.claudeModel,
    max_tokens: 100,
    thinking: { type: "disabled" },
    system: NUDGE_INSTRUCTION,
    messages: [{ role: "user", content: originalContent }],
  });
  const text = response.content.find((b) => b.type === "text")?.text ?? "";
  return text.trim();
}

async function sendFollowUp(event) {
  const text = await craftNudgeText(event.content);
  await sendMessengerMessage(event.from_id, text);
  updateEvent(event.id, { followup_status: "nudge_sent" });
  await tg("sendMessage", {
    chat_id: config.telegramChatId,
    text: `👋 Sent photo-help follow-up to ${event.from_name || "someone"} (#${event.id}):\n${text}`,
  });
}

/**
 * Polls for photo_help DMs answered over an hour ago with no reply since,
 * and sends each a one-time "did everything go ok?" check-in. Runs inside
 * the fb-bot process alongside the webhook server and Telegram poll loop.
 */
export function startFollowUpLoop() {
  setInterval(async () => {
    let due;
    try {
      due = findDueFollowUps(FOLLOW_UP_DELAY_MINUTES);
    } catch (err) {
      console.error("[fbresponder/followup] query failed:", err);
      return;
    }
    for (const event of due) {
      try {
        await sendFollowUp(event);
      } catch (err) {
        console.error(`[fbresponder/followup] send failed for #${event.id}:`, err);
      }
    }
  }, CHECK_INTERVAL_MS);
  console.log(
    `[fbresponder/followup] polling for due photo-help nudges every ${CHECK_INTERVAL_MS / 60000} min`,
  );
}
