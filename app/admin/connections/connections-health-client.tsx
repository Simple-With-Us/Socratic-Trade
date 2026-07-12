"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, Chip, Dot, Tabs } from "../../ui/primitives";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ServiceHealthSummary {
  service: string;
  keySource: string | null;
  lastSuccessTs: string | null;
  lastSuccessLatencyMs: number | null;
  lastFailureTs: string | null;
  lastFailureError: string | null;
  callsLastHour: number;
  callsLast24h: number;
  stoppedWorking: boolean;
  stoppedReason: string | null;
}

interface HealthLogRow {
  id: string;
  service: string;
  ts: string;
  ok: number;
  latency_ms: number | null;
  error_text: string | null;
}

interface ErrorPatternRow {
  id: string;
  service: string;
  fingerprint: string;
  error_text: string;
  first_seen: string;
  last_seen: string;
  count: number;
  key_source: string | null;
}

interface HealthData {
  services: ServiceHealthSummary[];
  errorPatterns: Record<string, ErrorPatternRow[]>;
  asOf: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function relTime(iso: string | null): string {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

function statusTone(s: ServiceHealthSummary): "up" | "down" | "warn" | "neutral" {
  if (s.stoppedWorking) return "down";
  if (!s.lastSuccessTs) return s.callsLast24h > 0 ? "warn" : "neutral";
  if (s.lastFailureTs && s.lastFailureTs > s.lastSuccessTs) return "warn";
  return "up";
}

// ── Service card ──────────────────────────────────────────────────────────────

function ServiceCard({
  summary,
  onClick,
  selected,
}: {
  summary: ServiceHealthSummary;
  onClick: () => void;
  selected: boolean;
}) {
  const tone = statusTone(summary);

  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left transition-colors rounded-2xl border ${
        selected
          ? "border-accent bg-accent/8"
          : "border-line bg-surface/80 hover:bg-surface-2"
      } p-4 backdrop-blur-sm`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Dot tone={tone} pulse={summary.stoppedWorking} />
          <span className="font-medium text-sm truncate">
            {summary.service}
            {summary.keySource && (
              <span className="ml-1 text-xs font-normal text-muted">({summary.keySource})</span>
            )}
          </span>
        </div>
        {summary.stoppedWorking && (
          <Chip tone="down">STOPPED</Chip>
        )}
      </div>

      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted">
        <span>Last OK: <span className="text-fg">{relTime(summary.lastSuccessTs)}</span></span>
        <span>Last fail: <span className="text-fg">{relTime(summary.lastFailureTs)}</span></span>
        <span>1h calls: <span className="text-fg">{summary.callsLastHour}</span></span>
        <span>24h calls: <span className="text-fg">{summary.callsLast24h}</span></span>
      </div>

      {summary.lastSuccessLatencyMs !== null && (
        <div className="mt-1 text-xs text-faint">
          Last latency: {summary.lastSuccessLatencyMs}ms
        </div>
      )}

      {summary.stoppedWorking && summary.stoppedReason && (
        <div className="mt-2 text-xs text-down">{summary.stoppedReason}</div>
      )}
    </button>
  );
}

// ── Detail drawer ─────────────────────────────────────────────────────────────

type DrawerTab = "log" | "errors";

function ServiceDetail({
  summary,
  errorPatterns,
  asOf,
}: {
  summary: ServiceHealthSummary;
  errorPatterns: ErrorPatternRow[];
  asOf: string;
}) {
  const [tab, setTab] = useState<DrawerTab>("log");
  const [log, setLog] = useState<HealthLogRow[]>([]);
  const [loadingLog, setLoadingLog] = useState(false);

  useEffect(() => {
    if (tab !== "log") return;
    setLoadingLog(true);
    const ksParam = summary.keySource !== null ? `&keySource=${encodeURIComponent(summary.keySource)}` : "&keySource=";
    fetch(`/api/admin/connections-health?service=${encodeURIComponent(summary.service)}&limit=100${ksParam}`)
      .then((r) => r.json())
      .then((data) => setLog(data.log ?? []))
      .catch(() => setLog([]))
      .finally(() => setLoadingLog(false));
  }, [summary.service, summary.keySource, tab, asOf]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-sm">
          {summary.service}
          {summary.keySource && (
            <span className="ml-1.5 text-xs font-normal text-muted">({summary.keySource})</span>
          )}
        </h3>
        <Tabs<DrawerTab>
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "log", label: "Raw Log" },
            { id: "errors", label: `Error Patterns (${errorPatterns.length})` },
          ]}
        />
      </div>

      {tab === "log" && (
        <div className="overflow-x-auto rounded-xl border border-line">
          {loadingLog ? (
            <div className="py-8 text-center text-xs text-muted">Loading…</div>
          ) : log.length === 0 ? (
            <div className="py-8 text-center text-xs text-muted">No log entries</div>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-line bg-surface-2">
                  <th className="px-3 py-2 text-left text-muted font-medium">Time</th>
                  <th className="px-3 py-2 text-left text-muted font-medium">Status</th>
                  <th className="px-3 py-2 text-left text-muted font-medium">Latency</th>
                  <th className="px-3 py-2 text-left text-muted font-medium">Error</th>
                </tr>
              </thead>
              <tbody>
                {log.map((row) => (
                  <tr key={row.id} className="border-b border-line/50 hover:bg-surface-2">
                    <td className="px-3 py-1.5 text-faint whitespace-nowrap">{relTime(row.ts)}</td>
                    <td className="px-3 py-1.5">
                      {row.ok ? (
                        <Chip tone="up">OK</Chip>
                      ) : (
                        <Chip tone="down">FAIL</Chip>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-muted">
                      {row.latency_ms !== null ? `${row.latency_ms}ms` : "—"}
                    </td>
                    <td className="px-3 py-1.5 text-down truncate max-w-xs">
                      {row.error_text ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === "errors" && (
        <div className="overflow-x-auto rounded-xl border border-line">
          {errorPatterns.length === 0 ? (
            <div className="py-8 text-center text-xs text-muted">No error patterns</div>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-line bg-surface-2">
                  <th className="px-3 py-2 text-left text-muted font-medium">Error</th>
                  <th className="px-3 py-2 text-left text-muted font-medium">Count</th>
                  <th className="px-3 py-2 text-left text-muted font-medium">First seen</th>
                  <th className="px-3 py-2 text-left text-muted font-medium">Last seen</th>
                </tr>
              </thead>
              <tbody>
                {errorPatterns.map((p) => (
                  <tr key={p.id} className="border-b border-line/50 hover:bg-surface-2">
                    <td className="px-3 py-1.5 text-down font-mono truncate max-w-xs">{p.error_text}</td>
                    <td className="px-3 py-1.5 font-semibold">{p.count}</td>
                    <td className="px-3 py-1.5 text-faint whitespace-nowrap">{relTime(p.first_seen)}</td>
                    <td className="px-3 py-1.5 text-faint whitespace-nowrap">{relTime(p.last_seen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function ConnectionsHealthClient() {
  const [data, setData] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const fetch_ = useCallback(() => {
    fetch("/api/admin/connections-health")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d: HealthData) => {
        setData(d);
        setError(null);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetch_();
    const interval = setInterval(fetch_, 30_000);
    return () => clearInterval(interval);
  }, [fetch_]);

  const laneKey = (s: ServiceHealthSummary) => `${s.service}:${s.keySource ?? ""}`;
  const selectedSummary = data?.services.find((s) => laneKey(s) === selected) ?? null;
  const stoppedCount = data?.services.filter((s) => s.stoppedWorking).length ?? 0;

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">API Connections Health</h1>
          {data?.asOf && (
            <p className="text-xs text-muted mt-0.5">Last updated {relTime(data.asOf)}</p>
          )}
        </div>
        <div className="flex items-center gap-3">
          {stoppedCount > 0 && (
            <Chip tone="down">{stoppedCount} stopped</Chip>
          )}
          <a
            href="/"
            className="text-xs text-muted hover:text-fg transition-colors"
          >
            ← Dashboard
          </a>
        </div>
      </div>

      {loading && !data && (
        <div className="py-16 text-center text-sm text-muted">Loading…</div>
      )}

      {error && (
        <Card className="p-4 border-down/40 bg-down/5">
          <p className="text-sm text-down">{error}</p>
        </Card>
      )}

      {data && (
        <div className={`grid gap-4 ${selectedSummary ? "lg:grid-cols-[380px_1fr]" : "grid-cols-1"}`}>
          {/* Service grid */}
          <div className="space-y-3">
            {data.services.length === 0 ? (
              <Card className="p-8 text-center">
                <p className="text-sm text-muted">No API calls recorded yet.</p>
                <p className="text-xs text-faint mt-1">
                  Health data appears after the first scan or enrichment fetch.
                </p>
              </Card>
            ) : (
              <>
                {/* Stopped services first */}
                {data.services
                  .slice()
                  .sort((a, b) => {
                    if (a.stoppedWorking !== b.stoppedWorking) return a.stoppedWorking ? -1 : 1;
                    const svcCmp = a.service.localeCompare(b.service);
                    if (svcCmp !== 0) return svcCmp;
                    return (a.keySource ?? "").localeCompare(b.keySource ?? "");
                  })
                  .map((s) => (
                    <ServiceCard
                      key={laneKey(s)}
                      summary={s}
                      selected={selected === laneKey(s)}
                      onClick={() => setSelected(selected === laneKey(s) ? null : laneKey(s))}
                    />
                  ))}
              </>
            )}
          </div>

          {/* Detail panel */}
          {selectedSummary && (
            <Card className="p-4 self-start sticky top-4">
              <ServiceDetail
                summary={selectedSummary}
                errorPatterns={data.errorPatterns[laneKey(selectedSummary)] ?? []}
                asOf={data.asOf}
              />
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
