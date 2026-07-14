import "dotenv/config";
import path from "node:path";

function bool(value, fallback) {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

export const config = {
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  claudeModel: process.env.CLAUDE_MODEL ?? "claude-sonnet-5",

  // DeepSeek (OpenAI-compatible, https://api.deepseek.com) — the cheap,
  // knowledge-only half of the music account's A/B fact generation (see
  // generateFact.js). deepseekShare is the fraction of *historical*-pillar
  // posts routed to DeepSeek instead of the Claude+web_search flow; tunable via
  // env so the split can be dialed without a deploy. NOTE: the deepseek-chat /
  // deepseek-reasoner aliases deprecate 2026-07-24 in favor of
  // deepseek-v4-flash — after that, set DEEPSEEK_MODEL=deepseek-v4-flash.
  deepseekApiKey: process.env.DEEPSEEK_API_KEY ?? "",
  deepseekModel: process.env.DEEPSEEK_MODEL ?? "deepseek-chat",
  deepseekShare: Number(process.env.DEEPSEEK_SHARE ?? 0.5),

  // Tavily search (https://api.tavily.com) — grounds the recent_news pillar,
  // which DeepSeek's training cutoff can't cover. Free tier is 1,000
  // searches/month; tavilyPriceUsd (per search) is 0 until that's exceeded.
  tavilyApiKey: process.env.TAVILY_API_KEY ?? "",
  tavilyPriceUsd: Number(process.env.TAVILY_PRICE_USD ?? 0),
  // Optional comma-separated domain whitelist for the recent_news Tavily search,
  // to keep results on electronic-music outlets and drop off-topic noise. Empty
  // => generateFact.js falls back to its built-in RECENT_NEWS_DOMAINS list.
  tavilyIncludeDomains: (process.env.TAVILY_INCLUDE_DOMAINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  xaiApiKey: process.env.XAI_API_KEY ?? "",
  grokImageModel: process.env.GROK_IMAGE_MODEL ?? "grok-2-image",
  // Second model the food account's cover generator alternates in against
  // grokImageModel, to compare quality/cost side by side over time — see
  // generateFoodCover.js. Unused by the music (bass_vault) pipeline.
  grokImageModelAlt: process.env.GROK_IMAGE_MODEL_ALT ?? "grok-imagine-image",

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

  // Shared AI-usage metrics store — deliberately NOT the per-account DB_PATH, so
  // every account process (pipeline crons, poll, fb-bot) records into one file
  // the dashboard reads. All services run with cwd /opt/social-generator, so the
  // repo-relative default resolves to the same file for every account.
  metricsDbPath: path.resolve(process.env.METRICS_DB_PATH ?? "./data/metrics.db"),
  // Cost/latency dashboard HTTP server (raw node:http, bound to 127.0.0.1 and
  // fronted by Caddy). 8787 = media server, 8791 = fb webhook, so default 8788.
  metricsServerPort: Number(process.env.METRICS_SERVER_PORT ?? 8788),

  mockMode: bool(process.env.MOCK_MODE, false),

  // "music" (default, Bass Vault) or "food" (bitemeweekly) — selects which
  // generate/cover/render step implementations pipeline.js loads.
  account: process.env.ACCOUNT ?? "music",

  // Human-facing service name used to label cost/usage metrics, so the
  // dashboard reads bass__vault / bitemeweekly rather than the internal
  // music/food. Derived from the post handle (each account's .env sets its own).
  accountLabel: (process.env.POST_HANDLE ?? process.env.ACCOUNT ?? "music").replace(/^@/, ""),

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
