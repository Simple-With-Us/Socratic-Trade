#!/usr/bin/env tsx

/**
 * Production-path retrieval evaluation.
 *
 * This calls retrieveContextDetailedWithStatus in the CLI (not search-fusion) and never writes
 * corpus data. The normal production retrieval path may emit its ordinary usage/audit receipts;
 * the evaluator reads those receipts after the run when available.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { RetrievedChunk, RetrievalStatus } from "../../src/lib/vector-db";

export interface ProductionRagGoldenCase {
  id: string;
  query: string;
  symbol: string;
  /** Source-publication timestamp, never an indexing timestamp. */
  authoritativeAsOf: string;
  expectedEvidenceIds: string[];
  category?: string;
  expectedSources?: string[];
  expectedSections?: string[];
  notes?: string;
}

export interface EvaluationModelConfiguration {
  label: string;
  embeddingProvider: string;
  embeddingModel: string;
  rerankProvider: string;
  rerankModel: string;
}

export interface ProductionRetrievalAdapter {
  retrieve(
    query: string,
    symbol: string,
    limit: number,
    userId: string,
    options: { asOf: string }
  ): Promise<{ chunks: RetrievedChunk[]; status: RetrievalStatus }>;
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
  userId?: string;
  configuration?: EvaluationModelConfiguration;
  retriever?: ProductionRetrievalAdapter;
  usageReceipt?: (startedAt: string, userId: string) => RagUsageReceipt | undefined | Promise<RagUsageReceipt | undefined>;
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
  expectedEvidenceIds: string[];
  returnedEvidenceIds: string[];
  relevantRanks: number[];
  recallAtK: number;
  reciprocalRank: number;
  ndcgAtK: number;
  pitFutureEvidenceIds: string[];
  undatedEvidenceIds: string[];
  duplicateRate: number;
  sources: string[];
  sections: string[];
  expectedSourceCoverage?: number;
  expectedSectionCoverage?: number;
}

