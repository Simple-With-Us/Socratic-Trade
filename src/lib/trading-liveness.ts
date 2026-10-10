import { getDb, getInternalSetting, listConnectedAccounts, listUsers, peekPolicy } from "./db";
import { isMarketOpen } from "./market-calendar";

// Handoff 6b.7: the scheduler heartbeat (/api/health's schedulerAgeSeconds) only proves the tick
// FUNCTION is running — it goes green the instant a DB write succeeds, even if every strategy run
// it kicks off then fails (persistent LLM/broker outage). This module adds a second, orthogonal
// signal: per active-autonomy account, how long since a run actually COMPLETED, and how many runs
// in a row have failed. Read-only; never throws (callers treat a thrown/failed computation the
// same as "no data" rather than letting it break the health probe).
//
// Deliberately NEVER maps to a 503 anywhere it's consumed — see the /api/health call site. A
// container restart re-triggers the boot autonomy interlock (reconcileAutonomyOnBoot), reverting
// every "active" account to "halted" (6b.1) — so a naive 503-on-stale-runs would have Coolify
// restart the very process needed to place the trade that clears the staleness, and instead HALT
// autonomy. This is `degraded`-only signal for a human/alert to act on.
//
// THE `autonomy_fully_dark` REASON (added 2026-09-29).  The per-account reasons below are both
// scoped to accounts that are ALREADY `systemState === "active"` — the loop `continue`s past
// everything else, and the whole summary returns null when no active account remains.  That is
// correct for its own purpose (a halted account is not a stale RUN, it is a deliberate stop) and it
// is also the exact reason this module read "healthy" for four consecutive days while Alpaca Paper
// sat halted from 2026-09-25 with no strategy run at all.  A system where NOTHING is trading is the
// worst state available, and the dimension that exists to detect trading going wrong was
// structurally incapable of noticing that trading had stopped entirely.  The fleet's own numbers:
// last strategy run 2026-09-25T18:33, seven accounts all `halted`/`close_only`, and
// `tradingLiveness: { degraded: 0, degradedReasons: [] }` on /api/health throughout.
// So: count accounts ELIGIBLE to trade (autopilot authority, connected with an account number, not
// parked, not draining) separately from accounts that are actually ACTIVE, and report
// `autonomy_fully_dark` when the first set is non-empty and the second is empty.  It is NOT gated on
// market hours: accounts stay `active` overnight and across weekends, and only a HALT removes one
// from the active set, so a dark fleet is worth paging about at any hour.  It still never maps to a
// 503 — the Coolify-restart trap above still applies — so this is a `degradedReasons` entry for a
// human, not a container kill switch.
//
// Market-session-aware staleness (audit finding, 2026-07-15): the scheduler deliberately skips
// runs while the market is closed (strategy.ts's "Market is closed" guard, sourced from
// market-calendar.ts's isMarketOpen — the SAME source of truth reused here), so a naive
// age-vs-threshold comparison reports every account "stale" as its overnight/weekend baseline.
// The rule: the `stale_last_completed_run` reason can only fire when the market is OPEN at
// evaluation time (`isMarketOpen(now)`). A stale run while the market is closed still reports its
// real age (never fabricated/hidden) plus `marketOpen: false`, just without flipping `degraded`.
// This is the simplest honest rule — it does not try to reconstruct "was the market open at any
// point since the last completed run"; it only asks "is staleness actionable right now." The
// `consecutive_failures` reason is unaffected by the market clock: a run only reaches 'failed'
// status by actually executing, which itself only happens while the market is open (or extended
// hours, per policy.runDuringExtendedHours), so that signal is already implicitly market-gated.
//
// Auto-halt is a narrower streak.  `consecutiveFailedRuns` counts every failed run (alert,
// backoff, and this degraded reason).  `consecutiveHaltEligibleFailures` is that same walk with
// app-stall and mid-run-restart failures removed.  Those still alert and back off.  They must
// not auto-halt Autopilot after an event-loop stall (2026-10-01 RTH).  Broker HTTP failures
// and LLM/provider failures stay on the halt streak.

const MAX_RUN_LOOKBACK = 200;

export type FinishedStrategyRunRow = {
  status: string;
  started_at: string;
  summary: string | null;
};

/**
 * Set by `computeAccountTradingLiveness` for the caller that immediately takes it.
 *  `getTradingLivenessSummary` copies the array into an optional sink so the
 *  run-failure watchdog can walk the same rows again without a second SELECT.
 */
