import { config } from "../config.js";
import { metricsDb } from "../lib/apiMetrics.js";
import { liveMoney } from "./balances.js";

// ---------------------------------------------------------------------------
// "How much money do I have with this agent?" — answered from two sources
// merged behind one shape, because no single source can answer it for every
// provider (see balances.js for why).
//
//   source: "live"      the provider told us; authoritative
//   source: "estimate"  your declared budget minus what THIS REPO has spent
//                       since you declared it. Blind to spend from anywhere
//                       else — the provider's web playground, another app,
//                       a teammate's key — so treat it as a floor, not a
//                       guarantee. Rendered with a leading "~" everywhere.
//   source: "spend"     no budget declared and no probe: all we can honestly
//                       report is what's been spent.
// ---------------------------------------------------------------------------

// Spend recorded by every service in this repo, not just the genbot: the
// metrics DB is deliberately shared across accounts (see config.metricsDbPath),
// so the pipeline's cover images count against the same xAI credit the genbot
// draws on — which is exactly right, it's one balance.
const spendStmt = metricsDb.prepare(
  `SELECT COALESCE(SUM(cost_usd), 0) AS usd, COUNT(*) AS calls
     FROM api_calls
    WHERE provider = ? AND status = 'ok' AND ts >= ?`,
);

/** Total USD this repo has billed to `provider` since the ISO date `since`. */
export function spendSince(provider, since = "1970-01-01") {
  const row = spendStmt.get(provider, since);
  return { usd: row.usd ?? 0, calls: row.calls ?? 0 };
}

/**
 * Money position for one provider.
 * @returns {Promise<{usd: number|null, spent: number, source: "live"|"estimate"|"spend", budget: number|null, credits?: number}>}
 *   `usd` is remaining credit, or null when only spend is knowable.
 */
export async function providerMoney(provider) {
  const declared = config.budgets[provider] ?? { usd: null, since: "1970-01-01" };
  const live = await liveMoney(provider);

  // The provider told us what's left — nothing beats that.
  if (live?.kind === "balance") {
    return {
      usd: live.usd,
      spent: spendSince(provider, declared.since).usd,
      source: "live",
      budget: declared.usd,
      credits: live.credits,
    };
  }

  // The provider told us what we've spent (OpenAI's Costs API). Real spend,
  // so subtracting it from a declared budget still counts as "live".
  if (live?.kind === "spend") {
    return {
      usd: declared.usd == null ? null : declared.usd - live.usd,
      spent: live.usd,
      source: declared.usd == null ? "spend" : "live",
      budget: declared.usd,
    };
  }

  const spent = spendSince(provider, declared.since).usd;
  return {
    usd: declared.usd == null ? null : declared.usd - spent,
    spent,
    source: declared.usd == null ? "spend" : "estimate",
    budget: declared.usd,
  };
}

/** Same, for a registry agent. Several agents can share one provider balance. */
export function agentMoney(agent) {
  return providerMoney(agent.provider);
}

/**
 * Short form for an inline-keyboard button, e.g. "$34.12" (live) or "~$21.40"
 * (estimate). Buttons are tight, so a provider we know nothing about renders
 * as a spend figure instead of a misleading blank.
 */
export function formatMoneyShort(money) {
  if (money.usd == null) return `$${money.spent.toFixed(2)} spent`;
  const tilde = money.source === "estimate" ? "~" : "";
  // Overspending a declared budget is a real state (the estimate can't see
  // spend from outside this repo, so it drifts) — show it as a negative
  // rather than clamping to zero and hiding that the budget is stale.
  if (money.usd < 0) return `${tilde}-$${Math.abs(money.usd).toFixed(2)}`;
  return `${tilde}$${money.usd.toFixed(2)}`;
}
