import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_BODY_BYTES,
  MAX_MESSAGES,
  MAX_MESSAGE_CHARS,
  MAX_TOTAL_CHARS,
  checkConversation,
  readBoundedJson,
} from "./guardrails.ts";
import {
  MemoryStore,
  checkRateLimit,
  rateLimitHeaders,
  rateLimitKey,
  type Rule,
} from "./rate-limit.ts";
import type { ApiMessage } from "./types.ts";

const user = (text: string): ApiMessage => ({ role: "user", content: text });
const assistant = (text: string): ApiMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
});

// --- conversation limits --------------------------------------------------

test("an ordinary conversation passes", () => {
  assert.equal(checkConversation([user("hi"), assistant("hello"), user("more")]), null);
});

test("an empty conversation is rejected", () => {
  assert.equal(checkConversation([])?.status, 400);
});

test("a history that does not end with the user is rejected", () => {
  const failure = checkConversation([user("hi"), assistant("hello")]);
  assert.equal(failure?.status, 400);
  assert.match(failure!.error, /last message must be from the user/);
});

test("too many turns is rejected", () => {
  const many = Array.from({ length: MAX_MESSAGES + 1 }, () => user("hi"));
  assert.equal(checkConversation(many)?.status, 413);
});

test("an oversized user message is rejected", () => {
  const failure = checkConversation([user("x".repeat(MAX_MESSAGE_CHARS + 1))]);
  assert.equal(failure?.status, 413);
  assert.match(failure!.error, /Message 1 is too long/);
});

test("an oversized assistant turn is not blamed on the user", () => {
  // Assistant turns are replayed verbatim and already bounded by max_tokens,
  // so only the total matters for them.
  const failure = checkConversation([
    assistant("x".repeat(MAX_MESSAGE_CHARS + 1)),
    user("hi"),
  ]);
  assert.equal(failure, null);
});

test("an oversized conversation is rejected even when each message is small", () => {
  const chunk = "x".repeat(MAX_MESSAGE_CHARS);
  const needed = Math.ceil(MAX_TOTAL_CHARS / MAX_MESSAGE_CHARS) + 1;
  const messages = Array.from({ length: needed }, () => assistant(chunk));
  messages.push(user("hi"));

  const failure = checkConversation(messages);
  assert.equal(failure?.status, 413);
  assert.match(failure!.error, /too large/);
});

test("search results inside an assistant turn count toward the total", () => {
  // A long search result is real tokens; ignoring it would let a client
  // replay a huge history for free.
  const big = "x".repeat(MAX_TOTAL_CHARS + 1);
  const withResults: ApiMessage = {
    role: "assistant",
    content: [
      {
        type: "web_search_tool_result",
        content: [{ type: "web_search_result", text: big }],
      },
    ],
  };
  assert.equal(checkConversation([withResults, user("hi")])?.status, 413);
});

// --- body reading ---------------------------------------------------------

function jsonRequest(body: string, headers: Record<string, string> = {}): Request {
  return new Request("https://x.test/api/chat", { method: "POST", body, headers });
}

test("a well-formed body is parsed", async () => {
  const result = await readBoundedJson(jsonRequest('{"messages":[]}'));
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.value, { messages: [] });
});

test("invalid JSON is a 400, not a crash", async () => {
  const result = await readBoundedJson(jsonRequest("{not json"));
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.failure.status, 400);
});

test("a lying Content-Length does not get the body past the limit", async () => {
  // Declared small, actually huge: the real length has to be checked too.
  const huge = JSON.stringify({ messages: "x".repeat(MAX_BODY_BYTES + 100) });
  const result = await readBoundedJson(jsonRequest(huge, { "content-length": "10" }));
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.failure.status, 413);
});

test("an absurd declared length is refused without buffering the body", async () => {
  const result = await readBoundedJson(
    jsonRequest("{}", { "content-length": String(MAX_BODY_BYTES * 10 + 1) }),
  );
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.failure.status, 413);
});

test("a merely-oversized body is still read before being rejected", async () => {
  // Draining it keeps the keep-alive connection usable; abandoning the body
  // mid-flight makes the client's *next* request fail with ECONNRESET.
  const body = JSON.stringify({ m: "x".repeat(MAX_BODY_BYTES + 100) });
  const request = jsonRequest(body, { "content-length": String(body.length) });

  const result = await readBoundedJson(request);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.failure.status, 413);
  assert.equal(request.bodyUsed, true, "body should have been consumed");
});

