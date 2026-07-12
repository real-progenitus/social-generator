import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";
import { config } from "../config.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const templatePath = path.join(here, "..", "..", "templates", "food-slide.html");

const KICKER = "BITE ME WEEKLY";
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

function eyebrow() {
  return `<div class="eyebrow"><span class="dot"></span>${esc(KICKER)}</div>`;
}

function footerRow(page, total) {
  return `
      <div class="footer-rule"></div>
      <div class="footer-row">
        <span><span class="dot"></span>${esc(config.postHandle.replace(/^@/, ""))}</span>
        <span>${String(page).padStart(2, "0")} — ${String(total).padStart(2, "0")}</span>
      </div>`;
}

function coverHtml(fact, coverImage) {
  const tag = fact.fact_type === "recipe" ? "Recipe" : "Trivia";
  return `
  <div class="slide">
    <div class="cover-photo" style="background-image: url('${imageUri(coverImage)}')"></div>
    <div class="cover-scrim"></div>
    <div class="cover-content">
      <span class="cover-tag"><span class="dot"></span>${esc(tag)}</span>
      <div class="cover-headline">${esc(fact.headline)}</div>
      <div class="cover-foot">
        <span>${esc(config.postHandle)}</span>
        <span>Swipe →</span>
      </div>
    </div>
  </div>`;
}

function triviaBodyHtml(text, page, total, isLast, sourceNote) {
  return `
  <div class="slide">
    <div class="body-slide">
      ${eyebrow()}
      <div class="body-main"><div class="fact-text">${esc(text)}</div></div>
      ${isLast ? `<div class="source-line">Source: ${esc(sourceNote)}</div>` : ""}
      ${footerRow(page, total)}
    </div>
  </div>`;
}

function ingredientsHtml(fact, page, total) {
  const meta = [fact.servings, fact.prep_time && `Prep ${fact.prep_time}`, fact.cook_time && `Cook ${fact.cook_time}`]
    .filter(Boolean);
  const metaHtml = meta.map((m, i) => (i === 0 ? esc(m) : `<span class="sep">·</span>${esc(m)}`)).join(" ");
  const compact = fact.ingredients.length > 9 ? " compact" : "";
  const inner = `
      <div class="recipe-title">${esc(fact.dish_name)}</div>
      ${meta.length ? `<div class="recipe-meta">${metaHtml}</div>` : ""}
      ${fact.health_note ? `<div class="health-label">Why it works</div><div class="health-note">${esc(fact.health_note)}</div>` : ""}
      <div class="section-label">Ingredients</div>
      <ul class="ingredients-list${compact}">
        ${fact.ingredients.map((i) => `<li>${esc(i)}</li>`).join("\n        ")}
      </ul>`;
  return `
  <div class="slide">
    <div class="body-slide">
      ${eyebrow()}
      <div class="body-main" style="justify-content: flex-start; margin-top: 40px;">${inner}</div>
      ${footerRow(page, total)}
    </div>
  </div>`;
}

function stepsHtml(stepsChunk, startIndex, page, total, isLast, sourceNote) {
  const list = `
      <ol class="steps-list">
        ${stepsChunk
          .map((s, i) => `<li><span class="step-num">${startIndex + i + 1}</span>${esc(s)}</li>`)
          .join("\n        ")}
      </ol>`;
  return `
  <div class="slide">
    <div class="body-slide">
      ${eyebrow()}
      <div class="method-label">Method</div>
      <div class="body-main" style="margin-top: 0;">${list}</div>
      ${isLast ? `<div class="source-line">Source: ${esc(sourceNote)}</div>` : ""}
      ${footerRow(page, total)}
    </div>
  </div>`;
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
 * slides) or a trivia body (one slide per fact.slides entry). Returns
 * ordered PNG paths.
 */
export async function renderFoodSlides(fact, coverImage, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const template = fs.readFileSync(templatePath, "utf8");

  let bodySlides;
  if (fact.fact_type === "recipe") {
    const stepChunks = chunk(fact.steps, STEPS_PER_SLIDE);
    const total = 1 + stepChunks.length;
    bodySlides = [
      ingredientsHtml(fact, 1, total),
      ...stepChunks.map((c, i) =>
        stepsHtml(c, i * STEPS_PER_SLIDE, i + 2, total, i === stepChunks.length - 1, fact.source_note),
      ),
    ];
  } else {
    const total = fact.slides.length;
    bodySlides = fact.slides.map((text, i) =>
      triviaBodyHtml(text, i + 1, total, i === fact.slides.length - 1, fact.source_note),
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
