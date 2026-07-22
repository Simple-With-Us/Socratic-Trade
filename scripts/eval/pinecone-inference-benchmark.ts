#!/usr/bin/env tsx

/** Bounded read-only Pinecone hosted-inference benchmark. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const BASE = "https://api.pinecone.io";
const API_VERSION = "2026-04";

export interface BenchmarkCase {
  id: string;
  query: string;
  candidates: Array<{ id: string; text: string; relevant: boolean }>;
}
export interface Transport {
  request(path: "/embed" | "/rerank" | "/models", init: { method: "GET" | "POST"; body?: unknown }): Promise<unknown>;
}
export interface CaseResult {
  caseId: string;
  ranking: Array<{ id: string; score: number }>;
  recallAtK: number;
  reciprocalRank: number;
  ndcgAtK: number;
  latencyMs: number;
  usage: ProviderUsageReceipt;
}
/** Provider-reported units where available; requestCount is always measured locally. */
export interface ProviderUsageReceipt {
  requestCount: number;
  embeddingTokens?: number;
  rerankUnits?: number;
}
export interface ModelResult {
  kind: "dense" | "rerank";
  model: string;
  latencyMs: number;
  metrics: { recallAtK: number; mrr: number; ndcgAtK: number };
  usage: ProviderUsageReceipt;
  cases: CaseResult[];
}
export interface BenchmarkReport {
  schemaVersion: 1;
  generatedAt: string;
  limit: number;
  caseCount: number;
  candidates: ModelResult[];
  inventory?: Array<{ model: string; type?: string; providerName?: string }>;
}
export interface BenchmarkOptions {
  transport: Transport;
  embedModels?: string[];
  rerankModels?: string[];
  limit?: number;
  includeInventory?: boolean;
  now?: () => number;
}

/** Reads frozen cases; caller controls the live gate separately. */
export function loadPineconeBenchmarkCases(path: string): BenchmarkCase[] {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const rows = Array.isArray(parsed) ? parsed : (parsed as { cases?: unknown })?.cases;
  if (!Array.isArray(rows)) throw new Error("Expected a JSON array or { cases: [...] }.");
  return rows.map((row, index) => parseCase(row, `file row ${index + 1}`));
}

/** All output is ids/scores/metrics only; candidate text is never retained in the report. */
export async function runPineconeInferenceBenchmark(cases: BenchmarkCase[], options: BenchmarkOptions): Promise<BenchmarkReport> {
  if (cases.length === 0) throw new Error("Pinecone inference benchmark refuses an empty golden set.");
  const limit = positiveInteger(options.limit, 10);
  const now = options.now ?? Date.now;
  const candidates: ModelResult[] = [];
  for (const model of uniqueModels(options.embedModels ?? ["llama-text-embed-v2"])) candidates.push(await benchmarkDense(model, cases, limit, options.transport, now));
  for (const model of uniqueModels(options.rerankModels ?? ["bge-reranker-v2-m3"])) candidates.push(await benchmarkRerank(model, cases, limit, options.transport, now));
  const inventory = options.includeInventory ? await listModels(options.transport) : undefined;
  return { schemaVersion: 1, generatedAt: new Date(now()).toISOString(), limit, caseCount: cases.length, candidates, ...(inventory ? { inventory } : {}) };
}

export async function benchmarkDense(model: string, cases: BenchmarkCase[], limit: number, transport: Transport, now: () => number = Date.now): Promise<ModelResult> {
  const started = now(); const results: CaseResult[] = [];
  for (const testCase of cases) {
    const caseStarted = now();
    const passages = await embed(model, testCase.candidates.map((candidate) => candidate.text), "passage", transport);
    const query = await embed(model, [testCase.query], "query", transport);
    if (!query.vectors[0] || passages.vectors.length !== testCase.candidates.length) throw new Error(`Dense model ${model}: malformed embedding response for ${testCase.id}.`);
    const ranking = testCase.candidates.map((candidate, index) => ({ id: candidate.id, score: cosine(query.vectors[0]!, passages.vectors[index]!) }))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    results.push(scoreRanking(testCase, ranking, limit, Math.max(0, now() - caseStarted), sumUsage([passages.usage, query.usage])));
  }
  return summarize("dense", model, results, Math.max(0, now() - started));
}

