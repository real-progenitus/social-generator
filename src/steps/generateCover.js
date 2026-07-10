import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

const XAI_IMAGES_URL = "https://api.x.ai/v1/images/generations";

function buildPrompt(fact) {
  if (fact.fact_type === "artist_specific" && fact.artist_name) {
    if (config.artistImageMode === "photoreal") {
      // Explicit opt-in only — see README §2.2 for the legal/platform risk.
      return (
        `Portrait-format editorial photograph evoking the world of ${fact.artist_name}: ` +
        `stage, gear and atmosphere associated with their era of electronic music. ` +
        `Moody club lighting, cinematic, high detail. Theme: ${fact.topic}.`
      );
    }
    return (
      `Stylized poster-art illustration inspired by the music of ${fact.artist_name} — ` +
      `NOT a realistic likeness or photograph of any person. Abstract silhouette, bold ` +
      `screen-print / pop-art treatment, symbolic imagery of their era and gear ` +
      `(synthesizers, turntables, club lights). Dark background, neon accents, ` +
      `portrait orientation. Theme: ${fact.topic}.`
    );
  }
  return (
    `Atmospheric electronic music visual: ${fact.topic}. Abstract composition — ` +
    `club lighting beams, waveforms, synthesizer close-up textures, crowd silhouettes. ` +
    `Dark background with vivid neon accents, cinematic haze, portrait orientation, ` +
    `no text, no readable words.`
  );
}

function mockCover(outDir) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1350" viewBox="0 0 1080 1350">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0d0221"/>
      <stop offset="0.55" stop-color="#1a0b3b"/>
      <stop offset="1" stop-color="#03121f"/>
    </linearGradient>
  </defs>
  <rect width="1080" height="1350" fill="url(#bg)"/>
  ${Array.from({ length: 54 }, (_, i) => {
    const x = 40 + i * 19;
    const h = 120 + Math.abs(Math.sin(i * 0.7)) * 420;
    const y = 675 - h / 2;
    return `<rect x="${x}" y="${y.toFixed(0)}" width="9" height="${h.toFixed(0)}" rx="4" fill="#b9ff2e" opacity="${(0.25 + 0.55 * Math.abs(Math.cos(i * 0.45))).toFixed(2)}"/>`;
  }).join("\n  ")}
  <circle cx="850" cy="280" r="180" fill="none" stroke="#ff2ea6" stroke-width="3" opacity="0.5"/>
  <circle cx="850" cy="280" r="120" fill="none" stroke="#2ee6ff" stroke-width="2" opacity="0.6"/>
</svg>`;
  const file = path.join(outDir, "cover-raw.svg");
  fs.writeFileSync(file, svg);
  return { path: file, mime: "image/svg+xml" };
}

/**
 * Generate the cover artwork via the xAI (Grok) image API.
 * Returns { path, mime } of the raw image; the renderer overlays the headline.
 */
export async function generateCover(fact, outDir) {
  fs.mkdirSync(outDir, { recursive: true });

  if (config.mockMode) {
    console.log("[generateCover] MOCK_MODE — generating placeholder SVG cover");
    return mockCover(outDir);
  }

  const prompt = buildPrompt(fact);
  console.log(`[generateCover] mode=${config.artistImageMode} prompt: ${prompt.slice(0, 120)}...`);

  const res = await fetch(XAI_IMAGES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.xaiApiKey}`,
    },
    body: JSON.stringify({
      model: config.grokImageModel,
      prompt,
      n: 1,
      response_format: "b64_json",
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`xAI image API error ${res.status}: ${body}`);
  }

  const json = await res.json();
  const b64 = json.data?.[0]?.b64_json;
  if (!b64) throw new Error("xAI image API returned no image data");

  const file = path.join(outDir, "cover-raw.jpg");
  fs.writeFileSync(file, Buffer.from(b64, "base64"));
  return { path: file, mime: "image/jpeg" };
}
