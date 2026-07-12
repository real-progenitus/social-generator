import path from "node:path";
import { config, requireConfig } from "./config.js";
import { createPost, recordUsedFact, updatePost } from "./db.js";
import { publishPost } from "./steps/publish.js";
import { sendForReview } from "./steps/review.js";

// Each account's generate/cover/render implementations live in their own
// sibling files (see src/steps/generateFoodContent.js etc.) and are loaded
// dynamically, never statically imported side by side — renderSlides.js and
// renderFoodSlides.js each read a module-top-level logo asset, so a static
// import of both would make a missing food-logo.png crash the music pipeline
// even though it never calls into that file.
async function loadAccountSteps() {
  if (config.account === "food") {
    const [{ generateFoodContent }, { generateFoodCover }, { renderFoodSlides }] = await Promise.all([
      import("./steps/generateFoodContent.js"),
      import("./steps/generateFoodCover.js"),
      import("./steps/renderFoodSlides.js"),
    ]);
    return { generateContent: generateFoodContent, generateCoverImage: generateFoodCover, renderSlideImages: renderFoodSlides };
  }
  const [{ generateFact }, { generateCover }, { renderSlides }] = await Promise.all([
    import("./steps/generateFact.js"),
    import("./steps/generateCover.js"),
    import("./steps/renderSlides.js"),
  ]);
  return { generateContent: generateFact, generateCoverImage: generateCover, renderSlideImages: renderSlides };
}

/**
 * Daily pipeline:
 * generate_fact (web-search grounded) -> generate_cover_image -> render_slides
 * -> queue_for_review (or publish directly when REVIEW_REQUIRED=false)
 *
 * There is no separate fact-check call: generateFact grounds every claim in a
 * live web search, and the Telegram approval step is the final human gate.
 */
export async function runPipeline() {
  console.log(`[pipeline] account=${config.account} handle=${config.postHandle}`);
  if (!config.mockMode) {
    const required = ["anthropicApiKey"];
    if (!config.localCoverImage) required.push("xaiApiKey");
    requireConfig(required);
  }

  const { generateContent, generateCoverImage, renderSlideImages } = await loadAccountSteps();

  const fact = await generateContent();
  console.log(`[pipeline] generated: "${fact.headline}"`);

  const postId = createPost(fact);
  updatePost(postId, {
    status: "fact_checked",
    fact_check_json: JSON.stringify({ method: "web_search_grounded" }),
    caption: fact.caption,
  });
  recordUsedFact(fact);

  const outDir = path.join(config.outputDir, `post-${postId}`);
  const cover = await generateCoverImage(fact, outDir);
  const slidePaths = await renderSlideImages(fact, cover, outDir);
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