test("multi-byte characters are measured in bytes, not characters", async () => {
  // Each of these is 4 bytes but counts as 2 JS characters, so a
  // character-based check would let roughly twice the payload through.
  const emoji = "🙂".repeat(MAX_BODY_BYTES / 4);
  const result = await readBoundedJson(jsonRequest(JSON.stringify({ m: emoji })));
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.failure.status, 413);
});

// --- rate limiting --------------------------------------------------------

const RULES: Rule[] = [
  { name: "burst", limit: 3, windowMs: 1000 },
  { name: "sustained", limit: 5, windowMs: 10_000 },
];

test("requests are allowed up to the burst limit, then refused", () => {
  const store = new MemoryStore();
  const now = 1_000_000;

  for (let i = 0; i < 3; i++) {
    const decision = checkRateLimit("user-a", { rules: RULES, store, now });
    assert.equal(decision.allowed, true, `request ${i + 1} should be allowed`);
  }

  const blocked = checkRateLimit("user-a", { rules: RULES, store, now });
  assert.equal(blocked.allowed, false);
  assert.equal(!blocked.allowed && blocked.rule.name, "burst");
  assert.equal(!blocked.allowed && blocked.retryAfterSeconds, 1);
});

test("a refused request does not consume quota", () => {
  const store = new MemoryStore();
  const now = 1_000_000;
  for (let i = 0; i < 3; i++) checkRateLimit("user-a", { rules: RULES, store, now });

  // Hammering while blocked must not push the reset further out, or a
  // retrying client would lock itself out forever.
  for (let i = 0; i < 10; i++) checkRateLimit("user-a", { rules: RULES, store, now });

  const afterWindow = checkRateLimit("user-a", { rules: RULES, store, now: now + 1001 });
  assert.equal(afterWindow.allowed, true);
});

test("the sustained window still applies after the burst window rolls over", () => {
  const store = new MemoryStore();
  let now = 1_000_000;

  // 5 requests spread across burst windows: within burst, at the sustained cap.
  for (let i = 0; i < 5; i++) {
    assert.equal(checkRateLimit("user-a", { rules: RULES, store, now }).allowed, true);
    now += 1100;
  }

  const blocked = checkRateLimit("user-a", { rules: RULES, store, now });
  assert.equal(blocked.allowed, false);
  assert.equal(!blocked.allowed && blocked.rule.name, "sustained");
});

test("limits are per caller", () => {
  const store = new MemoryStore();
  const now = 1_000_000;
  for (let i = 0; i < 3; i++) checkRateLimit("user-a", { rules: RULES, store, now });

  assert.equal(checkRateLimit("user-a", { rules: RULES, store, now }).allowed, false);
  assert.equal(checkRateLimit("user-b", { rules: RULES, store, now }).allowed, true);
});

test("expired counters are evicted rather than accumulating", () => {
  const store = new MemoryStore();
  for (let i = 0; i < 50; i++) {
    checkRateLimit(`user-${i}`, { rules: RULES, store, now: 1_000_000 });
  }
  assert.ok(store.size > 0);

  // Long past every window: a fresh call sees empty counters.
  const later = checkRateLimit("user-0", { rules: RULES, store, now: 2_000_000 });
  assert.equal(later.allowed, true);
  assert.equal(later.allowed && later.remaining, RULES[0].limit - 1);
});

test("the authenticated subject is preferred over the client IP", () => {
  const request = new Request("https://x.test", {
    headers: { "x-forwarded-for": "203.0.113.9, 70.41.3.18" },
  });

  assert.equal(rateLimitKey("user-42", request), "sub:user-42");
  // Falls back to the first hop, which is the client in a standard chain.
  assert.equal(rateLimitKey(null, request), "ip:203.0.113.9");
  assert.equal(rateLimitKey(null, new Request("https://x.test")), "ip:unknown");
});

test("a refusal carries Retry-After so a client knows when to come back", () => {
  const store = new MemoryStore();
  const now = Date.now();
  for (let i = 0; i < 3; i++) checkRateLimit("user-a", { rules: RULES, store, now });

  const blocked = checkRateLimit("user-a", { rules: RULES, store, now });
  const headers = rateLimitHeaders(blocked);
  assert.equal(headers["Retry-After"], "1");
  assert.equal(headers["RateLimit-Remaining"], "0");
  assert.equal(headers["RateLimit-Limit"], "3");
});
