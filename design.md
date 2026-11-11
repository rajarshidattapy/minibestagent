# Design: Minimal Web-Search Chat Agent

A single-process chat agent with exactly one tool — web search — built to answer fast, answer correctly, and remember every question and when it was asked.

## Goals

1. **Fast** — first token on screen in well under a second of model latency overhead; no client-side tool loop round-trips.
2. **Right** — search the web whenever the answer could be stale or unknown; cite sources.
3. **Remembers** — full conversation history with a timestamp on every user turn, so "what did I ask you this morning?" works.

## Architecture (one API call per turn)

```
user input ──► append to history ──► POST /v1/messages (streaming) ──► stream text to user
                     ▲                        │
                     └── append response ◄────┘
                         content blocks
```

There is deliberately **no agent framework and no client-side tool loop**. The one tool is Anthropic's **server-side web search tool** (`web_search_20260209`): Claude decides when to search, the search runs on Anthropic's infrastructure, and results come back inside the same response. One request per user turn is the entire control flow, which is what makes the agent both simple and fast.

## Model and request shape

| Setting | Value | Why |
|---|---|---|
| Model | `claude-opus-5-5` | Current default Opus: strong, cheap ($4/$20 per MTok), 1M context. |
| Thinking | omit (adaptive, always on) | Opus 5.5 rejects `disabled`; adaptive adds depth only when needed. |
| Effort | `output_config: {effort: "low"}` | Chat is latency-sensitive; low effort means less preamble, faster answers. Opus 5.5 defaults to `medium`, so set it explicitly. |
| Streaming | always (`.stream()` + `get_final_message()`) | Tokens appear as generated — the dominant factor in *perceived* speed. |
| `max_tokens` | 16000 | Room for a searched, cited answer without risking truncation. |
| Fallbacks | `betas: ["server-side-fallback-2026-07-01"]`, `fallbacks: "default"` | If a safety classifier declines (`stop_reason: "refusal"`), the API retries on a fallback model automatically instead of showing the user an error. |

### The one tool

```json
{
  "type": "web_search_20260209",
  "name": "web_search",
  "max_uses": 5
}
```

- `max_uses: 5` caps latency on any single turn.
- The `_20260209` variant does dynamic filtering internally — do **not** also declare a code-execution tool.
- **Error handling:** search errors return HTTP 200 with an error *object* (not a list) in the `web_search_tool_result` block's `content` — branch on that shape, never index blindly.
- **`pause_turn`:** if `stop_reason == "pause_turn"`, append the response content and re-send immediately; it's the server pausing a long search turn, not an error.

### System prompt (short, frozen)

```
You are a concise, accurate chat assistant with web search.
- Search when the answer involves current events, prices, versions,
  schedules, or anything you are not certain of. Otherwise answer directly.
- Cite sources for searched facts.
- Each user message is prefixed with its timestamp; use these to answer
  questions about what was asked and when.
```

Frozen byte-for-byte: the current date/time lives in each user message, never here (see caching).

## Memory: what was asked, and when

Memory is the message history itself — no vector DB, no summaries to drift out of sync.

1. **App-side log**: every turn is appended to a JSONL file: `{role, content, ts}` with an ISO-8601 timestamp. This survives restarts and is the source of truth.
2. **In-context timestamps**: each user message is sent as
   `[2026-11-11 14:32 local] <user's text>` — so the model itself can answer "when did I ask about X?".
3. **Append-only history**: after every response, append the **full `response.content` block list** (not just the text) back onto `messages`. This is required anyway — Opus 5.5's preserved-thinking check rejects edited history, and compaction blocks must round-trip intact.
4. **Long conversations**: 1M context covers weeks of chat. Beyond that, enable server-side **compaction** (beta header `compact-2026-01-12`); the API summarizes old turns automatically at ~150K tokens. Because the JSONL log is kept separately, nothing is ever truly lost even after compaction.

## Speed: prompt caching

Latency and cost per turn stay flat as history grows by caching the stable prefix:

- Render order is `tools → system → messages`; the tool list and system prompt never change, so everything up to the last turn is a cache hit.
- Put `cache_control: {type: "ephemeral"}` on the last message of the prior history each turn.
- Timestamps go **inside new user messages only** — a timestamp in the system prompt would invalidate the whole cache every turn.
- Verify in logs: `usage.cache_read_input_tokens > 0` on turn 2 onward; zero means a silent invalidator crept in.

Net effect per turn: one streamed request, ~90% of input tokens read from cache at $0.20/MTok.

## Error handling

Most-specific-first chain: `RateLimitError` (retry with backoff — SDK already retries twice) → `APIStatusError` (surface message) → `APIConnectionError` (retry once, then tell the user). Check `stop_reason` before reading content: `refusal` is handled by the server-side fallback; `max_tokens` means the answer was cut — tell the user rather than silently showing a truncated reply.

## What's intentionally left out

- **No RAG / vector memory** — history + timestamps in context already answers "what/when did I ask"; 1M context makes retrieval unnecessary at this scale.
- **No client-side tool loop / tool runner** — the only tool is server-side.
- **No multi-model routing** — one model keeps one cache namespace; low effort on Opus 5.5 is already fast.
- **No framework** — the whole agent is a system prompt, a JSONL file, and one streaming API call in a loop.

## Pseudocode

```python
client = Anthropic()
history = load_jsonl()  # [{role, content}], timestamps already inline

while True:
    text = input("> ")
    user_msg = {"role": "user", "content": f"[{now_iso()}] {text}"}
    history.append(user_msg); log(user_msg)

    while True:
        with client.beta.messages.stream(
            model="claude-opus-5-5",
            max_tokens=16000,
            output_config={"effort": "low"},
            system=SYSTEM_PROMPT,
            tools=[{"type": "web_search_20260209", "name": "web_search", "max_uses": 5}],
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            messages=with_cache_breakpoint(history),
        ) as stream:
            for chunk in stream.text_stream:
                print(chunk, end="", flush=True)
            msg = stream.get_final_message()

        history.append({"role": "assistant", "content": msg.content})
        log_assistant(msg)
        if msg.stop_reason != "pause_turn":
            break
```
