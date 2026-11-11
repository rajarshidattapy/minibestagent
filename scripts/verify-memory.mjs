/**
 * End-to-end check of long-term memory, using the brief's own question shapes.
 *
 * Seeds a store with conversations dated days in the past, starts the app
 * against it, and asks the questions from the task description. Asserts the
 * server recalls the right turns and hands them to the model - the headline
 * behaviour, proven over HTTP rather than in a unit test.
 *
 * Needs no Anthropic key: recall happens before the model is called, and the
 * `recall` frame arrives ahead of the upstream error.
 *
 * Usage: node scripts/verify-memory.mjs
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = 3134;
const BASE = `http://localhost:${PORT}`;

const inUse = await fetch(BASE, { signal: AbortSignal.timeout(1000) }).then(
  () => true,
  () => false,
);
if (inUse) {
  console.error(`Port ${PORT} is already in use. Stop that process and re-run.`);
  process.exit(1);
}

const dbPath = join(mkdtempSync(join(tmpdir(), "mini-memory-")), "verify.db");
process.env.MEMORY_DB_PATH = dbPath;

const store = await import("../lib/memory/store.ts");

const DAY = 86_400_000;
const OWNER = "anon:11111111-1111-1111-1111-111111111111";
const COOKIE = `mini_owner=11111111-1111-1111-1111-111111111111`;

const daysAgo = (n, hour = 10) => {
  const d = new Date(Date.now() - n * DAY);
  d.setHours(hour, 0, 0, 0);
  return d;
};

function seed(conversationId, role, text, at) {
  store.appendTurn(
    { conversationId, role, ts: at.getTime(), text, content: text },
    OWNER,
  );
}

// Two past conversations, in separate threads, several days apart.
const crmDay = daysAgo(5);
seed("crm", "user", "shortlist 5 CRM tools for a 20-person sales team", crmDay);
seed(
  "crm",
  "assistant",
  "HubSpot, Pipedrive, Close, Attio and Folk. Pipedrive starts at $24/seat/month.",
  daysAgo(5, 11),
);

const pgDay = daysAgo(8);
seed("pg", "user", "what are my options for Postgres hosting?", pgDay);
seed("pg", "assistant", "Neon, Supabase and Railway are the main managed options.", daysAgo(8, 11));

seed("noise", "user", "how do I bake sourdough bread?", daysAgo(6));

const monthDay = crmDay.toLocaleDateString("en-GB", { day: "numeric", month: "long" });

/**
 * A stand-in for the Anthropic API that records the request body and replies
 * with a minimal valid stream. Without this the end-to-end runs never got
 * past the auth error, so nothing ever checked what was actually sent - which
 * is exactly how a duplicated user message went unnoticed.
 */
const UPSTREAM_PORT = 3136;
const captured = [];

const upstream = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    try {
      captured.push(JSON.parse(raw));
    } catch {
      captured.push(null);
    }

    const frames = [
      { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "mock", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ];

    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    for (const frame of frames) {
      res.write(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
    }
    res.end();
  });
});
await new Promise((r) => upstream.listen(UPSTREAM_PORT, r));

const nextBin = fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url));
const app = spawn(process.execPath, [nextBin, "start", "-p", String(PORT)], {
  env: {
    ...process.env,
    NODE_ENV: "production",
    MEMORY_DB_PATH: dbPath,
    AUTH_OPTIONAL: "true",
    ANTHROPIC_API_KEY: "sk-ant-dummy-for-memory-test",
    // Point the SDK at the recorder above instead of the real API.
    ANTHROPIC_BASE_URL: `http://localhost:${UPSTREAM_PORT}`,
  },
  stdio: "ignore",
});

