import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { tg } from "../lib/telegram.js";

const EXT_BY_MIME = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "video/mp4": ".mp4",
};

// Generated assets are kept on disk rather than held in memory because the
// "📎 Original" button re-sends the same bytes uncompressed, potentially long
// after the generation finished (and after a restart).
const genDir = path.join(config.outputDir, "genbot");

/** Persist one generated asset and return its path. */
export function saveAsset({ requestId, agentKey, b64, mime }) {
  fs.mkdirSync(genDir, { recursive: true });
  const file = path.join(genDir, `${requestId}-${agentKey}${EXT_BY_MIME[mime] ?? ".png"}`);
  fs.writeFileSync(file, Buffer.from(b64, "base64"));
  return file;
}

const MIME_BY_EXT = Object.fromEntries(
  Object.entries(EXT_BY_MIME).map(([mime, ext]) => [ext, mime]),
);

/** Mime for a saved asset, recovered from its extension. */
export function mimeOf(filePath) {
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Fetch a provider-hosted result (video jobs return a URL, not bytes) and
 * store it exactly like a generated asset, so /again and the poller's
 * restart path find it in the same place.
 */
export async function downloadTo(url, { requestId, agentKey, mime }) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`asset download failed: ${res.status}`);
  const b64 = Buffer.from(await res.arrayBuffer()).toString("base64");
  return saveAsset({ requestId, agentKey, b64, mime });
}

export function assetPath(requestId, agentKey) {
  if (!fs.existsSync(genDir)) return null;
  const prefix = `${requestId}-${agentKey}.`;
  const match = fs.readdirSync(genDir).find((f) => f.startsWith(prefix));
  return match ? path.join(genDir, match) : null;
}

// Multipart upload via the tg() wrapper, which already accepts a FormData
// body. Same Blob-from-file pattern as sendForReview() in src/steps/review.js.
function fileForm(chatId, field, filePath, mime, extra = {}) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append(field, new Blob([fs.readFileSync(filePath)], { type: mime }), path.basename(filePath));
  for (const [k, v] of Object.entries(extra)) {
    form.append(k, typeof v === "string" ? v : JSON.stringify(v));
  }
  return form;
}

/**
 * Upload a generated image into the chat. Telegram re-encodes anything sent
 * via sendPhoto, so the caption carries a button that re-sends the untouched
 * file as a document.
 */
export async function sendImage({ chatId, filePath, mime, caption, requestId, agentKey }) {
  return tg(
    "sendPhoto",
    fileForm(chatId, "photo", filePath, mime, {
      caption,
      reply_markup: {
        inline_keyboard: [
          [
            { text: "📎 Original", callback_data: `o:${requestId}:${agentKey}` },
            { text: "🔁 Again", callback_data: `r:${requestId}:${agentKey}` },
          ],
        ],
      },
    }),
  );
}

/** Re-send a generated asset uncompressed, exactly as the provider returned it. */
export async function sendOriginal({ chatId, filePath }) {
  return tg("sendDocument", fileForm(chatId, "document", filePath, mimeOf(filePath)));
}

/** Upload a generated video into the chat (v2 — the gen_jobs seam). */
export async function sendVideo({ chatId, filePath, caption }) {
  return tg(
    "sendVideo",
    fileForm(chatId, "video", filePath, "video/mp4", { caption, supports_streaming: "true" }),
  );
}
