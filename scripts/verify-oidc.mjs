/**
 * End-to-end check of the auth gate against a real (local) OIDC issuer.
 *
 * Stands up a throwaway identity provider that publishes a discovery document
 * and a JWKS, mints tokens with its key, then drives the running app over HTTP.
 * This exercises the paths the unit tests inject around: OIDC discovery,
 * remote JWKS fetching, and `kid` lookup.
 *
 * Usage: node scripts/verify-oidc.mjs
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const ISSUER_PORT = 3131;
const APP_PORT = 3132;
const ISSUER = `http://localhost:${ISSUER_PORT}`;
const AUDIENCE = "https://api.mini.example";

// A server left over from a previous run would answer with a stale cached
// JWKS and quietly fail every signature check, so refuse to start.
for (const port of [ISSUER_PORT, APP_PORT]) {
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

const mint = (claims = {}) => {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: claims.kid ?? "local-1" })
    .setIssuer(claims.iss ?? ISSUER)
    .setAudience(claims.aud ?? AUDIENCE)
    .setSubject(claims.sub ?? "user-42")
    .setIssuedAt(now)
    .setExpirationTime(claims.exp ?? now + 300)
    .sign(privateKey);
};

// Invoke Next's entry point with the current node binary: no npx, no shell,
// and nothing platform-specific.
const nextBin = fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url));

const app = spawn(
  process.execPath,
  [nextBin, "start", "-p", String(APP_PORT)],
  {
    env: {
      ...process.env,
      NODE_ENV: "production",
      // A throwaway store, so runs never inherit another run's conversations.
      MEMORY_DB_PATH: join(mkdtempSync(join(tmpdir(), "mini-oidc-")), "verify.db"),
      OIDC_ISSUER: ISSUER,
      OIDC_AUDIENCE: AUDIENCE,
      ANTHROPIC_API_KEY: "sk-ant-dummy-for-auth-test",
    },
    stdio: "ignore",
  },
);

async function waitForApp() {
  for (let i = 0; i < 40; i++) {
    try {
      await fetch(`http://localhost:${APP_PORT}/`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error("app did not start");
}

async function probe(label, token, expectedStatus, conversationId = "probe") {
  const response = await fetch(`http://localhost:${APP_PORT}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ conversationId, message: "hi" }),
  });

  const body = await response.text();
  const pass = response.status === expectedStatus;
  results.push(pass);
  console.log(
    `${pass ? "PASS" : "FAIL"}  ${label}\n      want ${expectedStatus}, got ${response.status}` +
      `${response.headers.get("www-authenticate") ? `\n      challenge: ${response.headers.get("www-authenticate")}` : ""}` +
      `\n      ${body.trim().slice(0, 150).replace(/\n/g, " ")}`,
  );
}

const results = [];
try {
  await waitForApp();

  // 200 means it cleared the auth gate: the stream then carries an API-key
  // error frame, because the Anthropic key here is a dummy.
  await probe("valid token is accepted", await mint(), 200);
  await probe("no token is rejected", null, 401);
  await probe("expired token is rejected", await mint({ exp: Math.floor(Date.now() / 1000) - 600 }), 401);
  await probe("wrong issuer is rejected", await mint({ iss: "https://evil.example.com" }), 401);
  await probe("wrong audience is rejected", await mint({ aud: "https://other.example" }), 401);
  await probe("unknown signing key is rejected", await mint({ kid: "does-not-exist" }), 401);

  // One user's conversation must not be reachable by another, even with a
  // perfectly valid token - the id alone is not authorisation.
  await probe("user A opens a conversation", await mint({ sub: "user-a" }), 200, "shared-id");
  await probe(
    "user B cannot reach user A's conversation",
    await mint({ sub: "user-b" }),
    404,
    "shared-id",
  );
} finally {
  app.kill();
  issuer.close();
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