const results = [];
function check(label, pass, detail) {
  results.push(pass);
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? `\n      ${detail}` : ""}`);
}

/** Send a question and collect the NDJSON frames the server emits. */
async function ask(message, conversationId = "live") {
  const response = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: COOKIE },
    body: JSON.stringify({ conversationId, message }),
  });
  const body = await response.text();
  return body
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

try {
  for (let i = 0; i < 40; i++) {
    try {
      await fetch(BASE);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  // 1. The CRM question from the brief, by date.
  let frames = await ask(`On ${monthDay} we shortlisted 5 CRM tools. Has any of them changed pricing since?`);
  let recall = frames.find((f) => f.type === "recall");
  check(
    `"on ${monthDay}" recalls that day's conversation`,
    Boolean(recall) && recall.count >= 2,
    recall ? `recalled ${recall.count} turns from ${recall.since.slice(0, 10)}` : "no recall frame",
  );

  // 2. Topical recall with no date at all.
  frames = await ask("has Postgres hosting pricing changed since you told me?");
  recall = frames.find((f) => f.type === "recall");
  check(
    "a dateless follow-up still finds the right past thread",
    Boolean(recall) && recall.count >= 1,
    recall ? `recalled ${recall.count} turns` : "no recall frame",
  );

  // 3. A plain question must not drag in history.
  frames = await ask("what is 2 + 2?");
  check(
    "an ordinary question triggers no recall",
    !frames.some((f) => f.type === "recall"),
    frames.some((f) => f.type === "recall") ? "unexpected recall frame" : "no recall frame, as expected",
  );

  // 4. Memory is per owner: a different cookie sees none of it.
  const other = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: "mini_owner=22222222-2222-2222-2222-222222222222",
    },
    body: JSON.stringify({ conversationId: "stranger", message: "has Postgres hosting pricing changed?" }),
  });
  const strangerFrames = (await other.text())
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  check(
    "another user recalls nothing of this history",
    !strangerFrames.some((f) => f.type === "recall"),
    "no recall frame for a different owner",
  );

  // 5. The transcript survives a reload.
  const transcript = await fetch(`${BASE}/api/conversation?id=crm`, {
    headers: { Cookie: COOKIE },
  }).then((r) => r.json());
  check(
    "a past conversation reloads from the server",
    transcript.turns?.length === 2 && transcript.turns[0].text.includes("CRM"),
    `${transcript.turns?.length ?? 0} turns returned`,
  );

  // `notice` is a client-side warning, never persisted. When the two shared
  // one field, every reloaded answer rendered twice - once as the reply and
  // again as a warning underneath it.
  check(
    "reloaded turns carry no notice field",
    (transcript.turns ?? []).every((t) => t.notice === undefined),
    "no stored turn doubles as a warning",
  );
  // --- 6. what actually reaches the model --------------------------------
  captured.length = 0;
  // A question that genuinely reaches back, so recall is expected here.
  await ask(`on ${monthDay} we shortlisted CRM tools - is that still right?`, "shape-check");
  const body = captured.at(-1);

  check("the request reached the model", Boolean(body), body ? "captured" : "nothing captured");

  if (body) {
    const asked = body.messages.filter(
      (m) => m.role === "user" && JSON.stringify(m.content).includes("we shortlisted CRM tools"),
    );
    check(
      "the question is sent exactly once",
      asked.length === 1,
      `found ${asked.length} copies of the question`,
    );

    const roles = body.messages.map((m) => m.role);
    const conversational = roles.filter((r) => r !== "system");
    const alternates = conversational.every((r, i) => i === 0 || r !== conversational[i - 1]);
    check("roles alternate", alternates && conversational[0] === "user", roles.join(" -> "));

    const last = body.messages.at(-1);
    check(
      "recall rides in a trailing system message",
      last.role === "system" && String(last.content).includes("earlier conversations"),
      `last message is ${last.role}`,
    );
  }

  // --- 7. a real second turn ---------------------------------------------
  captured.length = 0;
  await ask("and the second one?", "shape-check");
  const followUp = captured.at(-1);
  if (followUp) {
    const roles = followUp.messages.filter((m) => m.role !== "system").map((m) => m.role);
    check(
      "the stored answer makes the next turn alternate properly",
      roles.join(",") === "user,assistant,user",
      roles.join(" -> "),
    );
  }
  // --- 8. stopping mid-answer must not lose it ---------------------------
  // Pins the behaviour rather than a specific failure: whatever the runtime
  // does on disconnect, an answer that was paid for must reach the store.
  const abort = new AbortController();
  const inflight = fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: COOKIE },
    body: JSON.stringify({ conversationId: "aborted", message: "slow-please summarise this" }),
    signal: abort.signal,
  });

  try {
    const response = await inflight;
    // Take the first chunk, then walk away mid-answer.
    const reader = response.body.getReader();
    await reader.read();
    abort.abort();
  } catch {
    // An abort during read is the point of the exercise.
  }

  // Let the server finish the upstream stream and write the turn.
  await new Promise((r) => setTimeout(r, 1500));

  const afterAbort = await fetch(`${BASE}/api/conversation?id=aborted`, {
    headers: { Cookie: COOKIE },
  }).then((r) => r.json());
  const roles = (afterAbort.turns ?? []).map((t) => t.role);
  check(
    "an answer the user stopped reading is still remembered",
    roles.join(",") === "user,assistant",
    `stored: ${roles.join(" -> ") || "nothing"}`,
  );
} finally {
  app.kill();
  upstream.close();
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
