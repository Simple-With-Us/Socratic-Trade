/**
 * Consecutive-run-failure watchdog (self-healing, 2026-09-30).
 *
 * The trading-liveness signal (trading-liveness.ts) is deliberately read-only:
 * it reports a degraded account but never acts, on the theory that "a
 * human/alert acts on it".  The 2026-09-30 incident proved that assumption
 * false — ~5 days of consecutive strategy-run failures sat unhandled while the
 * scheduler ticked, because the degraded flag had no in-process consumer.
 * This module closes that gap ON the scheduler tick, with three escalating
 * responses per active-autonomy account:
 *
 *   1. ALERT (streak >= ST_RUN_FAILURE_ALERT_AFTER, default 3): loud admin
 *      alert via alertLivenessWarning("run_failure_streak", ...) — 15-min
 *      cooldown, Sentry error-level paging, 4h escalation.  Re-alerts as the
 *      streak GROWS, so a worsening failure is not a single ping.
 *   2. BACKOFF (streak >= ST_RUN_FAILURE_BACKOFF_AFTER, default 5): the
 *      scheduler suppresses that account's due runs with exponential backoff
 *      (base ST_RUN_FAILURE_BACKOFF_BASE_MIN default 15m, doubling per
 *      additional failure, cap ST_RUN_FAILURE_BACKOFF_CAP_MIN default 240m),
 *      so a broken broker/LLM path is not hammered every cadence.  A probe run
 *      is allowed once the backoff expires; success clears everything, another
 *      failure extends the backoff.
 *   3. AUTO-HALT (streak >= ST_RUN_FAILURE_HALT_AFTER, default 10): the
 *      account is flipped to `halted` with a durable, clearly-labeled halt
 *      marker (autoResume: false) + audit row, mirroring the broker-health
 *      auto-pause.  The halt cause is described honestly by
 *      describeAutonomyHaltCause ("run_failure_halt").  The owner re-arms from
 *      the console; a fresh streak is required before it can halt again.
 *
 * Deliberately NEVER restarts the process: the boot interlock
 * (reconcileAutonomyOnBoot) would revert every active account to halted,
 * trading one failing account for a stopped fleet.  All state lives in
 * internal_settings — no migration.
 *
 * Never throws: a broken watchdog must not break the tick it guards.
 */

import {
  deleteInternalSetting,
  getDb,
  getInternalSetting,
  listConnectedAccounts,
  listUsers,
  peekPolicy,
  setInternalSetting,
  setPolicy,
  audit,
} from "./db";
import { getTradingLivenessSummary } from "./trading-liveness";
import { alertLivenessWarning } from "./db-health";

const STATE_PREFIX = "runFailureWatch";
const HALT_MARKER_PREFIX = "runFailureHaltMarker";

export interface RunFailureWatchState {
  /** Last observed consecutive-failure streak. */
  consecutiveFailures: number;
  /** ISO time the current streak was first seen. */
  firstSeenAt: string;
  /** ISO time the streak last grew (drives the backoff window). */
  lastFailureAt: string;
  /** Highest streak value already alerted on (re-alert on growth). */
  lastAlertedStreak: number;
  /** ISO time until which due runs are suppressed, or null. */
  backoffUntil: string | null;
  /** Whether this account was auto-halted by the watchdog. */
  halted: boolean;
  /** Streak at the last auto-halt (set on owner re-arm): a re-halt requires
   *  NEW failures beyond this floor, so re-arming is not instantly undone. */
  lastHaltStreak?: number;
}

export interface RunFailureHaltMarker {
  since: string;
  reason: string;
  consecutiveFailures: number;
  /** Never auto-resumes: the owner re-arms from the console. */
  autoResume: false;
  priorState: "active";
}

function stateKey(userId: string, accountId: string): string {
  return `${STATE_PREFIX}:${userId}:${accountId}`;
}

export function runFailureHaltMarkerKey(userId: string, accountId: string): string {
  return `${HALT_MARKER_PREFIX}:${userId}:${accountId}`;
}

function alertAfter(): number {
  const raw = Number(process.env.ST_RUN_FAILURE_ALERT_AFTER);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 3;
}

function backoffAfter(): number {
  const raw = Number(process.env.ST_RUN_FAILURE_BACKOFF_AFTER);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 5;
}

function haltAfter(): number {
  const raw = Number(process.env.ST_RUN_FAILURE_HALT_AFTER);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 10;
}

function backoffBaseMin(): number {
  const raw = Number(process.env.ST_RUN_FAILURE_BACKOFF_BASE_MIN);
  return Number.isFinite(raw) && raw > 0 ? raw : 15;
}

function backoffCapMin(): number {
  const raw = Number(process.env.ST_RUN_FAILURE_BACKOFF_CAP_MIN);
  return Number.isFinite(raw) && raw > 0 ? raw : 240;
}

