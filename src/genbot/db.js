import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

// The genbot's own state DB (config.dbPath, which .env.genbot points at
// ./data/genbot.db). Mirrors src/db.js and src/fbresponder/db.js: opened and
// migrated as an import side effect, which is exactly why cli.js imports this
// module lazily inside its case block rather than at the top of the file.
fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");

// One row per prompt the user sends. Exists because Telegram caps
// callback_data at 64 bytes — the prompt can't ride in the button, so we
// persist it and put only "g:<requestId>:<agentKey>" in the callback. Also
// gives /again something to look up.
db.exec(`
  CREATE TABLE IF NOT EXISTS gen_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    prompt TEXT NOT NULL,
    -- 'image' | 'video' — which slice of the agent registry was offered
    kind TEXT NOT NULL DEFAULT 'image',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_gen_requests_chat ON gen_requests (chat_id, id DESC);
`);

// Async generation jobs (video: Veo/Sora/Kling/Runway/Luma all return a job
// handle and take minutes). Unused by the image-only v1 — the table and the
// poller exist now so adding a video agent is a registry entry plus a
// pollJob() implementation, not a restructure of the bot loop.
db.exec(`
  CREATE TABLE IF NOT EXISTS gen_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id INTEGER NOT NULL,
    agent_key TEXT NOT NULL,
    provider TEXT NOT NULL,
    -- the provider's own handle for the job, whatever shape it takes
    external_job_id TEXT,
    -- queued -> running -> done | failed
    status TEXT NOT NULL DEFAULT 'queued',
    chat_id TEXT NOT NULL,
    -- the "⏳ Generating…" message we edit in place with progress
    status_message_id INTEGER,
    error_msg TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_gen_jobs_status ON gen_jobs (status);
`);

export function createRequest({ chatId, prompt, kind = "image" }) {
  const info = db
    .prepare(
      `INSERT INTO gen_requests (chat_id, prompt, kind) VALUES (@chat_id, @prompt, @kind)`,
    )
    .run({ chat_id: String(chatId), prompt, kind });
  return info.lastInsertRowid;
}

export function getRequest(id) {
  return db.prepare("SELECT * FROM gen_requests WHERE id = ?").get(id);
}

/** Most recent prompt from this chat — backs /again. */
export function lastRequest(chatId) {
  return db
    .prepare("SELECT * FROM gen_requests WHERE chat_id = ? ORDER BY id DESC LIMIT 1")
    .get(String(chatId));
}

export function createJob(fields) {
  const info = db
    .prepare(
      `INSERT INTO gen_jobs
         (request_id, agent_key, provider, external_job_id, status, chat_id, status_message_id)
       VALUES
         (@request_id, @agent_key, @provider, @external_job_id, @status, @chat_id, @status_message_id)`,
    )
    .run({ external_job_id: null, status: "queued", status_message_id: null, ...fields });
  return info.lastInsertRowid;
}

export function updateJob(id, fields) {
  const cols = Object.keys(fields);
  if (cols.length === 0) return;
  const sets = cols.map((c) => `${c} = @${c}`).join(", ");
  db.prepare(
    `UPDATE gen_jobs SET ${sets}, updated_at = datetime('now') WHERE id = @id`,
  ).run({ id, ...fields });
}

/**
 * Jobs still in flight, oldest first. Read on every poller tick *and* at
 * startup — a job that was running when the process died is picked back up
 * from here rather than being silently abandoned.
 */
export function pendingJobs() {
  return db
    .prepare("SELECT * FROM gen_jobs WHERE status IN ('queued', 'running') ORDER BY id ASC")
    .all();
}
