import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";

/**
 * OAuth 2.0 resource-server verification for /api/chat.
 *
 * Every token must clear four independent checks before a request is served:
 * signature, issuer, audience, and expiry. Failing any one is a 401.
 */

/**
 * Signature algorithms we accept. Pinning this list is the single most
 * important line in this file: without it a token carrying `alg: "none"`
 * verifies trivially, and a token signed with HS256 can be forged using the
 * issuer's *public* key as the HMAC secret. Asymmetric algorithms only -
 * never add an HS* entry here.
 */
const ALLOWED_ALGORITHMS = [
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
];

/** Tolerance for clock drift between us and the issuer, in seconds. */
const CLOCK_TOLERANCE = 60;

/**
 * Claims that must be present. `exp` is here deliberately: a token with no
 * expiry would otherwise sail through the expiry check by having nothing to
 * check, which is a non-expiring credential.
 */
const REQUIRED_CLAIMS = ["iss", "aud", "exp", "sub"];

export type AuthConfig = {
  issuer: string;
  audience: string;
  /** Overrides OIDC discovery when the issuer does not publish a discovery document. */
  jwksUri?: string;
};

/**
 * - `enforced`: issuer and audience are configured; every request needs a valid token.
 * - `disabled`: nothing configured, and we are not in production - local dev convenience.
 * - `misconfigured`: half-configured, or production with no config. Fails closed.
 */
export type AuthMode = "enforced" | "disabled" | "misconfigured";

export type AuthResult =
  | { ok: true; claims: JWTPayload | null }
  | {
      ok: false;
      status: 401 | 500;
      /** RFC 6750 error code, or null when no credentials were supplied at all. */
      error: "invalid_token" | "invalid_request" | "server_error" | null;
      description: string;
    };

type Env = Record<string, string | undefined>;

export function readAuthConfig(env: Env = process.env): AuthConfig | null {
  const issuer = env.OIDC_ISSUER?.trim();
  const audience = env.OIDC_AUDIENCE?.trim();
  if (!issuer || !audience) return null;
  return { issuer, audience, jwksUri: env.OIDC_JWKS_URI?.trim() || undefined };
}

export function authMode(env: Env = process.env): AuthMode {
  const issuer = env.OIDC_ISSUER?.trim();
  const audience = env.OIDC_AUDIENCE?.trim();

  if (issuer && audience) return "enforced";
  // Half-configured is always an error: silently serving an open endpoint
  // because one variable was typo'd is exactly the failure to avoid.
  if (issuer || audience) return "misconfigured";
  // Running an open endpoint in production has to be a deliberate, typed-out
  // decision - never something you get by forgetting to set a variable.
  if (env.AUTH_OPTIONAL === "true") return "disabled";
  // Unconfigured is a dev convenience only. In production it is a mistake,
  // and we refuse to serve rather than quietly running wide open.
  return env.NODE_ENV === "production" ? "misconfigured" : "disabled";
}

// ---------------------------------------------------------------------------
// Key resolution
// ---------------------------------------------------------------------------

/** Cached per JWKS URI. `createRemoteJWKSet` does its own caching, rate-limited
 * refresh on an unseen `kid`, and cooldown, so we keep one instance alive. */
const keySetCache = new Map<string, JWTVerifyGetKey>();
/** Cached discovery lookups, keyed by issuer. */
const discoveryCache = new Map<string, Promise<string>>();

