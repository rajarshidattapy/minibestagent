import type { ApiMessage } from "../types";
// Explicit extensions: Node's test runner resolves these directly, and the
// bundler is equally happy with them.
import { formatDay, mentionsThePast, resolveDateReferences } from "./dates.ts";
import { recentTurns, searchTurns, turnsInRange, type Turn } from "./store.ts";

/**
 * Builds the context for one turn.
 *
 * The rules give the agent exactly one tool - web search - so memory cannot
 * be a tool the model calls. Instead the server decides what is worth
 * remembering and puts it in the prompt. Three sources, in order of trust:
 *
 *   1. the running thread, verbatim, so ordinary conversation flows;
 *   2. anything from a date the user named ("on 3 November", "last Tuesday");
 *   3. anything that reads like the question, via full-text search.
 *
 * Recalled material is injected as a system message rather than faked into
 * the transcript, which keeps it clearly operator-supplied and leaves the
 * cached prefix intact.
 */

/** Verbatim turns of the live thread. Enough for flow, bounded for cost. */
const RECENT_TURNS = 24;

/** Ceiling on recalled text, so an old conversation cannot flood the window. */
const MAX_RECALL_CHARS = 12_000;

/** Per-turn truncation inside the recall block. */
const MAX_RECALL_TURN_CHARS = 1_200;

export type Recalled = {
  turn: Turn;
  reason: string;
};

export type BuiltContext = {
  messages: ApiMessage[];
  recalled: Recalled[];
};

function clip(text: string, limit: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit)}...`;
}

function stamp(ts: number): string {
  const date = new Date(ts);
  return `${formatDay(date)} at ${date.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

/**
 * Gather older turns worth showing the model. Recency within the live thread
 * is handled separately - this is the long-term half.
 */
export function gatherRecall(
  owner: string,
  question: string,
  excludeIds: Set<number>,
  now: Date = new Date(),
): Recalled[] {
  // Skip the work entirely when nothing suggests the past is relevant: most
  // turns are ordinary chat and should not pay for a search.
  if (!mentionsThePast(question)) return [];

  const picked = new Map<number, Recalled>();

  // Dates the user named are the strongest signal there is - take them first
  // so they are never crowded out by topical matches.
  for (const range of resolveDateReferences(question, now)) {
    for (const turn of turnsInRange(owner, range.from.getTime(), range.to.getTime())) {
      if (excludeIds.has(turn.id) || picked.has(turn.id)) continue;
      picked.set(turn.id, { turn, reason: `from ${formatDay(range.from)}` });
    }
  }

  for (const turn of searchTurns(owner, question)) {
    if (excludeIds.has(turn.id) || picked.has(turn.id)) continue;
    picked.set(turn.id, { turn, reason: "earlier, on this topic" });
  }

  // Oldest first, so the recall block reads as a timeline.
  return [...picked.values()].sort((a, b) => a.turn.ts - b.turn.ts);
}

/** Render recalled turns as the operator-supplied memory block. */
export function renderRecall(recalled: Recalled[], now: Date = new Date()): string | null {
  if (!recalled.length) return null;

  const lines: string[] = [];
  let budget = MAX_RECALL_CHARS;

  for (const { turn, reason } of recalled) {
    const speaker = turn.role === "user" ? "User asked" : "You answered";
    const line = `- [${stamp(turn.ts)}, ${reason}] ${speaker}: ${clip(turn.text, MAX_RECALL_TURN_CHARS)}`;
    if (line.length > budget) break;
    budget -= line.length;
    lines.push(line);
  }

  if (!lines.length) return null;

  return [
    `Relevant extracts from this user's earlier conversations with you.`,
    `Today is ${formatDay(now)}.`,
    ``,
    ...lines,
    ``,
    `These extracts are a record of what was actually said, so treat them as reliable.`,
    `Anything factual in them was true when it was said and may be stale now: if the user`,
    `asks whether it still holds, or what has changed since, search the web and compare`,
    `what you find against the extract, then say plainly what changed and what did not.`,
  ].join("\n");
}

/**
 * Assemble the messages for one request: the live thread, the new question,
 * and - when the question reaches back - a recall block.
 */
export function buildContext(
  owner: string,
  conversationId: string,
  question: ApiMessage,
  /**
   * The user's words alone. Deliberately not `question.content`, which
   * carries the `[2026-11-11 14:32]` prefix - feeding that to the date
   * parser makes every single message look like it names today's date, and
   * every turn pays for a recall it never asked for.
   */
  questionText: string,
  now: Date = new Date(),
): BuiltContext {
  const thread = recentTurns(conversationId, RECENT_TURNS);
  const messages: ApiMessage[] = thread.map((turn) => ({
    role: turn.role,
    content: turn.content,
  }));

  // The thread is already in the prompt verbatim; do not repeat it in recall.
  const inThread = new Set(thread.map((turn) => turn.id));
  const recalled = gatherRecall(owner, questionText, inThread, now);

  messages.push(question);

  const block = renderRecall(recalled, now);
  if (block) {
    // A mid-conversation system message: operator-supplied, clearly separate
    // from anything the user or a web page said, and placed last so the
    // cached prefix above it is untouched.
    messages.push({ role: "system", content: block });
  }

  return { messages, recalled };
}
