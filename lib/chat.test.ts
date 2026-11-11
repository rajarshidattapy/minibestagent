import { test } from "node:test";
import assert from "node:assert/strict";
import {
  blocksToText,
  extractSources,
  localStamp,
  readEvents,
  searchErrors,
} from "./chat.ts";
import type { ContentBlock, StreamEvent } from "./types.ts";

function ndjson(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      // Split mid-line on purpose: chunk boundaries never align with newlines.
      const payload = lines.join("");
      for (let i = 0; i < payload.length; i += 7) {
        controller.enqueue(encoder.encode(payload.slice(i, i + 7)));
      }
      controller.close();
    },
  });
}

test("readEvents reassembles frames split across chunks", async () => {
  const stream = ndjson([
    `${JSON.stringify({ type: "status", status: "searching" })}\n`,
    `${JSON.stringify({ type: "text", text: "hello " })}\n`,
    `${JSON.stringify({ type: "text", text: "world" })}\n`,
    // Last line deliberately has no trailing newline.
    JSON.stringify({ type: "done", content: [], stopReason: "end_turn" }),
  ]);

  const events: StreamEvent[] = [];
  for await (const event of readEvents(stream)) events.push(event);

  assert.equal(events.length, 4);
  assert.deepEqual(
    events.filter((e) => e.type === "text").map((e) => e.text),
    ["hello ", "world"],
  );
  assert.equal(events.at(-1)?.type, "done");
});

test("extractSources reads citations and dedupes by URL", () => {
  const content: ContentBlock[] = [
    { type: "server_tool_use", name: "web_search", input: { query: "f1" } },
    {
      type: "web_search_tool_result",
      content: [
        { type: "web_search_result", title: "Race report", url: "https://a.com/x" },
        { type: "web_search_result", title: "Dupe", url: "https://a.com/x" },
        { type: "web_search_result", url: "https://b.com/y" },
      ],
    },
    { type: "text", text: "The race was won by..." },
  ];

  assert.deepEqual(extractSources(content), [
    { title: "Race report", url: "https://a.com/x" },
    // No title in the payload, so the URL stands in for one.
    { title: "https://b.com/y", url: "https://b.com/y" },
  ]);
});

test("a failed search is an object, not a list, and must not crash or cite", () => {
  // Search errors arrive as HTTP 200 with an error object where the result
  // list would be. Indexing it blindly is the bug this guards.
  const content: ContentBlock[] = [
    {
      type: "web_search_tool_result",
      content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" },
    },
  ];

  assert.deepEqual(extractSources(content), []);
  assert.deepEqual(searchErrors(content), ["max_uses_exceeded"]);
});

test("blocksToText joins text blocks and ignores the rest", () => {
  assert.equal(blocksToText("plain user string"), "plain user string");
  assert.equal(
    blocksToText([
      { type: "thinking", thinking: "" },
      { type: "text", text: "part one. " },
      { type: "web_search_tool_result", content: [] },
      { type: "text", text: "part two." },
    ]),
    "part one. part two.",
  );
});

test("localStamp renders the local wall clock the model is told about", () => {
  const iso = new Date(2026, 10, 11, 14, 32).toISOString();
  assert.equal(localStamp(iso), "2026-11-11 14:32");
});
