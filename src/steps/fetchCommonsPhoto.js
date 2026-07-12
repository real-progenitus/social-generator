import sharp from "sharp";
import { config } from "../config.js";

const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
const MIN_DIMENSION = 700;
const REQUEST_WIDTH = 1600;
const COMMONS_UA = `social-generator/1.0 (Instagram carousel bot; ${config.postHandle})`;

// Laplacian-variance blur detection (a standard focus-sharpness measure:
// convolve with a Laplacian kernel, then take the variance of the result —
// crisp edges produce high-magnitude responses, a soft/blurry image produces
// a flat one). Resized to a fixed width first so the score reflects actual
// detail rather than just pixel count — otherwise a bigger image would
// score higher than a smaller one of identical sharpness.
const LAPLACIAN_KERNEL = [0, 1, 0, 1, -4, 1, 0, 1, 0];
const SHARPNESS_SAMPLE_WIDTH = 600;
// Deliberately not an absolute pass/fail cutoff: tested against real Commons
// photos, a fixed threshold doesn't cleanly separate blurry from fine (a
// blurry livestream-frame-grab scored in the same range as several clearly
// acceptable press photos of other artists). What the score IS reliable for
// is relative ranking within one subject's own candidate pool, so callers
// re-rank by this instead of trusting Commons' relevance order for quality.
const MAX_CANDIDATES_TO_SCORE = 8;

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

  const res = await fetch(url, { headers: { "User-Agent": COMMONS_UA } });
  if (!res.ok) throw new Error(`Wikimedia Commons search failed: ${res.status}`);

  const json = await res.json();
  return json.query?.pages ?? null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Small gap between each sequential candidate download — tested live against
// production and a tight back-to-back burst of ~6-8 requests to
// upload.wikimedia.org from this droplet's IP was enough to trip a 429 with
// Retry-After: 600 (10 minutes), for the *entire* IP, not just this request.
const SHARPNESS_REQUEST_DELAY_MS = 400;

async function sharpnessScore(url) {
  const res = await fetch(url, { headers: { "User-Agent": COMMONS_UA } });
  if (!res.ok) {
    const err = new Error(`sharpness check fetch failed: ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  const { data } = await sharp(buffer)
    .resize({ width: SHARPNESS_SAMPLE_WIDTH, withoutEnlargement: true })
    .grayscale()
    .convolve({ width: 3, height: 3, kernel: LAPLACIAN_KERNEL })
    .raw()
    .toBuffer({ resolveWithObject: true });
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i];
  const mean = sum / data.length;
  let variance = 0;
  for (let i = 0; i < data.length; i++) {
    const d = data[i] - mean;
    variance += d * d;
  }
  return variance / data.length;
}

// Scores the top relevance-ranked candidates and returns them sharpest-first.
// Capped rather than scoring the whole pool — this downloads each candidate's
// full image to analyze it, so an unbounded pool would mean an unbounded
// number of extra Commons fetches for subjects with many hits. A download or
// decode failure just drops that candidate rather than aborting the pick.
async function bySharpness(candidates) {
  const scored = [];
  const pool = candidates.slice(0, MAX_CANDIDATES_TO_SCORE);
  for (let i = 0; i < pool.length; i++) {
    const c = pool[i];
    try {
      scored.push({ ...c, sharpness: await sharpnessScore(c.url) });
    } catch (err) {
      console.warn(`[fetchCommonsPhoto] sharpness check failed for ${c.url}: ${err.message}`);
      // A 429 means every subsequent request this run will fail the same way
      // (it's an IP-wide, not per-URL, lockout) — stop rather than burn the
      // rest of the pool (and worsen the lockout) on guaranteed failures.
      if (err.status === 429) break;
    }
    if (i < pool.length - 1) await sleep(SHARPNESS_REQUEST_DELAY_MS);
  }
  scored.sort((a, b) => b.sharpness - a.sharpness);
  return scored;
}

/**
 * Returns the best cover photo of the subject plus, when available, one extra
 * photo for a mid-carousel slide. Both are held to the same relevance bar:
 * the subject name must appear in the file's title or Commons' own
 * "ObjectName" field, not merely a category/description mention. Plain
 * relevance search alone isn't enough — Commons' own ranking can surface
 * photos whose only connection to the subject is a shared word in categories
 * or descriptions (e.g. "Kraftwerk" is also the German word for "power
 * station", so a literal power plant photo can outrank real photos of the
 * band), and separately, relevance order says nothing about photo quality (a
 * blurry livestream frame-grab can rank above a sharp press photo of the same
 * subject). So candidates are first filtered to those actually matching the
 * subject, then re-ranked by sharpness rather than trusting relevance order
 * for the final pick. When no candidate clears the subject-match bar, fall
 * back to Commons' top overall (still sharpness-ranked) result as the cover
 * with no extra slide, rather than returning nothing.
 */
export async function fetchCommonsPhotos(subject, usedUrls = new Set()) {
  const pages = await searchCommons(subject);
  if (!pages) return [];
  const ranked = rankImages(pages, usedUrls);
  if (ranked.length === 0) return [];

  const subjectNorm = normalize(subject);
  const matching = ranked.filter((c) => matchesSubject(c.titleHaystack, subjectNorm));

  if (matching.length > 0) {
    const sharpest = await bySharpness(matching);
    if (sharpest.length === 0) return [];
    const cover = sharpest[0];
    const extra = sharpest.find((c) => c !== cover);
    return extra ? [cover, extra] : [cover];
  }

  const sharpest = await bySharpness(ranked);
  return sharpest.length > 0 ? [sharpest[0]] : [];
}
