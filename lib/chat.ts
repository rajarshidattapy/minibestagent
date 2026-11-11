import type { ContentBlock, Source, StreamEvent } from "./types";

/** "2026-11-11 14:32" in the user's own timezone - what the model sees. */
export function localStamp(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/** "Today", "Yesterday", or "3 November 2026" - the transcript's date separator. */
export function dayLabel(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);

  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";

  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    // Only show the year when it is not the current one.
    year: date.getFullYear() === today.getFullYear() ? undefined : "numeric",
  });
}

/** "2:32 PM" - the clock shown next to a bubble. */
export function clockLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Concatenate every text block, which is what a turn reads as. */
export function blocksToText(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b) => b.type === "text")
    .map((b) => (typeof b.text === "string" ? b.text : ""))
    .join("");
}

/**
 * Pull citations out of `web_search_tool_result` blocks, deduped by URL.
 * A successful result's `content` is an array; an errored one is a single
 * object (`{error_code: ...}`), so the array check is load-bearing.
 */
export function extractSources(content: string | ContentBlock[]): Source[] {
  if (typeof content === "string") return [];
  const seen = new Map<string, Source>();
  for (const block of content) {
    if (block.type !== "web_search_tool_result") continue;
    const results = block.content;
    if (!Array.isArray(results)) continue;
    for (const r of results as ContentBlock[]) {
      if (r?.type !== "web_search_result") continue;
      const url = typeof r.url === "string" ? r.url : null;
      if (!url || seen.has(url)) continue;
      const title = typeof r.title === "string" && r.title ? r.title : url;
      seen.set(url, { title, url });
    }
  }
  return [...seen.values()];
}

/** Any search error codes the server returned, for an honest "search failed" notice. */
export function searchErrors(content: string | ContentBlock[]): string[] {
  if (typeof content === "string") return [];
  const codes: string[] = [];
  for (const block of content) {
    if (block.type !== "web_search_tool_result") continue;
    const result = block.content;
    if (Array.isArray(result) || !result || typeof result !== "object") continue;
    const code = (result as ContentBlock).error_code;
    if (typeof code === "string") codes.push(code);
  }
  return codes;
}

/** Read an NDJSON body, yielding one parsed frame per line. */
export async function* readEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<StreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) yield JSON.parse(line) as StreamEvent;
    }
  }

  const tail = buffer.trim();
  if (tail) yield JSON.parse(tail) as StreamEvent;
}
