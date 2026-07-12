import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";
import { config } from "../config.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const templatePath = path.join(here, "..", "..", "templates", "food-slide.html");
const logoPath = path.join(here, "..", "..", "assets", "food-logo.png");

const KICKER = "BiteMeWeekly";
const WIDTH = 1080;
const HEIGHT = 1350;

// Lazy + memoized, unlike renderSlides.js's module-top-level read — a missing
// food-logo.png then only breaks a food run at the point it's actually
// needed, never a static-import-time crash that could take down the music
// pipeline (which never calls anything in this file).
let logoUriCache;
function logoUri() {
  if (!logoUriCache) {
    logoUriCache = `data:image/png;base64,${fs.readFileSync(logoPath).toString("base64")}`;
  }
  return logoUriCache;
}

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
      <span class="kicker">${esc(KICKER)}</span>
      <div class="headline">${esc(fact.headline)}</div>
      <div class="handle">${esc(config.postHandle)} &nbsp;•&nbsp; swipe →</div>
    </div>
  </div>`;
}

// Same hero/mark cycling as renderSlides.js's bodyHtml, so trivia posts read
// with the same "structurally distinct on swipe" feel as the music account.
const HERO = {
  circles: `<svg width="360" height="360" viewBox="0 0 360 360" fill="none" stroke="currentColor" stroke-width="3"><circle cx="180" cy="180" r="178"/><circle cx="180" cy="180" r="126"/><circle cx="180" cy="180" r="74"/></svg>`,
  circle: `<svg width="320" height="320" viewBox="0 0 320 320" fill="none" stroke="currentColor" stroke-width="3"><circle cx="160" cy="160" r="158"/></svg>`,
};
const MARK = {
  dots: `<svg width="26" height="118" viewBox="0 0 26 118" fill="currentColor"><circle cx="13" cy="13" r="10"/><circle cx="13" cy="59" r="10"/><circle cx="13" cy="105" r="10"/></svg>`,
  bracket: `<svg width="84" height="84" viewBox="0 0 84 84" fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"><path d="M80 8 H8 V80"/></svg>`,
  plus: `<svg width="72" height="72" viewBox="0 0 72 72" fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round"><path d="M36 8 V64 M8 36 H64"/></svg>`,
};
const VARIANTS = [
  { heroClass: "hero-br", hero: HERO.circles, mark: MARK.dots },
  { heroClass: "hero-cr", hero: HERO.circle, mark: MARK.bracket },
  { heroClass: "hero-tl", hero: HERO.circles, mark: MARK.plus },
];

function footer() {
  return `<div class="footer"><img class="footer-logo" src="${logoUri()}" alt=""><span>${esc(config.postHandle)}</span></div>`;
}

function cardShell(variant, isLast, kicker, bodyInner, sourceNote) {
  const v = VARIANTS[variant];
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
        <span class="kicker">${esc(kicker)}</span>
      </div>
      ${bodyInner}
      ${isLast ? `<div class="source">Source: ${esc(sourceNote)}</div>` : ""}
    </div>
    ${footer()}
  </div>`;
}

function triviaBodyHtml(text, variant, isLast, sourceNote) {
  const inner = `
      <div class="body-text-wrap">
        <div class="body-text">${esc(text)}</div>
      </div>`;
  return cardShell(variant, isLast, KICKER, inner, sourceNote);
}

function ingredientsHtml(fact, variant) {
  const meta = [fact.servings, fact.prep_time && `Prep ${fact.prep_time}`, fact.cook_time && `Cook ${fact.cook_time}`]
    .filter(Boolean)
    .join("  ·  ");
  const inner = `
      <div class="recipe-title">${esc(fact.dish_name)}</div>
      ${meta ? `<div class="recipe-meta">${esc(meta)}</div>` : ""}
      ${fact.health_note ? `<div class="health-note">${esc(fact.health_note)}</div>` : ""}
      <div class="section-label">Ingredients</div>
      <ul class="ingredients-list">
        ${fact.ingredients.map((i) => `<li>${esc(i)}</li>`).join("\n        ")}
      </ul>`;
  return cardShell(variant, false, KICKER, inner, null);
}

function stepsHtml(stepsChunk, startIndex, variant, isLast, sourceNote) {
  const inner = `
      <div class="section-label">Method</div>
      <ol class="steps-list" start="${startIndex + 1}">
        ${stepsChunk.map((s) => `<li>${esc(s)}</li>`).join("\n        ")}
      </ol>`;
  return cardShell(variant, isLast, KICKER, inner, sourceNote);
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const IG_CAROUSEL_MAX = 10;
const STEPS_PER_SLIDE = 4;

/**
 * Render a bitemeweekly carousel: cover (Grok image + headline overlay)
 * followed by either a recipe body (ingredients slide + chunked steps
 * slides) or a trivia body (one slide per fact.slides entry, same
 * variant-cycling as the music account). Returns ordered PNG paths.
 */
export async function renderFoodSlides(fact, coverImage, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const template = fs.readFileSync(templatePath, "utf8");

  let bodySlides;
  if (fact.fact_type === "recipe") {
    const stepChunks = chunk(fact.steps, STEPS_PER_SLIDE);
    bodySlides = [
      ingredientsHtml(fact, 0),
      ...stepChunks.map((c, i) =>
        stepsHtml(c, i * STEPS_PER_SLIDE, (i + 1) % VARIANTS.length, i === stepChunks.length - 1, fact.source_note),
      ),
    ];
  } else {
    bodySlides = fact.slides.map((text, i) =>
      triviaBodyHtml(text, i % VARIANTS.length, i === fact.slides.length - 1, fact.source_note),
    );
  }

  const slides = [coverHtml(fact, coverImage), ...bodySlides];
  if (slides.length > IG_CAROUSEL_MAX) {
    throw new Error(`renderFoodSlides: ${slides.length} slides exceeds Instagram's ${IG_CAROUSEL_MAX}-item limit`);
  }

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
      console.log(`[renderFoodSlides] wrote ${file}`);
    }
  } finally {
    await browser.close();
  }
  return paths;
}
