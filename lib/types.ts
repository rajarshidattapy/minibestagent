// Shared, SDK-free shapes. Kept free of `@anthropic-ai/sdk` imports so the
// client bundle does not pull the SDK in.

/** An opaque Claude content block. We never rewrite these - only store and replay. */
export type ContentBlock = { type: string; [key: string]: unknown };

/** Exactly what gets sent to the Messages API. */
export type ApiMessage = {
  role: "user" | "assistant";
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
  /** The user's raw text, without the timestamp prefix. */
  text?: string;
};

export type Source = { title: string; url: string };

/** NDJSON frames sent from /api/chat to the browser. */
export type StreamEvent =
  | { type: "status"; status: "searching"; query?: string }
  | { type: "text"; text: string }
  | {
      type: "done";
      content: ContentBlock[];
      stopReason: string | null;
      notice?: string;
    }
  | { type: "error"; message: string };
