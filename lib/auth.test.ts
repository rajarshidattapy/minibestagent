import { test, before } from "node:test";
import assert from "node:assert/strict";
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  type JWTVerifyGetKey,
  type CryptoKey,
} from "jose";
import {
  authMode,
  bearerToken,
  challengeHeader,
  readAuthConfig,
  verifyAccessToken,
  type AuthConfig,
} from "./auth.ts";

const ISSUER = "https://issuer.example.com";
const AUDIENCE = "https://api.mini.example";
const CONFIG: AuthConfig = { issuer: ISSUER, audience: AUDIENCE };

let privateKey: CryptoKey;
let publicJwk: JWK;
/** A second, unrelated key - used to forge a well-formed but untrusted token. */
let attackerKey: CryptoKey;
let getKey: JWTVerifyGetKey;

before(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: "test-key", alg: "RS256" };
  getKey = createLocalJWKSet({ keys: [publicJwk] });

  attackerKey = (await generateKeyPair("RS256", { extractable: true })).privateKey;
});

/** Mint a token that is valid unless a field is overridden. */
function mint(
  overrides: {
    issuer?: string;
    audience?: string;
    expiresAt?: number;
    notBefore?: number;
    key?: CryptoKey;
    omitExp?: boolean;
    omitSub?: boolean;
  } = {},
) {
  const now = Math.floor(Date.now() / 1000);
  let jwt = new SignJWT({ scope: "chat" })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(overrides.issuer ?? ISSUER)
    .setAudience(overrides.audience ?? AUDIENCE)
    .setIssuedAt(now);

  if (!overrides.omitSub) jwt = jwt.setSubject("user-42");
  if (!overrides.omitExp) jwt = jwt.setExpirationTime(overrides.expiresAt ?? now + 300);
  if (overrides.notBefore !== undefined) jwt = jwt.setNotBefore(overrides.notBefore);

  return jwt.sign(overrides.key ?? privateKey);
}

/** Assert that verification rejects, and hand back the error for inspection. */
async function expectRejected(token: string): Promise<{ code?: string }> {
  try {
    await verifyAccessToken(token, { config: CONFIG, getKey });
  } catch (err) {
    return err as { code?: string };
  }
  throw new assert.AssertionError({ message: "token was accepted but should have been rejected" });
}

// --- the happy path -------------------------------------------------------

test("a correctly signed, in-date token is accepted", async () => {
  const claims = await verifyAccessToken(await mint(), { config: CONFIG, getKey });
  assert.equal(claims.sub, "user-42");
  assert.equal(claims.iss, ISSUER);
  assert.equal(claims.scope, "chat");
});

// --- signature ------------------------------------------------------------

test("a token signed by an unrelated key is rejected", async () => {
  const err = await expectRejected(await mint({ key: attackerKey }));
  assert.equal(err.code, "ERR_JWS_SIGNATURE_VERIFICATION_FAILED");
});

test("a tampered payload is rejected", async () => {
  const [header, payload, signature] = (await mint()).split(".");
  const decoded = JSON.parse(Buffer.from(payload, "base64url").toString());
  decoded.sub = "admin";
  const forged = Buffer.from(JSON.stringify(decoded)).toString("base64url");

  const err = await expectRejected(`${header}.${forged}.${signature}`);
  assert.equal(err.code, "ERR_JWS_SIGNATURE_VERIFICATION_FAILED");
});

test('an "alg: none" token is rejected', async () => {
  // The classic forgery: strip the signature and declare the token unsigned.
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: ISSUER,
      aud: AUDIENCE,
      sub: "admin",
      exp: Math.floor(Date.now() / 1000) + 300,
    }),
  ).toString("base64url");

  await expectRejected(`${header}.${payload}.`);
});

test("an HS256 token signed with the public key as the secret is rejected", async () => {
  // Algorithm confusion: if HS* were allowed, anyone holding the issuer's
  // public JWKS could forge tokens with it as an HMAC secret.
  const secret = new TextEncoder().encode(JSON.stringify(publicJwk));
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256", kid: "test-key" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject("admin")
    .setExpirationTime(Math.floor(Date.now() / 1000) + 300)
    .sign(secret);

  const err = await expectRejected(token);
  assert.equal(err.code, "ERR_JOSE_ALG_NOT_ALLOWED");
});

// --- issuer and audience --------------------------------------------------

test("a token from the wrong issuer is rejected", async () => {
  const err = await expectRejected(await mint({ issuer: "https://evil.example.com" }));
  assert.equal(err.code, "ERR_JWT_CLAIM_VALIDATION_FAILED");
  assert.equal((err as { claim?: string }).claim, "iss");
});

test("a token for a different audience is rejected", async () => {
  // i.e. a valid token for another API behind the same issuer.
  const err = await expectRejected(await mint({ audience: "https://other-api.example" }));
  assert.equal(err.code, "ERR_JWT_CLAIM_VALIDATION_FAILED");
  assert.equal((err as { claim?: string }).claim, "aud");
});

