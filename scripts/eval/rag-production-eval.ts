#!/usr/bin/env tsx

/**
 * Production-path retrieval evaluation.
 *
 * This calls retrieveContextDetailedWithStatus in the CLI (not search-fusion) and never writes
 * corpus data. The normal production retrieval path may emit its ordinary usage/audit receipts;
 * the evaluator reads those receipts after the run when available.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { RetrievedChunk, RetrievalStatus } from "../../src/lib/vector-db";

export const MAX_PRODUCTION_EVAL_CASES = 100;
export const MAX_PRODUCTION_EVAL_LIMIT = 100;
export const DEFAULT_PRODUCTION_RAG_EVAL_USER_ID = "local";

export interface ProductionRagGoldenCase {
  id: string;
  query: string;
  symbol: string;
  /** Source-publication timestamp, never an indexing timestamp. */
  authoritativeAsOf: string;
  /** Stable provenance selectors. `vectorId` is diagnostic-only and never establishes relevance. */
  expectedEvidenceRefs: ExpectedEvidenceRef[];
  category?: string;
  expectedSources?: string[];
  expectedSections?: string[];
  notes?: string;
}

export interface ExpectedEvidenceRef {
  source?: string;
  accession?: string;
  section?: string;
  ordinal?: number;
  contentHash?: string;
  /** Optional historical diagnostic, deliberately excluded from relevance matching. */
  vectorId?: string;
}

export interface EvaluationModelConfiguration {
  label: string;
  embeddingProvider: string;
  embeddingModel: string;
  embeddingCredentialSource?: string;
  rerankProvider: string;
  rerankModel: string;
  rerankAvailable?: boolean;
  pineconeIndexName?: string;
  pineconeCredentialSource?: string;
  pineconeProviderAuthority?: string;
  ledgerAuthority?: string;
}

export type ProductionRetrievalOptions = {
  asOf: string;
  strictAsOf: true;
  /** Isolated evaluator run identity for candidate-pool/telemetry receipts. */
  runId?: string;
  /** Cosine floor applied like strategy/chat production callers. */
  minScore?: number;
  /** Post-rerank relevance floor applied like strategy/chat production callers. */
  minRelevanceScore?: number;
  /** Near-duplicate suppression threshold applied like strategy/chat production callers. */
  dedupeSimilarity?: number;
  applyDefaultFloors?: boolean;
};

export interface ProductionRetrievalAdapter {
  retrieve(
    query: string,
    symbol: string,
    limit: number,
    userId: string,
    options: ProductionRetrievalOptions
  ): Promise<{ chunks: RetrievedChunk[]; status: RetrievalStatus }>;
  runtimeConfiguration?(userId: string): Promise<Omit<EvaluationModelConfiguration, "label">>;
}

export interface RagUsageReceipt {
  calls: number;
  tokensIn: number;
  tokensOut: number;
  batchCount: number;
  costEstUsd: number | null;
  byOperation: Array<{
    operation: string;
    provider: string;
    model: string | null;
    calls: number;
    tokensIn: number;
    tokensOut: number;
    batchCount: number;
    costEstUsd: number | null;
  }>;
}

export interface ProductionRagEvalOptions {
  limit?: number;
  /** Credentialed user whose provider keys and usage receipts are exercised. */
  userId?: string;
  /** Isolated run identity kept separate from the credentialed retrieval user. */
  runId?: string;
  configuration?: EvaluationModelConfiguration;
  retriever?: ProductionRetrievalAdapter;
  usageReceipt?: (startedAt: string, endedAt: string, userId: string) => RagUsageReceipt | undefined | Promise<RagUsageReceipt | undefined>;
  now?: () => number;
}

export interface ProductionRagEvalCaseResult {
  id: string;
  category: string;
  query: string;
  symbol: string;
  authoritativeAsOf: string;
  status: RetrievalStatus;
  latencyMs: number;
  returnedCount: number;
  expectedEvidenceRefs: ExpectedEvidenceRef[];
  returnedEvidenceIds: string[];
  matchedExpectedRefIndices: number[];
  diagnosticVectorIdMatches: Array<{ refIndex: number; vectorId: string }>;
  relevantRanks: number[];
  recallAtK: number;
  reciprocalRank: number;
  ndcgAtK: number;
  pitFutureEvidenceIds: string[];
  undatedEvidenceIds: string[];
  pitValid: boolean;
  duplicateRate: number;
  sources: string[];
  sections: string[];
  expectedSourceCoverage?: number;
  expectedSectionCoverage?: number;
}

