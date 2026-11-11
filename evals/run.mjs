/**
 * Eval harness: runs the corpus in evals/cases.ts against the real agent
 * pipeline over HTTP and grades the result.
 *
 * Two modes, chosen deliberately rather than auto-detected, so a real model
 * is never called by accident:
 *
 *   npm run eval       - structural mode (default, free, deterministic).
 *                        A mock Anthropic endpoint answers every call, so
 *                        only the parts of each case that do not depend on
 *                        what the model actually says are graded: did
 *                        recall fire, from the right day, across threads,
 *                        and not on a plain question. Content and
 *                        search-discipline checks report SKIPPED.
 *
 *   npm run eval:live  - calls the real Anthropic API (needs a real
 *                        ANTHROPIC_API_KEY already set in the environment -
 *                        this script will not invent one) and additionally
 *                        grades what the model actually said: does the
 *                        answer mention the recalled specifics, does it
 *                        search when it should and not when it shouldn't,
 *                        does it resist an injected instruction sitting in
 *                        recalled memory. This spends real money - a few
 *                        cents per run - which is exactly why it is not the
 *                        default.
 *
 * Usage: node evals/run.mjs
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

// A CLI flag rather than requiring `EVAL_LIVE=true node ...` - env-var-prefix
// syntax differs between POSIX shells and PowerShell, a flag does not.
const LIVE = process.env.EVAL_LIVE === "true" || process.argv.includes("--live");
const PORT = 3150;
const UPSTREAM_PORT = 3151;
const BASE = `http://localhost:${PORT}`;
const OWNER_COOKIE = `mini_owner=${randomUUID()}`;

if (LIVE && (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY.includes("dummy"))) {
  console.error(
    "EVAL_LIVE=true needs a real ANTHROPIC_API_KEY in the environment - refusing to " +
      "silently fall back to a mock while claiming to run live.",
  );
  process.exit(1);
}

for (const port of LIVE ? [PORT] : [PORT, UPSTREAM_PORT]) {
  const inUse = await fetch(`http://localhost:${port}/`, {
    signal: AbortSignal.timeout(1000),
  }).then(
    () => true,
    () => false,
  );
  if (inUse) {
    console.error(`Port ${port} is already in use. Stop that process and re-run.`);
    process.exit(1);
  }
}

const { buildCases } = await import("./cases.ts");
const {
  gradeMentionsAll,
  gradeMentionsNone,
  gradeRecall,
  gradeSearchUsage,
} = await import("./grade.ts");
const store = await import("../lib/memory/store.ts");

const dbPath = join(mkdtempSync(join(tmpdir(), "mini-eval-")), "eval.db");
store._resetForTests(dbPath);

const OWNER = `anon:${OWNER_COOKIE.split("=")[1]}`;
const cases = buildCases();

for (const evalCase of cases) {
  for (const turn of evalCase.seed) {
    store.appendTurn(
      {
        conversationId: turn.conversationId,
        role: turn.role,
        ts: turn.at.getTime(),
        text: turn.text,
        content: turn.text,
      },
      OWNER,
    );
  }
}

// --- a mock model for structural mode ---------------------------------------
let upstream;
if (!LIVE) {
  upstream = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      const frames = [
        {
          type: "message_start",
          message: {
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "mock-model",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 0 },
          },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "(structural mode - no real answer was generated)" },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 5 },
        },
        { type: "message_stop" },
      ];
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      for (const f of frames) res.write(`event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`);
      res.end();
    });
  });
  await new Promise((r) => upstream.listen(UPSTREAM_PORT, r));
}

const nextBin = fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url));
const app = spawn(process.execPath, [nextBin, "start", "-p", String(PORT)], {
  env: {
    ...process.env,
    NODE_ENV: "production",
    MEMORY_DB_PATH: dbPath,
    AUTH_OPTIONAL: "true",
    LLM_CACHE: "off", // every case must reach the model/mock fresh, not a cached neighbour
    ...(LIVE ? {} : { ANTHROPIC_BASE_URL: `http://localhost:${UPSTREAM_PORT}` }),
    ...(LIVE ? {} : { ANTHROPIC_API_KEY: "sk-ant-dummy-for-structural-eval" }),
  },
  stdio: "ignore",
});

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

async function ask(conversationId, message) {
  const response = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: OWNER_COOKIE },
    body: JSON.stringify({ conversationId, message }),
  });
  const body = await response.text();
  const frames = body
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const done = frames.find((f) => f.type === "done");
  const text = frames
    .filter((f) => f.type === "text")
    .map((f) => f.text)
    .join("");
  return { frames, content: done?.content ?? [], text };
}

/** One line per expectation: ✔/✖/— (skip), the label, and why. */
function report(label, verdict) {
  const mark = verdict === "skip" ? "—" : verdict.pass ? "✔" : "✖";
  const detail = verdict === "skip" ? "skipped: no live model run" : verdict.detail;
  console.log(`    ${mark} ${label} - ${detail}`);
  return verdict === "skip" ? "skip" : verdict.pass ? "pass" : "fail";
}

const tally = { pass: 0, fail: 0, skip: 0 };

try {
  await waitForApp();
  console.log(`Mode: ${LIVE ? "LIVE (real model, spends money)" : "structural (mock model, free)"}\n`);

  for (const evalCase of cases) {
    console.log(`${evalCase.id}`);
    console.log(`  ${evalCase.description}`);

    const { frames, content, text } = await ask(evalCase.askConversationId, evalCase.question);

    const outcomes = [report("recall", gradeRecall(frames, evalCase.expectRecall))];

    if (evalCase.live) {
      if (evalCase.live.mustSearch !== undefined) {
        outcomes.push(
          report(
            "search discipline",
            LIVE ? gradeSearchUsage(content, evalCase.live.mustSearch) : "skip",
          ),
        );
      }
      if (evalCase.live.mustMentionAllOf) {
        outcomes.push(
          report(
            "answer mentions the right specifics",
            LIVE ? gradeMentionsAll(text, evalCase.live.mustMentionAllOf) : "skip",
          ),
        );
      }
      if (evalCase.live.mustMentionNoneOf) {
        outcomes.push(
          report(
            "answer does not comply with an injected instruction",
            LIVE ? gradeMentionsNone(text, evalCase.live.mustMentionNoneOf) : "skip",
          ),
        );
      }
    }

    for (const outcome of outcomes) tally[outcome] += 1;
    console.log();
  }
} finally {
  app.kill();
  upstream?.close();
}

const total = tally.pass + tally.fail + tally.skip;
console.log(
  `${tally.pass}/${total} passed, ${tally.fail} failed, ${tally.skip} skipped` +
    (LIVE ? "" : " (run with EVAL_LIVE=true, and a real ANTHROPIC_API_KEY, to grade answer content)"),
);
process.exit(tally.fail > 0 ? 1 : 0);
