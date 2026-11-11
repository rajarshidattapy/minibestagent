import { createHash } from "node:crypto";
import { database } from "./db.ts";
import type { ApiMessage, ContentBlock } from "./types";

/**
 * A persistent cache of model responses, keyed on a hash of the scrubbed
 * prompt and stored in the same SQLite file as conversation memory, so it
 * survives a restart.
 *
 * Only the hash is stored, never the prompt. A cache should not quietly
 * become a second, less careful copy of everyone's conversations.
 */

/**
 * How long a cached answer stays usable.
 *
 * This agent's job is to be current, so an answer built from a web search
 * goes stale quickly and gets a short life. An answer the model gave from
 * its own knowledge is not racing anything and can live far longer. Which
 * one it was is known at write time, from the blocks in the response.
 */
const TTL_SEARCHED_MS = 15 * 60 * 1000;
const TTL_UNSEARCHED_MS = 12 * 60 * 60 * 1000;

/** Keep the table from growing without bound on a long-lived server. */
const MAX_ENTRIES = 5_000;

export type CacheHit = {
  content: ContentBlock[];
  usedSearch: boolean;
  storedAt: number;
  expiresAt: number;
};

export function cacheEnabled(): boolean {
  return process.env.LLM_CACHE !== "off";
}

/**
 * Who a cached answer may be served to.
 *
 * Owner-scoped by default. An identical scrubbed prompt really does imply an
 * identical answer, so global sharing is sound in principle - but the prompt
 * carries the user's recalled history, and a key that is right only because
 * of a subtle argument is the kind that breaks the first time someone adds a
 * field. Set LLM_CACHE_SCOPE=global to trade that caution for a hit rate
 * across users on identical cold-start questions.
 */
function scopeFor(owner: string): string {
  return process.env.LLM_CACHE_SCOPE === "global" ? "global" : owner;
}

/** Deterministic JSON: key order must never change the hash. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(",")}}`;
}

/**
 * Drop the time of day from a message's timestamp prefix, keeping the date.
 *
 * Both halves matter. Leaving the clock in means every prompt is unique and
 * nothing ever hits. Removing the prefix entirely is worse than useless: it
 * makes "what did I ask yesterday?" hash the same on Tuesday as on Monday,
 * and the cache confidently answers with the wrong day. Day precision keeps
 * date-relative questions correct and still lets a repeat within the same
 * day hit.
 */
export function scrubTimestamps(text: string): string {
  return text.replace(/\[(\d{4}-\d{2}-\d{2}) \d{2}:\d{2}\]/g, "[$1]");
}

function scrubContent(content: string | ContentBlock[]): unknown {
  if (typeof content === "string") {
    return scrubTimestamps(content).replace(/\s+/g, " ").trim();
  }
  return content.map((block) => {
    if (typeof block.text === "string") {
      return { ...block, text: scrubTimestamps(block.text).replace(/\s+/g, " ").trim() };
    }
    return block;
  });
}

export type KeyInput = {
  model: string;
  system: string;
  effort: string;
  tools: unknown;
  messages: ApiMessage[];
};

/**
 * The cache key: a hash of everything that could change the answer, with the
 * clock scrubbed out. Time is handled by expiry, not by the key.
 */
export function cacheKey(input: KeyInput): string {
  const canonical = stableStringify({
    model: input.model,
    system: input.system.replace(/\s+/g, " ").trim(),
    effort: input.effort,
    tools: input.tools,
    messages: input.messages.map((m) => ({ role: m.role, content: scrubContent(m.content) })),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/** True when the response was built from a web search. */
export function usedWebSearch(content: ContentBlock[]): boolean {
  return content.some(
    (block) =>
      block.type === "web_search_tool_result" ||
      (block.type === "server_tool_use" && block.name === "web_search"),
  );
}

export function lookup(key: string, owner: string, now = Date.now()): CacheHit | null {
  if (!cacheEnabled()) return null;

  const row = database()
    .prepare(
      `SELECT content, used_search, created_at, expires_at
       FROM response_cache WHERE key = ? AND scope = ? AND expires_at > ?`,
    )
    .get(key, scopeFor(owner), now) as
    | { content: string; used_search: number; created_at: number; expires_at: number }
    | undefined;

  if (!row) return null;

  database()
    .prepare(`UPDATE response_cache SET hits = hits + 1 WHERE key = ? AND scope = ?`)
    .run(key, scopeFor(owner));

  try {
    return {
      content: JSON.parse(row.content) as ContentBlock[],
      usedSearch: row.used_search === 1,
      storedAt: row.created_at,
      expiresAt: row.expires_at,
    };
  } catch {
    // Unreadable row: treat as a miss rather than taking the request down.
    return null;
  }
}

export function store(
  key: string,
  owner: string,
  content: ContentBlock[],
  now = Date.now(),
): void {
  if (!cacheEnabled()) return;

  const searched = usedWebSearch(content);
  const expiresAt = now + (searched ? TTL_SEARCHED_MS : TTL_UNSEARCHED_MS);

  database()
    .prepare(
      `INSERT INTO response_cache (key, scope, content, used_search, created_at, expires_at, hits)
       VALUES (?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT(key, scope) DO UPDATE SET
         content = excluded.content,
         used_search = excluded.used_search,
         created_at = excluded.created_at,
         expires_at = excluded.expires_at`,
    )
    .run(key, scopeFor(owner), JSON.stringify(content), searched ? 1 : 0, now, expiresAt);

  prune(now);
}

/** Drop expired rows, then the oldest if the table is still oversized. */
export function prune(now = Date.now()): void {
  const db = database();
  db.prepare(`DELETE FROM response_cache WHERE expires_at <= ?`).run(now);

  const { n } = db.prepare(`SELECT COUNT(*) AS n FROM response_cache`).get() as { n: number };
  if (n > MAX_ENTRIES) {
    db.prepare(
      `DELETE FROM response_cache WHERE rowid IN (
         SELECT rowid FROM response_cache ORDER BY expires_at ASC LIMIT ?
       )`,
    ).run(n - MAX_ENTRIES);
  }
}

export function stats(): { entries: number; hits: number } {
  const row = database()
    .prepare(`SELECT COUNT(*) AS entries, COALESCE(SUM(hits), 0) AS hits FROM response_cache`)
    .get() as { entries: number; hits: number };
  return row;
}
