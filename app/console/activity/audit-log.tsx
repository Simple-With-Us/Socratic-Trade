"use client";

/** User-scoped GET /api/audit — last 200 events, filterable by kind. */

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Ago, Card, Chip, Empty, TextInput } from "../ui/primitives";
import { SENTENCE_GAP } from "../lib/format";
import {
  fetchAuditEvents,
  filterAuditEvents,
  formatAuditPayloadPreview,
  OperatorDiagnosticError,
  type AuditEvent
} from "../lib/operator-diagnostics";

export function AuditLogPanel() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [kindQuery, setKindQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetchAuditEvents()
      .then((rows) => {
        if (!cancelled) setEvents(rows);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof OperatorDiagnosticError ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const visible = useMemo(() => filterAuditEvents(events, kindQuery), [events, kindQuery]);

  return (
    <Card title="Raw Events">
      <p className="mb-3 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
        Raw audit events for this account (newest 200).{SENTENCE_GAP}Filter is local — the server
        query is unchanged.
      </p>
      <div className="mb-3 max-w-sm">
        <TextInput
          value={kindQuery}
          onChange={(event) => setKindQuery(event.target.value)}
          placeholder="Filter by kind"
          aria-label="Filter audit events by kind"
        />
      </div>
      {error && (
        <div className="mb-3 flex items-start gap-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-warn)]">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {loading ? (
        <div className="py-8 text-center text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
          Loading audit events...
        </div>
      ) : visible.length === 0 ? (
        <Empty>{kindQuery.trim() ? "No events match that kind." : "No audit events yet."}</Empty>
      ) : (
        <div className="divide-y divide-[color:var(--con-line)]">
          {visible.map((event) => (
            <details key={event.id} className="py-2.5">
              <summary className="cursor-pointer text-[length:var(--con-fs-xs)]">
                <span className="ml-1 inline-flex flex-wrap items-center gap-2">
                <Chip tone="muted" className="con-mono">
                  {event.kind}
                </Chip>
                <span className="text-[color:var(--con-faint)]">
                  <Ago iso={event.createdAt} />
                </span>
                <span className="min-w-0 truncate text-[color:var(--con-muted)]">
                  {formatAuditPayloadPreview(event.payload)}
                </span>
                </span>
              </summary>
              <pre className="mt-2 overflow-x-auto rounded-control bg-[color:var(--con-surface-2)] p-3 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
                {safeJson(event.payload)}
              </pre>
            </details>
          ))}
        </div>
      )}
    </Card>
  );
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