/** Backoff minutes for a streak of S failures (>= backoffAfter): base * 2^(S - backoffAfter), capped. */
export function backoffMinutesForStreak(streak: number): number {
  const base = backoffBaseMin();
  const cap = backoffCapMin();
  const after = backoffAfter();
  if (streak < after) return 0;
  const minutes = base * Math.pow(2, streak - after);
  return Math.min(cap, minutes);
}

function loadState(userId: string, accountId: string): RunFailureWatchState | null {
  try {
    return getInternalSetting<RunFailureWatchState>(stateKey(userId, accountId)) ?? null;
  } catch {
    return null;
  }
}

function saveState(userId: string, accountId: string, state: RunFailureWatchState): void {
  try {
    setInternalSetting(stateKey(userId, accountId), state);
  } catch {
    /* durable state is best-effort; the streak recomputes from strategy_runs */
  }
}

function clearState(userId: string, accountId: string): void {
  try {
    deleteInternalSetting(stateKey(userId, accountId));
  } catch {
    /* ignore */
  }
}

export function getRunFailureHaltMarker(
  userId: string,
  accountId: string
): RunFailureHaltMarker | null {
  try {
    return getInternalSetting<RunFailureHaltMarker>(runFailureHaltMarkerKey(userId, accountId)) ?? null;
  } catch {
    return null;
  }
}

function clearHaltMarker(userId: string, accountId: string): void {
  try {
    deleteInternalSetting(runFailureHaltMarkerKey(userId, accountId));
  } catch {
    /* ignore */
  }
}

/**
 * Scheduler hook: true when the watchdog is currently backing off this
 * account's runs.  Called from the due-run filter in scheduler.ts; reads only
 * durable state, so it is correct regardless of lane ordering within the tick.
 */
export function isRunBackedOff(
  userId: string,
  accountId: string,
  now: number = Date.now()
): boolean {
  const state = loadState(userId, accountId);
  if (!state?.backoffUntil) return false;
  const untilMs = Date.parse(state.backoffUntil);
  if (Number.isNaN(untilMs)) return false;
  return now < untilMs;
}

async function haltAccountForRunFailures(
  userId: string,
  accountId: string,
  label: string,
  streak: number,
  now: number
): Promise<void> {
  const policy = peekPolicy(userId, accountId);
  if (policy.systemState !== "active") return; // someone else already halted it; leave their intent alone
  const reason =
    `${streak} consecutive strategy-run failures` +
    (label ? ` on ${label}` : "") +
    ` (auto-halted by the run-failure watchdog; re-arm from the console)`;
  setPolicy({ ...policy, systemState: "halted" }, userId, accountId);
  const marker: RunFailureHaltMarker = {
    since: new Date(now).toISOString(),
    reason,
    consecutiveFailures: streak,
    autoResume: false,
    priorState: "active",
  };
  setInternalSetting(runFailureHaltMarkerKey(userId, accountId), marker);
  try {
    audit(
      "run_failure_auto_halted",
      { consecutiveFailures: streak, reason, from: "active", to: "halted", label },
      userId,
      accountId
    );
  } catch {
    /* audit is best-effort */
  }
  console.error(`[run-failure-watchdog] AUTO-HALTED ${userId}/${accountId}: ${reason}`);
  await alertLivenessWarning(
    "run_failure_streak_halted",
    `AUTO-HALTED ${label || accountId}: ${streak} consecutive strategy-run failures. ` +
      `The account is halted until re-armed from the console. Last failures need investigation.`
  );
}

/**
 * One watchdog pass over every account.  Intended as a cadence-gated lane
 * inside the scheduler tick (leader only).  Never throws.
 */