// --- expiry ---------------------------------------------------------------

test("an expired token is rejected", async () => {
  const tenMinutesAgo = Math.floor(Date.now() / 1000) - 600;
  const err = await expectRejected(await mint({ expiresAt: tenMinutesAgo }));
  assert.equal(err.code, "ERR_JWT_EXPIRED");
});

test("a token with no expiry at all is rejected", async () => {
  // Otherwise "check the expiry" passes vacuously and the token never dies.
  const err = await expectRejected(await mint({ omitExp: true }));
  assert.equal(err.code, "ERR_JWT_CLAIM_VALIDATION_FAILED");
});

test("a token that is not yet valid is rejected", async () => {
  const inAnHour = Math.floor(Date.now() / 1000) + 3600;
  const err = await expectRejected(await mint({ notBefore: inAnHour }));
  assert.equal(err.code, "ERR_JWT_CLAIM_VALIDATION_FAILED");
});

test("expiry just inside the clock-skew tolerance is still accepted", async () => {
  const thirtySecondsAgo = Math.floor(Date.now() / 1000) - 30;
  const claims = await verifyAccessToken(await mint({ expiresAt: thirtySecondsAgo }), {
    config: CONFIG,
    getKey,
  });
  assert.equal(claims.sub, "user-42");
});

test("a token with no subject is rejected", async () => {
  const err = await expectRejected(await mint({ omitSub: true }));
  assert.equal(err.code, "ERR_JWT_CLAIM_VALIDATION_FAILED");
});

// --- header parsing -------------------------------------------------------

test("bearerToken parses the Authorization header, scheme case-insensitively", () => {
  const read = (value?: string) =>
    bearerToken(new Request("https://x.test", value ? { headers: { authorization: value } } : {}));

  assert.equal(read("Bearer abc.def.ghi"), "abc.def.ghi");
  assert.equal(read("bearer abc.def.ghi"), "abc.def.ghi");
  assert.equal(read("  Bearer   abc.def.ghi  "), "abc.def.ghi");
  assert.equal(read(), null);
  assert.equal(read("Basic dXNlcjpwYXNz"), null);
  assert.equal(read("Bearer"), null);
});

// --- configuration --------------------------------------------------------

test("authMode fails closed when configuration is incomplete", () => {
  const full = { OIDC_ISSUER: ISSUER, OIDC_AUDIENCE: AUDIENCE };

  assert.equal(authMode(full), "enforced");
  assert.equal(authMode({ ...full, NODE_ENV: "production" }), "enforced");

  // Unconfigured: convenient in dev, refused in production.
  assert.equal(authMode({}), "disabled");
  assert.equal(authMode({ NODE_ENV: "production" }), "misconfigured");

  // Half-configured is never allowed to serve traffic.
  assert.equal(authMode({ OIDC_ISSUER: ISSUER }), "misconfigured");
  assert.equal(authMode({ OIDC_AUDIENCE: AUDIENCE }), "misconfigured");
  assert.equal(
    authMode({ OIDC_ISSUER: ISSUER, NODE_ENV: "production", AUTH_OPTIONAL: "true" }),
    "misconfigured",
    "AUTH_OPTIONAL must not paper over a half-configured issuer",
  );

  // Running open in production takes a deliberate, exactly-spelled opt-out.
  assert.equal(authMode({ NODE_ENV: "production", AUTH_OPTIONAL: "true" }), "disabled");
  assert.equal(authMode({ NODE_ENV: "production", AUTH_OPTIONAL: "1" }), "misconfigured");
  assert.equal(authMode({ NODE_ENV: "production", AUTH_OPTIONAL: "TRUE" }), "misconfigured");
  // An opt-out never overrides a real configuration.
  assert.equal(authMode({ ...full, AUTH_OPTIONAL: "true" }), "enforced");
  // Whitespace is not configuration.
  assert.equal(authMode({ OIDC_ISSUER: "  ", OIDC_AUDIENCE: "  " }), "disabled");
});

test("readAuthConfig requires both halves", () => {
  assert.deepEqual(readAuthConfig({ OIDC_ISSUER: ISSUER, OIDC_AUDIENCE: AUDIENCE }), {
    issuer: ISSUER,
    audience: AUDIENCE,
    jwksUri: undefined,
  });
  assert.equal(readAuthConfig({ OIDC_ISSUER: ISSUER }), null);
  assert.equal(readAuthConfig({}), null);
});

test("challengeHeader cannot be broken out of by a crafted description", () => {
  const header = challengeHeader({
    ok: false,
    status: 401,
    error: "invalid_token",
    description: 'bad " token \\ here',
  });
  assert.equal(header, 'Bearer realm="mini", error="invalid_token", error_description="bad  token  here"');

  // A bare challenge carries no error code.
  assert.equal(
    challengeHeader({ ok: false, status: 401, error: null, description: "Authentication required." }),
    'Bearer realm="mini"',
  );
});
