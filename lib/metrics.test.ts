import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { _resetForTests, withHttpMetrics } from "./metrics.ts";
import { checkMetricsAuth } from "./metrics-auth.ts";

let m: ReturnType<typeof _resetForTests>;

beforeEach(() => {
  m = _resetForTests();
});

// --- exposition format ------------------------------------------------------

test("the registry produces valid Prometheus exposition text", async () => {
  m.httpRequestsTotal.inc({ method: "GET", route: "/api/chat", status: "200" });
  const output = await m.registry.metrics();

  assert.match(output, /^# HELP mini_http_requests_total/m);
  assert.match(output, /^# TYPE mini_http_requests_total counter$/m);
  assert.match(
    output,
    /^mini_http_requests_total\{method="GET",route="\/api\/chat",status="200"\} 1$/m,
  );
});

test("default process metrics are included", async () => {
  const output = await m.registry.metrics();
  // Comes from collectDefaultMetrics - proof it actually ran, not just that
  // the registry exists.
  assert.match(output, /^mini_process_cpu_user_seconds_total /m);
});

test("the content type matches the exposition format being served", () => {
  assert.match(m.registry.contentType, /^text\/plain/);
});

// --- counters and histograms do what the route code expects ----------------

test("counters accumulate across labels independently", async () => {
  m.cacheLookupsTotal.inc({ result: "hit" });
  m.cacheLookupsTotal.inc({ result: "hit" });
  m.cacheLookupsTotal.inc({ result: "miss" });

  const output = await m.registry.metrics();
  assert.match(output, /mini_cache_lookups_total\{result="hit"\} 2/);
  assert.match(output, /mini_cache_lookups_total\{result="miss"\} 1/);
});

test("a histogram timer records an observation with the labels given at both ends", async () => {
  const end = m.llmRequestDuration.startTimer({ cached: "false" });
  end({ model: "claude-opus-5-5" });

  const output = await m.registry.metrics();
  assert.match(
    output,
    /mini_llm_request_duration_seconds_count\{cached="false",model="claude-opus-5-5"\} 1/,
  );
});

test("a token count can be incremented by a specific amount, not just by one", async () => {
  m.llmTokensTotal.inc({ model: "claude-opus-5-5", direction: "input" }, 1234);
  const output = await m.registry.metrics();
  assert.match(
    output,
    /mini_llm_tokens_total\{model="claude-opus-5-5",direction="input"\} 1234/,
  );
});

test("the in-flight gauge goes up and back down", async () => {
  m.chatInFlight.inc();
  m.chatInFlight.inc();
  let output = await m.registry.metrics();
  assert.match(output, /mini_chat_in_flight 2/);

  m.chatInFlight.dec();
  output = await m.registry.metrics();
  assert.match(output, /mini_chat_in_flight 1/);
});

// --- withHttpMetrics ---------------------------------------------------------

test("withHttpMetrics records the status the handler actually returned", async () => {
  const request = new Request("https://x.test", { method: "POST" });
  const response = await withHttpMetrics(request, "/api/chat", async () =>
    Response.json({ ok: true }, { status: 429 }),
  );

  assert.equal(response.status, 429);
  const output = await m.registry.metrics();
  assert.match(
    output,
    /mini_http_requests_total\{method="POST",route="\/api\/chat",status="429"\} 1/,
  );
});

test("withHttpMetrics records a request even when the handler throws", async () => {
  const request = new Request("https://x.test", { method: "GET" });

  await assert.rejects(() =>
    withHttpMetrics(request, "/api/conversation", async () => {
      throw new Error("boom");
    }),
  );

  const output = await m.registry.metrics();
  assert.match(
    output,
    /mini_http_requests_total\{method="GET",route="\/api\/conversation",status="500"\} 1/,
  );
});

test("the registry is reused across calls to metrics(), not rebuilt", async () => {
  const { metrics: getMetrics } = await import("./metrics.ts");
  assert.equal(getMetrics(), getMetrics(), "same object every call");
});

// --- metrics endpoint auth ---------------------------------------------------

function req(auth?: string): Request {
  return new Request("https://x.test/api/metrics", {
    headers: auth ? { authorization: auth } : {},
  });
}

test("no token configured, outside production: open", () => {
  assert.deepEqual(checkMetricsAuth(req(), {}), { ok: true });
});

test("no token configured, in production: fails closed", () => {
  const result = checkMetricsAuth(req(), { NODE_ENV: "production" });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.status, 500);
});

test("no token configured, in production, with the explicit opt-out: open", () => {
  assert.deepEqual(
    checkMetricsAuth(req(), { NODE_ENV: "production", METRICS_OPEN: "true" }),
    { ok: true },
  );
});

test("a token configured requires the exact bearer credential", () => {
  const env = { METRICS_TOKEN: "s3cret" };
  assert.deepEqual(checkMetricsAuth(req("Bearer s3cret"), env), { ok: true });

  const wrong = checkMetricsAuth(req("Bearer nope"), env);
  assert.equal(wrong.ok, false);
  assert.equal(!wrong.ok && wrong.status, 401);

  const missing = checkMetricsAuth(req(), env);
  assert.equal(missing.ok, false);
  assert.equal(!missing.ok && missing.status, 401);
});

test("the scheme check is case-insensitive, matching bearerToken elsewhere in the app", () => {
  assert.deepEqual(
    checkMetricsAuth(req("bearer s3cret"), { METRICS_TOKEN: "s3cret" }),
    { ok: true },
  );
});

test("a token that is merely a prefix or suffix of the real one is rejected", () => {
  // Guards against a naive `.includes()`/`.startsWith()` implementation.
  const env = { METRICS_TOKEN: "s3cret" };
  assert.equal(checkMetricsAuth(req("Bearer s3cretextra"), env).ok, false);
  assert.equal(checkMetricsAuth(req("Bearer s3cre"), env).ok, false);
});
