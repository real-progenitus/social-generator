import { config } from "../../config.js";
import { recordImageCall } from "../apiMetrics.js";

// Plain fetch against the REST API, no SDK — same rationale as
// deepseekClient.js / grokImage.js / geminiClient.js.
const OPENAI_IMAGES_URL = "https://api.openai.com/v1/images/generations";

/**
 * Instrumented entry point for OpenAI image generation, shaped exactly like
 * generateGrokImage so src/genbot/registry.js can treat every image agent
 * identically.
 *
 * @param {object} opts
 * @param {string} opts.prompt
 * @param {string} opts.account       Account label for the dashboard.
 * @param {string} opts.operation     Call-site label (e.g. "genbot").
 * @param {string} [opts.model]       Overrides config.openaiImageModel.
 * @param {number} [opts.unitPriceUsd] Per-image price, from the registry entry.
 * @param {string} [opts.size]
 * @returns {Promise<{ b64: string, mime: string }>}
 */
export async function generateOpenAiImage({
  prompt,
  account,
  operation,
  model,
  unitPriceUsd,
  size = "1024x1024",
}) {
  const start = Date.now();
  const resolvedModel = model ?? config.openaiImageModel;
  try {
    const res = await fetch(OPENAI_IMAGES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.openaiApiKey}`,
      },
      // No response_format: gpt-image-1 always returns b64_json, and sending
      // the parameter it inherited from dall-e-3 is rejected as unsupported.
      body: JSON.stringify({ model: resolvedModel, prompt, n: 1, size }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenAI image API error ${res.status}: ${body.slice(0, 500)}`);
    }

    const json = await res.json();
    const b64 = json.data?.[0]?.b64_json;
    if (!b64) throw new Error("OpenAI image API returned no image data");

    recordImageCall({
      account,
      provider: "openai",
      model: resolvedModel,
      operation,
      durationMs: Date.now() - start,
      imageCount: 1,
      unitPriceUsd,
      status: "ok",
    });
    return { b64, mime: "image/png" };
  } catch (err) {
    recordImageCall({
      account,
      provider: "openai",
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
