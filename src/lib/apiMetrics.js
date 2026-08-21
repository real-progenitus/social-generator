import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

// Dedicated, shared metrics DB (separate from any account's state.db) so every
// process — pipeline crons, poll, fb-bot — records AI-usage rows into one place
// the dashboard reads. WAL + a busy timeout let multiple processes on the same
// host write concurrently. Mirrors the setup in src/db.js.
fs.mkdirSync(path.dirname(config.metricsDbPath), { recursive: true });

const db = new Database(config.metricsDbPath);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

db.exec(`
  CREATE TABLE IF NOT EXISTS api_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL DEFAULT (datetime('now')),
    account TEXT,
    provider TEXT NOT NULL,        -- 'anthropic' | 'xai'
    model TEXT,
    operation TEXT,                -- generateFact, fbReply, cover, ...
    duration_ms INTEGER,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cache_read_tokens INTEGER DEFAULT 0,
    cache_creation_tokens INTEGER DEFAULT 0,
    web_search_count INTEGER DEFAULT 0,
    image_count INTEGER DEFAULT 0,
    cost_usd REAL,
    status TEXT NOT NULL DEFAULT 'ok',   -- 'ok' | 'error'
    error_msg TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_api_calls_ts ON api_calls (ts);

  CREATE TABLE IF NOT EXISTS system_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL DEFAULT (datetime('now')),
    cpu_pct REAL,
    load1 REAL,
    load5 REAL,
    load15 REAL,
    cores INTEGER,
    mem_total_mb REAL,
    mem_used_mb REAL,
    mem_available_mb REAL,
    swap_used_mb REAL,
    swap_total_mb REAL,
    disk_total_gb REAL,
    disk_used_gb REAL
  );
  CREATE INDEX IF NOT EXISTS idx_system_samples_ts ON system_samples (ts);
`);

// Idempotent column addition for upgrading an existing metrics.db — CREATE
// TABLE IF NOT EXISTS won't add a column to a table that predates it. Same
// idiom as src/fbresponder/db.js. video_seconds exists because the genbot's
// video agents (Veo, Sora, Kling, Runway, Luma) all price per second of
// output, not per asset, so image_count can't carry their billable unit.
for (const [column, type] of [["video_seconds", "REAL DEFAULT 0"]]) {
  const exists = db
    .prepare("SELECT 1 FROM pragma_table_info('api_calls') WHERE name = ?")
    .get(column);
  if (!exists) db.exec(`ALTER TABLE api_calls ADD COLUMN ${column} ${type}`);
}

export const metricsDb = db;

// ---------------------------------------------------------------------------
// Pricing. Per 1M tokens for Claude; per image for xAI; per 1k web searches.
// KEEP CURRENT when a deployed model or provider price changes (see the
// check-deployed-model-before-cost-changes note): a stale rate silently skews
// every cost figure on the dashboard.
// ---------------------------------------------------------------------------
const MTOK = 1_000_000;

