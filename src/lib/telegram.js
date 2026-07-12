import { config } from "../config.js";

// Raw Telegram Bot API wrapper — no SDK. Each process only ever talks to the
// one bot configured in its own .env file (config.telegramBotToken), so this
// needs no parameterization: the post-review flow and the fb-responder's
// approval flow each get their own bot via their own .env.<name>.
const API = (method) =>
  `https://api.telegram.org/bot${config.telegramBotToken}/${method}`;

export async function tg(method, payload) {
  const isForm = payload instanceof FormData;
  const res = await fetch(API(method), {
    method: "POST",
    headers: isForm ? undefined : { "Content-Type": "application/json" },
    body: isForm ? payload : JSON.stringify(payload),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`Telegram ${method} failed: ${JSON.stringify(json)}`);
  return json.result;
}
