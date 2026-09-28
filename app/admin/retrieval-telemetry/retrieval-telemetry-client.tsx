"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, Chip, Stat, TextInput, type ChipTone } from "../../console/ui/primitives";

// ── Types ──────────────────────────────────────────────────────────────────────
// Mirrors src/lib/rag/retrieval-telemetry-read.ts. Aggregates only: the payloads behind this page
// carry no query text and no document text, just a short deterministic query digest, so nothing
// here can reconstruct what was searched for.

interface StageAggregate {
  stage: string;
  calls: number;
  errors: number;
  cacheHits: number;
  totalDurationMs: number;
  meanDurationMs: number;
  p95DurationMs: number;
  maxDurationMs: number;
  candidatesIn: number;
  candidatesOut: number;
  dropped: number;
  dropRate: number;
  errorKinds: string[];
  providers: string[];
  models: string[];
}

interface SymbolAggregate {
  symbol: string;
  traces: number;
  meanWallDurationMs: number;
  meanFinalCandidates: number;
  emptyTraces: number;
  totalDurationMs: number;
}

interface QualityAggregate {
  samples: number;
  meanCandidates: number;
  meanFinalCount: number;
  totalDroppedByMinScore: number;
  totalDroppedByAsOf: number;
  hybridSamples: number;
  rerankAttempted: number;
  rerankRan: number;
  meanTopCosine: number;
  meanTopRelevanceScore: number;
  emptyRate: number;
}

interface TelemetryResponse {
  sinceIso: string;
  sinceDays: number;
  rowsRead: number;
  truncated: boolean;
  traces: number;
  firstTraceAt: string | null;
  lastTraceAt: string | null;
  routes: string[];
  stages: StageAggregate[];
  symbols: SymbolAggregate[];
  quality: QualityAggregate;
  noData: boolean;
}

