import { databasePath, deleteInternalSetting, getAutoResumeOnBoot, getDb, getInternalSetting, setInternalSetting } from "./db";
import { brokerPauseAccountScope, getBrokerPlacementPauseMarker } from "./broker-health";
import { sqliteAllOffLoop } from "./rag/sqlite-all-offloop";
import { z } from "zod";
import type { SystemState } from "./types";

// Why is this account halted, and will it start again by itself?  (Board 687a5fb4, lane h5.)
//
// Production 2026-09-25..29: Alpaca Paper was auto-halted by a broker-health probe timeout at
// 18:20Z, and stayed halted with no runs for four days until an operator re-armed it.  Why its
// auto-pause never lifted is NOT established (see docs/rollouts/2026-09-30-st-w3-h5-restart-halt-visibility.md, Review
// round): the leading hypothesis is that pre-#3752 code dropped the auto-resume marker without
// resuming, when a caller holding a stale "active" snapshot got a healthy probe after the halt
// (#3752's durable re-read closed that path); the alternative is that the boot interlock ended the
// auto-pause at the #3752 deploy because "Auto-resume on boot" was off.  Either way nothing on the
// console, in the ops snapshot, or in the notification title said what was holding the account.
//
// This module records what the boot interlock did to each account (a receipt) and turns the
// durable state, plus the audit trail for halts that predate any receipt, into one honest answer:
// paused by the app and resuming by itself (with the last broker check), stopped by a restart,
// stopped by the drawdown breaker, paused by the app with its resume record gone, or no record.

/** What the boot interlock did to one account.  Cleared once the account leaves `halted`. */
export type BootHaltReceipt = {
  /** ISO time of the boot that halted the account. */
  at: string;
  /** "active": the boot reverted a Running account.  "broker_auto_pause": the account was already
   *  halted by a broker-health auto-pause, and the boot took away its auto-resume. */
  from: "active" | "broker_auto_pause";
  autoPauseReason?: string;
  autoPausedSince?: string;
};

export type AutonomyHaltCause =
  | {
      kind: "broker_auto_pause";
      /** The app paused the account and lifts the pause itself on the first healthy broker check
       *  (unless a restart with Auto-resume on boot off ends the pause first). */
      resumesOnItsOwn: true;
      since: string;
      reason: string;
      /** The user's "Auto-resume on boot" setting (or the env override) now.  When false, a restart
       *  or deploy before the broker recovers ends this auto-pause and leaves the account stopped. */
      autoResumeOnBootNow: boolean;
      /** The latest broker check that still failed while this pause held the account, if recorded. */
      lastProbeAt?: string;
      lastProbeReason?: string;
      summary: string;
    }
  | {
      kind: "restart";
      resumesOnItsOwn: false;
      at: string;
      from: BootHaltReceipt["from"];
      autoPauseReason?: string;
      /** The user's "Auto-resume on boot" setting as it is NOW (it was off when the restart halted it). */
      autoResumeOnBootNow: boolean;
      summary: string;
    }
  | {
      /** The drawdown circuit breaker (hard action "halted") stopped the account, and it has stayed
       *  halted since.  Read from the audit trail. */
      kind: "breaker";
      resumesOnItsOwn: false;
      at: string;
      reason: string;
      summary: string;
    }
  | {
      /** The run-failure watchdog (run-failure-watchdog.ts) auto-halted the account after a long
       *  streak of consecutive strategy-run failures, and it has stayed halted since.  The owner
       *  re-arms from the console; the watchdog never lifts it by itself. */
      kind: "run_failure_halt";
      resumesOnItsOwn: false;
      since: string;
      reason: string;
      consecutiveFailures: number;
      summary: string;
    }
  | {
      /** The audit trail says a broker auto-pause halted the account and nothing re-armed or took it
       *  over since, but the auto-resume marker is gone.  The 2026-09-25 incident shape; current code
       *  should never produce it, so seeing it means a marker was dropped without a record. */
      kind: "auto_pause_lost";
      resumesOnItsOwn: false;
      at: string;
      reason: string;
      summary: string;
    }
  | {
      kind: "stopped";
      resumesOnItsOwn: false;
      summary: string;
    };

const receiptKey = (userId: string, accountScope: string) => `autonomy:boot-halted:${userId}:${accountScope}`;

export function recordBootHaltReceipt(userId: string, accountScope: string, receipt: BootHaltReceipt): void {
  setInternalSetting(receiptKey(userId, accountScope), receipt);
}

export function getBootHaltReceipt(userId: string, accountScope: string): BootHaltReceipt | undefined {
  const raw = getInternalSetting<BootHaltReceipt>(receiptKey(userId, accountScope));
  if (!raw || typeof raw !== "object" || typeof raw.at !== "string") return undefined;
  if (raw.from !== "active" && raw.from !== "broker_auto_pause") return undefined;
  return raw;
}

export function clearBootHaltReceipt(userId: string, accountScope: string): void {
  deleteInternalSetting(receiptKey(userId, accountScope));
}

/**
 * Drop a receipt the account has outgrown: once it is no longer `halted`, someone re-armed it (or
 * set exit-only / wind-down) and the restart is history.  Read first so the scheduler's
 * every-tick call is a read, not a write, in the common case.  Returns true when one was removed.
 */
export function clearBootHaltReceiptIfNotHalted(userId: string, accountScope: string, systemState: SystemState): boolean {
  if (systemState === "halted") return false;
  if (!getBootHaltReceipt(userId, accountScope)) return false;
  clearBootHaltReceipt(userId, accountScope);
  return true;
}

function centralTime(iso: string | undefined): string {
  if (!iso) return "an unknown time";
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "an unknown time";
  const text = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
  return `${text} CT`;
}

function trimReason(reason: string | undefined): string {
  const text = String(reason ?? "").trim().replace(/[.\s]+$/, "");
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}

/** The user's "Auto-resume on boot" setting, or the AUTONOMY_RESUME_ON_BOOT=1 global override,
 *  exactly as the boot interlock (scheduler.reconcileAutonomyOnBoot) reads them. */
export function effectiveAutoResumeOnBoot(userId: string): boolean {
  return process.env.AUTONOMY_RESUME_ON_BOOT === "1" || getAutoResumeOnBoot(userId);
}

type AppHaltFromAudit = { kind: "breaker" | "auto_pause_lost"; at: string; reason: string };

/** Read one JSON field from an audit payload without letting a malformed payload throw
 *  (json_extract raises on invalid JSON; CASE evaluates only the chosen branch). */
const jsonField = (path: string, column = "payload") =>
  `CASE WHEN json_valid(${column}) THEN json_extract(${column}, '${path}') END`;

/** App-initiated halt rows.  Same predicate the old two-step lookup used. */
export const APP_HALT_PREDICATE = `(kind = 'broker_placement_auto_halted'
  OR (kind = 'policy_violation_drawdown' AND ${jsonField("$.revertedTo")} = 'halted'))`;

export function handoverPredicate(kindColumn: string, payloadColumn: string): string {
  return `(${kindColumn} IN ('broker_placement_auto_resumed', 'broker_placement_pause_owner_override', 'autonomy_halted_on_boot')
    OR (${kindColumn} = 'ops_account_control' AND ${jsonField("$.action", payloadColumn)} = 'set_system_state' AND ${jsonField("$.dryRun", payloadColumn)} = 0)
    OR (${kindColumn} = 'policy_change' AND ${jsonField("$.value.systemState", payloadColumn)} <> 'halted'))`;
}

/** Stay under SQLite's portable 999-variable ceiling.  Settings bind one variable per key. */
const HALT_SETTINGS_KEY_CHUNK = 900;
/** Each account is its own indexed LIMIT 1 inside one statement. */
const HALT_AUDIT_ACCOUNT_CHUNK = 80;

type AuditScope = HaltAuditScope;

type LatestAppHaltRow = {
  user_id: string;
  connected_account_id: string | null;
  kind: string;
  created_at: string;
  payload: string;
  handed_over: number;
};