/** OIDC discovery: ask the issuer where its public keys live. */
async function discoverJwksUri(issuer: string): Promise<string> {
  const url = `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`OIDC discovery failed for ${issuer} (HTTP ${response.status}).`);
  }

  const doc = (await response.json()) as { issuer?: unknown; jwks_uri?: unknown };

  // Required by the OIDC Discovery spec, and a real check: it stops a
  // redirected or hijacked discovery document from pointing us at keys
  // belonging to someone else.
  if (doc.issuer !== issuer) {
    throw new Error(
      `OIDC discovery issuer mismatch: configured "${issuer}", document declares "${String(doc.issuer)}".`,
    );
  }
  if (typeof doc.jwks_uri !== "string" || !doc.jwks_uri) {
    throw new Error(`OIDC discovery document for ${issuer} has no jwks_uri.`);
  }
  return doc.jwks_uri;
}

async function resolveKeySet(config: AuthConfig): Promise<JWTVerifyGetKey> {
  let jwksUri = config.jwksUri;

  if (!jwksUri) {
    let pending = discoveryCache.get(config.issuer);
    if (!pending) {
      pending = discoverJwksUri(config.issuer);
      discoveryCache.set(config.issuer, pending);
      // Do not cache a failure: a transient outage should not disable auth
      // until the process restarts.
      pending.catch(() => discoveryCache.delete(config.issuer));
    }
    jwksUri = await pending;
  }

  const cached = keySetCache.get(jwksUri);
  if (cached) return cached;

  const keySet = createRemoteJWKSet(new URL(jwksUri), {
    cacheMaxAge: 10 * 60 * 1000,
    // Floor between refetches when an unknown `kid` appears, so a flood of
    // tokens with bogus key ids cannot be turned into a request amplifier
    // against the issuer.
    cooldownDuration: 30 * 1000,
    timeoutDuration: 5000,
  });
  keySetCache.set(jwksUri, keySet);
  return keySet;
}

/** Test seam: drop memoized keys and discovery results. */
export function resetAuthCaches(): void {
  keySetCache.clear();
  discoveryCache.clear();
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/** Maps a jose failure onto a message safe to hand back to a caller. */
function describeVerificationFailure(err: unknown): string {
  const code = (err as { code?: string })?.code;
  switch (code) {
    case "ERR_JWT_EXPIRED":
      return "The access token is expired.";
    case "ERR_JWS_SIGNATURE_VERIFICATION_FAILED":
      return "The access token signature is invalid.";
    case "ERR_JOSE_ALG_NOT_ALLOWED":
      return "The access token is signed with an unsupported algorithm.";
    case "ERR_JWKS_NO_MATCHING_KEY":
      return "No signing key matches the access token.";
    case "ERR_JWT_CLAIM_VALIDATION_FAILED": {
      const claim = (err as { claim?: string }).claim;
      // Covers iss, aud, nbf and the required-claim check.
      return claim
        ? `The access token "${claim}" claim is missing or invalid.`
        : "The access token failed claim validation.";
    }
    case "ERR_JWT_INVALID":
    case "ERR_JWS_INVALID":
      return "The access token is malformed.";
    default:
      return "The access token could not be verified.";
  }
}

export type VerifyOptions = {
  config?: AuthConfig;
  /** Injected in tests so verification runs against a local key set. */
  getKey?: JWTVerifyGetKey;
};

/**
 * Verify signature, issuer, audience and expiry. Resolves with the claims or
 * rejects; callers should use {@link authorizeRequest} rather than this
 * directly unless they want to handle errors themselves.
 */
export async function verifyAccessToken(
  token: string,
  options: VerifyOptions = {},
): Promise<JWTPayload> {
  const config = options.config ?? readAuthConfig();
  if (!config) throw new Error("Auth is not configured.");

  const getKey = options.getKey ?? (await resolveKeySet(config));

  const { payload } = await jwtVerify(token, getKey, {
    issuer: config.issuer,
    audience: config.audience,
    algorithms: ALLOWED_ALGORITHMS,
    clockTolerance: CLOCK_TOLERANCE,
    requiredClaims: REQUIRED_CLAIMS,
  });

  return payload;
}

/** Pull the credential out of `Authorization: Bearer <token>`. */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  // The scheme is case-insensitive per RFC 7235.
  const match = /^Bearer[ ]+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

/** The whole gate: decide whether this request may proceed. */
export async function authorizeRequest(
  request: Request,
  options: VerifyOptions = {},
): Promise<AuthResult> {
  const mode = authMode();

  if (mode === "disabled") return { ok: true, claims: null };

  if (mode === "misconfigured") {
    return {
      ok: false,
      status: 500,
      error: "server_error",
      description:
        "Authentication is misconfigured: set both OIDC_ISSUER and OIDC_AUDIENCE, " +
        "or set AUTH_OPTIONAL=true to run this endpoint without authentication.",
    };
  }

  const token = bearerToken(request);
  if (!token) {
    return {
      ok: false,
      status: 401,
      // No credentials at all is a bare challenge, not an invalid_token error.
      error: null,
      description: "Authentication required.",
    };
  }

  try {
    const claims = await verifyAccessToken(token, options);
    return { ok: true, claims };
  } catch (err) {
    // A discovery or network failure is ours, not the caller's: say so with a
    // 500 instead of telling them their perfectly good token is invalid.
    if (!(err as { code?: string })?.code) {
      return {
        ok: false,
        status: 500,
        error: "server_error",
        description: "Could not reach the identity provider to verify the token.",
      };
    }
    return {
      ok: false,
      status: 401,
      error: "invalid_token",
      description: describeVerificationFailure(err),
    };
  }
}

/** RFC 6750 challenge header for a rejected request. */
export function challengeHeader(result: Extract<AuthResult, { ok: false }>): string {
  const parts = ['Bearer realm="mini"'];
  if (result.error && result.error !== "server_error") {
    parts.push(`error="${result.error}"`);
    // Quoted-string: strip anything that would break out of the quotes.
    parts.push(`error_description="${result.description.replace(/["\\]/g, "")}"`);
  }
  return parts.join(", ");
}
