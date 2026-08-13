// Background scheduler for autonomous strategy runs.
//
// Dev note: Next.js HMR may hot-reload modules, but the `if (timer) return` guard
// plus Node module caching ensures startScheduler() is effectively a no-op on
// subsequent calls within the same process. In production (`next start`) it runs once.

import { LANE_WAITS, withAccountMutation } from "./account-mutation";
import { checkAllUserPriceAlerts } from "./alerts";
import { runCongressDailyShareIfDue } from "./congress-share";
import { runMarketScanFreshnessIfDue } from "./market-scan-freshness";
import { runHealthLaneReprobeIfDue } from "./health-lane-reprobe";
import { audit, getActiveConnectedAccount, getAutoResumeOnBoot, getInternalSetting, getLastStrategyRunStartedAt, getPolicy, listConnectedAccounts, listUsers, listWatchlistSymbols, setInternalSetting, setPolicy, purgeConnectedAccount } from "./db";
import { isEarningsCallsRefreshDue, refreshEarningsCallsTranscriptsIfDue } from "./earningscalls-transcripts";
import { isRoicTranscriptRefreshDue, refreshRoicTranscriptsIfDue } from "./web-sources/roic-transcripts";
import { runDailyLearningReviewIfDue } from "./learning-review";
import { isRunAllowedNow } from "./market-hours";
import { runProviderTierCheckIfDue } from "./provider-tier";
import { runR2UsageCheckIfDue, runR2UsageDailyDigestIfDue } from "./r2-usage";
import { runWatchlistDigestIfDue } from "./watchlist-digest";
import { runAuditPruneIfDue } from "./audit-prune";
import { applyBrokerOrderPlacementPause, checkBrokerHealth } from "./broker-health";
import { sendNotification } from "./notifications";
import { expireStalePendingProposals } from "./proposal-revalidation";
import { markStaleRunningRuns } from "./db-execution";
import { checkRegimeFlip } from "./regime-watch";
import { getBrokerGateway } from "./broker";
import { deriveExecutionState } from "./execution-mode";
import { runStrategyOnce, type StrategyResult } from "./strategy";
import { checkMonthlyLlmSpendCeiling } from "./llm-budget";
import { maybeAutoTuneWeights } from "./auto-tune-scheduler";
import { notifyStaleLimitOrders } from "./stale-limit-orders";
import { autoRemediateStaleExitOrders } from "./order-replacement";
import { runSyntheticStopMonitor } from "./synthetic-stops";
import { isLiveOrderState } from "./broker-side";
import type { EquityOrder, TradingPolicy } from "./types";
import { cadenceLaneDecision, drainMaterialEventQueue } from "./triggers";
import {
  getTechnicalWatchlist,
  isFilingIngestDue,
  isFmpTranscriptRefreshDue,
  refreshDueWebSources,
  refreshFilingBodies,
  refreshFmpTranscripts
} from "./web-sources";
import { symbolsForPolicyUniverse } from "./index-universes";
import { acquireOrRenewLeadership, releaseLease, LEASE_OWNER } from "./scheduler-lease";
import { reconcilePendingFills } from "./strategy-execution";
import { safeErrorMessage } from "./telemetry-sanitize";
import { runStPrimaryBridgeWriterIfDue } from "./st-primary-bridge-writer";
import { journalLane } from "./task-journal";
import { pruneTaskJournal } from "./db-task-journal";

const TICK_MS = 60_000; // check every 60s; cadence changes take effect within one tick
export const MANAGED_VECTOR_RECONCILE_LAST_ATTEMPT_KEY = "scheduler:managedVectorReconcile:lastAttempt";
export const MANAGED_VECTOR_RECONCILE_LAST_SUCCESS_KEY = "scheduler:managedVectorReconcile:lastSuccess";
export const MANAGED_VECTOR_RECONCILE_SUCCESS_INTERVAL_MS = 24 * 60 * 60 * 1_000;
export const MANAGED_VECTOR_RECONCILE_RETRY_INTERVAL_MS = 60 * 60 * 1_000;

type PersistedTimestamp = string | number | null | undefined;

function timestampMs(value: PersistedTimestamp): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function elapsed(now: number, marker: PersistedTimestamp, intervalMs: number): boolean {
  const markerMs = timestampMs(marker);
  return markerMs === undefined || now - markerMs >= intervalMs;
}

/** Pure cadence decision for the global managed-vector repair pass. */
export function isManagedVectorReconcileDue(
  now: number,
  lastAttemptAt?: PersistedTimestamp,
  lastSuccessAt?: PersistedTimestamp
): boolean {
  if (!Number.isFinite(now)) return false;
  if (!elapsed(now, lastSuccessAt, MANAGED_VECTOR_RECONCILE_SUCCESS_INTERVAL_MS)) return false;
  return elapsed(now, lastAttemptAt, MANAGED_VECTOR_RECONCILE_RETRY_INTERVAL_MS);
}

export type ManagedVectorReconcileRun = {
  status: "success" | "busy" | "failed";
  result?: { skipped?: boolean };
};

export function drainingAccountLiveOrders(orders: readonly EquityOrder[]): EquityOrder[] {
  return orders.filter((order) => isLiveOrderState(order.state));
}

const managedVectorReconcileGuardHost = globalThis as unknown as {
  __schedulerManagedVectorReconcileInFlight?: Promise<ManagedVectorReconcileRun | null>;
};

/**
 * Run the global managed-vector repair pass when its persisted cadence allows it.
 *
 * This is intentionally independent of user/account state: the reconciler's default scope is the
 * global `local` tenant. The promise guard is pinned to globalThis so HMR/module duplication cannot
 * start a second provider/SQLite repair in the same process.
 */
export async function reconcileManagedVectorRecordsIfDue(now = Date.now()): Promise<ManagedVectorReconcileRun | null> {
  const existing = managedVectorReconcileGuardHost.__schedulerManagedVectorReconcileInFlight;
  if (existing) return existing;

  const run = (async (): Promise<ManagedVectorReconcileRun | null> => {
    try {
      const lastAttemptAt = getInternalSetting<PersistedTimestamp>(MANAGED_VECTOR_RECONCILE_LAST_ATTEMPT_KEY);
      const lastSuccessAt = getInternalSetting<PersistedTimestamp>(MANAGED_VECTOR_RECONCILE_LAST_SUCCESS_KEY);
      if (!isManagedVectorReconcileDue(now, lastAttemptAt, lastSuccessAt)) return null;

      setInternalSetting(MANAGED_VECTOR_RECONCILE_LAST_ATTEMPT_KEY, new Date(now).toISOString());
      const { reconcileManagedVectorRecords } = await import("./vector-db");
      // Scheduled maintenance is observation-only. Provider list inventory is eventually
      // consistent, so destructive repair requires an explicit operator invocation after review.
      const result = await reconcileManagedVectorRecords({ dryRun: true });
      if (result.skipped) {
        console.warn("[scheduler] managed-vector reconciliation busy; retry deferred");
        return { status: "busy", result };
      }

      setInternalSetting(MANAGED_VECTOR_RECONCILE_LAST_SUCCESS_KEY, new Date(now).toISOString());
      return { status: "success", result };
    } catch (error) {
      console.error(`[scheduler] managed-vector reconciliation failed: ${safeErrorMessage(error)}`);
      return { status: "failed" };
    }
  })();

  const guardPromise = run;
  managedVectorReconcileGuardHost.__schedulerManagedVectorReconcileInFlight = guardPromise;
  try {
    return await run;
  } finally {
    if (managedVectorReconcileGuardHost.__schedulerManagedVectorReconcileInFlight === guardPromise) {
      delete managedVectorReconcileGuardHost.__schedulerManagedVectorReconcileInFlight;
    }
  }
}

