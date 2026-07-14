import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { recordClaudeCall } from "./apiMetrics.js";

/**
 * Single instrumented entry point for every Claude Messages API call in this
 * repo. Times the call, runs the `pause_turn` retry loop for server-tool
 * (web_search) turns via the pause_turn resend loop, and records
 * tokens/latency/cost into the shared metrics store. Usage is summed
 * across retry iterations so a multi-round search turn counts every token and
 * web_search request, not just the final response's.
 *
 * Everything except the metadata keys below (account, operation, search,
 * maxRetries) is passed straight through to messages.create as the request
 * params, so call sites keep their existing object shape with one extra key.
 *
 * @param {object}  opts
 * @param {string}  opts.account    Account label for the dashboard (e.g. "music", "ifound").
 * @param {string}  opts.operation  Call-site label (e.g. "generateFact", "fbReply").
 * @param {boolean} [opts.search]   True for calls using the web_search server tool.
 * @param {number}  [opts.maxRetries]
 * @param {...object} opts.params   Remaining keys = Messages API params (model, max_tokens, ...).
 * @returns the final Messages API response.
 */
export async function callClaude({ account, operation, search = false, maxRetries = 6, ...params }) {
  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const start = Date.now();

  const usage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    web_search_requests: 0,
  };
  const addUsage = (u) => {
    if (!u) return;
    usage.input_tokens += u.input_tokens ?? 0;
    usage.output_tokens += u.output_tokens ?? 0;
    usage.cache_read_input_tokens += u.cache_read_input_tokens ?? 0;
    usage.cache_creation_input_tokens += u.cache_creation_input_tokens ?? 0;
    usage.web_search_requests += u.server_tool_use?.web_search_requests ?? 0;
  };

  try {
    let resp = await client.messages.create(params);
    addUsage(resp.usage);

    if (search) {
      // A server-tool turn can stop with `pause_turn` if the tool's internal
      // iteration cap is hit before the model finishes; re-send with the
      // assistant turn appended so it can pick back up.
      let guard = 0;
      let p = params;
      while (resp.stop_reason === "pause_turn" && guard < maxRetries) {
        guard++;
        p = { ...p, messages: [...p.messages, { role: "assistant", content: resp.content }] };
        resp = await client.messages.create(p);
        addUsage(resp.usage);
      }
    }

    recordClaudeCall({
      account,
      model: params.model,
      operation,
      durationMs: Date.now() - start,
      usage,
      status: "ok",
    });
    return resp;
  } catch (err) {
    recordClaudeCall({
      account,
      model: params.model,
      operation,
      durationMs: Date.now() - start,
      usage,
      status: "error",
      error: err,
    });
    throw err;
  }
}
