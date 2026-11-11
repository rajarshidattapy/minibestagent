import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDateReferences, mentionsThePast } from "./dates.ts";

let store: typeof import("./store.ts");
let context: typeof import("./context.ts");
let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "mini-memory-"));
  process.env.MEMORY_DB_PATH = join(dir, "test.db");
  store = await import("./store.ts");
  context = await import("./context.ts");
});

// --- date resolution ------------------------------------------------------
// Wednesday 11 November 2026, 14:00 local.
const NOW = new Date(2026, 10, 11, 14, 0);

/** The single day a reference resolves to, as YYYY-MM-DD. */
function resolvedDay(text: string, now = NOW): string | null {
  const [first] = resolveDateReferences(text, now);
  if (!first) return null;
  const d = first.from;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

test('"3 November" resolves to the most recent 3 November', () => {
  assert.equal(resolvedDay("what did I ask you on 3 November?"), "2026-11-03");
  assert.equal(resolvedDay("what about November 3rd?"), "2026-11-03");
  assert.equal(resolvedDay("on 3rd Nov"), "2026-11-03");
});

test("a month/day still in the future resolves to last year", () => {
  // Asking about "3 December" on 11 November means last December.
  assert.equal(resolvedDay("on 3 December"), "2025-12-03");
});

test("an explicit year is honoured", () => {
  assert.equal(resolvedDay("on 3 November 2024"), "2024-11-03");
});

test("bare weekdays resolve backwards", () => {
  // Wednesday the 11th: Monday was the 9th, Tuesday the 10th.
  assert.equal(resolvedDay("on Monday we shortlisted 5 CRM tools"), "2026-11-09");
  assert.equal(resolvedDay("last Tuesday I asked about Postgres hosting"), "2026-11-10");
});

test('"last <weekday>" on that same weekday means a week earlier', () => {
  // The distinction that makes "last Wednesday" on a Wednesday mean 7 days back.
  assert.equal(resolvedDay("last Wednesday"), "2026-11-04");
  assert.equal(resolvedDay("on Wednesday"), "2026-11-11");
});

test("relative words resolve", () => {
  assert.equal(resolvedDay("what did I ask yesterday?"), "2026-11-10");
  assert.equal(resolvedDay("earlier today"), "2026-11-11");
  assert.equal(resolvedDay("three days ago"), "2026-11-08");
  assert.equal(resolvedDay("2026-11-02"), "2026-11-02");
});

test("a message with no date reference yields nothing", () => {
  assert.deepEqual(resolveDateReferences("what is the capital of France?", NOW), []);
});

test("several references in one message all resolve", () => {
  const ranges = resolveDateReferences("between Monday and yesterday", NOW);
  assert.equal(ranges.length, 2);
});

test("mentionsThePast catches follow-ups with no explicit date", () => {
  assert.equal(mentionsThePast("is your answer still correct today?"), true);
  assert.equal(mentionsThePast("has any of them changed pricing since?"), true);
  assert.equal(mentionsThePast("you said it was $20"), true);
  assert.equal(mentionsThePast("what is the capital of France?"), false);
});

// --- store and recall -----------------------------------------------------

const OWNER = "anon:test-owner";

beforeEach(() => {
  // A fresh database file per test, so ordering never matters.
  const path = join(dir, `t-${Math.random().toString(36).slice(2)}.db`);
  store._resetForTests(path);
});

function seed(conversationId: string, role: "user" | "assistant", text: string, at: Date) {
  return store.appendTurn(
    { conversationId, role, ts: at.getTime(), text, content: text },
    OWNER,
  );
}

test("turns survive and come back in order", () => {
  seed("c1", "user", "first", new Date(2026, 10, 9, 10, 0));
  seed("c1", "assistant", "second", new Date(2026, 10, 9, 10, 1));

  const turns = store.allTurns("c1");
  assert.deepEqual(
    turns.map((t) => t.text),
    ["first", "second"],
  );
});

test("recall finds what was said on a named date, across conversations", () => {
  // The CRM question from the brief: asked in one thread, followed up in another.
  seed("monday-thread", "user", "shortlist 5 CRM tools for a 20-person sales team", new Date(2026, 10, 9, 9, 0));
  seed("monday-thread", "assistant", "HubSpot, Pipedrive, Close, Attio and Folk", new Date(2026, 10, 9, 9, 1));
  seed("today-thread", "user", "unrelated chatter", new Date(2026, 10, 11, 8, 0));

  const recalled = context.gatherRecall(
    OWNER,
    "On Monday we shortlisted 5 CRM tools. Has any of them changed pricing since?",
    new Set(),
    NOW,
  );

  const texts = recalled.map((r) => r.turn.text);
  assert.ok(texts.some((t) => t.includes("shortlist 5 CRM tools")), "should recall the question");
  assert.ok(texts.some((t) => t.includes("HubSpot")), "should recall the answer");
  assert.ok(!texts.includes("unrelated chatter"), "should not drag in unrelated turns");
});

test("recall finds things by topic when no date is given", () => {
  seed("old", "user", "what are my options for Postgres hosting?", new Date(2026, 9, 1, 9, 0));
  seed("old", "assistant", "Neon, Supabase and Railway are the main ones", new Date(2026, 9, 1, 9, 1));
  seed("old", "user", "how do I bake sourdough?", new Date(2026, 9, 2, 9, 0));

  const recalled = context.gatherRecall(
    OWNER,
    "has postgres hosting pricing changed since then?",
    new Set(),
    NOW,
  );

  const texts = recalled.map((r) => r.turn.text).join(" ");
  assert.match(texts, /Postgres hosting/i);
  assert.doesNotMatch(texts, /sourdough/i);
});

test("turns already in the live thread are not recalled twice", () => {
  const id = seed("c1", "user", "postgres hosting options", new Date(2026, 10, 10, 9, 0));

  const without = context.gatherRecall(OWNER, "postgres hosting, still right?", new Set(), NOW);
  assert.ok(without.length > 0);

  const withExclusion = context.gatherRecall(
    OWNER,
    "postgres hosting, still right?",
    new Set([id]),
    NOW,
  );
  assert.equal(withExclusion.find((r) => r.turn.id === id), undefined);
});

test("an ordinary question does no recall work at all", () => {
  seed("c1", "user", "postgres hosting options", new Date(2026, 10, 10, 9, 0));
  assert.deepEqual(context.gatherRecall(OWNER, "what is 2 + 2?", new Set(), NOW), []);
});

test("one owner never sees another's history", () => {
  seed("c1", "user", "my secret postgres setup", new Date(2026, 10, 10, 9, 0));

  const other = context.gatherRecall("anon:someone-else", "postgres, still right?", new Set(), NOW);
  assert.deepEqual(other, []);
  assert.equal(store.ownsConversation("c1", "anon:someone-else"), false);
  assert.equal(store.ownsConversation("c1", OWNER), true);
  // An id nobody has claimed is available.
  assert.equal(store.ownsConversation("brand-new", "anon:someone-else"), true);
});

test("search text from the user is never parsed as an FTS query", () => {
  seed("c1", "user", "postgres hosting", new Date(2026, 10, 10, 9, 0));
  // These would be syntax errors if passed through to FTS5 unescaped.
  for (const hostile of ['"', "NEAR(", "a OR (b", "*", 'postgres" OR "1']) {
    assert.doesNotThrow(() => store.searchTurns(OWNER, hostile));
  }
});

// --- context assembly -----------------------------------------------------

test("recall is injected as a system message, after the question", () => {
  seed("old", "user", "postgres hosting options please", new Date(2026, 10, 3, 9, 0));

  const built = context.buildContext(
    OWNER,
    "new-thread",
    { role: "user", content: "[2026-11-11 14:00] on 3 November I asked about postgres hosting - still right?" },
    "on 3 November I asked about postgres hosting - still right?",
    NOW,
  );

  const last = built.messages[built.messages.length - 1];
  assert.equal(last.role, "system", "recall must be the final message");
  assert.match(String(last.content), /postgres hosting options/);
  // The question itself stays a user turn, immediately before it.
  assert.equal(built.messages[built.messages.length - 2].role, "user");
});

test("no recall means no system message and an untouched prompt", () => {
  const built = context.buildContext(
    OWNER,
    "c1",
    { role: "user", content: "[2026-11-11 14:00] what is 2 + 2?" },
    "what is 2 + 2?",
    NOW,
  );
  assert.equal(built.messages.length, 1);
  assert.equal(built.messages[0].role, "user");
  assert.deepEqual(built.recalled, []);
});

test("the recall block is capped so old history cannot flood the window", () => {
  // 60 long turns on one day, all matching the question.
  for (let i = 0; i < 60; i++) {
    seed("old", "assistant", `postgres hosting note ${i}: ${"x".repeat(900)}`, new Date(2026, 10, 3, 9, i));
  }

  const recalled = context.gatherRecall(OWNER, "on 3 November, postgres hosting?", new Set(), NOW);
  const block = context.renderRecall(recalled, NOW)!;

  assert.ok(block.length < 16_000, `recall block was ${block.length} chars`);
  assert.match(block, /Today is 11 November 2026/);
});

test("the timestamp prefix is not mistaken for a date the user named", () => {
  // Every user message carries a "[2026-11-11 14:00]" prefix. Feeding that to
  // the date parser made every single turn look like it named today, so every
  // turn paid for a recall nobody asked for.
  seed("c1", "user", "something from earlier today", new Date(2026, 10, 11, 9, 0));

  const built = context.buildContext(
    OWNER,
    "c2",
    { role: "user", content: "[2026-11-11 14:00] what is 2 + 2?" },
    "what is 2 + 2?",
    NOW,
  );
  assert.deepEqual(built.recalled, [], "a plain question must recall nothing");

  // The prefix alone must not resolve to a date either.
  assert.deepEqual(resolveDateReferences("what is 2 + 2?", NOW), []);
});
