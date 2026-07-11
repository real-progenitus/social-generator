import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";
import { config } from "../config.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const templatePath = path.join(here, "..", "..", "templates", "slide.html");
const logoPath = path.join(here, "..", "..", "assets", "logo.png");
const logoUri = `data:image/png;base64,${fs.readFileSync(logoPath).toString("base64")}`;

const WIDTH = 1080;
const HEIGHT = 1350;

function esc(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function imageUri(image) {
  const data = fs.readFileSync(image.path).toString("base64");
  return `data:${image.mime};base64,${data}`;
}

function coverHtml(fact, coverImage) {
  return `
  <div class="cover" style="background-image: url('${imageUri(coverImage)}')">
    <div class="scrim"></div>
    <div class="content">
      <span class="kicker">Electronic Music Facts</span>
      <div class="headline">${esc(fact.headline)}</div>
      <div class="handle">${esc(config.postHandle)} &nbsp;•&nbsp; swipe →</div>
    </div>
  </div>`;
}

// Full-bleed photo slide for a second Commons photo of the subject, dropped
// into the middle of the carousel to break up the text slides.
function photoSlideHtml(photo) {
  const credit = photo.credit ? `${esc(photo.credit)} / Wikimedia Commons` : "Wikimedia Commons";
  return `
  <div class="cover photo-slide" style="background-image: url('${imageUri(photo)}')">
    <div class="scrim"></div>
    <div class="content">
      <div class="photo-credit">Photo: ${credit}</div>
    </div>
  </div>`;
}

// Large faint background shapes for depth.
const HERO = {
  circles: `<svg width="360" height="360" viewBox="0 0 360 360" fill="none" stroke="currentColor" stroke-width="3"><circle cx="180" cy="180" r="178"/><circle cx="180" cy="180" r="126"/><circle cx="180" cy="180" r="74"/></svg>`,
  circle: `<svg width="320" height="320" viewBox="0 0 320 320" fill="none" stroke="currentColor" stroke-width="3"><circle cx="160" cy="160" r="158"/></svg>`,
};
// Smaller, bolder foreground marks that sit where the slide counter used to be.
const MARK = {
  dots: `<svg width="26" height="118" viewBox="0 0 26 118" fill="currentColor"><circle cx="13" cy="13" r="10"/><circle cx="13" cy="59" r="10"/><circle cx="13" cy="105" r="10"/></svg>`,
  bracket: `<svg width="84" height="84" viewBox="0 0 84 84" fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"><path d="M80 8 H8 V80"/></svg>`,
  plus: `<svg width="72" height="72" viewBox="0 0 72 72" fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round"><path d="M36 8 V64 M8 36 H64"/></svg>`,
};

// Per variant: a hero shape (placement + kind) plus a bold top-right mark. The
// three variants also anchor the body text at different heights (see the .v1/
// .v2/.v3 rules in slide.html), so slides feel structurally distinct on swipe.
const VARIANTS = [
  { heroClass: "hero-br", hero: HERO.circles, mark: MARK.dots },
  { heroClass: "hero-cr", hero: HERO.circle, mark: MARK.bracket },
  { heroClass: "hero-tl", hero: HERO.circles, mark: MARK.plus },
];

function bodyHtml(text, variant, isLast, sourceNote) {
  const v = VARIANTS[variant];
  // The hero reaches the card's lower edge on some variants, where the source
  // box lives on the final slide — drop it there so nothing overlaps.
  const hero = isLast ? "" : `<div class="accent accent-hero ${v.heroClass}">${v.hero}</div>`;
  return `
  <div class="body-slide v${variant + 1}">
    <div class="ring ring-outer"></div>
    <div class="ring ring-inner"></div>
    <div class="ring ring-bl"></div>
    <div class="card">
      ${hero}
      <div class="accent accent-mark mark-tr">${v.mark}</div>
      <div class="top-row">
        <span class="kicker">Electronic Music Facts</span>
      </div>
      <div class="body-text-wrap">
        <div class="body-text">${esc(text)}</div>
      </div>
      ${isLast ? `<div class="source">Source: ${esc(sourceNote)}</div>` : ""}
    </div>
    <div class="footer"><img class="footer-logo" src="${logoUri}" alt=""><span>${esc(config.postHandle)}</span></div>
  </div>`;
}

const IG_CAROUSEL_MAX = 10;

/**
 * Render the carousel: cover (photo/Grok image + headline overlay) followed by
 * one branded text slide per fact.slides entry. When coverImage carries an
 * extraPhoto (a second distinct Commons photo of the subject), one full-bleed
 * photo slide is inserted in the middle. Returns ordered PNG paths.
 */
export async function renderSlides(fact, coverImage, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const template = fs.readFileSync(templatePath, "utf8");

  const bodySlides = fact.slides.map((text, i) =>
    bodyHtml(text, i % VARIANTS.length, i === fact.slides.length - 1, fact.source_note),
  );

  // Drop the optional photo slide into the middle of the body slides, but only
  // if it keeps the carousel within Instagram's 10-item limit.
  const extra = coverImage.extraPhoto;
  const withinLimit = 1 + bodySlides.length + 1 <= IG_CAROUSEL_MAX;
  if (extra && withinLimit) {
    const mid = Math.ceil(bodySlides.length / 2);
    bodySlides.splice(mid, 0, photoSlideHtml(extra));
  }

  const slides = [coverHtml(fact, coverImage), ...bodySlides];

  const browser = await puppeteer.launch({
    args: ["--no-sandbox", "--force-color-profile=srgb"],
  });
  const paths = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 });

    for (let i = 0; i < slides.length; i++) {
      const html = template.replace("<!--SLIDE_CONTENT-->", slides[i]);
      await page.setContent(html, { waitUntil: "load" });
      const file = path.join(outDir, `slide-${String(i).padStart(2, "0")}.png`);
      await page.screenshot({ path: file, type: "png" });
      paths.push(file);
      console.log(`[renderSlides] wrote ${file}`);
    }
  } finally {
    await browser.close();
  }
  return paths;
}
