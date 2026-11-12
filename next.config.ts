import type { NextConfig } from "next";

/**
 * The browser must be able to reach the identity provider for OIDC discovery
 * and the token exchange, so its origin joins connect-src. Everything else
 * stays same-origin.
 */
function connectSources(): string {
  const sources = new Set(["'self'"]);
  for (const value of [
    process.env.NEXT_PUBLIC_OIDC_ISSUER,
    process.env.OIDC_ISSUER,
  ]) {
    if (!value) continue;
    try {
      sources.add(new URL(value).origin);
    } catch {
      // Not a URL - nothing to allow.
    }
  }
  return [...sources].join(" ");
}

const csp = [
  "default-src 'self'",
  // Next's hydration bootstrap is inline. Tightening this to a nonce needs
  // middleware that rewrites the header per request; see DESIGN.md.
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  // Search results are summarised as text, never rendered, so no remote
  // images are ever needed.
  "img-src 'self' data:",
  "font-src 'self'",
  `connect-src ${connectSources()}`,
  // Blocks <base href> injection from redirecting every relative URL.
  "base-uri 'self'",
  "form-action 'self'",
  // Clickjacking: this app must never be framed.
  "frame-ancestors 'none'",
  "object-src 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  // Defence in depth for browsers that honour the older header.
  { key: "X-Frame-Options", value: "DENY" },
  // Stops a response being re-interpreted as a type it is not.
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  // Only meaningful over HTTPS; ignored on localhost.
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  // Do not advertise the framework version.
  poweredByHeader: false,
  // A self-contained server bundle for deploy/ (EC2 + systemd, not a
  // serverless platform) - this app keeps its memory and cache in a local
  // SQLite file, which needs one long-lived process and a real disk, not an
  // ephemeral per-invocation filesystem.
  output: "standalone",
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
