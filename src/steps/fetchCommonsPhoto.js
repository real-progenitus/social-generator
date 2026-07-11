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

// Lowercase, collapse punctuation to single spaces — so "Eiffel_65" and
// "Eiffel 65" compare equal, and "panoramio_(65)" doesn't read as "... 65 ...".
function normalize(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// A candidate is "clearly about" the subject only if the full subject name
// appears as a contiguous phrase in its metadata. Used to gate the optional
// extra photo slide: a loose match (e.g. an aerial "Tour Eiffel ... (65)" photo
// for subject "Eiffel 65") is fine as a headline backdrop but wrong as a
// standalone slide, so we skip the extra rather than show something unrelated.
function matchesSubject(haystack, subjectNorm) {
  return subjectNorm.length > 0 && haystack.includes(subjectNorm);
}

function metaText(page, info) {
  return [
    page.title,
    info.extmetadata?.ObjectName?.value,
    info.extmetadata?.ImageDescription?.value,
    info.extmetadata?.Categories?.value,
  ]
    .filter(Boolean)
    .join(" ");
}

// Stricter signal than metaText(): title and Commons' own "ObjectName" field
// are direct claims about what the file depicts. Categories/descriptions are
// looser (a photo can be *categorized under* a subject without actually being
// *of* it, e.g. a general festival crowd shot tagged with the artist's name),
// so the extra mid-carousel slide is gated on this narrower match instead.
function primaryText(page, info) {
  return [page.title, info.extmetadata?.ObjectName?.value].filter(Boolean).join(" ");
}

function looksExcluded(text) {
  return EXCLUDE_PATTERN.test(text);
}

// Filter the raw search pages down to usable, unused, on-topic photos and
// return them in Commons' own relevance order (via each result's `index`).
// Sorting by resolution instead — as this once did — throws away relevance and
// surfaces big but unrelated images (e.g. a high-res statue for "Carl Cox").
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
    const text = metaText(page, info);
    if (looksExcluded(text)) continue;

    const credit =
      stripHtml(info.extmetadata?.Artist?.value) ||
      stripHtml(info.extmetadata?.Credit?.value) ||
      "Wikimedia Commons";

    candidates.push({
      index: page.index ?? Number.MAX_SAFE_INTEGER,
      url: info.thumburl || info.url,
      mime: info.mime,
      width: info.thumbwidth || info.width,
      height: info.thumbheight || info.height,
      credit,
      license,
      descriptionUrl: info.descriptionurl,
      haystack: normalize(text),
      titleHaystack: normalize(primaryText(page, info)),
      description: stripHtml(info.extmetadata?.ImageDescription?.value),
    });
  }
  candidates.sort((a, b) => a.index - b.index);
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
 * Returns the best cover photo of the subject plus, when available, one extra
 * photo for a mid-carousel slide. Both are held to the same bar: the subject
 * name must appear in the file's title or Commons' own "ObjectName" field, not
 * merely a category/description mention. Plain relevance search alone isn't
 * enough — Commons' own ranking can surface photos whose only connection to
 * the subject is a shared word in categories or descriptions (e.g. "Kraftwerk"
 * is also the German word for "power station", so a literal power plant photo
 * can outrank real photos of the band). When no candidate clears that bar,
 * fall back to Commons' top overall result as the cover with no extra slide,
 * rather than returning nothing.
 */
export async function fetchCommonsPhotos(subject, usedUrls = new Set()) {
  const pages = await searchCommons(subject);
  if (!pages) return [];
  const ranked = rankImages(pages, usedUrls);
  if (ranked.length === 0) return [];

  const subjectNorm = normalize(subject);
  const matching = ranked.filter((c) => matchesSubject(c.titleHaystack, subjectNorm));
  const cover = matching[0] ?? ranked[0];
  const extra = matching.find((c) => c !== cover);
  return extra ? [cover, extra] : [cover];
}
