import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ContentBlock } from "../types";

/**
 * Durable, server-side conversation memory.
 *
 * SQLite via `node:sqlite` - built into Node, so `npm install` adds nothing.
 * It buys three things the browser could not: memory that survives a cleared
 * cache or a different device, recall by date, and full-text recall by topic.
 *
 * The schema is deliberately small, and every query the agent needs is an
 * index hit. To move this to Postgres, reimplement `Store` - nothing outside
 * this file knows it is SQLite.
 */

export type Turn = {
  id: number;
  conversationId: string;
  role: "user" | "assistant";
  /** Epoch milliseconds. */
  ts: number;
  /** Plain text, for display, search and recall. */
  text: string;
  /** The verbatim API content blocks, replayed unchanged on later requests. */
  content: string | ContentBlock[];
};

export type NewTurn = Omit<Turn, "id">;

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

let db: DatabaseSync | null = null;

function database(): DatabaseSync {
  if (db) return db;

  const path = dbPath();
  mkdirSync(dirname(path), { recursive: true });
  db = new DatabaseSync(path);

  // WAL keeps reads from blocking the write of the turn in flight.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  db.exec(`
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
  `);

  // Keep the index in step with the table from inside the database, so no
  // write path can forget to update it.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS turns_ai AFTER INSERT ON turns BEGIN
      INSERT INTO turns_fts(rowid, text) VALUES (new.id, new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS turns_ad AFTER DELETE ON turns BEGIN
      INSERT INTO turns_fts(turns_fts, rowid, text) VALUES ('delete', old.id, old.text);
    END;
  `);

  return db;
}

type Row = {
  id: number;
  conversation_id: string;
  role: string;
  ts: number;
  text: string;
  content: string;
};

function toTurn(row: Row): Turn {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role === "assistant" ? "assistant" : "user",
    ts: row.ts,
    text: row.text,
    content: JSON.parse(row.content) as string | ContentBlock[],
  };
}

export function ensureConversation(id: string, owner: string): void {
  const now = Date.now();
  database()
    .prepare(
      `INSERT INTO conversations (id, owner, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`,
    )
    .run(id, owner, now, now);
}

export function appendTurn(turn: NewTurn, owner: string): number {
  ensureConversation(turn.conversationId, owner);
  const result = database()
    .prepare(
      `INSERT INTO turns (conversation_id, owner, role, ts, text, content)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      turn.conversationId,
      owner,
      turn.role,
      turn.ts,
      turn.text,
      JSON.stringify(turn.content),
    );
  return Number(result.lastInsertRowid);
}

/** Does this conversation belong to this owner? Guards cross-owner reads. */
export function ownsConversation(id: string, owner: string): boolean {
  const row = database()
    .prepare(`SELECT owner FROM conversations WHERE id = ?`)
    .get(id) as { owner: string } | undefined;
  // An id nobody has used yet is free to claim.
  return row === undefined || row.owner === owner;
}

/** The running thread, oldest first. */
export function recentTurns(conversationId: string, limit: number): Turn[] {
  const rows = database()
    .prepare(
      `SELECT * FROM (
         SELECT * FROM turns WHERE conversation_id = ? ORDER BY id DESC LIMIT ?
       ) ORDER BY id ASC`,
    )
    .all(conversationId, limit) as Row[];
  return rows.map(toTurn);
}

export function allTurns(conversationId: string): Turn[] {
  const rows = database()
    .prepare(`SELECT * FROM turns WHERE conversation_id = ? ORDER BY id ASC`)
    .all(conversationId) as Row[];
  return rows.map(toTurn);
}

/**
 * Turns an owner recorded within a window, across every conversation - "what
 * did I ask on 3 November" should not care which thread it happened in.
 */
export function turnsInRange(
  owner: string,
  from: number,
  to: number,
  limit = 40,
): Turn[] {
  const rows = database()
    .prepare(
      `SELECT * FROM turns
       WHERE owner = ? AND ts >= ? AND ts < ?
       ORDER BY ts ASC LIMIT ?`,
    )
    .all(owner, from, to, limit) as Row[];
  return rows.map(toTurn);
}

/** Strip FTS5 operators so a user's words are never parsed as a query. */
function sanitiseQuery(query: string): string {
  const terms = query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((term) => term.length > 2)
    .slice(0, 12);
  if (!terms.length) return "";
  // Quoted terms, OR-ed: match on any salient word, ranked by relevance.
  return terms.map((term) => `"${term}"`).join(" OR ");
}

/** Topical recall: the turns that read most like this question. */
export function searchTurns(owner: string, query: string, limit = 8): Turn[] {
  const match = sanitiseQuery(query);
  if (!match) return [];

  try {
    const rows = database()
      .prepare(
        `SELECT turns.* FROM turns_fts
         JOIN turns ON turns.id = turns_fts.rowid
         WHERE turns_fts MATCH ? AND turns.owner = ?
         ORDER BY bm25(turns_fts) ASC
         LIMIT ?`,
      )
      .all(match, owner, limit) as Row[];
    return rows.map(toTurn);
  } catch {
    // A malformed match expression must never take the chat down.
    return [];
  }
}

export function conversationSize(conversationId: string): number {
  const row = database()
    .prepare(`SELECT COUNT(*) AS n FROM turns WHERE conversation_id = ?`)
    .get(conversationId) as { n: number };
  return row.n;
}

/** Test seam: point the module at a throwaway database. */
export function _resetForTests(path: string): void {
  db?.close();
  db = null;
  process.env.MEMORY_DB_PATH = path;
}