function fmtPct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function fmtMs(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(2)}s`;
  return `${value.toFixed(0)}ms`;
}

function fmtRelDate(iso: string | null): string {
  if (!iso) return "never";
  try {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60_000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  } catch {
    return iso;
  }
}

/** A stage that removes candidates is doing its job; one that ERRORS is not. */
function stageTone(stage: StageAggregate): ChipTone {
  if (stage.errors > 0) return "neg";
  if (stage.dropRate >= 0.5) return "warn";
  if (stage.cacheHits > 0 && stage.dropped === 0) return "pos";
  return "muted";
}

export function RetrievalTelemetryClient() {
  const [days, setDays] = useState(7);
  const [data, setData] = useState<TelemetryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/retrieval-telemetry?sinceDays=${days}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as TelemetryResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-4">
      <Card
        title="Retrieval Stage Telemetry"
        action={
          <div className="flex items-center gap-2">
            <label className="text-xs opacity-70" htmlFor="retrieval-telemetry-days">
              Window (days)
            </label>
            <TextInput
              id="retrieval-telemetry-days"
              value={String(days)}
              onChange={(event) => setDays(Math.max(1, Math.min(90, Number(event.target.value) || 1)))}
              className="w-20"
            />
            <button
              type="button"
              onClick={() => void load()}
              className="rounded border border-[var(--border)] px-2 py-1 text-xs"
            >
              {loading ? "Loading…" : "Refresh"}
            </button>
          </div>
        }
      >
        <p className="text-xs opacity-70">
          Which stage of recall is eating the candidates, and how long each stage takes.{"  "}Aggregates only —
          no query text and no document text is stored in these events, only a short query digest.{"  "}This page
          exists because these events were written on every retrieval and could not be read anywhere: a
          recall stage that silently returned nothing was invisible in-product.
        </p>
        {error ? <p className="mt-2 text-xs text-[var(--neg)]">{error}</p> : null}
        {data && data.noData ? (
          <p className="mt-3 text-xs">
            No retrieval telemetry in this window.{"  "}That is itself a finding: check that{" "}
            <code className="opacity-80">RAG_RETRIEVAL_STAGE_TELEMETRY</code> is not set to{" "}
            <code className="opacity-80">off</code> and that{" "}
            <code className="opacity-80">RAG_RETRIEVAL_TELEMETRY</code> is enabled.
          </p>
        ) : null}
        {data && data.truncated ? (
          <p className="mt-3 text-xs">
            <Chip tone="warn">capped</Chip> Read hit the row cap, so this window is a SAMPLE, not the whole
            window.{"  "}Narrow the date range to see a complete picture.
          </p>
        ) : null}
      </Card>

      {data && !data.noData ? (
        <>
          <Card title="Overview">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat label="Traces" value={data.traces.toLocaleString()} sub={`${data.routes.length} route(s)`} />
              <Stat
                label="Recall returned nothing"
                value={fmtPct(data.quality.emptyRate)}
                sub={`${data.symbols.reduce((sum, s) => sum + s.emptyTraces, 0)} empty trace(s)`}
                tone={data.quality.emptyRate > 0.2 ? "neg" : "muted"}
              />
              <Stat
                label="Mean final candidates"
                value={data.quality.meanFinalCount.toFixed(2)}
                sub={`from ${data.quality.meanCandidates.toFixed(1)} candidates`}
              />
              <Stat
                label="Newest trace"
                value={fmtRelDate(data.lastTraceAt)}
                sub={data.firstTraceAt ? `oldest ${fmtRelDate(data.firstTraceAt)}` : undefined}
                tone={data.lastTraceAt === null ? "neg" : "muted"}
              />
            </div>
          </Card>

          <Card title="Stages" collapsible defaultOpen>
            {data.stages.length === 0 ? (
              <p className="text-xs opacity-70">No stage receipts in this window.</p>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left opacity-70">
                    <th className="py-1">Stage</th>
                    <th className="py-1">Calls</th>
                    <th className="py-1">Mean</th>
                    <th className="py-1">P95</th>
                    <th className="py-1">Max</th>
                    <th className="py-1">In → Out</th>
                    <th className="py-1">Dropped</th>
                    <th className="py-1">Errors</th>
                  </tr>
                </thead>
                <tbody>
                  {data.stages.map((stage) => (
                    <tr key={stage.stage} className="border-t border-[var(--border)]">
                      <td className="py-1">
                        <Chip tone={stageTone(stage)}>{stage.stage}</Chip>
                        {stage.errorKinds.length > 0 ? (
                          <span className="ml-1 opacity-70">{stage.errorKinds.join(", ")}</span>
                        ) : null}
                      </td>
                      <td className="py-1">{stage.calls.toLocaleString()}</td>
                      <td className="py-1">{fmtMs(stage.meanDurationMs)}</td>
                      <td className="py-1">{fmtMs(stage.p95DurationMs)}</td>
                      <td className="py-1">{fmtMs(stage.maxDurationMs)}</td>
                      <td className="py-1">
                        {stage.candidatesIn.toLocaleString()} → {stage.candidatesOut.toLocaleString()}
                      </td>
                      <td className="py-1">
                        {stage.dropped.toLocaleString()}{" "}
                        <span className="opacity-70">({fmtPct(stage.dropRate)} of calls)</span>
                      </td>
                      <td className="py-1">{stage.errors > 0 ? <span className="text-[var(--neg)]">{stage.errors}</span> : "0"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <Card title="Retrieval quality" collapsible defaultOpen={false}>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat label="Samples" value={data.quality.samples.toLocaleString()} />
              <Stat label="Dropped by min score" value={data.quality.totalDroppedByMinScore.toLocaleString()} />
              <Stat label="Dropped by as-of filter" value={data.quality.totalDroppedByAsOf.toLocaleString()} />
              <Stat
                label="Rerank ran"
                value={`${data.quality.rerankRan}/${data.quality.rerankAttempted}`}
                sub={data.quality.rerankAttempted > data.quality.rerankRan ? "some attempts did not run" : "all attempts ran"}
                tone={data.quality.rerankAttempted > data.quality.rerankRan ? "neg" : "muted"}
              />
              <Stat label="Hybrid queries" value={data.quality.hybridSamples.toLocaleString()} />
              <Stat label="Mean top cosine" value={data.quality.meanTopCosine.toFixed(4)} />
              <Stat label="Mean top relevance" value={data.quality.meanTopRelevanceScore.toFixed(4)} />
            </div>
          </Card>

          <Card title="By symbol" collapsible defaultOpen={false}>
            {data.symbols.length === 0 ? (
              <p className="text-xs opacity-70">No per-symbol traces in this window.</p>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left opacity-70">
                    <th className="py-1">Symbol</th>
                    <th className="py-1">Traces</th>
                    <th className="py-1">Mean wall</th>
                    <th className="py-1">Mean final candidates</th>
                    <th className="py-1">Empty traces</th>
                  </tr>
                </thead>
                <tbody>
                  {data.symbols.map((row) => (
                    <tr key={row.symbol} className="border-t border-[var(--border)]">
                      <td className="py-1">{row.symbol}</td>
                      <td className="py-1">{row.traces.toLocaleString()}</td>
                      <td className="py-1">{fmtMs(row.meanWallDurationMs)}</td>
                      <td className="py-1">{row.meanFinalCandidates.toFixed(2)}</td>
                      <td className="py-1">
                        {row.emptyTraces > 0 ? (
                          <span className="text-[var(--neg)]">{row.emptyTraces}</span>
                        ) : (
                          "0"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </>
      ) : null}
    </div>
  );
}
