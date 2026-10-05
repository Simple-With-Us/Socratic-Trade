/**
 * Run a read-only better-sqlite3 `.all()` off the serving-process event loop.
 *
 * better-sqlite3 statements are synchronous on the calling thread.  A corpus-wide FTS MATCH
 * with occurrence joins therefore pins GET /api/live and GET /api/health for the whole
 * statement.  This helper keeps SQL construction and row mapping on the caller, and only
 * moves the blocking `.all()` onto a persistent worker thread with its own readonly
 * connection.  WAL readers can proceed without sharing the serving `getDb()` handle.
 */
import "server-only";
import type { Worker } from "node:worker_threads";
import { z } from "zod";
import { RAG_QUERY_IO_DEADLINE_MS } from "../rag-retrieval-deadline";
import { SQLITE_BUSY_PIN_MS } from "../sqlite-event-loop";

// WEBPACK TRAP: reachable from instrumentation.ts via vector-db.ts — no static "node:" imports.
// SQLITE_BUSY_PIN_MS is safe to import: sqlite-event-loop.ts only reaches market-hours.ts and
// slow-sync-guard.ts, neither of which has a static node: import. db.ts is not imported here.

/**
 * The worker handles one message at a time on its own thread. A 60s busy_timeout would park
 * every queued lexical query behind one SQLITE_BUSY. The serving connection uses
 * SQLITE_BUSY_PIN_MS so the busy error surfaces quickly; corpusWideLexicalFailed then degrades
 * to dense recall. Same pin here.
 */
const WORKER_BUSY_TIMEOUT_MS = SQLITE_BUSY_PIN_MS;

/** Serving handle in src/lib/db.ts: `cache_size = -20000` (~20MB page cache). */
const WORKER_CACHE_SIZE = -20_000;

/** Serving handle in src/lib/db.ts: `mmap_size = 268435456` (256MB). */
const WORKER_MMAP_SIZE = 268_435_456;

/**
 * Per-request ceiling for one off-loop read. Same budget as RAG_QUERY_IO_DEADLINE_MS
 * (rag-retrieval-deadline.ts). That module does not statically import node: builtins
 * (only inflight-deadline.ts), so it is safe on the instrumentation webpack graph.
 * A wedged statement blocks the worker thread; on this deadline the instance is
 * terminated and the next call opens a fresh one.
 */
export const SQLITE_OFF_LOOP_TIMEOUT_MS = RAG_QUERY_IO_DEADLINE_MS;

export type SqliteAllOffLoopOptions = {
  /** Drop this waiter when the signal aborts. Does not by itself terminate the worker. */
  signal?: AbortSignal;
  /** Override SQLITE_OFF_LOOP_TIMEOUT_MS. Production callers omit this. */
  timeoutMs?: number;
};

const SqliteWorkerErrorSchema = z.strictObject({
  message: z.string(),
  code: z.string().optional()
});

/**
 * One column value as the parent observes it.
 *
 * better-sqlite3 materializes NULL, TEXT, INTEGER/REAL, and BLOB. INTEGER is a JS number,
 * or a bigint when safeIntegers is enabled (this worker does not enable it). REAL is a JS
 * number and can be ±Infinity; Zod 4's `z.number()` is finite-only, so non-finite numbers
 * are listed beside it. NaN does not survive better-sqlite3's bind path (it comes back
 * NULL) but is accepted so a non-finite REAL is not mistaken for a corrupt envelope.
 * Column reads never produce booleans — SQLite has no boolean storage class and the
 * binding layer rejects them — but a boolean is still a scalar SQLite-shaped value, not
 * an object/array, so it stays in the transport union. The caller's row schema is the
 * domain check.
 *
 * BLOB is a Node Buffer inside the worker (`Napi::Buffer` in better-sqlite3). Buffer is a
 * Uint8Array subclass. `postMessage` structured-clone does not preserve the Buffer
 * subclass: the parent receives a plain Uint8Array. `z.instanceof(Uint8Array)` accepts
 * both, including a same-realm Buffer delivered in tests.
 */
const SqliteNumberSchema = z.union([z.number(), z.literal(Infinity), z.literal(-Infinity), z.nan()]);

export const SqliteValueSchema = z.union([
  z.string(),
  SqliteNumberSchema,
  z.bigint(),
  z.boolean(),
  z.null(),
  z.instanceof(Uint8Array)
]);

export type SqliteValue = z.infer<typeof SqliteValueSchema>;

