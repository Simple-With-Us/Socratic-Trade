"use client";

// Admin transcript view: the chat conversation with the MODEL that produced each assistant reply
// (chat_turns.model). Reads GET /api/admin/transcript — the requireAdmin-gated, cross-user read —
// in chronological order.
//
// This deliberately does NOT read /api/chat-history. That endpoint is the per-caller Coach history
// shared with the console assistant and iOS, so it only ever returned the viewing admin's own turns
// while this page's nav promised "every chat turn". Each turn now carries its userId so a turn from
// another account is attributable rather than silently blended in.

import { useCallback, useEffect, useState } from "react";
import { Btn, Card } from "../../console/ui/primitives";
import { Markdown } from "./markdown";
import { describeLongTurn } from "./long-turn";
import { describeProbeNetworkError, describeProbeStatus, type ProbeErrorDescription } from "../lib/probe-error";

interface Turn {
  id: string;
  userId: string;
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
  const [error, setError] = useState<ProbeErrorDescription | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/transcript?limit=200");
      if (!res.ok) {
        setError(describeProbeStatus(res.status));
        return;
      }
      const body = (await res.json()) as { turns: Turn[] };
      setTurns(body.turns ?? []);
    } catch {
      setError(describeProbeNetworkError());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Chat Transcript</h1>
          <p className="mt-1 text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">Every chat turn, with the model that produced each assistant reply.</p>
        </div>
        <Btn variant="outline" size="sm" onClick={() => void load()}>
          Refresh
        </Btn>
      </div>

      {loading && <p className="text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">Loading…</p>}
      {error && (
        <p className="text-[length:var(--con-fs-sm)] text-[color:var(--con-neg)]" title={error.rawLabel}>
          {error.message}
        </p>
      )}
      {!loading && !error && turns.length === 0 && (
        <p className="text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">No chat turns yet.</p>
      )}

      <div className="space-y-3">
        {turns.map((t) => {
          const long = describeLongTurn(t.text);
          const body =
            t.role === "assistant" ? (
              <Markdown>{t.text}</Markdown>
            ) : (
              <p className="whitespace-pre-wrap text-[length:var(--con-fs-sm)]">{t.text}</p>
            );
          return (
            <Card key={t.id}>
              {/* Metadata header stays OUTSIDE the disclosure: who spoke, which model,
                  intent, redaction, and when are what you scan an audit view for, and they
                  must stay readable whether or not the body is collapsed. */}
              <div className="mb-1 flex flex-wrap items-center gap-2 text-[length:var(--con-fs-xs)]">
                {/* Display label only — the persisted role stays "assistant"; the product
                    calls this voice the Coach everywhere else. The user side reads "User", not
                    "You": this view spans every account, so a turn here need not be the viewer's. */}
                <span className={t.role === "assistant" ? "font-medium text-[color:var(--con-accent)]" : "font-medium text-[color:var(--con-fg)]"}>
                  {t.role === "assistant" ? "Coach" : "User"}
                </span>
                <span className="con-chip con-mono" title="Account this turn belongs to">{t.userId}</span>
                {t.role === "assistant" && (
                  <span className="con-chip con-mono">{t.model ?? "—"}</span>
                )}
                {t.intent && <span className="text-[color:var(--con-muted)]">· {t.intent}</span>}
                {t.redacted && <span className="text-[color:var(--con-neg)]">· redacted</span>}
                <span className="ml-auto text-[color:var(--con-faint)]">{new Date(t.createdAt).toLocaleString(undefined, { timeZone: "America/Chicago" })}</span>
              </div>
              {long.collapse ? (
                <details className="con-disclosure">
                  <summary className="flex items-center gap-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
                    <span className="con-disclosure-label" />
                    <span>{long.label}</span>
                  </summary>
                  <div className="mt-2">{body}</div>
                </details>
              ) : (
                body
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
