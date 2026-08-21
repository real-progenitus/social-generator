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
 * @param {string} [opts.reasoningEffort] DeepSeek reasoning budget; "none"
 *                                  disables hidden reasoning entirely.
 * @returns {Promise<string>} assistant message content.
 */
export async function callDeepSeek({ account, operation, system, user, model, jsonMode = false, maxTokens = 4000, reasoningEffort }) {
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
        // deepseek-v4-flash reasons by default, spending part of max_tokens on
        // hidden reasoning_content before it writes the visible reply. Passing
        // "none" turns that off, which is what makes the last rung of
        // callDeepSeekWithRetry's ladder deterministic.
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
        ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`DeepSeek API error ${res.status}: ${body.slice(0, 500)}`);
    }

    const json = await res.json();
    const choice = json.choices?.[0];
    const text = choice?.message?.content;
    // finish_reason separates the common failure (reasoning_content ate the
    // whole max_tokens budget => "length") from a genuinely empty answer.
    if (!text)
      throw new Error(
        `DeepSeek API returned no message content (finish_reason=${choice?.finish_reason ?? "unknown"})`,
      );
    // A truncated answer is worse than an empty one: the caller gets plausible
    // text that is actually cut off mid-token, so in jsonMode JSON.parse throws
    // *downstream* of the retry ladder and no retry ever happens. Treating it
    // as a failure here is what lets callDeepSeekWithRetry see it — and its
    // last attempt, with reasoning off, has the whole budget for the answer.
    if (choice.finish_reason === "length")
      throw new Error("DeepSeek response was truncated before it finished (finish_reason=length)");

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

/**
 * callDeepSeek with a retry ladder, for call sites that have no second
 * provider to fall back to. The ifound responder is the case this exists for:
 * a real person's DM must not go unanswered because one model call came back
 * empty (and previously, because a *different* provider's billing had lapsed).
 *
 * The failure this defends against is deepseek-v4-flash spending its entire
 * max_tokens budget on hidden reasoning and returning empty content. Reasoning
 * length is stochastic and does not correlate with input length, so simply
 * asking again usually clears it; the final attempt disables reasoning
 * outright, trading a little language-detection nuance for an answer that
 * cannot fail this particular way.
 *
 * @param {object}   opts             Everything callDeepSeek takes, plus:
 * @param {number}   [opts.attempts]  Total tries; the last runs reasoning-free.
 * @param {function} [opts.onRetry]   Called with (err, attemptNumber) per failure.
 * @returns {Promise<string>} assistant message content.
 */
export async function callDeepSeekWithRetry({ attempts = 3, onRetry, ...opts }) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const finalAttempt = attempt === attempts;
    try {
      return await callDeepSeek({
        ...opts,
        // Last chance: no reasoning, so the whole budget goes to the answer.
        ...(finalAttempt ? { reasoningEffort: "none" } : {}),
      });
    } catch (err) {
      lastErr = err;
      onRetry?.(err, attempt);
      // Short, growing pause so a transient 5xx or rate-limit isn't retried
      // instantly. Skipped after the final attempt — we're about to throw.
      if (!finalAttempt) await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
  throw lastErr;
}
