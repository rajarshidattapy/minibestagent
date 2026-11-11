"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Source, StoredMessage } from "@/lib/types";
import {
  blocksToText,
  clockLabel,
  dayLabel,
  extractSources,
  readEvents,
  searchErrors,
} from "@/lib/chat";
import {
  authEnabled,
  beginLogin,
  currentUser,
  getAccessToken,
  isSignedIn,
  logout,
} from "@/lib/oauth";

/** Only the conversation id lives in the browser now; the turns live on the server. */
const CONVERSATION_KEY = "mini.conversation.v2";

const EXAMPLES = [
  "What shipped in the last Next.js release?",
  "What did I ask you yesterday?",
  "Is what you told me last week still true?",
];

type Pending = {
  text: string;
  searching: boolean;
  query?: string;
  recall?: { count: number; since: string };
  cachedAt?: string;
};

export default function Page() {
  const [history, setHistory] = useState<StoredMessage[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [user, setUser] = useState<string | null>(null);

  const requiresAuth = authEnabled();
  const signedIn = !requiresAuth || user !== null;

  const threadRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Restore the thread from the server, so a reload (or another device, when
  // signed in) shows the same conversation.
  useEffect(() => {
    let id = localStorage.getItem(CONVERSATION_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(CONVERSATION_KEY, id);
    }
    setConversationId(id);
    if (isSignedIn()) setUser(currentUser());

    (async () => {
      try {
        const token = authEnabled() ? await getAccessToken() : null;
        const response = await fetch(`/api/conversation?id=${encodeURIComponent(id)}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (response.ok) {
          const data = (await response.json()) as { turns: StoredMessage[] };
          setHistory(data.turns);
        }
      } catch {
        // Offline or server down: start empty rather than block the UI.
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight });
  }, [history, pending]);

  const send = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || pending || !conversationId) return;

      const token = requiresAuth ? await getAccessToken() : null;
      if (requiresAuth && !token) {
        setUser(null);
        setError("Your session has expired. Please sign in again.");
        return;
      }

      setError(null);
      setInput("");
      if (textareaRef.current) textareaRef.current.style.height = "auto";

      // Shown immediately; the server is the record of what was actually stored.
      setHistory((h) => [
        ...h,
        {
          id: `local-${crypto.randomUUID()}`,
          role: "user",
          ts: new Date().toISOString(),
          text,
          content: text,
        },
      ]);
      setPending({ text: "", searching: false });

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          signal: controller.signal,
          // Only the new message travels. The server already has the history,
          // so cost per turn no longer grows with the length of the thread.
          body: JSON.stringify({ conversationId, message: text }),
        });

        if (!response.ok || !response.body) {
          const detail = await response
            .json()
            .then((d: { error?: string }) => d.error)
            .catch(() => null);
          if (response.status === 401) setUser(null);
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
          } else if (event.type === "cached") {
            setPending((p) => (p ? { ...p, cachedAt: event.storedAt } : p));
          } else if (event.type === "recall") {
            setPending((p) =>
              p ? { ...p, recall: { count: event.count, since: event.since } } : p,
            );
          } else if (event.type === "error") {
            throw new Error(event.message);
          } else if (event.type === "done") {
            setHistory((h) => [
              ...h,
              {
                id: `local-${crypto.randomUUID()}`,
                role: "assistant",
                ts: new Date().toISOString(),
                content: event.content,
                notice: event.notice,
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
    [conversationId, pending, requiresAuth],
  );

  /** Starts a fresh thread. Earlier conversations stay in memory and remain recallable. */
  const newConversation = () => {
    abortRef.current?.abort();
    const id = crypto.randomUUID();
    localStorage.setItem(CONVERSATION_KEY, id);
    setConversationId(id);
    setHistory([]);
    setError(null);
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
        <div className="header-actions">
          {loaded && requiresAuth && (
            signedIn ? (
              <>
                <span className="who" title={user ?? undefined}>
                  {user}
                </span>
                <button className="ghost-button" onClick={() => void logout()}>
                  Sign out
                </button>
              </>
            ) : (
              <button className="ghost-button" onClick={() => void beginLogin("/")}>
                Sign in
              </button>
            )
          )}
          <button
            className="ghost-button"
            onClick={newConversation}
            disabled={!history.length}
            title="Earlier conversations stay in memory and can still be recalled"
          >
            New chat
          </button>
        </div>
      </header>

      <div className="thread" ref={threadRef}>
        {loaded && !signedIn && (
          <div className="empty">
            <p>Sign in to start chatting.</p>
            <div className="examples">
              <button className="chip" onClick={() => void beginLogin("/")}>
                Sign in
              </button>
            </div>
          </div>
        )}

        {loaded && signedIn && !history.length && !pending && (
          <div className="empty">
            <p>Ask anything.</p>
            <p>
              It searches the web when the answer needs to be current, and remembers
              what you asked and when.
            </p>
            <div className="examples">
              {EXAMPLES.map((example) => (
                <button key={example} className="chip" onClick={() => send(example)}>
                  {example}
                </button>
              ))}
            </div>
          </div>
        )}

        {signedIn &&
          history.map((turn, index) => (
            <Turn
              key={turn.id}
              turn={turn}
              // A date separator, so "you asked that on Monday" is visible.
              showDay={index === 0 || !sameDay(history[index - 1].ts, turn.ts)}
            />
          ))}

        {pending && (
          <div className="turn assistant">
            {pending.recall && (
              <div className="status recall">
                Recalling {pending.recall.count} earlier message
                {pending.recall.count === 1 ? "" : "s"} from{" "}
                {dayLabel(pending.recall.since)}
              </div>
            )}
            {pending.cachedAt && (
              <div className="status recall">
                Answered from cache ({clockLabel(pending.cachedAt)})
              </div>
            )}
            {pending.searching && (
              <div className="status">
                <span className="dot" />
                {pending.query ? `Searching for "${pending.query}"` : "Searching the web"}
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
          disabled={!signedIn}
          placeholder={signedIn ? "Ask anything..." : "Sign in to start chatting"}
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
          <button type="button" className="send" onClick={() => abortRef.current?.abort()}>
            Stop
          </button>
        ) : (
          <button type="submit" className="send" disabled={!input.trim() || !signedIn}>
            Send
          </button>
        )}
      </form>
      <div className="hint">Enter to send, Shift+Enter for a new line.</div>
    </div>
  );
}

function sameDay(a: string, b: string): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

function Turn({ turn, showDay }: { turn: StoredMessage; showDay: boolean }) {
  const isUser = turn.role === "user";
  const body = isUser ? (turn.text ?? "") : blocksToText(turn.content);
  const sources = isUser ? [] : extractSources(turn.content);
  const failures = isUser ? [] : searchErrors(turn.content);

  return (
    <>
      {showDay && <div className="day-separator">{dayLabel(turn.ts)}</div>}
      <div className={`turn ${isUser ? "user" : "assistant"}`}>
        <div className="meta">
          {isUser ? "You" : "mini"} · {clockLabel(turn.ts)}
        </div>
        {sources.length > 0 && <SourceList sources={sources} />}
        {body && <div className="bubble">{body}</div>}
        {turn.notice && <div className="notice">{turn.notice}</div>}
        {failures.length > 0 && (
          <div className="notice">Search failed: {failures.join(", ")}.</div>
        )}
      </div>
    </>
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
