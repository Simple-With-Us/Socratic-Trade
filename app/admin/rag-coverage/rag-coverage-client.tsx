"use client";

import { useEffect, useState, useCallback } from "react";
import { Btn, Card, Chip, Meter, Segmented, Stat, TextInput, type ChipTone } from "../../console/ui/primitives";
import { describeProbeNetworkError, describeProbeStatus, type ProbeErrorDescription } from "../lib/probe-error";

// ── Types ─────────────────────────────────────────────────────────────────────

interface TickerCoverage {
  symbol: string;
  filings: number;
  chunks: number;
  latestChunkAt: string | null;
  breakdown?: Record<string, number>;
}

interface VectorStoreHealth {
  configured: boolean;
  indexName: string;
  exists?: boolean;
  totalVectorCount?: number;
  dimension?: number;
  error?: string;
  lastIngest?: {
    at?: string;
    attempted?: number;
    indexed?: number;
    skipped?: boolean;
    error?: string;
    budgetSkipped?: number;
    writeUnitBudgetSkipped?: number;
    budget?: {
      requested?: number;
      allowed?: number;
      skipped?: number;
      usedLast24h?: number;
      limitPer24h?: number;
    };
    writeBudget?: {
      requestedEstimatedWriteUnits?: number;
      allowedEstimatedWriteUnits?: number;
      skipped?: number;
      usedLast24h?: number;
      limitPer24h?: number;
    };
  };
}

interface VectorIndexStats {
  indexName: string;
  totalVectorCount?: number;
  dimension?: number;
  error?: string;
}