export async function benchmarkRerank(model: string, cases: BenchmarkCase[], limit: number, transport: Transport, now: () => number = Date.now): Promise<ModelResult> {
  const started = now(); const results: CaseResult[] = [];
  for (const testCase of cases) {
    const caseStarted = now();
    const payload = await transport.request("/rerank", {
      method: "POST",
      body: {
        model, query: testCase.query,
        documents: testCase.candidates.map((candidate) => ({ id: candidate.id, text: candidate.text })),
        top_n: testCase.candidates.length,
        // Ensure the response never carries document text into the report.
        return_documents: false
      }
    });
    results.push(scoreRanking(testCase, parseRerank(payload, testCase, model), limit, Math.max(0, now() - caseStarted), usageReceipt(payload, 1)));
  }
  return summarize("rerank", model, results, Math.max(0, now() - started));
}

export async function listModels(transport: Transport): Promise<Array<{ model: string; type?: string; providerName?: string }>> {
  const payload = await transport.request("/models", { method: "GET" });
  const models = (payload as { models?: unknown })?.models;
  if (!Array.isArray(models)) throw new Error("Pinecone /models response did not contain models.");
  return models.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    if (typeof row.model !== "string" || !row.model) return [];
    return [{ model: row.model, ...(typeof row.type === "string" ? { type: row.type } : {}), ...(typeof row.provider_name === "string" ? { providerName: row.provider_name } : {}) }];
  });
}

/** The only network-capable transport; no key, request body, or provider error body is printed. */
export async function createLivePineconeInferenceTransport(allowLive: boolean): Promise<Transport> {
  if (!allowLive) throw new Error("Refusing Pinecone network calls without --allow-live.");
  const { resolveApiKey } = await import("../../src/lib/db");
  const apiKey = resolveApiKey("pinecone", "local") ?? process.env.PINECONE_API_KEY;
  if (!apiKey) throw new Error("Pinecone API key is not configured.");
  return {
    async request(path, init) {
      const response = await fetch(`${BASE}${path}`, {
        method: init.method,
        headers: { "Api-Key": apiKey, "Content-Type": "application/json", "X-Pinecone-Api-Version": API_VERSION },
        ...(init.body == null ? {} : { body: JSON.stringify(init.body) }),
        signal: AbortSignal.timeout(30_000)
      });
      if (!response.ok) throw new Error(`Pinecone inference ${path} failed with HTTP ${response.status}.`);
      return response.json();
    }
  };
}

function parseCase(value: unknown, label: string): BenchmarkCase {
  if (!value || typeof value !== "object") throw new Error(`${label}: expected object.`);
  const row = value as Record<string, unknown>;
  const string = (key: string) => {
    const raw = row[key];
    if (typeof raw !== "string" || !raw.trim()) throw new Error(`${label}: ${key} must be non-empty.`);
    return raw.trim();
  };
  if (!Array.isArray(row.candidates) || row.candidates.length === 0) throw new Error(`${label}: candidates must be non-empty.`);
  const ids = new Set<string>();
  const candidates = row.candidates.map((item, index) => {
    if (!item || typeof item !== "object") throw new Error(`${label}: candidate ${index + 1} must be an object.`);
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.id !== "string" || !candidate.id.trim()) throw new Error(`${label}: candidate id must be non-empty.`);
    if (ids.has(candidate.id)) throw new Error(`${label}: duplicate candidate id ${candidate.id}.`);
    ids.add(candidate.id);
    if (typeof candidate.text !== "string" || !candidate.text.trim()) throw new Error(`${label}: candidate ${candidate.id} text must be non-empty.`);
    if (typeof candidate.relevant !== "boolean") throw new Error(`${label}: candidate ${candidate.id} relevant must be boolean.`);
    return { id: candidate.id, text: candidate.text, relevant: candidate.relevant };
  });
  if (!candidates.some((candidate) => candidate.relevant)) throw new Error(`${label}: requires at least one relevant candidate.`);
  return { id: string("id"), query: string("query"), candidates };
}

async function embed(model: string, texts: string[], inputType: "query" | "passage", transport: Transport): Promise<{ vectors: number[][]; usage: ProviderUsageReceipt }> {
  const payload = await transport.request("/embed", { method: "POST", body: { model, parameters: { input_type: inputType, truncate: "END" }, inputs: texts.map((text) => ({ text })) } });
  const data = (payload as { data?: unknown })?.data;
  if (!Array.isArray(data)) throw new Error(`Pinecone /embed response for ${model} did not contain data.`);
  const vectors = data.map((item, index) => {
    const values = (item as { values?: unknown })?.values;
    if (!Array.isArray(values) || values.length === 0 || values.some((value) => typeof value !== "number" || !Number.isFinite(value))) throw new Error(`Pinecone /embed response for ${model} has invalid vector ${index}.`);
    return values;
  });
  return { vectors, usage: usageReceipt(payload, 1) };
}

