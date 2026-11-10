// Item 1 (Workstream B): cadence gate for AUTONOMOUS factor-weight tuning.
//
// DEFAULT OFF: with `policy.tuning.autoApplyWeights` unset this is a no-op. When on, it runs the auto-tuner
// at most once per cadence window (default 24h) after a strategy run, and lets `applyAutonomousWeightTuning`
// handle the OOS gate + clamp + persist + audit. Kept separate from `triggers.ts`/`strategy.ts` so the
// cadence bookkeeping (a `last_auto_tune_at` settings row) is isolated and easily testable.

import { getInternalSetting, setInternalSetting } from "./db-settings";
import { getPolicy } from "./db";
import { acquireStrategyLock, releaseStrategyLock } from "./db-execution";
import { releaseLlmReservation, reserveLlmRunBudget } from "./llm-budget";
import { startStrategyLockGuard, StrategyLockOwnershipLostError } from "./strategy-lock-guard";
import { applyAutonomousWeightTuning, type AutonomousWeightApplyResult } from "./strategy-tuning";

/** Minimum interval (ms) between autonomous auto-tune attempts. Env-tunable; default 24h. */
export function autoTuneMinIntervalMs(): number {
  const hours = Number(process.env.AUTO_TUNE_MIN_INTERVAL_HOURS);
  const h = Number.isFinite(hours) && hours > 0 ? hours : 24;
  return h * 60 * 60 * 1000;
}

function cadenceKey(userId: string, connectedAccountId: string): string {
  return `last_auto_tune_at:${userId}:${connectedAccountId}`;
}

function legacyCadenceKey(userId: string): string {
  return `last_auto_tune_at:${userId}`;
}

export interface MaybeAutoTuneResult extends Partial<AutonomousWeightApplyResult> {
  ran: boolean;
  skippedReason?: string;
}

/**
 * Cadence-gated autonomous auto-tune. Returns `{ ran: false, skippedReason }` when the flag is off or the
 * cadence window hasn't elapsed. Fully self-guarded: any error is swallowed (returns ran:false) so it can
 * never break the strategy-run path that calls it. Marks the cadence timestamp only when it actually runs
 * the tuner (so a transient failure retries next run rather than blocking for a full window).
 */
export async function maybeAutoTuneWeights(
  userId: string = "local",
  now: number = Date.now(),
  connectedAccountId?: string
): Promise<MaybeAutoTuneResult> {
  // Bind once even when a direct caller omits the account. No later active-account switch can
  // redirect the cadence row, evidence reads, or policy mutation.
  const accountId = connectedAccountId ?? getPolicy(userId).connectedAccountId;
  if (!accountId) return { ran: false, skippedReason: "no_account" };

  // The tuner is policy-mutating follow-on work, so it contends on the same account lease as a
  // strategy/approval run and renews it for the full LLM/OOS duration.
  const lockOwner = `auto-tune:${crypto.randomUUID()}`;
  if (!acquireStrategyLock(lockOwner, userId, accountId)) {
    return { ran: false, skippedReason: "account_busy" };
  }
  const lockGuard = startStrategyLockGuard({ owner: lockOwner, userId, connectedAccountId: accountId });
  let reservationId: string | undefined;
  try {
    lockGuard.assertOwned();
    const policy = getPolicy(userId, accountId);
    if (!policy.tuning?.autoApplyWeights) return { ran: false, skippedReason: "autoApplyWeights_off" };

    // Honor the former user-wide stamp during migration so account scoping cannot trigger an
    // immediate duplicate tune; new successful attempts write only the account-scoped key.
    const last = getInternalSetting<number>(cadenceKey(userId, accountId))
      ?? getInternalSetting<number>(legacyCadenceKey(userId));
    if (typeof last === "number" && now - last < autoTuneMinIntervalMs()) {
      return { ran: false, skippedReason: "cadence_window" };
    }
    // Auto-tune's LLM call runs in the scheduler AFTER runStrategyOnce released its reservation, so it must
    // take its OWN per-user reservation — otherwise it spends against headroom a concurrent same-user run's
    // reservation has claimed (its budget checks read only the committed ledger). Reserve BEFORE marking the
    // cadence so a stand-down retries next run instead of burning the 24h window. Default-OFF budget → no-op.
    const reservation = reserveLlmRunBudget(userId, accountId, new Date(now));
    if (!reservation.ok) return { ran: false, skippedReason: "budget_reservation" };
    reservationId = reservation.reservationId;

    const assertOwned = () => lockGuard.assertOwned();
    const result = await applyAutonomousWeightTuning(userId, undefined, accountId, assertOwned);
    lockGuard.assertOwned();
    // Advance only after the account-bound attempt completed under the lease. A transient failure
    // or ownership loss retries on the next successful strategy run instead of burning 24 hours.
    setInternalSetting(cadenceKey(userId, accountId), now);
    return { ran: true, ...result };
  } catch (err) {
    console.error("[auto-tune] autonomous weight tuning error:", err);
    return {
      ran: false,
      skippedReason: err instanceof StrategyLockOwnershipLostError ? "lease_lost" : "error"
    };
  } finally {
    if (reservationId) releaseLlmReservation(userId, reservationId);
    lockGuard.stop();
    releaseStrategyLock(lockOwner, userId, accountId);
  }
}
