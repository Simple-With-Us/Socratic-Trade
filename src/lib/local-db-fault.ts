// Local-SQLite fault classification for provider call sites.
//
// Why this exists (prod, 2026-08-09): the hourly managed-vector reconcile lane
// (scheduler.ts -> reconcileManagedVectorRecordsIfDue -> inventoryVectorRecordsByMetadata) was
// pushing alerts titled "Pinecone connection failed" whose body was
// `inventory fetch: database is locked` / `inventory list: database is locked`. "database is
// locked" is SQLITE_BUSY from OUR OWN better-sqlite3 file — Pinecone was never implicated. The
// failure reached the provider-degraded lane because withRagApiHealth wraps the whole durable
// dispatch cycle (reserve -> mark started -> provider call -> settle), so a SQLite error raised
// by the LOCAL ledger writes on either side of the network call is indistinguishable, at that
// seam, from a provider error — and gets the provider's name stamped on it.
//
// This module is the classifier plus the honest reporting lane for that case: an audit row named
// for the real cause, and — only when it keeps happening — ONE advisory notification that says
// "local database contention", never a vendor's name.
//
// Owner philosophy check: this is an OBSERVABILITY correctness fix, not a guardrail. It changes
// only how a failure is LABELLED and alerted; the error still propagates to the caller exactly as
// before, so no control flow, retry, or trading behavior changes.
//
// WEBPACK TRAP: this module is reachable from src/lib/scheduler.ts — do not import "os" and do
// not use "node:"-prefixed import specifiers here. `alertStorageWarning` is pulled in with a
// dynamic import so db-health.ts can statically import the classifier without a module cycle.

import { audit, getInternalSetting, setInternalSetting } from "./db";

/**
 * Message shapes that ONLY our local SQLite file can produce. Deliberately narrow: every entry is
 * a better-sqlite3/SQLite string that no provider HTTP response can contain, so a genuine
 * Pinecone/Voyage/OpenRouter outage keeps its existing provider-degraded behavior untouched.
 *
 * - `database is locked`        — SQLITE_BUSY (incl. SQLITE_BUSY_SNAPSHOT, the busy_timeout-proof
 *                                 variant; see docs/rollouts/2026-08-09-pinecone-lock-mislabel.md)
 * - `database table is locked`  — SQLITE_LOCKED (same family, different message text)
 * - `no such table`             — a missing / not-yet-migrated local table
 */
const LOCAL_DB_FAULT_MESSAGE_PATTERNS: RegExp[] = [
  /database is locked/i,
  /database table is locked/i,
  /no such table/i,
  /\bSQLITE_(?:BUSY|LOCKED)\b/
];

/** SQLite lock/contention shapes that appear inside an App A (Congress.Trade) import body, not ST's file. */
const DEPENDENCY_DB_CONTENTION_SQLITE_PATTERNS: RegExp[] = [
  /database is locked/i,
  /database table is locked/i,
  /\bSQLITE_(?:BUSY|LOCKED)\b/
];

/**
 * True when a health `error_text` row is Congress.Trade-side (or other peer-app) database write
 * contention surfaced through a successful HTTP import — NOT a broken share connection on ST.
 *
 * Prod (ST-3988, 2026-09-30): App A returned HTTP 200 with `ok:false` and per-row D1
 * `SQLITE_BUSY` rejections.  `logApiHealth` still drove `alertConnectionFailure`, which titled the
 * Sentry/PD event "congress-share connection failed" even though the token and transport were fine.
 */
export function isDependencyDbContentionMessage(message: string | null | undefined): boolean {
  if (!message) return false;
  const hasContention = DEPENDENCY_DB_CONTENTION_SQLITE_PATTERNS.some((pattern) => pattern.test(message));
  if (!hasContention) return false;
  if (/D1 batch error/i.test(message)) return true;
  const fromAppA =
    /App A reported ok=/i.test(message) ||
    /App A accepted fewer rows/i.test(message) ||
    /import rejected rows/i.test(message);
  return fromAppA;
}

/** Sentry `health.failure_class` for peer-app DB contention (must not route as `hard`). */
export const HEALTH_FAILURE_CLASS_DEPENDENCY_DB = "dependency-db-contention";

/** SQLite error codes better-sqlite3 puts on `error.code` (the message alone may not carry them). */
const LOCAL_DB_FAULT_CODE_PREFIXES = ["SQLITE_BUSY", "SQLITE_LOCKED"];

