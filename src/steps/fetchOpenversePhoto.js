import { config } from "../config.js";
import { looksExcluded, normalize } from "./fetchCommonsPhoto.js";

// Openverse aggregates openly-licensed images from Flickr, Wikimedia, museums
// and more, so it covers many subjects (specific gear, venues, clubs) that a
// plain Wikimedia Commons search misses. Used as a second real-photo source
// before falling back to AI generation. No API key needed at this volume.
const OPENVERSE_API = "https://api.openverse.org/v1/images/";
const OPENVERSE_UA = `social-generator/1.0 (Instagram carousel bot; ${config.postHandle})`;
const MIN_DIMENSION = 700;

// commercial + modification already restricts to cc0/pdm/by/by-sa, but verify.
const PERMISSIVE_LICENSE = /^(cc0|pdm|by|by-sa)$/i;

const MIME_BY_FILETYPE = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png" };

// Openverse `attribution` is legally complete but verbose; build a concise
// credit for the caption. CC BY / BY-SA still need creator + license shown,
// which this carries.
function toPhoto(r) {
  const mime = MIME_BY_FILETYPE[String(r.filetype ?? "").toLowerCase()];
  if (!mime) return null;
  if (!PERMISSIVE_LICENSE.test(r.license ?? "")) return null;
  if ((r.width && r.width < MIN_DIMENSION) || (r.height && r.height < MIN_DIMENSION)) return null;
  const text = `${r.title ?? ""} ${r.source ?? ""}`;
  if (looksExcluded(text)) return null;
  if (!r.url) return null;

  const credit = r.creator || r.provider || "Openverse";
  const license = `${(r.license ?? "").toUpperCase()}${r.license_version ? ` ${r.license_version}` : ""}`.trim();
  return {
    url: r.url,
    mime,
    credit,
    license,
    descriptionUrl: r.foreign_landing_url || r.url,
    description: r.title ? String(r.title) : "",
    attribution: `Photo: ${credit} via Openverse (${license})`,
    title: String(r.title ?? ""),
  };
}

/**
 * Returns the best openly-licensed photo of the subject from Openverse, plus one
 * extra when available (for the mid-carousel slide) — mirroring
 * fetchCommonsPhotos' shape so generateCover can use either interchangeably.
 * Prefers results whose title actually contains the subject; falls back to the
 * top relevance result otherwise. Returns [] on no usable result or any error.
 */
export async function fetchOpenversePhotos(subject, usedUrls = new Set()) {
  const url = new URL(OPENVERSE_API);
  url.search = new URLSearchParams({
    q: subject,
    license_type: "commercial,modification",
    page_size: "20",
    mature: "false",
  }).toString();

  let json;
  try {
    const res = await fetch(url, { headers: { "User-Agent": OPENVERSE_UA, Accept: "application/json" } });
    if (!res.ok) throw new Error(`Openverse search failed: ${res.status}`);
    json = await res.json();
  } catch (err) {
    console.warn(`[fetchOpenversePhoto] search failed: ${err.message}`);
    return [];
  }

  const candidates = (json.results ?? [])
    .map(toPhoto)
    .filter((p) => p && !usedUrls.has(p.descriptionUrl) && !usedUrls.has(p.url));
  if (candidates.length === 0) return [];

  const subjectNorm = normalize(subject);
  const matching = candidates.filter((p) => subjectNorm.length > 0 && normalize(p.title).includes(subjectNorm));
  const ordered = matching.length > 0 ? matching : candidates;

  const cover = ordered[0];
  const extra = matching.length > 0 ? ordered.find((p) => p !== cover) : undefined;
  return extra ? [cover, extra] : [cover];
}
