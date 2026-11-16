"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, Chip, Dot, Segmented } from "../../console/ui/primitives";
import { cx } from "../../console/lib/format";
import { describeProbeNetworkError, describeProbeStatus, type ProbeErrorDescription } from "../lib/probe-error";

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
  // Mirrors src/lib/db-health.ts's HealthStoppedReasonKind / HEALTH_LOG_LANE_CAP, re-declared here
  // rather than imported: this is a "use client" component and importing db-health would drag
  // better-sqlite3 into the browser bundle. Both arrive verbatim on the /api/admin/connections-health
  // `services` payload. Optional because that route also synthesizes placeholder rows for lanes that
  // have never logged a call.
  stoppedReasonKind?: "consecutive-failures" | "no-success-ever" | "no-success-this-hour" | "expected-limit" | null;
  laneLogCap?: number;
  /** Product-retired vendor (FMP / Quiver / UW) — render muted OFF, never red STOPPED. */
  intentionalOff?: boolean;
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

/** The health store sets `stoppedWorking` for three different conditions, only one of which is
 *  strong evidence the lane is actually broken: five consecutive failures. The other two ("active
 *  this hour but no success yet" / "no success in 60 min") are soft heuristics that a SINGLE cold
 *  first call can trip, so counting them as "stopped" inflates the header count with lanes that are
 *  merely warming up. This is the same hard/soft split app/api/health/route.ts already uses to
 *  decide what fails liveness versus what is only `degraded` — keep the two consistent.
 *  A stopped lane with no `stoppedReasonKind` (never-seen shape) counts as HARD: fail loud rather
 *  than silently demoting a real outage to a muted chip.
 *  "expected-limit" is soft by definition — a KNOWN quota window (e.g. the Pinecone monthly
 *  write-unit breaker) with a stamped resume date, not a broken integration.
 *  Product-retired vendors (intentionalOff) never count as hard-stopped. */
export function isHardStopped(s: ServiceHealthSummary): boolean {
  if (s.intentionalOff) return false;
  if (!s.stoppedWorking) return false;
  return (
    s.stoppedReasonKind !== "no-success-ever" &&
    s.stoppedReasonKind !== "no-success-this-hour" &&
    s.stoppedReasonKind !== "expected-limit"
  );
}

/** Soft degraded only — excludes intentional OFF and hard stops. Exported for unit tests. */
export function isSoftDegraded(s: ServiceHealthSummary): boolean {
  if (s.intentionalOff) return false;
  return Boolean(s.stoppedWorking) && !isHardStopped(s);
}

/** Window call counts come from a log capped at `laneLogCap` rows per lane, so a count that reached
 *  the cap is a floor. Render it as "500+" — a busy lane pegged at the cap otherwise reads as an
 *  exact (and permanently wrong) total. Exported for direct unit testing. */
export function formatLaneCallCount(count: number, laneLogCap: number | undefined): string {
  if (typeof laneLogCap === "number" && laneLogCap > 0 && count >= laneLogCap) return `${laneLogCap}+`;
  return String(count);
}

function callCountTitle(laneLogCap: number | undefined): string | undefined {
  if (typeof laneLogCap !== "number" || laneLogCap <= 0) return undefined;
  return `Only the most recent ${laneLogCap} calls per lane are retained, so these counts saturate at ${laneLogCap}+.`;
}

/** Exported for unit tests — intentional OFF is always muted grey, never red/yellow alarm. */
export function statusTone(s: ServiceHealthSummary): "pos" | "neg" | "warn" | "muted" {
  if (s.intentionalOff) return "muted";
  if (isHardStopped(s)) return "neg";
  if (s.stoppedWorking) return "warn";
  if (!s.lastSuccessTs) return s.callsLast24h > 0 ? "warn" : "muted";
  if (s.lastFailureTs && s.lastFailureTs > s.lastSuccessTs) return "warn";
  return "pos";
}

/** Sort weight: hard stops first, then soft degraded, then active, then intentional OFF last. */
export function laneSortRank(s: ServiceHealthSummary): number {
  if (s.intentionalOff) return 3;
  if (isHardStopped(s)) return 0;
  if (s.stoppedWorking) return 1;
  return 2;
}

// ── Service card ──────────────────────────────────────────────────────────────