// Sonnet 5 has promotional input/output pricing through 2026-08-31, then
// reverts to standard. Computed per-row at record time so historical rows keep
// the rate that was actually in effect and the switch is automatic.
function sonnet5Rates() {
  const introEndsMs = Date.UTC(2026, 7, 31, 23, 59, 59); // Aug 31 2026 (month is 0-based)
  const intro = Date.now() <= introEndsMs;
  return intro
    ? { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }
    : { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
}

// Per-model $/MTok. cacheRead ≈ 0.1× input, cacheWrite (5-min TTL) = 1.25× input.
const CLAUDE_PRICING = {
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "claude-sonnet-5": sonnet5Rates, // function — resolved per record
};

// Anthropic web search: $10 per 1,000 requests.
const WEB_SEARCH_PER_REQUEST = 10 / 1000;

// DeepSeek $/MTok (V4 Flash, which deepseek-chat/deepseek-v4-flash both route
// to). cache-hit input is a ~98% discount off cache-miss. Keyed for both ids so
// the 2026-07-24 alias→v4-flash rename is a DEEPSEEK_MODEL env change, not a
// code edit. Unknown model → cost null, tokens still recorded (as with Claude).
const DEEPSEEK_FLASH_RATES = { input: 0.14, cacheRead: 0.0028, output: 0.28 };
const DEEPSEEK_PRICING = {
  "deepseek-chat": DEEPSEEK_FLASH_RATES,
  "deepseek-v4-flash": DEEPSEEK_FLASH_RATES,
};

// xAI image price per generated image, keyed by model (docs.x.ai, 1024x1024
// output — close enough to these carousels' portrait dimensions). Needed
// per-model rather than one flat rate now that generateFoodCover.js
// alternates grokImageModel/grokImageModelAlt in the same account: a single
// price would misprice whichever model doesn't match it. Verify against
// xAI's current pricing whenever a deployed GROK_IMAGE_MODEL(_ALT) changes.
// XAI_IMAGE_PRICE_USD is the fallback for any model not listed here
// (in practice, the legacy default grok-2-image).
const XAI_IMAGE_PRICING = {
  "grok-imagine-image-quality": 0.05,
  "grok-imagine-image": 0.02,
};

function xaiImagePrice(model) {
  return XAI_IMAGE_PRICING[model] ?? Number(process.env.XAI_IMAGE_PRICE_USD ?? 0.07);
}

// Per-asset prices for the genbot's non-xAI generation models, keyed by the
// exact model id sent to the provider. The genbot's registry passes its own
// unitPriceUsd through to recordImageCall, so this table is the fallback for
// a model whose registry entry omits a price — and the one place to correct a
// rate without touching src/genbot/registry.js. Verify against each
// provider's current pricing page when you change a deployed model id.
const GEN_IMAGE_PRICING = {
  // OpenAI gpt-image-1, 1024x1024 — quality tiers differ; this is 'high'.
  "gpt-image-1": 0.17,
  // Google Nano Banana / Imagen family.
  "gemini-2.5-flash-image": 0.039,
  "imagen-4.0-generate-001": 0.04,
  // fal.ai model ids are slash-paths.
  "fal-ai/flux-pro/v1.1-ultra": 0.06,
  "fal-ai/flux/dev": 0.025,
  "fal-ai/ideogram/v3": 0.06,
};

function claudeRates(model) {
  const entry = CLAUDE_PRICING[model];
  if (!entry) return null;
  return typeof entry === "function" ? entry() : entry;
}

function claudeCost({ inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, webSearchCount, model }) {
  const r = claudeRates(model);
  if (!r) return null; // unknown model — still record tokens/latency, cost null
  return (
    (inputTokens * r.input +
      outputTokens * r.output +
      cacheReadTokens * r.cacheRead +
      cacheCreationTokens * r.cacheWrite) /
      MTOK +
    webSearchCount * WEB_SEARCH_PER_REQUEST
  );
}

// DeepSeek splits prompt tokens into cache-hit vs cache-miss; each is priced
// differently, so cost is computed from the split, not the summed total.
function deepseekCost({ cacheMissTokens, cacheHitTokens, outputTokens, model }) {
  const r = DEEPSEEK_PRICING[model];
  if (!r) return null; // unknown model — still record tokens/latency, cost null
  return (
    (cacheMissTokens * r.input + cacheHitTokens * r.cacheRead + outputTokens * r.output) / MTOK
  );
}

const insertStmt = db.prepare(`
  INSERT INTO api_calls
    (account, provider, model, operation, duration_ms,
     input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
     web_search_count, image_count, video_seconds, cost_usd, status, error_msg)
  VALUES
    (@account, @provider, @model, @operation, @duration_ms,
     @input_tokens, @output_tokens, @cache_read_tokens, @cache_creation_tokens,
     @web_search_count, @image_count, @video_seconds, @cost_usd, @status, @error_msg)
`);

// Recording is best-effort: instrumentation must never break generation or a
// reply. Any DB/pricing error is logged and swallowed. video_seconds is
// defaulted here rather than at every call site, so the four recorders that
// predate the column stay unchanged.
function safeInsert(row) {
  try {
    insertStmt.run({ video_seconds: 0, ...row });
  } catch (err) {
    console.error("[apiMetrics] failed to record call:", err.message);
  }
}

/**
 * Record one Claude Messages API call. `usage` is the summed usage object
 * (input_tokens, output_tokens, cache_read_input_tokens,
 * cache_creation_input_tokens, and either web_search_requests or
 * server_tool_use.web_search_requests).
 */
export function recordClaudeCall({ account, model, operation, durationMs, usage = {}, status = "ok", error }) {
  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
  const cacheCreationTokens = usage.cache_creation_input_tokens ?? 0;
  const webSearchCount =
    usage.web_search_requests ?? usage.server_tool_use?.web_search_requests ?? 0;

  safeInsert({
    account: account ?? null,
    provider: "anthropic",
    model: model ?? null,
    operation: operation ?? null,
    duration_ms: durationMs ?? null,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_tokens: cacheReadTokens,
    cache_creation_tokens: cacheCreationTokens,
    web_search_count: webSearchCount,
    image_count: 0,
    cost_usd: claudeCost({
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      webSearchCount,
      model,
    }),
    status,
    error_msg: error ? String(error.message ?? error).slice(0, 500) : null,
  });
}

/**
 * Record one DeepSeek chat-completion call. `usage` is the OpenAI-style usage
 * object DeepSeek returns: prompt_tokens (total input), completion_tokens, and
 * the prompt_cache_hit_tokens / prompt_cache_miss_tokens split of the input.
 */
export function recordDeepSeekCall({ account, model, operation, durationMs, usage = {}, status = "ok", error }) {
  const promptTokens = usage.prompt_tokens ?? 0;
  const outputTokens = usage.completion_tokens ?? 0;
  const cacheHitTokens = usage.prompt_cache_hit_tokens ?? 0;
  // Fall back to (prompt - hit) when the miss field is absent, so cost is still
  // right on responses that only report the hit count.
  const cacheMissTokens = usage.prompt_cache_miss_tokens ?? Math.max(0, promptTokens - cacheHitTokens);

  safeInsert({
    account: account ?? null,
    provider: "deepseek",
    model: model ?? null,
    operation: operation ?? null,
    duration_ms: durationMs ?? null,
    input_tokens: promptTokens,
    output_tokens: outputTokens,
    cache_read_tokens: cacheHitTokens,
    cache_creation_tokens: 0,
    web_search_count: 0,
    image_count: 0,
    cost_usd: deepseekCost({ cacheMissTokens, cacheHitTokens, outputTokens, model }),
    status,
    error_msg: error ? String(error.message ?? error).slice(0, 500) : null,
  });
}

/**
 * Record one external search-provider call (e.g. Tavily) used to ground a fact.
 * Cost is per query; the count lands in web_search_count so the dashboard's
 * "Web" column reflects every search regardless of provider.
 */
export function recordSearchCall({ account, provider, operation, durationMs, queries = 1, unitPrice = 0, status = "ok", error }) {
  const count = status === "ok" ? queries : 0;
  safeInsert({
    account: account ?? null,
    provider: provider ?? "search",
    model: null,
    operation: operation ?? null,
    duration_ms: durationMs ?? null,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    web_search_count: count,
    image_count: 0,
    cost_usd: count * unitPrice,
    status,
    error_msg: error ? String(error.message ?? error).slice(0, 500) : null,
  });
}

const insertSampleStmt = db.prepare(`
  INSERT INTO system_samples
    (cpu_pct, load1, load5, load15, cores,
     mem_total_mb, mem_used_mb, mem_available_mb, swap_used_mb, swap_total_mb,
     disk_total_gb, disk_used_gb)
  VALUES
    (@cpu_pct, @load1, @load5, @load15, @cores,
     @mem_total_mb, @mem_used_mb, @mem_available_mb, @swap_used_mb, @swap_total_mb,
     @disk_total_gb, @disk_used_gb)
`);

/** Record one droplet resource snapshot (see systemStats.systemSnapshot). */
export function recordSystemSample(sample) {
  try {
    insertSampleStmt.run(sample);
  } catch (err) {
    console.error("[apiMetrics] failed to record system sample:", err.message);
  }
}

/** Drop system samples older than `days` to keep the trend table bounded. */
export function pruneSystemSamples(days = 30) {
  try {
    db.prepare(`DELETE FROM system_samples WHERE ts < datetime('now', ?)`).run(`-${days} days`);
  } catch (err) {
    console.error("[apiMetrics] failed to prune system samples:", err.message);
  }
}

/**
 * Record one image generation call. Cost is per generated image; image APIs
 * carry no token usage.
 *
 * `provider` defaults to "xai" so the pipeline's existing generateCover /
 * generateFoodCover call sites keep working untouched; the genbot passes its
 * own ("openai" | "gemini" | "fal" | …) so every agent lands in this one table
 * and the existing dashboard picks them up for free. `unitPriceUsd` likewise
 * lets a genbot registry entry carry its own rate; without it the price falls
 * back to the per-model tables above.
 */
export function recordImageCall({
  account,
  provider = "xai",
  model,
  operation,
  durationMs,
  imageCount = 1,
  unitPriceUsd,
  status = "ok",
  error,
}) {
  const count = status === "ok" ? imageCount : 0;
  const unit =
    unitPriceUsd ??
    (provider === "xai" ? xaiImagePrice(model) : GEN_IMAGE_PRICING[model]);
  safeInsert({
    account: account ?? null,
    provider,
    model: model ?? null,
    operation: operation ?? null,
    duration_ms: durationMs ?? null,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    web_search_count: 0,
    image_count: count,
    // Unknown model and no declared price → cost null, so the dashboard shows
    // a gap rather than a confident $0.00. Matches the Claude/DeepSeek path.
    cost_usd: unit === undefined ? null : count * unit,
    status,
    error_msg: error ? String(error.message ?? error).slice(0, 500) : null,
  });
}

/**
 * Record one video generation job (Grok Imagine, Veo, Sora, Kling, Runway,
 * Luma). These price per second of output rather than per asset, so the
 * billable unit lands in video_seconds and `unitPriceUsd` is $/second.
 *
 * `costUsd` wins when the provider reports the exact charge — xAI returns
 * usage.cost_in_usd_ticks, which beats any rate we hardcode. unitPriceUsd is
 * the fallback for providers that report only a duration.
 */
export function recordVideoCall({
  account,
  provider,
  model,
  operation,
  durationMs,
  seconds = 0,
  unitPriceUsd,
  costUsd,
  status = "ok",
  error,
}) {
  const billable = status === "ok" ? seconds : 0;
  const resolvedCost =
    status !== "ok"
      ? 0
      : costUsd != null
        ? costUsd
        : unitPriceUsd === undefined
          ? null
          : billable * unitPriceUsd;
  safeInsert({
    account: account ?? null,
    provider: provider ?? "video",
    model: model ?? null,
    operation: operation ?? null,
    duration_ms: durationMs ?? null,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    web_search_count: 0,
    image_count: 0,
    video_seconds: billable,
    cost_usd: resolvedCost,
    status,
    error_msg: error ? String(error.message ?? error).slice(0, 500) : null,
  });
}