export interface ProductionRagEvalReport {
  schemaVersion: 2;
  generatedAt: string;
  configuration: EvaluationModelConfiguration;
  configurationSource: "runtime-resolved" | "injected-adapter";
  limit: number;
  userId: string;
  runId: string;
  caseCount: number;
  evaluationContract: {
    strictAsOf: true;
    serverAsOfFilterEnabled: boolean;
    /** Production-like cosine/relevance/dedupe floors applied by the default retriever. */
    productionRetrievalFloors: true;
  };
  statusCounts: Record<RetrievalStatus, number>;
  metrics: {
    recallAtK: number;
    mrr: number;
    ndcgAtK: number;
    pitFutureEvidenceCount: number;
    pitFutureEvidenceRate: number;
    undatedEvidenceCount: number;
    undatedEvidenceRate: number;
    pitValid: boolean;
    pitInvalidCaseIds: string[];
    duplicateRate: number;
    latencyMs: { p50: number; p95: number; p99: number; mean: number };
  };
  usageReceipt?: RagUsageReceipt;
  cases: ProductionRagEvalCaseResult[];
}

const PRODUCTION_RETRIEVER: ProductionRetrievalAdapter = {
  // Dynamic import keeps fixture/unit evaluation hermetic. The CLI still invokes the actual
  // production function, rather than a parallel search-fusion implementation.
  retrieve: async (query, symbol, limit, userId, options) => {
    const {
      retrieveContextDetailedWithStatus,
      defaultMinScore,
      defaultRelevanceFloor,
      defaultDedupeSimilarity
    } = await import("../../src/lib/vector-db");
    // Match strategy filings + chat kb_search floors so promotion metrics cannot credit
    // low-score / near-duplicate chunks that production would drop before prompt injection.
    return retrieveContextDetailedWithStatus(query, symbol, limit, userId, {
      ...options,
      minScore: options.minScore ?? defaultMinScore(),
      minRelevanceScore: options.minRelevanceScore ?? defaultRelevanceFloor(),
      dedupeSimilarity: options.dedupeSimilarity ?? defaultDedupeSimilarity(),
      applyDefaultFloors: options.applyDefaultFloors ?? true
    });
  },
  runtimeConfiguration: async (userId) => {
    const { resolvedRagRuntimeConfiguration } = await import("../../src/lib/vector-db");
    return resolvedRagRuntimeConfiguration(userId);
  }
};

export function defaultEvaluationModelConfiguration(): EvaluationModelConfiguration {
  // These are an explicit run label/receipt only. This evaluator deliberately does not mutate
  // provider env or production defaults; shadow runs set their environment before starting it.
  return {
    label: process.env.RAG_EVAL_PROFILE?.trim() || "current-production-env",
    embeddingProvider: process.env.RAG_EMBED_PROVIDER?.trim() || "production-default",
    embeddingModel: process.env.RAG_EMBED_MODEL?.trim() || "production-default",
    rerankProvider: process.env.RAG_RERANK_PROVIDER?.trim() || "production-default",
    rerankModel: process.env.RAG_RERANK_MODEL?.trim() || "production-default"
  };
}

export function loadFrozenProductionRagGoldenSet(path: string): ProductionRagGoldenCase[] {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const rows = Array.isArray(parsed) ? parsed : (parsed as { cases?: unknown })?.cases;
  if (!Array.isArray(rows)) throw new Error("Expected a JSON array or { cases: [...] }.");
  if (rows.length > MAX_PRODUCTION_EVAL_CASES) {
    throw new Error(`Production RAG evaluation is capped at ${MAX_PRODUCTION_EVAL_CASES} cases per run.`);
  }
  return rows.map((row, index) => parseGoldenCase(row, `file row ${index + 1}`));
}

