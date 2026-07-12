import { requireConfig } from "../config.js";
import { pollFbApprovals } from "./review.js";
import { startWebhookServer } from "./webhook.js";

/**
 * Starts both halves of the fb-responder in one process: the webhook HTTP
 * server (receives Meta events) and the Telegram approval poll loop (gates
 * what gets sent back). They're coupled by design — the poll loop only
 * exists to approve/reject what the webhook server generates — so one
 * systemd unit covers both instead of splitting them like the content
 * pipeline's poll/serve services.
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
  await pollFbApprovals(); // never resolves
}
