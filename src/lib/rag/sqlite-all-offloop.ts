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

// WEBPACK TRAP: reachable from instrumentation.ts via vector-db.ts — no static "node:" imports.

/** Off-loop readers may wait the historical 60s lock budget; the serving thread stays free. */
const WORKER_BUSY_TIMEOUT_MS = 60_000;

const SqliteWorkerErrorSchema = z.strictObject({
  message: z.string(),
  code: z.string().optional()
});

/**
 * Parent-side view of one worker reply.  Strict so a widened payload cannot be treated as
 * rows or as a sqlite error.  `id: -1` is the worker's sentinel for a request that had no
 * safe integer id; it is not a waiter and must not settle anyone else.
 */
export const SqliteWorkerResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    id: z.int(),
    ok: z.literal(true),
    rows: z.array(z.unknown())
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

function rejectAll(err: Error): void {
  const waiters = [...pending.values()];
  pending.clear();
  for (const waiter of waiters) waiter.reject(err);
}

function updateRef(instance: Worker): void {
  if (pending.size > 0) instance.ref();
  else instance.unref();
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
    const waiter = pending.get(id);
    if (!waiter) return;
    pending.delete(id);
    updateRef(instance);
    waiter.reject(new Error("invalid sqlite worker response"));
    return;
  }
  if (parsed.data.id === -1) return;
  const waiter = pending.get(parsed.data.id);
  if (!waiter) return;
  pending.delete(parsed.data.id);
  updateRef(instance);
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
    if (worker === instance) {
      worker = null;
      workerReady = null;
    }
    rejectAll(wrapped);
  });
  instance.on("exit", (code) => {
    if (worker === instance) {
      worker = null;
      workerReady = null;
    }
    if (pending.size > 0) {
      rejectAll(new Error(`sqlite off-loop worker exited (${code ?? "unknown"})`));
    }
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
  rowSchema: z.ZodType<T>
): Promise<T[]> {
  if (typeof sql !== "string" || sql.length === 0) {
    throw new Error("sqlite off-loop query requires SQL");
  }
  if (typeof dbPath !== "string" || dbPath.length === 0) {
    throw new Error("sqlite off-loop query requires a database path");
  }
  const instance = await getWorker();
  const id = nextId++;
  const rows = await new Promise<unknown[]>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    updateRef(instance);
    try {
      instance.postMessage({ id, dbPath, sql, params: [...params] });
    } catch (err) {
      pending.delete(id);
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
    pending.set(id, { resolve, reject });
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