export async function runProductionRagEvaluation(
  cases: ProductionRagGoldenCase[],
  options: ProductionRagEvalOptions = {}
): Promise<ProductionRagEvalReport> {
  if (cases.length === 0) throw new Error("Production RAG evaluation refuses an empty golden set.");
  if (cases.length > MAX_PRODUCTION_EVAL_CASES) {
    throw new Error(`Production RAG evaluation is capped at ${MAX_PRODUCTION_EVAL_CASES} cases per run.`);
  }
  const limit = strictPositiveInteger(options.limit, 20, "limit", MAX_PRODUCTION_EVAL_LIMIT);
  const userId = options.userId?.trim() || process.env.RAG_EVAL_USER_ID?.trim() || DEFAULT_PRODUCTION_RAG_EVAL_USER_ID;
  const runId = options.runId?.trim() || `rag-eval:${randomUUID()}`;
  const now = options.now ?? Date.now;
  const startedAt = new Date(now()).toISOString();
  const retriever = options.retriever ?? PRODUCTION_RETRIEVER;
  const results: ProductionRagEvalCaseResult[] = [];

  for (const evalCase of cases) {
    assertAuthoritativeAsOf(evalCase.authoritativeAsOf, evalCase.id);
    const begin = now();
    const { chunks, status } = await retriever.retrieve(
      evalCase.query,
      evalCase.symbol,
      limit,
      userId,
      {
        asOf: evalCase.authoritativeAsOf,
        strictAsOf: true,
        runId,
        // Injected/test retrievers may ignore these; PRODUCTION_RETRIEVER applies the same
        // cosine/relevance/dedupe floors as strategy filings + chat kb_search.
        applyDefaultFloors: true
      }
    );
    results.push(scoreProductionRagCase(evalCase, chunks, status, Math.max(0, now() - begin), limit));
  }

  const statusCounts: Record<RetrievalStatus, number> = {
    ok: 0,
    no_memory: 0,
    lookup_failed: 0,
    budget_skipped: 0,
    degraded: 0
  };
  for (const result of results) statusCounts[result.status]++;
  const retrieved = results.flatMap((result) => ({ future: result.pitFutureEvidenceIds.length, undated: result.undatedEvidenceIds.length, count: result.returnedCount }));
  const returnedCount = retrieved.reduce((sum, item) => sum + item.count, 0);
  const latency = results.map((result) => result.latencyMs);
  const pitInvalidCaseIds = results.filter((result) => !result.pitValid).map((result) => result.id);
  const endedAt = new Date(now()).toISOString();
  const declaredConfiguration = options.configuration ?? defaultEvaluationModelConfiguration();
  const runtimeConfiguration = await retriever.runtimeConfiguration?.(userId);

  return {
    schemaVersion: 2,
    generatedAt: new Date(now()).toISOString(),
    configuration: runtimeConfiguration
      ? { label: declaredConfiguration.label, ...runtimeConfiguration }
      : declaredConfiguration,
    configurationSource: runtimeConfiguration ? "runtime-resolved" : "injected-adapter",
    limit,
    userId,
    runId,
    caseCount: results.length,
    evaluationContract: {
      strictAsOf: true,
      serverAsOfFilterEnabled: envFlagEnabled(process.env.VECTOR_ASOF_SERVER_FILTER),
      productionRetrievalFloors: true
    },
    statusCounts,
    metrics: {
      recallAtK: average(results.map((result) => result.recallAtK)),
      mrr: average(results.map((result) => result.reciprocalRank)),
      ndcgAtK: average(results.map((result) => result.ndcgAtK)),
      pitFutureEvidenceCount: retrieved.reduce((sum, item) => sum + item.future, 0),
      pitFutureEvidenceRate: ratio(retrieved.reduce((sum, item) => sum + item.future, 0), returnedCount),
      undatedEvidenceCount: retrieved.reduce((sum, item) => sum + item.undated, 0),
      undatedEvidenceRate: ratio(retrieved.reduce((sum, item) => sum + item.undated, 0), returnedCount),
      pitValid: pitInvalidCaseIds.length === 0,
      pitInvalidCaseIds,
      duplicateRate: average(results.map((result) => result.duplicateRate)),
      latencyMs: { p50: percentile(latency, 0.5), p95: percentile(latency, 0.95), p99: percentile(latency, 0.99), mean: average(latency) }
    },
    ...(options.usageReceipt ? { usageReceipt: await options.usageReceipt(startedAt, endedAt, userId) } : {}),
    cases: results
  };
}

