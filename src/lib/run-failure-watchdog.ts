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
 *   3. AUTO-HALT (halt-eligible streak >= ST_RUN_FAILURE_HALT_AFTER, default
 *      10): the account is flipped to `halted` with a durable, clearly-labeled
 *      halt marker (autoResume: false) + audit row, mirroring the broker-health
 *      auto-pause.  The halt cause is described honestly by
 *      describeAutonomyHaltCause ("run_failure_halt").  The owner re-arms from
 *      the console.  Only runs that STARTED after that re-arm count toward the
 *      next halt, so a run already in flight cannot re-trip it.  A fresh streak
 *      of the same halt threshold is required before it can halt again.
 *      App-stall and mid-run-restart failures stay in the alert/backoff streak
 *      and are omitted from this halt streak (consecutiveHaltEligibleFailures).
 *      Broker HTTP failures and LLM/provider failures still count.
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
import {
  RUN_FAILURE_WATCH_STATE_PREFIX,
  countLeadingFailedRuns,
  countLeadingHaltEligibleFailedRuns,
  getTradingLivenessSummary,
  hasFinishedRunStartedAfter,
  runFailureWatchStateKey,
} from "./trading-liveness";
import { alertLivenessWarning, clearLivenessWarning } from "./db-health";

const STATE_PREFIX = RUN_FAILURE_WATCH_STATE_PREFIX;
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
  /** Legacy raw-streak floor.  Re-arm now sets this to 0 and records `rearmedAt`
   *  instead.  A raw floor of "streak at halt time" is one behind a run that was
   *  already in flight, so the next failure stepped over it and re-halted. */
  lastHaltStreak?: number;
  /** ISO time the account was last re-armed to active.  Only runs with
   *  `started_at` strictly after this instant count toward alert, backoff, and
   *  halt.  Cleared when a run that started after it completes successfully. */
  rearmedAt?: string;
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
  return runFailureWatchStateKey(userId, accountId);
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

/** Finished runs, newest start first.  A still-running row is omitted. */
function recentFinishedRuns(
  userId: string,
  accountId: string
): Array<{ status: string; started_at: string; summary: string | null }> {
  return getDb()
    .prepare(
      `SELECT status, started_at, summary FROM strategy_runs
       WHERE user_id = ? AND connected_account_id = ? AND status IN ('completed', 'failed')
       ORDER BY started_at DESC LIMIT 200`
    )
    .all(userId, accountId) as Array<{ status: string; started_at: string; summary: string | null }>;
}

/** Null when the run log could not be read.  Callers must not treat that as a recovered streak. */
function failuresStartedAfter(userId: string, accountId: string, startedAfter: string | null): number | null {
  try {
    return countLeadingFailedRuns(recentFinishedRuns(userId, accountId), startedAfter);
  } catch {
    return null;
  }
}

/** Null when the run log could not be read.  Halt-eligible subset of `failuresStartedAfter`. */
function haltEligibleFailuresStartedAfter(
  userId: string,
  accountId: string,
  startedAfter: string | null
): number | null {
  try {
    return countLeadingHaltEligibleFailedRuns(recentFinishedRuns(userId, accountId), startedAfter);
  } catch {
    return null;
  }
}

/**
 * When the owner set the account active again.  Prefer the audit receipt (console
 * `policy_change` or ops `set_system_state`) so a run that started in the gap between
 * re-arm and this tick still counts.  Falls back to null; the caller uses the tick time,
 * which still excludes anything already in flight.
 */
function resolveRearmTimestamp(userId: string, accountId: string, haltedSince: string): string | null {
  try {
    const row = getDb()
      .prepare(
        `SELECT created_at FROM audit_events
         WHERE user_id = ? AND connected_account_id = ? AND created_at >= ?
           AND (
             (kind = 'policy_change'
               AND json_valid(payload)
               AND json_extract(payload, '$.value.systemState') = 'active')
             OR (kind = 'ops_account_control'
               AND json_valid(payload)
               AND json_extract(payload, '$.action') = 'set_system_state'
               AND CAST(json_extract(payload, '$.dryRun') AS INTEGER) = 0
               AND CAST(json_extract(payload, '$.ok') AS INTEGER) = 1
               AND json_extract(payload, '$.to') = 'active')
           )
         ORDER BY created_at ASC
         LIMIT 1`
      )
      .get(userId, accountId, haltedSince) as { created_at: string } | undefined;
    if (!row?.created_at || !Number.isFinite(Date.parse(row.created_at))) return null;
    return row.created_at;
  } catch {
    return null;
  }
}

