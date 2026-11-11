/**
 * Browser half of the OAuth 2.0 flow: Authorization Code with PKCE (RFC 7636).
 *
 * PKCE rather than the implicit flow, and no client secret, because this is a
 * public client - anything shipped to the browser is readable by the user.
 * The server never trusts anything decided here; it re-verifies the access
 * token's signature, issuer, audience and expiry on every request.
 */

export type OAuthConfig = {
  issuer: string;
  clientId: string;
  /** The API the token is *for*. Must match OIDC_AUDIENCE on the server. */
  audience?: string;
  scope: string;
};

type Endpoints = {
  authorization_endpoint: string;
  token_endpoint: string;
  end_session_endpoint?: string;
};

type TokenSet = {
  accessToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  refreshToken?: string;
  /** Display only - never an authorization decision. */
  subject?: string;
};

const TOKENS_KEY = "mini.oauth.tokens";
const TXN_KEY = "mini.oauth.txn";
/** Refresh this far before actual expiry, so a request never races the clock. */
const REFRESH_MARGIN_MS = 60_000;

/**
 * Next inlines NEXT_PUBLIC_* at build time only for literal property reads,
 * so these cannot be looked up dynamically.
 */
export function readOAuthConfig(): OAuthConfig | null {
  const issuer = process.env.NEXT_PUBLIC_OIDC_ISSUER?.trim();
  const clientId = process.env.NEXT_PUBLIC_OIDC_CLIENT_ID?.trim();
  if (!issuer || !clientId) return null;

  return {
    issuer,
    clientId,
    audience: process.env.NEXT_PUBLIC_OIDC_AUDIENCE?.trim() || undefined,
    scope: process.env.NEXT_PUBLIC_OIDC_SCOPE?.trim() || "openid profile offline_access",
  };
}

/** True when the app is configured to require sign-in. */
export const authEnabled = (): boolean => readOAuthConfig() !== null;

