import { config } from "../../config.js";
import { recordImageCall } from "../apiMetrics.js";

// fal.ai is an aggregator: the model id *is* the path, so one client covers
// FLUX, Ideogram, Recraft and the rest — which is why a single integration
// yields several genbot agents. https://fal.run/<model-id> is the synchronous
// endpoint (it blocks until the result is ready); the queue endpoint is only
// needed for the long-running video models.
const FAL_BASE_URL = "https://fal.run";

/**
 * Instrumented entry point for fal.ai image generation. Shaped like
 * generateGrokImage / generateOpenAiImage so the genbot registry can treat
 * every image agent identically.
 *
 * @param {object} opts
 * @param {string} opts.prompt
 * @param {string} opts.account
 * @param {string} opts.operation
 * @param {string} opts.model          fal model id, e.g. "fal-ai/flux-pro/v1.1-ultra".
 * @param {number} [opts.unitPriceUsd]
 * @param {object} [opts.input]        Extra model-specific input fields.
 * @returns {Promise<{ b64: string, mime: string }>}
 */
export async function generateFalImage({ prompt, account, operation, model, unitPriceUsd, input = {} }) {
  const start = Date.now();
  try {
    const res = await fetch(`${FAL_BASE_URL}/${model}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // fal uses "Key <token>", not "Bearer".
        Authorization: `Key ${config.falApiKey}`,
      },
      body: JSON.stringify({ prompt, num_images: 1, ...input }),
    });

    if (!res.ok) {
      const body = await res.text();
      // fal reports an empty wallet as 403 "User is locked. Reason: TOP_UP",
      // which reads like an account suspension rather than "add credits".
      // Translate it, since this is the first thing you hit on a new key.
      if (res.status === 403 && body.includes("TOP_UP")) {
        throw new Error("fal.ai has no credit left — top up at fal.ai/dashboard/billing.");
      }
      throw new Error(`fal.ai API error ${res.status}: ${body.slice(0, 500)}`);
    }

    const json = await res.json();
    const image = json.images?.[0] ?? json.image;
    if (!image?.url) throw new Error("fal.ai returned no image URL");

    // fal hands back a CDN URL rather than inline bytes, so fetch it here —
    // callers get the same { b64, mime } every other image client returns.
    const imgRes = await fetch(image.url);
    if (!imgRes.ok) throw new Error(`fal.ai image download failed: ${imgRes.status}`);
    const b64 = Buffer.from(await imgRes.arrayBuffer()).toString("base64");

    recordImageCall({
      account,
      provider: "fal",
      model,
      operation,
      durationMs: Date.now() - start,
      imageCount: 1,
      unitPriceUsd,
      status: "ok",
    });
    return { b64, mime: image.content_type ?? "image/jpeg" };
  } catch (err) {
    recordImageCall({
      account,
      provider: "fal",
      model,
      operation,
      durationMs: Date.now() - start,
      unitPriceUsd,
      status: "error",
      error: err,
    });
    throw err;
  }
}
