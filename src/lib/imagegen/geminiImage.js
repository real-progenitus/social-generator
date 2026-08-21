import { config } from "../../config.js";
import { recordImageCall } from "../apiMetrics.js";

// Same base URL as geminiClient.js, but the generation side: the "Nano Banana"
// image models return their picture as an inlineData part on an ordinary
// :generateContent response, rather than through a separate images endpoint
// the way xAI and OpenAI do.
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

/**
 * Instrumented entry point for Gemini image generation. Shaped like
 * generateGrokImage / generateOpenAiImage so the genbot registry can treat
 * every image agent identically.
 *
 * @param {object} opts
 * @param {string} opts.prompt
 * @param {string} opts.account
 * @param {string} opts.operation
 * @param {string} [opts.model]        Overrides config.geminiImageModel.
 * @param {number} [opts.unitPriceUsd]
 * @returns {Promise<{ b64: string, mime: string }>}
 */
export async function generateGeminiImage({ prompt, account, operation, model, unitPriceUsd }) {
  const start = Date.now();
  const resolvedModel = model ?? config.geminiImageModel;
  try {
    const res = await fetch(
      `${GEMINI_BASE_URL}/models/${resolvedModel}:generateContent?key=${config.geminiApiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      },
    );

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Gemini image API error ${res.status}: ${body.slice(0, 500)}`);
    }

    const json = await res.json();
    // The response interleaves text and image parts, and the model often
    // narrates before it draws — so find the image part rather than assuming
    // parts[0] is it.
    const parts = json.candidates?.[0]?.content?.parts ?? [];
    const imagePart = parts.find((p) => p.inlineData?.data ?? p.inline_data?.data);
    const inline = imagePart?.inlineData ?? imagePart?.inline_data;
    if (!inline?.data) {
      // A safety block comes back as a 200 with no image, so surface the
      // reason instead of a bare "no data".
      const reason = json.candidates?.[0]?.finishReason ?? json.promptFeedback?.blockReason;
      throw new Error(
        `Gemini image API returned no image data${reason ? ` (${reason})` : ""}`,
      );
    }

    recordImageCall({
      account,
      provider: "gemini",
      model: resolvedModel,
      operation,
      durationMs: Date.now() - start,
      imageCount: 1,
      unitPriceUsd,
      status: "ok",
    });
    return { b64: inline.data, mime: inline.mimeType ?? inline.mime_type ?? "image/png" };
  } catch (err) {
    recordImageCall({
      account,
      provider: "gemini",
      model: resolvedModel,
      operation,
      durationMs: Date.now() - start,
      unitPriceUsd,
      status: "error",
      error: err,
    });
    throw err;
  }
}