/**
 * Single-leader is the fail-safe default. Unset, empty, and whitespace-only values stay ON;
 * operators must use an explicit non-truthy value (for example false/off/0/no) to disable it.
 */
export function singleLeaderEnabled(rawValue: string | undefined = process.env.SCHEDULER_SINGLE_LEADER): boolean {
  const v = String(rawValue ?? "").trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(v);
}

/**
 * A signal-driven shutdown can interrupt detached broker maintenance that the scheduler already
 * launched. Keep the durable leader lease fenced until its TTL expires; only release once Node's
 * event loop has actually drained and `beforeExit` proves no such work remains.
 */
export const SCHEDULER_LEASE_RELEASE_EVENTS = ["beforeExit"] as const;

export function shouldReleaseSchedulerLeaseOnShutdown(event: "SIGTERM" | "SIGINT" | "beforeExit"): boolean {
  return (SCHEDULER_LEASE_RELEASE_EVENTS as readonly string[]).includes(event);
}

/** Auto-tuning is follow-on work for a successfully completed decision cycle only.
 *  Pure pre-decision skips (budget / market / broker) must not trigger tuning (UX PR-A1). */
export function shouldAutoTuneAfterStrategyRun(result: Pick<StrategyResult, "status">): boolean {
  return result.status === "completed";
}

/** Account-bound scheduler composition kept exportable for deterministic regression coverage. */
export async function runScheduledStrategyAndMaybeTune(
  userId: string,
  connectedAccountId: string,
  now?: number
): Promise<StrategyResult> {
  const result = await runStrategyOnce(userId, { connectedAccountId });
  if (shouldAutoTuneAfterStrategyRun(result)) {
    // Compute after the potentially long run so cadence and daily budget reservation use the
    // follow-up's real day/time. Tests may inject an explicit clock value.
    await maybeAutoTuneWeights(userId, now ?? Date.now(), connectedAccountId);
  }
  return result;
}

// ── Health threshold: abdicate leadership after N consecutive heartbeat failures ──
//
// When the scheduler's heartbeat write (setInternalSetting("scheduler:lastTick", …)) fails, the
// DB is unreachable — the lease operations in the same tick will also fail, so another process can
// acquire it. But we also want the current process to explicitly stop trying + log the event rather
// than spinning on a dead DB. After N consecutive heartbeat failures, the leader releases its lease
// and this tick returns early. A successful heartbeat resets the counter.
//
// Pinned to globalThis so Next.js HMR re-evaluations can't reset the counter mid-run.

const healthFailuresHost = globalThis as unknown as { __schedulerHealthFailures?: number };
const DEFAULT_HEALTH_FAILURE_THRESHOLD = 5;

function healthFailureThreshold(): number {
  const v = Number(process.env.SCHEDULER_HEALTH_FAILURE_THRESHOLD);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_HEALTH_FAILURE_THRESHOLD;
}

function incrementHealthFailures(): number {
  const current = healthFailuresHost.__schedulerHealthFailures ?? 0;
  healthFailuresHost.__schedulerHealthFailures = current + 1;
  return current + 1;
}

function resetHealthFailures(): void {
  healthFailuresHost.__schedulerHealthFailures = 0;
}

function getHealthFailures(): number {
  return healthFailuresHost.__schedulerHealthFailures ?? 0;
}

/** Exported for tests — asserts the env gate and that failures can never propagate. */
export function _schedulerTickHealthCheck(): { failures: number; threshold: number; heartbeatOk: boolean } {
  return { failures: getHealthFailures(), threshold: healthFailureThreshold(), heartbeatOk: true };
}

// Sentry Crons heartbeat for the scheduler tick. Addresses a confirmed monitoring gap: a
// dead/hung scheduler still leaves /api/health returning 200, so an external dead-man's-switch
// is needed. When enabled, every tick reports "ok" to the 'scheduler-tick' monitor and Sentry
// alerts when check-ins stop arriving. Opt-in — requires BOTH SENTRY_DSN (the SDK is only
// initialized in instrumentation.ts when it is set) AND SENTRY_CRONS_ENABLED=1 — and fully
// try/catch-wrapped: monitoring must never be able to break trading.
export const SENTRY_CRON_MONITOR_SLUG = "scheduler-tick";

function sentryCronsEnabled(): boolean {
  return Boolean(process.env.SENTRY_DSN) && process.env.SENTRY_CRONS_ENABLED === "1";
}

/** Exported for tests only — asserts the env gate and that failures can never propagate. */
export async function sendSentrySchedulerCheckIn(): Promise<void> {
  if (!sentryCronsEnabled()) return;
  try {
    // Dynamic import keeps the Sentry SDK out of the module graph of every scheduler consumer
    // (tests, API routes) and makes the disabled path a true no-op. Interop note: depending on
    // the module system the CJS exports can surface on `.default` instead of as named exports
    // (raw Node ESM import of @sentry/nextjs does this), so resolve defensively and silently
    // skip — never throw — if the API is unavailable.
    const mod = (await import("@sentry/nextjs")) as typeof import("@sentry/nextjs") & {
      default?: typeof import("@sentry/nextjs");
    };
    const captureCheckIn = mod.captureCheckIn ?? mod.default?.captureCheckIn;
    if (typeof captureCheckIn !== "function") return;
    // The upsert monitor config auto-creates/updates the monitor on first check-in: expected
    // every minute (TICK_MS), flagged missed after a 5-minute margin.
    captureCheckIn(
      { monitorSlug: SENTRY_CRON_MONITOR_SLUG, status: "ok" },
      {
        schedule: { type: "interval", value: 1, unit: "minute" },
        checkinMargin: 5,
        maxRuntime: 10,
        timezone: "UTC"
      }
    );
  } catch (err) {
    console.error("[scheduler] sentry cron check-in error:", err);
  }
}

let timer: NodeJS.Timeout | null = null;
// Schedule state is per (userId, connectedAccountId): each connected account runs autonomously on
// its own cadence/state, so two accounts of the same user neither share a cadence clock nor block
// each other. Keyed by scheduleKey(userId, accountId).
const accountSchedules: Record<string, {
  lastRunAt: string | null;
  nextRunAt: string | null;
}> = {};

function scheduleKey(userId: string, connectedAccountId: string): string {
  return `${userId}::${connectedAccountId}`;
}

// Per-(user,account) re-entrancy guard for the synthetic-stop monitor: a slow broker call must not
// let the next 60s tick start a second concurrent monitor for the same account. globalThis-pinned so
// Next.js HMR module duplication can't defeat the guard with two module instances.
const stopGuardHost = globalThis as unknown as { __stopMonitorInFlight?: Set<string> };
const stopMonitorInFlight: Set<string> =
  stopGuardHost.__stopMonitorInFlight ?? (stopGuardHost.__stopMonitorInFlight = new Set<string>());

