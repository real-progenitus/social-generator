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
    -- 'photo_help' | 'post_redirect' | 'other' — classified by generateReply(),
    -- used to decide whether this exchange gets a proactive follow-up nudge.
    topic TEXT,
    -- null -> 'awaiting' (nudge due in an hour) -> 'nudge_sent' (waiting on
    -- their reply) -> 'replied' (they answered; loop closed). Only ever set
    -- on 'photo_help' or 'post_redirect' DM rows — see followup.js and
    -- FOLLOW_UP_TOPICS below.
    followup_status TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Idempotent column additions for upgrading an existing DB file — CREATE
// TABLE IF NOT EXISTS above doesn't add columns to a table that already
// exists from before `topic`/`followup_status` were introduced.
for (const [column, type] of [
  ["topic", "TEXT"],
  ["followup_status", "TEXT"],
]) {
  const exists = db
    .prepare("SELECT 1 FROM pragma_table_info('fb_events') WHERE name = ?")
    .get(column);
  if (!exists) db.exec(`ALTER TABLE fb_events ADD COLUMN ${column} ${type}`);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS paused_senders (
    from_id TEXT PRIMARY KEY,
    paused_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Caches each sender's Messenger account locale (or NULL if we looked it up
// and got nothing back - still a cache hit, so a failed/empty lookup isn't
// retried on every image-only message). No TTL: account locale essentially
// never changes, and this only gates a fallback path (image-only DMs with no
// text to detect language from), so indefinite caching is the simplest
// correct choice.
db.exec(`
  CREATE TABLE IF NOT EXISTS sender_locales (
    from_id TEXT PRIMARY KEY,
    locale TEXT,
    checked_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Topics that get a proactive "did this work out?" nudge if the sender goes
// quiet for an hour — shared between the scheduling check in webhook.js and
// the due-nudge query below, so the two can't drift apart.
export const FOLLOW_UP_TOPICS = ["photo_help", "post_redirect"];

// If a Telegram "take over" is forgotten, the bot resumes itself after this
// many hours rather than staying silent on that person indefinitely.
const PAUSE_AUTO_EXPIRE_HOURS = 4;

export function pauseSender(fromId) {
  db.prepare(
    `INSERT INTO paused_senders (from_id, paused_at) VALUES (?, datetime('now'))
     ON CONFLICT(from_id) DO UPDATE SET paused_at = excluded.paused_at`,
  ).run(fromId);
}

export function resumeSender(fromId) {
  db.prepare("DELETE FROM paused_senders WHERE from_id = ?").run(fromId);
}

// True if a human is currently handling this sender manually. Expiry is
// enforced directly in the query (no background sweep needed) — a stale row
// just stops matching and is harmless to leave behind.
export function isPaused(fromId) {
  if (!fromId) return false;
  return !!db
    .prepare(
      `SELECT 1 FROM paused_senders
       WHERE from_id = ? AND paused_at > datetime('now', '-' || ? || ' hours')`,
    )
    .get(fromId, PAUSE_AUTO_EXPIRE_HOURS);
}

// { cached: true, locale: string|null } if we've already looked this sender
// up (locale may legitimately be null - Meta returned nothing); { cached:
// false } if we've never checked, so the caller knows to call
// fetchUserLocale() and record the result via setSenderLocale().
export function getSenderLocale(fromId) {
  if (!fromId) return { cached: false };
  const row = db.prepare("SELECT locale FROM sender_locales WHERE from_id = ?").get(fromId);
  return row ? { cached: true, locale: row.locale } : { cached: false };
}

export function setSenderLocale(fromId, locale) {
  db.prepare(
    `INSERT INTO sender_locales (from_id, locale, checked_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(from_id) DO UPDATE SET locale = excluded.locale, checked_at = excluded.checked_at`,
  ).run(fromId, locale);
}

export function eventExists(platformEventId) {
  return !!db
    .prepare("SELECT 1 FROM fb_events WHERE platform_event_id = ?")
    .get(platformEventId);
}

export function createEvent(fields) {
  const info = db
    .prepare(
      `INSERT INTO fb_events
         (platform_event_id, event_type, from_id, from_name, content, post_context, proposed_reply, topic, status)
       VALUES (@platform_event_id, @event_type, @from_id, @from_name, @content, @post_context, @proposed_reply, @topic, @status)`,
    )
    .run({ status: "pending_review", topic: null, ...fields });
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

// Recent turns with this sender, oldest first, for multi-turn context. Only
// surfaces proposed_reply for rows the sender actually saw (status='sent') —
// a rejected or still-pending proposal was never delivered, so presenting it
// as something "we already said" would mislead the model. `excludeId` drops
// one row (the message currently being answered, which is recorded before we
// generate — see webhook.js's coalescing) so it isn't fed back as its own
// history; the still-unanswered earlier burst messages remain as context.
export function recentEventsFrom(fromId, eventType, { limit = 6, excludeId = null } = {}) {
  if (!fromId) return [];
  const rows = db
    .prepare(
      `SELECT content, proposed_reply, status FROM fb_events
       WHERE from_id = ? AND event_type = ? AND (? IS NULL OR id != ?)
       ORDER BY id DESC LIMIT ?`,
    )
    .all(fromId, eventType, excludeId, excludeId, limit);
  return rows.reverse().map((r) => ({
    content: r.content,
    reply: r.status === "sent" ? r.proposed_reply : null,
  }));
}

// True if this sender has any message row newer than `afterId` — used by the
// DM coalescing debounce (webhook.js) to let the latest message in a burst be
// the one that actually replies, while earlier ones bow out. Same monotonic-id
// "is there anything newer from them" test as findDueFollowUps's NOT EXISTS.
export function hasNewerMessageFrom(fromId, afterId) {
  if (!fromId) return false;
  return !!db
    .prepare(
      `SELECT 1 FROM fb_events WHERE from_id = ? AND event_type = 'message' AND id > ?`,
    )
    .get(fromId, afterId);
}

// A prior 'photo_help'/'post_redirect' DM we sent a check-in nudge for, and
// are still waiting to hear back from — used to detect that a fresh inbound
// message is the reply closing that loop (triggers the topic-specific note
// in generateReply.js).
export function findPendingNudge(fromId) {
  if (!fromId) return null;
  return db
    .prepare(
      `SELECT * FROM fb_events
       WHERE from_id = ? AND followup_status = 'nudge_sent'
       ORDER BY id DESC LIMIT 1`,
    )
    .get(fromId);
}

// DMs on a FOLLOW_UP_TOPICS topic we answered over an hour ago that are
// still awaiting a nudge, where the sender hasn't sent anything else since
// (any newer row from the same from_id means they already replied — skip
// those).
export function findDueFollowUps(delayMinutes) {
  const placeholders = FOLLOW_UP_TOPICS.map(() => "?").join(", ");
  return db
    .prepare(
      `SELECT * FROM fb_events e
       WHERE e.event_type = 'message' AND e.topic IN (${placeholders}) AND e.status = 'sent'
         AND e.followup_status = 'awaiting'
         AND e.updated_at <= datetime('now', '-' || ? || ' minutes')
         AND NOT EXISTS (
           SELECT 1 FROM fb_events e2 WHERE e2.from_id = e.from_id AND e2.id > e.id
         )`,
    )
    .all(...FOLLOW_UP_TOPICS, delayMinutes);
}
