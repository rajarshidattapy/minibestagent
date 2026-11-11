# Design: Minimal Web-Search Chat Agent

A chat agent with exactly one tool — web search — built to answer fast, answer correctly, and remember every question and when it was asked. Implemented as a Next.js App Router app so it deploys with a single environment variable.

## Goals

1. **Fast** — tokens on screen as they are generated; no client-side tool round-trips; flat latency as the conversation grows.
2. **Right** — search the web whenever the answer could be stale or unknown, and cite sources.
3. **Remembers** — the full transcript with a timestamp on every user turn, so "what did I ask you this morning?" works.

## Architecture: one API call per turn

```
browser                            /api/chat (stateless)         Anthropic
───────                            ─────────────────────         ─────────
transcript in localStorage
  + new user turn  ──── POST ────►  stream Messages request ────►  Claude
                                                                     │
                                                                  web search
                                                                  (server-side)
                                                                     │
  render deltas  ◄──── NDJSON ────  forward text + status    ◄───────┘
  append blocks  ◄──── "done"  ───  final content blocks
```

There is deliberately **no agent framework and no client-side tool loop**. The one tool is Anthropic's **server-side web search tool** (`web_search_20260209`): Claude decides when to search, the search executes on Anthropic's infrastructure, and the results arrive inside the same response. One request per user turn is the entire control flow — which is what makes the agent both simple and fast.

The route handler is **stateless**. It holds no session, writes no files, and needs no database, so it runs identically on Vercel, Fly, a container, or a laptop.

## Model and request shape

`app/api/chat/route.ts`

| Setting | Value | Why |
|---|---|---|
| Model | `claude-opus-5-5` | Current default Opus: strong, 1M context, $4/$20 per MTok. |
| Thinking | omitted | On this model omitting it *is* adaptive thinking. `disabled` and `budget_tokens` are both rejected with a 400. |
| Effort | `output_config: { effort: "low" }` | Chat is latency-sensitive; low effort means less preamble and a faster first answer. The model defaults to `medium`, so this is set explicitly. |
| Streaming | always | Perceived speed is dominated by time-to-first-token, not total time. |
| `max_tokens` | 16000 | Room for a searched, cited answer without risking truncation. |
| Caching | top-level `cache_control: { type: "ephemeral" }` | Automatic prefix caching — no manual breakpoint placement to get wrong. |
| Fallbacks | `betas: ["server-side-fallback-2026-07-01"]`, `fallbacks: "default"` | If a safety classifier declines (`stop_reason: "refusal"`), the server retries on a fallback model instead of handing the user an error. |

### The one tool

```ts
{ type: "web_search_20260209", name: "web_search", max_uses: 5 }
```

- `max_uses: 5` caps worst-case latency on any single turn.
- The `_20260209` variant does dynamic filtering internally, so no code-execution tool is declared alongside it.
- **Search errors do not throw.** They return HTTP 200 with an error *object* where the result *list* would be. `extractSources` checks `Array.isArray` before iterating, and `searchErrors` surfaces the `error_code` to the user rather than silently showing an uncited answer. Both are covered by a test.
- **`pause_turn` is not an error.** It means the server paused a long search. The route replays the partial assistant turn and lets it continue, up to `MAX_RESUMES = 4`; resumed blocks are **merged into the one assistant turn** so history stays strictly alternating. If it is still paused at the cap, the user is told the search ran long instead of being shown a truncated answer as if it were complete.

### System prompt

Frozen byte-for-byte — the clock lives in each user message, never in the system prompt, because a timestamp here would invalidate the cache prefix on every single turn. It covers: when to search and when not to, cite sources, lead with the answer, read the per-message timestamps, and never invent a fact or a citation.

## Memory: what was asked, and when

Memory is the transcript itself — no vector store, no summarisation that can drift out of sync with what was actually said.

1. **Durable log in the browser.** `app/page.tsx` keeps the transcript in `localStorage`. This is what makes the server stateless and the deploy one variable; it survives refreshes, and it is per-device by construction. Moving it to a database means changing where the page loads and saves — the API route never needs to know.
2. **In-context timestamps.** Each user message is sent as `[2026-11-11 14:32] <text>`, in the user's own timezone. That is how the model itself can answer "when did I ask about X?" — no tool call, no retrieval step. The raw text and the ISO timestamp are stored alongside for rendering, so the prefix never shows up in the UI.
3. **Verbatim, append-only history.** The **full content-block array** from each response is stored and replayed, not just the extracted text. This matters: thinking blocks and search results must round-trip unchanged, Opus 5.5's preserved-thinking check rejects edited history, and compaction blocks are what the API uses to replace compacted turns. Turns are only ever appended.
4. **Long conversations.** 1M context covers a very long chat. Beyond that, enable server-side compaction (beta `compact-2026-01-12`) and the API summarises old turns at ~150K tokens automatically; because the browser keeps the raw transcript separately, the human-readable record is never lost.

## Speed

- **Streaming end to end.** The route forwards NDJSON frames (`status`, `text`, `done`, `error`) as they arrive, with `X-Accel-Buffering: no` so a proxy cannot quietly turn streaming back into batching.
- **Prompt caching.** Render order is `tools → system → messages`; the tool list and system prompt never change, so everything up to the newest turn is a cache hit at $0.20/MTok. Verify with `usage.cache_read_input_tokens > 0` from turn two onward — zero means a silent invalidator crept into the prefix.
- **Low effort.** The largest single lever on chat latency, and the cheapest to set.
- **Visible progress.** A *Searching for "…"* indicator appears the moment the query is parsed out of the streamed tool input, so a multi-second search never looks like a hang.

