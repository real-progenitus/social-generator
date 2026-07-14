import { config } from "../config.js";
import { recordDeepSeekCall } from "./apiMetrics.js";

// OpenAI-compatible endpoint. DeepSeek also exposes an Anthropic-compatible
// endpoint, but plain chat/completions over fetch keeps this dependency-free
// and matches grokImage.js's shape.
const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

/**
 * Single instrumented entry point for DeepSeek chat completions. Times the
 * request and records tokens/cost (cache-hit/miss aware) into the shared
 * metrics store. Returns the assistant message text, or throws on API/parse
 * error.
 *
 * @param {object} opts
 * @param {string} opts.account     Account label for the dashboard.
 * @param {string} opts.operation   Call-site label (e.g. "generateFact").
 * @param {string} opts.system      System prompt.
 * @param {string} opts.user        User message.
 * @param {string} [opts.model]     Overrides config.deepseekModel.
 * @param {boolean} [opts.jsonMode] Request response_format json_object (the
 *                                  prompt must contain the word "json").
 * @param {number} [opts.maxTokens]
 * @returns {Promise<string>} assistant message content.
 */
export async function callDeepSeek({ account, operation, system, user, model, jsonMode = false, maxTokens = 4000 }) {
  const start = Date.now();
  const resolvedModel = model ?? config.deepseekModel;
  try {
    const res = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.deepseekApiKey}`,
      },
      body: JSON.stringify({
        model: resolvedModel,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        max_tokens: maxTokens,
        ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`DeepSeek API error ${res.status}: ${body.slice(0, 500)}`);
    }

    const json = await res.json();
    const text = json.choices?.[0]?.message?.content;
    if (!text) throw new Error("DeepSeek API returned no message content");

    recordDeepSeekCall({
      account,
      model: resolvedModel,
      operation,
      durationMs: Date.now() - start,
      usage: json.usage,
      status: "ok",
    });
    return text;
  } catch (err) {
    recordDeepSeekCall({
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
