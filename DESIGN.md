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

## Why this way

The honest alternative was keeping the transcript in the browser and replaying it whole. It is simpler and it works — until the history is three weeks long, at which point cost grows every turn, a cleared cache is amnesia, and there is no answer to "what did I ask on 3 November" beyond "send everything and hope." Since that question *is* the evaluation, the memory had to be durable, server-side, and queryable by date.

SQLite over Postgres because the brief requires `npm install && npm run dev` to just work. `node:sqlite` is zero-dependency and zero-config, and nothing outside `lib/memory/store.ts` knows it is SQLite.

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

## What I'd do with another week

1. **Verify claims, not just recall them.** Extract dated factual claims ("Pipedrive was $29/seat on 3 Nov") into their own table, so "has anything changed?" becomes a structured diff the model reports rather than a comparison it performs in prose. This is the biggest remaining win.
2. **Proactive staleness.** Knowing a claim's age, flag it unprompted: "you asked about this on Monday — one of those prices has moved."
3. **Evals over the brief's question shapes.** A fixture corpus with seeded history and a graded set of recall/re-verification questions, so retrieval changes are measured rather than eyeballed. Currently 85 unit tests plus five HTTP suites, but no end-to-end answer-quality harness.
4. **Redis-backed rate limits.** The in-memory store is per-instance, so on serverless the real ceiling is the limit times the instance count.
5. **A durable, queryable audit log for admin actions**, not just a server-log line — who read what, when, searchable by admin or by target user.
6. **Retrieval quality.** Recency-weighted BM25, query expansion from the live thread ("them" → the five CRM tools), and a cheap reranker over the candidate set.
7. **Streaming recall UI.** Show which past messages were pulled in and let the user correct them — memory you can see and edit beats memory you have to trust.

## Guardrails

Rate limits (15/min, 150/hour per caller, keyed on the authenticated subject), a 1 MB body cap, 32k characters per message, 5 searches and 55 seconds per turn. Search results are treated strictly as data: the system prompt forbids following instructions found on a page, and structurally the one tool is read-only, so there is nothing destructive for an injection to reach. CSP, `frame-ancestors 'none'`, `nosniff`, HSTS. OAuth2/OIDC is optional but fails closed — half-configured, or production with no issuer, serves nothing until `AUTH_OPTIONAL=true` is spelled out.

## Running it

`npm install`, put `ANTHROPIC_API_KEY` in `.env` (see `.env.example`), `npm run dev`. `npm run test` for 70 unit tests; `npm run verify:oidc` and `npm run verify:guardrails` drive auth and limits over real HTTP.
