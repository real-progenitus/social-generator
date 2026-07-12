#!/usr/bin/env node
const [command, arg] = process.argv.slice(2);

const USAGE = `Usage: node src/cli.js <command>

  run              Run the daily pipeline once (fact -> check -> cover -> render -> review/publish)
  run-batch [n]    Run the pipeline n times back to back (default 3), one failure doesn't stop the rest
  poll             Long-poll Telegram for approve/reject decisions (run as a service)
  publish <id>     Publish an approved/rendered post by ID (bypass for manual ops)
  analytics        Pull IG insights for recent posts and update topic weights
  serve            Serve the output/ dir over HTTP for the Instagram Graph API
  status           Show recent posts and their pipeline states
  fb-bot           Run the Facebook comment/message webhook + approval bot (run as a service)
`;

// Every case imports its own dependencies lazily (dynamic import), scoped to
// that case, rather than as static top-of-file imports. db.js and
// fbresponder/db.js each open config.dbPath and run CREATE TABLE statements
// as a side effect of being imported, so a static import of both would have
// every command's process create the other domain's tables too (posts/
// used_facts/etc in the fb-bot's DB, fb_events in the pipeline's DB). Mirrors
// the same reasoning behind pipeline.js's dynamic per-account step loading.
try {
  switch (command) {
    case "run": {
      const { runPipeline } = await import("./pipeline.js");
      const id = await runPipeline();
      console.log(`Done. Post ID: ${id}`);
      break;
    }
    case "run-batch": {
      const { runBatch } = await import("./pipeline.js");
      const count = arg ? Number(arg) : 3;
      await runBatch(count);
      break;
    }
    case "poll": {
      const { pollApprovals } = await import("./steps/review.js");
      await pollApprovals();
      break;
    }
    case "publish": {
      if (!arg) throw new Error("Usage: node src/cli.js publish <postId>");
      const { publishPost } = await import("./steps/publish.js");
      await publishPost(Number(arg));
      break;
    }
    case "analytics": {
      const { runAnalytics } = await import("./steps/analytics.js");
      await runAnalytics();
      break;
    }
    case "serve": {
      const { serveMedia } = await import("./serve.js");
      serveMedia();
      break;
    }
    case "status": {
      const { db } = await import("./db.js");
      const rows = db
        .prepare(
          `SELECT id, status, created_at,
                  json_extract(fact_json, '$.headline') AS headline
           FROM posts ORDER BY id DESC LIMIT 15`,
        )
        .all();
      if (rows.length === 0) {
        console.log("No posts yet — run `npm run pipeline`.");
      } else {
        for (const r of rows) {
          console.log(`#${r.id}  [${r.status}]  ${r.created_at}  ${r.headline}`);
        }
      }
      break;
    }
    case "fb-bot": {
      const { startFbResponder } = await import("./fbresponder/main.js");
      await startFbResponder();
      break;
    }
    default:
      console.log(USAGE);
      process.exitCode = command ? 1 : 0;
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exitCode = 1;
}
