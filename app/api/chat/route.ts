import Anthropic from "@anthropic-ai/sdk";
import { authorizeRequest, challengeHeader } from "@/lib/auth";
import type { ApiMessage, ContentBlock, StreamEvent } from "@/lib/types";

export const runtime = "nodejs";
// A searched answer can take a while; give it room before the platform cuts us off.
export const maxDuration = 60;

const MODEL = "claude-opus-5-5";
const MAX_TOKENS = 16000;
/** Caps how many times we resume a server-paused turn before giving up. */
const MAX_RESUMES = 4;

// Frozen byte-for-byte: the clock lives in each user message, never here, so
// the cached prefix survives from turn to turn.
const SYSTEM_PROMPT = `You are a concise, accurate chat assistant with web search.

- Search the web when the answer involves current events, prices, versions, schedules, or anything you are not certain of. Otherwise answer directly from what you know - do not search for arithmetic, definitions, or opinions.
- Cite your sources for anything you searched.
- Lead with the answer, then add detail. Prefer short paragraphs over long lists.
- Each user message is prefixed with the local time it was sent. Use those timestamps to answer questions about what was asked and when, and say the time plainly (for example "about 20 minutes ago, at 2:32 PM").
- Never invent a fact or a citation. If a search comes back empty or fails, say so.`;

const WEB_SEARCH = {
  type: "web_search_20260209" as const,
  name: "web_search" as const,
  max_uses: 5,
};

function isApiMessage(value: unknown): value is ApiMessage {
  if (!value || typeof value !== "object") return false;
  const m = value as Record<string, unknown>;
  if (m.role !== "user" && m.role !== "assistant") return false;
  return typeof m.content === "string" || Array.isArray(m.content);
}

/** Turn an SDK/network failure into something worth showing a user. */
function describeError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) {
    return "The ANTHROPIC_API_KEY is missing or invalid.";
  }
  if (err instanceof Anthropic.RateLimitError) {
    return "Rate limited by the API. Wait a moment and try again.";
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return "Could not reach the API. Check your connection and try again.";
  }
  if (err instanceof Anthropic.APIError) {
    return `API error ${err.status ?? "?"}: ${err.message}`;
  }
  return err instanceof Error ? err.message : "Unknown error.";
}

/** A human-readable note for the stop reasons that mean the answer is incomplete. */
function noticeFor(stopReason: string | null): string | undefined {
  if (stopReason === "max_tokens") {
    return "This answer was cut off at the length limit.";
  }
  if (stopReason === "refusal") {
    return "The model declined to answer this one.";
  }
  if (stopReason === "pause_turn") {
    return "The search ran long and was stopped before finishing. Try asking again, more narrowly.";
  }
  return undefined;
}

export async function POST(request: Request) {
  // Authenticate before reading the body, so an unauthenticated caller cannot
  // make us do any work beyond verifying their token.
  const auth = await authorizeRequest(request);
  if (!auth.ok) {
    return Response.json(
      { error: auth.description },
      {
        status: auth.status,
        headers:
          auth.status === 401 ? { "WWW-Authenticate": challengeHeader(auth) } : undefined,
      },
    );
  }

  let messages: ApiMessage[];
  try {
    const body = (await request.json()) as { messages?: unknown };
    if (!Array.isArray(body.messages) || !body.messages.every(isApiMessage)) {
      throw new Error("`messages` must be an array of {role, content}.");
    }
    messages = body.messages as ApiMessage[];
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Bad request." },
      { status: 400 },
    );
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json(
      { error: "ANTHROPIC_API_KEY is not set on the server." },
      { status: 500 },
    );
  }

  const client = new Anthropic();
  const encoder = new TextEncoder();

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: StreamEvent) =>
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));

      try {
        // One logical assistant turn. A server-paused turn resumes in place and
        // its blocks are appended here, so history stays strictly alternating.
        const turn: ContentBlock[] = [];
        let stopReason: string | null = null;

        for (let resume = 0; ; resume++) {
          const outgoing = [
            ...messages,
            ...(turn.length ? [{ role: "assistant" as const, content: turn }] : []),
          ];

          const stream = client.beta.messages.stream({
            model: MODEL,
            max_tokens: MAX_TOKENS,
            // Chat is latency-sensitive: low effort means less preamble and a
            // faster first answer. Opus 5.5 defaults to medium, so be explicit.
            output_config: { effort: "low" },
            // Thinking is omitted entirely: that is adaptive on this model.
            system: SYSTEM_PROMPT,
            tools: [WEB_SEARCH],
            // Cache the stable prefix (tools -> system -> prior turns) so cost
            // and latency stay flat as the conversation grows.
            cache_control: { type: "ephemeral" },
            // If a safety classifier declines, the server retries on a fallback
            // model instead of handing the user an error.
            betas: ["server-side-fallback-2026-07-01"],
            fallbacks: "default",
            messages: outgoing as Anthropic.Beta.BetaMessageParam[],
          });

          // Accumulates each search tool's streamed JSON input, keyed by block
          // index, so we can show the query the moment it is complete.
          const toolInput = new Map<number, string>();

          for await (const event of stream) {
            if (event.type === "content_block_start") {
              if (event.content_block.type === "server_tool_use") {
                toolInput.set(event.index, "");
                send({ type: "status", status: "searching" });
              }
            } else if (event.type === "content_block_delta") {
              if (event.delta.type === "text_delta") {
                send({ type: "text", text: event.delta.text });
              } else if (
                event.delta.type === "input_json_delta" &&
                toolInput.has(event.index)
              ) {
                toolInput.set(
                  event.index,
                  toolInput.get(event.index)! + event.delta.partial_json,
                );
              }
            } else if (event.type === "content_block_stop") {
              const raw = toolInput.get(event.index);
              if (raw !== undefined) {
                toolInput.delete(event.index);
                try {
                  const query = (JSON.parse(raw) as { query?: unknown }).query;
                  if (typeof query === "string") {
                    send({ type: "status", status: "searching", query });
                  }
                } catch {
                  // Partial or truncated input - the indicator is already up.
                }
              }
            }
          }

          const message = await stream.finalMessage();
          turn.push(...(message.content as unknown as ContentBlock[]));
          stopReason = message.stop_reason;

          // pause_turn is the server pausing a long search, not an error:
          // replay the partial turn and let it carry on.
          if (stopReason !== "pause_turn" || resume >= MAX_RESUMES) break;
        }

        send({
          type: "done",
          content: turn,
          stopReason,
          notice: noticeFor(stopReason),
        });
      } catch (err) {
        send({ type: "error", message: describeError(err) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      // Tell proxies not to buffer, or streaming silently becomes batching.
      "X-Accel-Buffering": "no",
    },
  });
}
