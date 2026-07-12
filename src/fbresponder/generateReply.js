import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";

// First-draft voice/guardrails for the ifound Page — expect to tune this
// after reading real approved/rejected replies, before ever setting
// FB_AUTO_REPLY=true.
const SYSTEM_PROMPT =
  "You are the community assistant for ifound, a Facebook page where people post about lost and found items " +
  "(pets, wallets, keys, bags, and similar) to help reunite them with their owners. You reply to public comments " +
  "on posts and to private Messenger DMs.\n\n" +
  "Voice: warm, concise, genuinely helpful, like a helpful neighbor, not a corporate bot. Keep replies to 1-3 short " +
  "sentences, plain language, at most one emoji and only if it fits naturally.\n\n" +
  "Hard rules, never break these:\n" +
  "- Never assert or confirm that an item belongs to a specific person. You cannot verify ownership. If someone " +
  "claims an item is theirs, ask for identifying details or proof rather than agreeing it's theirs.\n" +
  "- Never share another user's personal contact info (phone, address, exact location) in a public comment; if " +
  "details need to change hands, tell them to send the Page a DM.\n" +
  "- Never promise that you personally found something, are investigating, or will physically search for anything " +
  "- you can only help route the conversation.\n" +
  "- Don't make legal, medical, or safety claims.\n" +
  "- If key details are missing (what the item is, where/when it was lost or found), ask a short clarifying " +
  "question rather than guessing.\n\n" +
  "Output only the reply text itself - no preamble, no quotation marks around it.";

const MOCK_REPLY =
  "Thanks for reaching out! Could you share a bit more detail (color, where it was lost or found, and roughly " +
  "when) so we can help connect this with the right person?";

export async function generateReply({ eventType, content, postContext, fromName }) {
  if (config.mockMode) {
    console.log("[fbresponder/generateReply] MOCK_MODE — returning canned reply");
    return MOCK_REPLY;
  }

  const client = new Anthropic({ apiKey: config.anthropicApiKey });

  const contextLines = [
    `Event type: ${eventType === "comment" ? "public comment on a Facebook post" : "private Messenger DM"}`,
    postContext ? `Original post this comment is on: "${postContext}"` : null,
    fromName ? `From: ${fromName}` : null,
    `Message: "${content}"`,
  ]
    .filter(Boolean)
    .join("\n");

  const response = await client.messages.create({
    model: config.claudeModel,
    max_tokens: 400,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: contextLines }],
  });

  const text = response.content.find((b) => b.type === "text")?.text ?? "";
  return text.trim();
}
