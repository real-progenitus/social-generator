import { config, requireConfig } from "../config.js";
import { bumpTopicWeight, db, recordInsights } from "../db.js";

const GRAPH = "https://graph.facebook.com/v21.0";

async function fetchInsights(mediaId) {
  const url = new URL(`${GRAPH}/${mediaId}/insights`);
  url.searchParams.set("metric", "reach,likes,comments,saved,shares");
  url.searchParams.set("access_token", config.metaAccessToken);
  const res = await fetch(url);
  const json = await res.json();
  if (json.error) throw new Error(`Graph API error: ${JSON.stringify(json.error)}`);
  const metrics = {};
  for (const m of json.data ?? []) {
    metrics[m.name] = m.values?.[0]?.value ?? null;
  }
  return metrics;
}

function engagementScore(m) {
  // Saves and shares signal "worth keeping" far more than likes
  return (m.saved ?? 0) * 3 + (m.shares ?? 0) * 3 + (m.comments ?? 0) * 2 + (m.likes ?? 0);
}

/**
 * Weekly feedback loop: pull insights for recently published posts and nudge
 * topic weights so future fact generation favors what performs.
 */
export async function runAnalytics() {
  requireConfig(["metaAccessToken"]);

  const posts = db
    .prepare(
      `SELECT id, ig_media_id, fact_json FROM posts
       WHERE status = 'published' AND ig_media_id IS NOT NULL
         AND created_at > datetime('now', '-14 days')`,
    )
    .all();

  if (posts.length === 0) {
    console.log("[analytics] no published posts in the last 14 days");
    return;
  }

  const scored = [];
  for (const post of posts) {
    try {
      const metrics = await fetchInsights(post.ig_media_id);
      recordInsights(post.id, metrics);
      const topic = JSON.parse(post.fact_json).topic;
      scored.push({ id: post.id, topic, score: engagementScore(metrics) });
      console.log(`[analytics] post #${post.id} (${topic}): ${JSON.stringify(metrics)}`);
    } catch (err) {
      console.error(`[analytics] failed for post #${post.id}:`, err.message);
    }
  }

  if (scored.length < 2) return;
  const avg = scored.reduce((s, p) => s + p.score, 0) / scored.length;
  for (const p of scored) {
    if (!p.topic) continue;
    const delta = p.score > avg * 1.25 ? 0.15 : p.score < avg * 0.75 ? -0.15 : 0;
    if (delta !== 0) {
      bumpTopicWeight(p.topic, delta);
      console.log(`[analytics] topic weight ${delta > 0 ? "+" : ""}${delta} for "${p.topic}"`);
    }
  }
}