function chunkItems<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * One indexed `LIMIT 1` per account, unioned into a single statement.
 * The handover check binds the same user and account again so both reads can
 * use `(user_id, connected_account_id, kind)` instead of scanning `audit_events`.
 * A missing account id uses `IS NULL`; a real id uses `=`.  ">=" plus the id
 * check keeps a row written in the same millisecond as the halt.
 */
function latestHaltBranch(account: AuditScope): { sql: string; params: string[] } {
  const missing = account.connectedAccountId == null;
  const accountSql = missing ? "connected_account_id IS NULL" : "connected_account_id = ?";
  const idParams = missing ? [account.userId] : [account.userId, account.connectedAccountId as string];
  // EXISTS binds come first in the text, then the inner LIMIT 1.  The subquery
  // returns one row before the handover check runs.
  const params = [...idParams, ...idParams];
  const sql = `SELECT h.user_id, h.connected_account_id, h.kind, h.created_at, h.payload,
    EXISTS (
      SELECT 1 FROM audit_events e
      WHERE e.user_id = ? AND e.${accountSql}
        AND e.created_at >= h.created_at
        AND e.id <> h.id
        AND ${handoverPredicate("e.kind", "e.payload")}
    ) AS handed_over
  FROM (
    SELECT id, user_id, connected_account_id, created_at, kind, payload
    FROM audit_events
    WHERE user_id = ? AND ${accountSql}
      AND ${APP_HALT_PREDICATE}
    ORDER BY created_at DESC
    LIMIT 1
  ) h`;
  return { sql, params };
}

function latestAppHalts(db: ReturnType<typeof getDb>, accounts: readonly AuditScope[]): LatestAppHaltRow[] {
  if (accounts.length === 0) return [];
  const rows: LatestAppHaltRow[] = [];
  for (const chunk of chunkItems(accounts, HALT_AUDIT_ACCOUNT_CHUNK)) {
    const branches = chunk.map(latestHaltBranch);
    const sql = branches.map((branch) => branch.sql).join("\nUNION ALL\n");
    const params = branches.flatMap((branch) => branch.params);
    rows.push(...(db.prepare(sql).all(...params) as LatestAppHaltRow[]));
  }
  return rows;
}

/**
 * One scope's cached audit row.  `row` is null when the account has no app-initiated halt.
 *
 * `dirty` is set when an audit write may have changed the answer (see invalidateHaltAuditCache):
 * the row is due for a re-read, but it is still the last CONFIRMED answer, so a re-read that
 * cannot complete does not erase a confirmed app halt.
 */
type CachedHaltAuditRow = { row: LatestAppHaltRow | null; at: number; dirty?: boolean };

/**
 * How long an off-loop audit row stays usable before it is re-read.
 *
 * Production 2026-10-24: one batch over four halted accounts held the serving event loop for
 * 5.4 s, and the `/api/health` probe that triggered it answered in 5.1 s.  Off the loop that is
 * no longer an outage, but it is still a multi-second read over a 19 GB database, so it does not
 * run on every health refresh.  The halt cause is a durable historical fact -- the last
 * app-initiated halt, and whether anyone took it over -- so a minute of staleness changes no
 * decision this feed drives.
 */
export const HALT_AUDIT_CACHE_TTL_MS = 60_000;

/**
 * How long a FAILED off-loop read keeps the next caller off the read.
 *
 * The read is a multi-second scan of a 19 GB table (1.4-5.4 s per call in production).  Retrying
 * it on every health poll while it keeps failing turns a degraded database into a repeating
 * multi-second read -- the same shape as the stall this fix exists to remove, only moved off the
 * serving loop.  The cooldown bounds the retry rate; the failure itself is reported (see
 * `haltCauseReadStatus`) instead of being retried into the ground.
 *
 * 30 s is shorter than the 60 s cache TTL, so a database that recovers is picked up within one
 * cache cycle and the fleet-dark signal does not stay blind for long.
 */
export const HALT_AUDIT_FAILURE_COOLDOWN_MS = 30_000;

/**
 * Execution budget for ONE off-loop audit read -- the whole read, not one chunk of it.  The
 * production batch takes ~5.4 s; the budget leaves room for a slower plan on a bigger database
 * and still retires the worker slot rather than hanging the caller.
 *
 * It is deliberately BELOW the fleet-health-recover probe timeout (12 s) and the Docker
 * HEALTHCHECK `--max-time` (14 s).  This read sits behind the health route, and a cold health
 * snapshot awaits it: a budget above those timeouts would let the fix reproduce the symptom it
 * exists to remove -- the health probe would time out, the daemon would restart the container, and
 * the restart would re-run the boot sweep.  At 8 s a contended read gives up, the cache keeps its
 * previous (stale) row, and the probe still answers in time.  A stale halt cause is display-only;
 * a missed probe is an outage.
 *
 * It covers the QUEUE WAIT as well as the statement.  `sqliteAllOffLoop` without a signal arms a
 * queue ceiling of `timeoutMs + SQLITE_OFF_LOOP_TIMEOUT_MS` (8 s + 15 s), so a read that waited
 * for a busy worker could hold its caller for 23 s -- past both probe budgets, which is the
 * outage this fix exists to remove.  One AbortSignal bounds the wait for every chunk instead.
 *
 * The read gives back a slice of this budget (`HALT_AUDIT_READ_WIND_DOWN_MS`) so it is aborted
 * and wound down BEFORE the caller's deadline, so the read itself gets a little under 8 s.
 */
const HALT_AUDIT_OFF_LOOP_TIMEOUT_MS = 8_000;

/**
 * How long past its own deadline a refresh may hold the shared pointer before it is released.
 *
 * The grace covers the normal path, where the refresh finishes on its deadline.  A refresh that
 * never settles at all -- a runner that ignores its abort -- is released after the grace, so one
 * wedged read cannot blind every later halt-cause read in the process.
 */
const HALT_AUDIT_REFRESH_RELEASE_GRACE_MS = 250;

/**
 * How much of the budget is held back so the read winds down BEFORE the caller's deadline.
 *
 * The caller gives up at its own deadline, and a read that is still running at that moment leaves
 * the caller racing it: the caller returns while the read is still in flight, the next caller
 * reuses the shared refresh that is already dying, and the read's own abort -- the signal that
 * ends it -- fires after the caller has already answered.  Holding back a slice of the budget
 * means the read is aborted, the failure is recorded and the shared pointer is released before the
 * caller's deadline, so the next caller starts a fresh read instead of inheriting a corpse.
 *
 * It is a tenth of the budget, capped: small enough that the read keeps almost all of its time,
 * large enough that the wind-down (a few microtasks) always fits.
 */
const HALT_AUDIT_READ_WIND_DOWN_MS = 250;

/**
 * The budget the sweep actually uses.  Production always gets the constant above; a test can
 * shorten it so the bound can be proven without waiting eight seconds.
 */
function haltAuditBudgetMs(): number {
  const raw = process.env.HALT_AUDIT_OFF_LOOP_BUDGET_MS;
  if (raw != null && raw !== "" && process.env.VITEST) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return HALT_AUDIT_OFF_LOOP_TIMEOUT_MS;
}

/**
 * How many scopes the cache holds before its oldest entries are dropped.
 *
 * The cache is keyed by (user, connected account), so account churn grows it forever, and every
 * entry holds an audit row with its payload.  Bounded: the oldest entries go first.
 */
const HALT_AUDIT_CACHE_MAX_ENTRIES = 1_000;

/** One audit row as the off-loop worker returns it.  `audit_events.payload` is NOT NULL. */
const HaltAuditRowSchema = z.object({
  user_id: z.string(),
  connected_account_id: z.string().nullable(),
  kind: z.string(),
  created_at: z.string(),
  payload: z.string(),
  handed_over: z.number()
});

type HaltAuditRow = z.infer<typeof HaltAuditRowSchema>;