export function scoreProductionRagCase(
  evalCase: ProductionRagGoldenCase,
  chunks: RetrievedChunk[],
  status: RetrievalStatus,
  latencyMs: number,
  limit: number
): ProductionRagEvalCaseResult {
  const ids = chunks.map((chunk) => chunk.id);
  const matchedRefsByRank = chunks.map((chunk) => evalCase.expectedEvidenceRefs
    .flatMap((ref, refIndex) => stableRefMatchesChunk(ref, chunk) ? [refIndex] : []));
  // A duplicate chunk must not improve nDCG. Record only each reference's first retrieval rank.
  const firstRankByRef = new Map<number, number>();
  matchedRefsByRank.forEach((refIndices, index) => {
    for (const refIndex of refIndices) if (!firstRankByRef.has(refIndex)) firstRankByRef.set(refIndex, index + 1);
  });
  const relevantRanks = [...firstRankByRef.values()].sort((a, b) => a - b);
  const matchedExpectedRefIndices = [...new Set(matchedRefsByRank.flat())].sort((a, b) => a - b);
  const diagnosticVectorIdMatches = evalCase.expectedEvidenceRefs.flatMap((ref, refIndex) =>
    ref.vectorId && ids.includes(ref.vectorId) ? [{ refIndex, vectorId: ref.vectorId }] : []);
  const firstRank = relevantRanks[0];
  const sourceSet = new Set(chunks.flatMap((chunk) => chunk.source ? [chunk.source] : []));
  const sectionSet = new Set(chunks.flatMap((chunk) => chunk.section ? [chunk.section] : []));
  const future: string[] = [];
  const undated: string[] = [];
  const duplicateKeys: string[] = [];
  const asOfMs = Date.parse(evalCase.authoritativeAsOf);
  for (const chunk of chunks) {
    const stamp = resolveChunkStamp(chunk);
    if (stamp == null) undated.push(chunk.id);
    else if (stamp > asOfMs) future.push(chunk.id);
    duplicateKeys.push(chunkDuplicateKey(chunk));
  }
  const relevantAtK = new Set(matchedRefsByRank.slice(0, limit).flat()).size;
  const idealRelevant = Math.min(evalCase.expectedEvidenceRefs.length, limit);
  const dcg = relevantRanks.filter((rank) => rank <= limit).reduce((sum, rank) => sum + 1 / Math.log2(rank + 1), 0);
  const idealDcg = Array.from({ length: idealRelevant }, (_, index) => 1 / Math.log2(index + 2)).reduce((sum, value) => sum + value, 0);

  return {
    id: evalCase.id,
    category: evalCase.category ?? "uncategorized",
    query: evalCase.query,
    symbol: evalCase.symbol,
    authoritativeAsOf: evalCase.authoritativeAsOf,
    status,
    latencyMs,
    returnedCount: chunks.length,
    expectedEvidenceRefs: evalCase.expectedEvidenceRefs,
    returnedEvidenceIds: ids,
    matchedExpectedRefIndices,
    diagnosticVectorIdMatches,
    relevantRanks,
    recallAtK: ratio(relevantAtK, evalCase.expectedEvidenceRefs.length),
    reciprocalRank: firstRank ? 1 / firstRank : 0,
    ndcgAtK: idealDcg === 0 ? 0 : dcg / idealDcg,
    pitFutureEvidenceIds: future,
    undatedEvidenceIds: undated,
    pitValid: future.length === 0 && undated.length === 0,
    duplicateRate: duplicateRate(duplicateKeys),
    sources: [...sourceSet].sort(),
    sections: [...sectionSet].sort(),
    ...(evalCase.expectedSources ? { expectedSourceCoverage: coverage(sourceSet, evalCase.expectedSources) } : {}),
    ...(evalCase.expectedSections ? { expectedSectionCoverage: coverage(sectionSet, evalCase.expectedSections) } : {})
  };
}

