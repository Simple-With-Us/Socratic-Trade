/**
 * Run a read-only better-sqlite3 `.all()` off the serving-process event loop.
 *
 * better-sqlite3 statements are synchronous on the calling thread.  A corpus-wide FTS MATCH
 * with occurrence joins therefore pins GET /api/live and GET /api/health for the whole
 * statement.  This helper keeps SQL construction and row mapping on the caller, and only
 * moves the blocking `.all()` onto a small pool of persistent worker threads, each
 * with its own readonly connection.  WAL readers can proceed without sharing the
 * serving `getDb()` handle.
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
 * Execution budget for one off-loop read, armed when that worker reports it is
 * about to call `.all()` — not when the parent posts. The worker runs statements
 * serially, so a timer started at postMessage would bill queue wait to the
 * statement. The budget equals `RAG_QUERY_IO_DEADLINE_MS`
 * (rag-retrieval-deadline.ts). That module does not statically import node:
 * builtins (only inflight-deadline.ts), so it is safe on the instrumentation
 * webpack graph.
 *
 * Production retrieval (`createRagQueryAbort` in vector-db.ts) arms that same
 * deadline before the request is posted, so the caller timer includes queue
 * wait and either timer can fire first. The settle path is safe whichever
 * wins. The execution timer keeps the waiter and retires the slot itself,
 * without looking the id up in `pending` after the waiter has been dropped.
 * A caller abort that settles first drops the waiter from `pending` but leaves
 * the execution timer armed until the worker replies or the budget fires.
 * Finishing quickly after the client gave up clears that timer and keeps the
 * slot warm. A wedged `.all()` that outlives the start-armed budget still
 * retires the slot when the timer fires, even though the caller already
 * rejected.
 *
 * A wedged `.all()` cannot be interrupted in place. This module retires a
 * started slot only for its own abandonments: the execution timer, or a
 * signal-less queue ceiling that loses the race with the start notice. Only
 * the started request fails. Requests still queued on that slot are
 * re-dispatched onto another live instance, or a fresh one when the rest of
 * the pool is busy.
 *
 * A request that was posted but has not started is cancelled in place. Each
 * worker is given a SharedArrayBuffer of 1024 int32 slots; the parent stores
 * the abandoned id at `id % length`, and the worker checks that flag after
 * validating the message and before posting `started` or calling `.all()`. A
 * match skips the statement. An index collision stores a different id, the
 * comparison fails, and the statement runs — safe, because a false cancel is
 * the outcome we refuse. The worker already inside `.all()` for a different
 * request is left alone. If SharedArrayBuffer cannot be allocated, the slot is
 * retired only when it has no started request; otherwise the abandoned message
 * is left to drain behind that healthy statement.
 *
 * Queued requests are also bounded by the caller's AbortSignal. A caller that
 * omits a signal gets a queue ceiling of `timeoutMs + SQLITE_OFF_LOOP_TIMEOUT_MS`
 * (this execution budget plus the same production timeout, not a small multiple
 * of `timeoutMs`). A short test override can sit behind a slow-but-under-timeout
 * statement without the ceiling firing, and a request that never receives a
 * start notification still cannot wait forever. The ceiling is cleared once
 * execution starts.
 */
export const SQLITE_OFF_LOOP_TIMEOUT_MS = RAG_QUERY_IO_DEADLINE_MS;

/**
 * Shared cancellation table, one per worker. Indexed by `requestId % length`.
 * 1024 entries keeps the buffer small (4KB) while making id collisions rare;
 * a collision only fails to cancel, it never cancels a different live request.
 */
const CANCEL_FLAG_COUNT = 1024;

/**
 * Readonly worker threads. Created lazily, up to this many. Each request is
 * posted to the live instance with the fewest pending requests (running plus
 * queued). A timeout or crash retires only that instance.
 *
 * A not-yet-started request is placed at most this many times: the first death
 * re-dispatches it, and a later death rejects it instead of respawning forever.
 */
export const SQLITE_OFF_LOOP_POOL_SIZE = 2;

