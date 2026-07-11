import path from "node:path";
import { config, requireConfig } from "./config.js";
import { createPost, recordUsedFact, updatePost } from "./db.js";
import { factCheck } from "./steps/factCheck.js";
import { generateCover } from "./steps/generateCover.js";
import { generateFact } from "./steps/generateFact.js";
import { publishPost } from "./steps/publish.js";
import { renderSlides } from "./steps/renderSlides.js";
import { sendForReview } from "./steps/review.js";

// One generation + one check, no regeneration loop — factCheck calls are the
// expensive part, so generateFact's prompt is responsible for only proposing
// easy-to-verify facts in the first place.
async function generateVerifiedFact() {
  const fact = await generateFact();
  console.log(`[pipeline] generated: "${fact.headline}"`);
  const check = await factCheck(fact);
  if (check.verdict === "pass" && check.confidence !== "low") {
    return { fact, check };
  }
  throw new Error(
    `Fact failed verification (${check.verdict}, confidence ${check.confidence}): ${check.issues.join("; ")}`,
  );
}

/**
 * Daily pipeline:
 * generate_fact -> fact-check -> generate_cover_image -> render_slides
 * -> queue_for_review (or publish directly when REVIEW_REQUIRED=false)
 */
export async function runPipeline() {
  if (!config.mockMode) {
    const required = ["anthropicApiKey"];
    if (!config.localCoverImage) required.push("xaiApiKey");
    requireConfig(required);
  }

  const { fact, check } = await generateVerifiedFact();

  const postId = createPost(fact);
  updatePost(postId, {
    status: "fact_checked",
    fact_check_json: JSON.stringify(check),
    caption: fact.caption,
  });
  recordUsedFact(fact);

  const outDir = path.join(config.outputDir, `post-${postId}`);
  const cover = await generateCover(fact, outDir);
  const slidePaths = await renderSlides(fact, cover, outDir);
  // Commons photos require attribution (CC BY / CC BY-SA) — fold it into the
  // caption so it ships with the post rather than only living in logs. The
  // cover and the optional extra photo slide may each carry a credit; dedupe
  // in case they came from the same author.
  const credits = [...new Set([cover.attribution, cover.extraPhoto?.attribution].filter(Boolean))];
  const caption = credits.length > 0 ? `${fact.caption}\n\n${credits.join("\n")}` : fact.caption;
  updatePost(postId, {
    status: "rendered",
    cover_path: cover.path,
    slide_paths_json: JSON.stringify(slidePaths),
    caption,
  });
  console.log(`[pipeline] post #${postId} rendered: ${slidePaths.length} slides in ${outDir}`);

  if (config.reviewRequired) {
    requireConfig(["telegramBotToken", "telegramChatId"]);
    updatePost(postId, { status: "pending_review" });
    await sendForReview(postId, { ...fact, caption }, slidePaths);
    console.log(
      `[pipeline] post #${postId} awaiting approval — run \`npm run poll\` to process the decision`,
    );
  } else if (config.mockMode) {
    console.log(`[pipeline] MOCK_MODE — skipping publish for post #${postId}`);
  } else {
    await publishPost(postId);
  }

  return postId;
}

/**
 * Run the pipeline `count` times back to back (sequentially, not in
 * parallel — each run's fact must be recorded before the next one's dedup
 * check runs). One failed run (e.g. a fact that doesn't pass verification)
 * doesn't abort the rest of the batch.
 */
export async function runBatch(count) {
  const results = [];
  for (let i = 1; i <= count; i++) {
    console.log(`[pipeline] batch run ${i}/${count}`);
    try {
      const id = await runPipeline();
      results.push({ ok: true, id });
    } catch (err) {
      console.error(`[pipeline] batch run ${i}/${count} failed: ${err.message}`);
      results.push({ ok: false, error: err.message });
    }
  }
  const succeeded = results.filter((r) => r.ok).length;
  console.log(`[pipeline] batch complete: ${succeeded}/${count} succeeded`);
  return results;
}
