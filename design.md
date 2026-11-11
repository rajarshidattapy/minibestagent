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

## What is intentionally left out

- **No RAG or vector memory** — transcript plus inline timestamps already answers "what did I ask, and when"; at this scale 1M context makes retrieval pure overhead.
- **No client-side tool loop or tool runner** — the only tool runs on Anthropic's servers.
- **No multi-model routing** — one model is one cache namespace, and low effort on Opus 5.5 is already fast.
- **No CSS framework or component library** — one stylesheet, zero runtime dependencies in the UI.
- **No server-side storage** — the thing that would otherwise turn a one-variable deploy into infrastructure.

## Tests

`lib/chat.test.ts` (`npm run test`) covers the parsing layer, where silent breakage would otherwise live: NDJSON frames reassembled across chunk boundaries that do not align with newlines, citation extraction and URL dedupe, the failed-search error object that must not be indexed as a list, text extraction across mixed block types, and the local-time stamp the model is handed.

Verified locally: `npm run test` (5/5), `npm run typecheck`, `npm run build`, and the route's streaming, validation, and error paths over HTTP. Live model output needs a real `ANTHROPIC_API_KEY`.
