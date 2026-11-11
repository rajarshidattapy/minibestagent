/**
 * Drives the guardrails against the running app over HTTP.
 * Usage: node scripts/verify-guardrails.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = 3133;
const BASE = `http://localhost:${PORT}`;

const inUse = await fetch(BASE, { signal: AbortSignal.timeout(1000) }).then(
  () => true,
  () => false,
);
if (inUse) {
  console.error(`Port ${PORT} is already in use. Stop that process and re-run.`);
  process.exit(1);
}

const nextBin = fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url));
const app = spawn(process.execPath, [nextBin, "start", "-p", String(PORT)], {
  env: {
    ...process.env,
    NODE_ENV: "production",
    // A throwaway store, so runs never inherit another run's conversations.
    MEMORY_DB_PATH: join(mkdtempSync(join(tmpdir(), "mini-guard-")), "verify.db"),
    AUTH_OPTIONAL: "true",
    ANTHROPIC_API_KEY: "sk-ant-dummy-for-guardrail-test",
  },
  stdio: "ignore",
});

const results = [];
function check(label, pass, detail) {
  results.push(pass);
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? `\n      ${detail}` : ""}`);
}

const post = (body, headers = {}) =>
  fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

try {
  for (let i = 0; i < 40; i++) {
    try {
      await fetch(BASE);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  // --- security headers ---------------------------------------------------
  const page = await fetch(BASE);
  const csp = page.headers.get("content-security-policy") ?? "";
  check("CSP blocks framing and object embedding", csp.includes("frame-ancestors 'none'") && csp.includes("object-src 'none'"), csp.slice(0, 110) + "...");
  check("X-Content-Type-Options is nosniff", page.headers.get("x-content-type-options") === "nosniff");
  check("Referrer-Policy is set", page.headers.get("referrer-policy") === "strict-origin-when-cross-origin");
  check("framework version is not advertised", page.headers.get("x-powered-by") === null);

  // --- input limits -------------------------------------------------------
  const oversized = await post({ conversationId: "probe", message: "x".repeat(40_000) });
  check("an oversized message is refused", oversized.status === 413, `status ${oversized.status}: ${(await oversized.text()).slice(0, 90)}`);

  const bigBody = await post(
    JSON.stringify({ conversationId: "probe", message: "x".repeat(1_200_000) }),
  );
  check("an oversized body is refused", bigBody.status === 413, `status ${bigBody.status}`);

  const empty = await post({ conversationId: "probe", message: "   " });
  check("an empty message is refused", empty.status === 400, `status ${empty.status}`);

  const badId = await post({ conversationId: "../../etc/passwd", message: "hi" });
  check("a malformed conversation id is refused", badId.status === 400, `status ${badId.status}`);

  // Someone else's conversation id must not be readable.
  const foreign = await fetch(`${BASE}/api/conversation?id=not%20an%20id`);
  check("a malformed id is refused on read too", foreign.status === 400, `status ${foreign.status}`);

  // --- rate limiting ------------------------------------------------------
  // Burst limit is 15/min; the 16th from the same caller must be refused.
  let limited = null;
  for (let i = 0; i < 18; i++) {
    const response = await post({ conversationId: "probe", message: `ping ${i}` });
    // Drain so the connection is not left open.
    await response.text();
    if (response.status === 429) {
      limited = response;
      break;
    }
  }
  check(
    "a burst of requests is rate limited",
    limited !== null,
    limited
      ? `Retry-After: ${limited.headers.get("retry-after")}s, RateLimit-Limit: ${limited.headers.get("ratelimit-limit")}`
      : "never hit 429 in 18 requests",
  );
} finally {
  app.kill();
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