/**
 * The audit cache, the shared in-flight refresh and the pending-scope set live on `globalThis`,
 * not in module scope.
 *
 * Next.js loads this module into more than one bundle (the route bundle and the instrumentation
 * bundle are separate module graphs).  A module-local Map gives each copy its own cache, its own
 * in-flight refresh and its own pending set, so two copies disagree about what has been read: a
 * caller can wait for a refresh another copy is running, get no cache entry for its own scopes,
 * and read "no app-initiated halt" out of a scope the other copy had already read.  That
 * mislabels a drawdown breaker or a lost auto-pause as an owner stop -- and an owner stop is a
 * "deliberately idle" account, which suppresses the fleet-fully-dark page for that poll.
 */
declare global {
  var __socraticHaltAuditCache: Map<string, CachedHaltAuditRow> | undefined;

  /** The one shared off-loop refresh.  A refresh that is still running is REUSED, never
   *  duplicated: two refreshes at once are two reads of the same 19 GB table, and the second one
   *  used to overwrite this pointer while the first was still running -- so a third caller
   *  started a third read on top of two running ones. */
  var __socraticHaltAuditRefresh: HaltAuditRefreshState | undefined;

  var __socraticHaltAuditPendingScopes: Map<string, AuditScope> | undefined;

  /** The last failure of the off-loop read.  Shared like the cache, so two module copies agree
   *  on whether the read is currently failing and on how often it has failed. */
  var __socraticHaltAuditReadFailure: HaltAuditReadFailure | undefined;

  /** The generation each scope was last invalidated at.  A read that STARTED before the
   *  invalidation must not write its now-stale answer over the invalidation. */
  var __socraticHaltAuditInvalidatedAt: Map<string, number> | undefined;

  /** The monotonic invalidation counter.  A GENERATION, not a clock: two events in the same
   *  millisecond share a timestamp, and a timestamp comparison misses that equality -- so a read
   *  that started in the same millisecond as the invalidation wrote its pre-halt answer back
   *  over it.  A counter cannot collide. */
  var __socraticHaltAuditInvalidationGeneration: number | undefined;

  /** The highest generation whose per-scope stamp was pruned to keep the stamp map bounded.  A
   *  read that started before it cannot tell whether ITS scopes were among the pruned ones, so it
   *  does not cache a scope that has no stamp left. */
  var __socraticHaltAuditPrunedInvalidationGeneration: number | undefined;

  /** The sequence number of the newest refresh.  A refresh whose shared pointer was released
   *  (its runner ignored the abort) may still be running; it writes nothing once a newer refresh
   *  has started. */
  var __socraticHaltAuditRefreshSequence: number | undefined;

  /** Set by this module so the audit write path can drop a scope's cached row without importing
   *  this module: this module imports db.ts, and db.ts is what writes the audit rows. */
  var __socraticHaltAuditInvalidate:
    | ((userId: string, connectedAccountId: string | null) => void)
    | undefined;
}

/** The shared refresh's state.  `settled` says whether the refresh has finished, so a finished
 *  refresh is not reused: a caller that arrives in the microtask window between the refresh
 *  finishing and its pointer being cleared must start a NEW read, not reuse a dead one. */
type HaltAuditRefreshState = {
  /** The refresh's promise.  It never rejects: a failed read is recorded, not thrown at the
   *  caller. */
  promise: Promise<void>;
  settled: boolean;
};

/** One failed off-loop read, kept so the failure is visible instead of retried into the ground. */
type HaltAuditReadFailure = {
  /** When the last failure happened. */
  at: number;
  /** The last failure message. */
  message: string;
  /** How many failures this process has seen.  Cumulative: a success does not erase the history. */
  count: number;
  /** When the retry cooldown ends.  Cleared by a success. */
  coolingDownUntil?: number;
};

const haltAuditInvalidatedAt = (globalThis.__socraticHaltAuditInvalidatedAt ??= new Map<string, number>());

/** How the off-loop read is doing, for the health payload.  Counts only; no account identity. */
export type HaltCauseReadStatus = {
  /** Failed off-loop refreshes since the process started. */
  failures: number;
  /** ISO time of the last failure, if there was one. */
  lastFailureAt?: string;
  /**
   * The last failure message, truncated.
   *
   * NOT in the public payload: the public projection carries the COUNT only.  This text is an
   * arbitrary error message -- it can carry a database path or a fragment of SQL -- so it must
   * not be added to an external payload without an allowlist of the messages that may go out.
   */
  lastFailure?: string;
  /** True while the read is cooling down after a failure. */
  coolingDown: boolean;
};

export function haltCauseReadStatus(now: number = Date.now()): HaltCauseReadStatus {
  const failure = globalThis.__socraticHaltAuditReadFailure;
  if (!failure) return { failures: 0, coolingDown: false };
  return {
    failures: failure.count,
    lastFailureAt: new Date(failure.at).toISOString(),
    lastFailure: failure.message.slice(0, 200),
    coolingDown: haltAuditReadCoolingDown(now)
  };
}

function recordHaltAuditReadFailure(error: unknown): void {
  const previous = globalThis.__socraticHaltAuditReadFailure;
  const at = Date.now();
  globalThis.__socraticHaltAuditReadFailure = {
    at,
    message: error instanceof Error ? error.message : String(error),
    count: (previous?.count ?? 0) + 1,
    coolingDownUntil: at + HALT_AUDIT_FAILURE_COOLDOWN_MS
  };
}

/** A successful read ends the cooldown.  The failure count and the last failure stay. */
function clearHaltAuditReadFailure(): void {
  const previous = globalThis.__socraticHaltAuditReadFailure;
  if (!previous) return;
  globalThis.__socraticHaltAuditReadFailure = { ...previous, coolingDownUntil: undefined };
}

/**
 * True while a failed read is still cooling down.
 *
 * The cooldown is the retry backoff: a failing multi-second read is not re-run on every health
 * poll.  It does not decide whether the fleet-dark page fires -- see
 * `HALT_CAUSE_UNKNOWN_COUNTS_AS_IDLE` in trading-liveness.ts for that -- it only bounds how
 * often this read is attempted while it keeps failing.
 */
function haltAuditReadCoolingDown(now: number): boolean {
  const failure = globalThis.__socraticHaltAuditReadFailure;
  if (!failure || failure.coolingDownUntil === undefined) return false;
  return now < failure.coolingDownUntil;
}

const haltAuditCache = (globalThis.__socraticHaltAuditCache ??= new Map<string, CachedHaltAuditRow>());

/** Scopes a caller wants read that no refresh has covered yet.  Shared like the cache. */
function pendingHaltAuditScopes(): Map<string, AuditScope> {
  return (globalThis.__socraticHaltAuditPendingScopes ??= new Map<string, AuditScope>());
}

function haltAuditScopeKey(scope: AuditScope): string {
  return `${scope.userId}\u0000${scope.connectedAccountId ?? ""}`;
}

/**
 * How many scopes the pending queue holds before its oldest entries are dropped.
 *
 * The pending queue is keyed by (user, connected account), so it grows with the fleet and with
 * every scope a failed read had to requeue.  The cache has a cap; this queue had none, so a
 * fleet larger than the cache cap could leave the queue holding more scopes than the cache --
 * and every one of them is a scope whose cause is still UNKNOWN.
 */
const HALT_AUDIT_PENDING_MAX_ENTRIES = 1_000;

/**
 * Put scopes on the pending queue, keeping it bounded.
 *
 * The queue is the work list for the next refresh: a caller asks for its scopes, and a refresh
 * that is already running picks them up in its next round.
 */
function enqueuePendingHaltAuditScopes(scopes: readonly AuditScope[]): void {
  const pending = pendingHaltAuditScopes();
  for (const scope of scopes) {
    const key = haltAuditScopeKey(scope);
    if (!pending.has(key)) pending.set(key, scope);
  }
  prunePendingHaltAuditScopes();
}

/**
 * Drop the oldest entries when the pending queue is over its cap.
 *
 * A scope whose answer is already cached goes first: its answer is known, so re-reading it is
 * wasted work, while a scope with no cache entry is the one that needs the read.  A scope
 * dropped here is not read this round and reads as UNKNOWN, which is the honest answer.
 */