/** One row object: column name to SQLite value. Not `z.array(z.unknown())`. */
export const SqliteRowSchema = z.record(z.string(), SqliteValueSchema);

export type SqliteRow = z.infer<typeof SqliteRowSchema>;

/**
 * Parent-side view of one worker reply.  Strict so a widened payload cannot be treated as
 * rows or as a sqlite error.  `id: -1` is the worker's sentinel for a request that had no
 * safe integer id; it is not a waiter and must not settle anyone else.
 * Row values are checked here; the caller's `rowSchema` remains the domain check.
 */
export const SqliteWorkerResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    id: z.int(),
    ok: z.literal(true),
    rows: z.array(SqliteRowSchema)
  }),
  z.strictObject({
    id: z.int(),
    ok: z.literal(false),
    error: SqliteWorkerErrorSchema
  })
]);

export type SqliteWorkerResponse = z.infer<typeof SqliteWorkerResponseSchema>;

const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const Database = require(workerData.betterSqlitePath);
// zod's CJS entry (package exports require -> index.cjs) is resolved in the parent
// the same way as better-sqlite3 and passed in workerData. require() works in this
// eval worker; a throw here means the entry could not be loaded.
const { z } = require(workerData.zodPath);
const RequestSchema = z.strictObject({
  id: z.int(),
  dbPath: z.string().min(1),
  sql: z.string().min(1),
  params: z.array(z.unknown())
});

let db = null;
let openPath = null;

function openDb(dbPath) {
  if (db && openPath === dbPath) return db;
  if (db) {
    try { db.close(); } catch {}
    db = null;
    openPath = null;
  }
  const next = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    next.pragma("query_only = ON");
    next.pragma("busy_timeout = ${WORKER_BUSY_TIMEOUT_MS}");
    next.pragma("cache_size = ${WORKER_CACHE_SIZE}");
    next.pragma("mmap_size = ${WORKER_MMAP_SIZE}");
  } catch (err) {
    try { next.close(); } catch {}
    throw err;
  }
  db = next;
  openPath = dbPath;
  return db;
}

function safeRequestId(msg) {
  if (msg && typeof msg === "object" && Number.isSafeInteger(msg.id)) return msg.id;
  return -1;
}

function invalidRequest(msg) {
  parentPort.postMessage({
    id: safeRequestId(msg),
    ok: false,
    error: { message: "invalid sqlite worker request", code: "INVALID_REQUEST" }
  });
}

