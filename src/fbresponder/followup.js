import { config } from "../config.js";
import { callClaude } from "../lib/claudeClient.js";
import { tg } from "../lib/telegram.js";
import { findDueFollowUps, updateEvent } from "./db.js";
import { sendMessengerMessage } from "./graph.js";

// How long to wait after answering a DM on a FOLLOW_UP_TOPICS topic (see
// db.js) with no reply before proactively checking in, and how often the
// loop scans for due nudges. 1h keeps every send comfortably inside Meta's
// 24h messaging window, so no message tag is needed.
const FOLLOW_UP_DELAY_MINUTES = 60;
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

// Per-topic instructions for the check-in nudge — what we're following up
// about differs (a stuck photo upload vs. never having posted at all), so
// each needs its own framing even though the send/schedule plumbing is shared.
const NUDGE_INSTRUCTIONS = {
  photo_help:
    "Detect the language of the message below and reply with ONLY a short, warm check-in in that same " +
    "language, asking if everything went okay with adding their photo. One short sentence, at most one " +
    "emoji. Output only the translated check-in text - no preamble, no quotation marks.",
  post_redirect:
    "Detect the language of the message below and reply with ONLY a short, warm check-in in that same " +
    "language, asking if they managed to post their lost/found item on ifound, or if they need any help " +
    "doing so. One short sentence, at most one emoji. Output only the translated check-in text - no " +
    "preamble, no quotation marks.",
};

const MOCK_NUDGES = {
  photo_help: "Hey, just checking in — did everything work out with the photo?",
  post_redirect: "Hey, just checking in — were you able to post it on ifound?",
};

const NUDGE_LABELS = {
  photo_help: "photo-help",
  post_redirect: "post-redirect",
};

async function craftNudgeText(priorReply, topic) {
  if (config.mockMode) return MOCK_NUDGES[topic] ?? MOCK_NUDGES.photo_help;

  const response = await callClaude({
    account: "ifound",
    operation: "fbNudge",
    model: config.claudeModel,
    max_tokens: 100,
    thinking: { type: "disabled" },
    system: NUDGE_INSTRUCTIONS[topic] ?? NUDGE_INSTRUCTIONS.photo_help,
    messages: [{ role: "user", content: priorReply }],
  });
  const text = response.content.find((b) => b.type === "text")?.text ?? "";
  return text.trim();
}

async function sendFollowUp(event) {
  // Detect language from our own already-sent reply, not the original DM
  // content - for image-only DMs, event.content is the hardcoded English
  // placeholder "[photo, no caption]" (see IMAGE_ONLY_CONTENT in
  // webhook.js), which carries no real language signal and previously made
  // the nudge default to English even when the initial reply correctly went
  // out in another language via the locale fallback.
  const text = await craftNudgeText(event.proposed_reply, event.topic);
  await sendMessengerMessage(event.from_id, text);
  updateEvent(event.id, { followup_status: "nudge_sent" });
  await tg("sendMessage", {
    chat_id: config.telegramChatId,
    text: `👋 Sent ${NUDGE_LABELS[event.topic] ?? "follow-up"} nudge to ${event.from_name || "someone"} (#${event.id}):\n${text}`,
  });
}

/**
 * Polls for DMs on a FOLLOW_UP_TOPICS topic (photo_help or post_redirect)
 * answered over an hour ago with no reply since, and sends each a one-time
 * check-in worded for its topic. Runs inside the fb-bot process alongside
 * the webhook server and Telegram poll loop.
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
    `[fbresponder/followup] polling for due follow-up nudges every ${CHECK_INTERVAL_MS / 60000} min`,
  );
}
