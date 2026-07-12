import "dotenv/config";
import path from "node:path";

function bool(value, fallback) {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

export const config = {
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  claudeModel: process.env.CLAUDE_MODEL ?? "claude-sonnet-5",

  xaiApiKey: process.env.XAI_API_KEY ?? "",
  grokImageModel: process.env.GROK_IMAGE_MODEL ?? "grok-2-image",

  // Path to a local image file — when set, generateCover uses it verbatim
  // instead of calling the xAI Grok API. For testing the render/review/
  // publish steps without burning a Grok credit each run.
  localCoverImage: process.env.LOCAL_COVER_IMAGE ?? "",

  // "stylized" | "photoreal" — stylized by default; photoreal likeness of real
  // musicians carries right-of-publicity and Meta policy risk (see README §2.2)
  artistImageMode:
    process.env.ARTIST_IMAGE_MODE === "photoreal" ? "photoreal" : "stylized",

  reviewRequired: bool(process.env.REVIEW_REQUIRED, true),
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
  telegramChatId: process.env.TELEGRAM_CHAT_ID ?? "",

  igUserId: process.env.IG_USER_ID ?? "",
  metaAccessToken: process.env.META_ACCESS_TOKEN ?? "",

  publicMediaBaseUrl: (process.env.PUBLIC_MEDIA_BASE_URL ?? "").replace(/\/$/, ""),
  mediaServerPort: Number(process.env.MEDIA_SERVER_PORT ?? 8787),

  dbPath: path.resolve(process.env.DB_PATH ?? "./data/state.db"),
  outputDir: path.resolve(process.env.OUTPUT_DIR ?? "./output"),
  postHandle: process.env.POST_HANDLE ?? "@electronic.music.facts",

  mockMode: bool(process.env.MOCK_MODE, false),

  // "music" (default, Bass Vault) or "food" (bitemeweekly) — selects which
  // generate/cover/render step implementations pipeline.js loads.
  account: process.env.ACCOUNT ?? "music",

  // Facebook Page comment/message auto-responder (fbresponder/) — unused by
  // the content pipeline, defaults keep it inert for every other account.
  facebookPageId: process.env.FB_PAGE_ID ?? "",
  facebookPageAccessToken: process.env.FB_PAGE_ACCESS_TOKEN ?? "",
  facebookAppSecret: process.env.FB_APP_SECRET ?? "",
  facebookWebhookVerifyToken: process.env.FB_WEBHOOK_VERIFY_TOKEN ?? "",
  // Independent so DMs (mostly low-risk redirect/FAQ) can go fully automatic
  // without also removing the review gate on comments (which can touch
  // ownership claims on specific lost/found items).
  fbAutoReplyMessages: bool(process.env.FB_AUTO_REPLY_MESSAGES, false),
  fbAutoReplyComments: bool(process.env.FB_AUTO_REPLY_COMMENTS, false),
  fbWebhookPort: Number(process.env.FB_WEBHOOK_PORT ?? 8791),
};

export function requireConfig(keys) {
  const missing = keys.filter((k) => !config[k]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required configuration: ${missing.join(", ")}. Set them in .env (see .env.example).`,
    );
  }
}
