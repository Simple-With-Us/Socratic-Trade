"use client";

// Admin transcript view: the chat conversation with the MODEL that produced each assistant reply
// (chat_turns.model). Reads GET /api/chat-history for the resolved user, chronological order.

import { useCallback, useEffect, useState } from "react";
import { Card } from "../../ui/primitives";
import { Markdown } from "../../ui/markdown";

interface Turn {
  id: string;
  role: "user" | "assistant";
  text: string;
  intent: string | null;
  model: string | null;
  redacted: boolean;
  createdAt: string;
}

export function TranscriptClient() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/chat-history?limit=200");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { turns: Turn[] };
      setTurns(body.turns ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load transcript");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="mx-auto min-h-screen max-w-4xl bg-base p-6 text-fg">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-fg">Chat Transcript</h1>
          <p className="mt-1 text-sm text-muted">Every chat turn, with the model that produced each assistant reply.</p>
        </div>
        <button
          onClick={() => void load()}
          className="rounded-md border border-line bg-surface-2 px-3 py-1 text-xs text-muted transition-colors hover:text-fg"
        >
          Refresh
        </button>
      </div>

      {loading && <p className="text-sm text-muted">Loading…</p>}
      {error && <p className="text-sm text-down">{error}</p>}
      {!loading && !error && turns.length === 0 && <p className="text-sm text-muted">No chat turns yet.</p>}

      <div className="space-y-3">
        {turns.map((t) => (
          <Card key={t.id} className="p-3">
            <div className="mb-1 flex flex-wrap items-center gap-2 text-xs">
              <span className={t.role === "assistant" ? "font-medium text-accent" : "font-medium text-fg"}>
                {t.role === "assistant" ? "Assistant" : "You"}
              </span>
              {t.role === "assistant" && (
                <span className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-muted">{t.model ?? "—"}</span>
              )}
              {t.intent && <span className="text-muted">· {t.intent}</span>}
              {t.redacted && <span className="text-down">· redacted</span>}
              <span className="ml-auto text-faint">{new Date(t.createdAt).toLocaleString()}</span>
            </div>
            {t.role === "assistant" ? (
              <Markdown>{t.text}</Markdown>
            ) : (
              <p className="whitespace-pre-wrap text-sm text-fg">{t.text}</p>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}
