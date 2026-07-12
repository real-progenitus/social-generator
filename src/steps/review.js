import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { getPost, updatePost } from "../db.js";
import { runPipeline } from "../pipeline.js";
import { publishPost } from "./publish.js";

const API = (method) =>
  `https://api.telegram.org/bot${config.telegramBotToken}/${method}`;

async function tg(method, payload) {
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

/**
 * Send the rendered carousel + fact text to the review chat with
 * Approve / Reject buttons. The pipeline then exits; `npm run poll`
 * processes the decision.
 */
export async function sendForReview(postId, fact, slidePaths) {
  // Album preview of all slides
  const form = new FormData();
  const media = slidePaths.map((p, i) => {
    const name = `slide${i}`;
    form.append(name, new Blob([fs.readFileSync(p)], { type: "image/png" }), path.basename(p));
    return { type: "photo", media: `attach://${name}` };
  });
  form.append("chat_id", config.telegramChatId);
  form.append("media", JSON.stringify(media));
  await tg("sendMediaGroup", form);

  await tg("sendMessage", {
    chat_id: config.telegramChatId,
    text:
      `📋 Post #${postId} awaiting review\n\n` +
      `${fact.headline}\n\n` +
      `Type: ${fact.fact_type}${fact.artist_name ? ` (${fact.artist_name})` : ""}\n` +
      `Source: ${fact.source_note}\n\n` +
      `Caption:\n${fact.caption}`,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Approve & publish", callback_data: `approve:${postId}` },
          { text: "❌ Reject", callback_data: `reject:${postId}` },
        ],
      ],
    },
  });
  console.log(`[review] post #${postId} sent to Telegram for approval`);
}

async function handleCallback(cb) {
  const [action, idStr] = String(cb.data ?? "").split(":");
  const postId = Number(idStr);
  const post = getPost(postId);

  const reply = async (text) => {
    await tg("answerCallbackQuery", { callback_query_id: cb.id });
    await tg("sendMessage", { chat_id: config.telegramChatId, text });
  };

  if (!post) return reply(`Post #${postId} not found.`);
  if (post.status !== "pending_review")
    return reply(`Post #${postId} is '${post.status}', not pending review — ignoring.`);

  if (action === "approve") {
    updatePost(postId, { status: "approved" });
    await reply(`✅ Post #${postId} approved — publishing…`);
    try {
      const mediaId = await publishPost(postId);
      await tg("sendMessage", {
        chat_id: config.telegramChatId,
        text: `🚀 Post #${postId} published (IG media ${mediaId}).`,
      });
    } catch (err) {
      updatePost(postId, { status: "failed", review_feedback: String(err) });
      await tg("sendMessage", {
        chat_id: config.telegramChatId,
        text: `⚠️ Publish failed for post #${postId}: ${err.message}`,
      });
    }
  } else if (action === "reject") {
    updatePost(postId, {
      status: "rejected",
      review_feedback: "Rejected via Telegram review",
    });
    await reply(`❌ Post #${postId} rejected. It will not be published; tomorrow's run generates a fresh fact.`);
  }
}

// Prevents two /generate presses from kicking off overlapping pipeline runs
// (each run burns Claude + xAI API credits and hits the fact-dedup table).
let generateInProgress = false;

async function handleMessage(msg) {
  if (String(msg.chat?.id ?? "") !== String(config.telegramChatId)) return;

  const command = String(msg.text ?? "")
    .trim()
    .toLowerCase()
    .split(/[\s@]/)[0];
  if (command !== "/generate" && command !== "/post") return;

  if (generateInProgress) {
    await tg("sendMessage", {
      chat_id: config.telegramChatId,
      text: "⏳ Already generating a post — hang tight.",
    });
    return;
  }

  generateInProgress = true;
  await tg("sendMessage", {
    chat_id: config.telegramChatId,
    text: "⏳ Generating a new post…",
  });
  try {
    const postId = await runPipeline();
    // When REVIEW_REQUIRED=false, runPipeline publishes directly with no
    // Telegram message of its own, so confirm here. Otherwise sendForReview
    // already posted the carousel + approve/reject buttons.
    if (!config.reviewRequired) {
      await tg("sendMessage", {
        chat_id: config.telegramChatId,
        text: `✅ Post #${postId} generated and published.`,
      });
    }
  } catch (err) {
    await tg("sendMessage", {
      chat_id: config.telegramChatId,
      text: `⚠️ Generation failed: ${err.message}`,
    });
  } finally {
    generateInProgress = false;
  }
}

/**
 * Long-poll Telegram for approve/reject button presses and /generate (or
 * /post) commands. Run as a service (`npm run poll`) alongside the daily
 * pipeline cron.
 */
export async function pollApprovals() {
  console.log("[review] polling Telegram for approvals (Ctrl-C to stop)…");
  let offset = 0;
  for (;;) {
    const updates = await tg("getUpdates", {
      offset,
      timeout: 50,
      allowed_updates: ["callback_query", "message"],
    });
    for (const update of updates) {
      offset = update.update_id + 1;
      if (update.callback_query) {
        try {
          await handleCallback(update.callback_query);
        } catch (err) {
          console.error("[review] callback handling failed:", err);
        }
      } else if (update.message) {
        try {
          await handleMessage(update.message);
        } catch (err) {
          console.error("[review] message handling failed:", err);
        }
      }
    }
  }
}