function parseRerank(payload: unknown, testCase: BenchmarkCase, model: string): Array<{ id: string; score: number }> {
  const data = (payload as { data?: unknown })?.data;
  if (!Array.isArray(data)) throw new Error(`Pinecone /rerank response for ${model} did not contain data.`);
  const seen = new Set<string>();
  return data.map((item, outputIndex) => {
    const row = item as { index?: unknown; score?: unknown; document?: { id?: unknown } };
    const indexed = typeof row.index === "number" && Number.isInteger(row.index) ? testCase.candidates[row.index] : undefined;
    const id = typeof row.document?.id === "string" ? row.document.id : indexed?.id;
    if (!id || !testCase.candidates.some((candidate) => candidate.id === id)) throw new Error(`Pinecone /rerank response for ${model} has unknown result ${outputIndex}.`);
    if (seen.has(id)) throw new Error(`Pinecone /rerank response for ${model} returned duplicate id ${id}.`);
    seen.add(id);
    if (typeof row.score !== "number" || !Number.isFinite(row.score)) throw new Error(`Pinecone /rerank response for ${model} has invalid score for ${id}.`);
    return { id, score: row.score };
  });
}

function scoreRanking(testCase: BenchmarkCase, ranking: Array<{ id: string; score: number }>, limit: number, latencyMs: number, usage: ProviderUsageReceipt): CaseResult {
  const relevant = new Set(testCase.candidates.filter((candidate) => candidate.relevant).map((candidate) => candidate.id));
  const atK = ranking.slice(0, limit);
  const ranks = ranking.flatMap((item, index) => relevant.has(item.id) ? [index + 1] : []);
  const dcg = atK.reduce((sum, item, index) => sum + (relevant.has(item.id) ? 1 / Math.log2(index + 2) : 0), 0);
  const ideal = Array.from({ length: Math.min(relevant.size, limit) }, (_, index) => 1 / Math.log2(index + 2)).reduce((sum, value) => sum + value, 0);
  return { caseId: testCase.id, ranking: atK, recallAtK: atK.filter((item) => relevant.has(item.id)).length / relevant.size, reciprocalRank: ranks[0] ? 1 / ranks[0] : 0, ndcgAtK: ideal === 0 ? 0 : dcg / ideal, latencyMs, usage };
}
function summarize(kind: "dense" | "rerank", model: string, cases: CaseResult[], latencyMs: number): ModelResult {
  return { kind, model, latencyMs, metrics: { recallAtK: average(cases.map((item) => item.recallAtK)), mrr: average(cases.map((item) => item.reciprocalRank)), ndcgAtK: average(cases.map((item) => item.ndcgAtK)) }, usage: sumUsage(cases.map((item) => item.usage)), cases };
}
function usageReceipt(payload: unknown, requestCount: number): ProviderUsageReceipt {
  const usage = (payload as { usage?: unknown })?.usage;
  const row = usage && typeof usage === "object" ? usage as Record<string, unknown> : {};
  const embeddingTokens = nonNegativeNumber(row.total_tokens);
  const rerankUnits = nonNegativeNumber(row.rerank_units);
  return { requestCount, ...(embeddingTokens == null ? {} : { embeddingTokens }), ...(rerankUnits == null ? {} : { rerankUnits }) };
}
function sumUsage(receipts: ProviderUsageReceipt[]): ProviderUsageReceipt {
  const embeddingTokens = receipts.flatMap((receipt) => receipt.embeddingTokens == null ? [] : [receipt.embeddingTokens]);
  const rerankUnits = receipts.flatMap((receipt) => receipt.rerankUnits == null ? [] : [receipt.rerankUnits]);
  return {
    requestCount: receipts.reduce((sum, receipt) => sum + receipt.requestCount, 0),
    ...(embeddingTokens.length ? { embeddingTokens: embeddingTokens.reduce((sum, value) => sum + value, 0) } : {}),
    ...(rerankUnits.length ? { rerankUnits: rerankUnits.reduce((sum, value) => sum + value, 0) } : {})
  };
}
function nonNegativeNumber(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined; }
function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error("Embedding dimensions differ.");
  let dot = 0; let aNorm = 0; let bNorm = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; aNorm += a[i]! ** 2; bNorm += b[i]! ** 2; }
  return aNorm === 0 || bNorm === 0 ? 0 : dot / Math.sqrt(aNorm * bNorm);
}
function average(values: number[]): number { return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length; }
function positiveInteger(value: number | undefined, fallback: number): number { const parsed = Math.floor(value ?? fallback); return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback; }
function uniqueModels(models: string[]): string[] { return [...new Set(models.map((model) => model.trim()).filter(Boolean))]; }

