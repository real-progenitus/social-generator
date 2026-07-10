import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    status TEXT NOT NULL DEFAULT 'draft',
    -- draft -> fact_checked -> rendered -> pending_review -> approved -> published
    -- terminal failure states: rejected, failed
    fact_json TEXT NOT NULL,
    fact_check_json TEXT,
    cover_path TEXT,
    slide_paths_json TEXT,
    caption TEXT,
    ig_media_id TEXT,
    review_feedback TEXT
  );

  CREATE TABLE IF NOT EXISTS used_facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    headline TEXT NOT NULL,
    topic TEXT,
    artist_name TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS topic_weights (
    topic TEXT PRIMARY KEY,
    weight REAL NOT NULL DEFAULT 1.0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS insights (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL REFERENCES posts(id),
    reach INTEGER,
    likes INTEGER,
    comments INTEGER,
    saved INTEGER,
    shares INTEGER,
    fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS used_commons_photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    description_url TEXT NOT NULL UNIQUE,
    subject TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

export function createPost(fact) {
  const info = db
    .prepare("INSERT INTO posts (fact_json) VALUES (?)")
    .run(JSON.stringify(fact));
  return info.lastInsertRowid;
}

export function updatePost(id, fields) {
  const cols = Object.keys(fields);
  if (cols.length === 0) return;
  const sets = cols.map((c) => `${c} = @${c}`).join(", ");
  db.prepare(
    `UPDATE posts SET ${sets}, updated_at = datetime('now') WHERE id = @id`,
  ).run({ id, ...fields });
}

export function getPost(id) {
  return db.prepare("SELECT * FROM posts WHERE id = ?").get(id);
}

export function getPostsByStatus(status) {
  return db
    .prepare("SELECT * FROM posts WHERE status = ? ORDER BY id")
    .all(status);
}

export function recordUsedFact(fact) {
  db.prepare(
    "INSERT INTO used_facts (headline, topic, artist_name) VALUES (?, ?, ?)",
  ).run(fact.headline, fact.topic ?? null, fact.artist_name ?? null);
}

export function recentUsedFacts(limit = 60) {
  return db
    .prepare(
      "SELECT headline, topic, artist_name FROM used_facts ORDER BY id DESC LIMIT ?",
    )
    .all(limit);
}

export function getTopicWeights() {
  const rows = db.prepare("SELECT topic, weight FROM topic_weights").all();
  return Object.fromEntries(rows.map((r) => [r.topic, r.weight]));
}

export function bumpTopicWeight(topic, delta) {
  db.prepare(
    `INSERT INTO topic_weights (topic, weight) VALUES (?, 1.0 + ?)
     ON CONFLICT(topic) DO UPDATE SET
       weight = MAX(0.2, MIN(3.0, weight + excluded.weight - 1.0)),
       updated_at = datetime('now')`,
  ).run(topic, delta);
}

export function recordUsedCommonsPhoto(descriptionUrl, subject) {
  db.prepare(
    "INSERT OR IGNORE INTO used_commons_photos (description_url, subject) VALUES (?, ?)",
  ).run(descriptionUrl, subject ?? null);
}

export function usedCommonsPhotoUrls() {
  return new Set(
    db.prepare("SELECT description_url FROM used_commons_photos").all().map((r) => r.description_url),
  );
}

export function recordInsights(postId, metrics) {
  db.prepare(
    `INSERT INTO insights (post_id, reach, likes, comments, saved, shares)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    postId,
    metrics.reach ?? null,
    metrics.likes ?? null,
    metrics.comments ?? null,
    metrics.saved ?? null,
    metrics.shares ?? null,
  );
}
