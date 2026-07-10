import { config } from "../config.js";

const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
const MIN_DIMENSION = 700;
const REQUEST_WIDTH = 1600;

// Commons hosts only freely-licensed or public-domain media, but we check the
// license string anyway rather than trust that blindly.
const PERMISSIVE_LICENSE = /^(cc0|cc[\s-]?by|public domain|pd\b)/i;

function stripHtml(html) {
  return String(html ?? "")
    .replace(/<[^>]*>/g, "")
    .trim();
}

function pickBestImage(pages, usedUrls) {
  const candidates = [];
  for (const page of Object.values(pages)) {
    const info = page.imageinfo?.[0];
    if (!info) continue;
    if (info.mime !== "image/jpeg" && info.mime !== "image/png") continue;
    if ((info.width ?? 0) < MIN_DIMENSION || (info.height ?? 0) < MIN_DIMENSION) continue;

    const license = info.extmetadata?.LicenseShortName?.value ?? "";
    if (!PERMISSIVE_LICENSE.test(license)) continue;

    if (usedUrls.has(info.descriptionurl)) continue;

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
  return candidates[0] ?? null;
}

/**
 * Look up a freely-licensed photo of a subject (artist, venue, or festival)
 * on Wikimedia Commons, skipping any file already recorded as used
 * (`usedUrls`, keyed by descriptionUrl) so the same post subject doesn't get
 * the same cover twice. Returns null if nothing unused turns up (caller
 * falls back to AI art).
 */
export async function fetchCommonsPhoto(subject, usedUrls = new Set()) {
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
  const pages = json.query?.pages;
  if (!pages) return null;

  return pickBestImage(pages, usedUrls);
}
