import { config } from "../config.js";
import { recordSearchCall } from "./apiMetrics.js";

const TAVILY_URL = "https://api.tavily.com/search";

/**
 * Single instrumented entry point for Tavily search. Used to ground the
 * recent_news pillar, which DeepSeek's training cutoff can't cover. Times the
 * request and records it (one query, per-query cost from config.tavilyPriceUsd,
 * 0 on the free tier) into the shared metrics store.
 *
 * @param {object} opts
 * @param {string} opts.query
 * @param {string} opts.account       Account label for the dashboard.
 * @param {string} opts.operation     Call-site label (e.g. "recentNewsSearch").
 * @param {string} [opts.topic]       "news" | "general" (default "news").
 * @param {number} [opts.days]        Recency window for news (default 14).
 * @param {number} [opts.maxResults]  Default 5.
 * @param {boolean} [opts.includeAnswer] Default true.
 * @param {string[]} [opts.includeDomains] Whitelist — restrict results to these
 *                                 domains (the main topical filter, e.g. only
 *                                 electronic-music outlets).
 * @param {string[]} [opts.excludeDomains] Blacklist domains.
 * @param {number} [opts.minScore] Drop results below this relevance score
 *                                 (0..1; default 0 = keep all).
 * @returns {Promise<{answer: string|null, results: {title, url, content, score}[]}>}
 */
export async function tavilySearch({
  query,
  account,
  operation,
  topic = "news",
  days = 14,
  maxResults = 5,
  includeAnswer = true,
  includeDomains = [],
  excludeDomains = [],
  minScore = 0,
}) {
  const start = Date.now();
  try {
    const res = await fetch(TAVILY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.tavilyApiKey}`,
      },
      body: JSON.stringify({
        query,
        topic,
        days,
        max_results: maxResults,
        include_answer: includeAnswer,
        search_depth: "basic",
        ...(includeDomains.length ? { include_domains: includeDomains } : {}),
        ...(excludeDomains.length ? { exclude_domains: excludeDomains } : {}),
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Tavily API error ${res.status}: ${body.slice(0, 500)}`);
    }

    const json = await res.json();
    const results = (json.results ?? [])
      .filter((r) => (r.score ?? 1) >= minScore)
      .map((r) => ({ title: r.title, url: r.url, content: r.content, score: r.score }));

    recordSearchCall({
      account,
      provider: "tavily",
      operation,
      durationMs: Date.now() - start,
      queries: 1,
      unitPrice: config.tavilyPriceUsd,
      status: "ok",
    });
    return { answer: json.answer ?? null, results };
  } catch (err) {
    recordSearchCall({
      account,
      provider: "tavily",
      operation,
      durationMs: Date.now() - start,
      queries: 1,
      unitPrice: config.tavilyPriceUsd,
      status: "error",
      error: err,
    });
    throw err;
  }
}