/** True when a raw error MESSAGE is one of our own local-SQLite fault shapes. */
export function isLocalDbFaultMessage(message: string | null | undefined): boolean {
  if (!message) return false;
  if (isDependencyDbContentionMessage(message)) return false;
  return LOCAL_DB_FAULT_MESSAGE_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * How many `cause` links to follow. Bounded so a self-referential or absurdly deep chain can never
 * spin here — three is already more nesting than any call site in this repo produces.
 */
const LOCAL_DB_FAULT_MAX_CAUSE_DEPTH = 3;

/**
 * The RAW local-SQLite message behind an error, or null when it is not one of our faults.
 *
 * Walks the `cause` chain, which is what makes this usable at a seam that RE-WRAPS the failure.
 * vector-db.ts's managed-commit path rethrows its local receipt/finalize writes as
 * `new Error("document-local-commit-finalize-failed", { cause: sqliteError })` — the wrapper's own
 * message matches no SQLite pattern and carries no `code`, so classifying it alone silently does
 * nothing. Returning the underlying text (rather than a bare boolean) also means the audit row and
 * the "local database contention" advisory quote the real SQLite error instead of the opaque
 * wrapper label.
 */
export function localDbFaultReason(error: unknown, depth = 0): string | null {
  if (depth > LOCAL_DB_FAULT_MAX_CAUSE_DEPTH) return null;
  if (typeof error === "string") return isLocalDbFaultMessage(error) ? error : null;
  if (!error || typeof error !== "object") return null;
  const message = (error as { message?: unknown }).message;
  const messageText = typeof message === "string" ? message : undefined;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && LOCAL_DB_FAULT_CODE_PREFIXES.some((prefix) => code.startsWith(prefix))) {
    // Prefer the message; `code` alone is still a truthful, non-empty reason.
    return messageText && messageText.length > 0 ? messageText : code;
  }
  if (messageText && isLocalDbFaultMessage(messageText)) return messageText;
  return localDbFaultReason((error as { cause?: unknown }).cause, depth + 1);
}

/**
 * True when an ERROR is a local-SQLite fault — by message, by the `code` better-sqlite3 stamps on
 * `SqliteError` (SQLITE_BUSY's message is the bare "database is locked", but SQLITE_BUSY_SNAPSHOT
 * arrives with `code: "SQLITE_BUSY_SNAPSHOT"`, so both are checked), or by either of those on a
 * wrapped `cause`.
 */
export function isLocalDbFaultError(error: unknown): boolean {
  return localDbFaultReason(error) !== null;
}

/** Rolling window the recurrence counter is measured over. */
export const LOCAL_DB_FAULT_WINDOW_MS = 6 * 60 * 60_000;
/** Occurrences within one window before the single advisory notification is raised. */
export const LOCAL_DB_FAULT_ADVISORY_THRESHOLD = 5;
/** Internal-settings key holding the rolling recurrence window. */
export const LOCAL_DB_FAULT_WINDOW_KEY = "localDbFault:window";
/** Hourly watermark so a contention storm cannot flood audit_events (which would itself write). */
export const LOCAL_DB_FAULT_AUDIT_HOUR_KEY = "localDbFault:lastAuditHour";
/** `warningType` passed to alertStorageWarning — becomes the notification title. */
export const LOCAL_DB_FAULT_WARNING_TYPE = "local database contention";

export const DEPENDENCY_DB_CONTENTION_WINDOW_KEY = "dependencyDbContention:window";
export const DEPENDENCY_DB_CONTENTION_AUDIT_HOUR_KEY = "dependencyDbContention:lastAuditHour";
export const DEPENDENCY_DB_CONTENTION_WARNING_TYPE = "dependency database contention";

interface LocalDbFaultWindow {
  startedAt: string;
  count: number;
  advised: boolean;
}

function readWindow(nowMs: number): LocalDbFaultWindow {
  const stored = getInternalSetting<Partial<LocalDbFaultWindow>>(LOCAL_DB_FAULT_WINDOW_KEY);
  const startedAtMs = stored?.startedAt ? Date.parse(stored.startedAt) : Number.NaN;
  const fresh =
    Number.isFinite(startedAtMs) &&
    startedAtMs <= nowMs &&
    nowMs - startedAtMs < LOCAL_DB_FAULT_WINDOW_MS;
  if (!fresh) return { startedAt: new Date(nowMs).toISOString(), count: 0, advised: false };
  return {
    startedAt: stored!.startedAt!,
    count: typeof stored?.count === "number" && Number.isFinite(stored.count) ? stored.count : 0,
    advised: stored?.advised === true
  };
}

export interface LocalDbFaultInput {
  /** Health/alert lane the failure surfaced through, e.g. "pinecone" — recorded, never alerted on. */
  lane: string;
  /** Operation label at the seam, e.g. "inventory fetch". */
  operation: string;
  /** Raw error message (already known to be a local-DB fault). */
  message: string;
  userId?: string;
}

/**
 * Record one local-DB fault: bump the rolling recurrence counter, write an audit row
 * (`local_db_contention`, at most once per hour so a contention storm's own logging cannot make
 * the contention worse), and — once the window crosses the threshold — raise exactly ONE advisory
 * notification titled for the real cause. Never throws and never mentions a provider in the title:
 * the whole point is that the vendor is not at fault.
 */
