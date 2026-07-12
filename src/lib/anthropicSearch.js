// A server-tool (e.g. web_search) turn can stop with `pause_turn` if the
// tool's internal iteration cap is hit before the model produces its final
// answer; re-send with the assistant turn appended so it can pick back up.
// Generic across any Anthropic Messages API call using a server-side tool —
// no coupling to any particular schema, prompt, or account.
export async function createWithSearch(client, params, { maxRetries = 6 } = {}) {
  let resp = await client.messages.create(params);
  let guard = 0;
  while (resp.stop_reason === "pause_turn" && guard < maxRetries) {
    guard++;
    params = {
      ...params,
      messages: [...params.messages, { role: "assistant", content: resp.content }],
    };
    resp = await client.messages.create(params);
  }
  return resp;
}
