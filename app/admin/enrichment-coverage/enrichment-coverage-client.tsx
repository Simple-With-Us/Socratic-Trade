"use client";

import { useCallback, useEffect, useState } from "react";
import { Btn, Stat } from "../../console/ui/primitives";
import type { EnrichmentCoverageReport } from "@/lib/enrichment-coverage";
import {
  describeProbeNetworkError,
  describeProbeStatus,
  type ProbeErrorDescription
} from "../lib/probe-error";

function pct(rate: number): string {
  return `${Math.round(rate * 1000) / 10}%`;
}

export function EnrichmentCoverageClient() {
  const [report, setReport] = useState<EnrichmentCoverageReport | null>(null);
  const [available, setAvailable] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ProbeErrorDescription | null>(null);
  const [showOnlyGaps, setShowOnlyGaps] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/enrichment-coverage");
      if (!res.ok) {
        setError(describeProbeStatus(res.status));
        return;
      }
      const body = (await res.json()) as {
        ok: boolean;
        available: boolean;
        message?: string;
        report?: EnrichmentCoverageReport;
      };
      setAvailable(Boolean(body.available));
      setMessage(body.message ?? null);
      setReport(body.report ?? null);
    } catch {
      setError(describeProbeNetworkError());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const fields = report
    ? showOnlyGaps
      ? report.fields.filter((f) => f.fillRate < 1)
      : report.fields
    : [];

  const sourceEntries = report
    ? Object.entries(report.sourceWinTotals).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    : [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Enrichment Coverage</h1>
        <p className="mt-1 text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
          Last cascade run: which data points filled, which source won (or won most often), and which
          fields the free/keyless + RapidAPI + paid cascade still could not provide.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
          <input
            type="checkbox"
            checked={showOnlyGaps}
            onChange={(e) => setShowOnlyGaps(e.target.checked)}
          />
          Show gaps only
        </label>
        <Btn variant="outline" size="sm" className="ml-auto" onClick={() => void fetchData()} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </Btn>
      </div>

      {error && (
        <div className="rounded-[var(--con-radius-sm)] border border-[color:var(--con-neg-border)] bg-[color:var(--con-neg-soft)] p-3 text-[length:var(--con-fs-sm)] text-[color:var(--con-neg)]">
          {error.message}
        </div>
      )}

      {!loading && !available && (
        <div className="con-tile text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
          {message ?? "No coverage report available yet."}
        </div>
      )}

      {report && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="con-tile">
              <Stat label="Symbols in last run" value={String(report.symbolCount)} sub={report.asOf} />
            </div>
            <div className="con-tile">
              <Stat
                label="Fully missing fields"
                value={String(report.missingFields.length)}
                sub={report.missingFields.slice(0, 4).join(", ") || "none"}
              />
            </div>
            <div className="con-tile">
              <Stat
                label="Partial fields"
                value={String(report.partialFields.length)}
                sub="filled for some symbols only"
              />
            </div>
            <div className="con-tile">
              <Stat
                label="Contributing sources"
                value={String(report.contributingSources.length)}
                sub={report.contributingSources.slice(0, 3).join(" + ") || "none"}
              />
            </div>
          </div>

          <div className="con-tile overflow-x-auto">
            <h2 className="mb-3 text-sm font-semibold">Source win totals</h2>
            {sourceEntries.length === 0 ? (
              <p className="text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">No field wins recorded.</p>
            ) : (
              <table className="w-full text-left text-[length:var(--con-fs-sm)]">
                <thead>
                  <tr className="border-b border-[color:var(--con-border)] text-[color:var(--con-muted)]">
                    <th className="py-2 pr-3 font-medium">Source</th>
                    <th className="py-2 font-medium">Field wins</th>
                  </tr>
                </thead>
                <tbody>
                  {sourceEntries.map(([source, wins]) => (
                    <tr key={source} className="border-b border-[color:var(--con-border)]/60">
                      <td className="py-1.5 pr-3 font-mono text-[length:var(--con-fs-xs)]">{source}</td>
                      <td className="py-1.5 tabular-nums">{wins}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {report.providerFailures.length > 0 && (
            <div className="con-tile overflow-x-auto">
              <h2 className="mb-3 text-sm font-semibold">Provider failures this run</h2>
              <table className="w-full text-left text-[length:var(--con-fs-sm)]">
                <thead>
                  <tr className="border-b border-[color:var(--con-border)] text-[color:var(--con-muted)]">
                    <th className="py-2 pr-3 font-medium">Provider</th>
                    <th className="py-2 pr-3 font-medium">Symbols failed</th>
                    <th className="py-2 font-medium">Error kinds</th>
                  </tr>
                </thead>
                <tbody>
                  {report.providerFailures.map((f) => (
                    <tr key={f.provider} className="border-b border-[color:var(--con-border)]/60">
                      <td className="py-1.5 pr-3 font-mono text-[length:var(--con-fs-xs)]">{f.provider}</td>
                      <td className="py-1.5 pr-3 tabular-nums">{f.failureCount}</td>
                      <td className="py-1.5 text-[color:var(--con-muted)]">{f.errorKinds.join(", ") || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="con-tile overflow-x-auto">
            <h2 className="mb-3 text-sm font-semibold">Per-field coverage</h2>
            <table className="w-full text-left text-[length:var(--con-fs-sm)]">
              <thead>
                <tr className="border-b border-[color:var(--con-border)] text-[color:var(--con-muted)]">
                  <th className="py-2 pr-3 font-medium">Field</th>
                  <th className="py-2 pr-3 font-medium">Fill</th>
                  <th className="py-2 pr-3 font-medium">Most frequent source</th>
                  <th className="py-2 font-medium">Winning sources</th>
                </tr>
              </thead>
              <tbody>
                {[...(report.headlines ? [report.headlines] : []), ...fields].map((f) => (
                  <tr key={f.field} className="border-b border-[color:var(--con-border)]/60 align-top">
                    <td className="py-1.5 pr-3 font-mono text-[length:var(--con-fs-xs)]">{f.field}</td>
                    <td className="py-1.5 pr-3 tabular-nums">
                      {f.filledCount}/{f.totalSymbols} ({pct(f.fillRate)})
                    </td>
                    <td className="py-1.5 pr-3 font-mono text-[length:var(--con-fs-xs)]">
                      {f.mostFrequentSource ?? "—"}
                    </td>
                    <td className="py-1.5 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
                      {Object.entries(f.winningSources)
                        .sort((a, b) => b[1] - a[1])
                        .map(([src, n]) => `${src}:${n}`)
                        .join(" · ") || "unfilled"}
                      {f.missingSymbols.length > 0 && f.fillRate < 1 ? (
                        <div className="mt-0.5">
                          missing sample: {f.missingSymbols.slice(0, 8).join(", ")}
                          {f.missingSymbols.length > 8 ? "…" : ""}
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
