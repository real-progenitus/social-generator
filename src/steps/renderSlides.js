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

// Minimal geometric accent marks, in ink at low opacity, rotated per body
// slide so consecutive slides don't look identical. Top-right mark + a bottom
// accent per variant; slide.html positions and fades them via the CSS classes.
const ACCENTS = [
  // v1: dot grid (top-right) + underline stroke (bottom-left)
  `<div class="accent accent-tr"><svg width="60" height="60" viewBox="0 0 60 60" fill="currentColor"><circle cx="6" cy="6" r="4"/><circle cx="30" cy="6" r="4"/><circle cx="54" cy="6" r="4"/><circle cx="6" cy="30" r="4"/><circle cx="30" cy="30" r="4"/><circle cx="54" cy="30" r="4"/><circle cx="6" cy="54" r="4"/><circle cx="30" cy="54" r="4"/><circle cx="54" cy="54" r="4"/></svg></div>
   <div class="accent accent-bl"><svg width="160" height="12" viewBox="0 0 160 12" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"><path d="M4 6 H156"/></svg></div>`,
  // v2: plus + circle (top-right) + quarter-circle arc (bottom-right)
  `<div class="accent accent-tr"><svg width="72" height="44" viewBox="0 0 72 44" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"><path d="M18 6 V38 M2 22 H34"/><circle cx="56" cy="22" r="12"/></svg></div>
   <div class="accent accent-br"><svg width="120" height="120" viewBox="0 0 120 120" fill="none" stroke="currentColor" stroke-width="4"><path d="M4 116 A112 112 0 0 0 116 4"/></svg></div>`,
  // v3: corner ticks (top-right) + vertical dashes (bottom-left)
  `<div class="accent accent-tr"><svg width="56" height="56" viewBox="0 0 56 56" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"><path d="M52 20 V4 H36"/><path d="M4 52 H20"/></svg></div>
   <div class="accent accent-bl"><svg width="104" height="36" viewBox="0 0 104 36" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"><path d="M6 6 V30 M34 6 V30 M62 6 V30 M90 6 V30"/></svg></div>`,
];

function bodyHtml(text, variant, isLast, sourceNote) {
  const v = variant + 1;
  return `
  <div class="body-slide v${v}">
    <div class="ring ring-outer"></div>
    <div class="ring ring-inner"></div>
    <div class="ring ring-bl"></div>
    <div class="card">
      ${ACCENTS[variant]}
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
    bodyHtml(text, i % ACCENTS.length, i === fact.slides.length - 1, fact.source_note),
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
