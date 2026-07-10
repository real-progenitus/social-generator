#!/usr/bin/env node
import { db } from "./db.js";
import { runPipeline } from "./pipeline.js";
import { serveMedia } from "./serve.js";
import { runAnalytics } from "./steps/analytics.js";
import { publishPost } from "./steps/publish.js";
import { pollApprovals } from "./steps/review.js";

const [command, arg] = process.argv.slice(2);

const USAGE = `Usage: node src/cli.js <command>

  run              Run the daily pipeline (fact -> check -> cover -> render -> review/publish)
  poll             Long-poll Telegram for approve/reject decisions (run as a service)
  publish <id>     Publish an approved/rendered post by ID (bypass for manual ops)
  analytics        Pull IG insights for recent posts and update topic weights
  serve            Serve the output/ dir over HTTP for the Instagram Graph API
  status           Show recent posts and their pipeline states
`;

try {
  switch (command) {
    case "run": {
      const id = await runPipeline();
      console.log(`Done. Post ID: ${id}`);
      break;
    }
    case "poll":
      await pollApprovals();
      break;
    case "publish": {
      if (!arg) throw new Error("Usage: node src/cli.js publish <postId>");
      await publishPost(Number(arg));
      break;
    }
    case "analytics":
      await runAnalytics();
      break;
    case "serve":
      serveMedia();
      break;
    case "status": {
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
    default:
      console.log(USAGE);
      process.exitCode = command ? 1 : 0;
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exitCode = 1;
}
