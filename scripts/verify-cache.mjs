/**
 * End-to-end check of the response cache.
 *
 * Counts calls reaching a stand-in Anthropic endpoint, so "it was cached"
 * means the model genuinely was not called - not merely that a frame said so.
 * Restarts the server mid-run to prove the cache is on disk, not in memory.
 *
 * Usage: node scripts/verify-cache.mjs
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = 3137;
const UPSTREAM_PORT = 3138;
const BASE = `http://localhost:${PORT}`;

for (const port of [PORT, UPSTREAM_PORT]) {
  const busy = await fetch(`http://localhost:${port}/`, {
    signal: AbortSignal.timeout(1000),
  }).then(
    () => true,
    () => false,
  );
  if (busy) {
    console.error(`Port ${port} is already in use. Stop that process and re-run.`);
    process.exit(1);
  }
}

let upstreamCalls = 0;

const upstream = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    upstreamCalls += 1;
    // No search blocks, so the entry gets the long TTL and cannot expire
    // underneath the test.
    const frames = [
      { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "mock", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "a cached-able answer" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ];
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    for (const f of frames) res.write(`event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`);
    res.end();
  });
});
await new Promise((r) => upstream.listen(UPSTREAM_PORT, r));

const dbPath = join(mkdtempSync(join(tmpdir(), "mini-cache-e2e-")), "verify.db");
const nextBin = fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url));

function startApp() {
  return spawn(process.execPath, [nextBin, "start", "-p", String(PORT)], {
    env: {
      ...process.env,
      NODE_ENV: "production",
      MEMORY_DB_PATH: dbPath,
      AUTH_OPTIONAL: "true",
      ANTHROPIC_API_KEY: "sk-ant-dummy-for-cache-test",
      ANTHROPIC_BASE_URL: `http://localhost:${UPSTREAM_PORT}`,
    },
    stdio: "ignore",
  });
}

async function waitForApp() {
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(BASE);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error("app did not start");
}

const results = [];
function check(label, pass, detail) {
  results.push(pass);
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? `\n      ${detail}` : ""}`);
}

const COOKIE_A = "mini_owner=11111111-1111-1111-1111-111111111111";
const COOKIE_B = "mini_owner=22222222-2222-2222-2222-222222222222";

/** Each call uses a fresh conversation, so the prompt is identical each time. */
async function ask(question, cookie = COOKIE_A) {
  const response = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ conversationId: crypto.randomUUID(), message: question }),
  });
  return (await response.text())
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

let app = startApp();
const QUESTION = "explain the borrow checker";

try {
  await waitForApp();

  // 1. Cold.
  upstreamCalls = 0;
  let frames = await ask(QUESTION);
  check(
    "a cold question calls the model",
    upstreamCalls === 1 && !frames.some((f) => f.type === "cached"),
    `${upstreamCalls} upstream call(s)`,
  );

  // 2. Warm - the real test is the call count, not the frame.
  upstreamCalls = 0;
  frames = await ask(QUESTION);
  check(
    "a repeat is served without calling the model",
    upstreamCalls === 0 && frames.some((f) => f.type === "cached"),
    `${upstreamCalls} upstream call(s), cached frame: ${frames.some((f) => f.type === "cached")}`,
  );

  // 3. The answer itself must survive the round trip.
  const text = frames.filter((f) => f.type === "text").map((f) => f.text).join("");
  check("the cached answer is returned intact", text === "a cached-able answer", JSON.stringify(text));

  // 4. A cache hit must still be written to memory, or the thread has a hole.
  const done = frames.find((f) => f.type === "done");
  check(
    "a cached turn is still recorded in the conversation",
    Boolean(done) && JSON.stringify(done.content).includes("cached-able"),
    done ? "done frame carries the answer" : "no done frame",
  );

  // 5. Another user must not be served it.
  upstreamCalls = 0;
  await ask(QUESTION, COOKIE_B);
  check(
    "another user does not get the cached answer",
    upstreamCalls === 1,
    `${upstreamCalls} upstream call(s) for a different owner`,
  );

  // 6. The headline requirement: survive a restart.
  app.kill();
  await new Promise((r) => setTimeout(r, 1500));
  app = startApp();
  await waitForApp();

  upstreamCalls = 0;
  frames = await ask(QUESTION);
  check(
    "the cache survives a restart",
    upstreamCalls === 0 && frames.some((f) => f.type === "cached"),
    `${upstreamCalls} upstream call(s) after restarting the server`,
  );

  // 7. A different question still reaches the model.
  upstreamCalls = 0;
  await ask("something else entirely");
  check("a new question still calls the model", upstreamCalls === 1, `${upstreamCalls} upstream call(s)`);
} finally {
  app.kill();
  upstream.close();
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