// Per-account in-flight guard for the stale-limit / auto-remediation pass. Without it, a slow broker
// (the ≥4 sequential round-trips in a cancel-replace can outlast the 60s tick) would let the next tick
// re-process the SAME stale exit and place a SECOND market sell — a double-sell / accidental short.
const staleExitGuardHost = globalThis as unknown as { __staleExitInFlight?: Set<string> };
const staleExitInFlight: Set<string> =
  staleExitGuardHost.__staleExitInFlight ?? (staleExitGuardHost.__staleExitInFlight = new Set<string>());

/**
 * Boot-time autonomy interlock. A persisted `systemState === "active"` must NOT silently resume
 * live/paper order placement after an unattended restart, crash-loop, or DB restore. Unless an
 * operator explicitly opts in (AUTONOMY_RESUME_ON_BOOT=1 env var OR per-user `autoResumeOnBoot`
 * setting), every user left "active" is reverted to "halted" on boot (audited), forcing a human
 * to re-arm autonomy deliberately. "close_only" and "liquidating" are left untouched (they are
 * themselves human-/breaker-set safe states).
 *
 * The env var is a global override — when set, ALL users resume regardless of their per-user
 * toggle. When not set, each user's `autoResumeOnBoot` setting controls their own accounts.
 */
export function reconcileAutonomyOnBoot(): void {
  if (process.env.AUTONOMY_RESUME_ON_BOOT === "1") {
    console.log("[scheduler] AUTONOMY_RESUME_ON_BOOT=1 — persisted 'active' autonomy will resume");
    return;
  }
  // Collect halted accounts per user so we can fire ONE summary notification per boot (not one
  // per account) after the reconcile loop finishes, rather than notifying inline per account.
  const haltedByUser = new Map<string, string[]>();
  for (const userId of listUsers()) {
    // Per-user autoResumeOnBoot setting (default false) — the individual opt-in replaces
    // the old global env var. Each user independently decides whether their accounts resume.
    if (getAutoResumeOnBoot(userId)) {
      console.log(`[scheduler] user ${userId} has autoResumeOnBoot enabled — persisted 'active' autonomy will resume`);
      continue;
    }
    // Reconcile EVERY connected account, not just the active one — a non-active account left
    // "active" would otherwise auto-resume the moment the multi-account scheduler iterates it.
    // A user with no connected accounts still has a base policy (accountId undefined), so reconcile
    // that too (preserves the original single-account interlock behavior).
    const accounts = listConnectedAccounts(userId);
    const accountIds: Array<string | undefined> = accounts.map((a) => a.id);
    if (accountIds.length === 0) accountIds.push(undefined);
    for (const accountId of accountIds) {
      try {
        const policy = getPolicy(userId, accountId);
        if (policy.systemState === "active") {
          setPolicy({ ...policy, systemState: "halted" }, userId, accountId);
          audit("autonomy_halted_on_boot", { from: "active", to: "halted", reason: "autoResumeOnBoot not enabled" }, userId, accountId);
          console.warn(`[scheduler] autonomy was 'active' for ${userId}/${accountId ?? "(base)"} at boot; reverted to 'halted' (enable autoResumeOnBoot in Settings to auto-resume).`);
          const label = accountId ? (accounts.find((a) => a.id === accountId)?.label ?? accountId) : "(base account)";
          const labels = haltedByUser.get(userId) ?? [];
          labels.push(label);
          haltedByUser.set(userId, labels);
        }
      } catch (err) {
        console.error(`[scheduler] boot autonomy reconcile failed for ${userId}/${accountId ?? "(base)"}:`, err);
      }
    }
  }
  // Fire-and-forget: notification delivery must never block or fail boot. sendNotification already
  // catches its own channel errors internally, but this catch is the backstop against a synchronous
  // throw (e.g. a policy lookup failure) reaching the caller of reconcileAutonomyOnBoot().
  for (const [userId, accountLabels] of haltedByUser) {
    notifyAutonomyHaltedOnBoot(userId, accountLabels).catch((err) => {
      console.error(`[scheduler] boot-halt notification failed for ${userId}:`, err);
    });
  }
}

/** One summary notification per user per boot when reconcileAutonomyOnBoot halted at least one of
 *  their accounts — so a deploy/restart silently disarming live autonomy doesn't go unnoticed until
 *  the owner happens to check Settings. enabledEvents gating is real (owner ruling 2026-08-12: no
 *  toggle is silently overridden) — a persisted policy that predated this event type got it
 *  backfilled once by the db migration (backfillDefaultOnNotificationEvents in db.ts), not
 *  force-included per send. */
async function notifyAutonomyHaltedOnBoot(userId: string, accountLabels: string[]): Promise<void> {
  const accountsList = accountLabels.join(", ");
  const activeAccountId = getActiveConnectedAccount(userId)?.id;
  const policy = getPolicy(userId, activeAccountId);
  const title =
    accountLabels.length === 1
      ? `Autonomy halted on boot: ${accountsList}`
      : `Autonomy halted on boot for ${accountLabels.length} accounts`;
  const body =
    `Autonomy was reverted from 'active' to 'halted' because the app restarted (deploy or crash restart).\n` +
    `Affected account(s): ${accountsList}.\n` +
    `Re-arm autonomy in Settings when ready. To skip this halt on future restarts, enable ` +
    `"auto-resume on boot" for this user in Settings, or set AUTONOMY_RESUME_ON_BOOT=1.`;
  await sendNotification(
    { type: "autonomy_halted_on_boot", title, payload: { accountLabels } },
    { userId, policy, directBody: body }
  );
}

export function getSchedulerState(userId: string = "local", connectedAccountId?: string): {
  lastRunAt: string | null;
  nextRunAt: string | null;
} {
  // Default to the active account's schedule (dashboard shows the active account).
  const accountId = connectedAccountId ?? getActiveConnectedAccount(userId)?.id;
  if (!accountId) return { lastRunAt: null, nextRunAt: null };
  return accountSchedules[scheduleKey(userId, accountId)] ?? { lastRunAt: null, nextRunAt: null };
}

export function startScheduler(): void {
  if (timer) return; // guard against double-start

  // Release only after the event loop drains. SIGTERM/SIGINT intentionally retain the lease until
  // its TTL: signal shutdown can kill detached synthetic-stop/broker work, and immediate release
  // would let a successor duplicate those protective orders before their outcome is known.
  // Guarded by globalThis so HMR re-evaluation cannot double-register the beforeExit listener.
  const shutdownHost = globalThis as unknown as { __schedulerLeaseShutdownRegistered?: boolean };
  if (!shutdownHost.__schedulerLeaseShutdownRegistered) {
    shutdownHost.__schedulerLeaseShutdownRegistered = true;
    const release = () => {
      try { releaseLease(LEASE_OWNER); } catch { /* never throw on shutdown */ }
    };
    for (const event of SCHEDULER_LEASE_RELEASE_EVENTS) process.on(event, release);
  }

  // Boot interlock runs once, before any tick, so a restored/copied DB cannot resume live
  // execution unattended.
  reconcileAutonomyOnBoot();

  // Run a tick immediately on start to schedule Next Run right away
  void tick();

  timer = setInterval(tick, TICK_MS);
  timer.unref(); // don't hold the process open in dev
  console.log("[scheduler] started (tick every 60s)");
}