/** Slack added to `timeoutMs` for the signal-less queue ceiling. See SQLITE_OFF_LOOP_TIMEOUT_MS. */
const SIGNAL_LESS_QUEUE_SLACK_MS = SQLITE_OFF_LOOP_TIMEOUT_MS;

export type SqliteAllOffLoopOptions = {
  /**
   * Reject this waiter on abort, including while it is still queued.
   * Abort of a request that has started drops only that waiter. The worker
   * finishes the statement and the slot stays in the pool, including requests
   * still queued behind it. Abort of a request that was posted but has not
   * started cancels it in place (the worker skips the statement) and does not
   * disturb a query already running there.
   */
  signal?: AbortSignal;
  /** Execution budget armed at worker start. Overrides SQLITE_OFF_LOOP_TIMEOUT_MS. Production callers omit this. */
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
 * Posted immediately before `.all()`. Strict and distinct from the result envelope so a
 * start notice cannot be read as rows or as a sqlite error. The parent arms the execution
 * timeout from this message; queue time is not part of that budget.
 */
export const SqliteWorkerStartedSchema = z.strictObject({
  id: z.int(),
  started: z.literal(true)
});

const SqliteWorkerResultSchema = z.discriminatedUnion("ok", [
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

/**
 * Parent-side view of one worker message. Strict so a widened payload cannot be treated as
 * rows, as a start notice, or as a sqlite error. `id: -1` is the worker's sentinel for a
 * request that had no safe integer id; it is not a waiter and must not settle anyone else.
 * Row values are checked here; the caller's `rowSchema` remains the domain check.
 */
export const SqliteWorkerResponseSchema = z.union([SqliteWorkerResultSchema, SqliteWorkerStartedSchema]);

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

// Parent stores an abandoned request id at id % length before this message is
// dequeued. Equal ids mean skip .all(). A colliding later id fails the compare
// and the statement runs, which must stay the safe direction.
function requestCancelled(id) {
  const flags = workerData.cancelFlags;
  if (!flags || typeof id !== "number" || !Number.isSafeInteger(id)) return false;
  try {
    const index = id % flags.length;
    if (index < 0 || index >= flags.length) return false;
    return Atomics.load(flags, index) === id;
  } catch {
    return false;
  }
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
  if (requestCancelled(request.id)) {
    parentPort.postMessage({
      id: request.id,
      ok: false,
      error: { message: "sqlite off-loop query cancelled", code: "CANCELLED" }
    });
    return;
  }
  try {
    const database = openDb(request.dbPath);
    const statement = database.prepare(request.sql);
    // After this message the statement is on the worker thread. The parent arms the
    // execution timeout here so earlier queue time is not charged against it.
    // Cancellation is checked above, before this post, so a skipped statement never
    // reports started and never enters .all().
    parentPort.postMessage({ id: request.id, started: true });
    const rows = statement.all(...request.params);
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

type PoolSlot = {
  worker: Worker | null;
  starting: Promise<Worker> | null;
  disposed: boolean;
  /** Shared with this slot's worker. Null when SharedArrayBuffer could not be allocated. */
  cancelFlags: Int32Array | null;
  /**
   * Posted ids abandoned before the parent observed `started`. A later start
   * notice means the cancel flag lost the race and the statement is running,
   * so the slot is retired. Terminal replies drop the id without retiring.
   */
  abandonedBeforeStart: Set<number>;
};

type Pending = {
  id: number;
  resolve: (rows: SqliteRow[]) => void;
  reject: (err: Error) => void;
  slot: PoolSlot;
  /** True once this instance has posted `{ id, started: true }` for the request. */
  started: boolean;
  /** True once postMessage has queued this attempt on `slot`'s worker. */
  posted: boolean;
  /**
   * True once the waiter left `pending`. Execution-timer callbacks read this
   * instead of looking the id up again: settle clears the timer, but a callback
   * already queued must still see that the waiter was abandoned and must not
   * depend on `pending.get`.
   */
  settled: boolean;
  /**
   * True when this module initiated the abandon (execution timer or the
   * signal-less queue ceiling). Caller AbortSignal leaves this false, so a
   * started request does not retire the worker.
   */
  abandonedByBudget: boolean;
  /** How many times the request has been posted. Caps re-dispatch at the pool size. */
  placements: number;
  /**
   * Real queries are posted again when their instance dies before start. Primed test
   * waiters are not SQL and must be rejected instead.
   */
  allowRedispatch: boolean;
  executionTimer?: ReturnType<typeof setTimeout>;
  ceilingTimer?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
  sql: string;
  params: readonly unknown[];
  dbPath: string;
  timeoutMs: number;
};

const slots: PoolSlot[] = [];
const pending = new Map<number, Pending>();
/** Started waiters settled by caller abort; execution timer may still reclaim the slot. */
const reclaimById = new Map<number, Pending>();
let nextId = 1;
/** Test-only. Invoked when the parent observes `{ started: true }` and arms the execution timer. */
let onQueryStartedForTesting: ((id: number) => void) | null = null;

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

function queueCeilingMs(timeoutMs: number): number {
  return timeoutMs + SIGNAL_LESS_QUEUE_SLACK_MS;
}

function slotLoad(slot: PoolSlot): number {
  let count = 0;
  for (const waiter of pending.values()) {
    if (waiter.slot === slot) count += 1;
  }
  return count;
}

function updateRef(slot: PoolSlot): void {
  const instance = slot.worker;
  if (!instance) return;
  let count = 0;
  for (const waiter of pending.values()) {
    if (waiter.slot === slot) count += 1;
  }
  try {
    if (count > 0 && !slot.disposed) instance.ref();
    else instance.unref();
  } catch {
    // terminate()/exit already stopped the thread.
  }
}

function clearExecutionReclaim(id: number): void {
  const waiter = reclaimById.get(id);
  if (!waiter) return;
  reclaimById.delete(id);
  if (waiter.executionTimer !== undefined) {
    clearTimeout(waiter.executionTimer);
    waiter.executionTimer = undefined;
  }
}

function dropPending(id: number, options?: { keepExecutionTimer?: boolean }): Pending | undefined {
  const waiter = pending.get(id);
  if (!waiter) return undefined;
  waiter.settled = true;
  pending.delete(id);
  if (!options?.keepExecutionTimer && waiter.executionTimer !== undefined) {
    clearTimeout(waiter.executionTimer);
    waiter.executionTimer = undefined;
  }
  if (waiter.ceilingTimer !== undefined) clearTimeout(waiter.ceilingTimer);
  if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
  updateRef(waiter.slot);
  return waiter;
}

function abandonedWorkerError(): Error {
  return new Error("sqlite off-loop worker terminated after an abandoned query");
}

function createCancelFlags(): Int32Array | null {
  try {
    if (typeof SharedArrayBuffer !== "function" || typeof Atomics === "undefined") return null;
    const buffer = new SharedArrayBuffer(CANCEL_FLAG_COUNT * Int32Array.BYTES_PER_ELEMENT);
    const flags = new Int32Array(buffer);
    // Atomics rejects a non-shared buffer. Prove the allocation before handing it to a worker.
    Atomics.store(flags, 0, 0);
    return flags;
  } catch {
    return null;
  }
}

/**
 * Record `id` so the worker skips that queued message. Returns false when there
 * is no shared table (or the id cannot be stored exactly in an int32); the
 * caller then falls back to retiring an idle slot or letting the message drain.
 * A wrapped or colliding store would not compare equal, so the statement would
 * run — do not report success in that case.
 */
function markCancelled(slot: PoolSlot, id: number): boolean {
  const flags = slot.cancelFlags;
  if (!flags) return false;
  if (!Number.isSafeInteger(id) || id <= 0 || id > 0x7fffffff) return false;
  Atomics.store(flags, id % flags.length, id);
  return true;
}

/**
 * The message is already on the worker port and `.all()` has not been observed.
 * Cancel it in place when a shared flag exists. A later `started` for this id
 * means the flag lost the race: the statement is running, and the slot is
 * retired from the message handler. Without a shared flag, retire the slot
 * only when nothing on it has started; a healthy in-flight statement is left
 * alone and this message drains behind it.
 *
 * A waiter that has already started is a caller abort; reclaim is the execution
 * timer, not this path. Leave the worker up until the budget fires or SQL ends.
 */
function abandonPostedRequest(waiter: Pending, slot: PoolSlot): void {
  if (waiter.started) return;
  if (markCancelled(slot, waiter.id)) {
    slot.abandonedBeforeStart.add(waiter.id);
    return;
  }
  let slotHasStarted = false;
  for (const other of pending.values()) {
    if (other.slot === slot && other.started) {
      slotHasStarted = true;
      break;
    }
  }
  if (!slotHasStarted) {
    killSlot(slot, () => abandonedWorkerError(), true);
  }
}

function settleReject(waiter: Pending, err: Error): void {
  if (pending.get(waiter.id) !== waiter) return;
  const started = waiter.started;
  const posted = waiter.posted;
  const abandonedByBudget = waiter.abandonedByBudget;
  const slot = waiter.slot;
  const keepExecutionTimer = started && !abandonedByBudget;
  dropPending(waiter.id, { keepExecutionTimer });
  if (keepExecutionTimer) reclaimById.set(waiter.id, waiter);
  // Retire or cancel before reject so a synchronous rejection handler observes
  // the pool after the abandoned statement has been dealt with.
  // Started budget abandonment retires the slot from onExecutionTimeout via
  // killSlot before settleReject runs for that waiter (`slot.disposed` true).
  if (!slot.disposed && posted) {
    abandonPostedRequest(waiter, slot);
  }
  waiter.reject(err);
}

/** Live instance with the fewest pending requests. Grows the pool while every instance is busy. */
function selectSlot(): PoolSlot {
  const active = slots.filter((slot) => !slot.disposed);
  const hasIdle = active.some((slot) => slotLoad(slot) === 0);
  if (active.length < SQLITE_OFF_LOOP_POOL_SIZE && (active.length === 0 || !hasIdle)) {
    return createSlot();
  }
  let best = active[0];
  if (!best) return createSlot();
  let bestLoad = slotLoad(best);
  for (let index = 1; index < active.length; index += 1) {
    const candidate = active[index];
    if (!candidate) continue;
    const load = slotLoad(candidate);
    if (load < bestLoad) {
      best = candidate;
      bestLoad = load;
    }
  }
  return best;
}

function createSlot(): PoolSlot {
  const slot: PoolSlot = {
    worker: null,
    starting: null,
    disposed: false,
    cancelFlags: null,
    abandonedBeforeStart: new Set()
  };
  slots.push(slot);
  slot.starting = startSlot(slot);
  return slot;
}

async function startSlot(slot: PoolSlot): Promise<Worker> {
  try {
    const { Worker: WorkerCtor } = await import(/* webpackIgnore: true */ "node:worker_threads");
    const [betterSqlitePath, zodPath] = await Promise.all([
      resolvePackageEntry("better-sqlite3"),
      resolvePackageEntry("zod")
    ]);
    if (slot.disposed) throw new Error("sqlite off-loop worker replaced");
    const cancelFlags = createCancelFlags();
    slot.cancelFlags = cancelFlags;
    const instance = new WorkerCtor(WORKER_SOURCE, {
      eval: true,
      workerData: { betterSqlitePath, zodPath, cancelFlags }
    });
    if (slot.disposed) {
      instance.removeAllListeners();
      await instance.terminate();
      throw new Error("sqlite off-loop worker replaced");
    }
    slot.worker = instance;
    attachWorker(slot, instance);
    updateRef(slot);
    return instance;
  } catch (err) {
    if (!slot.disposed) {
      slot.disposed = true;
      const index = slots.indexOf(slot);
      if (index >= 0) slots.splice(index, 1);
    }
    throw err;
  }
}

function armCeiling(waiter: Pending): void {
  if (waiter.signal || waiter.started || waiter.ceilingTimer !== undefined) return;
  const timer = setTimeout(() => {
    if (pending.get(waiter.id) !== waiter || waiter.started) return;
    // This module's queue ceiling, not the caller's AbortSignal. A start that
    // wins the race is handled from the worker message (see abandonedBeforeStart).
    waiter.abandonedByBudget = true;
    settleReject(waiter, new Error("sqlite off-loop query timed out before it started"));
  }, queueCeilingMs(waiter.timeoutMs));
  timer.unref?.();
  waiter.ceilingTimer = timer;
}

function postToSlot(waiter: Pending): void {
  const slot = waiter.slot;
  if (slot.disposed || pending.get(waiter.id) !== waiter) return;
  waiter.placements += 1;
  armCeiling(waiter);
  const placement = waiter.placements;
  const send = (instance: Worker) => {
    if (waiter.slot !== slot || slot.disposed || slot.worker !== instance) return;
    if (pending.get(waiter.id) !== waiter || waiter.placements !== placement) return;
    updateRef(slot);
    try {
      instance.postMessage({
        id: waiter.id,
        dbPath: waiter.dbPath,
        sql: waiter.sql,
        params: [...waiter.params]
      });
      waiter.posted = true;
    } catch (err) {
      settleReject(waiter, err instanceof Error ? err : new Error(String(err)));
    }
  };
  if (slot.worker) {
    send(slot.worker);
    return;
  }
  const starting = slot.starting;
  if (!starting) {
    settleReject(waiter, new Error("sqlite off-loop worker unavailable"));
    return;
  }
  starting.then(send, (err: unknown) => {
    if (waiter.slot !== slot || pending.get(waiter.id) !== waiter || waiter.placements !== placement) return;
    settleReject(waiter, err instanceof Error ? err : new Error(String(err)));
  });
}

/**
 * Retire one instance. Started requests on it fail. Not-yet-started requests are
 * re-dispatched when `redispatchQueued` is set, unless this placement would exceed
 * the pool size (or the waiter is a test probe that was never real SQL).
 */
function killSlot(
  slot: PoolSlot,
  errorFor: (waiter: Pending) => Error,
  redispatchQueued: boolean,
  stopThread = true
): void {
  if (slot.disposed) return;
  slot.disposed = true;
  const index = slots.indexOf(slot);
  if (index >= 0) slots.splice(index, 1);

  const doomed: Pending[] = [];
  const movable: Pending[] = [];
  for (const waiter of pending.values()) {
    if (waiter.slot !== slot) continue;
    // The port message cannot be pulled. Ask the dying worker to skip anything
    // it has not started so a slow terminate does not run SQL we are moving.
    if (!waiter.started && waiter.posted) markCancelled(slot, waiter.id);
    if (redispatchQueued && !waiter.started && waiter.allowRedispatch && waiter.placements < SQLITE_OFF_LOOP_POOL_SIZE) {
      movable.push(waiter);
    } else {
      doomed.push(waiter);
    }
  }
  for (const waiter of doomed) settleReject(waiter, errorFor(waiter));
  for (const waiter of movable) {
    // The new attempt posts to a different flag table. The old id was marked
    // cancelled only on the worker we are retiring.
    waiter.posted = false;
    waiter.slot = selectSlot();
    postToSlot(waiter);
  }
  updateRef(slot);
  const instance = slot.worker;
  slot.worker = null;
  if (!instance) return;
  // Drop parent handlers first. terminate() installs its own exit listener after this,
  // so it must be the last call — a later removeAllListeners() would hang that promise.
  instance.removeAllListeners("message");
  instance.removeAllListeners("error");
  instance.removeAllListeners("exit");
  if (stopThread) void instance.terminate().catch(() => undefined);
}

function onExecutionTimeout(waiter: Pending): void {
  if (!waiter.started || waiter.slot.disposed) return;
  reclaimById.delete(waiter.id);
  if (waiter.executionTimer !== undefined) {
    clearTimeout(waiter.executionTimer);
    waiter.executionTimer = undefined;
  }
  waiter.abandonedByBudget = true;
  const timeoutError = new Error("sqlite off-loop query timed out");
  const exhausted = new Error("sqlite off-loop worker terminated after query timeout");
  // Dispose the slot before settleReject runs for the waiters still on it, so
  // the budget branch there does not call killSlot a second time.
  killSlot(
    waiter.slot,
    (pendingWaiter) => (pendingWaiter.id === waiter.id ? timeoutError : exhausted),
    true
  );
}

function takeWaiter(slot: PoolSlot, instance: Worker, id: number): Pending | undefined {
  const waiter = pending.get(id);
  if (!waiter || waiter.slot !== slot || slot.worker !== instance) return undefined;
  dropPending(id);
  return waiter;
}

function noteStarted(slot: PoolSlot, instance: Worker, id: number): void {
  if (slot.disposed || slot.worker !== instance) return;
  const waiter = pending.get(id);
  if (!waiter || waiter.slot !== slot || waiter.started || waiter.settled) return;
  waiter.started = true;
  if (waiter.ceilingTimer !== undefined) {
    clearTimeout(waiter.ceilingTimer);
    waiter.ceilingTimer = undefined;
  }
  if (waiter.executionTimer !== undefined) clearTimeout(waiter.executionTimer);
  const timer = setTimeout(() => onExecutionTimeout(waiter), waiter.timeoutMs);
  timer.unref?.();
  waiter.executionTimer = timer;
  onQueryStartedForTesting?.(id);
}

function handleWorkerMessage(slot: PoolSlot, instance: Worker, msg: unknown): void {
  if (slot.disposed || slot.worker !== instance) return;
  const parsed = SqliteWorkerResponseSchema.safeParse(msg);
  if (!parsed.success) {
    const id = numericMessageId(msg);
    // -1 is the worker sentinel for "no safe request id". Never treat it as a waiter.
    if (id == null || id === -1) {
      console.warn("[sqlite-all-offloop] ignoring invalid worker response");
      return;
    }
    const waiter = takeWaiter(slot, instance, id);
    waiter?.reject(new Error("invalid sqlite worker response"));
    return;
  }
  if ("started" in parsed.data) {
    // The cancel flag is checked before the worker posts this. Seeing it for an
    // id we already abandoned means `.all()` is now running; retire the slot.
    // The request ahead of it has already finished — the worker is serial.
    // Notify the test hook before retiring so a start that escaped cancellation
    // is observable as a statement that began.
    if (slot.abandonedBeforeStart.delete(parsed.data.id)) {
      onQueryStartedForTesting?.(parsed.data.id);
      killSlot(slot, () => abandonedWorkerError(), true);
      return;
    }
    noteStarted(slot, instance, parsed.data.id);
    return;
  }
  // Replies for unknown ids (including a cancelled message whose waiter already
  // settled) are ignored. Drop the abandon mark so a stale entry cannot retire
  // the slot if a later start notice is ever delivered for the same id.
  slot.abandonedBeforeStart.delete(parsed.data.id);
  if (parsed.data.id === -1) return;
  clearExecutionReclaim(parsed.data.id);
  const waiter = takeWaiter(slot, instance, parsed.data.id);
  if (!waiter) return;
  if (parsed.data.ok) {
    waiter.resolve(parsed.data.rows);
    return;
  }
  waiter.reject(sqliteOffLoopError(parsed.data.error.message, parsed.data.error.code));
}

function attachWorker(slot: PoolSlot, instance: Worker): void {
  instance.on("message", (msg: unknown) => {
    handleWorkerMessage(slot, instance, msg);
  });
  instance.on("error", (err) => {
    const wrapped = err instanceof Error ? err : new Error(String(err));
    killSlot(slot, () => wrapped, true);
  });
  instance.on("exit", (code) => {
    // Only this instance. A trailing exit after its requests moved to a replacement
    // must not reject the new instance's queries. killSlot is a no-op once disposed.
    killSlot(slot, () => new Error(`sqlite off-loop worker exited (${code ?? "unknown"})`), true);
  });
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
  const slot = selectSlot();
  const id = nextId++;
  const rows = await new Promise<SqliteRow[]>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const entry: Pending = {
      id,
      resolve,
      reject,
      slot,
      started: false,
      posted: false,
      settled: false,
      abandonedByBudget: false,
      placements: 0,
      allowRedispatch: true,
      signal,
      sql,
      params,
      dbPath,
      timeoutMs
    };
    if (signal) {
      const callerSignal = signal;
      const onAbort = () => {
        if (pending.get(id) !== entry) return;
        settleReject(entry, abortError(callerSignal));
      };
      entry.onAbort = onAbort;
      if (callerSignal.aborted) {
        reject(abortError(callerSignal));
        return;
      }
      callerSignal.addEventListener("abort", onAbort, { once: true });
    }
    pending.set(id, entry);
    updateRef(slot);
    postToSlot(entry);
  });
  return z.array(rowSchema).parse(rows);
}

export async function resetSqliteAllOffLoopForTesting(): Promise<void> {
  const resetError = new Error("sqlite off-loop worker reset");
  const doomed = [...slots];
  const starts = doomed.map((slot) => slot.starting);
  const instances: Worker[] = [];
  for (const slot of doomed) {
    const instance = slot.worker;
    // Reject waiters here; terminate once below. A second concurrent terminate()
    // strips the exit listener the first one is awaiting and never settles.
    killSlot(slot, () => resetError, false, false);
    if (instance && !instances.includes(instance)) instances.push(instance);
  }
  for (const waiter of [...pending.values()]) settleReject(waiter, resetError);
  reclaimById.clear();
  const startedLater = await Promise.all(
    starts.map(async (starting) => {
      if (!starting) return null;
      try {
        return await starting;
      } catch {
        return null;
      }
    })
  );
  for (const instance of startedLater) {
    if (instance && !instances.includes(instance)) instances.push(instance);
  }
  await Promise.all(
    instances.map(async (instance) => {
      instance.removeAllListeners("message");
      instance.removeAllListeners("error");
      instance.removeAllListeners("exit");
      try {
        await instance.terminate();
      } catch {
        // already stopped
      }
    })
  );
}

async function ensureWorkerForTesting(): Promise<PoolSlot> {
  const existing = slots.find((slot) => !slot.disposed);
  const slot = existing ?? createSlot();
  if (!slot.worker) await slot.starting;
  if (!slot.worker || slot.disposed) throw new Error("sqlite off-loop worker unavailable");
  return slot;
}

/** Test-only: observe the parent arming the execution timer after `{ started: true }`. */
export function setSqliteOffLoopStartedHookForTesting(hook: ((id: number) => void) | null): void {
  onQueryStartedForTesting = hook;
}

/** Test-only: live pool slots. A retired slot is removed synchronously in killSlot. */
export function activeSqliteOffLoopSlotCountForTesting(): number {
  return slots.filter((slot) => !slot.disposed).length;
}

/** Test-only: register a waiter without sending SQL, so a forged reply can be delivered. */
export async function primeSqliteOffLoopWaiterForTesting(): Promise<{ id: number; done: Promise<SqliteRow[]> }> {
  const slot = await ensureWorkerForTesting();
  const id = nextId++;
  const done = new Promise<SqliteRow[]>((resolve, reject) => {
    const entry: Pending = {
      id,
      resolve,
      reject,
      slot,
      started: false,
      posted: false,
      settled: false,
      abandonedByBudget: false,
      placements: 1,
      allowRedispatch: false,
      sql: "SELECT 1",
      params: [],
      dbPath: ":memory:",
      timeoutMs: SQLITE_OFF_LOOP_TIMEOUT_MS
    };
    pending.set(id, entry);
    updateRef(slot);
  });
  return { id, done };
}

/** Test-only: run a raw worker message through the parent response handler. */
export async function deliverSqliteOffLoopMessageForTesting(msg: unknown): Promise<void> {
  const id = numericMessageId(msg);
  if (id != null && id !== -1) {
    const waiter = pending.get(id);
    const instance = waiter?.slot.worker;
    if (waiter && instance && !waiter.slot.disposed) {
      handleWorkerMessage(waiter.slot, instance, msg);
      return;
    }
  }
  const slot = await ensureWorkerForTesting();
  if (!slot.worker) return;
  handleWorkerMessage(slot, slot.worker, msg);
}

/**
 * Test-only: post an arbitrary message to one pool worker and resolve with the matching reply.
 * Start notices and replies whose id is not the request's safe integer id (or -1 when it has
 * none) are ignored.
 */
export async function postSqliteOffLoopRawForTesting(msg: unknown): Promise<unknown> {
  const slot = await ensureWorkerForTesting();
  const instance = slot.worker;
  if (!instance) throw new Error("sqlite off-loop worker unavailable");
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
      if (SqliteWorkerStartedSchema.safeParse(response).success) return;
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
