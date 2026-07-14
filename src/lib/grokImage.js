import { config } from "../config.js";
import { recordImageCall } from "./apiMetrics.js";

const XAI_IMAGES_URL = "https://api.x.ai/v1/images/generations";

/**
 * Single instrumented entry point for xAI Grok image generation. Times the
 * request and records it (one image, per-image cost) into the shared metrics
 * store. Returns the base64-encoded image, or throws on API/parse error.
 *
 * @param {object} opts
 * @param {string} opts.prompt
 * @param {string} opts.account    Account label for the dashboard.
 * @param {string} opts.operation  Call-site label (e.g. "cover", "foodCover").
 * @param {string} [opts.model]    Overrides config.grokImageModel — lets a
 *                                 caller A/B test a second model per call.
 * @returns {Promise<string>} base64 image data (b64_json).
 */
export async function generateGrokImage({ prompt, account, operation, model }) {
  const start = Date.now();
  const resolvedModel = model ?? config.grokImageModel;
  try {
    const res = await fetch(XAI_IMAGES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.xaiApiKey}`,
      },
      body: JSON.stringify({ model: resolvedModel, prompt, n: 1, response_format: "b64_json" }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`xAI image API error ${res.status}: ${body}`);
    }

    const json = await res.json();
    const b64 = json.data?.[0]?.b64_json;
    if (!b64) throw new Error("xAI image API returned no image data");

    recordImageCall({
      account,
      model: resolvedModel,
      operation,
      durationMs: Date.now() - start,
      imageCount: 1,
      status: "ok",
    });
    return b64;
  } catch (err) {
    recordImageCall({
      account,
      model: resolvedModel,
      operation,
      durationMs: Date.now() - start,
      status: "error",
      error: err,
    });
    throw err;
  }
}