export async function readRagUsageReceipt(startedAt: string, endedAt: string, userId: string): Promise<RagUsageReceipt | undefined> {
  try {
    const { getDb } = await import("../../src/lib/db");
    const rows = getDb().prepare(
      `SELECT operation, provider, model, COUNT(*) AS calls,
              COALESCE(SUM(tokens_in), 0) AS tokens_in,
              COALESCE(SUM(tokens_out), 0) AS tokens_out,
              COALESCE(SUM(batch_count), 0) AS batch_count,
              SUM(cost_est_usd) AS cost_est_usd
       FROM rag_usage WHERE user_id = ? AND created_at >= ? AND created_at <= ?
       GROUP BY operation, provider, model ORDER BY operation, provider, model`
    ).all(userId, startedAt, endedAt) as Array<Record<string, unknown>>;
    const byOperation = rows.map((row) => ({
      operation: String(row.operation), provider: String(row.provider), model: row.model == null ? null : String(row.model),
      calls: Number(row.calls), tokensIn: Number(row.tokens_in), tokensOut: Number(row.tokens_out),
      batchCount: Number(row.batch_count), costEstUsd: row.cost_est_usd == null ? null : Number(row.cost_est_usd)
    }));
    return {
      calls: byOperation.reduce((sum, row) => sum + row.calls, 0),
      tokensIn: byOperation.reduce((sum, row) => sum + row.tokensIn, 0),
      tokensOut: byOperation.reduce((sum, row) => sum + row.tokensOut, 0),
      batchCount: byOperation.reduce((sum, row) => sum + row.batchCount, 0),
      costEstUsd: byOperation.some((row) => row.costEstUsd != null)
        ? byOperation.reduce((sum, row) => sum + (row.costEstUsd ?? 0), 0) : null,
      byOperation
    };
  } catch {
    return undefined;
  }
}

function parseGoldenCase(value: unknown, label: string): ProductionRagGoldenCase {
  if (!value || typeof value !== "object") throw new Error(`${label}: expected object.`);
  const row = value as Record<string, unknown>;
  const requiredString = (key: string) => {
    const raw = row[key];
    if (typeof raw !== "string" || !raw.trim()) throw new Error(`${label}: ${key} must be a non-empty string.`);
    return raw.trim();
  };
  const asStringArray = (key: string, optional = false): string[] | undefined => {
    const raw = row[key];
    if (raw == null && optional) return undefined;
    if (!Array.isArray(raw) || raw.length === 0 || raw.some((item) => typeof item !== "string" || !item.trim())) throw new Error(`${label}: ${key} must be a non-empty string array.`);
    return [...new Set(raw.map((item) => item.trim()))];
  };
  const golden: ProductionRagGoldenCase = {
    id: requiredString("id"), query: requiredString("query"), symbol: requiredString("symbol").toUpperCase(),
    authoritativeAsOf: requiredString("authoritativeAsOf"), expectedEvidenceRefs: parseEvidenceRefs(row.expectedEvidenceRefs, "expectedEvidenceRefs"),
    ...(typeof row.category === "string" && row.category.trim() ? { category: row.category.trim() } : {}),
    ...(asStringArray("expectedSources", true) ? { expectedSources: asStringArray("expectedSources", true) } : {}),
    ...(asStringArray("expectedSections", true) ? { expectedSections: asStringArray("expectedSections", true) } : {}),
    ...(typeof row.notes === "string" && row.notes.trim() ? { notes: row.notes.trim() } : {})
  };
  assertAuthoritativeAsOf(golden.authoritativeAsOf, golden.id);
  return golden;
}

