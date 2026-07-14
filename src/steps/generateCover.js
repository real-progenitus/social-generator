import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { recordUsedCommonsPhoto, usedCommonsPhotoUrls } from "../db.js";
import { generateGrokImage } from "../lib/grokImage.js";
import { fetchCommonsPhotos } from "./fetchCommonsPhoto.js";
import { fetchOpenversePhotos } from "./fetchOpenversePhoto.js";

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

async function downloadPhoto(photo, outDir, basename = "cover-raw", source = "Wikimedia Commons") {
  const res = await fetch(photo.url, {
    headers: { "User-Agent": `social-generator/1.0 (Instagram carousel bot; ${config.postHandle})` },
  });
  if (!res.ok) throw new Error(`Failed to download ${source} photo: ${res.status}`);
  const ext = photo.mime === "image/png" ? ".png" : ".jpg";
  const file = path.join(outDir, `${basename}${ext}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return {
    path: file,
    mime: photo.mime,
    credit: photo.credit,
    description: photo.description,
    attribution: `Photo: ${photo.credit} / ${source} (${photo.license})`,
  };
}

// Real-photo sources tried in order before AI generation. The shared
// used_commons_photos table dedups picked URLs across both (it's really a
// "used cover photo url" store, not Commons-specific).
const PHOTO_SOURCES = [
  [fetchCommonsPhotos, "Wikimedia Commons"],
  [fetchOpenversePhotos, "Openverse"],
];

async function tryPhotoSource(fetchPhotos, source, photoSubject, outDir) {
  // Up to two distinct photos: the first is the cover, the second (when the
  // subject is well documented) becomes an extra full-bleed mid-carousel slide.
  const photos = await fetchPhotos(photoSubject, usedCommonsPhotoUrls());
  if (photos.length === 0) return null;
  const [coverPhoto, extra] = photos;
  console.log(`[generateCover] using ${source} photo of "${photoSubject}" (${coverPhoto.license})`);
  recordUsedCommonsPhoto(coverPhoto.descriptionUrl, photoSubject);
  const cover = await downloadPhoto(coverPhoto, outDir, "cover-raw", source);
  if (extra) {
    console.log(`[generateCover] second ${source} photo of "${photoSubject}" available — adding extra photo slide`);
    recordUsedCommonsPhoto(extra.descriptionUrl, photoSubject);
    cover.extraPhoto = await downloadPhoto(extra, outDir, "extra-raw", source);
  }
  return cover;
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
  "cartoon elements, no overlaid graphics, waveforms, or sound-wave visuals. No recognizable faces of real " +
  "people. Portrait orientation, shot on a professional camera with intentional, artistic composition: " +
  "dramatic natural light, meaningful framing, a genuine editorial/documentary-photography feel. Frame it " +
  "tight as an extreme close-up or macro filling the frame with the single subject, not a wide establishing " +
  "shot of a whole stage, rig, or room. Shallow depth of field, softly blurred background.";

// fact.image_mood is generated name-free (see FACT_SCHEMA) so it's safe to drop
// into the prompt: a real artist/venue/festival name here tends to send Grok
// toward a likeness or a literal signage/logo read.
function moodClause(fact) {
  return fact.image_mood ? ` Mood: ${fact.image_mood}.` : "";
}

// The fact carries a specific, face-free cover_subject (see FACT_SCHEMA), so the
// Grok fallback shoots something tied to THIS fact instead of a stock gear shot.
// Older facts (pre-cover_subject) or a rare empty value fall back to generic
// gear phrasing keyed off the subject/topic.
function grokSubject(fact) {
  if (fact.cover_subject) return fact.cover_subject;
  if (fact.fact_type === "artist_specific" && fact.artist_name) {
    return (
      `one small, generic piece of gear from ${fact.artist_name}'s era of electronic music ` +
      "(a hand on a mixer fader, a spinning vinyl record, a synthesizer's glowing knobs), no people or faces"
    );
  }
  return (
    `one small, generic detail representing ${fact.topic}: a hand on a mixer fader, a spinning record, ` +
    "glowing equipment knobs, or a close crop of club lighting"
  );
}

function buildPrompt(fact) {
  return `Extreme close-up photograph of ${grokSubject(fact)}.${moodClause(fact)} ${NO_AI_LOOK}`;
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
    for (const [fetchPhotos, source] of PHOTO_SOURCES) {
      try {
        const cover = await tryPhotoSource(fetchPhotos, source, photoSubject, outDir);
        if (cover) return cover;
        console.log(`[generateCover] no unused ${source} photo for "${photoSubject}"`);
      } catch (err) {
        console.warn(`[generateCover] ${source} lookup failed (${err.message})`);
      }
    }
    console.log(`[generateCover] no real photo for "${photoSubject}" — falling back to AI generation`);
  }

  if (config.mockMode) {
    console.log("[generateCover] MOCK_MODE — generating placeholder SVG cover");
    return mockCover(outDir);
  }

  const prompt = buildPrompt(fact);
  console.log(`[generateCover] mode=${config.artistImageMode} prompt: ${prompt.slice(0, 120)}...`);

  const b64 = await generateGrokImage({
    prompt,
    account: config.accountLabel,
    operation: "cover",
  });

  const file = path.join(outDir, "cover-raw.jpg");
  fs.writeFileSync(file, Buffer.from(b64, "base64"));
  return { path: file, mime: "image/jpeg" };
}
