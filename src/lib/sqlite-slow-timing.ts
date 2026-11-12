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
// 2026-10-24: this logger is what named the `audit_events` halt-cause sweep as the statement
// holding the serving event loop for 4.8-6.8 s, on a path the health route runs.  The log was
// then hard to read: the SQL prefix was truncated at 160 characters, which is shorter than the
// sweep's own branch, so the batched and single-account forms of the same statement were
// indistinguishable -- and, because the rate-limit key was that same truncated prefix, they
// shared one budget and neither could be counted on its own.
//
// Warn-only.  It changes no query, no result and no error: every wrapper calls the original with
// the same `this` and arguments and rethrows what it throws.  Log lines are rate-limited per SQL
// key so a slow loop cannot flood stderr.  No node: static imports (instrumentation webpack graph),
// so the WAL size is supplied by the caller as a callback.

export const SLOW_SQLITE_WARN_MS = 1_000;
const LOG_EVERY_MS = 10_000;
/**
 * How much SQL text a log line carries.  Long enough to hold the `connected_account_id = ?`
 * versus `IS NULL` branch of the halt-cause sweep, which is where two otherwise identical
 * statements first differ.
 */
const SQL_PREFIX_CHARS = 240;

export interface SlowSqliteOptions {
  thresholdMs?: number;
  warn?: (line: string) => void;
  /** Returns the WAL size in bytes, or null when unknown.  Called only on a slow call. */
  walBytes?: () => number | null;
  now?: () => number;
}

type AnyFn = (...args: unknown[]) => unknown;
const STATEMENT_METHODS = ["run", "get", "all", "iterate"] as const;

/**
 * Identity of one SQL shape: the rate-limit key AND the text a log line carries.
 *
 * The truncated prefix alone was not enough.  The batched `audit_events` sweep and the
 * single-account sweep share their first 160 characters, so they shared one rate-limit budget
 * and the log could not say which one was slow -- production 2026-10-24 could not tell a
 * 4-account batch from a 1-account read.  The statement length separates them, and the prefix
 * is long enough to carry the `connected_account_id = ?` versus `IS NULL` branch.
 */
function sqlKey(sql: string): string {
  const normalized = sql.replace(/\s+/g, " ").trim();
  return `${normalized.slice(0, SQL_PREFIX_CHARS)} len=${normalized.length}`;
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
  // One frame per running transaction; holds the first SQL it ran so an inline (anonymous)
  // transaction function still reports something that tells two transactions apart.
  const txFrames: Array<{ firstSql?: string }> = [];

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
    if (kind !== "exec" && txFrames.length > 0 && !kind.startsWith("transaction")) {
      const frame = txFrames[txFrames.length - 1];
      if (frame.firstSql === undefined) frame.firstSql = key;
    }
    try {
      return run();
    } finally {
      report(kind, key, now() - start);
    }
  };

  // Time each lazy step.  Each next() is one contiguous hold of the loop, so it is reported on
  // its own (kind "iterate.next") rather than summed across awaits between steps, which would
  // overstate a hold.  The iterator object is kept; only next/return/throw are shadowed, so every
  // other property and the iteration protocol are unchanged.
  const timeIteratorSteps = (iterator: unknown, key: string): unknown => {
    if (!iterator || typeof iterator !== "object") return iterator;
    const it = iterator as Record<string, unknown>;
    for (const step of ["next", "return", "throw"] as const) {
      const original = it[step];
      if (typeof original !== "function") continue;
      try {
        it[step] = function (this: unknown, ...stepArgs: unknown[]) {
          return timed(`iterate.${step}`, key, () => (original as AnyFn).apply(this, stepArgs));
        };
      } catch {
        // non-writable iterator: leave it untimed
      }
    }
    return iterator;
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
          const result = timed(method, key, () => (original as AnyFn).apply(this, callArgs));
          // iterate() only builds the iterator; the SQLite work runs inside each next().
          return method === "iterate" ? timeIteratorSteps(result, key) : result;
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
      const fnName = (args[0] as { name?: string } | undefined)?.name || "anonymous";
      // Label = the function's name plus the first SQL it ran (known once it finishes), so two
      // unnamed inline transactions neither share a rate-limit key nor lose their identity.
      const timedTx = <T>(kind: string, run: () => T): T => {
        const frame: { firstSql?: string } = {};
        txFrames.push(frame);
        const start = now();
        try {
          return run();
        } finally {
          txFrames.pop();
          const label = frame.firstSql ? `${fnName} first=${frame.firstSql}` : fnName;
          report(kind, label.slice(0, SQL_PREFIX_CHARS + 40), now() - start);
        }
      };
      const run = function (this: unknown, ...callArgs: unknown[]) {
        return timedTx("transaction", () => wrapped.apply(this, callArgs));
      } as AnyFn & Record<string, AnyFn>;
      for (const variant of ["deferred", "immediate", "exclusive"]) {
        const original = wrapped[variant];
        if (typeof original === "function") {
          run[variant] = function (this: unknown, ...callArgs: unknown[]) {
            return timedTx(`transaction.${variant}`, () => original.apply(this, callArgs));
          };
        }
      }
      return run;
    };
  }
}
