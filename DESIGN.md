# DESIGN

A chat agent with one tool — web search — built so that "what did I ask you on 3 November, and is it still true?" is a question it can actually answer.

## How it works

One streaming Claude call per turn. Web search is Anthropic's **server-side** tool, so the model decides when to search and the search runs upstream: there is no client-side tool loop, no framework, and no extra round-trip. The route handler is the whole control flow.

**Memory is the architecture.** The brief's examples all have the same shape — recall a past conversation, resolve a date, re-search, compare then against now — so memory is not a feature bolted on the side, it is the thing being designed.

Turns are persisted server-side in SQLite (`node:sqlite`, built into Node, so `npm install` adds nothing). On each turn the server assembles context from three sources:

1. **The live thread**, verbatim — the last 24 turns, so ordinary conversation flows.
2. **Date recall** — `lib/memory/dates.ts` parses "on 3 November", "last Tuesday", "yesterday", "three days ago" into day ranges and pulls the turns recorded in them, across *all* of that user's conversations.
3. **Topic recall** — SQLite FTS5 over every turn ever stored, for follow-ups that name no date ("has their pricing changed since?").

Recalled turns are injected as a **mid-conversation system message**, placed after the user's question. That keeps them clearly operator-supplied rather than smuggled into the transcript, and leaves the cached prefix untouched. The block carries today's date and an instruction: these extracts were true when said, may be stale now, so if asked whether something still holds, search and compare.

Crucially, **the rules allow one tool, so memory cannot be one.** Retrieval happens server-side before the model is called, which is also why it is fast — no extra model round-trip to decide what to remember.

**Speed.** `effort: "low"` (chat does not need deep reasoning), always streaming, and prompt caching over a frozen `tools → system → thread` prefix. Only the new message crosses the wire, so cost per turn no longer grows with conversation length. Skipping recall entirely when a question has no backward-looking signal keeps the common case at zero extra work.

