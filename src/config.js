import "dotenv/config";
import path from "node:path";

function bool(value, fallback) {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

// Declared credit for one provider, read from <PREFIX>_BUDGET_USD and
// <PREFIX>_BUDGET_SINCE. Most image/video providers expose no balance API at
// all, so the genbot shows "what you say you topped up, minus what this repo
// has spent since then" (see src/genbot/budgets.js). `since` is the date of
// that top-up — without it the sum would include spend the credit already
// covered — and defaults to the epoch, i.e. all recorded spend counts.
// usd null => no budget declared; the genbot then shows lifetime spend only.
function budget(prefix) {
  const usd = process.env[`${prefix}_BUDGET_USD`];
  return {
    usd: usd === undefined || usd === "" ? null : Number(usd),
    since: process.env[`${prefix}_BUDGET_SINCE`] || "1970-01-01",
  };
}

export const config = {
  // DeepSeek (OpenAI-compatible, https://api.deepseek.com) — since 2026-08-21
  // the only text model this repo calls; every account's generation and the
  // ifound responder run on it. deepseekShare is the fraction of
  // *historical*-pillar music posts written from DeepSeek's own knowledge
  // rather than grounded in a live Tavily search (see generateFact.js);
  // tunable via env so the split can be dialed without a deploy. NOTE: the deepseek-chat /
  // deepseek-reasoner aliases deprecate 2026-07-24 in favor of
  // deepseek-v4-flash — after that, set DEEPSEEK_MODEL=deepseek-v4-flash.
  deepseekApiKey: process.env.DEEPSEEK_API_KEY ?? "",
  deepseekModel: process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash",
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


  // Google Gemini — vision-only role in this codebase: reading image content
  // (e.g. OCR'ing a flyer's language) for the ifound DM responder, since
  // DeepSeek's API is text-only and Claude vision is the fallback engine, not
  // the primary one, right now. See generateReply.js's describeImageViaGemini.
  geminiApiKey: process.env.GEMINI_API_KEY ?? "",
  geminiVisionModel: process.env.GEMINI_VISION_MODEL ?? "gemini-2.5-flash",
  // Generation models for the Telegram genbot (src/genbot/) — separate from
  // the vision model above, which only reads images. The image model is the
  // "Nano Banana" family; the video model is Veo, which runs as a long-poll
  // operation rather than a single request.
  geminiImageModel: process.env.GEMINI_IMAGE_MODEL ?? "gemini-2.5-flash-image",
  geminiVideoModel: process.env.GEMINI_VIDEO_MODEL ?? "veo-3.0-generate-001",

  xaiApiKey: process.env.XAI_API_KEY ?? "",
  grokImageModel: process.env.GROK_IMAGE_MODEL ?? "grok-2-image",
  // Second model the food account's cover generator alternates in against
  // grokImageModel, to compare quality/cost side by side over time — see
  // generateFoodCover.js. Unused by the music (bass_vault) pipeline.
  grokImageModelAlt: process.env.GROK_IMAGE_MODEL_ALT ?? "grok-imagine-image",
  // Video generation for the genbot. Unlike the image endpoint this one is
  // asynchronous (POST returns a request_id you poll), so it runs through the
  // gen_jobs table — see src/lib/videogen/grokVideo.js.
  grokVideoModel: process.env.GROK_VIDEO_MODEL ?? "grok-imagine-video-1.5",
  // Clamped to xAI's accepted 1–15s range at call time.
  grokVideoSeconds: Number(process.env.GROK_VIDEO_SECONDS ?? 6),

  // OpenAI — image/video generation for the genbot only; nothing in the
  // content pipeline calls it. openaiAdminKey is optional and *different* from
  // the regular key: only an admin key (sk-admin-…) can read the org Costs
  // API, which is the sole way to get a real spend figure out of OpenAI. Left
  // unset, the genbot falls back to budget-minus-local-spend like xAI/Gemini.
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  openaiAdminKey: process.env.OPENAI_ADMIN_KEY ?? "",
  openaiImageModel: process.env.OPENAI_IMAGE_MODEL ?? "gpt-image-1",
  openaiVideoModel: process.env.OPENAI_VIDEO_MODEL ?? "sora-2",

  // fal.ai — an aggregator: one key and one prepaid balance covers FLUX,
  // Ideogram, Kling and the rest, so it adds several genbot agents for one
  // integration. It also exposes a real balance endpoint, which most direct
  // providers don't (see src/genbot/balances.js).
  falApiKey: process.env.FAL_API_KEY ?? "",

  // Dedicated video providers for the genbot. Both expose a real credit
  // balance; credits aren't dollars, so the *_USD_PER_CREDIT rates convert
  // them for display (check each provider's current plan — the defaults are
  // only a starting point).
  runwayApiKey: process.env.RUNWAY_API_KEY ?? "",
  runwayUsdPerCredit: Number(process.env.RUNWAY_USD_PER_CREDIT ?? 0.01),
  lumaApiKey: process.env.LUMA_API_KEY ?? "",
  lumaUsdPerCredit: Number(process.env.LUMA_USD_PER_CREDIT ?? 0.0004),

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
  // Mentions reply with a fixed template (no Claude call), so this defaults
  // on unlike the two flags above — there's no per-reply generation risk to
  // gate behind manual review first.
  fbAutoReplyMentions: bool(process.env.FB_AUTO_REPLY_MENTIONS, true),
  fbWebhookPort: Number(process.env.FB_WEBHOOK_PORT ?? 8791),

  // Per-provider declared credit, keyed by the same provider string used in
  // the api_calls table so budgets.js can join the two without a mapping.
  // Only consumed by the genbot; every other service ignores it.
  budgets: {
    xai: budget("XAI"),
    openai: budget("OPENAI"),
    gemini: budget("GEMINI"),
    fal: budget("FAL"),
    runway: budget("RUNWAY"),
    luma: budget("LUMA"),
    anthropic: budget("ANTHROPIC"),
    deepseek: budget("DEEPSEEK"),
  },

  // How long a live balance figure is reused before re-probing the provider.
  // Keeps a burst of /balance taps from hammering five APIs; short enough that
  // the number visibly moves after a generation.
  balanceCacheTtlMs: Number(process.env.BALANCE_CACHE_TTL_MS ?? 60_000),
};

export function requireConfig(keys) {
  const missing = keys.filter((k) => !config[k]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required configuration: ${missing.join(", ")}. Set them in .env (see .env.example).`,
    );
  }
}
