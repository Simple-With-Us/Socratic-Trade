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
const APP_HALT_PREDICATE = `(kind = 'broker_placement_auto_halted'
  OR (kind = 'policy_violation_drawdown' AND ${jsonField("$.revertedTo")} = 'halted'))`;

function handoverPredicate(kindColumn: string, payloadColumn: string): string {
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

/** One scope's cached audit row.  `row` is null when the account has no app-initiated halt. */
type CachedHaltAuditRow = { row: LatestAppHaltRow | null; at: number };

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
 * Execution budget for one off-loop audit read.  The production batch takes ~5.4 s; the budget
 * leaves room for a slower plan on a bigger database and still retires the worker slot rather
 * than hanging the caller.
 *
 * It is deliberately BELOW the fleet-health-recover probe timeout (12 s) and the Docker
 * HEALTHCHECK `--max-time` (14 s).  This read sits behind the health route, and a cold health
 * snapshot awaits it: a budget above those timeouts would let the fix reproduce the symptom it
 * exists to remove -- the health probe would time out, the daemon would restart the container, and
 * the restart would re-run the boot sweep.  At 8 s a contended read gives up, the cache keeps its
 * previous (stale) row, and the probe still answers in time.  A stale halt cause is display-only;
 * a missed probe is an outage.
 */
const HALT_AUDIT_OFF_LOOP_TIMEOUT_MS = 8_000;

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

const haltAuditCache = new Map<string, CachedHaltAuditRow>();
let haltAuditRefreshInFlight: Promise<void> | null = null;

function haltAuditScopeKey(scope: AuditScope): string {
  return `${scope.userId}\u0000${scope.connectedAccountId ?? ""}`;
}

/** One account scope the halt-cause sweep reads: a user and the connected account. */
export type HaltAuditScope = { userId: string; connectedAccountId: string | null };

/**
 * The batched sweep as one statement per chunk of accounts, so a statement stays under SQLite's
 * portable 999-variable ceiling.  Same SQL the serving connection runs.
 *
 * Exported so a test can assert the statement's shape and query plan without running it on the
 * serving connection -- which is the point of the off-loop read.
 */
export function buildHaltAuditStatements(accounts: readonly HaltAuditScope[]): { sql: string; params: string[] }[] {
  return chunkItems(accounts, HALT_AUDIT_ACCOUNT_CHUNK).map((chunk) => {
    const branches = chunk.map(latestHaltBranch);
    return {
      sql: branches.map((branch) => branch.sql).join("\nUNION ALL\n"),
      params: branches.flatMap((branch) => branch.params)
    };
  });
}

/**
 * The same statement the serving connection runs, executed on an off-loop worker thread
 * (`src/lib/rag/sqlite-all-offloop.ts`).  better-sqlite3 is synchronous, so on the serving
 * connection this read pinned the event loop for the whole statement -- and the health route
 * runs it, so the health probe could not answer until the read finished.
 */
async function readHaltAuditRowsOffLoop(scopes: readonly AuditScope[]): Promise<Map<string, HaltAuditRow>> {
  const rows = new Map<string, HaltAuditRow>();
  const dbPath = databasePath();
  for (const statement of buildHaltAuditStatements(scopes)) {
    const chunkRows = await sqliteAllOffLoop(statement.sql, statement.params, dbPath, HaltAuditRowSchema, {
      timeoutMs: HALT_AUDIT_OFF_LOOP_TIMEOUT_MS
    });
    for (const row of chunkRows) {
      rows.set(haltAuditScopeKey({ userId: row.user_id, connectedAccountId: row.connected_account_id }), row);
    }
  }
  return rows;
}

/**
 * Refresh the cached audit rows for the given scopes.  One refresh runs at a time; a caller that
 * arrives while one is in flight waits for that one instead of starting a second read.
 */
function refreshHaltAuditRows(scopes: readonly AuditScope[]): Promise<void> {
  if (scopes.length === 0) return Promise.resolve();
  if (haltAuditRefreshInFlight) return haltAuditRefreshInFlight;
  const pending = (async () => {
    try {
      const rows = await readHaltAuditRowsOffLoop(scopes);
      const at = Date.now();
      for (const scope of scopes) {
        const key = haltAuditScopeKey(scope);
        haltAuditCache.set(key, { row: rows.get(key) ?? null, at });
      }
    } catch {
      // Leave the cache as it was.  A stale row is better than a wrong one, and the next
      // refresh retries.  The caller still reads the old cache, exactly as a failed read did.
    }
  })();
  haltAuditRefreshInFlight = pending;
  void pending.then(() => {
    if (haltAuditRefreshInFlight === pending) haltAuditRefreshInFlight = null;
  });
  return pending;
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
  out: Map<string, AutonomyHaltCause["kind"]>
): Promise<void> {
  const scopes = accounts.map((account) => ({ userId: account.userId, connectedAccountId: account.accountId }));
  const now = Date.now();
  const stale = scopes.filter((scope) => {
    const hit = haltAuditCache.get(haltAuditScopeKey(scope));
    return !hit || now - hit.at > HALT_AUDIT_CACHE_TTL_MS;
  });
  // Off the event loop: this read held the serving loop for 5.4 s in production.
  if (stale.length > 0) await refreshHaltAuditRows(stale);
  const byKey = new Map<string, LatestAppHaltRow>();
  for (const scope of scopes) {
    const hit = haltAuditCache.get(haltAuditScopeKey(scope));
    if (!hit || !hit.row) continue;
    if (hit.row.connected_account_id == null) continue;
    byKey.set(`${hit.row.user_id}:${hit.row.connected_account_id}`, hit.row);
  }
  for (const account of accounts) {
    const row = byKey.get(`${account.userId}:${account.accountId}`);
    if (!row || row.handed_over) continue;
    out.set(
      `${account.userId}:${account.accountId}`,
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
export async function batchedHaltCauseKinds(
  accounts: readonly HaltCauseAccountRef[]
): Promise<Map<string, AutonomyHaltCause["kind"]>> {
  const out = new Map<string, AutonomyHaltCause["kind"]>();
  for (const account of accounts) {
    out.set(`${account.userId}:${account.accountId}`, "stopped");
  }
  if (accounts.length === 0) return out;
  let unmarked: HaltCauseAccountRef[];
  try {
    unmarked = classifyFromMarkers(getDb(), accounts, out);
  } catch {
    return out;
  }
  if (unmarked.length === 0) return out;
  try {
    await classifyFromAudit(unmarked, out);
  } catch {
    // Unmarked accounts stay `stopped`.
  }
  return out;
}
