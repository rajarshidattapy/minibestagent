
/**
 * Input guardrails for /api/chat.
 *
 * The client is untrusted even when authenticated: a signed-in user can still
 * post a hand-rolled body. Every one of these limits exists because exceeding
 * it costs real money or real latency, so they are enforced server-side
 * before a request reaches the model.
 */

/** Hard ceiling on the raw request body. */
export const MAX_BODY_BYTES = 1_000_000;

/**
 * Characters in one user message. ~32k chars is ~8k tokens - generous for a
 * paste, bounded for a bill.
 *
 * Note there is deliberately no cap on conversation *length* any more. The
 * server owns the transcript and assembles each request from recent turns
 * plus targeted recall, so a months-old conversation stays fully recallable
 * without any single request growing. The bound lives at assembly time, in
 * lib/memory/context.ts.
 */
export const MAX_MESSAGE_CHARS = 32_000;

export type GuardrailFailure = { status: 400 | 413; error: string };

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
