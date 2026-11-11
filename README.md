# mini

A fast chat agent with one tool — web search — that remembers what you asked and when.

See [`design.md`](./design.md) for why it is built this way.

## Run it

```bash
npm install
cp .env.local.example .env.local   # then put your key in it
npm run dev                        # http://localhost:3000
```

Get a key at [console.anthropic.com](https://console.anthropic.com/settings/keys). `ANTHROPIC_API_KEY` is the only variable needed to chat.

## Authentication

`/api/chat` can require a signed OAuth 2.0 / OIDC access token. Set `OIDC_ISSUER` and `OIDC_AUDIENCE` and every request is checked for **signature, issuer, audience and expiry** before it costs you a token. Add `NEXT_PUBLIC_OIDC_ISSUER` and `NEXT_PUBLIC_OIDC_CLIENT_ID` and the UI gains sign-in via Authorization Code + PKCE. Works with any OIDC provider — Auth0, Clerk, Cognito, Okta, Entra, Keycloak. See [`.env.local.example`](./.env.local.example).

Leaving the `OIDC_*` variables unset runs without auth. That is fine locally, but **in production it fails closed with a 500** until you either configure an issuer or set `AUTH_OPTIONAL=true`, so a forgotten variable can never quietly leave the endpoint open.

## Checks

```bash
npm run test         # parsing, stream framing, and token verification
npm run verify:oidc  # drives the auth gate against a throwaway local OIDC issuer
npm run typecheck
npm run build
```

## Layout


| Path                    | What it does                                                                      |
| ----------------------- | --------------------------------------------------------------------------------- |
| `app/page.tsx`          | The chat UI. Owns the transcript and persists it to `localStorage`.               |
| `app/api/chat/route.ts` | Stateless streaming endpoint. One Claude call per turn, web search attached.      |
| `lib/chat.ts`           | Stream framing, citation extraction, timestamp formatting.                        |
| `lib/types.ts`          | Shared shapes, deliberately free of SDK imports so the client bundle stays small. |
| `lib/auth.ts`           | Token verification: signature, issuer, audience, expiry.                          |
| `lib/oauth.ts`          | Browser sign-in: Authorization Code + PKCE, token refresh.                        |


## Notes

- **The transcript is the memory.** Each message you send is stamped with your local time before it goes to the model, so "what did I ask you this morning?" is a question it can actually answer. History lives in your browser and survives refreshes; **Clear** wipes it.
- **It searches when it should.** The model decides; you will see *Searching for "…"* and a row of source links on any answer that used the web.
- **Nothing is stored on the server.** Swapping in a database means changing where `app/page.tsx` loads and saves the transcript — the API route never needs to know.

