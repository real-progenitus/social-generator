import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { generateGrokImage } from "../lib/grokImage.js";

const MIME_BY_EXT = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".gif": "image/gif",
};

function localCover(imagePath, outDir) {
  const ext = path.extname(imagePath).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (!mime) {
    throw new Error(
      `LOCAL_COVER_IMAGE has unrecognized extension "${ext}" — use one of: ${Object.keys(MIME_BY_EXT).join(", ")}`,
    );
  }
  if (!fs.existsSync(imagePath)) {
    throw new Error(`LOCAL_COVER_IMAGE not found: ${imagePath}`);
  }
  const file = path.join(outDir, `cover-raw${ext}`);
  fs.copyFileSync(imagePath, file);
  return { path: file, mime };
}

function mockCover(outDir) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1350" viewBox="0 0 1080 1350">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#fdf6ec"/>
      <stop offset="0.55" stop-color="#f3e3c8"/>
      <stop offset="1" stop-color="#e8c98f"/>
    </linearGradient>
  </defs>
  <rect width="1080" height="1350" fill="url(#bg)"/>
  <circle cx="540" cy="675" r="260" fill="none" stroke="#8a6a3a" stroke-width="3" opacity="0.35"/>
  <circle cx="540" cy="675" r="180" fill="none" stroke="#8a6a3a" stroke-width="3" opacity="0.5"/>
</svg>`;
  const file = path.join(outDir, "cover-raw.svg");
  fs.writeFileSync(file, svg);
  return { path: file, mime: "image/svg+xml" };
}

// Kept plain and photographic, same rationale as generateCover.js's
// NO_AI_LOOK block: vague "food art" language is what makes AI images read
// as obviously AI. This exact prompt was validated against Unsplash in a
// side-by-side comparison — Grok was on-target and artifact-free on 4/4 test
// dishes where Unsplash's top search result was wrong on 3/4.
function buildPrompt(fact) {
  const dish = fact.image_subject || fact.dish_name;
  return (
    `Professional food photography of ${dish}, shot from a natural overhead or 45-degree angle on a DSLR camera ` +
    `with soft natural window light, shallow depth of field, appetizing rustic styling on a wooden or marble ` +
    `surface, realistic food texture, editorial food-magazine quality. No text, no logos, no illustration or ` +
    `cartoon elements, no watermark.`
  );
}

/**
 * Generate the cover artwork for a bitemeweekly post. Grok-only — no Commons
 * lookup: a stock-photo search doesn't need to match a real person's likeness
 * the way an artist photo does, but it also doesn't reliably match the exact
 * dish, and the comparison test showed Grok beating Unsplash's top result on
 * both relevance and quality for food specifically. Returns { path, mime } of
 * the raw image; the renderer overlays the headline.
 */
export async function generateFoodCover(fact, outDir) {
  fs.mkdirSync(outDir, { recursive: true });

  if (config.localCoverImage) {
    console.log(`[generateFoodCover] LOCAL_COVER_IMAGE — using ${config.localCoverImage}`);
    return localCover(config.localCoverImage, outDir);
  }

  if (config.mockMode) {
    console.log("[generateFoodCover] MOCK_MODE — generating placeholder SVG cover");
    return mockCover(outDir);
  }

  const prompt = buildPrompt(fact);
  console.log(`[generateFoodCover] prompt: ${prompt.slice(0, 120)}...`);

  const b64 = await generateGrokImage({
    prompt,
    account: config.accountLabel,
    operation: "foodCover",
  });

  const file = path.join(outDir, "cover-raw.jpg");
  fs.writeFileSync(file, Buffer.from(b64, "base64"));
  return { path: file, mime: "image/jpeg" };
}