function freshEpisode(rearmedAt: string, effectiveStreak: number): RunFailureWatchState {
  return {
    consecutiveFailures: effectiveStreak,
    firstSeenAt: rearmedAt,
    lastFailureAt: rearmedAt,
    lastAlertedStreak: 0,
    backoffUntil: null,
    halted: false,
    lastHaltStreak: 0,
    rearmedAt,
  };
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

/** True when any durable row under `prefix` still satisfies `live`. */
function anyDurableRow(prefix: string, live: (value: unknown) => boolean): boolean {
  try {
    const rows = getDb().prepare(`SELECT value FROM settings WHERE key LIKE ?`).all(`${prefix}:%`) as Array<{ value: string }>;
    return rows.some((row) => {
      try {
        return live(JSON.parse(row.value));
      } catch {
        return true; // unreadable but present: do not end the episode on a guess
      }
    });
  } catch {
    return true; // cannot tell: leave the episode alone
  }
}

/**
 * The two liveness warnings are fleet-wide (one episode clock each), so their
 * episodes end only when NO account still holds the condition: a recovered
 * streak or an owner re-arm clears them, but one account recovering does not
 * reset the clock for another that is still failing or halted.
 */
async function clearEndedLivenessEpisodes(): Promise<void> {
  if (!anyDurableRow(STATE_PREFIX, (v) => ((v as { lastAlertedStreak?: number })?.lastAlertedStreak ?? 0) > 0)) {
    await clearLivenessWarning("run_failure_streak");
  }
  if (!anyDurableRow(HALT_MARKER_PREFIX, () => true)) {
    await clearLivenessWarning("run_failure_streak_halted");
  }
}

/**
 * One watchdog pass over every account.  Intended as a cadence-gated lane
 * inside the scheduler tick (leader only).  Never throws.
 */
export async function runFailureWatchdogTick(now: number = Date.now()): Promise<void> {
  try {
    const summary = getTradingLivenessSummary(now);
    const activeStreaks = new Map<
      string,
      { userId: string; accountId: string; label: string; streak: number; haltStreak: number }
    >();
    if (summary) {
      for (const a of summary.accounts) {
        activeStreaks.set(`${a.userId}:${a.connectedAccountId}`, {
          userId: a.userId,
          accountId: a.connectedAccountId,
          label: a.label,
          streak: a.consecutiveFailedRuns,
          haltStreak: a.consecutiveHaltEligibleFailures,
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
        let haltStreak = entry?.haltStreak ?? 0;
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
              // Not in the active summary on this tick (the summary was taken
              // before the re-arm, or the account is close_only).  Open the
              // post-re-arm window anyway.  Clearing it here would let the next
              // active tick see the historical streak and halt immediately.
              const rearmedAt = resolveRearmTimestamp(userId, accountId, marker.since) ?? new Date(now).toISOString();
              clearHaltMarker(userId, accountId);
              saveState(userId, accountId, freshEpisode(rearmedAt, 0));
              console.log(
                `[run-failure-watchdog] ${userId}/${accountId} left halted; run-failure halt marker cleared`
              );
            }
          }
          continue;
        }

        // Active account.  `streak` from the summary is the post-re-arm count once
        // `rearmedAt` has been saved.  On the tick that first observes the re-arm,
        // the summary was computed before that write, so it is still the raw
        // historical streak.  Recompute from `started_at` before any decision.
        const isoNow = new Date(now).toISOString();
        let markerNow = marker;
        let prev = loadState(userId, accountId);
        let effective = streak;
        if (markerNow) {
          // The owner re-armed after the watchdog halted the account.  The halt-time
          // raw streak is NOT a safe floor: a run that had already started can fail
          // after the re-arm and make the raw count floor+1, which re-halts on this
          // tick.  Only runs that started after the re-arm count, and the halt
          // threshold applies to that new streak in full.
          const rearmedAt = resolveRearmTimestamp(userId, accountId, markerNow.since) ?? isoNow;
          clearHaltMarker(userId, accountId);
          markerNow = null;
          const counted = failuresStartedAfter(userId, accountId, rearmedAt);
          // Unreadable log: open the window at 0 so this tick cannot re-halt.
          effective = counted ?? 0;
          haltStreak = haltEligibleFailuresStartedAfter(userId, accountId, rearmedAt) ?? 0;
          prev = freshEpisode(rearmedAt, effective);
          console.log(
            `[run-failure-watchdog] ${userId}/${accountId} re-armed after auto-halt; post-rearm streak ${effective}`
          );
        } else if (prev && !prev.rearmedAt && (prev.lastHaltStreak ?? 0) > 0 && prev.firstSeenAt) {
          // Episode opened by the old raw floor.  firstSeenAt is that re-arm tick.
          // Adopt it so an in-flight failure cannot step over the floor.
          const rearmedAt = prev.firstSeenAt;
          const counted = failuresStartedAfter(userId, accountId, rearmedAt);
          if (counted === null) {
            saveState(userId, accountId, prev);
            continue;
          }
          effective = counted;
          haltStreak = haltEligibleFailuresStartedAfter(userId, accountId, rearmedAt) ?? 0;
          prev = { ...prev, rearmedAt, lastHaltStreak: 0, consecutiveFailures: effective };
        } else if (prev?.rearmedAt) {
          const counted = failuresStartedAfter(userId, accountId, prev.rearmedAt);
          if (counted === null) {
            saveState(userId, accountId, prev);
            continue;
          }
          effective = counted;
          haltStreak = haltEligibleFailuresStartedAfter(userId, accountId, prev.rearmedAt) ?? 0;
        }

        if (effective === 0) {
          if (prev?.rearmedAt && !hasFinishedRunStartedAfter(userId, accountId, prev.rearmedAt)) {
            // No finished run has started since the re-arm.  Keep the window.
            // Dropping it would put the historical streak back in force.
            saveState(userId, accountId, {
              ...prev,
              consecutiveFailures: 0,
              halted: false,
              backoffUntil: null,
              lastHaltStreak: 0,
            });
            continue;
          }
          // Recovered: a completed run broke the streak.  Clear everything so
          // the next episode starts fresh.
          const hadState = prev !== null || loadState(userId, accountId) !== null;
          clearState(userId, accountId);
          if (hadState) {
            console.log(
              `[run-failure-watchdog] ${userId}/${accountId} recovered (streak cleared by a completed run)`
            );
          }
          continue;
        }

        const state: RunFailureWatchState = prev ?? {
          consecutiveFailures: 0,
          firstSeenAt: isoNow,
          lastFailureAt: isoNow,
          lastAlertedStreak: 0,
          backoffUntil: null,
          halted: false,
        };
        if (effective > state.consecutiveFailures) {
          state.lastFailureAt = isoNow;
        }
        state.consecutiveFailures = effective;

        // 1. Alert — on first crossing and on every growth, so a worsening
        //    failure is not a single ping.
        if (effective >= alertAfter() && effective > state.lastAlertedStreak) {
          state.lastAlertedStreak = effective;
          await alertLivenessWarning(
            "run_failure_streak",
            `${label || accountId}: ${effective} consecutive strategy-run failures ` +
              `(${haltStreak} count toward auto-halt; app stalls and mid-run restarts do not). ` +
              `First seen ${state.firstSeenAt}. Trading on this account is failing every run; ` +
              `backoff ${effective >= backoffAfter() ? "engaged" : `engages at ${backoffAfter()}`} ` +
              `failures, auto-halt at ${haltAfter()} broker or LLM failures.`
          );
        }

        // 2. Backoff — exponential suppression window from the last failure.
        if (effective >= backoffAfter()) {
          const minutes = backoffMinutesForStreak(effective);
          const untilMs = Date.parse(state.lastFailureAt) + minutes * 60_000;
          const untilIso = new Date(untilMs).toISOString();
          // Only ever extend, never shorten: a shrinking window would flap.
          if (!state.backoffUntil || Date.parse(state.backoffUntil) < untilMs) {
            state.backoffUntil = untilIso;
            console.warn(
              `[run-failure-watchdog] ${userId}/${accountId}: backing off runs for ${minutes}m ` +
                `(streak=${effective}, until ${untilIso})`
            );
          }
        }

        // 3. Auto-halt — the last resort, and only on the halt-eligible streak.
        //    App stalls and mid-run restarts alert and back off above, but they
        //    never advance this threshold.  Never restarts the process.  After an
        //    owner re-arm, both streaks are limited to runs that started after
        //    re-arm; the halt threshold applies to halt-eligible failures only.
        const rehaltFloor = state.lastHaltStreak ?? 0;
        if (haltStreak >= haltAfter() && haltStreak > rehaltFloor && !state.halted && !markerNow) {
          state.halted = true;
          state.lastHaltStreak = haltStreak;
          saveState(userId, accountId, state);
          await haltAccountForRunFailures(userId, accountId, label, haltStreak, now);
          continue;
        }

        saveState(userId, accountId, state);
      }
    }
    await clearEndedLivenessEpisodes();
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
