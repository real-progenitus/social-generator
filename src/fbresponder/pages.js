import "dotenv/config";

// Every Facebook Page this bot serves. The Meta app ("Bass Vault Generator")
// batches every subscribed Page's webhook events into the same POST's
// entry[], disambiguated by entry.id — so all of this runs in the one
// existing webhook process, just resolving which Page an event belongs to.
//
// `default` reuses the pre-existing FB_PAGE_ID/FB_PAGE_ACCESS_TOKEN env var
// names verbatim, so the currently-working main ifound Page's .env.ifound
// lines never need to change. Every new country gets its own
// FB_PAGE_ID_<KEY>/FB_PAGE_TOKEN_<KEY> pair.
//
// `language` is only the STEP-0 fallback/tie-breaker default in
// generateReply.js — per-message language detection still runs for every
// Page, this just replaces the old hardcoded "Portuguese is the safer
// default" with a page-appropriate guess. `ptDialect` ("european" |
// "brazilian") only matters when language === "Portuguese".
const PAGE_DEFS = [
  { key: "default", pageIdEnv: "FB_PAGE_ID", tokenEnv: "FB_PAGE_ACCESS_TOKEN", label: "🌐 ifound", language: "Portuguese", ptDialect: "european" },
  { key: "PT", pageIdEnv: "FB_PAGE_ID_PT", tokenEnv: "FB_PAGE_TOKEN_PT", label: "🇵🇹 Portugal", language: "Portuguese", ptDialect: "european" },
  { key: "ES", pageIdEnv: "FB_PAGE_ID_ES", tokenEnv: "FB_PAGE_TOKEN_ES", label: "🇪🇸 Spain", language: "Spanish" },
  { key: "FR", pageIdEnv: "FB_PAGE_ID_FR", tokenEnv: "FB_PAGE_TOKEN_FR", label: "🇫🇷 France", language: "French" },
  { key: "IT", pageIdEnv: "FB_PAGE_ID_IT", tokenEnv: "FB_PAGE_TOKEN_IT", label: "🇮🇹 Italy", language: "Italian" },
  // Belgium is FR/NL/DE — French is an assumption, not confirmed.
  { key: "BE", pageIdEnv: "FB_PAGE_ID_BE", tokenEnv: "FB_PAGE_TOKEN_BE", label: "🇧🇪 Belgium", language: "French" },
  { key: "GB", pageIdEnv: "FB_PAGE_ID_GB", tokenEnv: "FB_PAGE_TOKEN_GB", label: "🇬🇧 United Kingdom", language: "English" },
  { key: "BR", pageIdEnv: "FB_PAGE_ID_BR", tokenEnv: "FB_PAGE_TOKEN_BR", label: "🇧🇷 Brazil", language: "Portuguese", ptDialect: "brazilian" },
  { key: "AR", pageIdEnv: "FB_PAGE_ID_AR", tokenEnv: "FB_PAGE_TOKEN_AR", label: "🇦🇷 Argentina", language: "Spanish" },
  { key: "CO", pageIdEnv: "FB_PAGE_ID_CO", tokenEnv: "FB_PAGE_TOKEN_CO", label: "🇨🇴 Colombia", language: "Spanish" },
  { key: "EC", pageIdEnv: "FB_PAGE_ID_EC", tokenEnv: "FB_PAGE_TOKEN_EC", label: "🇪🇨 Ecuador", language: "Spanish" },
  // Canada is EN/FR — English is an assumption, not confirmed.
  { key: "CA", pageIdEnv: "FB_PAGE_ID_CA", tokenEnv: "FB_PAGE_TOKEN_CA", label: "🇨🇦 Canada", language: "English" },
  { key: "US_TX", pageIdEnv: "FB_PAGE_ID_US_TX", tokenEnv: "FB_PAGE_TOKEN_US_TX", label: "🇺🇸 United States (TX)", language: "English" },
];

// Built once at load. A Page is only active if BOTH its id and token env
// vars are set — lets tokens be pasted in one at a time as they're
// generated, without touching code or crashing the process in the meantime.
const byFbId = new Map();
const byKey = new Map();
const skipped = [];

for (const def of PAGE_DEFS) {
  const pageId = process.env[def.pageIdEnv] ?? "";
  const token = process.env[def.tokenEnv] ?? "";
  if (!pageId || !token) {
    skipped.push(def.key);
    continue;
  }
  const page = {
    key: def.key,
    pageId,
    token,
    label: def.label,
    language: def.language,
    ptDialect: def.ptDialect ?? "european",
  };
  byFbId.set(pageId, page);
  byKey.set(def.key, page);
}

console.log(
  `[fbresponder/pages] active pages: ${[...byKey.keys()].join(", ") || "(none)"}` +
    (skipped.length ? ` — skipped (missing id or token): ${skipped.join(", ")}` : ""),
);

export function getPageByFbId(fbPageId) {
  return byFbId.get(fbPageId);
}

export function getPageByKey(key) {
  return byKey.get(key);
}