function prunePendingHaltAuditScopes(): void {
  const pending = pendingHaltAuditScopes();
  if (pending.size <= HALT_AUDIT_PENDING_MAX_ENTRIES) return;
  const overflow = pending.size - HALT_AUDIT_PENDING_MAX_ENTRIES;
  const drop = new Set<string>();
  for (const key of pending.keys()) {
    if (drop.size >= overflow) break;
    if (hasFreshHaltAuditAnswer(key)) drop.add(key);
  }
  if (drop.size < overflow) {
    for (const key of pending.keys()) {
      if (drop.size >= overflow) break;
      drop.add(key);
    }
  }
  for (const key of drop) pending.delete(key);
}

/** True when the scope has a cached answer that no later audit write has made stale. */
function hasFreshHaltAuditAnswer(key: string): boolean {
  const hit = haltAuditCache.get(key);
  return hit !== undefined && !hit.dirty;
}

/**
 * Mark one scope's cached audit row stale.
 *
 * The cache holds the answer to "did the APP halt this account, and has it stayed halted?".  A
 * new app-initiated halt row -- the drawdown breaker or a broker auto-halt -- changes that
 * answer, and the app writes that row itself, in this process.  So the write path tells the
 * cache, and the next read re-reads the scope instead of serving the old answer for up to a
 * cache TTL: without this, a breaker halt that lands just after a read is classified as "no
 * app-initiated halt" -- an owner stop -- for up to a minute, and an owner stop counts as a
 * deliberately idle account.
 *
 * The row is MARKED stale, not deleted.  It is the last confirmed answer, and a forced re-read can
 * fail to land (the failure cooldown, the budget, a read error).  Deleting it turned a CONFIRMED
 * app halt into an unknown cause in that window -- and an unknown cause counts toward idleness
 * for the fleet-dark page, so a confirmed breaker could stop paging.  The stale row is re-read
 * on the next poll, and until a re-read lands `classifyFromAudit` keeps reporting a confirmed app
 * halt from it; a stale "no app-initiated halt" is NOT kept, because the write that made it
 * stale may be the halt itself, so that scope reads as unknown.
 *
 * The invalidation carries a GENERATION, so a read that was already running when the halt was
 * written cannot write its pre-halt answer back over the invalidation.  A timestamp could not do
 * that: the halt and the read can land in the same millisecond, and `invalidatedAt >
 * readStartedAt` is false for two equal timestamps, so the read wrote its pre-halt answer back
 * over the invalidation and the scope read as "stopped" -- a confirmed owner stop -- until the
 * cache TTL expired.
 */
export function invalidateHaltAuditCache(userId: string, connectedAccountId: string | null): void {
  const key = haltAuditScopeKey({ userId, connectedAccountId });
  const hit = haltAuditCache.get(key);
  if (hit) hit.dirty = true;
  haltAuditInvalidatedAt.set(key, nextHaltAuditInvalidationGeneration());
  // The invalidation stamps are bounded here too: they used to be pruned only by a successful
  // refresh, so a database that kept failing (no successful refresh) let them grow with every
  // new app-initiated halt.
  pruneHaltAuditInvalidations();
}

/** The generation the next invalidation takes.  Monotonic, and shared like the cache. */
function nextHaltAuditInvalidationGeneration(): number {
  const next = (globalThis.__socraticHaltAuditInvalidationGeneration ?? 0) + 1;
  globalThis.__socraticHaltAuditInvalidationGeneration = next;
  return next;
}

/** The generation the most recent invalidation took.  A read remembers this when it starts. */
function currentHaltAuditInvalidationGeneration(): number {
  return globalThis.__socraticHaltAuditInvalidationGeneration ?? 0;
}

/**
 * Keep the invalidation stamps bounded.  The oldest go first, and an entry whose cache row is
 * gone cannot race anything.
 */
function pruneHaltAuditInvalidations(): void {
  if (haltAuditInvalidatedAt.size <= HALT_AUDIT_CACHE_MAX_ENTRIES) return;
  const oldest = [...haltAuditInvalidatedAt.entries()].sort((a, b) => a[1] - b[1]);
  let pruned = globalThis.__socraticHaltAuditPrunedInvalidationGeneration ?? 0;
  for (const [key, generation] of oldest.slice(0, haltAuditInvalidatedAt.size - HALT_AUDIT_CACHE_MAX_ENTRIES)) {
    haltAuditInvalidatedAt.delete(key);
    pruned = Math.max(pruned, generation);
  }
  // Remember how far the pruning reached.  A stamp that is gone can no longer stop an in-flight
  // read from writing its pre-invalidation answer back, so `invalidatedSince` falls back to this.
  globalThis.__socraticHaltAuditPrunedInvalidationGeneration = pruned;
}

/**
 * True when the scope may have been invalidated after a read that started at
 * `readStartedGeneration`, so that read's answer must not be cached.
 *
 * The per-scope stamp answers that exactly while it exists.  Once the stamp map is pruned, a scope
 * without a stamp may be one whose stamp was dropped, so any pruning past the read's start makes
 * the answer unsafe to cache.  That is conservative -- a read that overlaps a prune caches nothing
 * for un-stamped scopes, and the next read caches them -- and it keeps the map bounded.
 */
function invalidatedSince(key: string, readStartedGeneration: number): boolean {
  const stamp = haltAuditInvalidatedAt.get(key);
  if (stamp !== undefined) return stamp > readStartedGeneration;
  return (globalThis.__socraticHaltAuditPrunedInvalidationGeneration ?? 0) > readStartedGeneration;
}

// Registered on `globalThis` so the audit write path (db.ts) can call it without importing this
// module: this module imports db.ts, and db.ts is what writes the audit rows.
globalThis.__socraticHaltAuditInvalidate = invalidateHaltAuditCache;

/** One account scope the halt-cause sweep reads: a user and the connected account. */
export type HaltAuditScope = { userId: string; connectedAccountId: string | null };

/** One chunk of the batched sweep: its statement and the scopes it covers. */
type HaltAuditChunk = {
  sql: string;
  params: string[];
  scopes: AuditScope[];
};

/**
 * The batched sweep as one statement per chunk of accounts, so a statement stays under SQLite's
 * portable 999-variable ceiling.  Same SQL the serving connection runs.
 *
 * Each chunk carries the scopes it covers, so a read knows which scopes a completed chunk
 * answered and which ones it never reached.
 */
function haltAuditChunks(accounts: readonly AuditScope[]): HaltAuditChunk[] {
  return chunkItems(accounts, HALT_AUDIT_ACCOUNT_CHUNK).map((chunk) => {
    const branches = chunk.map(latestHaltBranch);
    return {
      sql: branches.map((branch) => branch.sql).join("\nUNION ALL\n"),
      params: branches.flatMap((branch) => branch.params),
      scopes: chunk
    };
  });
}

/**
 * The statements the sweep runs, without the scope bookkeeping.
 *
 * Exported so a test can assert the statement's shape and query plan without running it on the
 * serving connection -- which is the point of the off-loop read.
 */
export function buildHaltAuditStatements(accounts: readonly HaltAuditScope[]): { sql: string; params: string[] }[] {
  return haltAuditChunks(accounts).map((chunk) => ({ sql: chunk.sql, params: chunk.params }));
}

/**
 * The off-loop runner the sweep uses.  Production runs `sqliteAllOffLoop`; a test replaces it
 * with a stand-in, which is how the read's bound is proven without a slow database.
 */
type HaltAuditRunner = (
  sql: string,
  params: readonly unknown[],
  dbPath: string,
  rowSchema: z.ZodType<HaltAuditRow>,
  options: { timeoutMs: number; signal: AbortSignal }
) => Promise<HaltAuditRow[]>;

/**
 * The production runner, typed against `HaltAuditRunner` without a cast.
 *
 * `sqliteAllOffLoop` takes `readonly unknown[]` binds and a `z.ZodType<T>` row schema, which is
 * exactly this runner's shape, so the wrapper keeps the Zod type instead of throwing it away
 * behind `as unknown as`.
 */
const sqliteAllOffLoopHaltAuditRunner: HaltAuditRunner = (sql, params, dbPath, rowSchema, options) =>
  sqliteAllOffLoop(sql, params, dbPath, rowSchema, options);

