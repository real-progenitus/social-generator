import { config } from "../config.js";

// ---------------------------------------------------------------------------
// Live balance probes.
//
// Most image/video providers expose NO balance API at all (xAI and Google
// among them), which is why budgets.js exists — this module covers only the
// ones that do, and budgets.js falls back to declared-budget-minus-local-spend
// for everything else.
//
// Two shapes come back, because providers disagree about what they'll tell
// you:
//   { kind: "balance", usd }  what's left   — fal, Runway, Luma, DeepSeek
//   { kind: "spend",   usd }  what's gone   — OpenAI's org Costs API, which
//                                             needs an admin key and reports
//                                             spend, never a balance
//
// Every probe is best-effort and NEVER throws — logged and swallowed, the same
// contract as safeInsert() in apiMetrics.js. The agent keyboard has to render
// even when a provider's billing API is down, and a missing number degrades
// to an estimate rather than an error.
//
// These endpoints are the least stable thing in this codebase — billing APIs
// move around and are usually undocumented. Each lives in its own small
// function precisely so one breaking will not take the others with it. If a
// row shows "est." unexpectedly, run the probe directly (see the plan's
// verification section) to find out which one changed.
// ---------------------------------------------------------------------------

const PROBES = {
  // fal.ai — prepaid wallet, reported in USD directly.
  async fal() {
    if (!config.falApiKey) return null;
    const res = await fetch("https://rest.alpha.fal.ai/billing/user_balance", {
      headers: { Authorization: `Key ${config.falApiKey}` },
    });
    if (!res.ok) throw new Error(`fal balance ${res.status}`);
    const json = await res.json();
    // Returns either a bare number or an object, depending on the endpoint
    // version — accept both rather than guessing.
    const usd = typeof json === "number" ? json : (json.balance ?? json.user_balance);
    return usd == null ? null : { kind: "balance", usd: Number(usd) };
  },

  // DeepSeek — not a generation agent, but it's already billed by this repo
  // (fbresponder + generateFact), so /balance shows it alongside the rest.
  async deepseek() {
    if (!config.deepseekApiKey) return null;
    const res = await fetch("https://api.deepseek.com/user/balance", {
      headers: { Authorization: `Bearer ${config.deepseekApiKey}` },
    });
    if (!res.ok) throw new Error(`deepseek balance ${res.status}`);
    const json = await res.json();
    const usdInfo = json.balance_infos?.find((b) => b.currency === "USD") ?? json.balance_infos?.[0];
    return usdInfo ? { kind: "balance", usd: Number(usdInfo.total_balance) } : null;
  },

  // Runway — reports credits, not dollars; runwayUsdPerCredit converts for
  // display and is env-tunable because the rate depends on your plan.
  async runway() {
    if (!config.runwayApiKey) return null;
    const res = await fetch("https://api.dev.runwayml.com/v1/organization", {
      headers: {
        Authorization: `Bearer ${config.runwayApiKey}`,
        "X-Runway-Version": "2024-11-06",
      },
    });
    if (!res.ok) throw new Error(`runway balance ${res.status}`);
    const json = await res.json();
    const credits = json.creditBalance ?? json.credit_balance;
    return credits == null
      ? null
      : { kind: "balance", usd: Number(credits) * config.runwayUsdPerCredit, credits: Number(credits) };
  },

  // Luma — same credits-not-dollars caveat as Runway.
  async luma() {
    if (!config.lumaApiKey) return null;
    const res = await fetch("https://api.lumalabs.ai/dream-machine/v1/credits", {
      headers: { Authorization: `Bearer ${config.lumaApiKey}` },
    });
    if (!res.ok) throw new Error(`luma balance ${res.status}`);
    const json = await res.json();
    const credits = json.credit_balance ?? json.credits;
    return credits == null
      ? null
      : { kind: "balance", usd: Number(credits) * config.lumaUsdPerCredit, credits: Number(credits) };
  },

  // OpenAI has no balance endpoint. The org Costs API is the closest thing,
  // it reports *spend*, and it rejects a normal sk-… key — only an admin key
  // (sk-admin-…) can read it. Without OPENAI_ADMIN_KEY this returns null and
  // the row falls back to the local estimate like xAI and Gemini.
  async openai() {
    if (!config.openaiAdminKey) return null;
    const start = Math.floor(Date.parse(config.budgets.openai.since) / 1000);
    const res = await fetch(
      `https://api.openai.com/v1/organization/costs?start_time=${start}&limit=180`,
      { headers: { Authorization: `Bearer ${config.openaiAdminKey}` } },
    );
    if (!res.ok) throw new Error(`openai costs ${res.status}`);
    const json = await res.json();
    // Paginated buckets, each holding per-line-item amounts in USD.
    const usd = (json.data ?? []).reduce(
      (sum, bucket) =>
        sum + (bucket.results ?? []).reduce((s, r) => s + (r.amount?.value ?? 0), 0),
      0,
    );
    return { kind: "spend", usd };
  },
};

// provider -> { at: epochMs, value } . Short TTL so a burst of /balance taps
// doesn't hammer five billing APIs, but the number still visibly moves after
// a generation.
const cache = new Map();

/**
 * Probe one provider's billing API.
 * @returns {Promise<{kind: "balance"|"spend", usd: number} | null>} null when
 *   the provider has no probe, has no key configured, or the call failed.
 */
export async function liveMoney(provider) {
  const cached = cache.get(provider);
  if (cached && Date.now() - cached.at < config.balanceCacheTtlMs) return cached.value;

  const probe = PROBES[provider];
  if (!probe) return null;

  let value = null;
  try {
    value = await probe();
  } catch (err) {
    // Swallowed by design — see the module header.
    console.warn(`[genbot/balances] ${provider} probe failed: ${err.message}`);
  }
  cache.set(provider, { at: Date.now(), value });
  return value;
}

/** Providers this module can probe at all — used by /balance to label rows. */
export const PROBEABLE = Object.keys(PROBES);