interface CoverageData {
  sinceDays: number;
  perTicker: TickerCoverage[];
  globalBreakdown?: Record<string, number>;
  totalTickers: number;
  totalChunks: number;
  totalFilings: number;
  vectorStore: VectorStoreHealth;
  vectorStoreTotalVectors: number;
  allVectorIndexes?: VectorIndexStats[];
  allVectorStoreTotalVectors?: number;
  coverageGaps: string[];
  providerUsage?: {
    pinecone?: {
      monthlyUsageApiAvailable: boolean;
      note: string;
      configuredIndexVectors?: number;
      allVisibleIndexVectors?: number;
    };
    voyage?: {
      usageApiAvailable: boolean;
      note: string;
    };
  };
  ragUsage: {
    sinceDays: number;
    totalCostUsd: number;
    rows: Array<{
      userId: string;
      operation: string;
      provider: string;
      model: string | null;
      calls: number;
      tokensIn: number;
      tokensOut: number;
      batchCount: number;
      costEstUsd: number;
    }>;
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtCost(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(5)}`;
  return `$${usd.toFixed(4)}`;
}

// Headline totals show 2 decimals — a $34.8565 total reads as noise. Per-line-item
// costs keep fmtCost's 4dp (sub-cent precision matters for one call, not for a total).
function fmtTotalCost(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

function fmtRelDate(iso: string | null): string {
  if (!iso) return "never";
  try {
    const d = new Date(iso);
    const now = Date.now();
    const diff = now - d.getTime();
    const mins = Math.floor(diff / 60_000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    return d.toLocaleDateString();
  } catch {
    return iso;
  }
}

function fmtInt(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : "configured";
}

function opLabel(op: string): string {
  const map: Record<string, string> = {
    embed: "Embed",
    rerank: "Rerank",
    query: "Query",
    upsert: "Upsert"
  };
  return map[op] ?? op;
}

function providerLabel(provider: string): string {
  const map: Record<string, string> = {
    voyage: "Voyage",
    pinecone: "Pinecone"
  };
  return map[provider] ?? provider;
}

function getSourceLabel(src: string): string {
  if (src === "sec-edgar") return "SEC";
  if (src.startsWith("fundamentals:")) return "Fund Card";
  if (src.startsWith("disclosure:congress")) return "Congress";
  if (src.startsWith("disclosure:insider")) return "Insider";
  if (src.includes("socratic-memory")) return "Coach";
  if (src.startsWith("sec8k-summary")) return "8-K Summary";
  if (src === "fmp-earnings-transcript") return "Earnings Transcript";
  return src.split(":").pop() || src;
}

function getSourceTone(src: string): ChipTone {
  if (src === "sec-edgar") return "accent";
  if (src.startsWith("fundamentals:")) return "info";
  if (src.startsWith("disclosure:congress")) return "warn";
  if (src.startsWith("disclosure:insider")) return "muted";
  if (src.includes("socratic-memory")) return "pos";
  if (src.startsWith("sec8k-summary")) return "neg";
  if (src === "fmp-earnings-transcript") return "info";
  return "muted";
}

// ── Components ────────────────────────────────────────────────────────────────

function StatusNotice({ tone, title, children }: { tone: "warning" | "danger" | "info"; title: string; children: React.ReactNode }) {
  const styles = {
    warning: "border-[color:var(--con-warn-border)] bg-[color:var(--con-warn-soft)] text-[color:var(--con-warn)]",
    danger: "border-[color:var(--con-neg-border)] bg-[color:var(--con-neg-soft)] text-[color:var(--con-neg)]",
    info: "border-[color:var(--con-line)] bg-[color:var(--con-surface-2)] text-[color:var(--con-fg)]"
  }[tone];
  return (
    <div className={`rounded-[var(--con-radius-sm)] border p-3 text-[length:var(--con-fs-sm)] ${styles}`}>
      <strong>{title}</strong>
      <div className="mt-1 opacity-90">{children}</div>
    </div>
  );
}

function TickerRow({ coverage }: { coverage: TickerCoverage }) {
  const maxChunks = 200; // reasonable visual scale cap
  return (
    <div className="flex items-center gap-3 border-b border-[color:var(--con-line)] py-2 text-[length:var(--con-fs-sm)] last:border-0">
      <div className="con-mono w-16 shrink-0 font-semibold">{coverage.symbol}</div>
      <div className="min-w-0 flex-1">
        <Meter value={coverage.chunks} max={maxChunks} />
        <div className="mt-1.5 flex flex-wrap items-center gap-3 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
          <span className="font-semibold text-[color:var(--con-fg)]">{coverage.chunks} chunks</span>
          <span>{coverage.filings} filing{coverage.filings !== 1 ? "s" : ""}</span>
          {coverage.breakdown && Object.entries(coverage.breakdown).map(([src, count]) => {
            if (count === 0) return null;
            return (
              <Chip key={src} tone={getSourceTone(src)} className="con-mono">
                {count} {getSourceLabel(src)}
              </Chip>
            );
          })}
          <span className="ml-auto text-[color:var(--con-faint)]">{fmtRelDate(coverage.latestChunkAt)}</span>
        </div>
      </div>
    </div>
  );
}

function VectorIndexRow({ row, configuredIndex }: { row: VectorIndexStats; configuredIndex: string }) {
  const configured = row.indexName === configuredIndex;
  return (
    <div className="flex items-center gap-3 border-b border-[color:var(--con-line)] px-4 py-2 text-[length:var(--con-fs-xs)] last:border-0">
      <span className="con-mono min-w-0 flex-1 truncate" title={row.indexName}>
        {row.indexName}
      </span>
      {configured && <Chip tone="accent">configured</Chip>}
      <span className="con-mono w-24 text-right">{row.totalVectorCount ?? "?"}</span>
      <span className="con-mono w-20 text-right text-[color:var(--con-muted)]">{row.dimension ?? "?"}d</span>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

const WINDOW_OPTIONS = [
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 }
];

export function RagCoverageClient() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<CoverageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ProbeErrorDescription | null>(null);
  const [search, setSearch] = useState("");

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ sinceDays: String(days) });
      const res = await fetch(`/api/admin/rag-coverage?${params}`);
      if (!res.ok) {
        setError(describeProbeStatus(res.status));
        return;
      }
      setData(await res.json());
    } catch {
      setError(describeProbeNetworkError());
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const filtered = data
    ? data.perTicker.filter((t) =>
        t.symbol.toLowerCase().includes(search.toLowerCase())
      )
    : [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">RAG Coverage</h1>
        <p className="mt-1 text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
          What&apos;s in the vector index per ticker — chunk counts, freshness, and coverage gaps.
        </p>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          value={String(days)}
          onChange={(v) => setDays(Number(v))}
          ariaLabel="Time window"
          options={WINDOW_OPTIONS.map((opt) => ({ value: String(opt.days), label: opt.label }))}
        />
        {/* con-input is width:100% (unlayered CSS beats Tailwind's w-auto), so size via a wrapper. */}
        <div className="w-44">
          <TextInput
            placeholder="Filter ticker…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Filter ticker"
          />
        </div>
        <Btn variant="outline" size="sm" className="ml-auto" onClick={fetchData} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </Btn>
      </div>

      {error && (
        <div
          className="rounded-[var(--con-radius-sm)] border border-[color:var(--con-neg-border)] bg-[color:var(--con-neg-soft)] p-3 text-[length:var(--con-fs-sm)] text-[color:var(--con-neg)]"
          title={error.rawLabel}
        >
          {error.message}
        </div>
      )}

      {data && (
        <>
          {/* Summary row */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="con-tile">
              <Stat
                label="Tickers with coverage"
                value={String(data.totalTickers)}
                title="Distinct symbols with at least one indexed chunk in this app's local document_chunks ledger."
              />
            </div>
            <div className="con-tile">
              <Stat
                label="Chunks (local ledger)"
                value={String(data.totalChunks)}
                sub={`${data.totalFilings} filing${data.totalFilings !== 1 ? "s" : ""}`}
                title="Text chunks recorded in this app's own document_chunks table — the ledger the per-ticker coverage list below reads from, not Pinecone's own count."
              />
            </div>
            <div className="con-tile">
              <Stat
                label="Vectors (Pinecone index)"
                value={String(data.vectorStoreTotalVectors)}
                sub={data.vectorStore?.indexName ?? "No index"}
                title="Pinecone's own reported vector count for the configured index — a separate system from the local chunk ledger; the two can legitimately differ."
              />
            </div>
            <div className="con-tile">
              <Stat
                label="App-recorded RAG spend"
                value={fmtTotalCost(data.ragUsage.totalCostUsd)}
                sub={`estimated Voyage cost, last ${data.sinceDays}d`}
                title="Estimated Voyage embedding cost this app recorded for RAG ingestion — not a chunk or vector count."
              />
            </div>
          </div>

          {/* Global breakdown badges */}
          {data.globalBreakdown && Object.keys(data.globalBreakdown).length > 0 && (
            <Card title="Corpus composition">
              <div className="flex flex-wrap gap-2">
                {Object.entries(data.globalBreakdown)
                  .sort((a, b) => b[1] - a[1])
                  .map(([src, count]) => (
                    <Chip key={src} tone={getSourceTone(src)} className="con-mono">
                      <span className="font-semibold">{count.toLocaleString()}</span>
                      <span className="font-sans opacity-80">{getSourceLabel(src)}</span>
                    </Chip>
                  ))}
              </div>
            </Card>
          )}

          {(data.providerUsage?.pinecone || data.providerUsage?.voyage) && (
            <StatusNotice tone="info" title="Provider Usage Cross-Check">
              <div className="space-y-1">
                {data.providerUsage?.pinecone?.note && <p>{data.providerUsage.pinecone.note}</p>}
                {data.providerUsage?.voyage?.note && <p>{data.providerUsage.voyage.note}</p>}
              </div>
            </StatusNotice>
          )}

          {(data.vectorStoreTotalVectors > 0 && data.totalChunks === 0) && (
            <StatusNotice tone="warning" title="Pinecone Has Vectors, Local Coverage Ledger Is Empty">
              The configured Pinecone index reports {data.vectorStoreTotalVectors.toLocaleString()} vector{data.vectorStoreTotalVectors === 1 ? "" : "s"}, but this app&apos;s local <span className="con-mono">document_chunks</span> table has zero rows. Ticker coverage below is a local ledger view, not a full Pinecone inventory.
            </StatusNotice>
          )}
          {((data.allVectorStoreTotalVectors ?? 0) > data.vectorStoreTotalVectors) && (
            <StatusNotice tone="warning" title="Other Pinecone Indexes Also Consume This Org's Quota">
              This project key can see {(data.allVectorStoreTotalVectors ?? 0).toLocaleString()} vector{(data.allVectorStoreTotalVectors ?? 0) === 1 ? "" : "s"} across all Pinecone indexes, while the configured app index has {data.vectorStoreTotalVectors.toLocaleString()}. Pinecone Write Units are organization-level, so older indexes can explain quota usage that this ticker table does not show.
            </StatusNotice>
          )}

          {/* Vector store health */}
          {data.vectorStore && !data.vectorStore.configured && (
            <StatusNotice tone="warning" title="Pinecone/Voyage Not Configured">
              Shared RAG writes and retrieval are disabled because the backend keys are missing for this scope.
            </StatusNotice>
          )}
          {data.vectorStore?.exists === false && (
            <StatusNotice tone="danger" title="Pinecone Index Missing">
              The configured index <span className="con-mono">{data.vectorStore.indexName}</span> does not exist.
            </StatusNotice>
          )}
          {data.vectorStore?.error && (
            <StatusNotice tone="danger" title="Pinecone API Error">
              <span className="con-mono">{data.vectorStore.indexName}</span>: {data.vectorStore.error}
            </StatusNotice>
          )}
          {data.vectorStore?.lastIngest?.error && (
            <StatusNotice tone="danger" title="Last RAG Ingest Failed">
              {data.vectorStore.lastIngest.error}
              {data.vectorStore.lastIngest.at ? ` (${fmtRelDate(data.vectorStore.lastIngest.at)})` : ""}
            </StatusNotice>
          )}
          {(data.vectorStore?.lastIngest?.budgetSkipped ?? 0) > 0 && (
            <StatusNotice tone="warning" title="RAG Ingest Budget Reached">
              Skipped {data.vectorStore.lastIngest!.budgetSkipped} document{data.vectorStore.lastIngest!.budgetSkipped === 1 ? "" : "s"} before embedding. Current cap is {data.vectorStore.lastIngest!.budget?.limitPer24h ?? "configured"} texts per 24 hours.
            </StatusNotice>
          )}
          {(data.vectorStore?.lastIngest?.writeUnitBudgetSkipped ?? 0) > 0 && (
            <StatusNotice tone="warning" title="Pinecone Write Unit Budget Reached">
              Skipped {data.vectorStore.lastIngest!.writeUnitBudgetSkipped} document{data.vectorStore.lastIngest!.writeUnitBudgetSkipped === 1 ? "" : "s"} before Voyage embedding or Pinecone upsert. This run requested about {fmtInt(data.vectorStore.lastIngest!.writeBudget?.requestedEstimatedWriteUnits)} Write Units; {fmtInt(data.vectorStore.lastIngest!.writeBudget?.allowedEstimatedWriteUnits)} remained out of the {fmtInt(data.vectorStore.lastIngest!.writeBudget?.limitPer24h)} daily cap.
            </StatusNotice>
          )}

          {data.allVectorIndexes && data.allVectorIndexes.length > 0 && (
            <Card padded={false} className="overflow-hidden">
              <div className="con-card-title flex items-center gap-3 border-b border-[color:var(--con-line)] px-4 py-3">
                <span className="flex-1">Pinecone Index</span>
                <span className="w-24 text-right">Vectors</span>
                <span className="w-20 text-right">Dim</span>
              </div>
              <div>
                {data.allVectorIndexes
                  .slice()
                  .sort((a, b) => (b.totalVectorCount ?? -1) - (a.totalVectorCount ?? -1))
                  .map((row) => (
                    <VectorIndexRow key={row.indexName} row={row} configuredIndex={data.vectorStore?.indexName ?? ""} />
                  ))}
              </div>
            </Card>
          )}

          {/* Coverage gaps warning */}
          {data.coverageGaps.length > 0 && (
            <div className="rounded-[var(--con-radius-sm)] border border-[color:var(--con-neg-border)] bg-[color:var(--con-neg-soft)] p-3 text-[length:var(--con-fs-sm)] text-[color:var(--con-neg)]">
              <strong>{data.coverageGaps.length} ticker{data.coverageGaps.length !== 1 ? "s" : ""} have filing records but zero chunks in the index:</strong>{" "}
              {data.coverageGaps.join(", ")}
            </div>
          )}

          {/* Per-ticker list */}
          <Card padded={false} className="overflow-hidden">
            <div className="con-card-title flex items-center gap-3 border-b border-[color:var(--con-line)] px-4 py-3">
              <span className="w-16 shrink-0">Ticker</span>
              <span className="flex-1">Chunk coverage</span>
            </div>
            <div className="max-h-[60vh] overflow-y-auto px-4">
              {filtered.length === 0 ? (
                <div className="py-12 text-center text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
                  {search ? "No tickers match your filter." : "No indexed filings yet."}
                </div>
              ) : (
                filtered.map((t) => <TickerRow key={t.symbol} coverage={t} />)
              )}
            </div>
          </Card>

          {/* RAG usage table */}
          {data.ragUsage.rows.length > 0 && (
            <Card title="App-recorded RAG usage" padded={false} className="overflow-hidden">
              <div className="con-card-title flex items-center gap-3 border-b border-[color:var(--con-line)] px-4 py-2">
                <span className="w-24 shrink-0">Operation</span>
                <span className="w-20 shrink-0">Provider</span>
                <span className="flex-1">Model</span>
                <span className="w-16 text-right">Calls</span>
                <span className="w-20 text-right">Units / Tokens</span>
                <span className="w-20 text-right">Cost</span>
              </div>
              <div className="max-h-[30vh] divide-y divide-[color:var(--con-line)] overflow-y-auto">
                {data.ragUsage.rows.map((row, i) => (
                  <div key={i} className="flex items-center gap-3 px-4 py-2 text-[length:var(--con-fs-xs)]">
                    <span className="con-mono w-24 shrink-0">{opLabel(row.operation)}</span>
                    <span className="w-20 shrink-0 text-[color:var(--con-muted)]">{providerLabel(row.provider)}</span>
                    <span className="flex-1 truncate text-[color:var(--con-muted)]">{row.model ?? "—"}</span>
                    <span className="con-mono w-16 text-right text-[color:var(--con-muted)]">{row.calls}</span>
                    <span
                      className="con-mono w-20 text-right text-[color:var(--con-muted)]"
                      title={row.provider === "pinecone" && row.operation === "upsert" ? "Estimated Pinecone Write Units for upserts. Voyage rows show estimated input tokens." : row.provider === "pinecone" && row.operation === "query" ? "Pinecone Read Units reported by the query response when available, otherwise a conservative fallback." : "Estimated input tokens."}
                    >
                      {fmtInt(row.tokensIn)}
                    </span>
                    <span
                      className="con-mono w-20 text-right"
                      title={row.provider === "pinecone" ? "Pinecone cost is not estimated here; use provider billing/usage views for dollars. Units are shown in the Units / Tokens column." : "Estimated Voyage cost from app-recorded token volume and static pricing."}
                    >
                      {row.provider === "pinecone" ? "—" : fmtCost(row.costEstUsd)}
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </>
      )}

      {loading && !data && (
        <div className="py-12 text-center text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">Loading…</div>
      )}
    </div>
  );
}
