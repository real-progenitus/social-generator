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

// xAI image price per generated image. Set per deployed model; override with
// XAI_IMAGE_PRICE_USD if a model's price differs. Verify against xAI's current
// pricing when changing the deployed GROK_IMAGE_MODEL.
const XAI_IMAGE_PRICE_USD = Number(process.env.XAI_IMAGE_PRICE_USD ?? 0.07);

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

const insertStmt = db.prepare(`
  INSERT INTO api_calls
    (account, provider, model, operation, duration_ms,
     input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
     web_search_count, image_count, cost_usd, status, error_msg)
  VALUES
    (@account, @provider, @model, @operation, @duration_ms,
     @input_tokens, @output_tokens, @cache_read_tokens, @cache_creation_tokens,
     @web_search_count, @image_count, @cost_usd, @status, @error_msg)
`);

// Recording is best-effort: instrumentation must never break generation or a
// reply. Any DB/pricing error is logged and swallowed.
function safeInsert(row) {
  try {
    insertStmt.run(row);
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
 * Record one xAI image generation call. Cost is per generated image; xAI image
 * responses carry no token usage.
 */
export function recordImageCall({ account, model, operation, durationMs, imageCount = 1, status = "ok", error }) {
  const count = status === "ok" ? imageCount : 0;
  safeInsert({
    account: account ?? null,
    provider: "xai",
    model: model ?? null,
    operation: operation ?? null,
    duration_ms: durationMs ?? null,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    web_search_count: 0,
    image_count: count,
    cost_usd: count * XAI_IMAGE_PRICE_USD,
    status,
    error_msg: error ? String(error.message ?? error).slice(0, 500) : null,
  });
}
