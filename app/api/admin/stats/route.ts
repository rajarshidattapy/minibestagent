import { authorizeRequest, challengeHeader } from "@/lib/auth";
import { requirePermission } from "@/lib/rbac";
import { stats as cacheStats } from "@/lib/cache";
import { metrics, withHttpMetrics } from "@/lib/metrics";

export const runtime = "nodejs";

/**
 * Operational visibility, admin-only: how the response cache is doing. Not
 * per-user data - that is what "admin:view_stats" is scoped to, separately
 * from "admin:read_any" which gates reading another user's conversation.
 */
export async function GET(request: Request) {
  return withHttpMetrics(request, "/api/admin/stats", () => handle(request));
}

async function handle(request: Request): Promise<Response> {
  const auth = await authorizeRequest(request);
  if (!auth.ok) {
    metrics().authFailuresTotal.inc({ reason: auth.error ?? "no_token" });
    return Response.json(
      { error: auth.description },
      {
        status: auth.status,
        headers:
          auth.status === 401 ? { "WWW-Authenticate": challengeHeader(auth) } : undefined,
      },
    );
  }

  const forbidden = requirePermission(auth.claims, "admin:view_stats");
  if (forbidden) {
    metrics().authFailuresTotal.inc({ reason: "forbidden:admin:view_stats" });
    return Response.json({ error: forbidden.error }, { status: forbidden.status });
  }

  return Response.json({ cache: cacheStats() });
}
