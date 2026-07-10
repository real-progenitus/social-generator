import path from "node:path";
import { config, requireConfig } from "./config.js";
import { createPost, recordUsedFact, updatePost } from "./db.js";
import { factCheck } from "./steps/factCheck.js";
import { generateCover } from "./steps/generateCover.js";
import { generateFact } from "./steps/generateFact.js";
import { publishPost } from "./steps/publish.js";
import { renderSlides } from "./steps/renderSlides.js";
import { sendForReview } from "./steps/review.js";

const MAX_FACT_ATTEMPTS = 3;

async function generateVerifiedFact() {
  let lastIssues = [];
  for (let attempt = 1; attempt <= MAX_FACT_ATTEMPTS; attempt++) {
    const fact = await generateFact();
    console.log(`[pipeline] attempt ${attempt}: "${fact.headline}"`);
    const check = await factCheck(fact);
    if (check.verdict === "pass" && check.confidence !== "low") {
      return { fact, check };
    }
    lastIssues = check.issues;
    console.warn(
      `[pipeline] fact check ${check.verdict} (${check.confidence}): ${check.issues.join("; ")} — regenerating`,
    );
  }
  throw new Error(
    `No fact passed verification after ${MAX_FACT_ATTEMPTS} attempts. Last issues: ${lastIssues.join("; ")}`,
  );
}

/**
 * Daily pipeline:
 * generate_fact -> fact-check -> generate_cover_image -> render_slides
 * -> queue_for_review (or publish directly when REVIEW_REQUIRED=false)
 */
export async function runPipeline() {
  if (!config.mockMode) requireConfig(["anthropicApiKey", "xaiApiKey"]);

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
  updatePost(postId, {
    status: "rendered",
    cover_path: cover.path,
    slide_paths_json: JSON.stringify(slidePaths),
  });
  console.log(`[pipeline] post #${postId} rendered: ${slidePaths.length} slides in ${outDir}`);

  if (config.reviewRequired) {
    requireConfig(["telegramBotToken", "telegramChatId"]);
    updatePost(postId, { status: "pending_review" });
    await sendForReview(postId, fact, slidePaths);
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
