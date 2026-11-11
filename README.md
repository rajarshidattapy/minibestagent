# mini

A fast chat agent with one tool — web search — that remembers what you asked and when. Next.js App Router, deployable as-is.

See [`design.md`](./design.md) for why it is built this way.

## Run it

```bash
npm install
cp .env.local.example .env.local   # then put your key in it
npm run dev                        # http://localhost:3000
```

Get a key at [console.anthropic.com](https://console.anthropic.com/settings/keys). The only variable is `ANTHROPIC_API_KEY`.

## Deploy it

Push the repo, then import it on [Vercel](https://vercel.com/new) and set `ANTHROPIC_API_KEY` in **Settings → Environment Variables**. No other configuration, no database, no build flags — the server is stateless, so any Node host works the same way.

```bash
npx vercel --prod    # or just use the dashboard
```

## Checks

```bash
npm run test       # parsing and stream-framing tests
npm run typecheck
npm run build
```

## Layout

| Path | What it does |
|---|---|
| `app/page.tsx` | The chat UI. Owns the transcript and persists it to `localStorage`. |
| `app/api/chat/route.ts` | Stateless streaming endpoint. One Claude call per turn, web search attached. |
| `lib/chat.ts` | Stream framing, citation extraction, timestamp formatting. |
| `lib/types.ts` | Shared shapes, deliberately free of SDK imports so the client bundle stays small. |

## Notes

- **The transcript is the memory.** Each message you send is stamped with your local time before it goes to the model, so "what did I ask you this morning?" is a question it can actually answer. History lives in your browser and survives refreshes; **Clear** wipes it.
- **It searches when it should.** The model decides; you will see *Searching for "…"* and a row of source links on any answer that used the web.
- **Nothing is stored on the server.** Swapping in a database means changing where `app/page.tsx` loads and saves the transcript — the API route never needs to know.