export interface ProductionRagEvalReport {
  schemaVersion: 1;
  generatedAt: string;
  configuration: EvaluationModelConfiguration;
  limit: number;
  userId: string;
  caseCount: number;
  statusCounts: Record<RetrievalStatus, number>;
  metrics: {
    recallAtK: number;
    mrr: number;
    ndcgAtK: number;
    pitFutureEvidenceCount: number;
    pitFutureEvidenceRate: number;
    undatedEvidenceCount: number;
    undatedEvidenceRate: number;
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
    const { retrieveContextDetailedWithStatus } = await import("../../src/lib/vector-db");
    return retrieveContextDetailedWithStatus(query, symbol, limit, userId, options);
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
  return rows.map((row, index) => parseGoldenCase(row, `file row ${index + 1}`));
}

export async function loadDbProductionRagGoldenSet(): Promise<ProductionRagGoldenCase[]> {
  const { getDb } = await import("../../src/lib/db");
  const rows = getDb()
    .prepare(
      `SELECT id, query, symbol, authoritative_as_of, expected_evidence_ids,
              category, expected_sources, expected_sections, notes
       FROM rag_production_eval_cases WHERE enabled = 1 ORDER BY id`
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((row) => parseGoldenCase({
    id: row.id,
    query: row.query,
    symbol: row.symbol,
    authoritativeAsOf: row.authoritative_as_of,
    expectedEvidenceIds: parseJsonArray(row.expected_evidence_ids, "expected_evidence_ids"),
    category: row.category,
    expectedSources: parseOptionalJsonArray(row.expected_sources, "expected_sources"),
    expectedSections: parseOptionalJsonArray(row.expected_sections, "expected_sections"),
    notes: row.notes
  }, `DB case ${String(row.id)}`));
}

export async function runProductionRagEvaluation(
  cases: ProductionRagGoldenCase[],
  options: ProductionRagEvalOptions = {}
): Promise<ProductionRagEvalReport> {
  const limit = positiveInteger(options.limit, 20);
  const userId = options.userId ?? "local";
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
      { asOf: evalCase.authoritativeAsOf }
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

  return {
    schemaVersion: 1,
    generatedAt: new Date(now()).toISOString(),
    configuration: options.configuration ?? defaultEvaluationModelConfiguration(),
    limit,
    userId,
    caseCount: results.length,
    statusCounts,
    metrics: {
      recallAtK: average(results.map((result) => result.recallAtK)),
      mrr: average(results.map((result) => result.reciprocalRank)),
      ndcgAtK: average(results.map((result) => result.ndcgAtK)),
      pitFutureEvidenceCount: retrieved.reduce((sum, item) => sum + item.future, 0),
      pitFutureEvidenceRate: ratio(retrieved.reduce((sum, item) => sum + item.future, 0), returnedCount),
      undatedEvidenceCount: retrieved.reduce((sum, item) => sum + item.undated, 0),
      undatedEvidenceRate: ratio(retrieved.reduce((sum, item) => sum + item.undated, 0), returnedCount),
      duplicateRate: average(results.map((result) => result.duplicateRate)),
      latencyMs: { p50: percentile(latency, 0.5), p95: percentile(latency, 0.95), p99: percentile(latency, 0.99), mean: average(latency) }
    },
    ...(options.usageReceipt ? { usageReceipt: await options.usageReceipt(startedAt, userId) } : {}),
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
  const expected = new Set(evalCase.expectedEvidenceIds);
  const ids = chunks.map((chunk) => chunk.id);
  const relevantRanks = ids.flatMap((id, index) => expected.has(id) ? [index + 1] : []);
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
  const relevantAtK = relevantRanks.filter((rank) => rank <= limit).length;
  const idealRelevant = Math.min(expected.size, limit);
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
    expectedEvidenceIds: [...expected],
    returnedEvidenceIds: ids,
    relevantRanks,
    recallAtK: ratio(relevantAtK, expected.size),
    reciprocalRank: firstRank ? 1 / firstRank : 0,
    ndcgAtK: idealDcg === 0 ? 0 : dcg / idealDcg,
    pitFutureEvidenceIds: future,
    undatedEvidenceIds: undated,
    duplicateRate: duplicateRate(duplicateKeys),
    sources: [...sourceSet].sort(),
    sections: [...sectionSet].sort(),
    ...(evalCase.expectedSources ? { expectedSourceCoverage: coverage(sourceSet, evalCase.expectedSources) } : {}),
    ...(evalCase.expectedSections ? { expectedSectionCoverage: coverage(sectionSet, evalCase.expectedSections) } : {})
  };
}

export async function readRagUsageReceipt(startedAt: string, userId: string): Promise<RagUsageReceipt | undefined> {
  try {
    const { getDb } = await import("../../src/lib/db");
    const rows = getDb().prepare(
      `SELECT operation, provider, model, COUNT(*) AS calls,
              COALESCE(SUM(tokens_in), 0) AS tokens_in,
              COALESCE(SUM(tokens_out), 0) AS tokens_out,
              COALESCE(SUM(batch_count), 0) AS batch_count,
              SUM(cost_est_usd) AS cost_est_usd
       FROM rag_usage WHERE user_id = ? AND created_at >= ?
       GROUP BY operation, provider, model ORDER BY operation, provider, model`
    ).all(userId, startedAt) as Array<Record<string, unknown>>;
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
    authoritativeAsOf: requiredString("authoritativeAsOf"), expectedEvidenceIds: asStringArray("expectedEvidenceIds")!,
    ...(typeof row.category === "string" && row.category.trim() ? { category: row.category.trim() } : {}),
    ...(asStringArray("expectedSources", true) ? { expectedSources: asStringArray("expectedSources", true) } : {}),
    ...(asStringArray("expectedSections", true) ? { expectedSections: asStringArray("expectedSections", true) } : {}),
    ...(typeof row.notes === "string" && row.notes.trim() ? { notes: row.notes.trim() } : {})
  };
  assertAuthoritativeAsOf(golden.authoritativeAsOf, golden.id);
  return golden;
}

function parseJsonArray(value: unknown, field: string): string[] {
  if (typeof value !== "string") throw new Error(`${field} must be JSON text.`);
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string" || !item.trim())) throw new Error(`${field} must be a JSON string array.`);
  return parsed;
}

function parseOptionalJsonArray(value: unknown, field: string): string[] | undefined {
  return value == null ? undefined : parseJsonArray(value, field);
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

function positiveInteger(value: number | undefined, fallback: number): number {
  const parsed = Math.floor(value ?? fallback);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

interface CliArgs {
  source: "db" | "file";
  input?: string;
  output?: string;
  allowLive: boolean;
  limit: number;
  userId: string;
  configuration: EvaluationModelConfiguration;
}

function parseArgs(argv: string[]): CliArgs {
  const configuration = defaultEvaluationModelConfiguration();
  const args: CliArgs = { source: "db", allowLive: false, limit: 20, userId: "local", configuration };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]; const next = argv[i + 1];
    if (arg === "--source" && (next === "db" || next === "file")) args.source = next, i++;
    else if (arg === "--input" && next) args.input = next, i++;
    else if (arg === "--output" && next) args.output = next, i++;
    else if (arg === "--limit" && next) args.limit = positiveInteger(Number(next), args.limit), i++;
    else if (arg === "--user" && next) args.userId = next, i++;
    else if (arg === "--profile" && next) args.configuration.label = next, i++;
    else if (arg === "--embedding-provider" && next) args.configuration.embeddingProvider = next, i++;
    else if (arg === "--embedding-model" && next) args.configuration.embeddingModel = next, i++;
    else if (arg === "--rerank-provider" && next) args.configuration.rerankProvider = next, i++;
    else if (arg === "--rerank-model" && next) args.configuration.rerankModel = next, i++;
    else if (arg === "--allow-live") args.allowLive = true;
    else if (arg === "--help" || arg === "-h") { printHelp(); process.exit(0); }
    else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  if (args.source === "file" && !args.input) throw new Error("--source file requires --input <cases.json>.");
  return args;
}

function printHelp(): void {
  console.log(`Usage: npm run eval:rag-production -- --allow-live [options]

Read-only against corpus: calls the production retrieveContextDetailed path only. The normal
retrieval path may emit its usual usage/audit receipts. No embeddings or vectors are written.

  --source db|file           Golden case source (default db)
  --input cases.json         Frozen JSON cases when --source file
  --output result.json       Write machine-readable JSON (stdout always prints JSON)
  --limit N                  Retrieval limit (default 20)
  --user ID                  Retrieval user id (default local)
  --profile LABEL            Comparison label recorded in output
  --embedding-provider NAME  Recorded configuration only; does not change runtime env
  --embedding-model NAME     Recorded configuration only; does not change runtime env
  --rerank-provider NAME     Recorded configuration only; does not change runtime env
  --rerank-model NAME        Recorded configuration only; does not change runtime env
  --allow-live               Required: permits live read calls to configured RAG providers
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.allowLive) throw new Error("Refusing live RAG retrieval without --allow-live.");
  const cases = args.source === "db"
    ? await loadDbProductionRagGoldenSet()
    : loadFrozenProductionRagGoldenSet(resolve(args.input!));
  const report = await runProductionRagEvaluation(cases, {
    limit: args.limit, userId: args.userId, configuration: args.configuration, usageReceipt: readRagUsageReceipt
  });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (args.output) {
    const output = resolve(args.output);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, json, "utf8");
  }
  process.stdout.write(json);
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
