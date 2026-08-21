import { config } from "../config.js";
import { generateGrokImage } from "../lib/grokImage.js";
import { generateFalImage } from "../lib/imagegen/falImage.js";
import { generateGeminiImage } from "../lib/imagegen/geminiImage.js";
import { generateOpenAiImage } from "../lib/imagegen/openaiImage.js";
import { pollGrokVideo, submitGrokVideo } from "../lib/videogen/grokVideo.js";
import { mockImage } from "./mock.js";

// ---------------------------------------------------------------------------
// THE AGENT CATALOG. This is the one file you edit to add a generation agent:
// append an entry, set its key in .env.genbot, restart. `requires` gates the
// button, so an agent you have no key for simply doesn't appear on the
// keyboard — no code change needed to turn one on or off.
//
// The rest of this repo has no provider abstraction (each provider is a
// bespoke file, routing is hardcoded try/catch in generateFact.js and
// fbresponder/generateReply.js). That's deliberate there and unchanged; a
// registry earns its place *here* because picking a provider from a list is
// the whole feature.
//
// Contract for generate():
//   sync  → { assets: [{ b64, mime }] }   image agents; delivered immediately
//   async → { externalJobId }             video agents; a gen_jobs row is
//                                         created and poll() drives it to
//                                         completion (see main.js's poller)
//
// An async agent must also export poll(externalJobId), returning
//   { status: "pending", progress }
//   { status: "done", url, seconds, costUsd?, model? }
//   { status: "failed", error }
//
// unitPriceUsd is passed straight through to recordImageCall so the dashboard
// costs every agent. Verify each against its provider's pricing page when you
// change a model id — a stale rate silently skews the balance figures.
// ---------------------------------------------------------------------------

export const AGENTS = [
  {
    key: "grok",
    label: "Grok · Image",
    emoji: "🤖",
    kind: "image",
    provider: "xai",
    requires: ["xaiApiKey"],
    model: () => config.grokImageModel,
    unitPriceUsd: 0.02,
    generate: async ({ prompt, model, account, operation, unitPriceUsd }) => {
      // grokImage.js predates this registry and returns a bare b64 string —
      // normalize rather than changing a function the pipeline depends on.
      const b64 = await generateGrokImage({ prompt, model, account, operation });
      return { assets: [{ b64, mime: "image/jpeg" }] };
    },
  },
  {
    key: "flux",
    label: "FLUX 1.1 Ultra · fal",
    emoji: "⚡",
    kind: "image",
    provider: "fal",
    requires: ["falApiKey"],
    model: () => "fal-ai/flux-pro/v1.1-ultra",
    unitPriceUsd: 0.06,
    generate: async (opts) => ({ assets: [await generateFalImage(opts)] }),
  },
  {
    key: "ideogram",
    label: "Ideogram v3 · fal",
    emoji: "🔤",
    kind: "image",
    provider: "fal",
    requires: ["falApiKey"],
    model: () => "fal-ai/ideogram/v3",
    unitPriceUsd: 0.06,
    // Ideogram's draw is legible text inside the image — worth a separate
    // button from FLUX even though both bill to the same fal balance.
    generate: async (opts) => ({ assets: [await generateFalImage(opts)] }),
  },
  {
    key: "gptimage",
    label: "OpenAI · gpt-image-1",
    emoji: "🧠",
    kind: "image",
    provider: "openai",
    requires: ["openaiApiKey"],
    model: () => config.openaiImageModel,
    unitPriceUsd: 0.17,
    generate: async (opts) => ({ assets: [await generateOpenAiImage(opts)] }),
  },
  {
    key: "nanobanana",
    label: "Gemini · Nano Banana",
    emoji: "🍌",
    kind: "image",
    provider: "gemini",
    requires: ["geminiApiKey"],
    model: () => config.geminiImageModel,
    unitPriceUsd: 0.039,
    generate: async (opts) => ({ assets: [await generateGeminiImage(opts)] }),
  },

  // --- video ---------------------------------------------------------------
  // Asynchronous: generate() only submits, and poll() is driven by the
  // gen_jobs poller in main.js. Cost comes back exact from xAI's usage
  // report, so unitPriceUsd here is only a fallback for a response that
  // omits it.
  {
    key: "grokvid",
    label: "Grok · Video",
    emoji: "🎬",
    kind: "video",
    provider: "xai",
    requires: ["xaiApiKey"],
    model: () => config.grokVideoModel,
    // $/second. Measured against the live API 2026-08-20: a 6s clip billed
    // $0.48. Only a fallback and a pre-generation estimate — the actual charge
    // comes back exact in usage.cost_in_usd_ticks.
    unitPriceUsd: 0.08,
    generate: ({ prompt, model }) => submitGrokVideo({ prompt, model }),
    poll: (externalJobId) => pollGrokVideo(externalJobId),
  },
];

/** Agent by callback key, or undefined. */
export function getAgent(key) {
  return AGENTS.find((a) => a.key === key);
}

/**
 * Agents that are actually usable right now: every env key in `requires` is
 * set, and the kind matches. In MOCK_MODE the `requires` gate is lifted so the
 * whole picker can be exercised offline with no keys at all.
 */
export function availableAgents(kind = "image") {
  return AGENTS.filter(
    (a) => a.kind === kind && (config.mockMode || a.requires.every((k) => config[k])),
  );
}

/**
 * Run one agent. Centralizes the MOCK_MODE short-circuit so no individual
 * agent has to remember it, and resolves the model id (a thunk in the catalog,
 * so an env change is picked up without a code edit).
 */
export async function runAgent(agent, prompt) {
  const model = agent.model();
  if (config.mockMode) {
    // No mock video: faking an mp4 would need an encoder this repo doesn't
    // carry, and a still image pretending to be a video would be worse than
    // an honest refusal.
    if (agent.kind === "video") {
      throw new Error("MOCK_MODE doesn't simulate video — set MOCK_MODE=false to generate one.");
    }
    return { assets: [await mockImage({ prompt, label: agent.label })], model, mocked: true };
  }
  const result = await agent.generate({
    prompt,
    model,
    account: config.accountLabel,
    operation: "genbot",
    unitPriceUsd: agent.unitPriceUsd,
  });
  return { ...result, model };
}
