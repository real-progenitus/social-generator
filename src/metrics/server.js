import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import {
  metricsDb as db,
  pruneSystemSamples,
  recordSystemSample,
} from "../lib/apiMetrics.js";
import { cpuPercent, systemSnapshot, topProcesses } from "../lib/systemStats.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_HTML = path.join(here, "dashboard.html");

// How ?range= maps to a SQLite datetime() modifier. "all" uses a far-past
// bound so the same `ts >= datetime('now', ?)` filter always applies.
const RANGE_MODIFIER = {
  "24h": "-1 day",
  "7d": "-7 days",
  "30d": "-30 days",
  all: "-100 years",
};

const SAMPLE_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// Aggregation. Data volume here is modest (a handful of pipeline runs + FB
// replies per day), so we pull the rows in range once and reduce in JS — that
// keeps percentiles (which SQLite has no built-in for) trivial and the SQL
// simple. System-sample trends ARE aggregated in SQL because at a 30s cadence
// they'd otherwise be tens of thousands of rows.
// ---------------------------------------------------------------------------

function percentile(sortedNums, p) {
  if (sortedNums.length === 0) return null;
  const idx = Math.min(sortedNums.length - 1, Math.ceil((p / 100) * sortedNums.length) - 1);
  return sortedNums[Math.max(0, idx)];
}

function latencyStats(durations) {
  const nums = durations.filter((d) => typeof d === "number").sort((a, b) => a - b);
  if (nums.length === 0) return { avg: null, p50: null, p95: null };
  const avg = nums.reduce((s, d) => s + d, 0) / nums.length;
  return { avg, p50: percentile(nums, 50), p95: percentile(nums, 95) };
}

function bucketOf(ts, range) {
  // ts is 'YYYY-MM-DD HH:MM:SS' (UTC). Hourly buckets for 24h, daily otherwise.
  return range === "24h" ? ts.slice(0, 13) + ":00" : ts.slice(0, 10);
}

function buildApiSummary(range, account) {
  const mod = RANGE_MODIFIER[range] ?? RANGE_MODIFIER["7d"];
  const where = account ? "ts >= datetime('now', ?) AND account = ?" : "ts >= datetime('now', ?)";
  const rows = db
    .prepare(
      `SELECT ts, account, provider, model, operation, duration_ms,
              input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
              web_search_count, image_count, cost_usd, status
       FROM api_calls WHERE ${where} ORDER BY ts`,
    )
    .all(...(account ? [mod, account] : [mod]));

  const num = (v) => (typeof v === "number" ? v : 0);

  const totals = {
    calls: rows.length,
    cost: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    webSearches: 0,
    images: 0,
    errors: 0,
  };

  const byProvider = new Map();
  const byModel = new Map();
  const byOperation = new Map();
  const byAccount = new Map();
  const series = new Map();

  const bump = (map, key, init) => {
    if (!map.has(key)) map.set(key, init());
    return map.get(key);
  };

  for (const r of rows) {
    const cost = num(r.cost_usd);
    totals.cost += cost;
    totals.inputTokens += num(r.input_tokens);
    totals.outputTokens += num(r.output_tokens);
    totals.cacheReadTokens += num(r.cache_read_tokens);
    totals.cacheCreationTokens += num(r.cache_creation_tokens);
    totals.webSearches += num(r.web_search_count);
    totals.images += num(r.image_count);
    if (r.status === "error") totals.errors += 1;

    const prov = bump(byProvider, r.provider ?? "unknown", () => ({
      provider: r.provider ?? "unknown",
      calls: 0,
      cost: 0,
    }));
    prov.calls += 1;
    prov.cost += cost;

    const model = bump(byModel, r.model ?? "(unknown)", () => ({
      model: r.model ?? "(unknown)",
      provider: r.provider ?? "unknown",
      calls: 0,
      cost: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      images: 0,
      durations: [],
    }));
    model.calls += 1;
    model.cost += cost;
    model.inputTokens += num(r.input_tokens);
    model.outputTokens += num(r.output_tokens);
    model.cacheReadTokens += num(r.cache_read_tokens);
    model.cacheCreationTokens += num(r.cache_creation_tokens);
    model.images += num(r.image_count);
    if (r.duration_ms != null) model.durations.push(r.duration_ms);

    const op = bump(byOperation, r.operation ?? "(unknown)", () => ({
      operation: r.operation ?? "(unknown)",
      calls: 0,
      cost: 0,
      errors: 0,
      durations: [],
    }));
    op.calls += 1;
    op.cost += cost;
    if (r.status === "error") op.errors += 1;
    if (r.duration_ms != null) op.durations.push(r.duration_ms);

    const acct = bump(byAccount, r.account ?? "(unknown)", () => ({
      account: r.account ?? "(unknown)",
      calls: 0,
      cost: 0,
      inputTokens: 0,
      outputTokens: 0,
      webSearches: 0,
      images: 0,
      durations: [],
    }));
    acct.calls += 1;
    acct.cost += cost;
    acct.inputTokens += num(r.input_tokens);
    acct.outputTokens += num(r.output_tokens);
    acct.webSearches += num(r.web_search_count);
    acct.images += num(r.image_count);
    if (r.duration_ms != null) acct.durations.push(r.duration_ms);

    const bkt = bump(series, bucketOf(r.ts, range), () => ({ bucket: bucketOf(r.ts, range), cost: 0, calls: 0 }));
    bkt.cost += cost;
    bkt.calls += 1;
  }

  const allDurations = rows.map((r) => r.duration_ms).filter((d) => d != null);
  totals.avgLatencyMs = latencyStats(allDurations).avg;

  const finalizeLatency = (arr) =>
    arr.map(({ durations, ...rest }) => ({ ...rest, ...latencyStats(durations) }));

  return {
    totals,
    byProvider: [...byProvider.values()].sort((a, b) => b.cost - a.cost),
    byModel: finalizeLatency([...byModel.values()]).sort((a, b) => b.cost - a.cost),
    byOperation: finalizeLatency([...byOperation.values()]).sort((a, b) => b.calls - a.calls),
    byAccount: finalizeLatency([...byAccount.values()]).sort((a, b) => b.cost - a.cost),
    series: [...series.values()].sort((a, b) => (a.bucket < b.bucket ? -1 : 1)),
  };
}

