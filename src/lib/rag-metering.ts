// Per-user RAG (Voyage / Pinecone) usage ledger.
//
// Mirrors src/lib/llm-usage.ts: every Voyage embed or rerank call and every Pinecone
// upsert or query call records a row so the operator can meter API spend.
// RAG keys are app-funded (resolved via resolveApiKey), so the userId is always 'local'
// in the system path; per-user separation happens when a user provides their own key.
//
// Pricing notes (approximate, as of 2026-07; verify before committing spend):
//   - voyage-finance-2 embed: $0.00012/1K tokens after the free tier
//   - rerank-2.5:             $0.00005/1K processed tokens after the free tier
//   - Pinecone: serverless — metered by Read/Write Units; rows store units, not dollars.

import crypto from "crypto";
import { audit, getDb } from "./db";
import { pushRagUsage } from "./usage-monitor-push";

// ── Types ────────────────────────────────────────────────────────────────────

export type RagOperation = "embed" | "rerank" | "query" | "upsert";

export interface RagUsageEntry {
  userId?: string;
  operation: RagOperation;
  provider?: string;
  model?: string;
  /** Estimated input tokens; for Pinecone ops this stores estimated/reported Read or Write Units. */
  tokensIn?: number;
  /** Estimated output tokens; for Pinecone ops this stores record count. */
  tokensOut?: number;
  /** Number of items in the batch (texts / records). */
  batchCount?: number;
}

export interface RagUsageRow {
  userId: string;
  operation: RagOperation;
  provider: string;
  model: string | null;
  calls: number;
  tokensIn: number;
  tokensOut: number;
  batchCount: number;
  costEstUsd: number;
}

// ── Cost estimation (best-effort) ────────────────────────────────────────────

const VOYAGE_PRICE_PER_1K_TOKENS: Record<string, { embed: number; rerank: number }> = {
  "voyage-finance-2": { embed: 0.00012, rerank: 0 },
  "voyage-4": { embed: 0.00006, rerank: 0 },
  "voyage-4-lite": { embed: 0.00002, rerank: 0 },
  "voyage-4-large": { embed: 0.00012, rerank: 0 },
  "rerank-2.5": { embed: 0, rerank: 0.00005 },
  "rerank-2.5-lite": { embed: 0, rerank: 0.00002 },
  "rerank-2": { embed: 0, rerank: 0.00005 },
};

function estimateRagCost(
  provider: string,
  model: string | undefined,
  operation: RagOperation,
  tokensIn: number
): number | undefined {
  if (provider !== "voyage") return undefined;
  if (operation === "query" || operation === "upsert") return undefined;
  const modelKey = model || "voyage-finance-2";
  const prices =
    VOYAGE_PRICE_PER_1K_TOKENS[modelKey] ?? VOYAGE_PRICE_PER_1K_TOKENS["voyage-finance-2"];
  if (!prices) return undefined;
  const rate = operation === "embed" ? prices.embed : prices.rerank;
  return (tokensIn * rate) / 1000;
}

// ── Approximate token counting ───────────────────────────────────────────────

/** Crude token estimate from UTF-8 text length (Voyage uses a tokenizer; this is still approximate). */
function approxTokens(texts: string[]): number {
  return texts.reduce((sum, t) => sum + Math.max(1, Math.ceil(Buffer.byteLength(t, "utf8") / 4)), 0);
}

// ── Record ───────────────────────────────────────────────────────────────────

