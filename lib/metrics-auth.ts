import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Access control for /api/metrics, deliberately separate from lib/auth.ts.
 *
 * A Prometheus scrape config cannot run an OAuth2 Authorization Code flow -
 * its native auth options are a static bearer token, basic auth, or mTLS.
 * A plain shared-secret bearer token is what `scrape_configs:` actually
 * supports (`authorization: { credentials: <token> }`), so that is what this
 * checks, rather than forcing a JWT where none fits.
 *
 * Same fail-closed shape as the OIDC gate: unset in production serves
 * nothing until the token is set or the endpoint is explicitly opened, so a
 * forgotten environment variable can never silently expose operational
 * metrics (request volume, cache hit rate, rate-limit pressure - not user
 * data, but still an internal signal, and still not nothing).
 */

export type MetricsAuthResult =
  | { ok: true }
  | { ok: false; status: 401 | 500; error: string };

function constantTimeEquals(a: string, b: string): boolean {
  // Hash both sides to a fixed length first: comparing raw strings of
  // different lengths with timingSafeEqual throws, and padding them
  // ourselves is easy to get subtly wrong. Equal-length digests sidestep
  // both problems and keep the comparison itself constant-time.
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

type Env = Record<string, string | undefined>;

export function checkMetricsAuth(
  request: Request,
  env: Env = process.env,
): MetricsAuthResult {
  const token = env.METRICS_TOKEN?.trim();

  if (!token) {
    // Mirrors AUTH_OPTIONAL in lib/auth.ts: an open endpoint in production
    // has to be spelled out, never arrived at by forgetting a variable.
    if (env.NODE_ENV === "production" && env.METRICS_OPEN !== "true") {
      return {
        ok: false,
        status: 500,
        error:
          "METRICS_TOKEN is not set. Set it to a shared secret for your Prometheus " +
          "scrape config, or set METRICS_OPEN=true to serve this endpoint unauthenticated.",
      };
    }
    return { ok: true };
  }

  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match || !constantTimeEquals(match[1], token)) {
    return { ok: false, status: 401, error: "A valid metrics bearer token is required." };
  }
  return { ok: true };
}
