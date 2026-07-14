import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { recordUsedCommonsPhoto, usedCommonsPhotoUrls } from "../db.js";
import { generateGrokImage } from "../lib/grokImage.js";
import { fetchCommonsPhotos } from "./fetchCommonsPhoto.js";

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
  const res = await fetch(photo.url, {
    headers: { "User-Agent": `social-generator/1.0 (Instagram carousel bot; ${config.postHandle})` },
  });
  if (!res.ok) throw new Error(`Failed to download Commons photo: ${res.status}`);
  const ext = photo.mime === "image/png" ? ".png" : ".jpg";
  const file = path.join(outDir, `${basename}${ext}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return {
    path: file,
    mime: photo.mime,
    credit: photo.credit,
    description: photo.description,
    attribution: `Photo: ${photo.credit} / Wikimedia Commons (${photo.license})`,
  };
}

// Kept deliberately plain: no "neon," "abstract composition," "waveforms," or
// illustrated-silhouette language — that vocabulary is what makes these read
// as obvious AI art. Ask for something a photographer could have shot, with
// real artistic/editorial intent (composition, light, mood) rather than a
// flat literal snapshot.
// A wide shot asks the model to keep a whole stage/rig/room's worth of
// objects, cables, and architecture consistent at once — exactly where image
// models fall apart (mangled cables, duplicated/impossible gear, warped
// perspective), which is what made the fallback covers read as obviously AI.
// A tight close-up on one simple subject sidesteps that entirely.
const NO_AI_LOOK =
  "Realistic photograph, not digital art or illustration. No text, no logos, no illustrated or " +
  "cartoon elements, no overlaid graphics, waveforms, or sound-wave visuals. Portrait orientation, " +
  "shot on a professional camera with intentional, artistic composition: dramatic natural light, " +
  "meaningful framing, a genuine editorial/documentary-photography feel. Extreme close-up or macro " +
  "shot filling the frame with ONE simple, generic subject, not a wide establishing shot of a whole " +
  "stage, rig, or room: a single hand on a single fader, one spinning record, one set of glowing " +
  "synth knobs, one turntable needle on vinyl, one microphone. Shallow depth of field, softly " +
  "blurred background.";

function buildPrompt(fact) {
  if (fact.fact_type === "artist_specific" && fact.artist_name) {
    if (config.artistImageMode === "photoreal") {
      // Explicit opt-in only — see README §2.2 for the legal/platform risk.
      return (
        `Extreme close-up editorial photograph evoking the world of ${fact.artist_name}: one small, ` +
        `generic detail of gear or hands-on equipment from their era of electronic music, not a wide ` +
        `stage or rig shot. Theme: ${fact.topic}. ${NO_AI_LOOK}`
      );
    }
    return (
      `Extreme close-up photograph of one small, generic piece of gear associated with ${fact.artist_name}'s ` +
      `era of electronic music: a hand on a mixer fader, a spinning vinyl record, a synthesizer's glowing ` +
      `knobs, or a turntable needle on a record. No people, no faces, no human figures or silhouettes, no ` +
      `wide stage or venue shot. Theme: ${fact.topic}. ${NO_AI_LOOK}`
    );
  }
  return (
    `Extreme close-up photograph of one small, generic detail representing: ${fact.topic}. A hand on a ` +
    `mixer fader, a spinning record, glowing equipment knobs, or a close crop of club lighting, not a ` +
    `wide club, festival, or studio establishing shot. ${NO_AI_LOOK}`
  );
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

  const b64 = await generateGrokImage({
    prompt,
    account: config.account,
    operation: "cover",
  });

  const file = path.join(outDir, "cover-raw.jpg");
  fs.writeFileSync(file, Buffer.from(b64, "base64"));
  return { path: file, mime: "image/jpeg" };
}
