import type { ApiMessage, ContentBlock } from "./types";

/**
 * Input guardrails for /api/chat.
 *
 * The client is untrusted even when authenticated: a signed-in user can still
 * post a hand-rolled body. Every one of these limits exists because exceeding
 * it costs real money or real latency, so they are enforced server-side
 * before a request reaches the model.
 */

/** Hard ceiling on the raw request body. ~1 MB of JSON is a very long chat. */
export const MAX_BODY_BYTES = 1_000_000;

/** Turns in one conversation. 200 messages is ~100 exchanges. */
export const MAX_MESSAGES = 200;

/** Characters in a single message. ~32k chars is ~8k tokens - generous for a paste. */
export const MAX_MESSAGE_CHARS = 32_000;

/**
 * Characters across the whole conversation. ~600k chars is ~150k tokens,
 * which is where server-side compaction would kick in anyway.
 */
export const MAX_TOTAL_CHARS = 600_000;

export type GuardrailFailure = { status: 400 | 413; error: string };

/** Count the characters a message contributes, across every block it holds. */
function messageChars(message: ApiMessage): number {
  if (typeof message.content === "string") return message.content.length;

  let total = 0;
  for (const block of message.content as ContentBlock[]) {
    // Text the user wrote, and text the model produced.
    if (typeof block.text === "string") total += block.text.length;
    // Assistant turns also carry search results, which are real tokens.
    if (typeof block.content === "string") total += block.content.length;
    else if (Array.isArray(block.content)) {
      for (const inner of block.content as ContentBlock[]) {
        if (typeof inner.text === "string") total += inner.text.length;
      }
    }
  }
  return total;
}

/**
 * Check the conversation is a shape and size we are willing to pay for.
 * Returns null when it passes.
 */
export function checkConversation(messages: ApiMessage[]): GuardrailFailure | null {
  if (messages.length === 0) {
    return { status: 400, error: "The conversation is empty." };
  }

  if (messages.length > MAX_MESSAGES) {
    return {
      status: 413,
      error: `This conversation is too long (${messages.length} messages, limit ${MAX_MESSAGES}). Start a new one.`,
    };
  }

  // The model can only answer a user turn; an assistant-final history is
  // either a client bug or someone poking at the endpoint.
  if (messages[messages.length - 1].role !== "user") {
    return { status: 400, error: "The last message must be from the user." };
  }

  let total = 0;
  for (const [index, message] of messages.entries()) {
    const chars = messageChars(message);

    // Only bound what the user writes. Assistant turns are replayed verbatim
    // and are already bounded by max_tokens upstream.
    if (message.role === "user" && chars > MAX_MESSAGE_CHARS) {
      return {
        status: 413,
        error: `Message ${index + 1} is too long (${chars} characters, limit ${MAX_MESSAGE_CHARS}).`,
      };
    }
    total += chars;
  }

  if (total > MAX_TOTAL_CHARS) {
    return {
      status: 413,
      error: `This conversation is too large (${total} characters, limit ${MAX_TOTAL_CHARS}). Start a new one.`,
    };
  }

  return null;
}

/**
 * Point past which we refuse to buffer a body at all, even to reject it
 * politely. Abandoning a body mid-flight leaves the connection unusable, so
 * this is reserved for payloads far beyond anything legitimate.
 */
const REFUSE_TO_BUFFER_BYTES = MAX_BODY_BYTES * 10;

/**
 * Read the body with a size ceiling.
 *
 * Content-Length is only a claim, so the real byte length is what decides.
 * Ordinary oversized bodies are read to completion before being rejected:
 * returning early without draining the request leaves the keep-alive socket
 * half-read, and the client's *next* request on it dies with ECONNRESET.
 */
export async function readBoundedJson(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false; failure: GuardrailFailure }> {
  const tooLarge: GuardrailFailure = {
    status: 413,
    error: `Request body is too large (limit ${MAX_BODY_BYTES} bytes).`,
  };

  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > REFUSE_TO_BUFFER_BYTES) {
    return { ok: false, failure: tooLarge };
  }

  const text = await request.text();
  // Byte length, not character count: multi-byte input would slip past otherwise.
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    return { ok: false, failure: tooLarge };
  }

  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, failure: { status: 400, error: "Request body is not valid JSON." } };
  }
}
