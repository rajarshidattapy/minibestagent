import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiMessage, ContentBlock } from "./types.ts";

let cache: typeof import("./cache.ts");
let db: typeof import("./db.ts");
let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "mini-cache-"));
  process.env.MEMORY_DB_PATH = join(dir, "cache.db");
  db = await import("./db.ts");
  cache = await import("./cache.ts");
});

beforeEach(() => {
  db._resetForTests(join(dir, `c-${Math.random().toString(36).slice(2)}.db`));
  delete process.env.LLM_CACHE;
  delete process.env.LLM_CACHE_SCOPE;
});

const OWNER = "anon:owner-1";

function keyFor(messages: ApiMessage[], overrides: Partial<cacheKeyInput> = {}) {
  return cache.cacheKey({
    model: "claude-opus-5-5",
    system: "you are a helpful assistant",
    effort: "low",
    tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }],
    messages,
    ...overrides,
  });
}
type cacheKeyInput = Parameters<typeof cache.cacheKey>[0];

const answer = (text: string): ContentBlock[] => [{ type: "text", text }];

const searchedAnswer = (text: string): ContentBlock[] => [
  { type: "server_tool_use", name: "web_search", input: { query: "x" } },
  { type: "web_search_tool_result", content: [{ type: "web_search_result", url: "https://a" }] },
  { type: "text", text },
];

// --- the scrubbing, which is the whole design -----------------------------

test("the clock is scrubbed but the date is kept", () => {
  assert.equal(cache.scrubTimestamps("[2026-11-11 14:32] hello"), "[2026-11-11] hello");
  assert.equal(cache.scrubTimestamps("no stamp here"), "no stamp here");
});

test("the same question at a different minute hits the same key", () => {
  // Without scrubbing, the per-message clock makes every prompt unique and
  // the cache never hits once.
  const a = keyFor([{ role: "user", content: "[2026-11-11 09:00] what is rust?" }]);
  const b = keyFor([{ role: "user", content: "[2026-11-11 17:45] what is rust?" }]);
  assert.equal(a, b);
});

test("the same question on a different DAY gets a different key", () => {
  // The trap in the other direction: scrubbing the date too would make
  // "what did I ask yesterday?" answer with yesterday's yesterday.
  const monday = keyFor([{ role: "user", content: "[2026-11-09 09:00] what did I ask yesterday?" }]);
  const tuesday = keyFor([{ role: "user", content: "[2026-11-10 09:00] what did I ask yesterday?" }]);
  assert.notEqual(monday, tuesday);
});

test("anything that could change the answer changes the key", () => {
  const base: ApiMessage[] = [{ role: "user", content: "[2026-11-11 09:00] hello" }];
  const key = keyFor(base);

  assert.notEqual(keyFor([{ role: "user", content: "[2026-11-11 09:00] hello there" }]), key, "question");
  assert.notEqual(keyFor(base, { model: "claude-sonnet-5-5" }), key, "model");
  assert.notEqual(keyFor(base, { system: "you are terse" }), key, "system prompt");
  assert.notEqual(keyFor(base, { effort: "high" }), key, "effort");
  assert.notEqual(keyFor(base, { tools: [] }), key, "tools");

  // Recalled memory rides in a system message and absolutely changes the answer.
  assert.notEqual(
    keyFor([...base, { role: "system", content: "On 3 November you said $20" }]),
    key,
    "recalled memory",
  );
});

test("key order in content blocks does not change the hash", () => {
  const a = keyFor([{ role: "assistant", content: [{ type: "text", text: "hi" } as ContentBlock] }]);
  const b = keyFor([{ role: "assistant", content: [{ text: "hi", type: "text" } as ContentBlock] }]);
  assert.equal(a, b);
});

// --- storage --------------------------------------------------------------

test("a stored answer comes back", () => {
  const key = keyFor([{ role: "user", content: "[2026-11-11 09:00] hello" }]);
  assert.equal(cache.lookup(key, OWNER), null);

  cache.store(key, OWNER, answer("hi there"));
  const hit = cache.lookup(key, OWNER);
  assert.ok(hit);
  assert.deepEqual(hit.content, answer("hi there"));
  assert.equal(hit.usedSearch, false);
});

test("a searched answer expires quickly; an unsearched one lives much longer", () => {
  // The whole point of the agent is freshness, so a web-backed answer must
  // not outlive its sources by long.
  const now = Date.now();
  const searched = keyFor([{ role: "user", content: "[2026-11-11 09:00] latest release?" }]);
  const plain = keyFor([{ role: "user", content: "[2026-11-11 09:00] what is 2+2?" }]);

  cache.store(searched, OWNER, searchedAnswer("v3 shipped"), now);
  cache.store(plain, OWNER, answer("4"), now);

  const halfAnHour = now + 30 * 60 * 1000;
  assert.equal(cache.lookup(searched, OWNER, halfAnHour), null, "searched should have expired");
  assert.ok(cache.lookup(plain, OWNER, halfAnHour), "unsearched should survive");

  const nextDay = now + 25 * 60 * 60 * 1000;
  assert.equal(cache.lookup(plain, OWNER, nextDay), null, "unsearched should expire eventually");
});

test("one user's cached answer is not served to another", () => {
  const key = keyFor([{ role: "user", content: "[2026-11-11 09:00] my private question" }]);
  cache.store(key, OWNER, answer("private answer"));

  assert.ok(cache.lookup(key, OWNER));
  assert.equal(cache.lookup(key, "anon:someone-else"), null);
});

test("global scope shares across users when explicitly opted into", () => {
  process.env.LLM_CACHE_SCOPE = "global";
  const key = keyFor([{ role: "user", content: "[2026-11-11 09:00] what is rust?" }]);
  cache.store(key, OWNER, answer("a language"));

  assert.ok(cache.lookup(key, "anon:someone-else"), "global scope should share");
});

test("LLM_CACHE=off disables reads and writes", () => {
  const key = keyFor([{ role: "user", content: "[2026-11-11 09:00] hello" }]);
  process.env.LLM_CACHE = "off";

  cache.store(key, OWNER, answer("hi"));
  assert.equal(cache.lookup(key, OWNER), null);

  delete process.env.LLM_CACHE;
  assert.equal(cache.lookup(key, OWNER), null, "nothing should have been written");
});

test("expired rows are pruned rather than accumulating", () => {
  const now = Date.now();
  for (let i = 0; i < 20; i++) {
    cache.store(keyFor([{ role: "user", content: `[2026-11-11 09:00] q${i}` }]), OWNER, searchedAnswer("a"), now);
  }
  assert.equal(cache.stats().entries, 20);

  // A later write prunes everything that has since expired.
  cache.store(keyFor([{ role: "user", content: "[2026-11-11 09:00] fresh" }]), OWNER, answer("a"), now + 60 * 60 * 1000);
  assert.equal(cache.stats().entries, 1);
});

test("usedWebSearch recognises a searched answer", () => {
  assert.equal(cache.usedWebSearch(answer("hi")), false);
  assert.equal(cache.usedWebSearch(searchedAnswer("hi")), true);
});

test("the cache survives a restart", () => {
  const path = join(dir, "persist.db");
  db._resetForTests(path);

  const key = keyFor([{ role: "user", content: "[2026-11-11 09:00] remember me" }]);
  cache.store(key, OWNER, answer("still here"));

  // Close and reopen the same file, exactly as a restart would.
  db._resetForTests(path);

  const hit = cache.lookup(key, OWNER);
  assert.ok(hit, "entry should survive a reconnect");
  assert.deepEqual(hit.content, answer("still here"));
});
