import { requireConfig } from "../config.js";
import { startFollowUpLoop } from "./followup.js";
import { pollFbApprovals } from "./review.js";
import { startWebhookServer } from "./webhook.js";

/**
 * Starts all three halves of the fb-responder in one process: the webhook
 * HTTP server (receives Meta events), the Telegram approval poll loop (gates
 * what gets sent back), and the follow-up nudge loop (proactive photo_help
 * check-ins). They're coupled by design — the poll loop only exists to
 * approve/reject what the webhook server generates, and the follow-up loop
 * only fires for events the webhook server created — so one systemd unit
 * covers all three instead of splitting them like the content pipeline's
 * poll/serve services.
 */
export async function startFbResponder() {
  requireConfig([
    "anthropicApiKey",
    "telegramBotToken",
    "telegramChatId",
    "facebookPageId",
    "facebookPageAccessToken",
    "facebookAppSecret",
    "facebookWebhookVerifyToken",
  ]);

  startWebhookServer();
  startFollowUpLoop();
  await pollFbApprovals(); // never resolves
}
