# mini

A fast chat agent with one tool — web search — that remembers what you asked and when, across days and devices.

Ask it "what did I ask you on 3 November, and is that still true?" and it will find the conversation, re-search, and tell you what changed.

See [`DESIGN.md`](./DESIGN.md) for why it is built this way.

## Run it

```bash
npm install
cp .env.example .env            # then put your key in it
npm run dev                        # http://localhost:3000
```

Get a key at [console.anthropic.com](https://console.anthropic.com/settings/keys). `ANTHROPIC_API_KEY` is the only variable needed to chat.

## Authentication

`/api/chat` can require a signed OAuth 2.0 / OIDC access token. Set `OIDC_ISSUER` and `OIDC_AUDIENCE` and every request is checked for **signature, issuer, audience and expiry** before it costs you a token. Add `NEXT_PUBLIC_OIDC_ISSUER` and `NEXT_PUBLIC_OIDC_CLIENT_ID` and the UI gains sign-in via Authorization Code + PKCE. Works with any OIDC provider — Auth0, Clerk, Cognito, Okta, Entra, Keycloak. See [`.env.example`](./.env.example).

Leaving the `OIDC_*` variables unset runs without auth. That is fine locally, but **in production it fails closed with a 500** until you either configure an issuer or set `AUTH_OPTIONAL=true`, so a forgotten variable can never quietly leave the endpoint open.

## Guardrails

Enforced server-side on every request, because an authenticated client is still an untrusted one:

- **Rate limits** — 15 requests/min and 150/hour per caller, keyed on the authenticated subject (or IP when running without auth). Replies carry `Retry-After`.
- **Size limits** — 1 MB body, 200 messages per conversation, 32k characters per message, 600k per conversation.
- **Prompt injection** — search results are treated strictly as data. The model is told never to follow instructions found on a web page, and to say so when one tries. The agent's single tool is read-only, so there is no destructive action to reach.
- **Timeouts** — 55s upstream cap, 5 searches per turn.
- **Security headers** — CSP, `frame-ancestors 'none'`, `nosniff`, referrer and permissions policies, HSTS.

Tune the numbers in [`lib/guardrails.ts`](./lib/guardrails.ts) and [`lib/rate-limit.ts`](./lib/rate-limit.ts). The rate-limit store is in-memory and therefore per-instance — see `DESIGN.md` for what that means on serverless and how to make it global.

## Memory

Turns are stored server-side in SQLite (`node:sqlite`, built into Node — no extra dependency, no setup). On each turn the server assembles context from the live thread, anything from a date you named ("on 3 November", "last Tuesday", "yesterday"), and anything that matches by topic via full-text search.

The rules allow one tool, so memory is not one: retrieval runs server-side before the model is called, which is also why it costs no extra round-trip. Only your new message crosses the wire, so cost per turn does not grow with the length of the conversation.

Signed in, memory follows you across devices. Signed out, it is scoped to the browser by an `httpOnly` cookie. The database lives at `./data/mini.db` (override with `MEMORY_DB_PATH`).

## Role-based permission control

Authentication (`lib/auth.ts`) answers "who is this"; permission control (`lib/rbac.ts`) answers "what are they allowed to do" - checked separately, on every route.

Roles come from the verified token's own claims, so there is no second place for them to drift out of sync. Three roles ship: **user** (send and read, the default for any signed-in principal whose token carries no role the app recognises - most OIDC setups never configure custom roles, so this is the floor, not a trap), **readonly** (read only - a role that *removes* access, not just one that adds it), and **admin** (read any user's conversation via `?as=<owner key>` on `/api/conversation`, and `GET /api/admin/stats` for cache visibility). The claim is read from whichever shape the IdP used: a plain `roles` array, a space-delimited OAuth2 `scope`, Keycloak's `realm_access.roles`, Cognito's `cognito:groups`, or a custom claim named by `OIDC_ROLES_CLAIM`.

Every admin read of another user's conversation is written to the server log with the admin's subject and the target, since impersonating a read is exactly the kind of action an audit trail exists for.

## Evals

`evals/cases.ts` is a small corpus built directly on the brief's own three example questions (CRM pricing, "what did I ask on 3 November", Postgres hosting) plus five more covering memory controls and agent behaviour: recall must not false-positive on a plain question, must reach across conversation threads (not just the current one), must follow topically with no date named, must not search for arithmetic, and must not obey an instruction planted in a recalled past turn.

```bash
npm run eval       # structural mode: free, deterministic, no API key needed
npm run eval:live  # calls the real model and grades what it actually said - spends money
```

**Structural mode** (the default) answers every call with a mock model and grades only what does not depend on what the model says: did memory recall fire, from the right day, across threads, and - just as importantly - did it *not* fire on an unrelated question. This is what caught a real bug while building the harness: `lib/memory/store.ts`'s topic search had no stopword filter, so two completely unrelated turns that happened to share a word like "about" would match each other. Fixed, and now a named regression case in both the eval corpus and the unit tests.