const MAX_LIMIT = 100;
const MAX_CASES = 100;
const MAX_CANDIDATES = 100;
const MAX_MODELS_PER_KIND = 10;
interface CliArgs { input?: string; output?: string; allowLive: boolean; inventory: boolean; limit: number; maxCases: number; maxCandidates: number; embedModels: string[]; rerankModels: string[]; }
export function parsePineconeInferenceBenchmarkArgs(argv: string[]): CliArgs {
  const args: CliArgs = { allowLive: false, inventory: false, limit: 10, maxCases: 25, maxCandidates: 50, embedModels: [], rerankModels: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]; const next = argv[i + 1];
    if (arg === "--input" && next) { args.input = next; i++; }
    else if (arg === "--output" && next) { args.output = next; i++; }
    else if (arg === "--limit" && next) { args.limit = boundedCliInteger(next, "--limit", MAX_LIMIT); i++; }
    else if (arg === "--max-cases" && next) { args.maxCases = boundedCliInteger(next, "--max-cases", MAX_CASES); i++; }
    else if (arg === "--max-candidates" && next) { args.maxCandidates = boundedCliInteger(next, "--max-candidates", MAX_CANDIDATES); i++; }
    else if (arg === "--embed-model" && next) { args.embedModels.push(next); i++; }
    else if (arg === "--rerank-model" && next) { args.rerankModels.push(next); i++; }
    else if (arg === "--inventory") args.inventory = true;
    else if (arg === "--allow-live") args.allowLive = true;
    else if (arg === "--help" || arg === "-h") { printHelp(); process.exit(0); }
    else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  if (!args.input) throw new Error("--input <frozen-cases.json> is required.");
  args.embedModels = uniqueModels(args.embedModels);
  args.rerankModels = uniqueModels(args.rerankModels);
  if (args.embedModels.length > MAX_MODELS_PER_KIND || args.rerankModels.length > MAX_MODELS_PER_KIND) throw new Error(`At most ${MAX_MODELS_PER_KIND} distinct models are allowed per inference kind.`);
  return args;
}
function boundedCliInteger(value: string, flag: string, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer.`);
  if (parsed > maximum) throw new Error(`${flag} cannot exceed ${maximum}.`);
  return parsed;
}
function printHelp(): void {
  console.log(`Usage: npm run eval:pinecone-inference -- --allow-live --input cases.json [options]
Read-only hosted inference: no index, namespace, or corpus operation; output has ids/scores/metrics only.
  --embed-model MODEL   repeatable, default llama-text-embed-v2
  --rerank-model MODEL  repeatable, default bge-reranker-v2-m3; arbitrary model names accepted
  --limit N --max-cases N --max-candidates N --inventory --output result.json
  hard caps: limit/cases/candidates <= 100; distinct models per kind <= 10
  --allow-live           required for every network call`);
}
async function main(): Promise<void> {
  const args = parsePineconeInferenceBenchmarkArgs(process.argv.slice(2));
  const transport = await createLivePineconeInferenceTransport(args.allowLive);
  const cases = loadPineconeBenchmarkCases(resolve(args.input!)).slice(0, args.maxCases).map((item) => ({ ...item, candidates: item.candidates.slice(0, args.maxCandidates) }));
  if (cases.some((item) => !item.candidates.some((candidate) => candidate.relevant))) throw new Error("max-candidates removed all relevant candidates; reduce the bound or reorder the frozen case.");
  const report = await runPineconeInferenceBenchmark(cases, { transport, limit: args.limit, includeInventory: args.inventory, ...(args.embedModels.length ? { embedModels: args.embedModels } : {}), ...(args.rerankModels.length ? { rerankModels: args.rerankModels } : {}) });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (args.output) { const output = resolve(args.output); mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, json, "utf8"); }
  process.stdout.write(json);
}
const direct = (() => { try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href; } catch { return false; } })();
if (direct) main().catch((error) => { console.error("Pinecone inference benchmark failed:", error instanceof Error ? error.message : String(error)); process.exit(2); });