let lastFinishedRunsForCaller: FinishedStrategyRunRow[] | null = null;

/** Newest finished runs for one account.  Liveness and the watchdog share this SELECT. */
export function loadRecentFinishedRuns(userId: string, connectedAccountId: string): FinishedStrategyRunRow[] {
  return getDb()
    .prepare(
      `SELECT status, started_at, summary FROM strategy_runs
       WHERE user_id = ? AND connected_account_id = ? AND status IN ('completed', 'failed')
       ORDER BY started_at DESC LIMIT ?`
    )
    .all(userId, connectedAccountId, MAX_RUN_LOOKBACK) as FinishedStrategyRunRow[];
}

function takeFinishedRunsLoadedForLastAccount(): FinishedStrategyRunRow[] | null {
  const rows = lastFinishedRunsForCaller;
  lastFinishedRunsForCaller = null;
  return rows;
}

/** Durable settings prefix for the run-failure watchdog episode (`run-failure-watchdog.ts` writes it). */
export const RUN_FAILURE_WATCH_STATE_PREFIX = "runFailureWatch";

/** Settings key whose JSON may carry `rearmedAt` after the owner sets the account active again. */
export function runFailureWatchStateKey(userId: string, connectedAccountId: string): string {
  return `${RUN_FAILURE_WATCH_STATE_PREFIX}:${userId}:${connectedAccountId}`;
}

/**
 * ISO instant the owner re-armed this account, or null when no fresh episode is open.
 *  `/api/health` uses it so `maxConsecutiveFailedRuns` is the post-re-arm streak: failures
 *  that started before the re-arm stay in the run log but do not keep the public streak at
 *  the halt-time count.  A missing or unreadable row means "no window" (the raw streak).
 */
export function runFailureRearmCutoff(userId: string, connectedAccountId: string): string | null {
  try {
    const raw = getInternalSetting<{ rearmedAt?: unknown }>(runFailureWatchStateKey(userId, connectedAccountId));
    if (!raw || typeof raw.rearmedAt !== "string" || raw.rearmedAt.length === 0) return null;
    return Number.isFinite(Date.parse(raw.rearmedAt)) ? raw.rearmedAt : null;
  } catch {
    return null;
  }
}

/**
 * Leading failed-run count, newest first.  When `startedAfter` is set, a run counts only
 *  when its `started_at` is strictly later.  An equal timestamp is not after the re-arm, and
 *  a missing timestamp cannot be shown to be after it, so both stop the walk.  A completed
 *  run still breaks the streak.
 */
export function countLeadingFailedRuns(
  rows: Array<{ status: string; started_at?: string | null }>,
  startedAfter: string | null
): number {
  const cutoffMs = startedAfter ? Date.parse(startedAfter) : Number.NaN;
  const gated = Number.isFinite(cutoffMs);
  let consecutiveFailedRuns = 0;
  for (const row of rows) {
    if (gated) {
      const startedMs = Date.parse(row.started_at ?? "");
      if (!Number.isFinite(startedMs) || startedMs <= cutoffMs) break;
    }
    if (row.status === "completed") break;
    if (row.status !== "failed") break;
    consecutiveFailedRuns++;
  }
  return consecutiveFailedRuns;
}

/** Like `countLeadingFailedRuns`, but only rows that count toward auto-halt. */
export function countLeadingHaltEligibleFailedRuns(
  rows: Array<{ status: string; started_at?: string | null; summary?: string | null }>,
  startedAfter: string | null
): number {
  const cutoffMs = startedAfter ? Date.parse(startedAfter) : Number.NaN;
  const gated = Number.isFinite(cutoffMs);
  let consecutiveHaltEligibleFailures = 0;
  for (const row of rows) {
    if (gated) {
      const startedMs = Date.parse(row.started_at ?? "");
      if (!Number.isFinite(startedMs) || startedMs <= cutoffMs) break;
    }
    if (row.status === "completed") break;
    if (row.status !== "failed") break;
    if (strategyRunCountsTowardAutoHalt({ summary: row.summary })) consecutiveHaltEligibleFailures++;
  }
  return consecutiveHaltEligibleFailures;
}

/** True when any finished success or failure started strictly after `startedAfter`. */
export function hasFinishedRunStartedAfter(
  userId: string,
  connectedAccountId: string,
  startedAfter: string
): boolean {
  if (!Number.isFinite(Date.parse(startedAfter))) return false;
  try {
    const row = getDb()
      .prepare(
        `SELECT 1 AS ok FROM strategy_runs
         WHERE user_id = ? AND connected_account_id = ? AND status IN ('completed', 'failed')
           AND started_at > ?
         LIMIT 1`
      )
      .get(userId, connectedAccountId, startedAfter) as { ok: number } | undefined;
    return Boolean(row);
  } catch {
    return false;
  }
}

