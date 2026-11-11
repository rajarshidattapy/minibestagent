import { database, _resetForTests as resetDb } from "../db.ts";
import type { ContentBlock } from "../types";

/**
 * Durable, server-side conversation memory.
 *
 * Recall by date and by topic is what makes "what did I ask you on
 * 3 November?" answerable. The connection and schema live in lib/db.ts;
 * to move this to Postgres, reimplement the functions below - nothing
 * outside this file knows it is SQLite.
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

/**
 * Common English function words, excluded from the search query.
 *
 * Without this, a turn about "a fact ABOUT the Eiffel Tower" and a question
 * "what did I ask you ABOUT Postgres hosting" match each other on "about"
 * alone - the OR query below means any one shared word is enough to surface
 * a row, and a short, generic word is exactly the one every unrelated turn
 * is likeliest to share. This does not fix OR-matching in general (two
 * turns can still share an unrelated but substantive word), but it removes
 * the specific failure mode where the shared word carries no topic at all.
 */
const STOPWORDS = new Set([
  "the", "and", "for", "are", "was", "were", "been", "being", "have", "has",
  "had", "with", "that", "this", "these", "those", "then", "than", "when",
  "what", "who", "whom", "whose", "where", "why", "how", "did", "does",
  "doing", "about", "since", "any", "all", "some", "into", "onto", "over",
  "under", "after", "before", "again", "once", "here", "there", "you",
  "your", "yours", "me", "myself", "him", "her", "its", "our", "ours",
  "they", "them", "their", "will", "would", "could", "should", "can",
  "may", "might", "must", "not", "nor", "but", "yet", "out", "off", "from",
  "tell", "fact", "ask", "asked", "asking", "say", "said", "know", "told",
]);

/** Strip FTS5 operators and common function words so a user's words are
 * never parsed as a query, and filler words never stand in for a topic. */
function sanitiseQuery(query: string): string {
  const terms = query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((term) => term.length > 2 && !STOPWORDS.has(term))
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
export const _resetForTests = resetDb;
