import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS fb_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform_event_id TEXT NOT NULL UNIQUE,
    event_type TEXT NOT NULL,
    -- pending_review -> approved -> sent | failed
    -- pending_review -> rejected
    status TEXT NOT NULL DEFAULT 'pending_review',
    from_id TEXT,
    from_name TEXT,
    content TEXT,
    post_context TEXT,
    proposed_reply TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

export function eventExists(platformEventId) {
  return !!db
    .prepare("SELECT 1 FROM fb_events WHERE platform_event_id = ?")
    .get(platformEventId);
}

export function createEvent(fields) {
  const info = db
    .prepare(
      `INSERT INTO fb_events
         (platform_event_id, event_type, from_id, from_name, content, post_context, proposed_reply, status)
       VALUES (@platform_event_id, @event_type, @from_id, @from_name, @content, @post_context, @proposed_reply, @status)`,
    )
    .run({ status: "pending_review", ...fields });
  return info.lastInsertRowid;
}

export function updateEvent(id, fields) {
  const cols = Object.keys(fields);
  if (cols.length === 0) return;
  const sets = cols.map((c) => `${c} = @${c}`).join(", ");
  db.prepare(
    `UPDATE fb_events SET ${sets}, updated_at = datetime('now') WHERE id = @id`,
  ).run({ id, ...fields });
}

export function getEvent(id) {
  return db.prepare("SELECT * FROM fb_events WHERE id = ?").get(id);
}
