/**
 * End-to-end check that /api/metrics reflects real traffic, not just that
 * the counters exist. Drives chat, cache, auth-failure, rate-limit, and
 * admin paths over real HTTP, then reads the exposition text back and
 * checks the numbers actually moved.
 *
 * Usage: node scripts/verify-metrics.mjs
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const ISSUER_PORT = 3142;
const APP_PORT = 3143;
const UPSTREAM_PORT = 3144;
const ISSUER = `http://localhost:${ISSUER_PORT}`;
const BASE = `http://localhost:${APP_PORT}`;
const AUDIENCE = "https://api.mini.example";
const METRICS_TOKEN = "metrics-secret-for-this-run";

for (const port of [ISSUER_PORT, APP_PORT, UPSTREAM_PORT]) {
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

const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
const jwk = { ...(await exportJWK(publicKey)), kid: "local-1", alg: "RS256", use: "sig" };

const issuer = createServer((req, res) => {
  const routes = {
    "/.well-known/openid-configuration": {
      issuer: ISSUER,
      jwks_uri: `${ISSUER}/jwks.json`,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
    },
    "/jwks.json": { keys: [jwk] },
  };
  const body = routes[req.url];
  res.writeHead(body ? 200 : 404, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body ?? { error: "not_found" }));
});
await new Promise((r) => issuer.listen(ISSUER_PORT, r));

const upstream = createServer((req, res) => {
  req.on("data", () => {});
  req.on("end", () => {
    const frames = [
      { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "mock-model", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 50, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "a metered answer" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 9 } },
      { type: "message_stop" },
    ];
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    for (const f of frames) res.write(`event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`);
    res.end();
  });
});
await new Promise((r) => upstream.listen(UPSTREAM_PORT, r));

const mint = (sub, roles) => {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(roles ? { roles } : {})
    .setProtectedHeader({ alg: "RS256", kid: "local-1" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(sub)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(privateKey);
};

const dbPath = join(mkdtempSync(join(tmpdir(), "mini-metrics-")), "verify.db");
const nextBin = fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url));

const app = spawn(process.execPath, [nextBin, "start", "-p", String(APP_PORT)], {
  env: {
    ...process.env,
    NODE_ENV: "production",
    MEMORY_DB_PATH: dbPath,
    OIDC_ISSUER: ISSUER,
    OIDC_AUDIENCE: AUDIENCE,
    ANTHROPIC_API_KEY: "sk-ant-dummy-for-metrics-test",
    ANTHROPIC_BASE_URL: `http://localhost:${UPSTREAM_PORT}`,
    METRICS_TOKEN,
  },
  stdio: "ignore",
});

const results = [];
function check(label, pass, detail) {
  results.push(pass);
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? `\n      ${detail}` : ""}`);
}

async function chat(token, conversationId, message = "hello") {
  return fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ conversationId, message }),
  });
}

async function scrape(token) {
  return fetch(`${BASE}/api/metrics`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

try {
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(BASE);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  // --- the endpoint's own access control ----------------------------------
  let r = await scrape();
  check("no token is rejected", r.status === 401, `status ${r.status}`);

  r = await scrape("wrong-token");
  check("the wrong token is rejected", r.status === 401, `status ${r.status}`);

  r = await scrape(METRICS_TOKEN);
  check(
    "the right token is accepted, with the Prometheus content type",
    r.status === 200 && (r.headers.get("content-type") ?? "").startsWith("text/plain"),
    `status ${r.status}, content-type ${r.headers.get("content-type")}`,
  );

  // --- generate real traffic -----------------------------------------------
  const plainUser = await mint("user-plain", undefined);
  const readonlyUser = await mint("user-readonly", ["readonly"]);
  const adminUser = await mint("user-admin", ["admin"]);

  await chat(plainUser, "c1", "what is the borrow checker"); // cold -> miss
  await chat(plainUser, "c2", "what is the borrow checker"); // repeat -> hit
  await chat(readonlyUser, "c3", "hello"); // denied -> auth failure
  await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  }); // no Authorization header at all -> 401 under "no_token"
  await fetch(`${BASE}/api/admin/stats`, { headers: { Authorization: `Bearer ${adminUser}` } });

  // Flood past the burst limit to produce a rate-limit rejection.
  let limited = false;
  for (let i = 0; i < 20 && !limited; i++) {
    const response = await chat(plainUser, "flood", `ping ${i}`);
    await response.text().catch(() => {});
    if (response.status === 429) limited = true;
  }
  check("enough traffic was generated to trip the rate limiter", limited, "saw a 429");

  // --- read it back ----------------------------------------------------------
  const body = await (await scrape(METRICS_TOKEN)).text();

  check(
    "a cache miss was recorded",
    /mini_cache_lookups_total\{result="miss"\} [1-9]/.test(body),
    body.match(/mini_cache_lookups_total\{result="miss"\} \d+/)?.[0] ?? "not found",
  );
  check(
    "a cache hit was recorded",
    /mini_cache_lookups_total\{result="hit"\} [1-9]/.test(body),
    body.match(/mini_cache_lookups_total\{result="hit"\} \d+/)?.[0] ?? "not found",
  );
  check(
    "a successful chat outcome was recorded",
    /mini_chat_outcomes_total\{outcome="ok"\} [1-9]/.test(body),
    body.match(/mini_chat_outcomes_total\{outcome="ok"\} \d+/)?.[0] ?? "not found",
  );
  check(
    "a cached chat outcome was recorded",
    /mini_chat_outcomes_total\{outcome="cached"\} [1-9]/.test(body),
    body.match(/mini_chat_outcomes_total\{outcome="cached"\} \d+/)?.[0] ?? "not found",
  );
  check(
    "tokens billed by the mock model were recorded, attributed to its own model id",
    /mini_llm_tokens_total\{model="mock-model",direction="input"\} [1-9]/.test(body) &&
      /mini_llm_tokens_total\{model="mock-model",direction="output"\} [1-9]/.test(body),
    [...body.matchAll(/mini_llm_tokens_total\{[^}]+\} \d+/g)].map((m) => m[0]).join(" | ") ||
      "not found",
  );
  check(
    "a readonly role's denied chat attempt was recorded by reason",
    /mini_auth_failures_total\{reason="forbidden:chat:send"\} [1-9]/.test(body),
    body.match(/mini_auth_failures_total\{reason="forbidden:chat:send"\} \d+/)?.[0] ?? "not found",
  );
  check(
    "a missing-token request was recorded under no_token",
    /mini_auth_failures_total\{reason="no_token"\} [1-9]/.test(body),
    body.match(/mini_auth_failures_total\{reason="no_token"\} \d+/)?.[0] ?? "not found",
  );
  check(
    "the rate limiter rejection was recorded",
    /mini_rate_limit_rejections_total\{rule="burst"\} [1-9]/.test(body),
    body.match(/mini_rate_limit_rejections_total\{rule="burst"\} \d+/)?.[0] ?? "not found",
  );
  check(
    "per-route HTTP request counts cover every route hit, including admin",
    /mini_http_requests_total\{method="POST",route="\/api\/chat",status="200"\}/.test(body) &&
      /mini_http_requests_total\{method="GET",route="\/api\/admin\/stats",status="200"\}/.test(body),
    [...body.matchAll(/mini_http_requests_total\{[^}]+\} \d+/g)].slice(0, 6).map((m) => m[0]).join(" | "),
  );
  check(
    "the in-flight gauge settled back to zero once every request finished",
    /^mini_chat_in_flight 0$/m.test(body),
    body.match(/^mini_chat_in_flight \S+$/m)?.[0] ?? "not found",
  );
  check(
    "default Node process metrics are present alongside the app's own",
    /^mini_process_cpu_user_seconds_total /m.test(body),
    "present",
  );
} finally {
  app.kill();
  issuer.close();
  upstream.close();
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
