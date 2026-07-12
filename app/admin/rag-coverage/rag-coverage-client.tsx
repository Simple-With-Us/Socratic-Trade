"use client";

import { useEffect, useState, useCallback } from "react";
import { Card } from "../../ui/primitives";

// ── Types ─────────────────────────────────────────────────────────────────────

interface TickerCoverage {
  symbol: string;
  filings: number;
  chunks: number;
  latestChunkAt: string | null;
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

// ── Components ────────────────────────────────────────────────────────────────

function SummaryCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card className="p-4 flex flex-col gap-1">
      <div className="text-xs text-muted uppercase tracking-wide">{label}</div>
      <div className="text-2xl font-semibold text-fg">{value}</div>
      {sub && <div className="text-xs text-muted">{sub}</div>}
    </Card>
  );
}

function StatusNotice({ tone, title, children }: { tone: "warning" | "danger" | "info"; title: string; children: React.ReactNode }) {
  const styles = {
    warning: "text-amber-900 bg-amber-50 border-amber-200",
    danger: "text-down bg-down/10 border-down/20",
    info: "text-fg bg-surface-2 border-line"
  }[tone];
  return (
    <div className={`text-sm border rounded-lg p-3 mb-4 ${styles}`}>
      <strong>{title}</strong>
      <div className="mt-1 text-current/80">{children}</div>
    </div>
  );
}

function TickerRow({ coverage }: { coverage: TickerCoverage }) {
  const maxChunks = 200; // reasonable visual scale cap
  const barPct = Math.min(100, Math.round((coverage.chunks / maxChunks) * 100));
  return (
    <div className="flex items-center gap-3 py-2 border-b border-line/30 last:border-0 text-sm">
      <div className="w-16 font-mono font-semibold text-fg shrink-0">{coverage.symbol}</div>
      <div className="flex-1 min-w-0">
        <div className="h-2 bg-surface-2 rounded-full overflow-hidden">
          <div
            className="h-full bg-accent rounded-full transition-all"
            style={{ width: `${barPct}%` }}
          />
        </div>
        <div className="flex items-center gap-3 mt-1 text-xs text-muted">
          <span>{coverage.chunks} chunks</span>
          <span>{coverage.filings} filing{coverage.filings !== 1 ? "s" : ""}</span>
          <span>{fmtRelDate(coverage.latestChunkAt)}</span>
        </div>
      </div>
    </div>
  );
}

