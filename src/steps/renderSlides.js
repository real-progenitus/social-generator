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

function coverHtml(fact, coverImage) {
  const data = fs.readFileSync(coverImage.path).toString("base64");
  const uri = `data:${coverImage.mime};base64,${data}`;
  return `
  <div class="cover" style="background-image: url('${uri}')">
    <div class="scrim"></div>
    <div class="content">
      <span class="kicker">Electronic Music Facts</span>
      <div class="headline">${esc(fact.headline)}</div>
      <div class="handle">${esc(config.postHandle)} &nbsp;•&nbsp; swipe →</div>
    </div>
  </div>`;
}

function bodyHtml(fact, index, total) {
  const isLast = index === total - 1;
  const num = String(index + 1).padStart(2, "0");
  return `
  <div class="body-slide">
    <div class="ring ring-outer"></div>
    <div class="ring ring-inner"></div>
    <div class="ring ring-bl"></div>
    <div class="card">
      <div class="ghost-num">${num}</div>
      <div class="top-row">
        <span class="kicker">Electronic Music Facts</span>
        <div class="slide-num">${num} <span class="total">/ ${String(total).padStart(2, "0")}</span></div>
      </div>
      <div class="body-text-wrap">
        <div class="body-text">${esc(fact.slides[index - 1])}</div>
      </div>
      ${isLast ? `<div class="source">Source: ${esc(fact.source_note)}</div>` : ""}
    </div>
    <div class="footer"><img class="footer-logo" src="${logoUri}" alt=""><span>${esc(config.postHandle)}</span></div>
  </div>`;
}

/**
 * Render the carousel: cover (Grok image + headline overlay) followed by one
 * branded text slide per fact.slides entry. Returns ordered PNG paths.
 */
export async function renderSlides(fact, coverImage, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const template = fs.readFileSync(templatePath, "utf8");
  const total = fact.slides.length + 1; // cover + body slides

  const slides = [
    coverHtml(fact, coverImage),
    ...fact.slides.map((_, i) => bodyHtml(fact, i + 1, total)),
  ];

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