export function formatServiceName(service: string): string {
  if (service === "congress.trade") return "Congress.Trade (Public API)";
  if (service === "earningscalls-dev-rapidapi" || service === "earningscalls" || service === "earningscall") return "EarningsCalls.dev";
  if (service === "roic.ai" || service === "roic") return "ROIC.ai";
  if (service === "usage-monitor") return "Usage-Monitor";
  return service;
}

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
  const hardStopped = isHardStopped(summary);
  const intentionalOff = Boolean(summary.intentionalOff);
  const capTitle = callCountTitle(summary.laneLogCap);

  // Hand-authored card recipe (not .con-card): the con-card class sets
  // background/border in unlayered CSS, which beats Tailwind's layered
  // utilities — so the selected/hover tints would silently never apply.
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        "w-full rounded-[var(--con-radius)] border p-4 text-left shadow-[var(--con-shadow)] transition-colors",
        selected
          ? "border-[color:var(--con-accent)] bg-[color:var(--con-accent-soft)]"
          : "border-[color:var(--con-line)] bg-[color:var(--con-surface)] hover:bg-[color:var(--con-surface-2)]"
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Dot tone={tone} pulse={hardStopped} />
          <span className="truncate text-[length:var(--con-fs-sm)] font-medium">
            {formatServiceName(summary.service)}
            {summary.keySource && (
              <span className="ml-1 text-[length:var(--con-fs-xs)] font-normal text-[color:var(--con-muted)]">({summary.keySource})</span>
            )}
          </span>
        </div>
        {intentionalOff ? (
          <Chip tone="muted">OFF</Chip>
        ) : summary.stoppedWorking ? (
          hardStopped ? (
            <Chip tone="neg">STOPPED</Chip>
          ) : summary.stoppedReasonKind === "expected-limit" ? (
            <Chip tone="warn">LIMIT</Chip>
          ) : (
            <Chip tone="warn">DEGRADED</Chip>
          )
        ) : null}
      </div>

      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
        <span>Last OK: <span className="text-[color:var(--con-fg)]">{relTime(summary.lastSuccessTs)}</span></span>
        <span>Last fail: <span className="text-[color:var(--con-fg)]">{relTime(summary.lastFailureTs)}</span></span>
        <span title={capTitle}>1h calls: <span className="text-[color:var(--con-fg)]">{formatLaneCallCount(summary.callsLastHour, summary.laneLogCap)}</span></span>
        <span title={capTitle}>24h calls: <span className="text-[color:var(--con-fg)]">{formatLaneCallCount(summary.callsLast24h, summary.laneLogCap)}</span></span>
      </div>

      {summary.lastSuccessLatencyMs !== null && (
        <div className="mt-1 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
          Last latency: {summary.lastSuccessLatencyMs}ms
        </div>
      )}

      {intentionalOff && summary.stoppedReason && (
        <div className="mt-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
          {summary.stoppedReason}
        </div>
      )}
      {!intentionalOff && summary.stoppedWorking && summary.stoppedReason && (
        <div className={cx("mt-2 text-[length:var(--con-fs-xs)]", hardStopped ? "text-[color:var(--con-neg)]" : "text-[color:var(--con-warn)]")}>
          {summary.stoppedReason}
        </div>
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
        <h3 className="text-[length:var(--con-fs-sm)] font-semibold">
          {formatServiceName(summary.service)}
          {summary.keySource && (
            <span className="ml-1.5 text-[length:var(--con-fs-xs)] font-normal text-[color:var(--con-muted)]">({summary.keySource})</span>
          )}
        </h3>
        <Segmented<DrawerTab>
          value={tab}
          onChange={setTab}
          ariaLabel="Service detail view"
          options={[
            { value: "log", label: "Raw Log" },
            { value: "errors", label: `Error Patterns (${errorPatterns.length})` },
          ]}
        />
      </div>

      {tab === "log" && (
        <div className="overflow-x-auto rounded-[var(--con-radius-sm)] border border-[color:var(--con-line)]">
          {loadingLog ? (
            <div className="py-8 text-center text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">Loading…</div>
          ) : log.length === 0 ? (
            <div className="py-8 text-center text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">No log entries</div>
          ) : (
            <table className="con-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Status</th>
                  <th className="num">Latency</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {log.map((row) => (
                  <tr key={row.id}>
                    <td className="whitespace-nowrap text-[color:var(--con-faint)]">{relTime(row.ts)}</td>
                    <td>
                      {row.ok ? (
                        <Chip tone="pos">OK</Chip>
                      ) : (
                        <Chip tone="neg">FAIL</Chip>
                      )}
                    </td>
                    <td className="num text-[color:var(--con-muted)]">
                      {row.latency_ms !== null ? `${row.latency_ms}ms` : "—"}
                    </td>
                    <td className="max-w-xs truncate text-[color:var(--con-neg)]">
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
        <div className="overflow-x-auto rounded-[var(--con-radius-sm)] border border-[color:var(--con-line)]">
          {errorPatterns.length === 0 ? (
            <div className="py-8 text-center text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">No error patterns</div>
          ) : (
            <table className="con-table">
              <thead>
                <tr>
                  <th>Error</th>
                  <th className="num">Count</th>
                  <th>First seen</th>
                  <th>Last seen</th>
                </tr>
              </thead>
              <tbody>
                {errorPatterns.map((p) => (
                  <tr key={p.id}>
                    <td className="con-mono max-w-xs truncate text-[color:var(--con-neg)]">{p.error_text}</td>
                    <td className="num font-semibold">{p.count}</td>
                    <td className="whitespace-nowrap text-[color:var(--con-faint)]">{relTime(p.first_seen)}</td>
                    <td className="whitespace-nowrap text-[color:var(--con-faint)]">{relTime(p.last_seen)}</td>
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
  const [error, setError] = useState<ProbeErrorDescription | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const fetch_ = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/connections-health");
      if (!r.ok) {
        setError(describeProbeStatus(r.status));
        return;
      }
      const d: HealthData = await r.json();
      setData(d);
      setError(null);
    } catch {
      setError(describeProbeNetworkError());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetch_();
    const interval = setInterval(fetch_, 30_000);
    return () => clearInterval(interval);
  }, [fetch_]);

  const laneKey = (s: ServiceHealthSummary) => `${s.service}:${s.keySource ?? ""}`;
  const selectedSummary = data?.services.find((s) => laneKey(s) === selected) ?? null;
  // Split rather than one flat "N stopped": a lane tripped by the soft "no success yet this hour"
  // heuristic (one cold failure is enough) is not the same event as a lane that failed five calls in
  // a row, and merging them made the header count read alarmingly high for a healthy box.
  // Intentional OFF (retired FMP/Quiver/UW) never contributes to stopped/degraded header chips.
  const activeLanes = data?.services.filter((s) => !s.intentionalOff) ?? [];
  const stoppedLanes = activeLanes.filter((s) => s.stoppedWorking);
  const hardStoppedCount = stoppedLanes.filter(isHardStopped).length;
  const degradedCount = stoppedLanes.filter(isSoftDegraded).length;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">API Connections</h1>
          {data?.asOf && (
            <p className="mt-0.5 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">Last updated {relTime(data.asOf)}</p>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {hardStoppedCount > 0 && (
            <Chip tone="neg">{hardStoppedCount} stopped</Chip>
          )}
          {degradedCount > 0 && (
            <Chip tone="warn">{degradedCount} degraded</Chip>
          )}
        </div>
      </div>

      {loading && !data && (
        <div className="py-16 text-center text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">Loading…</div>
      )}

      {error && (
        <div
          className="rounded-[var(--con-radius-sm)] border border-[color:var(--con-neg-border)] bg-[color:var(--con-neg-soft)] p-3 text-[length:var(--con-fs-sm)] text-[color:var(--con-neg)]"
          title={error.rawLabel}
        >
          {error.message}
        </div>
      )}

      {data && (
        <div className={`grid gap-4 ${selectedSummary ? "lg:grid-cols-[380px_1fr]" : "grid-cols-1"}`}>
          {/* Service grid */}
          <div className="space-y-3">
            {data.services.length === 0 ? (
              <Card className="text-center">
                <p className="py-4 text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">No API calls recorded yet.</p>
                <p className="pb-4 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                  Health data appears after the first scan or enrichment fetch.
                </p>
              </Card>
            ) : (
              <>
                {/* Stopped services first */}
                {data.services
                  .slice()
                  .sort((a, b) => {
                    // Hard-stopped first, then soft-degraded, then healthy, then intentional OFF —
                    // same weighting as the header chips, so the list order matches the counts.
                    const rankDiff = laneSortRank(a) - laneSortRank(b);
                    if (rankDiff !== 0) return rankDiff;
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
            <Card className="sticky top-16 self-start">
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