**Live mode** needs a real `ANTHROPIC_API_KEY` already set in the environment - it refuses to run rather than silently falling back to the mock if one isn't there, since a "live" result that was actually a cache of mock answers would be worse than no result. It additionally grades the model's actual answer: does it mention the specific tools/numbers it was told about, does it search when the question needs current information and skip searching for arithmetic, and does it resist an instruction smuggled into recalled memory. Grading is keyword/phrase matching (an "AND of OR-groups" rubric per case), not an LLM judge - cheaper, deterministic, and its limits are named rather than hidden: a model that answers correctly but phrases it unexpectedly can read as a false fail.

## Observability

`GET /api/metrics` serves Prometheus exposition text: request counts and latency per route, LLM call latency and tokens (labelled by the model that actually answered, so a server-side fallback shows up), cache hit/miss rate, rate-limit rejections, auth/permission failures by reason, and memory recall invocations - plus default Node process metrics (CPU, memory, event-loop lag, GC) from `collectDefaultMetrics`. No label carries a user id, subject, or conversation id; those stay inside the access-controlled conversation data, not an operational surface scraped by infrastructure.

A Prometheus scrape config authenticates with a static bearer token (`authorization: { credentials: ... }` in `scrape_configs:`), not an OAuth2 flow, so the endpoint has its own shared secret, `METRICS_TOKEN`, checked in constant time. Unset in production, it fails closed the same way the OIDC gate does - `METRICS_OPEN=true` is the explicit opt-out for a deployment where the endpoint is already behind a private network.

Because `/api/chat` streams, its HTTP status is 200 the instant streaming begins, regardless of how the turn actually concludes - that is a real limitation of status codes on SSE, not an oversight. `mini_chat_outcomes_total{outcome}` is the metric that answers "did it actually work": `ok`, `cached`, `max_tokens`, `refusal`, `pause_turn_exhausted`, or `error`, recorded once the stream itself finishes.

## Response cache

Repeat questions are answered from a cache stored alongside memory in SQLite, so it survives restarts. The key is a hash of the whole prompt with the clock scrubbed to day precision — same question later the same day hits; the next day it does not, because date-relative questions ("what did I ask yesterday?") would otherwise get the wrong answer. Only the hash is stored, never the prompt.

Freshness is handled by expiry rather than the key: **15 minutes** for answers built from a web search, **12 hours** otherwise. Entries are per-user by default. Set `LLM_CACHE=off` to disable, or `LLM_CACHE_SCOPE=global` to share identical cold-start questions across users.

## Checks

```bash
npm run test       # 70 unit tests: dates, recall, cache keys, parsing, tokens, guardrails
npm run verify     # all three HTTP suites below
npm run typecheck
npm run build
```

`npm run verify` runs six end-to-end suites against a real server on a throwaway database: `verify:memory` (date and topic recall, per-owner isolation, reload), `verify:cache` (counts calls reaching a stand-in model endpoint, and restarts the server to prove the cache is on disk), `verify:rbac` (mints tokens with different roles and checks both denial and elevation over real HTTP), `verify:metrics` (drives chat/cache/auth/rate-limit traffic and checks the exposition text actually moved), `verify:oidc` (token verification against a local OIDC issuer), and `verify:guardrails` (limits and security headers).

## Layout


| Path                    | What it does                                                                      |
| ----------------------- | --------------------------------------------------------------------------------- |
| `app/page.tsx`          | The chat UI. Owns the transcript and persists it to `localStorage`.               |
| `app/api/chat/route.ts` | Stateless streaming endpoint. One Claude call per turn, web search attached.      |
| `lib/chat.ts`           | Stream framing, citation extraction, timestamp formatting.                        |
| `lib/memory/dates.ts`   | Turns "3 November" / "last Tuesday" into day ranges.                              |
| `lib/memory/store.ts`   | Durable turns in SQLite, with full-text search.                                   |
| `lib/memory/context.ts` | Assembles each request: live thread + date recall + topic recall.                 |
| `lib/cache.ts`          | Response cache: scrubbed prompt hash, TTL by whether it searched.                 |
| `lib/db.ts`             | The shared SQLite connection and schema.                                          |
| `lib/rbac.ts`           | Roles and permissions, read from the token's own claims.                          |
| `lib/metrics.ts`        | The Prometheus registry and every counter/histogram/gauge.                        |
| `lib/metrics-auth.ts`   | Static bearer-token gate for /api/metrics.                                        |
| `lib/types.ts`          | Shared shapes, deliberately free of SDK imports so the client bundle stays small. |
| `lib/auth.ts`           | Token verification: signature, issuer, audience, expiry.                          |
| `lib/oauth.ts`          | Browser sign-in: Authorization Code + PKCE, token refresh.                        |
| `lib/guardrails.ts`     | Input size and shape limits.                                                      |
| `lib/rate-limit.ts`     | Per-caller burst and sustained rate limiting.                                     |
| `next.config.ts`        | Security headers and CSP.                                                         |


## Notes

- **The transcript is the memory.** Each message you send is stamped with your local time before it goes to the model, so "what did I ask you this morning?" is a question it can actually answer. History lives in your browser and survives refreshes; **Clear** wipes it.
- **It searches when it should.** The model decides; you will see *Searching for "…"* and a row of source links on any answer that used the web.
- **Nothing is stored on the server.** Swapping in a database means changing where `app/page.tsx` loads and saves the transcript — the API route never needs to know.