function parseEvidenceRefs(value: unknown, field: string): ExpectedEvidenceRef[] {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error(`${field} must be a non-empty array.`);
  return parsed.map((item, index) => {
    if (!item || typeof item !== "object") throw new Error(`${field}[${index}] must be an object.`);
    const row = item as Record<string, unknown>;
    const ref: ExpectedEvidenceRef = {
      ...(optionalString(row.source, field, index, "source") ? { source: optionalString(row.source, field, index, "source") } : {}),
      ...(optionalString(row.accession, field, index, "accession") ? { accession: optionalString(row.accession, field, index, "accession") } : {}),
      ...(optionalString(row.section, field, index, "section") ? { section: optionalString(row.section, field, index, "section") } : {}),
      ...(optionalString(row.contentHash, field, index, "contentHash") ? { contentHash: optionalString(row.contentHash, field, index, "contentHash") } : {}),
      ...(optionalString(row.vectorId, field, index, "vectorId") ? { vectorId: optionalString(row.vectorId, field, index, "vectorId") } : {})
    };
    if (row.ordinal != null) {
      if (typeof row.ordinal !== "number" || !Number.isInteger(row.ordinal) || row.ordinal < 0) throw new Error(`${field}[${index}].ordinal must be a non-negative integer.`);
      ref.ordinal = row.ordinal;
    }
    // Scoring never compares ref.vectorId to chunk.id (vectorId is diagnostic-only). Reject
    // vectorId-only golden refs so they cannot vacuously match every returned chunk.
    const hasStableCoords = Boolean(ref.accession && (ref.section || ref.ordinal != null));
    // contentHash alone (or with only source) is not occurrence coordinates — require accession,
    // section, or ordinal so the match cannot float across filings.
    const hasContentHashCoords = Boolean(
      ref.contentHash && (ref.accession || ref.section || ref.ordinal != null)
    );
    if (!hasStableCoords && !hasContentHashCoords) {
      if (ref.contentHash) {
        throw new Error(`${field}[${index}] contentHash must be paired with accession, section, or ordinal.`);
      }
      throw new Error(
        `${field}[${index}] requires accession plus section/ordinal (or contentHash with occurrence coordinates); vectorId-only refs are rejected because scoring does not compare vectorId.`
      );
    }
    return ref;
  });
}

function optionalString(value: unknown, field: string, index: number, key: string): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field}[${index}].${key} must be a non-empty string.`);
  return value.trim();
}

function stableRefMatchesChunk(ref: ExpectedEvidenceRef, chunk: RetrievedChunk): boolean {
  const metadata = chunk.metadata ?? {};
  const source = chunk.source ?? (typeof metadata.source === "string" ? metadata.source : undefined);
  const section = chunk.section ?? (typeof metadata.section === "string" ? metadata.section : undefined);
  const accession = typeof metadata.accession === "string" ? metadata.accession : undefined;
  const contentHash = typeof metadata.content_hash === "string" ? metadata.content_hash : undefined;
  const ordinal = typeof metadata.chunk_ordinal === "number" ? metadata.chunk_ordinal : typeof metadata.ordinal === "number" ? metadata.ordinal : undefined;
  return (!ref.source || ref.source === source)
    && (!ref.accession || ref.accession === accession)
    && (!ref.section || ref.section === section)
    && (ref.ordinal == null || ref.ordinal === ordinal)
    && (!ref.contentHash || ref.contentHash === contentHash);
}

function assertAuthoritativeAsOf(asOf: string, id: string): void {
  if (!Number.isFinite(Date.parse(asOf))) throw new Error(`Case ${id}: authoritativeAsOf must be a parseable ISO timestamp.`);
}

function resolveChunkStamp(chunk: RetrievedChunk): number | undefined {
  // Keep the same precedence as vector-db.resolveAsOfStamp while staying import-free for
  // hermetic evaluator mechanics tests.
  const raw = chunk.metadata?.acceptance_datetime
    ?? chunk.metadata?.published_at
    ?? chunk.metadata?.as_of
    ?? chunk.metadata?.timestamp;
  const metadataStamp = raw == null ? undefined : typeof raw === "number" ? raw : Date.parse(String(raw));
  if (metadataStamp != null && Number.isFinite(metadataStamp)) return metadataStamp;
  if (!chunk.as_of) return undefined;
  const parsed = Date.parse(chunk.as_of);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function chunkDuplicateKey(chunk: RetrievedChunk): string {
  const contentHash = chunk.metadata?.content_hash;
  if (typeof contentHash === "string" && contentHash) return `hash:${contentHash}`;
  const accession = chunk.metadata?.accession;
  const section = chunk.section ?? chunk.metadata?.section;
  if (typeof accession === "string" && accession && typeof section === "string" && section) return `doc:${accession}:${section}:${normalizedText(chunk.text)}`;
  return `text:${normalizedText(chunk.text)}`;
}

function normalizedText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function duplicateRate(keys: string[]): number {
  return keys.length === 0 ? 0 : (keys.length - new Set(keys).size) / keys.length;
}

function coverage(actual: Set<string>, expected: string[]): number {
  return expected.length === 0 ? 1 : expected.filter((item) => actual.has(item)).length / expected.length;
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * percentileValue) - 1))]!;
}

function strictPositiveInteger(value: number | undefined, fallback: number, label: string, max: number): number {
  if (value == null) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new Error(`${label} must be an integer from 1 to ${max}.`);
  }
  return value;
}

function envFlagEnabled(value: string | undefined): boolean {
  return ["1", "true", "on", "yes"].includes((value ?? "").trim().toLowerCase());
}

interface CliArgs {
  input: string;
  output?: string;
  allowLive: boolean;
  allowPitViolations: boolean;
  limit: number;
  userId?: string;
  runId?: string;
  configuration: EvaluationModelConfiguration;
}

function parseArgs(argv: string[]): CliArgs {
  const configuration = defaultEvaluationModelConfiguration();
  const args: Omit<CliArgs, "input"> & { input?: string } = {
    allowLive: false,
    allowPitViolations: false,
    limit: 20,
    userId: process.env.RAG_EVAL_USER_ID?.trim() || DEFAULT_PRODUCTION_RAG_EVAL_USER_ID,
    configuration
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]; const next = argv[i + 1];
    if (arg === "--input" && next) args.input = next, i++;
    else if (arg === "--output" && next) args.output = next, i++;
    else if (arg === "--limit" && next) args.limit = strictPositiveInteger(Number(next), args.limit, "--limit", MAX_PRODUCTION_EVAL_LIMIT), i++;
    else if (arg === "--user" && next) args.userId = next, i++;
    else if (arg === "--run-id" && next) args.runId = next, i++;
    else if (arg === "--profile" && next) args.configuration.label = next, i++;
    else if (arg === "--allow-live") args.allowLive = true;
    else if (arg === "--allow-pit-violations") args.allowPitViolations = true;
    else if (arg === "--help" || arg === "-h") { printHelp(); process.exit(0); }
    else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  if (!args.input) throw new Error("Production RAG evaluation requires --input <frozen-cases.json>.");
  return args as CliArgs;
}

function printHelp(): void {
  console.log(`Usage: npm run eval:rag-production -- --allow-live [options]