let haltAuditRunner: HaltAuditRunner = sqliteAllOffLoopHaltAuditRunner;

/**
 * Test-only: clear the off-loop read's failure bookkeeping, so a test that makes the read fail
 * does not leave a cooldown behind for the next one.
 */
export function __resetHaltAuditReadFailureForTests(): void {
  globalThis.__socraticHaltAuditReadFailure = undefined;
}

/**
 * Test-only: clear the shared read state, so one test's read cannot answer another test's
 * question.
 *
 * The shared refresh, the pending scopes and the cache are process-wide on purpose -- that is
 * what makes two callers share one read.  In a test suite that sharing leaks between cases: a
 * test that leaves a refresh running (a runner that never settles) hands the NEXT test a refresh
 * that is already dying, and the next test then waits on it instead of reading its own rows.
 * The reset is what keeps the cases independent.
 */
export function __resetHaltAuditStateForTests(): void {
  const refresh = globalThis.__socraticHaltAuditRefresh;
  if (refresh) {
    // Mark it settled so no later caller reuses it.  The refresh itself may still be parked on a
    // runner that never settles; nothing waits on it after this.
    refresh.settled = true;
    if (globalThis.__socraticHaltAuditRefresh === refresh) {
      globalThis.__socraticHaltAuditRefresh = undefined;
    }
  }
  pendingHaltAuditScopes().clear();
  haltAuditCache.clear();
  haltAuditInvalidatedAt.clear();
  globalThis.__socraticHaltAuditInvalidationGeneration = 0;
  globalThis.__socraticHaltAuditPrunedInvalidationGeneration = 0;
  // Advance, never reset: a refresh a previous case left running must see itself superseded.
  globalThis.__socraticHaltAuditRefreshSequence = (globalThis.__socraticHaltAuditRefreshSequence ?? 0) + 1;
}

/**
 * Test-only: replace the off-loop runner.  Returns the runner that was in place, so the caller
 * can put it back.
 */
export function __setHaltAuditRunnerForTests(runner: HaltAuditRunner | null): HaltAuditRunner {
  const previous = haltAuditRunner;
  haltAuditRunner = runner ?? sqliteAllOffLoopHaltAuditRunner;
  return previous;
}

/**
 * Test-only: how many scopes are waiting on the next refresh.
 *
 * The queue is bounded, and this is how a test proves it: a failed read requeues the scopes it
 * did not cover, and a fleet larger than the cap must not leave the queue growing.
 */
export function __haltAuditPendingScopeCountForTests(): number {
  return pendingHaltAuditScopes().size;
}

/**
 * What one off-loop read produced.
 *
 * `covered` is the set of scope keys whose chunk COMPLETED.  A covered scope with no row is a
 * CONFIRMED "no app-initiated halt" -- the statement ran and found nothing.  A scope that is not
 * covered was never read, so its cause is unknown.
 */
type HaltAuditReadOutcome = {
  /** The audit rows the read found, keyed by scope. */
  rows: Map<string, HaltAuditRow>;
  /** The scope keys whose chunk completed. */
  covered: Set<string>;
  /** The failure that stopped the read early, if any. */
  error?: unknown;
};

/**
 * The same statement the serving connection runs, executed on an off-loop worker thread
 * (`src/lib/rag/sqlite-all-offloop.ts`).  better-sqlite3 is synchronous, so on the serving
 * connection this read pinned the event loop for the whole statement -- and the health route
 * runs it, so the health probe could not answer until the read finished.
 *
 * `budgetMs` covers the WHOLE read: the queue wait for a worker, the statement, and every chunk
 * of it.
 *
 * The chunks are read one at a time and each one that finishes is recorded as covered, so a
 * failure in a later chunk does not throw away the chunks that already succeeded.  The read used
 * to discard the completed chunks and requeue the WHOLE batch on any failure, which turned one
 * bad chunk into a re-read of every chunk.
 */
async function readHaltAuditRowsOffLoop(
  scopes: readonly AuditScope[],
  budgetMs: number
): Promise<HaltAuditReadOutcome> {
  const rows = new Map<string, HaltAuditRow>();
  const covered = new Set<string>();
  const chunks = haltAuditChunks(scopes);
  if (chunks.length === 0) return { rows, covered };
  const dbPath = databasePath();
  // ONE deadline for the whole read: the queue wait for a worker, the statement, and every chunk
  // of it.  `sqliteAllOffLoop` without a signal arms a queue ceiling of `timeoutMs + 15 s`, so a
  // queued read could hold its caller for 23 s per chunk -- past the 12 s health probe and the
  // 14 s Docker HEALTHCHECK, which is the outage this fix exists to remove.  One AbortSignal
  // bounds the wait for every chunk instead, and the signal suppresses that queue ceiling.
  //
  // The controller is armed BEFORE the first chunk is queued, on purpose: the budget is an
  // end-to-end deadline for the whole read, so the queue wait counts against it.  Arming it
  // after the worker slot is acquired would let a read that waited 20 s for a slot then run its
  // statement for another 8 s -- 28 s, past both probe budgets.
  //
  // The read is aborted a slice of the budget BEFORE the caller's deadline, so it winds down
  // inside the caller's budget: the caller answers with the read already finished, and the next
  // caller does not inherit a refresh that is still dying.
  const windDownMs = Math.min(HALT_AUDIT_READ_WIND_DOWN_MS, Math.floor(budgetMs * 0.1));
  const readMs = Math.max(1, budgetMs - windDownMs);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), readMs);
  try {
    for (const chunk of chunks) {
      try {
        const chunkRows = await haltAuditRunner(chunk.sql, chunk.params, dbPath, HaltAuditRowSchema, {
          timeoutMs: readMs,
          signal: controller.signal
        });
        for (const row of chunkRows) {
          rows.set(haltAuditScopeKey({ userId: row.user_id, connectedAccountId: row.connected_account_id }), row);
        }
        for (const scope of chunk.scopes) covered.add(haltAuditScopeKey(scope));
      } catch (error) {
        // Stop at the first failed chunk.  The chunks that already completed stay covered, and
        // the scopes of this chunk and the ones after it are requeued by the caller.
        return { rows, covered, error };
      }
    }
  } finally {
    clearTimeout(timer);
  }
  return { rows, covered };
}

/**
 * Await `promise`, but give up at `deadline`.  The promise keeps running in the background: it is
 * an off-loop read with its own budget, and the caller only needs to stop waiting for it.
 */
