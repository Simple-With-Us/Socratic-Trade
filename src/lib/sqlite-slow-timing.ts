// Log-only timing for the serving SQLite connection (ST-4542).
//
// 2026-10-15 profiles showed 39-47 s single native calls on the main thread (worst: a one-row
// UPDATE in abortVectorCommit).  busy_timeout is pinned to SQLITE_BUSY_PIN_MS, so a busy wait
// cannot explain a call that long.  Candidates are an auto-checkpoint run by the committing
// connection (a large WAL, Litestream holding a reader), disk or mmap stalls, or a genuinely
// huge scan.  V8 profiles cannot tell them apart because the time sits in anonymous native frames.
// This wraps statement execution, db.exec and db.transaction so a slow call names itself:
// SQL text (never bind values), duration, and WAL size at the moment it finished.
//
// Warn-only.  It changes no query, no result and no error: every wrapper calls the original with
// the same `this` and arguments and rethrows what it throws.  Log lines are rate-limited per SQL
// key so a slow loop cannot flood stderr.  No node: static imports (instrumentation webpack graph),
// so the WAL size is supplied by the caller as a callback.

export const SLOW_SQLITE_WARN_MS = 1_000;
const LOG_EVERY_MS = 10_000;
const SQL_PREFIX_CHARS = 160;

export interface SlowSqliteOptions {
  thresholdMs?: number;
  warn?: (line: string) => void;
  /** Returns the WAL size in bytes, or null when unknown.  Called only on a slow call. */
  walBytes?: () => number | null;
  now?: () => number;
}

type AnyFn = (...args: unknown[]) => unknown;
const STATEMENT_METHODS = ["run", "get", "all", "iterate"] as const;

function sqlKey(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().slice(0, SQL_PREFIX_CHARS);
}

interface Target {
  prepare: AnyFn;
  exec?: AnyFn;
  transaction?: AnyFn;
}

export function installSlowSqliteTiming(database: object, options: SlowSqliteOptions = {}): void {
  const target = database as unknown as Target;
  const thresholdMs = options.thresholdMs ?? SLOW_SQLITE_WARN_MS;
  const warn = options.warn ?? ((line: string) => console.warn(line));
  const now = options.now ?? Date.now;
  const lastLogged = new Map<string, number>();

  const report = (kind: string, key: string, ms: number): void => {
    if (ms < thresholdMs) return;
    const at = now();
    const last = lastLogged.get(`${kind}:${key}`);
    if (last !== undefined && at - last < LOG_EVERY_MS) return;
    if (lastLogged.size > 200) lastLogged.clear();
    lastLogged.set(`${kind}:${key}`, at);
    let wal = "unknown";
    try {
      const bytes = options.walBytes?.();
      if (typeof bytes === "number" && Number.isFinite(bytes)) wal = String(bytes);
    } catch {
      // diagnostics only
    }
    warn(`[slow-sqlite] ${kind} held the event loop ${Math.round(ms)}ms walBytes=${wal} sql=${key}`);
  };

  const timed = <T>(kind: string, key: string, run: () => T): T => {
    const start = now();
    try {
      return run();
    } finally {
      report(kind, key, now() - start);
    }
  };

  const originalPrepare = target.prepare;
  target.prepare = function (this: unknown, ...args: unknown[]) {
    const statement = originalPrepare.apply(this, args) as Record<string, unknown> | undefined;
    if (!statement || typeof statement !== "object") return statement;
    const key = sqlKey(String(args[0] ?? ""));
    for (const method of STATEMENT_METHODS) {
      const original = statement[method];
      if (typeof original !== "function") continue;
      try {
        statement[method] = function (this: unknown, ...callArgs: unknown[]) {
          return timed(method, key, () => (original as AnyFn).apply(this, callArgs));
        };
      } catch {
        // frozen or non-writable statement: leave it untimed
      }
    }
    return statement;
  };

  const originalExec = target.exec;
  if (typeof originalExec === "function") {
    target.exec = function (this: unknown, ...args: unknown[]) {
      return timed("exec", sqlKey(String(args[0] ?? "")), () => originalExec.apply(this, args));
    };
  }

  // A transaction's COMMIT (and any auto-checkpoint it triggers) is not a statement, so time the
  // whole wrapper.  Statements inside keep their own timing.
  const originalTransaction = target.transaction;
  if (typeof originalTransaction === "function") {
    target.transaction = function (this: unknown, ...args: unknown[]) {
      const wrapped = originalTransaction.apply(this, args) as AnyFn & Record<string, AnyFn>;
      if (typeof wrapped !== "function") return wrapped;
      const label = (args[0] as { name?: string } | undefined)?.name || "anonymous";
      const run = function (this: unknown, ...callArgs: unknown[]) {
        return timed("transaction", label, () => wrapped.apply(this, callArgs));
      } as AnyFn & Record<string, AnyFn>;
      for (const variant of ["deferred", "immediate", "exclusive"]) {
        const original = wrapped[variant];
        if (typeof original === "function") {
          run[variant] = function (this: unknown, ...callArgs: unknown[]) {
            return timed(`transaction.${variant}`, label, () => original.apply(this, callArgs));
          };
        }
      }
      return run;
    };
  }
}