Read-only against corpus: calls the production retrieveContextDetailed path only. The normal
retrieval path may emit its usual usage/audit receipts. No embeddings or vectors are written.

  --input cases.json         Required frozen, version-controlled golden cases
  --output result.json       Write machine-readable JSON (stdout always prints JSON)
  --limit N                  Retrieval limit (default 20; hard maximum 100)
  --user ID                  Credentialed retrieval user id (default RAG_EVAL_USER_ID or local)
  --run-id ID                Isolated report/run id (default generated rag-eval UUID)
  --profile LABEL            Comparison label recorded in output
  --allow-live               Required: permits live read calls to configured RAG providers
  --allow-pit-violations     Diagnostic only: do not fail the process on future/undated evidence
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.allowLive) throw new Error("Refusing live RAG retrieval without --allow-live.");
  const cases = loadFrozenProductionRagGoldenSet(resolve(args.input));
  const report = await runProductionRagEvaluation(cases, {
    limit: args.limit, userId: args.userId, runId: args.runId, configuration: args.configuration, usageReceipt: readRagUsageReceipt
  });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (args.output) {
    const output = resolve(args.output);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, json, "utf8");
  }
  process.stdout.write(json);
  if (!report.metrics.pitValid && !args.allowPitViolations) {
    console.error(`Production RAG evaluation failed PIT validity for: ${report.metrics.pitInvalidCaseIds.join(", ")}`);
    process.exitCode = 3;
  }
}

const invokedDirectly = (() => {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href; } catch { return false; }
})();

if (invokedDirectly) {
  main().catch((error) => {
    console.error("Production RAG evaluation failed:", error instanceof Error ? error.message : String(error));
    process.exit(2);
  });
}
