"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Source, StoredMessage } from "@/lib/types";
import {
  blocksToText,
  clockLabel,
  extractSources,
  localStamp,
  readEvents,
  searchErrors,
} from "@/lib/chat";

const STORAGE_KEY = "mini.history.v1";

const EXAMPLES = [
  "What shipped in the last Next.js release?",
  "Who won the F1 race this weekend?",
  "What did I ask you earlier today?",
];

type Pending = {
  text: string;
  searching: boolean;
  query?: string;
};

export default function Page() {
  const [history, setHistory] = useState<StoredMessage[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<string | null>(null);

  const threadRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // The transcript is the memory: load it before the first paint we control.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) setHistory(JSON.parse(saved) as StoredMessage[]);
    } catch {
      // Corrupt or unavailable storage - start clean rather than crash.
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
    } catch {
      // Over quota: the conversation still works for this session.
    }
  }, [history, loaded]);

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight });
  }, [history, pending]);

  const send = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || pending) return;

      setError(null);
      setInput("");
      if (textareaRef.current) textareaRef.current.style.height = "auto";

      const ts = new Date().toISOString();
      const userTurn: StoredMessage = {
        id: crypto.randomUUID(),
        role: "user",
        ts,
        text,
        // The model sees the clock inline, which is how it can answer
        // "what did I ask you an hour ago?".
        content: `[${localStamp(ts)}] ${text}`,
      };

      const next = [...history, userTurn];
      setHistory(next);
      setPending({ text: "", searching: false });

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            messages: next.map(({ role, content }) => ({ role, content })),
          }),
        });

        if (!response.ok || !response.body) {
          const detail = await response
            .json()
            .then((d: { error?: string }) => d.error)
            .catch(() => null);
          throw new Error(detail ?? `Request failed (${response.status}).`);
        }

        for await (const event of readEvents(response.body)) {
          if (event.type === "text") {
            setPending((p) =>
              p ? { ...p, searching: false, text: p.text + event.text } : p,
            );
          } else if (event.type === "status") {
            setPending((p) =>
              p ? { ...p, searching: true, query: event.query ?? p.query } : p,
            );
          } else if (event.type === "error") {
            throw new Error(event.message);
          } else if (event.type === "done") {
            // Store the content blocks verbatim. History is append-only, and
            // replaying the exact blocks is what keeps the model's own state
            // (thinking, search results) intact across turns.
            setHistory((h) => [
              ...h,
              {
                id: crypto.randomUUID(),
                role: "assistant",
                ts: new Date().toISOString(),
                content: event.content,
                text: event.notice,
              },
            ]);
          }
        }
      } catch (err) {
        if (!(err instanceof DOMException && err.name === "AbortError")) {
          setError(err instanceof Error ? err.message : "Something went wrong.");
        }
      } finally {
        abortRef.current = null;
        setPending(null);
      }
    },
    [history, pending],
  );

  const clear = () => {
    abortRef.current?.abort();
    setHistory([]);
    setError(null);
    localStorage.removeItem(STORAGE_KEY);
  };

  return (
    <div className="app">
      <header className="header">
        <div>
          <h1 className="title">mini</h1>
          <div className="subtitle">
            Web search, and a memory of what you asked and when.
          </div>
        </div>
        <button
          className="ghost-button"
          onClick={clear}
          disabled={!history.length}
        >
          Clear
        </button>
      </header>

      <div className="thread" ref={threadRef}>
        {loaded && !history.length && !pending && (
          <div className="empty">
            <p>Ask anything.</p>
            <p>It searches the web when the answer needs to be current.</p>
            <div className="examples">
              {EXAMPLES.map((example) => (
                <button
                  key={example}
                  className="chip"
                  onClick={() => send(example)}
                >
                  {example}
                </button>
              ))}
            </div>
          </div>
        )}

        {history.map((turn) => (
          <Turn key={turn.id} turn={turn} />
        ))}

        {pending && (
          <div className="turn assistant">
            {pending.searching && (
              <div className="status">
                <span className="dot" />
                {pending.query
                  ? `Searching for "${pending.query}"`
                  : "Searching the web"}
              </div>
            )}
            {pending.text ? (
              <div className="bubble">{pending.text}</div>
            ) : (
              !pending.searching && (
                <div className="status">
                  <span className="dot" />
                  Thinking
                </div>
              )
            )}
          </div>
        )}

        {error && <div className="error">{error}</div>}
      </div>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
      >
        <textarea
          ref={textareaRef}
          value={input}
          rows={1}
          placeholder="Ask anything..."
          onChange={(e) => {
            setInput(e.target.value);
            e.target.style.height = "auto";
            e.target.style.height = `${e.target.scrollHeight}px`;
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(input);
            }
          }}
        />
        {pending ? (
          <button
            type="button"
            className="send"
            onClick={() => abortRef.current?.abort()}
          >
            Stop
          </button>
        ) : (
          <button type="submit" className="send" disabled={!input.trim()}>
            Send
          </button>
        )}
      </form>
      <div className="hint">Enter to send, Shift+Enter for a new line.</div>
    </div>
  );
}

function Turn({ turn }: { turn: StoredMessage }) {
  const isUser = turn.role === "user";
  const body = isUser ? (turn.text ?? "") : blocksToText(turn.content);
  const sources = isUser ? [] : extractSources(turn.content);
  const failures = isUser ? [] : searchErrors(turn.content);

  return (
    <div className={`turn ${isUser ? "user" : "assistant"}`}>
      <div className="meta">
        {isUser ? "You" : "mini"} · {clockLabel(turn.ts)}
      </div>
      {sources.length > 0 && <SourceList sources={sources} />}
      {body && <div className="bubble">{body}</div>}
      {!isUser && turn.text && <div className="notice">{turn.text}</div>}
      {failures.length > 0 && (
        <div className="notice">Search failed: {failures.join(", ")}.</div>
      )}
    </div>
  );
}

function SourceList({ sources }: { sources: Source[] }) {
  return (
    <div className="sources">
      {sources.map((source) => (
        <a
          key={source.url}
          className="source"
          href={source.url}
          target="_blank"
          rel="noreferrer noopener"
          title={source.url}
        >
          {hostOf(source.url)} · {source.title}
        </a>
      ))}
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "source";
  }
}
