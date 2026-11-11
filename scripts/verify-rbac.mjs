/**
 * End-to-end check of role-based permission control, against a real local
 * OIDC issuer and a mock Anthropic endpoint.
 *
 * Mints tokens with different `roles` claims and drives the running app over
 * HTTP, proving what a unit test over lib/rbac.ts alone cannot: that the
 * permission is actually enforced at the route, for both directions - a role
 * granting access it should not need, and one denying access it should have.
 *
 * Usage: node scripts/verify-rbac.mjs
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const ISSUER_PORT = 3139;
const APP_PORT = 3140;
const UPSTREAM_PORT = 3141;
const ISSUER = `http://localhost:${ISSUER_PORT}`;
const BASE = `http://localhost:${APP_PORT}`;
const AUDIENCE = "https://api.mini.example";

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

/** A minimal stand-in model endpoint, so a permitted chat call reaches 200. */
const upstream = createServer((req, res) => {
  req.on("data", () => {});
  req.on("end", () => {
    const frames = [
      { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "mock", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
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

const mint = (sub, roles) => {
  const now = Math.floor(Date.now() / 1000);
  let jwt = new SignJWT(roles ? { roles } : {})
    .setProtectedHeader({ alg: "RS256", kid: "local-1" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(sub)
    .setIssuedAt(now)
    .setExpirationTime(now + 300);
  return jwt.sign(privateKey);
};

const dbPath = join(mkdtempSync(join(tmpdir(), "mini-rbac-")), "verify.db");
const nextBin = fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url));

const app = spawn(process.execPath, [nextBin, "start", "-p", String(APP_PORT)], {
  env: {
    ...process.env,
    NODE_ENV: "production",
    MEMORY_DB_PATH: dbPath,
    OIDC_ISSUER: ISSUER,
    OIDC_AUDIENCE: AUDIENCE,
    ANTHROPIC_API_KEY: "sk-ant-dummy-for-rbac-test",
    ANTHROPIC_BASE_URL: `http://localhost:${UPSTREAM_PORT}`,
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

async function conversation(token, id, as) {
  const params = new URLSearchParams({ id, ...(as ? { as } : {}) });
  return fetch(`${BASE}/api/conversation?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function adminStats(token) {
  return fetch(`${BASE}/api/admin/stats`, { headers: { Authorization: `Bearer ${token}` } });
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

  const plainUser = await mint("user-plain", undefined);
  const readonlyUser = await mint("user-readonly", ["readonly"]);
  const adminUser = await mint("user-admin", ["admin"]);
  const otherPlainUser = await mint("user-other", undefined);

  // 1. No roles claim at all still gets ordinary chat access.
  let r = await chat(plainUser, "c-plain");
  check("a token with no roles claim can send a chat message", r.status === 200, `status ${r.status}`);

  // 2. ...and can read their own history.
  r = await conversation(plainUser, "c-plain");
  check("a token with no roles claim can read their own conversation", r.status === 200, `status ${r.status}`);

  // 3. readonly is denied the write path.
  r = await chat(readonlyUser, "c-readonly");
  const body3 = await r.json();
  check(
    "a readonly role is denied sending a chat message",
    r.status === 403 && /chat:send/.test(body3.error ?? ""),
    `status ${r.status}: ${body3.error}`,
  );

  // 4. ...but keeps the read path.
  r = await conversation(readonlyUser, "c-readonly");
  check("a readonly role can still read conversations", r.status === 200, `status ${r.status}`);

  // 5. readonly is denied the admin surface.
  r = await adminStats(readonlyUser);
  check("a readonly role is denied admin stats", r.status === 403, `status ${r.status}`);

  // 6. admin reaches the admin surface, and it returns real data.
  r = await adminStats(adminUser);
  const stats = await r.json();
  check(
    "an admin role can read admin stats, and gets a real shape back",
    r.status === 200 && typeof stats?.cache?.entries === "number",
    `status ${r.status}: ${JSON.stringify(stats)}`,
  );

  // 7. admin still keeps ordinary chat access - elevation is additive.
  r = await chat(adminUser, "c-admin");
  check("an admin role can still send chat messages", r.status === 200, `status ${r.status}`);

  // 8. Set up data owned by one ordinary user...
  await chat(plainUser, "shared-convo", "a message only user-plain should normally read");

  // 9. ...a different ordinary user cannot read it via impersonation.
  r = await conversation(otherPlainUser, "shared-convo", "sub:user-plain");
  check(
    "a non-admin cannot read another user's conversation via ?as=",
    r.status === 403,
    `status ${r.status}`,
  );

  // 10. ...but an admin can, and the content is really there.
  r = await conversation(adminUser, "shared-convo", "sub:user-plain");
  const impersonated = await r.json();
  check(
    "an admin can read another user's conversation via ?as=, and sees real content",
    r.status === 200 &&
      JSON.stringify(impersonated.turns ?? []).includes("a message only user-plain"),
    `status ${r.status}: ${JSON.stringify(impersonated).slice(0, 140)}`,
  );

  // 11. A malformed owner key is rejected before it reaches the database.
  r = await conversation(adminUser, "shared-convo", "../../etc/passwd");
  check("a malformed ?as= value is rejected", r.status === 400, `status ${r.status}`);

  // 12. An admin's own unrelated conversation is unaffected by all of this.
  r = await conversation(adminUser, "c-admin");
  check("an admin reading their own conversation is unaffected", r.status === 200, `status ${r.status}`);
} finally {
  app.kill();
  issuer.close();
  upstream.close();
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