function readDependencyWindow(nowMs: number): LocalDbFaultWindow {
  const stored = getInternalSetting<Partial<LocalDbFaultWindow>>(DEPENDENCY_DB_CONTENTION_WINDOW_KEY);
  const startedAtMs = stored?.startedAt ? Date.parse(stored.startedAt) : Number.NaN;
  const fresh =
    Number.isFinite(startedAtMs) &&
    startedAtMs <= nowMs &&
    nowMs - startedAtMs < LOCAL_DB_FAULT_WINDOW_MS;
  if (!fresh) return { startedAt: new Date(nowMs).toISOString(), count: 0, advised: false };
  return {
    startedAt: stored!.startedAt!,
    count: typeof stored?.count === "number" && Number.isFinite(stored.count) ? stored.count : 0,
    advised: stored?.advised === true
  };
}

/**
 * Record peer-app (e.g. Congress.Trade D1) write contention seen through an import health row.
 * Never labels it a provider connection outage on ST.
 */
export async function noteDependencyDbContention(
  input: LocalDbFaultInput,
  nowMs: number = Date.now()
): Promise<{ count: number; advised: boolean }> {
  let result = { count: 0, advised: false };
  try {
    const window = readDependencyWindow(nowMs);
    const count = window.count + 1;
    const shouldAdvise = !window.advised && count >= LOCAL_DB_FAULT_ADVISORY_THRESHOLD;
    const next: LocalDbFaultWindow = {
      startedAt: window.startedAt,
      count,
      advised: window.advised || shouldAdvise
    };
    setInternalSetting(DEPENDENCY_DB_CONTENTION_WINDOW_KEY, next);
    result = { count, advised: shouldAdvise };

    const hour = new Date(nowMs).toISOString().slice(0, 13);
    if (getInternalSetting<string>(DEPENDENCY_DB_CONTENTION_AUDIT_HOUR_KEY) !== hour) {
      setInternalSetting(DEPENDENCY_DB_CONTENTION_AUDIT_HOUR_KEY, hour);
      audit(
        "dependency_db_contention",
        {
          lane: input.lane,
          operation: input.operation,
          reason: input.message.slice(0, 400),
          windowStartedAt: window.startedAt,
          windowCount: count
        },
        input.userId ?? "local"
      );
    }
    console.warn(
      `[dependency-db-contention] ${input.lane} "${input.operation}" saw peer-app database write contention ` +
        `(${input.message.slice(0, 120)}) — ST share connection not implicated (${count} in this window).`
    );

    if (shouldAdvise) {
      const { alertStorageWarning } = await import("./db-health");
      await alertStorageWarning(
        DEPENDENCY_DB_CONTENTION_WARNING_TYPE,
        `Congress.Trade (or another peer app) returned database lock/contention errors ${count} times in the last ` +
          `${Math.round(LOCAL_DB_FAULT_WINDOW_MS / 3_600_000)}h on the ${input.lane} "${input.operation}" path ` +
          `(latest: "${input.message.slice(0, 160)}"). This is write contention on the peer's database, not a ` +
          "broken share token or transport from Socratic Trade."
      );
    }
  } catch {
    // Reporting must never become a second failure.
  }
  return result;
}

export async function noteLocalDbFault(
  input: LocalDbFaultInput,
  nowMs: number = Date.now()
): Promise<{ count: number; advised: boolean }> {
  let result = { count: 0, advised: false };
  try {
    const window = readWindow(nowMs);
    const count = window.count + 1;
    const shouldAdvise = !window.advised && count >= LOCAL_DB_FAULT_ADVISORY_THRESHOLD;
    const next: LocalDbFaultWindow = {
      startedAt: window.startedAt,
      count,
      advised: window.advised || shouldAdvise
    };
    setInternalSetting(LOCAL_DB_FAULT_WINDOW_KEY, next);
    result = { count, advised: shouldAdvise };

    const hour = new Date(nowMs).toISOString().slice(0, 13);
    if (getInternalSetting<string>(LOCAL_DB_FAULT_AUDIT_HOUR_KEY) !== hour) {
      setInternalSetting(LOCAL_DB_FAULT_AUDIT_HOUR_KEY, hour);
      audit(
        "local_db_contention",
        {
          lane: input.lane,
          operation: input.operation,
          reason: input.message.slice(0, 400),
          windowStartedAt: window.startedAt,
          windowCount: count
        },
        input.userId ?? "local"
      );
    }
    console.warn(
      `[local-db-fault] ${input.lane} "${input.operation}" failed on a LOCAL SQLite fault ` +
        `(${input.message.slice(0, 120)}) — provider not implicated (${count} in this window).`
    );

    if (shouldAdvise) {
      const { alertStorageWarning } = await import("./db-health");
      await alertStorageWarning(
        LOCAL_DB_FAULT_WARNING_TYPE,
        `The local SQLite database returned "${input.message.slice(0, 160)}" ${count} times in the last ` +
          `${Math.round(LOCAL_DB_FAULT_WINDOW_MS / 3_600_000)}h, most recently on the ${input.lane} ` +
          `"${input.operation}" path. This is local write-lock contention on data/app.db, not a provider ` +
          "outage — the provider call itself was never shown to fail."
      );
    }
  } catch {
    // Reporting a local DB fault must never become a second failure. The caller still receives the
    // original error unchanged.
  }
  return result;
}