async function untilDeadline(promise: Promise<void>, deadline: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
  });
  try {
    await Promise.race([promise, guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Keep the cache bounded.  It is keyed by (user, connected account), so account churn grows it
 * forever, and every entry holds an audit row with its payload.
 */
function pruneHaltAuditCache(): void {
  if (haltAuditCache.size > HALT_AUDIT_CACHE_MAX_ENTRIES) {
    const oldest = [...haltAuditCache.entries()].sort((a, b) => a[1].at - b[1].at);
    for (const [key] of oldest.slice(0, haltAuditCache.size - HALT_AUDIT_CACHE_MAX_ENTRIES)) {
      haltAuditCache.delete(key);
    }
  }
  // The invalidation stamps are bounded the same way: an entry whose cache row is gone cannot
  // race anything.
  pruneHaltAuditInvalidations();
}

/**
 * One off-loop refresh.
 *
 * It reads the pending scopes in rounds: a caller that arrives while a round is running adds its
 * scopes to the pending set, and the next round picks them up.  The whole refresh -- every round,
 * every chunk -- is bounded by ONE deadline.  The health route awaits this, and a health probe
 * that misses its deadline restarts the container, which re-runs the boot sweep.
 */
async function runHaltAuditRefresh(budgetMs: number, sequence: number): Promise<void> {
  const deadline = Date.now() + Math.max(0, budgetMs);
  // A refresh whose pointer was released at its deadline (its runner ignored the abort) can still
  // be running when the next caller starts a newer one.  From then on the older one changes no
  // shared state: it does not take scopes off the pending queue, write the cache, or record a
  // failure -- otherwise its late, older answer could overwrite the newer refresh's answer and be
  // served as fresh for a whole TTL.
  const superseded = () => globalThis.__socraticHaltAuditRefreshSequence !== sequence;
  try {
    while (!superseded() && pendingHaltAuditScopes().size > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const batch = [...pendingHaltAuditScopes().values()];
      pendingHaltAuditScopes().clear();
      // The generation this read starts at: an invalidation that lands after this point must win
      // over whatever this read finds, so the read's answer is not written over it.  A
      // GENERATION, not a clock -- two events in the same millisecond share a timestamp, and a
      // timestamp comparison misses that equality.
      const readStartedGeneration = currentHaltAuditInvalidationGeneration();
      let outcome: HaltAuditReadOutcome;
      try {
        outcome = await readHaltAuditRowsOffLoop(batch, remaining);
      } catch (error) {
        // The read reports its own failures in the outcome; this is the path for an error thrown
        // around the read itself (a bad database path, for instance).
        outcome = { rows: new Map(), covered: new Set(), error };
      }
      if (superseded()) {
        // A newer refresh owns the shared state now.  Hand back the scopes this read took that
        // still have no fresh answer, so the newer refresh or the next caller reads them, and
        // drop this read's answer.
        enqueuePendingHaltAuditScopes(batch.filter((scope) => !hasFreshHaltAuditAnswer(haltAuditScopeKey(scope))));
        return;
      }
      if (outcome.error === undefined) clearHaltAuditReadFailure();
      const at = Date.now();
      // Cache what the read actually covered.  A chunk that completed is a confirmed answer --
      // including "no app-initiated halt" -- so a later chunk's failure does not throw away the
      // chunks that already succeeded.
      for (const scope of batch) {
        const key = haltAuditScopeKey(scope);
        if (!outcome.covered.has(key)) continue;
        if (invalidatedSince(key, readStartedGeneration)) {
          // The scope was invalidated while this read was running: this answer predates the
          // invalidation, so it is not cached.  The next read sees the newer row.
          continue;
        }
        haltAuditCache.set(key, { row: outcome.rows.get(key) ?? null, at });
      }
      if (outcome.error !== undefined) {
        // Put back ONLY the scopes this read did not cover, so the next caller retries them.
        // Requeuing the whole batch used to throw away the chunks that had already succeeded.
        const uncovered = batch.filter((scope) => !outcome.covered.has(haltAuditScopeKey(scope)));
        enqueuePendingHaltAuditScopes(uncovered);
        // The failure is counted and reported, not retried into the ground: the cooldown keeps
        // the next caller off this read for a while (see HALT_AUDIT_FAILURE_COOLDOWN_MS).
        recordHaltAuditReadFailure(outcome.error);
        break;
      }
      pruneHaltAuditCache();
    }
  } finally {
    pruneHaltAuditCache();
  }
}

/**
 * Start the shared refresh, or reuse the one that is already running.
 *
 * The check and the publish happen in the SAME synchronous turn, so two callers can never both
 * start a refresh: the second one sees the first one's state and reuses it.  Two refreshes at
 * once are two reads of the same 19 GB table.
 *
 * This is what the fallback path needs.  It used to call the starter directly, so two callers
 * that were both waiting on a first refresh that had just failed each started their OWN
 * fallback: the second one overwrote the shared pointer while the first was still running, and
 * the pointer was then cleared while a refresh was still active -- so a third caller started a
 * third read on top of two running ones.
 */
function startHaltAuditRefresh(budgetMs: number): Promise<void> {
  const existing = globalThis.__socraticHaltAuditRefresh;
  if (existing && !existing.settled) return existing.promise;
  let settle: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const state: HaltAuditRefreshState = { promise, settled: false };
  // Published BEFORE the refresh starts, so a caller that arrives in the same turn reuses it.
  globalThis.__socraticHaltAuditRefresh = state;
  const sequence = (globalThis.__socraticHaltAuditRefreshSequence ?? 0) + 1;
  globalThis.__socraticHaltAuditRefreshSequence = sequence;
  // `finish` runs only after `releaseTimer` below is assigned: from the timer itself, or from the
  // refresh's promise, which settles no earlier than the next microtask.
  const finish = () => {
    state.settled = true;
    clearTimeout(releaseTimer);
    if (globalThis.__socraticHaltAuditRefresh === state) {
      globalThis.__socraticHaltAuditRefresh = undefined;
    }
    settle();
  };
  // A refresh that never settles -- a runner that ignores its abort -- must not hold the shared
  // pointer forever: while it held it, every later caller reused a dead refresh and no scope
  // was ever read again, so the whole fleet's halt causes stayed UNKNOWN.  The pointer is
  // released at the refresh's own deadline, so the next caller starts a fresh read.  The released
  // refresh may still be running; its sequence number keeps it from writing over the newer one.
  const releaseTimer = setTimeout(finish, budgetMs + HALT_AUDIT_REFRESH_RELEASE_GRACE_MS);
  releaseTimer.unref?.();
  // The refresh never rejects: a failed read is recorded and reported, not thrown at the caller.
  void runHaltAuditRefresh(budgetMs, sequence).then(finish, finish);
  return promise;
}

/**
 * Refresh the cached audit rows for the given scopes.
 *
 * One refresh runs at a time.  A caller that arrives while one is running waits for it and then
 * refreshes whatever of ITS OWN scopes is still missing: the shared refresh may have covered
 * different scopes, and a scope with no cache entry reads as "no app-initiated halt", which
 * mislabels a drawdown breaker or a lost auto-pause as an owner stop -- and an owner stop counts
 * as a deliberately idle account, which suppresses the fleet-fully-dark page for that poll.
 *
 * The wait is bounded by the caller's deadline even if the read itself ignores the abort: a
 * runner that never settles must not hold a health probe past its budget, because a probe that
 * misses its deadline restarts the container, which re-runs the boot sweep.
 */
async function refreshHaltAuditRows(scopes: readonly AuditScope[]): Promise<void> {
  if (scopes.length === 0) return;
  const deadline = Date.now() + haltAuditBudgetMs();
  // A read that just failed is not re-run on every health poll: it is a multi-second scan of a
  // 19 GB table, and retrying it while the database is degraded repeats the read this fix exists
  // to stop happening.  The cooldown bounds the retry rate; the failure is reported instead.
  //
  // Checked BEFORE this caller queues anything, so the cooldown path leaves the shared pending
  // queue exactly as it found it.  It used to queue and then clear the WHOLE queue -- including
  // the scopes other callers had queued for a refresh that was already running and the scopes a
  // failed read had requeued for retry -- so those scopes went unread and read as unknown.
  if (haltAuditReadCoolingDown(Date.now())) return;
  enqueuePendingHaltAuditScopes(scopes);
  await untilDeadline(startHaltAuditRefresh(deadline - Date.now()), deadline);
  // Whatever of THIS caller's scopes the shared refresh did not cover gets its own read, with
  // whatever budget is left.  Out of budget, the cache stays as it is: a stale halt cause is
  // display-only, and a missed probe is an outage.
  const missing = scopes.filter((scope) => !hasFreshHaltAuditAnswer(haltAuditScopeKey(scope)));
  if (missing.length === 0) return;
  const remaining = deadline - Date.now();
  if (remaining <= 0) return;
  if (haltAuditReadCoolingDown(Date.now())) return;
  // The missing scopes go back on the pending queue first: a refresh whose pending set is empty
  // has nothing to read, so the fallback used to be a no-op that left the scope unknown.
  enqueuePendingHaltAuditScopes(missing);
  await untilDeadline(startHaltAuditRefresh(remaining), deadline);
}

/**
 * For a halted account with no live marker and no boot receipt: did the APP halt it, and has it
 * stayed halted since?  Looks at the latest app-initiated halt in the audit trail (the drawdown
 * breaker with hard action "halted", or a broker-health auto-halt), then for anything after it that
 * re-armed the account or handed the halt to someone else.  Any such later row means the app can no
 * longer say who holds the halt, so this returns undefined.  Display-only; never throws.
 */
function lastAppHaltFromAudit(userId: string, connectedAccountId: string | undefined): AppHaltFromAudit | undefined {
  try {
    const halt = latestAppHalts(getDb(), [{ userId, connectedAccountId: connectedAccountId ?? null }])[0];
    if (!halt || halt.handed_over) return undefined;
    let reason = "";
    try {
      const payload = JSON.parse(halt.payload) as { reason?: unknown };
      if (typeof payload.reason === "string") reason = payload.reason;
    } catch {
      /* reason stays empty */
    }
    return { kind: halt.kind === "policy_violation_drawdown" ? "breaker" : "auto_pause_lost", at: halt.created_at, reason };
  } catch {
    return undefined;
  }
}

/**
 * The run-failure watchdog's halt marker, read without importing
 * run-failure-watchdog.ts (which pulls in db-health's `server-only`; the key
 * is duplicated as a literal for the same reason broker-health.ts documents).
 * Key format mirrors runFailureHaltMarkerKey() there.
 */
interface RunFailureHaltMarkerRead {
  since: string;
  reason?: string;
  consecutiveFailures?: number;
}

function getRunFailureHaltMarkerRead(
  userId: string,
  connectedAccountId: string | undefined
): RunFailureHaltMarkerRead | null {
  if (!connectedAccountId) return null;
  try {
    const raw = getInternalSetting<RunFailureHaltMarkerRead>(
      `runFailureHaltMarker:${userId}:${connectedAccountId}`
    );
    if (!raw || typeof raw !== "object" || typeof raw.since !== "string") return null;
    return raw;
  } catch {
    return null;
  }
}

/**
 * Owner-readable cause of a `halted` account, or null for any other state.  Precedence: a live
 * broker auto-pause marker (the app owns the halt and will lift it), then a boot receipt (a restart
 * stopped it and nothing will start it by itself), then an app halt read from the audit trail (the
 * drawdown breaker, or an auto-pause whose resume record is gone), else "no record".  Summaries
 * separate sentences with two spaces (the console renders them with SENTENCE_GAP).
 */
export function describeAutonomyHaltCause(input: {
  userId: string;
  connectedAccountId?: string;
  accountNumber?: string;
  systemState: SystemState;
}): AutonomyHaltCause | null {
  if (input.systemState !== "halted") return null;
  const scope = brokerPauseAccountScope(input.connectedAccountId, input.accountNumber);

  const marker = getBrokerPlacementPauseMarker(input.userId, scope);
  if (marker) {
    const reason = trimReason(marker.reason) || "the broker could not take orders";
    const autoResumeOnBootNow = effectiveAutoResumeOnBoot(input.userId);
    const lastCheck = marker.lastProbeAt
      ? `Last broker check ${centralTime(marker.lastProbeAt)} still failed: ${trimReason(marker.lastProbeReason) || "no reason given"}.  `
      : "No failed broker check recorded since the pause.  ";
    const restartCaveat = autoResumeOnBootNow
      ? ""
      : "Auto-resume on boot is off, so a restart or deploy before the broker recovers ends this auto-pause and leaves the account stopped.  ";
    return {
      kind: "broker_auto_pause",
      resumesOnItsOwn: true,
      since: marker.since,
      reason: marker.reason,
      autoResumeOnBootNow,
      ...(marker.lastProbeAt ? { lastProbeAt: marker.lastProbeAt } : {}),
      ...(marker.lastProbeReason ? { lastProbeReason: marker.lastProbeReason } : {}),
      summary:
        `Paused by the app since ${centralTime(marker.since)}: ${reason}.  ` +
        "It starts again by itself on the first healthy broker check.  " +
        lastCheck +
        restartCaveat +
        "Start Agent resumes it now."
    };
  }

  // Self-healing 2026-09-30: the run-failure watchdog auto-halted this account
  // after a long streak of consecutive strategy-run failures.  Unlike a broker
  // auto-pause it never lifts by itself — the owner re-arms from the console.
  const runFailureMarker = getRunFailureHaltMarkerRead(input.userId, input.connectedAccountId);
  if (runFailureMarker) {
    const reason =
      trimReason(runFailureMarker.reason) ||
      "its strategy runs kept failing";
    const failures = runFailureMarker.consecutiveFailures;
    return {
      kind: "run_failure_halt",
      resumesOnItsOwn: false,
      since: runFailureMarker.since,
      reason: runFailureMarker.reason ?? reason,
      consecutiveFailures: typeof failures === "number" ? failures : 0,
      summary:
        `Auto-halted by the app since ${centralTime(runFailureMarker.since)}: ${reason}.  ` +
        "It will not start by itself.  Start Agent resumes it when the underlying failure is fixed."
    };
  }

  const receipt = getBootHaltReceipt(input.userId, scope);
  if (receipt) {
    const autoResumeOnBootNow = effectiveAutoResumeOnBoot(input.userId);
    const setting = autoResumeOnBootNow
      ? "Auto-resume on boot is on now, so later restarts keep running accounts running."
      : "Auto-resume on boot is off, so every restart or deploy stops running accounts.  Turn it on in Settings (After a restart) to keep them running through restarts.";
    const lead =
      receipt.from === "broker_auto_pause"
        ? `The app had paused this account for a broker problem (${trimReason(receipt.autoPauseReason) || "broker check failed"}).  ` +
          `The restart at ${centralTime(receipt.at)} ended that auto-pause, so it will not start by itself when the broker recovers.`
        : `Stopped by the restart at ${centralTime(receipt.at)}.  It will not start by itself.`;
    return {
      kind: "restart",
      resumesOnItsOwn: false,
      at: receipt.at,
      from: receipt.from,
      ...(receipt.autoPauseReason ? { autoPauseReason: receipt.autoPauseReason } : {}),
      autoResumeOnBootNow,
      summary: `${lead}  Start Agent re-arms it.  ${setting}`
    };
  }

  const appHalt = lastAppHaltFromAudit(input.userId, input.connectedAccountId);
  if (appHalt?.kind === "breaker") {
    return {
      kind: "breaker",
      resumesOnItsOwn: false,
      at: appHalt.at,
      reason: appHalt.reason,
      summary:
        `The drawdown circuit breaker stopped this account at ${centralTime(appHalt.at)}: ${trimReason(appHalt.reason) || "loss limit breached"}.  ` +
        "It will not start by itself.  Start Agent re-arms it."
    };
  }
  if (appHalt?.kind === "auto_pause_lost") {
    return {
      kind: "auto_pause_lost",
      resumesOnItsOwn: false,
      at: appHalt.at,
      reason: appHalt.reason,
      summary:
        `The app paused this account for a broker problem at ${centralTime(appHalt.at)} (${trimReason(appHalt.reason) || "broker check failed"}), ` +
        "but the record that lets it start again by itself is gone.  It will not start by itself.  Start Agent re-arms it."
    };
  }

  return {
    kind: "stopped",
    resumesOnItsOwn: false,
    summary:
      "No automatic pause is holding this account, and the app did not record who or what stopped it.  " +
      "It stays stopped until someone starts it."
  };
}

/** One halted account to classify.  `accountId` is the connected-account id. */
export type HaltCauseAccountRef = {
  userId: string;
  accountId: string;
  accountNumber?: string;
};

const RUN_FAILURE_HALT_PREFIX = "runFailureHaltMarker";
const BROKER_PAUSE_PREFIX = "broker:placement-paused";

function settingKeysFor(account: HaltCauseAccountRef): { broker: string; run: string; boot: string } {
  const scope = brokerPauseAccountScope(account.accountId, account.accountNumber);
  return {
    broker: `${BROKER_PAUSE_PREFIX}:${account.userId}:${scope}`,
    run: `${RUN_FAILURE_HALT_PREFIX}:${account.userId}:${account.accountId}`,
    boot: receiptKey(account.userId, scope)
  };
}

type SettingRead = { state: "missing" } | { state: "bad" } | { state: "value"; value: unknown };

function readSettingValue(raw: string | undefined): SettingRead {
  if (raw === undefined) return { state: "missing" };
  try {
    return { state: "value", value: JSON.parse(raw) };
  } catch {
    return { state: "bad" };
  }
}

function markerHit(read: SettingRead, accept: (value: unknown) => boolean): "hit" | "miss" | "bad" {
  if (read.state === "bad") return "bad";
  if (read.state === "missing") return "miss";
  return accept(read.value) ? "hit" : "miss";
}

/** Same shape check as `getBrokerPlacementPauseMarker`. */
function isBrokerPauseMarker(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const marker = value as { since?: unknown; autoResume?: unknown };
  return typeof marker.since === "string" && marker.autoResume === true;
}

/** Same shape check as `getRunFailureHaltMarkerRead`. */
function isRunFailureMarker(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  return typeof (value as { since?: unknown }).since === "string";
}

/** Same shape check as `getBootHaltReceipt`. */
function isBootReceipt(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const receipt = value as { at?: unknown; from?: unknown };
  return typeof receipt.at === "string" && (receipt.from === "active" || receipt.from === "broker_auto_pause");
}

function loadSettingValues(db: ReturnType<typeof getDb>, keys: readonly string[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const chunk of chunkItems(keys, HALT_SETTINGS_KEY_CHUNK)) {
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db
      .prepare(`SELECT key, value FROM settings WHERE key IN (${placeholders})`)
      .all(...chunk) as { key: string; value: string }[];
    for (const row of rows) found.set(row.key, row.value);
  }
  return found;
}

function classifyFromMarkers(
  db: ReturnType<typeof getDb>,
  accounts: readonly HaltCauseAccountRef[],
  out: Map<string, AutonomyHaltCause["kind"]>
): HaltCauseAccountRef[] {
  const keyed = accounts.map((account) => ({ account, keys: settingKeysFor(account) }));
  const values = loadSettingValues(
    db,
    keyed.flatMap((entry) => [entry.keys.broker, entry.keys.run, entry.keys.boot])
  );
  const unmarked: HaltCauseAccountRef[] = [];
  for (const { account, keys } of keyed) {
    const mapKey = `${account.userId}:${account.accountId}`;
    const broker = markerHit(readSettingValue(values.get(keys.broker)), isBrokerPauseMarker);
    if (broker === "bad") continue;
    if (broker === "hit") {
      out.set(mapKey, "broker_auto_pause");
      continue;
    }
    const run = markerHit(readSettingValue(values.get(keys.run)), isRunFailureMarker);
    if (run === "bad") continue;
    if (run === "hit") {
      out.set(mapKey, "run_failure_halt");
      continue;
    }
    const boot = markerHit(readSettingValue(values.get(keys.boot)), isBootReceipt);
    if (boot === "bad") continue;
    if (boot === "hit") {
      out.set(mapKey, "restart");
      continue;
    }
    unmarked.push(account);
  }
  return unmarked;
}

async function classifyFromAudit(
  accounts: readonly HaltCauseAccountRef[],
  out: Map<string, AutonomyHaltCause["kind"]>,
  unknown: Set<string>
): Promise<void> {
  const scopes = accounts.map((account) => ({ userId: account.userId, connectedAccountId: account.accountId }));
  const now = Date.now();
  const stale = scopes.filter((scope) => {
    const hit = haltAuditCache.get(haltAuditScopeKey(scope));
    return !hit || hit.dirty === true || now - hit.at > HALT_AUDIT_CACHE_TTL_MS;
  });
  // Off the event loop: this read held the serving loop for 5.4 s in production.
  if (stale.length > 0) await refreshHaltAuditRows(stale);
  const byKey = new Map<string, LatestAppHaltRow>();
  for (const scope of scopes) {
    const key = haltAuditScopeKey(scope);
    const mapKey = `${scope.userId}:${scope.connectedAccountId}`;
    const hit = haltAuditCache.get(key);
    if (!hit) {
      // No read has ever confirmed this scope: the cause is UNKNOWN, not "stopped".
      unknown.add(mapKey);
      continue;
    }
    if (now - hit.at > HALT_AUDIT_CACHE_TTL_MS) {
      // The cached answer is older than the TTL and the refresh did not replace it, so the cause
      // is unknown right now.  A stale answer that is still inside its TTL stays usable: it is a
      // confirmed read, just an old one.
      unknown.add(mapKey);
      continue;
    }
    if (hit.dirty && (!hit.row || hit.row.handed_over)) {
      // An audit write made this answer stale and the re-read has not landed.  The stale answer
      // says "no app halt" (or "handed over"), and the write that made it stale may be the very
      // halt it is missing, so the cause is unknown right now.  A stale CONFIRMED app halt falls
      // through and is still reported: the last confirmed cause stays usable until a re-read
      // replaces it, so a confirmed breaker never decays into idleness.
      unknown.add(mapKey);
      continue;
    }
    // A confirmed read that found no app-initiated halt: the cause IS "stopped", and the account
    // is deliberately idle.  Only a read that could not happen is unknown.
    if (!hit.row) continue;
    if (hit.row.connected_account_id == null) continue;
    byKey.set(`${hit.row.user_id}:${hit.row.connected_account_id}`, hit.row);
  }
  for (const account of accounts) {
    const mapKey = `${account.userId}:${account.accountId}`;
    if (unknown.has(mapKey)) continue;
    const row = byKey.get(mapKey);
    if (!row || row.handed_over) continue;
    out.set(
      mapKey,
      row.kind === "policy_violation_drawdown" ? "breaker" : "auto_pause_lost"
    );
  }
}

/**
 * Halt-cause kind for many halted accounts.  One `settings` read covers the three markers
 * (`broker:placement-paused`, `runFailureHaltMarker`, `autonomy:boot-halted`) and one
 * `audit_events` read covers a drawdown breaker or a lost auto-pause.  The kind matches
 * `describeAutonomyHaltCause` for a halted account.  A bad marker payload or a failed read
 * stays `stopped`, the same bucket the health poll uses when a per-account lookup throws.
 *
 * The `audit_events` read runs OFF the serving event loop (a worker thread) and is cached for
 * `HALT_AUDIT_CACHE_TTL_MS`.  On the serving connection it pinned the event loop for the whole
 * statement -- 5.4 s in production on 2026-10-24 -- and the health route runs this, so the
 * health probe could not answer until the read finished.  Async for that reason.
 */
export type HaltCauseBatch = {
  /**
   * The confirmed cause kind per account.
   *
   * `"stopped"` here means CONFIRMED: the audit trail was read successfully, inside the cache
   * TTL, and holds no app-initiated halt for that scope.  A scope whose cause could NOT be
   * confirmed also reads `"stopped"` in this map, and is listed in `unknown` -- so a caller that
   * wants the truth about a scope has to read `unknown` first.
   */
  kinds: Map<string, AutonomyHaltCause["kind"]>;
  /**
   * Scopes whose cause could not be confirmed: the off-loop read failed, timed out, or never
   * ran.  An unknown cause is NOT evidence of a deliberate owner stop, and it is not the same
   * fact as "stopped" -- it is the absence of a fact.
   */
  unknown: Set<string>;
};

export async function batchedHaltCauseKinds(
  accounts: readonly HaltCauseAccountRef[]
): Promise<HaltCauseBatch> {
  const out = new Map<string, AutonomyHaltCause["kind"]>();
  const unknown = new Set<string>();
  for (const account of accounts) {
    out.set(`${account.userId}:${account.accountId}`, "stopped");
  }
  if (accounts.length === 0) return { kinds: out, unknown };
  let unmarked: HaltCauseAccountRef[];
  try {
    unmarked = classifyFromMarkers(getDb(), accounts, out);
  } catch {
    // The marker read failed: no cause could be confirmed for anyone.
    for (const account of accounts) unknown.add(`${account.userId}:${account.accountId}`);
    return { kinds: out, unknown };
  }
  if (unmarked.length === 0) return { kinds: out, unknown };
  try {
    await classifyFromAudit(unmarked, out, unknown);
  } catch {
    // The audit read failed outright: those scopes keep their unknown marking.
    for (const account of unmarked) unknown.add(`${account.userId}:${account.accountId}`);
  }
  return { kinds: out, unknown };
}