async function tick(): Promise<void> {
  // Crashed-run sweep: mark strategy_runs left in status='running' after a process crash/kill.
  // Must run BEFORE the single-leader gate so stale rows are always repaired (idempotent: the
  // UPDATE has a `WHERE status = 'running'` guard, so even two concurrent sweeps won't double-count).
  try {
    await journalLane("stale-run-sweep", {}, () => {
      const repaired = markStaleRunningRuns(Date.now());
      if (repaired > 0) console.log(`[scheduler] marked ${repaired} stale running run(s) as failed`);
      return { status: repaired > 0 ? ("ok" as const) : ("skipped" as const), summary: `repaired=${repaired}` };
    });
  } catch (err) {
    console.error("[scheduler] stale-run sweep error:", err);
  }

  // Same repair for the mobile/PWA command queue: claimNextQueuedCommand marks a row 'running' and
  // nothing else in the codebase ever selects that status, so a crash mid-command strands the row
  // forever — which permanently blocks account deletion (activeMobileCommands) and permanently
  // spins the PWA. Placed here for two reasons: before the single-leader gate (like the run sweep,
  // so stale rows are repaired even on a follower — its liveness graces are all durable DB
  // evidence, so a follower cannot misjudge a command the leader is running), and after the run
  // sweep, so a strategy_runs row that sweep just left alive on this same tick still hands its
  // grace through to the strategy.run_once command wrapping it. Dynamic import matches the
  // mobile-command-drain lane below and keeps scheduler -> mobile-api off the static graph.
  try {
    await journalLane("stale-mobile-command-sweep", {}, async () => {
      const { markStaleRunningMobileCommands } = await import("./mobile-api");
      const repaired = markStaleRunningMobileCommands(Date.now());
      if (repaired > 0) console.log(`[scheduler] marked ${repaired} stale running mobile command(s) as failed`);
      return { status: repaired > 0 ? ("ok" as const) : ("skipped" as const), summary: `repaired=${repaired}` };
    });
  } catch (err) {
    console.error("[scheduler] stale mobile-command sweep error:", err);
  }

  // Task-journal retention: 'skipped' heartbeat rows age out in 24h, ok/error in 30d
  // (db-task-journal.ts). One cheap indexed DELETE per tick; never throws.
  pruneTaskJournal();

  // Daily audit_events + provider-observability retention (audit-prune.ts):
  // observability kinds 14d, everything else 90d, bounded batches. First-ever
  // run drains a large backlog over several daily passes. Also sweeps the
  // embed_stage table (35d orphan retention + defensive size cap, db-embed-stage.ts).
  void journalLane("audit-prune", {}, () => {
    const result = runAuditPruneIfDue();
    if (!result) return { status: "skipped" as const, summary: "not due" };
    const total = result.auditObservability + result.auditDefault + result.providerDispatch +
      result.providerOutbox + result.embedStageExpired + result.embedStageCapPruned;
    return { status: "ok" as const, summary: `deleted=${total}` };
  }).catch((err) => console.error("[scheduler] audit prune error:", err));

  // Single-leader gate (default ON, including unset/empty). Only an explicit false/off/0/no-style
  // value disables it; otherwise only the lease holder runs the background updates and per-account tick body
  // — preventing duplicate API scrapes and broker EXIT orders on multi-process deploys.
  if (singleLeaderEnabled() && !acquireOrRenewLeadership(new Date())) {
    return; // not the leader this tick — no side effects
  }

  // Liveness heartbeat — AFTER the leader gate, so a follower that never runs the tick body cannot
  // keep /api/health fresh while the leader is wedged (which would let synthetic stops and strategy
  // runs grow stale without tripping the stale-scheduler check). Also self-guards the health-failure
  // threshold: only the leader tracks heartbeat failures — a follower with a dead DB won't abdicate
  // (it never got past the gate anyway), and the leader does.
  try {
    setInternalSetting("scheduler:lastTick", new Date().toISOString());
    if (getHealthFailures() > 0) resetHealthFailures();
  } catch (err) {
    console.error("[scheduler] heartbeat write error:", err);
    const failures = incrementHealthFailures();
    const threshold = healthFailureThreshold();
    if (failures >= threshold && singleLeaderEnabled()) {
      console.error(
        `[scheduler] health threshold reached (${failures}/${threshold} consecutive heartbeat failures) — abdicating leadership`
      );
      try { releaseLease(LEASE_OWNER); } catch { /* never throw on shutdown */ }
      return; // stop this tick — we can't prove leadership anyway with a dead DB
    }
  }

  // Sentry Crons check-in (opt-in, see sendSentrySchedulerCheckIn above). Deliberately AFTER the
  // single-leader gate: only the process actually running the tick body reports "ok", so a dead
  // leader is not masked by idle followers. Fire-and-forget + self-guarded — can't break a tick.
  void sendSentrySchedulerCheckIn();

  // Drain durable material-event inboxes on every leader tick, independent of SEC ingestion
  // flags. Events may be produced by filings, transcripts, broker state, or operator actions;
  // gating this on one source would strand queued work indefinitely.
  try {
    await journalLane("material-event-drain", {}, () => drainMaterialEventQueue());
  } catch (err) {
    console.error("[scheduler] material-event drain error:", err);
  }

  // Global managed-vector crash repair is cadence-gated and single-flight. It must never block or
  // throw into trading work; failed or lease-busy attempts persist their hourly retry marker.
  void journalLane("managed-vector-reconcile", {}, async () => {
    const run = await reconcileManagedVectorRecordsIfDue();
    if (run === null) return { status: "skipped" as const, summary: "not due" };
    return { status: "ok" as const, summary: `status=${run.status}` };
  }).catch((err) => console.error("[scheduler] managed-vector reconcile journal error:", err));

  // Default-off, cadence-gated export of only the primary local user's Gemini
  // and DeepSeek credentials to the isolated Usage Monitor bridge path. The
  // writer is self-guarded and returns sanitized status codes without throwing
  // into trading work.
  void journalLane("st-primary-bridge-writer", {}, () => runStPrimaryBridgeWriterIfDue()).then((result) => {
    if (result.status === "error") {
      console.error(
        `[scheduler] ST primary credential bridge failed (${result.errorCode ?? "unknown"})`
      );
    }
  }).catch((err) => console.error("[scheduler] ST primary bridge journal error:", err));

  // Refresh backend web sources (congressional trades, etc.) independently of the
  // trading loop — these are low-frequency (cadence-gated, ~daily) data reads that
  // keep the dashboard + agent context fresh even while autonomous trading is paused.
  // Skipped instantly when not yet due; fully self-guarded so it can't break a tick.
  void journalLane("web-source-refresh", {}, () => refreshDueWebSources())
    .catch((err) => console.error("[scheduler] web-source refresh error:", err));

  // Nightly (cadence-gated) market-data paid-tier watchdog: probes the Massive/FMP keys' actual tier
  // and, on a confident "free" detection (e.g. a lapsed sub), notifies + auto-clamps Massive to the
  // free-safe 5/min so the raised paid default can't 429-storm. No-op until due; fully self-guarded.
  void journalLane("provider-tier-check", {}, () => runProviderTierCheckIfDue())
    .catch((err) => console.error("[scheduler] provider-tier check error:", err));

  // Re-open hard-STOPPED Connections health lanes on a 3–6h cadence (or at known
  // quota reset). Prevents "red forever until an agent SSHs" — owner 2026-08-06.
  void journalLane("health-lane-reprobe", {}, () => runHealthLaneReprobeIfDue())
    .catch((err) => console.error("[scheduler] health-lane-reprobe error:", err));

  // Cloudflare R2 free-tier watchdog (owner directive 2026-07-30: never pace >70%
  // of the 10 GiB / 1M Class A / 10M Class B monthly free tier). Cadence-gated
  // (default 6h), leader-only, self-guarded; alerts via notify() on threshold
  // crossings and persists a snapshot for the admin dashboard card.
  void journalLane("r2-usage-check", {}, () => runR2UsageCheckIfDue())
    .catch((err) => console.error("[scheduler] r2 usage check error:", err));

  // Daily R2 free-tier digest (owner opt-in 2026-07-31): fresh check + notify()
  // summary of MTD usage and month-end pace, whether or not anything crossed.
  // Separate watermark from the 6h check; disable with R2_USAGE_DAILY_DIGEST=off.
  void journalLane("r2-usage-daily-digest", {}, () => runR2UsageDailyDigestIfDue())
    .catch((err) => console.error("[scheduler] r2 usage digest error:", err));

  // Opt-in daily watchlist digest (owner default OFF, per-user Settings -> Delivery toggle):
  // once per Central-Time day, at/after 15:15 CT (shortly after US market close), summarizes the
  // watchlist from data the app already persisted (last market scan + recent proposals per
  // symbol) — no provider or LLM calls. Resolves its own due users internally; self-guarded.
  void journalLane("watchlist-digest", {}, () => runWatchlistDigestIfDue())
    .catch((err) => console.error("[scheduler] watchlist digest error:", err));

  // 10-K/10-Q bodies and default-OFF FMP transcripts have separate producer cadences, request
  // budgets, and cursors. They share the durable RAG_REINDEX operation lease and this demand-first
  // symbol collection so both corpora prioritize held/watchlisted/recent-candidate names.
  // Gated on the operator monthly spend ceiling too: RAG (Voyage/Pinecone) spend counts toward
  // LLM_SPEND_CEILING, and this refresh runs BEFORE the strategy-run ceiling check below, so without
  // this guard a breached ceiling would still let the weekly filing-body ingest spend.
  const filingIngestDue = isFilingIngestDue();
  const transcriptIngestDue = isFmpTranscriptRefreshDue();
  if ((filingIngestDue || transcriptIngestDue) && checkMonthlyLlmSpendCeiling().ok) {
    // DEMAND-FIRST ordering: ingestion is capped per run, so queue order decides which
    // symbols' filings the strategy can actually retrieve against. Watchlist names and the
    // last scan's candidate set (which force-includes held positions) go first; the broad
    // index universe fills the tail. Until 2026-07-09 this was one alphabetical Set union,
    // so the corpus warmed from "A" while the names decisions cite waited years.
    const symbolSet = new Set<string>();
    for (const userId of listUsers()) {
      try {
        for (const item of listWatchlistSymbols(userId)) symbolSet.add(item.symbol);
      } catch {
        // don't let a single user's DB error block the others
      }
    }
    for (const s of getTechnicalWatchlist()) symbolSet.add(s);
    for (const userId of listUsers()) {
      try {
        const policy = getPolicy(userId);
        for (const s of symbolsForPolicyUniverse(policy)) symbolSet.add(s);
      } catch {
        // don't let a single user's DB error block the others
      }
    }
    const symbols = Array.from(symbolSet);
    // These producers spend from the same Voyage/Pinecone budgets and share the durable RAG_REINDEX
    // lease. Keep their scheduler admission ordered too, so a same-tick refresh does not make one
    // producer race into a benign busy result while the other starts embedding.
    void (async () => {
      if (filingIngestDue) {
        try {
          await journalLane("filing-body-ingest", { metadata: { symbols: symbols.length } }, () => refreshFilingBodies(symbols));
        } catch (err) {
          console.error("[scheduler] filing-body refresh error:", err);
        }
      }
      if (transcriptIngestDue) {
        try {
          await journalLane("fmp-transcript-ingest", { metadata: { symbols: symbols.length } }, () => refreshFmpTranscripts(symbols));
        } catch {
          // The connector captures sanitized failures in its result/audit. Do not print a thrown
          // provider error here: it could contain request context and transcript bodies are untrusted.
          console.error("[scheduler] FMP transcript refresh failed before a result was recorded");
        }
      }
    })();
  }

  // Once-per-UTC-day EarningsCalls.dev transcript pass (dormant without EARNINGSCALLS_API_KEY;
  // kill-switch EARNINGSCALLS_DISABLED=1). Holdings-first selection, durable 180/month
  // reserve-before-call budget under the plan's HARD 200/month — see
  // src/lib/earningscalls-transcripts.ts. Gated on the monthly LLM/RAG spend ceiling like the
  // filing/FMP-transcript producers above (its ingest spends Voyage/Pinecone), and serialized
  // with them via the shared durable RAG_REINDEX operation lease (acquired inside the producer,
  // like refreshFilingBodies/refreshFmpTranscripts; a busy lease is a benign deferred pass —
  // the daily watermark is untouched, so a later tick retries). Self-guarded.
  if (isEarningsCallsRefreshDue() && checkMonthlyLlmSpendCeiling().ok) {
    void journalLane("earningscalls-refresh", {}, () => refreshEarningsCallsTranscriptsIfDue()).catch((err) =>
      console.error("[scheduler] earningscalls transcript refresh error:", err instanceof Error ? err.message : err)
    );
  }

  // ROIC.ai full-text transcripts (key = opt-in; ROIC_TRANSCRIPTS_DISABLED=1 kill-switch).
  // Prefer this over free EarningsCalls previews when the ROIC individual plan is configured.
  // Holdings → watchlist, last N fiscal quarters, cap ROIC_TRANSCRIPTS_MAX_PER_RUN.
  // Library helpers existed earlier without a scheduler caller — that left zero ROIC saves.
  if (isRoicTranscriptRefreshDue() && checkMonthlyLlmSpendCeiling().ok) {
    void journalLane("roic-transcript-refresh", {}, () => refreshRoicTranscriptsIfDue()).catch((err) =>
      console.error("[scheduler] roic transcript refresh error:", err instanceof Error ? err.message : err)
    );
  }

  // Once-per-day share of company refs + daily closes + the S&P-500 series to congress.trade
  // (App A) so it can avoid spending the shared FMP quota. No-op unless CONGRESS_TRADE_TOKEN +
  // CONGRESS_SHARE_ENABLED are set and the batch hasn't already run today. Fully self-guarded.
  void journalLane("congress-daily-share", {}, () => runCongressDailyShareIfDue(Date.now())).catch((err) =>
    console.error("[scheduler] congress-share daily batch error:", err)
  );

  // Weekend/off-hours Market Scan freshness guarantee: scanMarket otherwise has no scheduled
  // caller, so a Friday-evening scan would sit stale until a user visits the app Monday.
  // Deliberately does NOT pass through isRunAllowedNow/isTradingDay — this is a data-freshness
  // read, not a trading action — and never places an order or invokes the LLM. Cadence-gated on
  // the newest persisted scan's age (default 20h; MARKET_SCAN_FRESHNESS_MAX_AGE_HOURS=0 disables).
  void journalLane("market-scan-freshness", {}, () => runMarketScanFreshnessIfDue(Date.now(), process.uptime())).catch((err) =>
    console.error("[scheduler] market-scan freshness error:", err)
  );

  // Deterministic regime-flip detector (Phase 1) — cheap, self-guarded. Runs per-user so
  // each user's stored regime label is independent; multi-user setups can't share one KV row.
  for (const userId of listUsers()) {
    void journalLane("regime-flip-check", { userId }, () => checkRegimeFlip(userId)).catch((err) =>
      console.error(`[scheduler] regime check error for ${userId}:`, err)
    );
  }

  // Once-per-day LLM learning review (default OFF; policy.learningReviewEnabled): a frontier-class
  // model audits recent learned-context rows + the pending learning queue against a system-history
  // digest, so lessons built on corrupted evidence (execution defects blamed on theses) get caught.
  // Annotate-only unless the owner opted into "decide". No-op unless enabled + due; self-guarded.
  for (const userId of listUsers()) {
    void journalLane("learning-review", { userId }, () => runDailyLearningReviewIfDue(userId)).catch((err) =>
      console.error(`[scheduler] learning-review error for ${userId}:`, err)
    );
  }

  // Once-per-day retrieval-usefulness join (handoff 4.1): credit the analog/coaching vector ids
  // each decision case injected (ragAttributions) with that case's matured outcome, into the
  // retrieval_usefulness_stats aggregates. Bounded batch, credited-ledger watermark (idempotent),
  // SQLite-only — no provider or LLM calls. Advisory observability + a bounded ranking nudge.
  for (const userId of listUsers()) {
    void import("./retrieval-usefulness")
      .then(({ runRetrievalUsefulnessJoinIfDue }) =>
        journalLane("retrieval-usefulness-join", { userId }, () => runRetrievalUsefulnessJoinIfDue(userId))
      )
      .catch((err) => console.error(`[scheduler] retrieval-usefulness join error for ${userId}:`, err));
  }

  // Once-per-day signal-health refresh (r2 lesson: health): pure-arithmetic rolling diagnostics of
  // the LLM's OWN confidenceScore against matured decision outcomes (rank IC + t-stat, quantile
  // buckets, top-K churn, gross vs net) persisted as signal_health_snapshot rows; a confirmed
  // rank-IC drift raises an advisory signal_health alarm — sizing only changes under the opt-in
  // policy.tuning.signalHealthAutoThrottle. SQLite-only, no provider or LLM calls; self-guarded
  // (UTC-day marker) like the retrieval-usefulness join above.
  for (const userId of listUsers()) {
    void import("./signal-health")
      .then(({ runSignalHealthRefreshIfDue }) =>
        journalLane("signal-health-refresh", { userId }, () => runSignalHealthRefreshIfDue(userId))
      )
      .catch((err) => console.error(`[scheduler] signal-health refresh error for ${userId}:`, err));
  }

  // Atlas public-repo port: evaluate armed price alerts against live quotes every tick.
  void journalLane("price-alert-check", {}, () => checkAllUserPriceAlerts())
    .catch((err) => console.error("[scheduler] price-alert check error:", err));

  // Mobile/PWA command gateway: drain queued user commands from the durable queue. Route handlers
  // also kick this worker immediately after enqueueing, but the scheduler makes queued commands
  // recover after a process restart or an interrupted request.
  void import("./mobile-api")
    .then(({ processPendingMobileCommands }) =>
      journalLane("mobile-command-drain", {}, async () => {
        const result = await processPendingMobileCommands({ limit: 5 });
        return { status: result.processed > 0 ? ("ok" as const) : ("skipped" as const), summary: `processed=${result.processed}` };
      })
    )
    .catch((err) => console.error("[scheduler] mobile-command worker error:", err));

  // Durable due-jobs: drain due 15m/1h intraday outcome-sampling jobs (db-jobs.ts + outcome-engine's
  // drainDueIntradaySampleJobs) so sampling survives process downtime instead of depending on a
  // strategy run coincidentally landing inside the narrow tolerance window.
  void import("./outcome-engine")
    .then(({ drainDueIntradaySampleJobs }) =>
      journalLane("due-job-intraday-drain", {}, () => drainDueIntradaySampleJobs())
    )
    .catch((err) => console.error("[scheduler] due-jobs intraday sample drain error:", err));

  // Weekly R2 cold snapshot (owner directive 2026-08-08): second-provider disaster
  // recovery — better-sqlite3 backup() of the live DB, multipart-uploaded to the idle
  // historic R2 bucket (cold-snapshots/app-<date>.db, newest 4 kept). Durable weekly
  // due-job (Sunday ~03:17 UTC; survives downtime), silent no-op without the
  // AWS_R2_HISTORIC_* credentials, budget-guarded against the R2 free tier.
  void import("./r2-cold-snapshot")
    .then(({ ensureR2ColdSnapshotJobScheduled, drainR2ColdSnapshotJobs }) =>
      journalLane("r2-cold-snapshot", {}, async () => {
        ensureR2ColdSnapshotJobScheduled();
        const result = await drainR2ColdSnapshotJobs();
        return {
          status: result.drained > 0 ? ("ok" as const) : ("skipped" as const),
          summary: result.drained > 0 ? `drained=${result.drained} last=${result.lastRun?.status ?? "?"}` : undefined,
        };
      })
    )
    .catch((err) => console.error("[scheduler] r2 cold snapshot error:", err));

  // Weekly truncated-replay lookahead audit (freqtrade lookahead-analysis port): recompute
  // momentum/liquidity factor sub-scores and RAG evidence from data truncated to each sampled
  // decision's date and diff against what was persisted at decision time; everything else is an
  // honest 'unverifiable' receipt. Durable per-user due-job (default weekly; LOOKAHEAD_AUDIT_*
  // knobs; LOOKAHEAD_AUDIT_ENABLED=off is the kill switch). Read-only + advisory — findings and
  // the lookahead_leak notification gate nothing.
  void import("./lookahead-audit")
    .then(({ ensureLookaheadAuditJobsScheduled, drainLookaheadAuditJobs }) =>
      journalLane("lookahead-audit", {}, async () => {
        ensureLookaheadAuditJobsScheduled();
        const result = await drainLookaheadAuditJobs();
        return {
          status: result.drained > 0 ? ("ok" as const) : ("skipped" as const),
          summary:
            result.drained > 0
              ? `drained=${result.drained} verdict=${result.lastResult?.verdict.verdict ?? "?"}`
              : undefined,
        };
      })
    )
    .catch((err) => console.error("[scheduler] lookahead audit error:", err));

  try {

    // ── Operator-level monthly LLM spend ceiling ──────────────────────────────
    // Checked once per tick after the single-leader gate. When breached, the scheduler
    // skips LLM work (strategy runs) for all users but still runs non-LLM safety
    // maintenance: reconciliation, synthetic-stop monitor, stale-limit alerts, etc.
    const monthlyCeiling = checkMonthlyLlmSpendCeiling();
    if (!monthlyCeiling.ok) {
      console.warn(
        `[scheduler] monthly LLM spend ceiling reached: $${monthlyCeiling.totalUsd.toFixed(2)} ` +
        `of $${monthlyCeiling.ceilingUsd?.toFixed(2)} — skipping LLM work for all users this tick`
      );
      // Still run the per-account non-LLM safety tasks below (reconciliation, stop monitor,
      // stale orders, proposal expiry). Only the dueRuns / strategy execution is skipped.
    }

    // --- Per-Account Scheduling ---
    // Each connected account is scheduled independently: its own per-account policy
    // (systemState, cadence, broker) drives whether/when it runs. Autonomy is opt-in per
    // account — only accounts whose own systemState is "active" trade.
    const dueRuns: Array<{
      userId: string;
      accountId: string;
      key: string;
      prevLastRunAt: string | null;
      prevNextRunAt: string | null;
    }> = [];

    for (const userId of listUsers()) {
      for (const account of listConnectedAccounts(userId)) {
        const accountId = account.id;
        const key = scheduleKey(userId, accountId);
        // Owner ruling 2026-08-05: the internal TestBroker adapter (`broker: "test"`) is test
        // infrastructure only. Never schedule LLM strategy autonomy for it — historical "test-local"
        // armed accounts burned shared LLM budget and 429'd live accounts. Protective/reconcile
        // paths below also skip; there is no product execution mode here.
        if (account.broker === "test") {
          if (accountSchedules[key]) accountSchedules[key].nextRunAt = null;
          continue;
        }
        if (!accountSchedules[key]) {
          // Rehydrate this account's cadence clock from its last real run so a restart/HMR/deploy
          // doesn't fire an immediate run regardless of cadence (in-memory state starts empty).
          accountSchedules[key] = {
            lastRunAt: getLastStrategyRunStartedAt(userId, accountId),
            nextRunAt: null
          };
        }
        const schedule = accountSchedules[key];

        const policy = getPolicy(userId, accountId);

        // Deterministic proposal expiry runs independently of the trading cadence so a stale
        // approval queue self-clears even while the system is halted or the market is closed.
        if (policy.accountNumber) {
          void journalLane(
            "proposal-expiry",
            { userId, connectedAccountId: accountId },
            () => expireStalePendingProposals({ userId, policy, accountNumber: policy.accountNumber })
          ).catch((err) => console.error("[scheduler] proposal-expiry error:", err));
        }

        if (!policy.accountNumber) {
          schedule.nextRunAt = null;
          continue;
        }
        const executionState = deriveExecutionState(policy, account);
        const brokerGateway = executionState.submitsBrokerOrders ? getBrokerGateway(policy, userId) : undefined;
        
        if (account.isDraining) {
          if (brokerGateway && policy.accountNumber) {
            const gw = brokerGateway;
            const accountNumber = policy.accountNumber;
            void journalLane("account-drain", { userId, connectedAccountId: accountId }, async () => {
              // §7 slice 3: drain is a multi-cancel + purge sequence — hold the account mutation
              // lease so it cannot interleave with a stop-monitor or replacement window mid-flight.
              // (These are sequence cancels, not the sacred STANDALONE cancel — that stays unleased.)
              const outcome = await withAccountMutation(
                { userId, accountNumber, connectedAccountId: accountId, lane: "account-drain" },
                async () => {
                  const orders = await gw.getEquityOrders(accountNumber);
                  const openOrders = drainingAccountLiveOrders(orders);
                  for (const o of openOrders) {
                    await gw.cancelEquityOrder(accountNumber, o.id).catch((err: unknown) => {
                      console.error(`[scheduler] draining account cancel error for order ${o.id}:`, err);
                    });
                  }
                  await reconcilePendingFills(gw, accountNumber, userId, policy.connectedAccountId);
                  if (openOrders.length === 0) purgeConnectedAccount(accountId, userId);
                  return openOrders.length;
                }
              );
              if (!outcome.acquired) return { status: "skipped" as const, summary: "account mutation lease busy" };
              return { status: "ok" as const, summary: `open=${outcome.value}` };
            }).catch((err: unknown) => console.error("[scheduler] draining account order check error:", err));
          } else {
            purgeConnectedAccount(accountId, userId);
          }
          schedule.nextRunAt = null;
          continue;
        }
        
        if (brokerGateway && !staleExitInFlight.has(key)) {
          staleExitInFlight.add(key);
          const gw = brokerGateway;
          const stalePolicy = policy as TradingPolicy & { accountNumber: string }; // accountNumber checked non-null above
          void journalLane("stale-limit-scan", { userId, connectedAccountId: accountId }, async () => {
            const orders = await gw.getEquityOrders(stalePolicy.accountNumber);
            await notifyStaleLimitOrders({ userId, policy, orders });
            // Auto-cancel-replace stale EXIT limits with market orders (MU deadlock backstop). No-op
            // when disabled; defers to the human on a live account with typed confirmation on. The
            // in-flight guard above + the per-order cooldown inside autoRemediateStaleExitOrders keep
            // a slow broker cancel from triggering a second market sell on the next tick.
            // §7 slice 3: the cancel-then-place bodies run under the account's mutation lease.
            // Bounded wait (not try-once): this lane reaches its acquisition only after a broker
            // read, so a try-once would deterministically lose the phase race to the stop-monitor
            // lane every tick and starve the replacement pump (adversarial-review finding).
            const outcome = await withAccountMutation(
              { userId, accountNumber: stalePolicy.accountNumber, connectedAccountId: accountId, lane: "stale-exit-replacement", waitMs: LANE_WAITS.staleExit },
              (ctx) => autoRemediateStaleExitOrders({ userId, policy: stalePolicy, activeAccount: account, gateway: gw, orders, fence: ctx.assertOwned })
            );
            if (!outcome.acquired) return { status: "skipped" as const, summary: "account mutation lease busy" };
            return undefined;
          })
            .catch((err) => console.error("[scheduler] stale-limit-order handling error:", err))
            .finally(() => staleExitInFlight.delete(key));
        }

        const protectiveState =
          policy.systemState === "active" ||
          policy.systemState === "close_only" ||
          policy.systemState === "liquidating" ||
          (policy.systemState === "halted" && policy.riskRules?.protectWhileHalted === true);

        // R2: synthetic trailing-stop monitor — runs every tick in states where risk-reducing exits
        // are allowed. `close_only` and `liquidating` must not disable the very protection that can
        // reduce exposure after a breaker trips. `halted` remains the only no-order state unless protectWhileHalted is active.
        if (protectiveState && !stopMonitorInFlight.has(key)) {
          stopMonitorInFlight.add(key);
          void journalLane("synthetic-stop-monitor", { userId, connectedAccountId: accountId }, async () => {
            // §7 slice 3: the whole read-decide-mutate pass holds the account mutation lease so
            // its coverage math cannot go stale under a concurrent replacement/drain sequence.
            const outcome = await withAccountMutation(
              { userId, accountNumber: policy.accountNumber, connectedAccountId: accountId, lane: "stop-monitor" },
              (ctx) => runSyntheticStopMonitor(userId, policy, true, undefined, ctx.assertOwned)
            );
            if (!outcome.acquired) return { status: "skipped" as const, summary: "account mutation lease busy" };
            const result = outcome.value;
            return {
              status: "ok" as const,
              summary: `evaluated=${result.evaluated} triggered=${result.triggered} exited=${result.exited}`
            };
          })
            .catch((err) => console.error("[scheduler] synthetic-stop monitor error:", err))
            .finally(() => stopMonitorInFlight.delete(key));
        }

        // Reconcile pending broker fills every tick (independent of the strategy cadence) so a broker
        // order that returned non-filled — common on Robinhood and limit orders — doesn't sit
        // pending_reconciliation until the next strategy run. Applies to broker/paper and broker/live;
        // Test/local has no broker order lifecycle.
        if (brokerGateway) {
          // Captured outside the closure: the !accountNumber `continue` guard above narrows the
          // property here, but property narrowing does not propagate into arrow closures.
          const accountNumber = policy.accountNumber;
          void journalLane(
            "pending-fill-reconcile",
            { userId, connectedAccountId: accountId },
            () => reconcilePendingFills(brokerGateway, accountNumber, userId, policy.connectedAccountId)
          ).catch((err) => console.error("[scheduler] pending-fill reconcile error:", err));
        }

        // Fast pre-proposal broker health gate.
        // E.g., skips queuing an LLM strategy run if the broker is unreachable, account is suspended,
        // order path is down (Tradier OMS 500s, Alpaca trading_blocked), or elevated place failures.
        // Unhealthy + active → auto-halt systemState so future ticks stay paused until recovery.
        const healthSignals = await checkBrokerHealth(userId, account, brokerGateway);
        const pauseResult = await applyBrokerOrderPlacementPause({
          userId,
          connectedAccountId: accountId,
          accountScope: accountId,
          health: healthSignals,
          policy
        });
        if (pauseResult.action === "halted" || pauseResult.action === "resumed") {
          // Policy may have flipped; re-read so the rest of this tick sees durable state.
          const refreshed = getPolicy(userId, accountId);
          policy.systemState = refreshed.systemState;
        }
        if (!healthSignals.isHealthy) {
          console.warn(`[scheduler] Skipping account ${accountId}: ${healthSignals.reason}${pauseResult.action === "halted" ? " (auto-halted)" : ""}`);
          // Journal the suppression itself: an unhealthy gate is exactly the event an operator
          // later asks "why didn't this account trade?" about.
          void journalLane("broker-health-gate", { userId, connectedAccountId: accountId }, () => ({
            status: "ok" as const,
            summary: `suppressed: ${healthSignals.reason ?? "unhealthy"}${pauseResult.action === "halted" ? "; auto-halted" : pauseResult.action === "still_paused" ? "; still paused" : ""}`
          })).catch(() => undefined);
          schedule.nextRunAt = null; // Re-evaluate on next tick without advancing the cadence
          continue;
        }

        if (policy.systemState !== "active") {
          schedule.nextRunAt = null;
          continue;
        }

        // Event-only mode: the trigger engine drives runs; skip the fixed-interval cadence.
        // Resolved PER ACCOUNT (2026-07-28): triggerSettings.enabled/mode fall back to the global
        // TRIGGER_ENGINE/TRIGGER_MODE env, and triggerSettings.fallbackIntervalMinutes keeps a
        // safety-floor cadence alive in event mode (used as this account's cadenceMs instead of
        // runCadenceMinutes). Default — engine off for the account, or mode interval/both —
        // leaves the interval lane byte-identical to before.
        const cadenceLane = cadenceLaneDecision(policy);
        if (!cadenceLane.run) {
          schedule.nextRunAt = null;
          continue;
        }

        if (!isRunAllowedNow(policy.runDuringExtendedHours)) {
          // Market is closed; don't update nextRunAt — it will recalculate when open
          continue;
        }

        const now = Date.now();
        const cadenceMs = cadenceLane.cadenceMinutes * 60_000;

        if (schedule.lastRunAt !== null) {
          const elapsed = now - new Date(schedule.lastRunAt).getTime();
          if (elapsed < cadenceMs) {
            schedule.nextRunAt = new Date(new Date(schedule.lastRunAt).getTime() + cadenceMs).toISOString();
            continue;
          }
        }

        // Due for a run. Record the pre-mutation cadence state so a run suppressed by the monthly
        // operator ceiling below can be ROLLED BACK — otherwise advancing lastRunAt/nextRunAt here
        // makes a never-executed run look completed, so the account waits a full cadence and the UI
        // shows a next-run for a skipped run (see the monthly-ceiling rollback below).
        const prevLastRunAt = schedule.lastRunAt;
        const prevNextRunAt = schedule.nextRunAt;
        schedule.lastRunAt = new Date(now).toISOString();
        schedule.nextRunAt = new Date(now + cadenceMs).toISOString();
        dueRuns.push({ userId, accountId, key, prevLastRunAt, prevNextRunAt });
      }
    }

    // Run with bounded concurrency (max 3 at a time) to balance throughput and API rate limits
    const MAX_CONCURRENCY = 3;
    const executing = new Set<Promise<unknown>>();

    // Skip LLM strategy runs when the monthly operator spend ceiling is breached.
    // Non-LLM safety tasks (reconciliation, stop monitor, stale orders, proposal expiry)
    // have already run above — only the LLM-heavy strategy execution is gated here.
    if (!monthlyCeiling.ok) {
      if (dueRuns.length > 0) {
        console.warn(`[scheduler] monthly ceiling: suppressing ${dueRuns.length} due strategy run(s)`);
        // Roll back the cadence state advanced in the due-detection loop above: a run that never
        // executed must NOT look completed, or the account waits a full cadence and the UI shows a
        // next-run for a skipped run. Restore each suppressed account's pre-mutation lastRunAt/nextRunAt.
        for (const { key, prevLastRunAt, prevNextRunAt } of dueRuns) {
          const s = accountSchedules[key];
          if (s) {
            s.lastRunAt = prevLastRunAt;
            s.nextRunAt = prevNextRunAt;
          }
        }
      }
      return;
    }

    let jitterMs = 0;
    for (const { userId, accountId } of dueRuns) {
      // P2.9: Stagger/jitter LLM calls to prevent concurrent-account bursts from blowing QPM.
      // Offset each simultaneous launch by 2-5s to stagger their LLM phase.
      const runDelayMs = jitterMs;
      jitterMs += 2000 + Math.random() * 3000;

      // The daily LLM budget ceiling is enforced INSIDE runStrategyOnce (after its non-LLM risk
      // breakers + reconciliation, before proposal generation), NOT here — suppressing the run at this
      // outer gate would also skip the drawdown/volatility breakers + fill reconciliation, disabling
      // safety maintenance for the rest of the day. So we always enter the run; it skips only LLM work.
      const p = (async () => {
        if (runDelayMs > 0) await new Promise((r) => setTimeout(r, runDelayMs));
        await journalLane("strategy-run", { userId, connectedAccountId: accountId }, async () => {
          const result = await runScheduledStrategyAndMaybeTune(userId, accountId);
          return { status: "ok" as const, summary: `status=${result.status}` };
        });
      })()
        // Item 1 (opt-in): after a successful cadence run, attempt account-bound, cadence-gated
        // autonomous weight tuning. Failed/busy runs never tune; the helper owns that invariant.
        .catch((err) => {
          console.error(`[scheduler] error running strategy for ${userId}/${accountId}:`, err);
        })
        .finally(() => {
          executing.delete(p);
        });

      executing.add(p);
      if (executing.size >= MAX_CONCURRENCY) {
        await Promise.race(executing);
      }
    }
    
    await Promise.all(executing);
  } catch (err) {
    // Never let a thrown error kill the timer
    console.error("[scheduler] tick error:", err);
  }
}

/** Test-only entry point for asserting leader-gate ordering without starting the interval. */
export async function _runSchedulerTickForTest(): Promise<void> {
  await tick();
}