**Role-based permission control.** Authentication (`lib/auth.ts`) and authorization (`lib/rbac.ts`) are deliberately separate questions, checked separately on every route — a verified token answers who someone is; it does not by itself answer what they may do. Roles live in the token's own claims rather than a second database, read from whichever shape the IdP actually used (`roles`, `scope`, Keycloak's `realm_access.roles`, Cognito's `cognito:groups`, or a configurable custom claim) — there's no canonical shape across providers, so the claim location has to be a setting, not an assumption. Three roles: `user` (the floor — send and read, and what any signed-in principal gets when its token carries no role the app recognises, because most OIDC setups never configure custom roles and RBAC should not become a trap for everyone who didn't opt in), `readonly` (demonstrates restriction, not just elevation — it removes `chat:send` rather than adding to the floor), and `admin` (adds reading any user's conversation by owner key, and a `/api/admin/stats` endpoint — the first real caller of `cache.ts`'s `stats()`, previously written but unused). Every admin read of someone else's conversation is logged with the admin's subject and the target, since impersonating a read is exactly the action an audit trail is for.

**Response cache.** Repeat questions are served from a SQLite-backed cache in the same file as memory, so it survives restarts. The key is a SHA-256 of everything that could change the answer — model, system prompt, tools, effort, messages — with the clock scrubbed to day precision. Both halves of that scrub matter: leaving the `[14:32]` in makes every prompt unique and nothing ever hits; removing the date too makes "what did I ask yesterday?" hash identically on Tuesday and Monday, and the cache answers confidently with the wrong day. Time is handled by expiry, not by the key: 15 minutes for an answer built from a web search, 12 hours for one the model gave from its own knowledge. Only the hash is stored, never the prompt. Entries are owner-scoped by default.

**Correctness.** Search when stale-able, cite sources, never invent a citation. Every incomplete path says so rather than rendering a partial answer as whole: `max_tokens`, refusal, a `pause_turn` that exhausts its resumes, and search errors — which arrive as HTTP 200 with an error *object* where the result *list* goes, a trap with a test pinning it.

**Identity.** Signed in, memory follows the person across devices. Signed out, an `httpOnly` cookie scopes it to the browser. Every store query is filtered by owner.

**Evals.** `evals/cases.ts` is built on the brief's own three example questions, close to verbatim, plus five covering the ways recall can go wrong: a false positive on a plain question, failing to reach across conversation threads, failing to follow a topic with no date named, searching when it shouldn't, and obeying an instruction planted inside recalled memory. `npm run eval` runs structurally against a mock model (free, deterministic, checks only what does not depend on what the model says — did recall fire, from the right day); `npm run eval:live` spends real money against the actual model and grades the answer's content against a keyword rubric, and refuses to run rather than silently falling back to the mock if a real `ANTHROPIC_API_KEY` isn't already set. Building this surfaced a real bug — see "Found while building this" below.

**Observability.** `GET /api/metrics` serves Prometheus exposition text — request counts and latency per route, LLM latency and tokens (labelled by the model that actually answered, so a fallback is visible), cache hit rate, rate-limit rejections, auth/permission failures by reason, recall invocations, plus default Node process metrics. No label is a user id, subject, or conversation id; metrics are not access-controlled the way conversation data is, so nothing identifying goes near them. The one subtlety: `/api/chat` streams, so its HTTP status is 200 from the instant streaming begins regardless of how the turn concludes — status codes cannot carry an SSE outcome. `mini_chat_outcomes_total{outcome}` is the metric recorded from inside the stream once it actually finishes, and it is the one that answers "did this work." The endpoint authenticates with a static bearer token (`METRICS_TOKEN`) rather than OIDC, because a Prometheus `scrape_configs:` entry can supply a shared secret but cannot run an Authorization Code flow; unset in production it fails closed, same as the OIDC gate, until `METRICS_OPEN=true` says otherwise on purpose.

## Why this way

The honest alternative was keeping the transcript in the browser and replaying it whole. It is simpler and it works — until the history is three weeks long, at which point cost grows every turn, a cleared cache is amnesia, and there is no answer to "what did I ask on 3 November" beyond "send everything and hope." Since that question *is* the evaluation, the memory had to be durable, server-side, and queryable by date.

SQLite over Postgres because the brief requires `npm install && npm run dev` to just work. `node:sqlite` is zero-dependency and zero-config, and nothing outside `lib/memory/store.ts` knows it is SQLite.

## Found while building this

The eval corpus is the first thing in this project to seed several *unrelated* topics into one person's memory and then ask about one of them — every earlier test seeded either one topic, or topics kept apart by date. That mix found a real bug: `lib/memory/store.ts`'s topic search built its FTS5 query from every word over two characters with no stopword filter, so two turns with nothing in common topically — *"tell me a fact **about** the Eiffel Tower"* and *"I asked you **about** Postgres hosting"* — matched each other on the word "about" alone. On a small corpus (a new user, or this eval's own fixture) that is enough to pull unrelated history into a request; at real scale it would have been a slow, constant leak of irrelevant context into every recall. Fixed with a stopword list, confirmed by reproducing the exact failure before and after, and pinned by a named regression case in both `lib/memory/memory.test.ts` and the eval corpus.

## Considered and rejected

- **Memory as a second tool.** The cleanest agentic design, and disallowed — one tool. Server-side retrieval turned out better anyway: no round-trip, lower latency.
- **Vector search / embeddings.** Real cost and a moving part, to beat FTS5 on a single user's chat history. Date recall carries most of the weight; BM25 carries the rest. Worth revisiting at scale, not before.
- **Replaying full history.** Linear cost growth and a hard wall. Its caps actively fought the thing being tested.
- **LLM-summarised rolling memory.** Lossy exactly where precision matters — "you said $20/month on 3 November" must survive verbatim.
- **A second model call to plan retrieval.** Doubles latency on every turn to replace a regex and a BM25 query.
- **A globally shared response cache.** An identical scrubbed prompt does imply an identical answer, so sharing across users is sound in principle — but the prompt carries recalled history, and a key that is correct only because of a subtle argument breaks the first time someone adds a field. Owner-scoped by default, `LLM_CACHE_SCOPE=global` to opt in.
- **A roles table in the database.** Would need its own CRUD, its own admin UI, and a sync problem with whatever already manages identity. Reading roles out of the token the IdP already signs means one source of truth and nothing new to keep consistent.
- **Caching on the question alone.** Far higher hit rate, and wrong: it throws away the conversation the answer depends on.
- **Backend-for-frontend auth with `httpOnly` token cookies.** More secure than `sessionStorage`, but costs a client secret and server session state; noted as the upgrade path.
- **Nonce-based CSP.** Needs per-request middleware; `script-src` keeps `'unsafe-inline'` for Next's hydration bootstrap. Called out rather than glossed.
- **Hand-rolled Prometheus text output.** The exposition format has sharp edges — cumulative histogram buckets, `HELP`/`TYPE` lines, label escaping — that are easy to get subtly wrong in a way a scraper won't complain about until a bucket is silently off. Used `@prometheus-io/client` (the official successor to the now-deprecated `prom-client`, same maintainers, same API, moved under the Prometheus org scope) rather than write a serializer for a format with one canonical implementation already.
- **OIDC for the metrics endpoint.** Consistent with the rest of the app, but a Prometheus `scrape_configs:` entry cannot run an Authorization Code flow — its native options are a static bearer token, basic auth, or mTLS. A separate shared secret is what the scraper can actually hold.

## What I'd do with another week

1. **Verify claims, not just recall them.** Extract dated factual claims ("Pipedrive was $29/seat on 3 Nov") into their own table, so "has anything changed?" becomes a structured diff the model reports rather than a comparison it performs in prose. This is the biggest remaining win.
2. **Proactive staleness.** Knowing a claim's age, flag it unprompted: "you asked about this on Monday — one of those prices has moved."
3. **LLM-judge grading for `eval:live`**, replacing the keyword rubric with a second model call scoring the answer against a written rubric — more robust to a correctly-phrased answer the keyword list did not anticipate, at the cost of a second call per case and judge variance to manage.
4. **Redis-backed rate limits.** The in-memory store is per-instance, so on serverless the real ceiling is the limit times the instance count.
5. **A durable, queryable audit log for admin actions**, not just a server-log line — who read what, when, searchable by admin or by target user.
6. **Retrieval quality.** Recency-weighted BM25, query expansion from the live thread ("them" → the five CRM tools), a relevance floor so a weak single-word FTS match cannot surface a row at all, and a cheap reranker over the candidate set.
7. **Streaming recall UI.** Show which past messages were pulled in and let the user correct them — memory you can see and edit beats memory you have to trust.
8. **Grafana dashboards and alert rules** on top of the new `/api/metrics` — the data exists; nothing yet turns `mini_chat_outcomes_total{outcome="error"}` climbing into a page.

## Guardrails

Rate limits (15/min, 150/hour per caller, keyed on the authenticated subject), a 1 MB body cap, 32k characters per message, 5 searches and 55 seconds per turn. Search results are treated strictly as data: the system prompt forbids following instructions found on a page, and structurally the one tool is read-only, so there is nothing destructive for an injection to reach. CSP, `frame-ancestors 'none'`, `nosniff`, HSTS. OAuth2/OIDC is optional but fails closed — half-configured, or production with no issuer, serves nothing until `AUTH_OPTIONAL=true` is spelled out.

## Running it

`npm install`, put `ANTHROPIC_API_KEY` in `.env` (see `.env.example`), `npm run dev`. `npm run test` for 112 unit tests; `npm run verify` drives six end-to-end suites (memory, cache, RBAC, metrics, OIDC, guardrails) against the real routes over HTTP; `npm run eval` runs the brief's own question shapes structurally for free, `npm run eval:live` against the real model for a few cents.
