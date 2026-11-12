# Design notes

The brief gives three example questions, and they all have the same shape once you squint at them: recall something from a past conversation, work out what day that actually was, go check whether it's still true, and say what changed. That's not really three separate features to build (memory, dates, web search), it's one thing. So that's what I treated it as, and most of the decisions below fall out of taking that seriously instead of bolting a "memory" feature onto a chatbot afterward.

## How it works

Each turn is one streaming call to Claude. Web search is Anthropic's own server-side tool, so the model decides when to search and the search itself runs on their infrastructure. There's no tool loop on my end, no framework managing it, nothing extra in between. The API route *is* the whole control flow for a turn.

The part I actually spent my time on is memory. Every turn gets written to a small SQLite database (`node:sqlite`, which ships inside Node now, so there's nothing extra to install for it). When a new message comes in, I build the context for the model out of three things:

1. **The live thread**, last 24 turns, sent as-is, because most of a conversation is just... a conversation.
2. **Date recall.** If the question names a day ("on Monday", "last Tuesday", "3 November"), I resolve that to an actual date and pull whatever was said then, across *every* conversation that person has had, not just the current thread.
3. **Topic recall**, for the follow-ups that don't name a day at all ("has that changed since?"). This is just SQLite's full-text search over everything that's ever been said.

There's a constraint that shaped more of this than I expected: the brief says one tool. So memory can't be a second tool the model calls, it has to be something the server figures out and hands over before the model is even invoked. I resisted that a little at first, because "the model decides what to recall" felt like the more elegant design. But doing it server-side turned out better anyway. There's no extra round trip, so it costs nothing in latency, and I can reach into the full conversation history with plain SQL instead of hoping the model asks the right retrieval question.

When something is recalled, it goes in as a separate system message after the user's turn, not spliced into the transcript. Partly that's hygiene (it keeps "things I said" and "things fetched on my behalf" visibly distinct), and partly it's so the cached prompt prefix stays untouched. The block tells the model plainly that these are old extracts, that they were true when said and might not be now, and to go verify before repeating anything from them as current fact.

Cost-wise, only the new message ever goes over the wire. The server already has the history, so a long conversation doesn't get more expensive to answer with every turn, which is the opposite of what you'd get if the browser just replayed the whole transcript each time. That's actually what the first version of this did, before memory needed to survive a cleared cache and reach back further than the current tab.

## Who's allowed to do what

Authentication and authorization ended up being two separate files on purpose. `lib/auth.ts` verifies a JWT and tells you who's asking. `lib/rbac.ts` is the completely separate question of what they're allowed to do once you know that, because a valid, signed, perfectly legitimate token can still be told no. Roles are read straight out of the token's own claims rather than kept in some second table here, since identity providers don't agree on where to put them (a plain `roles` array, Keycloak's `realm_access.roles`, Cognito's `cognito:groups`, a scope string), so the claim path is a setting, not something I can hardcode and hope for.

There are three roles. `user` is the floor: send a message, read your own history. This is also what anyone gets by default if their token doesn't carry a role the app recognizes at all, which matters more than it sounds like, because most OIDC setups never bother configuring custom role claims, and I didn't want "no roles configured" to quietly mean "no access." `readonly` can see conversations but not send. The point of having this one isn't really the restriction itself, it's that it proves the system can *take away* a permission and not just hand out extra ones, which is the direction every RBAC demo I've seen skips. And `admin` can read anyone's conversation by their owner key and hit a small stats endpoint. Every time an admin reads someone else's conversation, it gets written to the server log with who did it and whose history they were looking at. That's the one action in this whole app sensitive enough to deserve a paper trail.

## Making the same question free the second time

If the exact same prompt comes in twice, there's no reason to pay for it twice. The cache key is a hash of everything that could actually change the answer (model, system prompt, tools, effort, the whole message list), with one deliberate scrub: the clock gets stripped down to just the date. Both directions of that matter more than you'd think. If I left the full timestamp in, literally nothing would ever hit the cache twice, because every message has a unique minute stamped on it. But if I'd stripped the date too, "what did I ask yesterday?" would hash identically whether you asked it on a Tuesday or a Wednesday, and the cache would cheerfully hand back the wrong day's answer with total confidence. Day precision is the line where both problems go away.

Freshness itself isn't part of the key at all, it's handled by expiry, and the expiry depends on what kind of answer it was. Something the model pulled from a web search gets 15 minutes, because the whole point of this app is not going stale. Something it answered from its own knowledge gets 12 hours. And only the hash ever gets written to disk, never the prompt itself. A cache shouldn't quietly turn into a second, less careful copy of everyone's conversations.

## Guardrails, and not getting hurt by my own agent

Rate limits per caller, a cap on body size and message length, a ceiling on searches and time per turn: the boring stuff that mostly exists so one bad client or one runaway loop can't turn into a surprising bill. The more interesting one is prompt injection, because this agent's whole job is reading pages it doesn't control. The system prompt is explicit that search results are data, not instructions, and that it should say so out loud if a page tries anything, but I don't actually rely on the model remembering its manners. The real backstop is structural: there's exactly one tool, and it's read-only, so there's nothing destructive on the other side of an injected instruction even if the model did fall for it. Auth follows the same instinct. Half-configured OIDC, or no config at all in production, serves nothing rather than quietly running open; you have to type `AUTH_OPTIONAL=true` on purpose to get that.

## Evals, and the bug they actually caught

The eval cases are close to the brief's own three questions, plus a handful I added to cover the ways recall specifically goes wrong: recalling something it shouldn't, missing something it should've found with no date given, that kind of thing. There are two ways to run it. For free against a mock model, which checks everything that doesn't depend on what the model actually says (did recall fire, from the right day, and not fire when it shouldn't). And for real money against the actual API, which additionally grades whether the answer mentions the right specifics and whether it searched when it should have.

Building the free version is actually what found a real bug, which I think is a better argument for writing evals than anything I could say about them in the abstract. Once I had a corpus with a few unrelated topics seeded into one person's history at once (something none of my earlier tests happened to do), a question about Postgres hosting pulled in a completely unrelated turn about the Eiffel Tower. Turned out the full-text search had no stopword filtering, so "tell me a fact **about** the Eiffel Tower" and "I asked you **about** Postgres hosting" matched each other on the word "about" and nothing else. Harmless-looking on a tiny eval fixture, but at real scale that's a slow, constant leak of irrelevant context into every single recall. Fixed it with a stopword list, confirmed the fix by reproducing the exact failure before and after, and left a regression test for it in both places, the unit tests and the eval corpus, so it can't quietly come back.

## Watching it once it's actually running

`/api/metrics` serves Prometheus's text format: request counts and latency per route, how long the model takes and how many tokens it uses (tagged by whichever model actually answered, so a fallback shows up instead of hiding), cache hit rate, rate limit rejections, auth failures by reason. None of it is tagged by user or conversation. Metrics aren't access-controlled the way the conversation data is, so nothing that could identify someone goes anywhere near them.

One thing took a moment to get right: `/api/chat` streams its response, so the HTTP status is 200 from the first byte regardless of how the turn actually ends up going. A status code just can't carry that information for a streamed response. So there's a separate counter, recorded from inside the stream once it genuinely finishes, that's the real signal for whether a turn worked, was cut off, got refused, or errored. That's the one to actually watch, not the HTTP status.

## Getting it onto a real server

This is the part I added last, and it's genuinely two separate jobs: Terraform for what exists, Ansible for what's configured on it. I kept them that way instead of letting one bleed into the other. The instance's `user_data` only installs Python so Ansible has something to connect with, nothing more, specifically so there's no shell script anywhere that could accidentally reformat the data volume on a reboot.

It's one instance, not a Fargate service or an autoscaling group, and that's not me being lazy about it. It follows directly from everything above: the whole memory and cache story lives in one SQLite file on one disk. A second instance wouldn't be more capacity, it'd just be a second, different, equally confident copy of somebody's conversation history. If this ever needs to scale out for real, that has to start with swapping SQLite for Postgres and the in-memory rate limiter for Redis (both already called out below), not with throwing more compute at the current design.

There's no SSH key anywhere in this setup, on purpose. Every connection, mine and Ansible's both, goes through AWS Systems Manager, using the instance's own IAM role, so there's nothing to generate, rotate, or leave lying around in a `.pem` file. Secrets follow the same logic: they live in SSM Parameter Store, created by hand once, and the instance pulls them itself using its own role at deploy time. The machine running Terraform or Ansible never needs permission to read a single one of them. And because losing the one EBS volume this all depends on would mean actually losing people's history, there's a nightly job that takes a proper SQLite-safe snapshot and ships it to S3. Terraform also refuses to let `destroy` touch that volume at all, unless someone deliberately removes that guard first.

## What I thought about and didn't do

- **Memory as a second tool.** Would've been the tidier agentic design, and the brief rules it out anyway, one tool. Turned out to be the right call regardless: server-side retrieval is faster and doesn't depend on the model asking the right question.
- **Embeddings instead of full-text search.** Real infrastructure to beat SQLite's FTS5 on one person's chat history. Date recall is doing most of the actual work anyway; worth revisiting if this ever has to serve a much bigger corpus, not before.
- **Just replaying the whole conversation from the browser.** Simplest possible thing, and it's what I actually started with, until the conversation gets long, the cache gets cleared, and there's no honest answer to "what did I ask on the 3rd" beyond "send everything and hope."
- **Summarizing old turns with the model instead of storing them verbatim.** Lossy exactly where it can't afford to be. "You told me $20/month on November 3rd" has to survive as those exact words, not a paraphrase of them.
- **A second model call just to decide what to retrieve.** Doubles the latency of every single turn to replace what a regex and a database query already do for free.
- **Sharing the cache across every user by default.** An identical prompt really does imply an identical answer in principle, but the prompt carries someone's recalled history in it, and that's exactly the kind of thing that's correct today and a quiet bug the next time the prompt shape changes. Scoped per-user by default; there's a flag to opt into sharing it.
- **A roles table in a database somewhere.** Its own CRUD, its own admin screen, and a second source of truth to keep in sync with whatever already manages identity. Reading roles straight out of the token the identity provider already signs means there's exactly one place that's true.
- **Hand-writing the Prometheus text format myself.** It has just enough sharp edges (how histogram buckets accumulate, exact label escaping) that getting it subtly wrong wouldn't even show up until a dashboard quietly lied. Used the standard library for it instead of being clever.
- **A VPC module, a load balancer, more than one instance.** All the right calls the day there's a second instance to isolate traffic across. There isn't one, and the data model is the reason why not, see above.

## What I'd do with another week

1. Stop comparing "then" and "now" in prose and start storing it structurally: pull dated claims like "Pipedrive was $29/seat on the 3rd" into their own table, so checking whether something changed is a real diff instead of the model eyeballing two paragraphs. This is the one I'd do first.
2. Have it bring up staleness on its own sometimes, not just when asked. "You asked about this on Monday, and one of those prices has actually moved since."
3. Swap the keyword-matching grader in the live eval for a second model call that reads the answer against a written rubric. Costs more and adds some judge variance to manage, but it stops punishing a correct answer that just happened to phrase itself differently than I guessed it would.
4. Move the rate limiter to Redis. Right now it's in-process memory, so the moment this runs as more than one instance, each one is quietly enforcing its own separate limit instead of one shared one.
5. A real audit log for admin reads, queryable by who did it or whose data they looked at, not just a line in the server log.
6. Better ranking on the recall side: weight by recency, expand short pronouns like "them" against the live thread before searching, and put a relevance floor in so one weak, coincidental word match can't surface a row on its own.
7. Show people which old messages got pulled into their answer, and let them correct it if it's wrong. Memory you can actually see and fix is worth more than memory you just have to trust.
8. A dashboard and some actual alerts on top of the metrics that already exist. Right now nothing pages anyone when the error outcome counter starts climbing, even though the data to notice that is already being collected.

## Running it

`npm install`, drop `ANTHROPIC_API_KEY` into `.env` (see `.env.example` for everything else that's optional), `npm run dev`. There are 112 unit tests (`npm run test`), six end-to-end suites that drive the real routes over HTTP (`npm run verify`, covering memory, cache, RBAC, metrics, OIDC, guardrails), and the eval corpus (`npm run eval` for free, `npm run eval:live` for a few real cents against the actual model). `deploy/` has Terraform and Ansible for putting it on an actual AWS box, with its own README for the parts that are specific to doing that safely.
