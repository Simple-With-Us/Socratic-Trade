import { NextResponse } from "next/server";
import { getChunkCoverage, getChunkSourceBreakdown, getInternalSetting, getDb } from "@/lib/db";
import { getRagUsageSummary } from "@/lib/rag-metering";
import { getAllVectorStoreStats, getVectorStoreStats, activeEmbeddingModel, currentEmbedRev, type VectorIndexStats, type VectorStoreStats } from "@/lib/vector-db";
import { requireAdmin } from "@/lib/auth/admin";
import { getFmpTranscriptStatus } from "@/lib/web-sources/fmp-transcripts";
import { listDormantFeatureStatus } from "@/lib/dormant-features";

export const dynamic = "force-dynamic";

interface LastVectorIngest {
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
}

type VectorStoreAdminStats = VectorStoreStats & {
  lastIngest?: LastVectorIngest;
};

// Admin/diagnostic route: corpus coverage stats — what's in the RAG index per ticker,
// how fresh it is, and which tickers have no filings at all.
//
// GET  /api/admin/rag-coverage                       → full report
// GET  /api/admin/rag-coverage?sinceDays=7             → rag usage window
export async function GET(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const sinceDays = Number(url.searchParams.get("sinceDays")) || 30;
  const sinceIso = new Date(Date.now() - sinceDays * 24 * 60 * 60_000).toISOString();

  const db = getDb();

  const [chunkCoverage, chunkBreakdown, vectorStats, allVectorIndexes, ragUsage] = await Promise.all([
    Promise.resolve(getChunkCoverage()),
    Promise.resolve(getChunkSourceBreakdown()),
    getVectorStoreStats(),
    getAllVectorStoreStats(),
    Promise.resolve(getRagUsageSummary({ sinceIso }))
  ]);

  const activeModel = activeEmbeddingModel("local");
  const dormantFeatures = listDormantFeatureStatus();
  const readyCount = dormantFeatures.filter((f) => f.readyToEnable && !f.enabled).length;

  const filingsStats = db.prepare(`
    SELECT 
      ticker,
      COUNT(*) AS total_filings,
      SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END) AS completed_filings,
      MIN(filed_at) AS min_filed_at,
      MAX(filed_at) AS max_filed_at,
      MIN(accepted_at) AS min_accepted_at,
      MAX(accepted_at) AS max_accepted_at
    FROM sec_filings
    GROUP BY ticker
  `).all() as Array<{
    ticker: string;
    total_filings: number;
    completed_filings: number;
    min_filed_at: string;
    max_filed_at: string;
    min_accepted_at: string;
    max_accepted_at: string;
  }>;

  const parserVersions = db.prepare(`
    SELECT DISTINCT f.ticker, a.parser_version
    FROM sec_artifacts a
    JOIN sec_filings f ON a.accession = f.accession
  `).all() as Array<{ ticker: string; parser_version: string }>;

  const tickerParsers: Record<string, string[]> = {};
  for (const row of parserVersions) {
    if (!tickerParsers[row.ticker]) {
      tickerParsers[row.ticker] = [];
    }
    tickerParsers[row.ticker].push(row.parser_version);
  }

  const vectorStore: VectorStoreAdminStats = {
    ...vectorStats,
    lastIngest: getInternalSetting<LastVectorIngest>("vectorStore:lastIngest")
  };

  // Compile breakdowns
  const globalBreakdown: Record<string, number> = {};
  const tickerBreakdown: Record<string, Record<string, number>> = {};
  for (const row of chunkBreakdown) {
    globalBreakdown[row.source] = (globalBreakdown[row.source] ?? 0) + row.chunkCount;
    if (!tickerBreakdown[row.symbol]) {
      tickerBreakdown[row.symbol] = {};
    }
    tickerBreakdown[row.symbol][row.source] = row.chunkCount;
  }

  const chunkSymbols = new Set(chunkCoverage.map((r) => r.symbol));
  const ingestedSymbols = new Set(filingsStats.map((f) => f.ticker));
  const noChunksSymbols = [...ingestedSymbols].filter((s) => !chunkSymbols.has(s));

  const perTicker = filingsStats.map((stat) => {
    const symbol = stat.ticker;
    return {
      symbol,
      filings: stat.total_filings,
      completedFilings: stat.completed_filings,
      minFiledAt: stat.min_filed_at,
      maxFiledAt: stat.max_filed_at,
      minAcceptedAt: stat.min_accepted_at,
      maxAcceptedAt: stat.max_accepted_at,
      activeModel,
      parsers: tickerParsers[symbol] || [],
      chunks: chunkCoverage.find((c) => c.symbol === symbol)?.chunkCount ?? 0,
      latestChunkAt: chunkCoverage.find((c) => c.symbol === symbol)?.latestAt ?? null,
      breakdown: tickerBreakdown[symbol] ?? {}
    };
  }).sort((a, b) => b.chunks - a.chunks);

  const vectTotal = vectorStore?.totalVectorCount ?? 0;
  const allVectorTotal = (allVectorIndexes as VectorIndexStats[]).reduce((sum, row) => sum + (row.totalVectorCount ?? 0), 0);

  return NextResponse.json({
    sinceDays,
    perTicker,
    globalBreakdown,
    totalTickers: perTicker.length,
    totalChunks: perTicker.reduce((s, t) => s + t.chunks, 0),
    totalFilings: filingsStats.reduce((s, t) => s + t.total_filings, 0),
    vectorStore,
    vectorStoreTotalVectors: vectTotal,
    allVectorIndexes,
    allVectorStoreTotalVectors: allVectorTotal,
    coverageGaps: noChunksSymbols,
    earningsTranscripts: getFmpTranscriptStatus(),
    providerUsage: {
      pinecone: {
        monthlyUsageApiAvailable: false,
        note: "Pinecone Database APIs expose per-request usage on operations and live index stats, but not an org-month Write Unit total through the app's normal SDK path. Cross-check provider quota in the Pinecone console; this page shows app-recorded units plus live index inventory.",
        configuredIndexVectors: vectTotal,
        allVisibleIndexVectors: allVectorTotal
      },
      voyage: {
        usageApiAvailable: false,
        note: "Voyage documents usage monitoring in its dashboard/Atlas UI. This page can show app-recorded embed/rerank estimates, but cannot reconstruct provider-account totals for calls made before local metering or outside this app."
      }
    },
    ragUsage: {
      sinceDays,
      totalCostUsd: ragUsage.reduce((s, r) => s + r.costEstUsd, 0),
      rows: ragUsage
    },
    dormantFeatures: {
      currentEmbedRev: currentEmbedRev(),
      readyToEnableCount: readyCount,
      items: dormantFeatures
    }
  });
}