export async function runFailureWatchdogTick(now: number = Date.now()): Promise<void> {
  try {
    const summary = getTradingLivenessSummary(now);
    const activeStreaks = new Map<string, { userId: string; accountId: string; label: string; streak: number }>();
    if (summary) {
      for (const a of summary.accounts) {
        activeStreaks.set(`${a.userId}:${a.connectedAccountId}`, {
          userId: a.userId,
          accountId: a.connectedAccountId,
          label: a.label,
          streak: a.consecutiveFailedRuns,
        });
      }
    }

    // Visit every connected account (active or not) so halted-by-watchdog
    // accounts get their marker reconciled even though they leave the
    // liveness summary once halted.
    for (const userId of listUsers()) {
      let accounts: Array<{ id: string; label?: string | null }>;
      try {
        accounts = listConnectedAccounts(userId);
      } catch {
        continue;
      }
      for (const account of accounts) {
        const accountId = account.id;
        const entry = activeStreaks.get(`${userId}:${accountId}`);
        const streak = entry?.streak ?? 0;
        const label = entry?.label ?? account.label ?? accountId;
        const marker = getRunFailureHaltMarker(userId, accountId);

        if (!entry) {
          // Not active: only marker reconciliation matters.
          if (marker) {
            let systemState: string | undefined;
            try {
              systemState = peekPolicy(userId, accountId).systemState;
            } catch {
              systemState = undefined;
            }
            if (systemState && systemState !== "halted") {
              // The owner (or another mechanism) moved the account out of
              // halted: hand it back.  A fresh streak is required before the
              // watchdog can halt it again.
              clearHaltMarker(userId, accountId);
              clearState(userId, accountId);
              console.log(
                `[run-failure-watchdog] ${userId}/${accountId} left halted; run-failure halt marker cleared`
              );
            }
          }
          continue;
        }

        if (streak === 0) {
          // Recovered: a completed run broke the streak.  Clear everything so
          // the next episode starts fresh; keep the marker only while halted.
          const hadState = loadState(userId, accountId) !== null;
          clearState(userId, accountId);
          if (hadState) {
            console.log(
              `[run-failure-watchdog] ${userId}/${accountId} recovered (streak cleared by a completed run)`
            );
          }
          continue;
        }

        // Active account with a live failure streak.
        const isoNow = new Date(now).toISOString();
        let markerNow = marker;
        let prev = loadState(userId, accountId);
        if (markerNow) {
          // The owner (or another mechanism) re-armed the account after the
          // watchdog halted it: hand it back and start a fresh episode.  The
          // halt-time streak becomes the re-halt floor, so a re-halt requires
          // NEW failures beyond it (mirrors the broker-health auto-pause
          // re-arm rule) instead of instantly undoing the owner's re-arm.
          clearHaltMarker(userId, accountId);
          markerNow = null;
          prev = null;
          console.log(
            `[run-failure-watchdog] ${userId}/${accountId} re-armed after auto-halt; fresh episode`
          );
        }
        const state: RunFailureWatchState = prev ?? {
          consecutiveFailures: 0,
          firstSeenAt: isoNow,
          lastFailureAt: isoNow,
          lastAlertedStreak: 0,
          backoffUntil: null,
          halted: false,
          ...(marker ? { lastHaltStreak: marker.consecutiveFailures } : {}),
        };
        if (streak > state.consecutiveFailures) {
          state.lastFailureAt = isoNow;
        }
        state.consecutiveFailures = streak;

        // 1. Alert — on first crossing and on every growth, so a worsening
        //    failure is not a single ping.
        if (streak >= alertAfter() && streak > state.lastAlertedStreak) {
          state.lastAlertedStreak = streak;
          await alertLivenessWarning(
            "run_failure_streak",
            `${label || accountId}: ${streak} consecutive strategy-run failures ` +
              `(first seen ${state.firstSeenAt}). Trading on this account is failing every run; ` +
              `backoff ${streak >= backoffAfter() ? "engaged" : `engages at ${backoffAfter()}`} ` +
              `failures, auto-halt at ${haltAfter()}.`
          );
        }

        // 2. Backoff — exponential suppression window from the last failure.
        if (streak >= backoffAfter()) {
          const minutes = backoffMinutesForStreak(streak);
          const untilMs = Date.parse(state.lastFailureAt) + minutes * 60_000;
          const untilIso = new Date(untilMs).toISOString();
          // Only ever extend, never shorten: a shrinking window would flap.
          if (!state.backoffUntil || Date.parse(state.backoffUntil) < untilMs) {
            state.backoffUntil = untilIso;
            console.warn(
              `[run-failure-watchdog] ${userId}/${accountId}: backing off runs for ${minutes}m ` +
                `(streak=${streak}, until ${untilIso})`
            );
          }
        }

        // 3. Auto-halt — the last resort.  Never restarts the process.  After an
        //    owner re-arm, the streak must grow BEYOND the halt-time floor
        //    before it can halt again.
        const rehaltFloor = state.lastHaltStreak ?? 0;
        if (streak >= haltAfter() && streak > rehaltFloor && !state.halted && !markerNow) {
          state.halted = true;
          saveState(userId, accountId, state);
          await haltAccountForRunFailures(userId, accountId, label, streak, now);
          continue;
        }

        saveState(userId, accountId, state);
      }
    }
  } catch (err) {
    console.error("[run-failure-watchdog] tick error:", err);
  }
}

/** Test helper: wipe all watchdog state + markers (prefix scan). */
export function resetRunFailureWatchdogForTests(): void {
  try {
    const db = getDb();
    db.prepare(
      `DELETE FROM settings WHERE key LIKE '${STATE_PREFIX}:%' OR key LIKE '${HALT_MARKER_PREFIX}:%'`
    ).run();
  } catch {
    /* ignore */
  }
}