/** Minutes without a COMPLETED run (for an active-autonomy account) before it's reported stale. */
export function tradingLivenessStaleMinutes(): number {
  const raw = Number(process.env.TRADING_LIVENESS_STALE_MINUTES);
  return Number.isFinite(raw) && raw > 0 ? raw : 180;
}

/** Consecutive failed runs (for an active-autonomy account) before it's reported degraded. */
export function tradingLivenessMaxConsecutiveFailures(): number {
  const raw = Number(process.env.TRADING_LIVENESS_MAX_CONSECUTIVE_FAILURES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 3;
}

export interface AccountTradingLiveness {
  userId: string;
  connectedAccountId: string;
  label: string;
  /** ISO finished_at of the most recent status='completed' run, or null if none exists. */
  lastCompletedRunAt: string | null;
  /** Age of lastCompletedRunAt in seconds, or null when there is no completed run yet. */
  lastCompletedRunAgeSeconds: number | null;
  /** Failed runs, most-recent-first, before hitting a completed run (capped at MAX_RUN_LOOKBACK).
   *  Includes app-stall and mid-run-restart failures.  Alert, backoff, and `consecutive_failures`
   *  use this count. */
  consecutiveFailedRuns: number;
  /** Subset of `consecutiveFailedRuns` that may auto-halt.  App stalls and process restarts
   *  mid-run are omitted.  Broker and LLM failures are kept.  See
   *  `strategyRunCountsTowardAutoHalt`. */
  consecutiveHaltEligibleFailures: number;
  /** decide = Autopilot (app places trades).  propose = Running / ask-first. */
  strategyAuthority?: string;
  /** Whether the US equity market was open (regular session) at evaluation time — see the
   *  module docstring for why `stale_last_completed_run` is gated on this. */
  marketOpen: boolean;
  degraded: boolean;
  degradedReasons: Array<"stale_last_completed_run" | "consecutive_failures" | "autonomy_fully_dark">;
}

/** Why a fleet eligible to trade is not trading — see the module docstring's
 *  `autonomy_fully_dark` section, which is the incident that motivated it. */
export interface AutonomyDarkness {
  /** Accounts that COULD trade: autopilot authority, connected with an account number, not parked,
   *  not draining.  Deliberately narrower than "all accounts" — a parked account is quiet on
   *  purpose and must never be counted as an outage. */
  eligibleAccounts: number;
  /** Of those, how many are actually `systemState === "active"`. */
  activeAccounts: number;
  /** Labels of the eligible-but-not-active accounts, capped, for a human to act on. */
  darkAccountLabels: string[];
  /** True when eligibleAccounts > 0 and activeAccounts === 0 — the whole fleet is dark. */
  fullyDark: boolean;
}

export interface TradingLivenessSummary {
  staleMinutes: number;
  maxConsecutiveFailures: number;
  /** Whether the US equity market was open (regular session) at evaluation time; same value
   *  every account in this summary was evaluated against (one `now` for the whole pass). */
  marketOpen: boolean;
  accounts: AccountTradingLiveness[];
  degraded: boolean;
  /** Fleet-level "nothing is trading" signal.  Populated even when `accounts` is empty, because
   *  zero ACTIVE accounts is precisely the case the per-account list cannot express. */
  darkness?: AutonomyDarkness;
}

/**
 * Public `/api/health` aggregate.  Always emitted so UptimeRobot/Pushover can key
 * on `tradingLiveness.degraded` (count) without the object disappearing when
 * every account is halted.  Never includes user/account identity.
 */
export interface PublicTradingLiveness {
  activeAccounts: number;
  autopilotAccounts: number;
  runningAskFirstAccounts: number;
  /** Count of degraded active-autonomy accounts.  Keyword monitors use the sibling
   *  `tradingLivenessDegraded` boolean; JSON-path monitors use this number `> 0`. */
  degraded: number;
  oldestCompletedRunAgeSeconds: number | null;
  /** Worst consecutive-failure streak across active-autonomy accounts.  Without this a JSON-path
   *  monitor sees only `degraded > 0` and cannot tell an account failing every run from ordinary
   *  out-of-session silence — the two want very different responses.  Identity-free: a max across
   *  accounts, never per-account.  After an owner re-arm this is the post-re-arm streak (runs
   *  whose `started_at` is after `rearmedAt`), not the historical halt-time count. */
  maxConsecutiveFailedRuns: number;
  /** Distinct reasons currently degrading at least one account, so ops can route on the CAUSE
   *  rather than inferring it from `oldestCompletedRunAgeSeconds` and the clock.  Includes the
   *  fleet-level `autonomy_fully_dark`, which is why it can be non-empty while `degraded` is 0. */
  degradedReasons: Array<"stale_last_completed_run" | "consecutive_failures" | "autonomy_fully_dark">;
  marketOpen: boolean;
  /** Identity-free counts for the "nothing is trading" signal — see AutonomyDarkness. Present on
   *  every response (zeros when there is nothing eligible) so a JSON-path monitor can alert on
   *  `.autonomyFullyDark == true` without a null-vs-object special case. */
  autonomyEligibleAccounts: number;
  autonomyActiveAccounts: number;
  autonomyFullyDark: boolean;
}

export function toPublicTradingLiveness(
  summary: TradingLivenessSummary | null,
  now: number = Date.now()
): PublicTradingLiveness {
  if (!summary) {
    // A null summary now means "no eligible account exists at all", NOT "no active account" — the
    // fully-dark case returns a real summary carrying `darkness` (see getTradingLivenessSummary).
    return {
      activeAccounts: 0,
      autopilotAccounts: 0,
      runningAskFirstAccounts: 0,
      degraded: 0,
      oldestCompletedRunAgeSeconds: null,
      maxConsecutiveFailedRuns: 0,
      degradedReasons: [],
      marketOpen: isMarketOpen(new Date(now)),
      autonomyEligibleAccounts: 0,
      autonomyActiveAccounts: 0,
      autonomyFullyDark: false
    };
  }
  const degradedCount = summary.accounts.filter((a) => a.degraded).length;
  const oldestCompletedRunAgeSeconds = summary.accounts.reduce<number | null>((oldest, a) => {
    if (a.lastCompletedRunAgeSeconds === null) return oldest;
    return oldest === null ? a.lastCompletedRunAgeSeconds : Math.max(oldest, a.lastCompletedRunAgeSeconds);
  }, null);
  const maxConsecutiveFailedRuns = summary.accounts.reduce(
    (worst, a) => Math.max(worst, a.consecutiveFailedRuns),
    0
  );
  // Union the reasons from the DEGRADED accounts only — a healthy account contributes none, so an
  // empty array always means "nothing is degraded right now".
  const degradedReasons = [
    ...new Set([
      ...summary.accounts.filter((a) => a.degraded).flatMap((a) => a.degradedReasons),
      // The fleet-level reason is not attached to any account row (there are none active by
      // definition), so it is unioned in here where the public shape is built.
      ...(summary.darkness?.fullyDark ? (["autonomy_fully_dark"] as const) : [])
    ])
  ];
  return {
    activeAccounts: summary.accounts.length,
    autopilotAccounts: summary.accounts.filter((a) => a.strategyAuthority === "decide").length,
    runningAskFirstAccounts: summary.accounts.filter((a) => a.strategyAuthority !== "decide").length,
    degraded: degradedCount,
    oldestCompletedRunAgeSeconds,
    maxConsecutiveFailedRuns,
    degradedReasons,
    marketOpen: summary.marketOpen,
    autonomyEligibleAccounts: summary.darkness?.eligibleAccounts ?? 0,
    autonomyActiveAccounts: summary.darkness?.activeAccounts ?? 0,
    autonomyFullyDark: summary.darkness?.fullyDark ?? false
  };
}

/**
 * True when a failed strategy run may advance the auto-halt streak.
 *
 * Exempt (return false) — still a failure for alert, backoff, and the degraded streak:
 *   - stale-run sweep `strategy_run_crashed` causes `process_restarted_mid_run` and
 *     `stalled_no_progress` (summaries written by `staleRunningRunSweepSummary`, plus the
 *     audit `haltExempt` flag those receipts share)
 *   - summaries the scheduler already attributes to the app: "App process was stalled",
 *     "broker not at fault", or an event-loop stall that "dominated the window"
 *
 * Still counted: broker HTTP failures, LLM/provider failures, and a lane deadline that only
 * reports a measured stall (`event-loop stall=120ms`) without claiming the stall dominated.
 * That parenthetical is a broker timeout with a stall measurement, not an app-fault label.
 */
export function strategyRunCountsTowardAutoHalt(input: {
  summary?: string | null;
  crashReason?: string | null;
  haltExempt?: boolean | null;
}): boolean {
  if (input.haltExempt === true) return false;
  const reason = (input.crashReason ?? "").trim();
  if (reason === "process_restarted_mid_run" || reason === "stalled_no_progress") return false;
  const text = (input.summary ?? "").toLowerCase();
  if (text.includes("process restarted mid-run")) return false;
  if (text.includes("stalled with no progress")) return false;
  if (text.includes("app process was stalled")) return false;
  if (text.includes("broker not at fault")) return false;
  const stallDominated =
    (text.includes("event-loop stall") || text.includes("event loop stall")) &&
    text.includes("dominated the window");
  if (stallDominated) return false;
  return true;
}

/**
 * Compute the liveness dimension for one (userId, connectedAccountId). Read-only against
 * strategy_runs; the caller decides what "active autonomy" means (this function doesn't check
 * systemState itself, so it can also be reused for diagnostics on a halted account).
 */
export function computeAccountTradingLiveness(
  userId: string,
  connectedAccountId: string,
  label: string,
  now: number = Date.now()
): AccountTradingLiveness {
  lastFinishedRunsForCaller = null;
  const staleMinutes = tradingLivenessStaleMinutes();
  const maxConsecutiveFailures = tradingLivenessMaxConsecutiveFailures();
  const db = getDb();

  const lastCompleted = db
    .prepare(
      `SELECT finished_at FROM strategy_runs
       WHERE user_id = ? AND connected_account_id = ? AND status = 'completed'
       ORDER BY started_at DESC LIMIT 1`
    )
    .get(userId, connectedAccountId) as { finished_at: string | null } | undefined;
  const lastCompletedRunAt = lastCompleted?.finished_at ?? null;
  const lastCompletedRunAgeSeconds = lastCompletedRunAt
    ? Math.max(0, Math.round((now - new Date(lastCompletedRunAt).getTime()) / 1000))
    : null;

  // Walk the most recent finished (non-'running') runs newest-first, counting a leading streak of
  // 'failed' rows until the first 'completed' row (or the lookback cap) breaks it.  A run still
  // 'running' is neither a success nor a failure yet, so it's excluded rather than resetting or
  // extending the streak.
  //
  // After an owner re-arm, only runs that STARTED after `rearmedAt` count.  The historical
  // streak (and a run that was already in flight at re-arm time) stays in the table but must
  // not keep `/api/health` at the halt-time count.  `stale_last_completed_run` is unchanged:
  // it still reports the real age of the last completed run.
  //
  // App-stall / mid-run-restart failures stay in the full streak (alert and backoff) and are
  // skipped only for the auto-halt subset (`consecutiveHaltEligibleFailures`).
  const rearmCutoff = runFailureRearmCutoff(userId, connectedAccountId);
  const recentFinished = loadRecentFinishedRuns(userId, connectedAccountId);
  lastFinishedRunsForCaller = recentFinished;
  const consecutiveFailedRuns = countLeadingFailedRuns(recentFinished, rearmCutoff);
  const consecutiveHaltEligibleFailures = countLeadingHaltEligibleFailedRuns(recentFinished, rearmCutoff);

  const marketOpen = isMarketOpen(new Date(now));

  const degradedReasons: AccountTradingLiveness["degradedReasons"] = [];
  // Staleness only counts as degraded while the market is open — see the module docstring. A
  // stale run reported while the market is closed is expected (the scheduler isn't running), not
  // a signal a human needs to act on.
  if (
    marketOpen &&
    lastCompletedRunAgeSeconds !== null &&
    lastCompletedRunAgeSeconds > staleMinutes * 60
  ) {
    degradedReasons.push("stale_last_completed_run");
  }
  if (consecutiveFailedRuns >= maxConsecutiveFailures) {
    degradedReasons.push("consecutive_failures");
  }

  return {
    userId,
    connectedAccountId,
    label,
    lastCompletedRunAt,
    lastCompletedRunAgeSeconds,
    consecutiveFailedRuns,
    consecutiveHaltEligibleFailures,
    marketOpen,
    degraded: degradedReasons.length > 0,
    degradedReasons
  };
}

/**
 * Trading-liveness across every account with active autonomy (policy.systemState === "active"),
 * for every user. Returns null when there are zero such accounts — the dimension is omitted
 * rather than reported "healthy" for a fleet that isn't trading (nothing to be live about).
 * Never throws: a per-account read error is skipped rather than breaking the whole summary, and a
 * top-level error (e.g. DB unreachable) returns null the same as "no active accounts" — callers
 * that need to distinguish should check DB health separately (this module is not the DB probe).
 */
/** Cap on the dark-account labels reported, so one user with many halted accounts cannot turn
 *  a health payload into a list. */
const MAX_DARK_LABELS = 12;

/**
 * Accounts that COULD trade but are not.
 *
 * Eligibility is deliberately narrow. A PARKED account is quiet on purpose (review rank 8) and a
 * DRAINING one is being disconnected; counting either as an outage would page the owner about a
 * decision they made. An account with no broker account number has never synced and has nothing to
 * trade. Only an account that is connected, on autopilot authority, not parked and not draining is
 * genuinely expected to be trading — so only those count.
 */
function computeAutonomyDarkness(now: number = Date.now()): AutonomyDarkness {
  const darkAccountLabels: string[] = [];
  let eligibleAccounts = 0;
  let activeAccounts = 0;
  for (const userId of listUsers()) {
    for (const account of listConnectedAccounts(userId)) {
      try {
        const policy = peekPolicy(userId, account.id);
        if (policy.strategyAuthority !== "decide") continue; // ask-first/Running is not Autopilot
        if (account.isDraining) continue; // being disconnected — quiet on purpose
        if (account.parked) continue; // parked on purpose (review rank 8)
        if (!account.accountNumber) continue; // never synced; nothing to trade
        eligibleAccounts += 1;
        if (policy.systemState === "active") {
          activeAccounts += 1;
        } else if (darkAccountLabels.length < MAX_DARK_LABELS) {
          darkAccountLabels.push(account.label || account.broker);
        }
      } catch {
        // An unreadable policy is not evidence of darkness — skip it rather than over-count.
      }
    }
  }
  return {
    eligibleAccounts,
    activeAccounts,
    darkAccountLabels,
    // The whole fleet is dark only when there was someone to trade and nobody is.
    fullyDark: eligibleAccounts > 0 && activeAccounts === 0
  };
}

export function getTradingLivenessSummary(
  now: number = Date.now(),
  finishedRunsOut?: Map<string, FinishedStrategyRunRow[]>
): TradingLivenessSummary | null {
  try {
    const accounts: AccountTradingLiveness[] = [];
    for (const userId of listUsers()) {
      for (const account of listConnectedAccounts(userId)) {
        try {
          const policy = peekPolicy(userId, account.id);
          if (policy.systemState !== "active") continue;
          const computed = computeAccountTradingLiveness(userId, account.id, account.label || account.broker, now);
          const rows = takeFinishedRunsLoadedForLastAccount();
          if (finishedRunsOut && rows) finishedRunsOut.set(`${userId}:${account.id}`, rows);
          accounts.push({
            ...computed,
            strategyAuthority: policy.strategyAuthority
          });
        } catch {
          takeFinishedRunsLoadedForLastAccount();
          // Skip an unreadable account's policy/runs rather than failing the whole summary.
        }
      }
    }
    // Computed even when `accounts` is empty — that is exactly the case it exists to catch.
    const darkness = computeAutonomyDarkness(now);
    if (accounts.length === 0) {
      // Previously: `return null`, which /api/health renders as tradingLivenessDegraded: false.  A
      // fully dark fleet is not "no data", it is the worst data there is, so return the summary and
      // let `degraded` carry the signal.  A genuinely empty fleet (no eligible accounts at all)
      // still returns null, because there is genuinely nothing to be live about.
      if (!darkness.fullyDark) return null;
      return {
        staleMinutes: tradingLivenessStaleMinutes(),
        maxConsecutiveFailures: tradingLivenessMaxConsecutiveFailures(),
        marketOpen: isMarketOpen(new Date(now)),
        accounts: [],
        degraded: true,
        darkness
      };
    }
    return {
      staleMinutes: tradingLivenessStaleMinutes(),
      maxConsecutiveFailures: tradingLivenessMaxConsecutiveFailures(),
      marketOpen: isMarketOpen(new Date(now)),
      accounts,
      // `degraded` is now the OR of the two conditions, so a fleet that still has one active
      // account but has lost the rest is not silently reported as fine either.
      degraded: accounts.some((a) => a.degraded) || darkness.fullyDark,
      darkness
    };
  } catch {
    lastFinishedRunsForCaller = null;
    return null;
  }
}