function VectorIndexRow({ row, configuredIndex }: { row: VectorIndexStats; configuredIndex: string }) {
  const configured = row.indexName === configuredIndex;
  return (
    <div className="flex items-center gap-3 border-b border-line/30 px-4 py-2 text-xs last:border-0">
      <span className="min-w-0 flex-1 truncate font-mono text-fg" title={row.indexName}>
        {row.indexName}
      </span>
      {configured && <span className="rounded border border-accent/30 bg-accent/10 px-1.5 py-0.5 text-accent">configured</span>}
      <span className="w-24 text-right font-mono text-fg">{row.totalVectorCount ?? "?"}</span>
      <span className="w-20 text-right font-mono text-muted">{row.dimension ?? "?"}d</span>
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
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ sinceDays: String(days) });
      const res = await fetch(`/api/admin/rag-coverage?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
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
    <div className="min-h-screen bg-base text-fg p-6 max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-fg">RAG Corpus Coverage</h1>
        <p className="text-sm text-muted mt-1">
          What&apos;s in the vector index per ticker — chunk counts, freshness, and coverage gaps.
        </p>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-3 mb-6 flex-wrap">
        <div className="flex items-center gap-1 bg-surface-2 border border-line rounded-lg p-0.5">
          {WINDOW_OPTIONS.map((opt) => (
            <button
              key={opt.days}
              onClick={() => setDays(opt.days)}
              className={`px-3 py-1 text-xs rounded-md transition-colors ${
                days === opt.days
                  ? "bg-accent text-accent-fg"
                  : "text-muted hover:text-fg"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <input
          type="text"
          placeholder="Filter ticker…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="text-sm border border-line bg-surface rounded-lg px-3 py-1.5 text-fg placeholder:text-muted focus:outline-none focus:border-accent/50 min-w-[140px]"
        />
        <button
          onClick={fetchData}
          disabled={loading}
          className="ml-auto text-xs text-muted hover:text-fg border border-line rounded-lg px-3 py-1.5 transition-colors disabled:opacity-50"
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {error && (
        <div className="text-sm text-down bg-down/10 border border-down/20 rounded-lg p-3 mb-4">
          {error}
        </div>
      )}

      {data && (
        <>
          {/* Summary row */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
            <SummaryCard
              label="Tickers indexed"
              value={String(data.totalTickers)}
            />
            <SummaryCard
              label="Total chunks"
              value={String(data.totalChunks)}
              sub={`${data.totalFilings} filing${data.totalFilings !== 1 ? "s" : ""}`}
            />
            <SummaryCard
              label="Pinecone vectors"
              value={String(data.vectorStoreTotalVectors)}
              sub={data.vectorStore?.indexName ?? "No index"}
            />
            <SummaryCard
              label="App-recorded RAG"
              value={fmtCost(data.ragUsage.totalCostUsd)}
              sub={`estimated Voyage cost, last ${data.sinceDays}d`}
            />
          </div>

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
              The configured Pinecone index reports {data.vectorStoreTotalVectors.toLocaleString()} vector{data.vectorStoreTotalVectors === 1 ? "" : "s"}, but this app&apos;s local <span className="font-mono">document_chunks</span> table has zero rows. Ticker coverage below is a local ledger view, not a full Pinecone inventory.
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
              The configured index <span className="font-mono">{data.vectorStore.indexName}</span> does not exist.
            </StatusNotice>
          )}
          {data.vectorStore?.error && (
            <StatusNotice tone="danger" title="Pinecone API Error">
              <span className="font-mono">{data.vectorStore.indexName}</span>: {data.vectorStore.error}
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
            <Card className="mb-6 overflow-hidden">
              <div className="flex items-center gap-3 border-b border-line px-4 py-3 text-xs uppercase tracking-wide text-muted">
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
            <div className="text-sm text-down bg-down/10 border border-down/20 rounded-lg p-3 mb-4">
              <strong>{data.coverageGaps.length} ticker{data.coverageGaps.length !== 1 ? "s" : ""} have filing records but zero chunks in the index:</strong>{" "}
              {data.coverageGaps.join(", ")}
            </div>
          )}

          {/* Per-ticker list */}
          <Card className="overflow-hidden">
            <div className="px-4 py-3 border-b border-line text-xs text-muted uppercase tracking-wide flex items-center gap-3">
              <span className="w-16 shrink-0">Ticker</span>
              <span className="flex-1">Chunk coverage</span>
            </div>
            <div className="px-4 divide-y divide-line/20 max-h-[60vh] overflow-y-auto">
              {filtered.length === 0 ? (
                <div className="text-sm text-muted text-center py-12">
                  {search ? "No tickers match your filter." : "No indexed filings yet."}
                </div>
              ) : (
                filtered.map((t) => <TickerRow key={t.symbol} coverage={t} />)
              )}
            </div>
          </Card>

          {/* RAG usage table */}
          {data.ragUsage.rows.length > 0 && (
            <div className="mt-6">
              <h2 className="text-sm font-semibold text-fg mb-2">App-Recorded RAG Usage</h2>
              <Card className="overflow-hidden">
                <div className="px-4 py-2 border-b border-line text-xs text-muted uppercase tracking-wide flex items-center gap-3">
                  <span className="w-24 shrink-0">Operation</span>
                  <span className="w-20 shrink-0">Provider</span>
                  <span className="flex-1">Model</span>
                  <span className="w-16 text-right">Calls</span>
                  <span className="w-20 text-right">Units / Tokens</span>
                  <span className="w-20 text-right">Cost</span>
                </div>
                <div className="divide-y divide-line/20 max-h-[30vh] overflow-y-auto">
                  {data.ragUsage.rows.map((row, i) => (
                    <div key={i} className="px-4 py-2 flex items-center gap-3 text-xs">
                      <span className="w-24 shrink-0 font-mono text-fg/80">{opLabel(row.operation)}</span>
                      <span className="w-20 shrink-0 text-muted">{providerLabel(row.provider)}</span>
                      <span className="flex-1 text-muted truncate">{row.model ?? "—"}</span>
                      <span className="w-16 text-right font-mono text-muted">{row.calls}</span>
                      <span
                        className="w-20 text-right font-mono text-muted"
                        title={row.provider === "pinecone" && row.operation === "upsert" ? "Estimated Pinecone Write Units for upserts. Voyage rows show estimated input tokens." : row.provider === "pinecone" && row.operation === "query" ? "Pinecone Read Units reported by the query response when available, otherwise a conservative fallback." : "Estimated input tokens."}
                      >
                        {fmtInt(row.tokensIn)}
                      </span>
                      <span
                        className="w-20 text-right font-mono text-fg"
                        title={row.provider === "pinecone" ? "Pinecone cost is not estimated here; use provider billing/usage views for dollars. Units are shown in the Units / Tokens column." : "Estimated Voyage cost from app-recorded token volume and static pricing."}
                      >
                        {row.provider === "pinecone" ? "—" : fmtCost(row.costEstUsd)}
                      </span>
                    </div>
                  ))}
                </div>
              </Card>
            </div>
          )}
        </>
      )}

      {loading && !data && (
        <div className="text-sm text-muted text-center py-12">Loading…</div>
      )}
    </div>
  );
}