parentPort.on("message", (msg) => {
  let request = null;
  try {
    const parsed = RequestSchema.safeParse(msg);
    request = parsed.success ? parsed.data : null;
  } catch {
    request = null;
  }
  if (!request) {
    invalidRequest(msg);
    return;
  }
  try {
    const rows = openDb(request.dbPath).prepare(request.sql).all(...request.params);
    parentPort.postMessage({ id: request.id, ok: true, rows });
  } catch (err) {
    const error = {
      message: err && err.message ? String(err.message) : String(err)
    };
    if (err && err.code != null) error.code = String(err.code);
    parentPort.postMessage({
      id: request.id,
      ok: false,
      error
    });
  }
});
`;

type Pending = {
  resolve: (rows: unknown[]) => void;
  reject: (err: Error) => void;
  instance: Worker;
  timer?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
};

let worker: Worker | null = null;
let workerReady: Promise<Worker> | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

async function resolvePackageEntry(specifier: string): Promise<string> {
  try {
    const { createRequire } = await import(/* webpackIgnore: true */ "node:module");
    const nodeRequire = createRequire(import.meta.url);
    return nodeRequire.resolve(specifier);
  } catch {
    return specifier;
  }
}

function sqliteOffLoopError(message: string, code?: string): Error {
  const error = new Error(message);
  if (typeof code === "string") {
    Object.defineProperty(error, "code", {
      value: code,
      enumerable: true,
      configurable: true,
      writable: true
    });
  }
  return error;
}

function numericMessageId(msg: unknown): number | undefined {
  if (typeof msg !== "object" || msg === null || !("id" in msg)) return undefined;
  const id = msg.id;
  if (typeof id !== "number" || !Number.isFinite(id)) return undefined;
  return id;
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  if (typeof signal.reason === "string" && signal.reason.length > 0) return new Error(signal.reason);
  return new Error("sqlite off-loop query aborted");
}

function resolveTimeoutMs(value: number | undefined): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  return SQLITE_OFF_LOOP_TIMEOUT_MS;
}

function dropPending(id: number): Pending | undefined {
  const waiter = pending.get(id);
  if (!waiter) return undefined;
  pending.delete(id);
  if (waiter.timer !== undefined) clearTimeout(waiter.timer);
  if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
  return waiter;
}

/** Reject waiters for `instance`, or every waiter when `instance` is omitted (test reset). */
function rejectAll(err: Error, instance?: Worker): void {
  const ids: number[] = [];
  for (const [id, waiter] of pending) {
    if (instance && waiter.instance !== instance) continue;
    ids.push(id);
  }
  const touched = new Set<Worker>();
  for (const id of ids) {
    const waiter = dropPending(id);
    if (!waiter) continue;
    touched.add(waiter.instance);
    waiter.reject(err);
  }
  if (instance) updateRef(instance);
  else for (const owned of touched) updateRef(owned);
}

function updateRef(instance: Worker): void {
  let count = 0;
  for (const waiter of pending.values()) {
    if (waiter.instance === instance) count += 1;
  }
  try {
    if (count > 0) instance.ref();
    else instance.unref();
  } catch {
    // terminate()/exit already stopped the thread.
  }
}

function detachInstance(instance: Worker): void {
  if (worker === instance) {
    worker = null;
    workerReady = null;
  }
}

function retireInstance(instance: Worker, errorFor: (id: number) => Error): void {
  detachInstance(instance);
  const ids: number[] = [];
  for (const [id, waiter] of pending) {
    if (waiter.instance === instance) ids.push(id);
  }
  for (const id of ids) {
    const waiter = dropPending(id);
    waiter?.reject(errorFor(id));
  }
  updateRef(instance);
  // The statement is synchronous on this thread, so a timeout means every request
  // queued behind it is stuck too. Kill the instance; the next call spawns another.
  void instance.terminate().catch(() => undefined);
}

function onRequestTimeout(instance: Worker, id: number): void {
  const waiter = pending.get(id);
  if (!waiter || waiter.instance !== instance) return;
  const timeoutError = new Error("sqlite off-loop query timed out");
  const collateral = new Error("sqlite off-loop worker terminated after query timeout");
  retireInstance(instance, (pendingId) => (pendingId === id ? timeoutError : collateral));
}

function takeWaiter(instance: Worker, id: number): Pending | undefined {
  const waiter = pending.get(id);
  if (!waiter || waiter.instance !== instance) return undefined;
  dropPending(id);
  updateRef(instance);
  return waiter;
}

function handleWorkerMessage(instance: Worker, msg: unknown): void {
  const parsed = SqliteWorkerResponseSchema.safeParse(msg);
  if (!parsed.success) {
    const id = numericMessageId(msg);
    // -1 is the worker sentinel for "no safe request id". Never treat it as a waiter.
    if (id == null || id === -1) {
      console.warn("[sqlite-all-offloop] ignoring invalid worker response");
      return;
    }
    const waiter = takeWaiter(instance, id);
    waiter?.reject(new Error("invalid sqlite worker response"));
    return;
  }
  if (parsed.data.id === -1) return;
  const waiter = takeWaiter(instance, parsed.data.id);
  if (!waiter) return;
  if (parsed.data.ok) {
    waiter.resolve(parsed.data.rows);
    return;
  }
  waiter.reject(sqliteOffLoopError(parsed.data.error.message, parsed.data.error.code));
}

function attachWorker(instance: Worker): void {
  instance.on("message", (msg: unknown) => {
    handleWorkerMessage(instance, msg);
  });
  instance.on("error", (err) => {
    const wrapped = err instanceof Error ? err : new Error(String(err));
    detachInstance(instance);
    rejectAll(wrapped, instance);
  });
  instance.on("exit", (code) => {
    // Only this instance's waiters. A trailing exit after a replacement worker
    // has taken over must not reject the new instance's queries.
    detachInstance(instance);
    rejectAll(new Error(`sqlite off-loop worker exited (${code ?? "unknown"})`), instance);
  });
}

async function getWorker(): Promise<Worker> {
  if (worker) return worker;
  if (workerReady) return workerReady;
  workerReady = (async () => {
    const { Worker: WorkerCtor } = await import(/* webpackIgnore: true */ "node:worker_threads");
    const [betterSqlitePath, zodPath] = await Promise.all([
      resolvePackageEntry("better-sqlite3"),
      resolvePackageEntry("zod")
    ]);
    const instance = new WorkerCtor(WORKER_SOURCE, {
      eval: true,
      workerData: { betterSqlitePath, zodPath }
    });
    attachWorker(instance);
    worker = instance;
    instance.unref();
    return instance;
  })();
  try {
    return await workerReady;
  } catch (err) {
    workerReady = null;
    worker = null;
    throw err;
  }
}

export async function sqliteAllOffLoop<T>(
  sql: string,
  params: readonly unknown[],
  dbPath: string,
  rowSchema: z.ZodType<T>,
  options?: SqliteAllOffLoopOptions
): Promise<T[]> {
  if (typeof sql !== "string" || sql.length === 0) {
    throw new Error("sqlite off-loop query requires SQL");
  }
  if (typeof dbPath !== "string" || dbPath.length === 0) {
    throw new Error("sqlite off-loop query requires a database path");
  }
  const signal = options?.signal;
  if (signal?.aborted) throw abortError(signal);
  const timeoutMs = resolveTimeoutMs(options?.timeoutMs);
  const instance = await getWorker();
  if (signal?.aborted) throw abortError(signal);
  const id = nextId++;
  const rows = await new Promise<unknown[]>((resolve, reject) => {
    if (worker !== instance) {
      reject(new Error("sqlite off-loop worker replaced"));
      return;
    }
    const timer = setTimeout(() => onRequestTimeout(instance, id), timeoutMs);
    timer.unref?.();
    const entry: Pending = { resolve, reject, instance, timer, signal };
    if (signal) {
      const callerSignal = signal;
      const onAbort = () => {
        const waiter = pending.get(id);
        if (!waiter || waiter !== entry) return;
        dropPending(id);
        updateRef(instance);
        waiter.reject(abortError(callerSignal));
      };
      entry.onAbort = onAbort;
      if (callerSignal.aborted) {
        clearTimeout(timer);
        reject(abortError(callerSignal));
        return;
      }
      callerSignal.addEventListener("abort", onAbort, { once: true });
    }
    pending.set(id, entry);
    updateRef(instance);
    if (signal?.aborted) {
      entry.onAbort?.();
      return;
    }
    try {
      instance.postMessage({ id, dbPath, sql, params: [...params] });
    } catch (err) {
      dropPending(id);
      updateRef(instance);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
  return z.array(rowSchema).parse(rows);
}

export async function resetSqliteAllOffLoopForTesting(): Promise<void> {
  const instance = worker;
  worker = null;
  workerReady = null;
  rejectAll(new Error("sqlite off-loop worker reset"));
  if (!instance) return;
  instance.removeAllListeners();
  await instance.terminate();
}

/** Test-only: register a waiter without sending SQL, so a forged reply can be delivered. */
export async function primeSqliteOffLoopWaiterForTesting(): Promise<{ id: number; done: Promise<unknown[]> }> {
  const instance = await getWorker();
  const id = nextId++;
  const done = new Promise<unknown[]>((resolve, reject) => {
    pending.set(id, { resolve, reject, instance });
    updateRef(instance);
  });
  return { id, done };
}

/** Test-only: run a raw worker message through the parent response handler. */
export async function deliverSqliteOffLoopMessageForTesting(msg: unknown): Promise<void> {
  const instance = await getWorker();
  handleWorkerMessage(instance, msg);
}

/**
 * Test-only: post an arbitrary message to the worker and resolve with the matching reply.
 * Replies whose id is not the request's safe integer id (or -1 when it has none) are ignored.
 */
export async function postSqliteOffLoopRawForTesting(msg: unknown): Promise<unknown> {
  const instance = await getWorker();
  const candidate = numericMessageId(msg);
  const matchId = candidate != null && Number.isSafeInteger(candidate) ? candidate : -1;
  return new Promise((resolve, reject) => {
    let onMessage: (response: unknown) => void = () => undefined;
    const timer = setTimeout(() => {
      instance.off("message", onMessage);
      reject(new Error("sqlite off-loop test probe timed out"));
    }, 2_000);
    timer.unref?.();
    onMessage = (response: unknown) => {
      if (numericMessageId(response) !== matchId) return;
      clearTimeout(timer);
      instance.off("message", onMessage);
      resolve(response);
    };
    instance.on("message", onMessage);
    try {
      instance.postMessage(msg);
    } catch (err) {
      clearTimeout(timer);
      instance.off("message", onMessage);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}
