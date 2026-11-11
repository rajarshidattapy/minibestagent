import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The one SQLite connection, shared by conversation memory and the response
 * cache. Both are durable by the same mechanism, so both survive a restart.
 *
 * `node:sqlite` is built into Node, so none of this costs a dependency.
 */

let db: DatabaseSync | null = null;

/**
 * Read at connect time, not import time, so tests can redirect it.
 *
 * The default is statically scoped to ./data. Composing it with
 * `path.resolve` on a variable instead makes the bundler trace the whole
 * project and ship every source file with the server bundle.
 */
function dbPath(): string {
  const override = process.env.MEMORY_DB_PATH;
  return override ? override : join(process.cwd(), "data", "mini.db");
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS conversations (
    id          TEXT PRIMARY KEY,
    owner       TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS conversations_owner
    ON conversations (owner, updated_at DESC);

  CREATE TABLE IF NOT EXISTS turns (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    owner           TEXT NOT NULL,
    role            TEXT NOT NULL,
    ts              INTEGER NOT NULL,
    text            TEXT NOT NULL,
    content         TEXT NOT NULL
  );

  -- Recall by conversation (the running thread) and by date (the "what did
  -- I ask on 3 November" case, which may span conversations).
  CREATE INDEX IF NOT EXISTS turns_conversation ON turns (conversation_id, id);
  CREATE INDEX IF NOT EXISTS turns_owner_ts     ON turns (owner, ts);

  -- Topical recall. An external-content table so the text is not stored twice.
  CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts
    USING fts5(text, content='turns', content_rowid='id', tokenize='porter unicode61');

  -- Cached model responses.
  --
  -- Only the hash of the scrubbed prompt is stored, never the prompt itself:
  -- a cache should not become a second, less careful copy of everyone's
  -- conversations.
  CREATE TABLE IF NOT EXISTS response_cache (
    key         TEXT NOT NULL,
    scope       TEXT NOT NULL,
    content     TEXT NOT NULL,
    used_search INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    hits        INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (key, scope)
  );

  CREATE INDEX IF NOT EXISTS response_cache_expiry ON response_cache (expires_at);
`;

const TRIGGERS = `
  CREATE TRIGGER IF NOT EXISTS turns_ai AFTER INSERT ON turns BEGIN
    INSERT INTO turns_fts(rowid, text) VALUES (new.id, new.text);
  END;
  CREATE TRIGGER IF NOT EXISTS turns_ad AFTER DELETE ON turns BEGIN
    INSERT INTO turns_fts(turns_fts, rowid, text) VALUES ('delete', old.id, old.text);
  END;
`;

export function database(): DatabaseSync {
  if (db) return db;

  const path = dbPath();
  mkdirSync(dirname(path), { recursive: true });
  db = new DatabaseSync(path);

  // WAL keeps reads from blocking the write of the turn in flight.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  // Keep the search index in step from inside the database, so no write path
  // can forget to update it.
  db.exec(TRIGGERS);

  return db;
}

/** Test seam: point the module at a throwaway database. */
export function _resetForTests(path: string): void {
  db?.close();
  db = null;
  process.env.MEMORY_DB_PATH = path;
}
