import { config, requireConfig } from "../config.js";
import { recordVideoCall } from "../lib/apiMetrics.js";
import { tg } from "../lib/telegram.js";
import { formatMoneyShort, providerMoney } from "./budgets.js";
import { createJob, createRequest, getRequest, lastRequest, pendingJobs, updateJob } from "./db.js";
import { assetPath, downloadTo, saveAsset, sendImage, sendOriginal, sendVideo } from "./deliver.js";
import { AGENTS, availableAgents, getAgent, runAgent } from "./registry.js";

// Providers surfaced by /balance beyond the generation agents themselves —
// they're billed by this repo's other services (fbresponder, generateFact), so
// showing them here makes /balance the single place to check what's left
// anywhere, not just what the genbot can spend.
const EXTRA_BALANCE_PROVIDERS = ["anthropic", "deepseek"];

const HELP = `🎨 Send me any message and I'll offer you agents to draw it.

  a neon cyberpunk cat in Lisbon

/image <prompt>   same thing, spelled out
/video <prompt>   generate a video (no video agents yet)
/balance          what's left with each provider
/agents           which agents are configured
/again            re-offer the picker for your last prompt
/help             this message`;

// ---------------------------------------------------------------------------
// Agent picker
// ---------------------------------------------------------------------------

async function sendPicker(chatId, requestId, prompt, kind = "image") {
  const agents = availableAgents(kind);
  if (agents.length === 0) {
    // Distinguish "you have no key for these" from "none of this kind exist
    // yet" — listing image-provider env vars in response to /video would just
    // send you looking for a key that wouldn't help.
    const registered = AGENTS.filter((a) => a.kind === kind);
    await tg("sendMessage", {
      chat_id: chatId,
      text: registered.length
        ? `No ${kind} agents are configured. Set at least one provider key in ` +
          `.env.genbot (${[...new Set(registered.flatMap((a) => a.requires))].join(", ")}) and restart.`
        : `No ${kind} agents exist yet — see src/genbot/registry.js.`,
    });
    return;
  }

  // Money figures are fetched in parallel: balances.js caches for a minute, so
  // this is usually free, and one slow provider shouldn't serialize the rest.
  const rows = await Promise.all(
    agents.map(async (a) => {
      const money = await providerMoney(a.provider);
      // Video costs ~25x an image, so the button leads with what this tap will
      // cost rather than only what's left — a $0.48 charge you didn't expect
      // is the one genuinely unpleasant surprise this bot can hand you.
      const price =
        a.kind === "video"
          ? `~$${((a.unitPriceUsd ?? 0) * config.grokVideoSeconds).toFixed(2)}`
          : formatMoneyShort(money);
      return [
        {
          text: `${a.emoji} ${a.label}   ${config.mockMode ? "🧪 mock" : price}`,
          callback_data: `g:${requestId}:${a.key}`,
        },
      ];
    }),
  );
  rows.push([{ text: "❌ Cancel", callback_data: `x:${requestId}:-` }]);

  await tg("sendMessage", {
    chat_id: chatId,
    text: `🎨 ${prompt}\n\nPick an agent:`,
    reply_markup: { inline_keyboard: rows },
  });
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

// In-flight "<requestId>:<agentKey>" pairs, so a double-tap on the same button
// waits instead of paying twice. In-process only — same scope and same
// limitation as the `publishing` Set in src/steps/review.js.
const generating = new Set();

async function runGeneration({ chatId, requestId, agent, messageId }) {
  const key = `${requestId}:${agent.key}`;
  if (generating.has(key)) {
    await tg("sendMessage", { chat_id: chatId, text: "⏳ That one's already running — hang tight." });
    return;
  }
  generating.add(key);

  const request = getRequest(requestId);
  const started = Date.now();
  try {
    // Replace the picker with a status line, so the keyboard can't be tapped
    // a second time and the chat shows what's happening.
    await tg("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: `🎨 ${request.prompt}\n\n⏳ Generating with ${agent.emoji} ${agent.label}…`,
    });

    const result = await runAgent(agent, request.prompt);

    // Async agents (video) hand back a provider job id instead of assets.
    // Persist it and let the poller drive it to completion — that way a job
    // in flight when the process dies is resumed on restart rather than
    // abandoned after you've already paid for it.
    if (result.externalJobId) {
      createJob({
        request_id: requestId,
        agent_key: agent.key,
        provider: agent.provider,
        external_job_id: result.externalJobId,
        status: "running",
        chat_id: String(chatId),
        status_message_id: messageId,
      });
      console.log(`[genbot] ${agent.key} job ${result.externalJobId} queued`);
      await tg("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: `🎬 ${request.prompt}\n\n⏳ ${agent.label} is rendering… this takes a minute or two.`,
      });
      return;
    }

    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    const money = await providerMoney(agent.provider);
    const cost = result.mocked ? "mock" : `$${(agent.unitPriceUsd ?? 0).toFixed(3)}`;

    for (const asset of result.assets) {
      const filePath = saveAsset({ requestId, agentKey: agent.key, b64: asset.b64, mime: asset.mime });
      await sendImage({
        chatId,
        filePath,
        mime: asset.mime,
        caption:
          `${agent.emoji} ${agent.label} · ${cost} · ${elapsed}s\n` +
          `${formatMoneyShort(money)} left${money.source === "estimate" ? " (est.)" : ""}`,
        requestId,
        agentKey: agent.key,
      });
    }

    await tg("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: `🎨 ${request.prompt}\n\n✅ ${agent.emoji} ${agent.label}`,
    });
  } catch (err) {
    console.error(`[genbot] ${agent.key} generation failed:`, err);
    // The failed call is already recorded as status='error' by the provider
    // client, so this only needs to tell the user — and re-offer the picker,
    // since the usual next move is to try a different agent.
    await tg("sendMessage", {
      chat_id: chatId,
      text: `⚠️ ${agent.label} failed: ${err.message}`,
    });
    await sendPicker(chatId, requestId, request.prompt, request.kind);
  } finally {
    generating.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function sendBalance(chatId) {
  const providers = [...new Set([...AGENTS.map((a) => a.provider), ...EXTRA_BALANCE_PROVIDERS])];
  const lines = await Promise.all(
    providers.map(async (p) => {
      const money = await providerMoney(p);
      const mark = { live: "✅", estimate: "~", spend: "·" }[money.source];
      const left =
        money.usd == null
          ? "no budget set"
          : `$${money.usd.toFixed(2)} left${money.source === "estimate" ? " (est.)" : ""}`;
      const credits = money.credits != null ? ` · ${money.credits} credits` : "";
      return `${mark} ${p.padEnd(9)} ${left}${credits}\n     $${money.spent.toFixed(2)} spent here`;
    }),
  );

  await tg("sendMessage", {
    chat_id: chatId,
    text:
      `💰 Balances\n\n${lines.join("\n")}\n\n` +
      `✅ = live from the provider.\n` +
      `~ = your declared budget minus what this repo has spent; it can't see ` +
      `spend from anywhere else, so treat it as a floor.\n` +
      `· = no budget declared — set <PROVIDER>_BUDGET_USD in .env.genbot.`,
  });
}

async function sendAgentList(chatId) {
  const lines = AGENTS.map((a) => {
    const ready = config.mockMode || a.requires.every((k) => config[k]);
    return `${ready ? "✅" : "⬜"} ${a.emoji} ${a.label}\n     ${a.model()} · ${a.provider}${
      ready ? "" : ` · needs ${a.requires.join(", ")}`
    }`;
  });
  await tg("sendMessage", {
    chat_id: chatId,
    text: `🤖 Agents\n\n${lines.join("\n")}${config.mockMode ? "\n\n🧪 MOCK_MODE — nothing is really generated." : ""}`,
  });
}

async function handleMessage(msg) {
  // Single-chat authorization, identical to src/steps/review.js — anything
  // from anywhere else is ignored in silence.
  const chatId = String(msg.chat?.id ?? "");
  if (chatId !== String(config.telegramChatId)) return;

  const text = String(msg.text ?? "").trim();
  if (!text) return;

  const command = text.toLowerCase().split(/[\s@]/)[0];

  if (command === "/balance") return sendBalance(chatId);
  if (command === "/agents") return sendAgentList(chatId);
  if (command === "/help" || command === "/start") {
    return tg("sendMessage", { chat_id: chatId, text: HELP });
  }
  if (command === "/again") {
    const prev = lastRequest(chatId);
    if (!prev) return tg("sendMessage", { chat_id: chatId, text: "No previous prompt yet." });
    return sendPicker(chatId, prev.id, prev.prompt, prev.kind);
  }

  // /image and /video take an explicit kind. /image is redundant — a bare
  // message already generates one — but it exists so image generation shows up
  // in Telegram's command menu at all, which is otherwise a menu that never
  // mentions the bot's main job. /video is reserved for the v2 video agents;
  // until one is registered availableAgents("video") is empty and sendPicker
  // explains that rather than offering an empty keyboard.
  if (command === "/image" || command === "/video") {
    const kind = command === "/video" ? "video" : "image";
    // Strip the whole first token, not just `command` — Telegram renders the
    // command as "/image@thebot" when it can't tell which bot you meant, and
    // slicing by command.length would leave "@thebot" glued to the prompt.
    const prompt = text.replace(/^\S+\s*/, "").trim();
    if (!prompt) {
      return tg("sendMessage", { chat_id: chatId, text: `Usage: ${command} <prompt>` });
    }
    const id = createRequest({ chatId, prompt, kind });
    return sendPicker(chatId, id, prompt, kind);
  }

  // Anything else that isn't a command is the prompt itself — the fast path,
  // and the one the help text leads with.
  if (text.startsWith("/")) {
    return tg("sendMessage", { chat_id: chatId, text: `Unknown command.\n\n${HELP}` });
  }

  const requestId = createRequest({ chatId, prompt: text, kind: "image" });
  await sendPicker(chatId, requestId, text, "image");
}

async function handleCallback(cb) {
  const chatId = String(cb.message?.chat?.id ?? "");
  if (chatId !== String(config.telegramChatId)) return;

  // "<action>:<requestId>:<agentKey>" — the prompt can't ride along because
  // Telegram caps callback_data at 64 bytes, hence the request id (see db.js).
  const [action, idStr, agentKey] = String(cb.data ?? "").split(":");
  const requestId = Number(idStr);

  // Acknowledge immediately: Telegram spins the button for ~15s otherwise,
  // and generation takes far longer than that.
  await tg("answerCallbackQuery", { callback_query_id: cb.id });

  if (action === "x") {
    return tg("editMessageText", {
      chat_id: chatId,
      message_id: cb.message.message_id,
      text: "❌ Cancelled.",
    });
  }

  if (action === "o") {
    const filePath = assetPath(requestId, agentKey);
    if (!filePath) {
      return tg("sendMessage", { chat_id: chatId, text: "That file is no longer on disk." });
    }
    return sendOriginal({ chatId, filePath });
  }

  if (action === "r") {
    const request = getRequest(requestId);
    if (!request) return tg("sendMessage", { chat_id: chatId, text: "That prompt is gone." });
    // A fresh request row, so the re-run's asset doesn't overwrite the first.
    const newId = createRequest({ chatId, prompt: request.prompt, kind: request.kind });
    return sendPicker(chatId, newId, request.prompt, request.kind);
  }

  if (action === "g") {
    const agent = getAgent(agentKey);
    if (!agent) return tg("sendMessage", { chat_id: chatId, text: `Unknown agent: ${agentKey}` });
    if (!getRequest(requestId)) {
      return tg("sendMessage", { chat_id: chatId, text: "That prompt is gone — send it again." });
    }
    return runGeneration({ chatId, requestId, agent, messageId: cb.message.message_id });
  }
}

// ---------------------------------------------------------------------------
// Async job poller (the video seam)
// ---------------------------------------------------------------------------

const JOB_POLL_INTERVAL_MS = 10_000;

// A job that never reaches a terminal state would otherwise be polled forever.
const JOB_TIMEOUT_MS = 20 * 60_000;

// Progress percentages already reported, so the "⏳ 68%" edit only fires when
// the number actually moves — Telegram rejects an edit whose text is unchanged.
const lastProgress = new Map();

async function advanceJob(job) {
  const agent = getAgent(job.agent_key);
  if (!agent?.poll) return;

  if (Date.now() - Date.parse(job.updated_at + "Z") > JOB_TIMEOUT_MS) {
    updateJob(job.id, { status: "failed", error_msg: "timed out" });
    lastProgress.delete(job.id);
    await tg("sendMessage", {
      chat_id: job.chat_id,
      text: `⚠️ ${agent.label} job timed out after 20 minutes.`,
    });
    return;
  }

  const res = await agent.poll(job.external_job_id);

  if (res.status === "pending") {
    if (res.progress != null && lastProgress.get(job.id) !== res.progress) {
      lastProgress.set(job.id, res.progress);
      const request = getRequest(job.request_id);
      // Best-effort: a failed progress edit must not abandon a paid job.
      await tg("editMessageText", {
        chat_id: job.chat_id,
        message_id: job.status_message_id,
        text: `🎬 ${request?.prompt ?? ""}\n\n⏳ ${agent.label} rendering… ${res.progress}%`,
      }).catch(() => {});
    }
    return;
  }

  if (res.status === "failed") {
    updateJob(job.id, { status: "failed", error_msg: String(res.error).slice(0, 500) });
    lastProgress.delete(job.id);
    recordVideoCall({
      account: config.accountLabel,
      provider: agent.provider,
      model: agent.model(),
      operation: "genbot",
      status: "error",
      error: new Error(res.error),
    });
    await tg("sendMessage", { chat_id: job.chat_id, text: `⚠️ ${agent.label} failed: ${res.error}` });
    return;
  }

  // Done — fetch the rendered file and hand it to the chat.
  const request = getRequest(job.request_id);
  const filePath = await downloadTo(res.url, {
    requestId: job.request_id,
    agentKey: job.agent_key,
    mime: "video/mp4",
  });

  // xAI reports the exact charge, so prefer it over the registry's
  // per-second estimate; fall back only when a provider omits it.
  const cost = res.costUsd ?? (res.seconds ?? 0) * (agent.unitPriceUsd ?? 0);
  recordVideoCall({
    account: config.accountLabel,
    provider: agent.provider,
    model: res.model ?? agent.model(),
    operation: "genbot",
    seconds: res.seconds ?? 0,
    costUsd: res.costUsd,
    unitPriceUsd: agent.unitPriceUsd,
    status: "ok",
  });

  updateJob(job.id, { status: "done" });
  lastProgress.delete(job.id);

  const money = await providerMoney(agent.provider);
  await sendVideo({
    chatId: job.chat_id,
    filePath,
    caption:
      `${agent.emoji} ${agent.label} · $${cost.toFixed(2)} · ${res.seconds ?? "?"}s\n` +
      `${formatMoneyShort(money)} left${money.source === "estimate" ? " (est.)" : ""}`,
  });
  await tg("editMessageText", {
    chat_id: job.chat_id,
    message_id: job.status_message_id,
    text: `🎬 ${request?.prompt ?? ""}\n\n✅ ${agent.emoji} ${agent.label}`,
  }).catch(() => {});
}

// Drives every in-flight video job. Reads from the DB rather than memory so a
// job that was rendering when the process died is picked back up on restart —
// the property video needs most, since you've already been charged by then.
function startJobPoller() {
  setInterval(async () => {
    let jobs;
    try {
      jobs = pendingJobs();
    } catch (err) {
      console.error("[genbot] job poll failed:", err.message);
      return;
    }
    for (const job of jobs) {
      try {
        await advanceJob(job);
      } catch (err) {
        console.error(`[genbot] job ${job.id} poll failed:`, err.message);
      }
    }
  }, JOB_POLL_INTERVAL_MS).unref();
}

/**
 * Long-poll Telegram for prompts and agent selections. Run as a service
 * (`npm run gen-bot`) with its own .env.genbot — its own bot token, chat id,
 * and DB, so it shares nothing with the pipeline or the fb responder except
 * the metrics DB.
 */
export async function startGenBot() {
  requireConfig(["telegramBotToken", "telegramChatId"]);
  const images = availableAgents("image").map((a) => a.key);
  const videos = availableAgents("video").map((a) => a.key);
  console.log(
    `[genbot] starting — image: ${images.join(", ") || "none"} | ` +
      `video: ${videos.join(", ") || "none"}${config.mockMode ? " (MOCK_MODE)" : ""}`,
  );

  startJobPoller();

  let offset = 0;
  for (;;) {
    let updates;
    try {
      updates = await tg("getUpdates", {
        offset,
        timeout: 50,
        allowed_updates: ["message", "callback_query"],
      });
    } catch (err) {
      // A transient Telegram/network error must not kill the service; back off
      // briefly and resume from the same offset.
      console.error("[genbot] getUpdates failed:", err.message);
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }

    for (const update of updates) {
      offset = update.update_id + 1;
      try {
        if (update.callback_query) await handleCallback(update.callback_query);
        else if (update.message) await handleMessage(update.message);
      } catch (err) {
        console.error("[genbot] update handling failed:", err);
      }
    }
  }
}