async function buildSystemSummary(range) {
  const mod = RANGE_MODIFIER[range] ?? RANGE_MODIFIER["7d"];
  const fmt = range === "24h" ? "%Y-%m-%d %H:00" : "%Y-%m-%d";
  const history = db
    .prepare(
      `SELECT strftime(?, ts) AS bucket,
              AVG(cpu_pct) AS cpu_pct,
              AVG(mem_used_mb) AS mem_used_mb,
              AVG(mem_total_mb) AS mem_total_mb,
              AVG(load1) AS load1,
              MAX(cores) AS cores
       FROM system_samples WHERE ts >= datetime('now', ?)
       GROUP BY bucket ORDER BY bucket`,
    )
    .all(fmt, mod);

  const current = db.prepare(`SELECT * FROM system_samples ORDER BY id DESC LIMIT 1`).get() ?? null;
  const processes = await topProcesses(8);
  return { current, history, processes };
}

async function buildSummary(range, account) {
  const mod = RANGE_MODIFIER[range] ?? RANGE_MODIFIER["7d"];
  const accounts = db
    .prepare(
      `SELECT DISTINCT account FROM api_calls
       WHERE ts >= datetime('now', ?) AND account IS NOT NULL ORDER BY account`,
    )
    .all(mod)
    .map((r) => r.account);
  return {
    range,
    account: account ?? null,
    accounts,
    generatedAt: new Date().toISOString(),
    ...buildApiSummary(range, account),
    system: await buildSystemSummary(range),
  };
}

// ---------------------------------------------------------------------------
// System sampler — the always-on metrics service owns the interval that makes
// a CPU rate meaningful and gives the droplet-health trend its data points.
// ---------------------------------------------------------------------------
function startSampler() {
  let sinceLastPrune = 0;
  const sample = async () => {
    try {
      const snapshot = await systemSnapshot(cpuPercent());
      recordSystemSample(snapshot);
      if (++sinceLastPrune >= 240) {
        pruneSystemSamples(30);
        sinceLastPrune = 0;
      }
    } catch (err) {
      console.error("[metrics] system sample failed:", err.message);
    }
  };
  pruneSystemSamples(30);
  sample();
  setInterval(sample, SAMPLE_INTERVAL_MS);
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

/**
 * Read-only cost + droplet-health dashboard server. Binds 127.0.0.1 only —
 * public access is via a Caddy reverse proxy with Basic auth in front of it.
 */
export function serveMetrics() {
  startSampler();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://x");
      if (req.method !== "GET") {
        res.writeHead(405).end("method not allowed");
        return;
      }
      if (url.pathname === "/" || url.pathname === "/index.html") {
        const html = fs.readFileSync(DASHBOARD_HTML);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }
      if (url.pathname === "/api/summary") {
        const range = url.searchParams.get("range") ?? "7d";
        const account = url.searchParams.get("account") || null;
        sendJson(res, 200, await buildSummary(RANGE_MODIFIER[range] ? range : "7d", account));
        return;
      }
      res.writeHead(404).end("not found");
    } catch (err) {
      console.error("[metrics] request failed:", err);
      sendJson(res, 500, { error: err.message });
    }
  });

  server.listen(config.metricsServerPort, "127.0.0.1", () => {
    console.log(
      `[metrics] dashboard on http://127.0.0.1:${config.metricsServerPort} (metrics DB: ${config.metricsDbPath})`,
    );
  });
  return server;
}
