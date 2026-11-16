import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { Pinecone } from "@pinecone-database/pinecone";

/**
 * Read-only, opt-in comparison probes for Turso/libSQL vector search and an
 * already-created Pinecone Assistant.  This is deliberately an evaluation
 * tool, not a production retrieval dependency: it never creates, uploads,
 * updates, deletes, or enumerates provider resources.
 */

const MAX_ASSISTANT_QUERIES = 100;
const DEFAULT_ASSISTANT_QUERIES = 25;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 15_000;

export interface ShadowCase {
  /** Stable, non-prompt identifier from a frozen evaluation set. */
  id: string;
  /** Kept in memory only; never included in a receipt. */
  query: string;
}

export interface AssistantUsageReceipt {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface AssistantContextResponse {
  snippets?: unknown[];
  usage?: AssistantUsageReceipt;
}

export interface ReadOnlyAssistantClient {
  context(
    options: { query: string; topK: number; snippetSize: number; multimodal: false },
    signal: AbortSignal
  ): Promise<AssistantContextResponse>;
}

export interface AssistantShadowReceipt {
  target: "pinecone-assistant";
  status: "skipped" | "completed";
  reason?: "live_gate_off" | "assistant_name_missing" | "api_key_missing" | "no_cases";
  assistantName?: string;
  requestedCaseCount: number;
  executedCaseCount: number;
  hardQueryCap: number;
  timeoutMs: number;
  cases: Array<{
    id: string;
    status: "ok" | "error" | "timeout";
    latencyMs: number;
    citationCount?: number;
    /** Hashed provider file identities only; no snippet text, file name, or prompt. */
    citationFingerprints?: string[];
    usage?: AssistantUsageReceipt;
    error?: "assistant_request_failed" | "timeout";
  }>;
}

export interface RunAssistantShadowOptions {
  cases: readonly ShadowCase[];
  liveEnabled: boolean;
  assistantName?: string;
  apiKey?: string;
  maxQueries?: number;
  timeoutMs?: number;
  client?: ReadOnlyAssistantClient;
  now?: () => number;
}

function boundedInteger(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(Math.floor(value as number), max));
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function citationFingerprints(snippets: unknown[] | undefined): string[] {
  if (!Array.isArray(snippets)) return [];
  const values = new Set<string>();
  for (const snippet of snippets) {
    if (!snippet || typeof snippet !== "object") continue;
    const reference = (snippet as { reference?: unknown }).reference;
    if (!reference || typeof reference !== "object") continue;
    const file = (reference as { file?: unknown }).file;
    if (!file || typeof file !== "object") continue;
    const candidate = (file as { id?: unknown }).id;
    if (typeof candidate === "string" && candidate.length > 0) values.add(fingerprint(candidate));
  }
  return [...values].sort();
}

function requestErrorKind(error: unknown): "timeout" | "assistant_request_failed" {
  return error instanceof Error && error.name === "TimeoutError" ? "timeout" : "assistant_request_failed";
}

async function withTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const controller = new AbortController();
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      const error = new Error("Pinecone Assistant context request exceeded configured timeout");
      error.name = "TimeoutError";
      controller.abort(error);
      reject(error);
    }, timeoutMs);
    timeout.unref?.();
  });
  try {
    return await Promise.race([operation(controller.signal), deadline]);
  } catch (error) {
    if (timedOut) {
      const timeoutError = new Error("Pinecone Assistant context request exceeded configured timeout");
      timeoutError.name = "TimeoutError";
      throw timeoutError;
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/** Only the Assistant `context` data-plane read is exposed to the benchmark. */
export function createReadOnlyAssistantClient(apiKey: string, assistantName: string): ReadOnlyAssistantClient {
  // The SDK's Assistant.context surface does not expose AbortSignal directly. Supply a scoped
  // fetch implementation so the benchmark timeout cancels the underlying paid HTTP request.
  let activeSignal: AbortSignal | undefined;
  const pinecone = new Pinecone({
    apiKey,
    fetchApi: (input, init) => fetch(input, { ...init, signal: activeSignal ?? init?.signal })
  });
  const assistant = pinecone.assistant({ name: assistantName });
  return {
    context: async ({ query, topK, snippetSize, multimodal }, signal) => {
      activeSignal = signal;
      try {
        return await assistant.context({ query, topK, snippetSize, multimodal });
      } finally {
        activeSignal = undefined;
      }
    }
  };
}

/**
 * Run bounded serial context retrieval against an assistant that already
 * exists.  It intentionally does not call any file, control-plane, index, or
 * chat-generation method.  Receipts retain only stable case IDs and hashed
 * citation identities, never prompts, snippets, answers, or file names.
 */
export async function runPineconeAssistantShadow(options: RunAssistantShadowOptions): Promise<AssistantShadowReceipt> {
  const maxQueries = boundedInteger(options.maxQueries, DEFAULT_ASSISTANT_QUERIES, MAX_ASSISTANT_QUERIES);
  const timeoutMs = boundedInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const cases = options.cases.filter((item) => item.id.trim().length > 0 && item.query.trim().length > 0).slice(0, maxQueries);
  const base = {
    target: "pinecone-assistant" as const,
    requestedCaseCount: options.cases.length,
    executedCaseCount: 0,
    hardQueryCap: MAX_ASSISTANT_QUERIES,
    timeoutMs,
    cases: [] as AssistantShadowReceipt["cases"]
  };

  if (!options.liveEnabled) return { ...base, status: "skipped", reason: "live_gate_off" };
  if (!options.assistantName?.trim()) return { ...base, status: "skipped", reason: "assistant_name_missing" };
  if (!options.apiKey?.trim() && !options.client) return { ...base, status: "skipped", reason: "api_key_missing" };
  if (cases.length === 0) return { ...base, status: "skipped", reason: "no_cases", assistantName: options.assistantName };

  const client = options.client ?? createReadOnlyAssistantClient(options.apiKey!, options.assistantName);
  const now = options.now ?? Date.now;
  const receipts: AssistantShadowReceipt["cases"] = [];
  for (const item of cases) {
    const startedAt = now();
    try {
      const response = await withTimeout(
        (signal) => client.context(
          { query: item.query, topK: 16, snippetSize: 512, multimodal: false },
          signal
        ),
        timeoutMs
      );
      const citations = citationFingerprints(response.snippets);
      receipts.push({
        id: item.id,
        status: "ok",
        latencyMs: Math.max(0, now() - startedAt),
        citationCount: citations.length,
        citationFingerprints: citations,
        usage: response.usage
      });
    } catch (error) {
      const kind = requestErrorKind(error);
      receipts.push({
        id: item.id,
        status: kind === "timeout" ? "timeout" : "error",
        latencyMs: Math.max(0, now() - startedAt),
        error: kind
      });
    }
  }

  return {
    ...base,
    status: "completed",
    assistantName: options.assistantName,
    executedCaseCount: receipts.length,
    cases: receipts
  };
}

export interface LocalSqliteProbe {
  get(sql: string): unknown;
  close(): void;
}

export interface TursoVectorCapabilityReceipt {
  target: "turso-libsql-vector";
  status: "available" | "unsupported";
  libsqlClientInstalled: boolean;
  networkProbed: false;
  sqliteVersion?: string;
  vector32Available: boolean;
  vectorDistanceCosAvailable: boolean;
  limitations: string[];
}

function installed(moduleName: string): boolean {
  try {
    createRequire(import.meta.url).resolve(moduleName);
    return true;
  } catch {
    return false;
  }
}

function defaultSqliteProbe(): LocalSqliteProbe {
  const db = new Database(":memory:");
  return {
    get: (sql) => db.prepare(sql).get(),
    close: () => db.close()
  };
}

function successful(probe: LocalSqliteProbe, sql: string): boolean {
  try {
    probe.get(sql);
    return true;
  } catch {
    return false;
  }
}

/**
 * Local capability inspection only.  It never contacts Turso and never adds a
 * libSQL package: a false result says this checkout cannot run a meaningful
 * Turso vector comparison yet, not that a remote Turso database is incapable.
 */
export function probeTursoVectorCapability(openProbe: () => LocalSqliteProbe = defaultSqliteProbe): TursoVectorCapabilityReceipt {
  const probe = openProbe();
  try {
    const sqliteRow = probe.get("SELECT sqlite_version() AS sqliteVersion") as { sqliteVersion?: unknown } | undefined;
    const vector32Available = successful(probe, "SELECT vector32('[1,2]') AS vector");
    const vectorDistanceCosAvailable = successful(probe, "SELECT vector_distance_cos(vector32('[1,2]'), vector32('[1,2]')) AS distance");
    const libsqlClientInstalled = installed("@libsql/client");
    const limitations: string[] = [];
    if (!libsqlClientInstalled) limitations.push("@libsql/client is not installed; no remote Turso query is attempted.");
    if (!vector32Available || !vectorDistanceCosAvailable) limitations.push("Local SQLite lacks Turso/libSQL vector functions (vector32 and vector_distance_cos).");
    limitations.push("This receipt is a local capability probe only; it performs no network or database write.");
    return {
      target: "turso-libsql-vector",
      status: libsqlClientInstalled && vector32Available && vectorDistanceCosAvailable ? "available" : "unsupported",
      libsqlClientInstalled,
      networkProbed: false,
      sqliteVersion: typeof sqliteRow?.sqliteVersion === "string" ? sqliteRow.sqliteVersion : undefined,
      vector32Available,
      vectorDistanceCosAvailable,
      limitations
    };
  } finally {
    probe.close();
  }
}

function liveGateOn(): boolean {
  return ["1", "true", "on", "yes"].includes((process.env.RAG_SHADOW_BENCHMARK_LIVE ?? "").trim().toLowerCase());
}

async function loadCases(path: string | undefined): Promise<ShadowCase[]> {
  if (!path) return [];
  const { readFile } = await import("node:fs/promises");
  const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!Array.isArray(raw)) throw new Error("RAG_SHADOW_CASES_PATH must contain a JSON array of { id, query } objects.");
  return raw.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const value = item as { id?: unknown; query?: unknown };
    return typeof value.id === "string" && typeof value.query === "string" ? [{ id: value.id, query: value.query }] : [];
  });
}

async function main(): Promise<void> {
  const cases = await loadCases(process.env.RAG_SHADOW_CASES_PATH);
  const receipt = {
    generatedAt: new Date().toISOString(),
    turso: probeTursoVectorCapability(),
    pineconeAssistant: await runPineconeAssistantShadow({
      cases,
      liveEnabled: liveGateOn(),
      assistantName: process.env.PINECONE_ASSISTANT_NAME,
      apiKey: process.env.PINECONE_API_KEY,
      maxQueries: Number(process.env.RAG_SHADOW_MAX_QUERIES ?? DEFAULT_ASSISTANT_QUERIES),
      timeoutMs: Number(process.env.RAG_SHADOW_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS)
    })
  };
  // This output is intentionally receipts-only: no query, snippet, answer, file name, or API key.
  console.log(JSON.stringify(receipt, null, 2));
}

const invokedDirectly = (() => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Shadow benchmark failed.");
    process.exitCode = 1;
  });
}
