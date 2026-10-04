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
import { createRequire } from "node:module";
import type { Worker } from "node:worker_threads";

const nodeRequire = createRequire(import.meta.url);

/** Off-loop readers may wait the historical 60s lock budget; the serving thread stays free. */
const WORKER_BUSY_TIMEOUT_MS = 60_000;

const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const Database = require(workerData.betterSqlitePath);
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

parentPort.on("message", (msg) => {
  if (!msg || typeof msg.id !== "number") return;
  try {
    const params = Array.isArray(msg.params) ? msg.params : [];
    const rows = openDb(msg.dbPath).prepare(msg.sql).all(...params);
    parentPort.postMessage({ id: msg.id, ok: true, rows });
  } catch (err) {
    parentPort.postMessage({
      id: msg.id,
      ok: false,
      error: {
        message: err && err.message ? String(err.message) : String(err),
        code: err && err.code != null ? String(err.code) : undefined
      }
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

function betterSqlitePath(): string {
  try {
    return nodeRequire.resolve("better-sqlite3");
  } catch {
    return "better-sqlite3";
  }
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

function attachWorker(instance: Worker): void {
  instance.on("message", (msg: unknown) => {
    if (!msg || typeof msg !== "object") return;
    const record = msg as {
      id?: unknown;
      ok?: unknown;
      rows?: unknown;
      error?: { message?: unknown; code?: unknown };
    };
    if (typeof record.id !== "number") return;
    const waiter = pending.get(record.id);
    if (!waiter) return;
    pending.delete(record.id);
    updateRef(instance);
    if (record.ok === true && Array.isArray(record.rows)) {
      waiter.resolve(record.rows);
      return;
    }
    const error = new Error(
      typeof record.error?.message === "string" ? record.error.message : "sqlite off-loop query failed"
    );
    if (typeof record.error?.code === "string") {
      (error as Error & { code?: string }).code = record.error.code;
    }
    waiter.reject(error);
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
    const { Worker: WorkerCtor } = await import("node:worker_threads");
    const instance = new WorkerCtor(WORKER_SOURCE, {
      eval: true,
      workerData: { betterSqlitePath: betterSqlitePath() }
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
  dbPath: string
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
  return rows as T[];
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
