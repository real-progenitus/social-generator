import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { recordUsedCommonsPhoto, usedCommonsPhotoUrls } from "../db.js";
import { fetchCommonsPhotos } from "./fetchCommonsPhoto.js";

const XAI_IMAGES_URL = "https://api.x.ai/v1/images/generations";

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

async function downloadCommonsPhoto(photo, outDir, basename = "cover-raw") {
  const res = await fetch(photo.url);
  if (!res.ok) throw new Error(`Failed to download Commons photo: ${res.status}`);
  const ext = photo.mime === "image/png" ? ".png" : ".jpg";
  const file = path.join(outDir, `${basename}${ext}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return {
    path: file,
    mime: photo.mime,
    credit: photo.credit,
    attribution: `Photo: ${photo.credit} / Wikimedia Commons (${photo.license})`,
  };
}

// Kept deliberately plain: no "neon," "abstract composition," "waveforms," or
// illustrated-silhouette language — that vocabulary is what makes these read
// as obvious AI art. Ask for something a photographer could have shot, with
// real artistic/editorial intent (composition, light, mood) rather than a
// flat literal snapshot.
const NO_AI_LOOK =
  "Realistic photograph, not digital art or illustration. No text, no logos, no illustrated or " +
  "cartoon elements, no overlaid graphics, waveforms, or sound-wave visuals. Portrait orientation, " +
  "shot on a professional camera with intentional, artistic composition: dramatic natural light, " +
  "meaningful framing, shallow depth of field, a genuine editorial/documentary-photography feel.";

function buildPrompt(fact) {
  if (fact.fact_type === "artist_specific" && fact.artist_name) {
    if (config.artistImageMode === "photoreal") {
      // Explicit opt-in only — see README §2.2 for the legal/platform risk.
      return (
        `Artistic editorial photograph evoking the world of ${fact.artist_name}: stage, gear, and ` +
        `atmosphere from their era of electronic music. Theme: ${fact.topic}. ${NO_AI_LOOK}`
      );
    }
    return (
      `Artistic photograph of the gear, stage, and atmosphere associated with ${fact.artist_name}'s ` +
      `era of electronic music: synthesizers, mixing decks, turntables, or an empty stage or venue. ` +
      `No people, no faces, no human figures or silhouettes. Theme: ${fact.topic}. ${NO_AI_LOOK}`
    );
  }
  return `Artistic photograph representing: ${fact.topic}. An authentic club, festival, or studio environment. ${NO_AI_LOOK}`;
}

function mockCover(outDir) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1350" viewBox="0 0 1080 1350">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#1a1e2e"/>
      <stop offset="0.55" stop-color="#14172380"/>
      <stop offset="1" stop-color="#0d0f1a"/>
    </linearGradient>
  </defs>
  <rect width="1080" height="1350" fill="url(#bg)"/>
  ${Array.from({ length: 54 }, (_, i) => {
    const x = 40 + i * 19;
    const h = 120 + Math.abs(Math.sin(i * 0.7)) * 420;
    const y = 675 - h / 2;
    return `<rect x="${x}" y="${y.toFixed(0)}" width="9" height="${h.toFixed(0)}" rx="4" fill="#ffffff" opacity="${(0.18 + 0.4 * Math.abs(Math.cos(i * 0.45))).toFixed(2)}"/>`;
  }).join("\n  ")}
  <circle cx="850" cy="280" r="180" fill="none" stroke="#ffffff" stroke-width="2" opacity="0.35"/>
  <circle cx="850" cy="280" r="120" fill="none" stroke="#ffffff" stroke-width="2" opacity="0.5"/>
</svg>`;
  const file = path.join(outDir, "cover-raw.svg");
  fs.writeFileSync(file, svg);
  return { path: file, mime: "image/svg+xml" };
}

/**
 * Generate the cover artwork. Tries a real, freely-licensed photo of the
 * fact's subject (artist, venue, or festival) from Wikimedia Commons first —
 * more authentic than AI art, and sidesteps generating a likeness of a real
 * person. Falls back to the xAI (Grok) image API otherwise or on any error.
 * Returns { path, mime, attribution? } of the raw image; the renderer
 * overlays the headline.
 */
export async function generateCover(fact, outDir) {
  fs.mkdirSync(outDir, { recursive: true });

  if (config.localCoverImage) {
    console.log(`[generateCover] LOCAL_COVER_IMAGE — using ${config.localCoverImage}`);
    return localCover(config.localCoverImage, outDir);
  }

  const photoSubject =
    fact.image_subject || (fact.fact_type === "artist_specific" ? fact.artist_name : null);
  if (!config.mockMode && photoSubject) {
    try {
      // Pull up to two distinct photos: the first is the cover, the second (if
      // the subject is well documented enough to have one) becomes an extra
      // full-bleed slide in the middle of the carousel.
      const photos = await fetchCommonsPhotos(photoSubject, usedCommonsPhotoUrls());
      if (photos.length > 0) {
        const [coverPhoto, extra] = photos;
        console.log(`[generateCover] using Wikimedia Commons photo of "${photoSubject}" (${coverPhoto.license})`);
        recordUsedCommonsPhoto(coverPhoto.descriptionUrl, photoSubject);
        const cover = await downloadCommonsPhoto(coverPhoto, outDir);
        if (extra) {
          console.log(`[generateCover] second Commons photo of "${photoSubject}" available — adding extra photo slide`);
          recordUsedCommonsPhoto(extra.descriptionUrl, photoSubject);
          cover.extraPhoto = await downloadCommonsPhoto(extra, outDir, "extra-raw");
        }
        return cover;
      }
      console.log(`[generateCover] no unused Commons photo for "${photoSubject}" — falling back to AI generation`);
    } catch (err) {
      console.warn(`[generateCover] Commons photo lookup failed (${err.message}) — falling back to AI generation`);
    }
  }

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
