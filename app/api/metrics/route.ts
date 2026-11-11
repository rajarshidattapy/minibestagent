import { checkMetricsAuth } from "@/lib/metrics-auth";
import { metrics } from "@/lib/metrics";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const auth = checkMetricsAuth(request);
  if (!auth.ok) {
    return new Response(auth.error, {
      status: auth.status,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        ...(auth.status === 401 ? { "WWW-Authenticate": 'Bearer realm="mini-metrics"' } : {}),
      },
    });
  }

  const registry = metrics().registry;
  return new Response(await registry.metrics(), {
    headers: { "Content-Type": registry.contentType },
  });
}
