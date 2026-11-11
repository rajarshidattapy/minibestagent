import * as client from "@prometheus-io/client";

/**
 * Prometheus metrics for the whole app: one registry, process defaults plus
 * a small set of counters and histograms for the things that actually cost
 * money or indicate trouble - LLM calls, cache hits, rate limiting, auth
 * failures, recall.
 *
 * Cardinality discipline: every label here is a small, fixed set of values
 * (a method, a route name, a status code, a model id, "hit"/"miss"). None of
 * them are a user id, a subject, or a conversation id - a label with
 * unbounded values turns into an unbounded number of time series, and a
 * per-user label would leak who-did-what into an operational surface that
 * is explicitly NOT access-controlled the way conversation data is.
 *
 * The registry is cached on `globalThis` because Next's dev server
 * re-executes module top-level code on every hot reload; without the cache,
 * the second reload would call `new client.Counter(...)` again under the
 * same metric name and prom-client's register throws on the duplicate.
 */

declare global {
  // eslint-disable-next-line no-var
  var __miniMetrics: Metrics | undefined;
}

type Metrics = {
  registry: client.Registry;
  httpRequestsTotal: client.Counter<"method" | "route" | "status">;
  httpRequestDuration: client.Histogram<"method" | "route" | "status">;
  chatOutcomesTotal: client.Counter<"outcome">;
  llmRequestDuration: client.Histogram<"model" | "cached">;
  llmTokensTotal: client.Counter<"model" | "direction">;
  cacheLookupsTotal: client.Counter<"result">;
  rateLimitRejectionsTotal: client.Counter<"rule">;
  authFailuresTotal: client.Counter<"reason">;
  recallInvocationsTotal: client.Counter<"source">;
  chatInFlight: client.Gauge;
};

function build(): Metrics {
  const registry = new client.Registry();
  client.collectDefaultMetrics({ register: registry, prefix: "mini_" });

  const httpRequestsTotal = new client.Counter({
    name: "mini_http_requests_total",
    help: "HTTP requests, by route and final status code",
    labelNames: ["method", "route", "status"],
    registers: [registry],
  });

  const httpRequestDuration = new client.Histogram({
    name: "mini_http_request_duration_seconds",
    help: "Time to produce a response (for a streaming route: time to begin streaming, not to finish - see mini_chat_outcomes_total for completion)",
    labelNames: ["method", "route", "status"],
    buckets: [0.01, 0.05, 0.1, 0.3, 1, 3],
    registers: [registry],
  });

  // /api/chat returns HTTP 200 the moment streaming begins, whether the turn
  // goes on to finish, get cut off, or error - the status code cannot carry
  // that outcome for a streamed response. This counter is incremented from
  // inside the stream once the turn actually concludes, so it is the metric
  // that answers "is this thing actually working", not the HTTP one.
  const chatOutcomesTotal = new client.Counter({
    name: "mini_chat_outcomes_total",
    help: "How a chat turn concluded once the stream finished",
    labelNames: ["outcome"],
    registers: [registry],
  });

  const llmRequestDuration = new client.Histogram({
    name: "mini_llm_request_duration_seconds",
    help: "Time spent waiting on the model, per turn (excludes cache hits)",
    labelNames: ["model", "cached"],
    buckets: [0.2, 0.5, 1, 2, 5, 10, 20, 40],
    registers: [registry],
  });

  const llmTokensTotal = new client.Counter({
    name: "mini_llm_tokens_total",
    help: "Tokens billed by the model API",
    labelNames: ["model", "direction"],
    registers: [registry],
  });

  const cacheLookupsTotal = new client.Counter({
    name: "mini_cache_lookups_total",
    help: "Response cache lookups, hit or miss",
    labelNames: ["result"],
    registers: [registry],
  });

  const rateLimitRejectionsTotal = new client.Counter({
    name: "mini_rate_limit_rejections_total",
    help: "Requests turned away by the rate limiter, by which rule tripped",
    labelNames: ["rule"],
    registers: [registry],
  });

  const authFailuresTotal = new client.Counter({
    name: "mini_auth_failures_total",
    help: "Authentication or permission failures, by reason",
    labelNames: ["reason"],
    registers: [registry],
  });

  const recallInvocationsTotal = new client.Counter({
    name: "mini_recall_invocations_total",
    help: "Turns where memory recall contributed context, by which signal found it",
    labelNames: ["source"],
    registers: [registry],
  });

  const chatInFlight = new client.Gauge({
    name: "mini_chat_in_flight",
    help: "Chat requests currently being handled",
    registers: [registry],
  });

  return {
    registry,
    httpRequestsTotal,
    httpRequestDuration,
    chatOutcomesTotal,
    llmRequestDuration,
    llmTokensTotal,
    cacheLookupsTotal,
    rateLimitRejectionsTotal,
    authFailuresTotal,
    recallInvocationsTotal,
    chatInFlight,
  };
}

export function metrics(): Metrics {
  globalThis.__miniMetrics ??= build();
  return globalThis.__miniMetrics;
}

/**
 * Wrap a route handler to record request count and duration for routes that
 * answer with one Response (not a stream). The outer try/finally means every
 * return path is measured once, in one place, rather than a metrics call
 * scattered at each early return - which is exactly the shape of bug where
 * one new "return 400" three months from now quietly goes unmeasured.
 */
export async function withHttpMetrics(
  request: Request,
  route: string,
  handler: () => Promise<Response>,
): Promise<Response> {
  const m = metrics();
  const end = m.httpRequestDuration.startTimer({ method: request.method, route });
  let status = "500";
  try {
    const response = await handler();
    status = String(response.status);
    return response;
  } finally {
    m.httpRequestsTotal.inc({ method: request.method, route, status });
    end({ status });
  }
}

/** Test seam: a fresh registry per test, so counters never bleed across tests. */
export function _resetForTests(): Metrics {
  globalThis.__miniMetrics = build();
  return globalThis.__miniMetrics;
}
