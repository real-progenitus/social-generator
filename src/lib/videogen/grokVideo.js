import { config } from "../../config.js";

// xAI video generation. Unlike the image endpoint (one request, one picture),
// this is a two-step job: POST returns a request_id immediately, and you GET
// the job until it reports done. Verified against the live API 2026-08-20:
//
//   POST /v1/videos/generations  {model, prompt, duration}
//     -> {"request_id": "..."}
//   GET  /v1/videos/{request_id}
//     -> 202 {"status":"pending","progress":68}
//     -> 200 {"status":"done","progress":100,"model":"...",
//             "video":{"url":"https://vidgen.x.ai/...mp4","duration":8},
//             "usage":{"cost_in_usd_ticks":4000000000}}
//
// Note the terminal status is "done", not "completed".
const XAI_VIDEO_URL = "https://api.x.ai/v1/videos/generations";
const XAI_VIDEO_JOB_URL = "https://api.x.ai/v1/videos";

// xAI reports cost in "ticks" of 1e-10 USD — 4000000000 ticks = $0.40, and the
// image endpoint's image_price of 200000000 = $0.02 confirms the same unit.
// Using the reported figure means video cost is EXACT rather than an estimate
// from a hardcoded per-second rate, which is the usual best we can do.
const USD_PER_TICK = 1e-10;

// xAI rejects anything outside this range with a 400.
const MIN_SECONDS = 1;
const MAX_SECONDS = 15;

/**
 * Kick off a video generation. Returns immediately — the job is polled
 * separately via pollGrokVideo.
 * @returns {Promise<{externalJobId: string}>}
 */
export async function submitGrokVideo({ prompt, model, seconds }) {
  const duration = Math.min(
    MAX_SECONDS,
    Math.max(MIN_SECONDS, Math.round(seconds ?? config.grokVideoSeconds)),
  );
  const res = await fetch(XAI_VIDEO_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.xaiApiKey}`,
    },
    body: JSON.stringify({ model: model ?? config.grokVideoModel, prompt, duration }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`xAI video API error ${res.status}: ${body.slice(0, 500)}`);
  }

  const json = await res.json();
  if (!json.request_id) throw new Error("xAI video API returned no request_id");
  return { externalJobId: json.request_id };
}

/**
 * Check one submitted job.
 * @returns {Promise<{status: "pending"|"done"|"failed", progress?: number,
 *                    url?: string, seconds?: number, costUsd?: number,
 *                    model?: string, error?: string}>}
 */
export async function pollGrokVideo(externalJobId) {
  const res = await fetch(`${XAI_VIDEO_JOB_URL}/${externalJobId}`, {
    headers: { Authorization: `Bearer ${config.xaiApiKey}` },
  });

  if (!res.ok && res.status !== 202) {
    const body = await res.text();
    return { status: "failed", error: `xAI video poll ${res.status}: ${body.slice(0, 300)}` };
  }

  const json = await res.json();

  if (json.status === "done") {
    const url = json.video?.url;
    if (!url) return { status: "failed", error: "job finished with no video URL" };
    return {
      status: "done",
      url,
      seconds: json.video?.duration ?? null,
      // Exact, straight from the provider — no per-second estimate needed.
      costUsd:
        json.usage?.cost_in_usd_ticks == null
          ? undefined
          : json.usage.cost_in_usd_ticks * USD_PER_TICK,
      model: json.model,
      progress: 100,
    };
  }

  // Anything explicitly failure-shaped ends the job; everything else (pending,
  // queued, running, or a status xAI adds later) is treated as still working,
  // so an unrecognized state stalls rather than throwing away a paid job.
  if (["failed", "error", "cancelled"].includes(json.status)) {
    return { status: "failed", error: json.error ?? `job ${json.status}` };
  }

  return { status: "pending", progress: json.progress ?? 0 };
}