## Honesty and failure modes

Every path that produces an incomplete answer says so, rather than rendering a partial reply as if it were whole:

| Condition | Behaviour |
|---|---|
| `stop_reason: "max_tokens"` | Text is kept, with "this answer was cut off at the length limit". |
| `stop_reason: "refusal"` | Server-side fallback usually handles it; if the fallback also declines, the user is told. |
| `stop_reason: "pause_turn"` at the resume cap | "The search ran long and was stopped before finishing." |
| Search returned an error object | "Search failed: `<error_code>`." |
| Auth / rate limit / connection | Specific-first error chain (`AuthenticationError` → `RateLimitError` → `APIConnectionError` → `APIError`), sent as an `error` frame. |

## Authentication

`/api/chat` is an OAuth 2.0 **resource server**. Browser sign-in uses **Authorization Code + PKCE** (RFC 7636) — no client secret, because anything shipped to a browser is readable by its user.

### The four checks

Every token clears four independent checks in `lib/auth.ts` before a request is served. Any one failing is a 401 with an RFC 6750 `WWW-Authenticate` challenge.

| Check | How |
|---|---|
| **Signature** | Verified against the issuer's public JWKS, fetched via OIDC discovery and cached. The `kid` in the token header selects the key. |
| **Issuer** | `iss` must equal `OIDC_ISSUER` exactly. The discovery document's own `issuer` is also checked against it, so a hijacked discovery response cannot point us at someone else's keys. |
| **Audience** | `aud` must contain `OIDC_AUDIENCE`. This is what stops a valid token minted for a *different* API behind the same issuer from working here. |
| **Expiry** | `exp` is enforced with 60s of clock tolerance, and `exp` is a *required* claim — a token without one would otherwise pass the expiry check vacuously and never die. `nbf` is honoured too. |

### The algorithm allowlist

`ALLOWED_ALGORITHMS` is asymmetric-only and is the single most important line in the file. Without it:

- a token declaring `alg: "none"` verifies with no signature at all; and
- a token signed **HS256** can be forged by anyone, using the issuer's *public* key as the HMAC secret — the classic algorithm-confusion attack, since the public key is by definition public.

Both are covered by tests that attempt the forgery and assert rejection.

### Failing closed

`authMode()` has three states, and the default on any ambiguity is to refuse:

- **`enforced`** — issuer and audience both set.
- **`disabled`** — nothing set, outside production. A local convenience.
- **`misconfigured`** — anything else, including *half*-configured and production-without-config. Returns 500 and serves nothing.

Running an open endpoint in production therefore requires typing `AUTH_OPTIONAL=true` in full. A typo'd or forgotten variable can never silently produce a public endpoint — the failure is loud and immediate rather than invisible.

### Known tradeoff: token storage

Access and refresh tokens live in `sessionStorage`, so they are script-readable and an XSS bug would expose them; they are at least scoped to the tab and die with it. This is the standard SPA tradeoff and it buys the stateless, one-variable deploy. If that is not acceptable for your threat model, the alternative is a backend-for-frontend: keep tokens in `httpOnly`, `SameSite=Strict` cookies and have the Next server attach them — which costs a client secret and server-side session state.

## What is intentionally left out

- **No RAG or vector memory** — transcript plus inline timestamps already answers "what did I ask, and when"; at this scale 1M context makes retrieval pure overhead.
- **No client-side tool loop or tool runner** — the only tool runs on Anthropic's servers.
- **No multi-model routing** — one model is one cache namespace, and low effort on Opus 5.5 is already fast.
- **No CSS framework or component library** — one stylesheet, zero runtime dependencies in the UI.
- **No server-side storage** — the thing that would otherwise turn a one-variable deploy into infrastructure.

## Tests

`npm run test` covers the two layers where breakage would otherwise be silent.

**`lib/chat.test.ts`** — the parsing layer: NDJSON frames reassembled across chunk boundaries that do not align with newlines, citation extraction and URL dedupe, the failed-search error object that must not be indexed as a list, text extraction across mixed block types, and the local-time stamp the model is handed.

**`lib/auth.test.ts`** — token verification, against a real key pair generated in the test. Alongside the happy path it asserts rejection of: a token signed by an unrelated key, a tampered payload, `alg: "none"`, an HS256 token signed with the public key as the secret, the wrong issuer, the wrong audience, an expired token, a token with *no* expiry, and a `nbf` in the future. It also pins the clock-skew boundary and the fail-closed configuration matrix.

**`npm run verify:oidc`** stands up a throwaway OIDC issuer on localhost — serving a real discovery document and JWKS — and drives the running app over HTTP. This covers what the unit tests inject around: discovery, remote JWKS fetching, and `kid` lookup.

Verified locally: 21/21 unit tests, 6/6 end-to-end OIDC probes, `npm run typecheck`, `npm run build`, and the gate's behaviour in all five configuration states over HTTP. Live model output still needs a real `ANTHROPIC_API_KEY`, and the browser PKCE flow needs a real identity provider.
