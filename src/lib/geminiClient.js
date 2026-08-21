import { config } from "../config.js";

// Plain fetch against the REST API, no SDK dependency — same rationale as
// deepseekClient.js/grokImage.js. Vision-only role in this codebase: this is
// NOT used for reply generation, only for describing image content (see
// generateReply.js's describeImageViaGemini) so DeepSeek/Claude can react to
// it as text.
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

/**
 * @param {object} opts
 * @param {string} opts.account      Account label (unused today, kept for
 *                                    parity with callDeepSeek in
 *                                    case this ever gets metered).
 * @param {string} opts.operation    Call-site label.
 * @param {string} opts.imageBase64  Base64-encoded image bytes, no data: URI prefix.
 * @param {string} opts.mimeType     e.g. "image/jpeg".
 * @param {string} opts.prompt       Text instruction accompanying the image.
 * @param {string} [opts.model]      Overrides config.geminiVisionModel.
 * @returns {Promise<string>} the model's text response.
 */
export async function callGeminiVision({ account, operation, imageBase64, mimeType, prompt, model }) {
  const resolvedModel = model ?? config.geminiVisionModel;
  const res = await fetch(
    `${GEMINI_BASE_URL}/models/${resolvedModel}:generateContent?key=${config.geminiApiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [{ inline_data: { mime_type: mimeType, data: imageBase64 } }, { text: prompt }],
          },
        ],
      }),
    },
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gemini API error ${res.status} (${account}/${operation}): ${body.slice(0, 500)}`);
  }

  const json = await res.json();
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error(`Gemini API returned no text (${account}/${operation})`);
  return text;
}
