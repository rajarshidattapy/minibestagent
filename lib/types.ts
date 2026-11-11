// Shared, SDK-free shapes. Kept free of `@anthropic-ai/sdk` imports so the
// client bundle does not pull the SDK in.

/** An opaque Claude content block. We never rewrite these - only store and replay. */
export type ContentBlock = { type: string; [key: string]: unknown };

/**
 * Exactly what gets sent to the Messages API. `system` is the
 * mid-conversation operator channel, used to inject recalled memory.
 */
export type ApiMessage = {
  role: "user" | "assistant" | "system";
  content: string | ContentBlock[];
};

/**
 * One turn as the browser stores it. `content` is the verbatim API payload;
 * `ts` and `text` exist only for rendering.
 */
export type StoredMessage = ApiMessage & {
  id: string;
  /** ISO-8601 time the turn was created. */
  ts: string;
  /** The turn's plain text, without the timestamp prefix. */
  text?: string;
  /**
   * A warning about this turn ("cut off at the length limit"). Kept separate
   * from `text`: overloading one field meant a reloaded answer rendered
   * twice, once as the reply and once as a warning.
   */
  notice?: string;
};

export type Source = { title: string; url: string };

/** NDJSON frames sent from /api/chat to the browser. */
export type StreamEvent =
  | { type: "status"; status: "searching"; query?: string }
  /** Older turns were pulled from memory and given to the model. */
  | { type: "recall"; count: number; since: string }
  /** Served from the response cache; no model call was made. */
  | { type: "cached"; storedAt: string }
  | { type: "text"; text: string }
  | {
      type: "done";
      content: ContentBlock[];
      stopReason: string | null;
      notice?: string;
    }
  | { type: "error"; message: string };
