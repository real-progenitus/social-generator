import { config } from "../config.js";

const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
const MIN_DIMENSION = 700;
const REQUEST_WIDTH = 1600;

// Commons hosts only freely-licensed or public-domain media, but we check the
// license string anyway rather than trust that blindly.
const PERMISSIVE_LICENSE = /^(cc0|cc[\s-]?by|public domain|pd\b)/i;

// Commons tags "of the subject" liberally — album art, memorials, and logos
// all turn up in a plain name search. None of those work as a cover photo:
// album art has its own text/branding baked in, memorials/graves are a bad
// tone match, and logos aren't photos at all. Filtered on title/description/
// categories rather than pixel content — cheap and catches the vast majority
// of Commons' own labeling for these.
const EXCLUDE_PATTERN =
  /\b(cover|album cover|single cover|logo|logotype|wordmark|emblem|coat of arms|grave|gravestone|headstone|tombstone|memorial|gedenkst\w*|cemetery|graveyard|monument|plaque|poster|flyer|ticket|screenshot|banknote|postage stamp)\b/i;

function stripHtml(html) {
  return String(html ?? "")
    .replace(/<[^>]*>/g, "")
    .trim();
}

function looksExcluded(page, info) {
  const text = [
    page.title,
    info.extmetadata?.ObjectName?.value,
    info.extmetadata?.ImageDescription?.value,
    info.extmetadata?.Categories?.value,
  ]
    .filter(Boolean)
    .join(" ");
  return EXCLUDE_PATTERN.test(text);
}

// Filter the raw search pages down to usable, unused, on-topic photos and
// return them best-resolution first. Callers take rank[0] for a single pick or
// a slice for multiple distinct photos of the same subject.
function rankImages(pages, usedUrls) {
  const candidates = [];
  for (const page of Object.values(pages)) {
    const info = page.imageinfo?.[0];
    if (!info) continue;
    if (info.mime !== "image/jpeg" && info.mime !== "image/png") continue;
    if ((info.width ?? 0) < MIN_DIMENSION || (info.height ?? 0) < MIN_DIMENSION) continue;

    const license = info.extmetadata?.LicenseShortName?.value ?? "";
    if (!PERMISSIVE_LICENSE.test(license)) continue;

    if (usedUrls.has(info.descriptionurl)) continue;
    if (looksExcluded(page, info)) continue;

    const credit =
      stripHtml(info.extmetadata?.Artist?.value) ||
      stripHtml(info.extmetadata?.Credit?.value) ||
      "Wikimedia Commons";

    candidates.push({
      url: info.thumburl || info.url,
      mime: info.mime,
      width: info.thumbwidth || info.width,
      height: info.thumbheight || info.height,
      credit,
      license,
      descriptionUrl: info.descriptionurl,
    });
  }
  candidates.sort((a, b) => b.width * b.height - a.width * a.height);
  return candidates;
}

async function searchCommons(subject) {
  const url = new URL(COMMONS_API);
  url.search = new URLSearchParams({
    action: "query",
    format: "json",
    generator: "search",
    gsrsearch: `${subject} filetype:bitmap`,
    gsrnamespace: "6",
    gsrlimit: "30",
    prop: "imageinfo",
    iiprop: "url|size|mime|extmetadata",
    iiurlwidth: String(REQUEST_WIDTH),
  }).toString();

  const res = await fetch(url, {
    headers: {
      "User-Agent": `social-generator/1.0 (Instagram carousel bot; ${config.postHandle})`,
    },
  });
  if (!res.ok) throw new Error(`Wikimedia Commons search failed: ${res.status}`);

  const json = await res.json();
  return json.query?.pages ?? null;
}

/**
 * Look up a freely-licensed photo of a subject (artist, venue, or festival)
 * on Wikimedia Commons, skipping any file already recorded as used
 * (`usedUrls`, keyed by descriptionUrl) so the same post subject doesn't get
 * the same cover twice. Returns null if nothing unused turns up (caller
 * falls back to AI art).
 */
export async function fetchCommonsPhoto(subject, usedUrls = new Set()) {
  const pages = await searchCommons(subject);
  if (!pages) return null;
  return rankImages(pages, usedUrls)[0] ?? null;
}

/**
 * Like fetchCommonsPhoto, but returns up to `limit` distinct photos of the
 * subject, best-resolution first — used to pull a second image for an extra
 * in-carousel photo slide when the subject is well documented. Returns fewer
 * (or none) when the subject doesn't have that many quality photos on Commons.
 */
export async function fetchCommonsPhotos(subject, usedUrls = new Set(), limit = 2) {
  const pages = await searchCommons(subject);
  if (!pages) return [];
  return rankImages(pages, usedUrls).slice(0, limit);
}