/** Record a RAG operation against a user. Never throws. */
export function recordRagUsage(entry: RagUsageEntry): void {
  try {
    const userId = entry.userId || "local";
    const provider = entry.provider || "voyage";
    const tokensIn = entry.tokensIn ?? 0;
    const tokensOut = entry.tokensOut ?? 0;
    const batchCount = entry.batchCount ?? 1;
    const cost = estimateRagCost(provider, entry.model, entry.operation, tokensIn);

    getDb()
      .prepare(
        `INSERT INTO rag_usage (id, user_id, operation, provider, model, tokens_in, tokens_out, batch_count, cost_est_usd, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        crypto.randomUUID(),
        userId,
        entry.operation,
        provider,
        entry.model ?? null,
        tokensIn,
        tokensOut,
        batchCount,
        cost ?? null,
        new Date().toISOString()
      );
    // Fire-and-forget forward to the API Usage Monitor (no-op unless configured; never throws).
    pushRagUsage({
      provider,
      operation: entry.operation,
      model: entry.model,
      userId,
      tokensIn,
      tokensOut,
      batchCount,
      costUsd: cost,
    });
  } catch {
    /* ledger is best-effort; never break the caller */
  }
}

/**
 * Convenience: record a Voyage embed call. Pass `userId` for per-user retrieval spend so the daily
 * LLM/RAG budget (`checkLlmDailyBudget`, which filters `rag_usage` by userId) actually sees it —
 * omitting it books the spend under the default "local" user and a non-local user's ceiling never trips.
 */
export function meterEmbed(texts: string[], model?: string, userId?: string): void {
  const tokens = approxTokens(texts);
  recordRagUsage({
    userId,
    operation: "embed",
    provider: "voyage",
    model: model || "voyage-finance-2",
    tokensIn: tokens,
    batchCount: texts.length
  });
}

/**
 * Convenience: record a Voyage rerank call. Pass `userId` so retrieval rerank spend counts toward that
 * user's daily budget (see `meterEmbed`).
 */
export function meterRerank(query: string, documents: string[], model?: string, userId?: string): void {
  const tokens = approxTokens([query, ...documents]);
  recordRagUsage({
    userId,
    operation: "rerank",
    provider: "voyage",
    model: model || "rerank-2.5",
    tokensIn: tokens,
    batchCount: documents.length
  });
}

/**
 * Convenience: record a Pinecone query. Pass `userId` so retrieval query spend counts toward that
 * user's daily budget (see `meterEmbed`).
 */
export function meterPineconeQuery(readUnits: number, userId?: string, recordCount?: number): void {
  recordRagUsage({
    userId,
    operation: "query",
    provider: "pinecone",
    tokensIn: readUnits,
    tokensOut: recordCount,
    batchCount: recordCount ?? 1
  });
}

/**
 * Convenience: record a Pinecone upsert.
 */
export function meterPineconeUpsert(recordCount: number, userId?: string, estimatedWriteUnits?: number): void {
  recordRagUsage({
    userId,
    operation: "upsert",
    provider: "pinecone",
    tokensIn: estimatedWriteUnits,
    tokensOut: recordCount,
    batchCount: recordCount
  });
}

// ── Read ─────────────────────────────────────────────────────────────────────

/**
 * Aggregate RAG usage grouped by (userId, operation, provider, model).
 */
export function getRagUsageSummary(opts: { sinceIso?: string } = {}): RagUsageRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.sinceIso) {
    where.push("created_at >= ?");
    params.push(opts.sinceIso);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = getDb()
    .prepare(
      `SELECT user_id, operation, provider, model,
              COUNT(*) AS calls,
              COALESCE(SUM(tokens_in),0) AS tokens_in,
              COALESCE(SUM(tokens_out),0) AS tokens_out,
              COALESCE(SUM(batch_count),0) AS batch_count,
              COALESCE(SUM(cost_est_usd),0) AS cost_est_usd
       FROM rag_usage ${clause}
       GROUP BY user_id, operation, provider, model
       ORDER BY cost_est_usd DESC, calls DESC`
    )
    .all(...params) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    userId: String(r.user_id),
    operation: r.operation as RagOperation,
    provider: String(r.provider),
    model: r.model == null ? null : String(r.model),
    calls: Number(r.calls),
    tokensIn: Number(r.tokens_in),
    tokensOut: Number(r.tokens_out),
    batchCount: Number(r.batch_count),
    costEstUsd: Number(r.cost_est_usd)
  }));
}

// ── R5: consolidated per-retrieval distribution telemetry ───────────────────
//
// (2026-07-01 RAG backlog item R5.) Subsumes three overlapping proposals ("recall-proxy
// telemetry", "per-chunk retrieval trace", "embed/rerank cost meter") into ONE record per
// `retrieveContextDetailed` call, instead of three separate mechanisms. Default OFF via
// RAG_RETRIEVAL_TELEMETRY — when unset/off this is a complete no-op (not even a hashed-query
// computation runs), so default retrieval stays byte-for-byte unchanged.
//
// IMPORTANT — these are DISTRIBUTION telemetry, NOT a recall metric. Recall/MRR is only
// measurable against a golden set (see test/rag-retrieval-eval.test.ts); a field like
// `topCosine` or `finalCount` here says nothing about whether the RIGHT chunks were retrieved.
// Field names are chosen so an operator reading this table doesn't mistake "we got N results
// with a wide score spread" for "recall is good."

import { envFlagOn } from "./rag/env-flag";

/** Returns true when RAG_RETRIEVAL_TELEMETRY is truthy. Default OFF. */
export function retrievalTelemetryEnabled(): boolean {
  return envFlagOn("RAG_RETRIEVAL_TELEMETRY", false);
}

/** Stable, non-reversible hash of a query string — the raw query text must NEVER be persisted
 *  (it may contain private/user-scoped context), only a fingerprint for grouping/debugging. */
export function hashQuery(query: string): string {
  return crypto.createHash("sha256").update(query, "utf8").digest("hex").slice(0, 16);
}

export interface RetrievalQualityRecord {
  /** SHA-256 (first 16 hex) of the query — NEVER the raw query text. */
  queryHash: string;
  /** Requested result count (the caller's `limit`). */
  k: number;
  /** Number of raw Pinecone matches fetched before any post-recall filtering. */
  candidates: number;
  /** Count dropped by the cosine score floor (`minScore`). */
  droppedByMinScore: number;
  /** Count dropped by the as-of point-in-time guard. */
  droppedByAsOf: number;
  /** Whether hybrid BM25/RRF fusion ran for this call. */
  hybrid: boolean;
  /** Whether reranking was attempted for this call (not necessarily succeeded). */
  rerankAttempted: boolean;
  /** Whether reranking actually ran (fusedPool.length > limit) and returned scored results. */
  rerankRan: boolean;
  /** Top cosine similarity score in the final pool (undefined if the pool ended up empty). */
  topCosine?: number;
  /** Top Voyage cross-encoder relevance score, if rerank produced one (undefined otherwise). */
  topRelevanceScore?: number;
  /** Final chunk count returned to the caller after every stage (score floor/as-of/hybrid/rerank/limit). */
  finalCount: number;
}

/**
 * Record one consolidated retrieval-quality distribution record. Fire-and-forget: wrapped in
 * try/catch so a telemetry failure (DB unavailable, serialization error) can never break
 * retrieval. No-ops entirely when RAG_RETRIEVAL_TELEMETRY is unset/off — the caller is expected
 * to gate the (cheap but non-zero) call site itself, but this function double-checks the flag
 * so importing/calling it directly is always safe.
 */
export function recordRetrievalQuality(entry: RetrievalQualityRecord, userId: string = "local"): void {
  if (!retrievalTelemetryEnabled()) return;
  try {
    audit(
      "rag_retrieval_quality",
      {
        queryHash: entry.queryHash,
        k: entry.k,
        candidates: entry.candidates,
        droppedByMinScore: entry.droppedByMinScore,
        droppedByAsOf: entry.droppedByAsOf,
        hybrid: entry.hybrid,
        rerankAttempted: entry.rerankAttempted,
        rerankRan: entry.rerankRan,
        topCosine: entry.topCosine,
        topRelevanceScore: entry.topRelevanceScore,
        finalCount: entry.finalCount
      },
      userId
    );
  } catch {
    /* telemetry is best-effort only; never break retrieval */
  }
}
