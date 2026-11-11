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

## Checks

```bash
npm run test       # 54 unit tests: dates, recall, parsing, token verification, guardrails
npm run verify     # all three HTTP suites below
npm run typecheck
npm run build
```

`npm run verify` runs three end-to-end suites against a real server on a throwaway database: `verify:memory` (date and topic recall, per-owner isolation, reload), `verify:oidc` (token verification against a local OIDC issuer), and `verify:guardrails` (limits and security headers).

## Layout


| Path                    | What it does                                                                      |
| ----------------------- | --------------------------------------------------------------------------------- |
| `app/page.tsx`          | The chat UI. Owns the transcript and persists it to `localStorage`.               |
| `app/api/chat/route.ts` | Stateless streaming endpoint. One Claude call per turn, web search attached.      |
| `lib/chat.ts`           | Stream framing, citation extraction, timestamp formatting.                        |
| `lib/memory/dates.ts`   | Turns "3 November" / "last Tuesday" into day ranges.                              |
| `lib/memory/store.ts`   | Durable turns in SQLite, with full-text search.                                   |
| `lib/memory/context.ts` | Assembles each request: live thread + date recall + topic recall.                 |
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