// --- PKCE primitives ------------------------------------------------------

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomString(byteLength = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

// --- discovery ------------------------------------------------------------

let endpointsPromise: Promise<Endpoints> | null = null;

async function endpoints(config: OAuthConfig): Promise<Endpoints> {
  if (!endpointsPromise) {
    endpointsPromise = (async () => {
      const url = `${config.issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`OIDC discovery failed (HTTP ${response.status}).`);

      const doc = (await response.json()) as Endpoints & { issuer?: string };
      if (doc.issuer !== config.issuer) {
        throw new Error("OIDC discovery issuer mismatch.");
      }
      return doc;
    })();
    endpointsPromise.catch(() => {
      endpointsPromise = null;
    });
  }
  return endpointsPromise;
}

// --- token storage --------------------------------------------------------

/**
 * sessionStorage, not localStorage: the token dies with the tab, which keeps
 * the exposure window short. It is still script-readable, so an XSS bug would
 * expose it - see design.md for why that tradeoff is acceptable here and what
 * to do instead if it is not.
 */
function loadTokens(): TokenSet | null {
  try {
    const raw = sessionStorage.getItem(TOKENS_KEY);
    return raw ? (JSON.parse(raw) as TokenSet) : null;
  } catch {
    return null;
  }
}

function saveTokens(tokens: TokenSet | null): void {
  try {
    if (tokens) sessionStorage.setItem(TOKENS_KEY, JSON.stringify(tokens));
    else sessionStorage.removeItem(TOKENS_KEY);
  } catch {
    // Storage unavailable: the session simply will not survive a reload.
  }
}

/** Read `sub` out of an ID token for the UI. Display only - never trusted. */
function subjectOf(idToken: string | undefined): string | undefined {
  if (!idToken) return undefined;
  try {
    const payload = JSON.parse(atob(idToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return payload.email ?? payload.preferred_username ?? payload.name ?? payload.sub;
  } catch {
    return undefined;
  }
}

type TokenResponse = {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
};

function toTokenSet(body: TokenResponse, previous?: TokenSet | null): TokenSet {
  return {
    accessToken: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 300) * 1000,
    // Providers with refresh-token rotation return a new one; those without
    // return none, so keep the one we already hold.
    refreshToken: body.refresh_token ?? previous?.refreshToken,
    subject: subjectOf(body.id_token) ?? previous?.subject,
  };
}

// --- the flow -------------------------------------------------------------

/** Step 1: send the user to the identity provider. */
export async function beginLogin(returnTo = window.location.pathname): Promise<void> {
  const config = readOAuthConfig();
  if (!config) throw new Error("OAuth is not configured.");

  const { authorization_endpoint } = await endpoints(config);
  const verifier = randomString();
  const state = randomString(16);
  const nonce = randomString(16);

  sessionStorage.setItem(TXN_KEY, JSON.stringify({ verifier, state, nonce, returnTo }));

  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: `${window.location.origin}/auth/callback`,
    scope: config.scope,
    // Binds this redirect to this browser session, defeating CSRF on the callback.
    state,
    nonce,
    code_challenge: await challengeFor(verifier),
    code_challenge_method: "S256",
  });
  // Tells the issuer which API the access token is for, so `aud` comes back
  // as our API rather than the userinfo endpoint.
  if (config.audience) params.set("audience", config.audience);

  window.location.assign(`${authorization_endpoint}?${params}`);
}

/** Step 2: exchange the authorization code. Returns where to send the user next. */
export async function completeLogin(query: URLSearchParams): Promise<string> {
  const config = readOAuthConfig();
  if (!config) throw new Error("OAuth is not configured.");

  const error = query.get("error");
  if (error) {
    throw new Error(query.get("error_description") || `Sign-in failed: ${error}.`);
  }

  const code = query.get("code");
  const raw = sessionStorage.getItem(TXN_KEY);
  sessionStorage.removeItem(TXN_KEY);
  if (!code || !raw) throw new Error("Sign-in response was incomplete. Please try again.");

  const txn = JSON.parse(raw) as { verifier: string; state: string; returnTo: string };
  // Reject a callback we did not initiate.
  if (query.get("state") !== txn.state) {
    throw new Error("Sign-in state did not match. Please try again.");
  }

  const { token_endpoint } = await endpoints(config);
  const response = await fetch(token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: config.clientId,
      redirect_uri: `${window.location.origin}/auth/callback`,
      // Proves we are the same client that started the flow.
      code_verifier: txn.verifier,
    }),
  });

  const body = (await response.json()) as TokenResponse;
  if (!response.ok || !body.access_token) {
    throw new Error(body.error_description || body.error || "Could not complete sign-in.");
  }

  saveTokens(toTokenSet(body));
  return txn.returnTo || "/";
}

let refreshInFlight: Promise<TokenSet | null> | null = null;

async function refresh(config: OAuthConfig, tokens: TokenSet): Promise<TokenSet | null> {
  if (!tokens.refreshToken) return null;

  const { token_endpoint } = await endpoints(config);
  const response = await fetch(token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refreshToken,
      client_id: config.clientId,
    }),
  });

  if (!response.ok) return null;
  const body = (await response.json()) as TokenResponse;
  if (!body.access_token) return null;

  const next = toTokenSet(body, tokens);
  saveTokens(next);
  return next;
}

/**
 * The access token to put on a request, refreshing if it is about to expire.
 * Returns null when the user needs to sign in again.
 */
export async function getAccessToken(): Promise<string | null> {
  const config = readOAuthConfig();
  if (!config) return null;

  const tokens = loadTokens();
  if (!tokens) return null;
  if (tokens.expiresAt - REFRESH_MARGIN_MS > Date.now()) return tokens.accessToken;

  // Collapse concurrent callers onto one refresh: two parallel requests must
  // not both spend the refresh token, which rotation would then invalidate.
  refreshInFlight ??= refresh(config, tokens).finally(() => {
    refreshInFlight = null;
  });

  const refreshed = await refreshInFlight;
  if (!refreshed) {
    saveTokens(null);
    return null;
  }
  return refreshed.accessToken;
}

/** Who is signed in, for the header. Null when signed out. */
export function currentUser(): string | null {
  const tokens = loadTokens();
  if (!tokens) return null;
  return tokens.subject ?? "signed in";
}

export function isSignedIn(): boolean {
  return loadTokens() !== null;
}

/** Clear local state, then end the session at the issuer if it supports it. */
export async function logout(): Promise<void> {
  const config = readOAuthConfig();
  saveTokens(null);
  sessionStorage.removeItem(TXN_KEY);
  if (!config) return;

  try {
    const { end_session_endpoint } = await endpoints(config);
    if (end_session_endpoint) {
      const params = new URLSearchParams({
        client_id: config.clientId,
        post_logout_redirect_uri: window.location.origin,
      });
      window.location.assign(`${end_session_endpoint}?${params}`);
      return;
    }
  } catch {
    // Discovery down: a local sign-out is still a sign-out.
  }
  window.location.assign("/");
}
