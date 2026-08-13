import { audit, getInternalSetting, getPolicy, setInternalSetting, setPolicy, deleteInternalSetting } from "./db";
import { countRecentAuditEvents } from "./db-learning";
import { ExecutionAccount, HealthSignals } from "./execution-mode";
import { accountEquity } from "./risk-breaker";
import { sendNotification } from "./notifications";
import type { BrokerGateway, BrokerageAccount, SystemState, TradingPolicy } from "./types";

/**
 * Validates whether the broker connection is currently healthy and the account is ready for trading.
 * Checks connectivity, account status, order-placement capability (when the gateway can probe it),
 * and recent error rates to prevent the agent from burning LLM tokens when orders cannot land.
 *
 * Unhealthy results are sticky at the policy layer via {@link applyBrokerOrderPlacementPause}:
 * autonomous strategy runs flip `systemState` to `halted` until the probe recovers (auto-resume)
 * or the owner re-arms.
 */
export async function checkBrokerHealth(
  userId: string,
  account: ExecutionAccount,
  brokerGateway?: BrokerGateway
): Promise<HealthSignals> {
  // If no gateway is provided, we can't check broker-side health.
  // This typically happens if the account isn't meant to submit orders (e.g. read-only mode).
  if (!brokerGateway) {
    return { isHealthy: true };
  }

  try {
    const [accounts, portfolio] = await Promise.all([
      brokerGateway.getAccounts(),
      brokerGateway.getPortfolio(account.accountNumber ?? "")
    ]);

    const activeBrokerAccount = accounts.find((a: BrokerageAccount) => a.accountNumber === account.accountNumber);
    if (!activeBrokerAccount) {
      return {
        isHealthy: false,
        reason: "Account not found on broker",
        category: "connectivity"
      };
    }

    if (!activeBrokerAccount.agenticAllowed) {
      return {
        isHealthy: false,
        reason: "Account is not marked agenticAllowed by the broker",
        category: "account"
      };
    }

    // Minimum notional check to prevent burning tokens when there's no money.
    // E.g., Robinhood requires $1 minimum for fractional shares.
    const equity = accountEquity(portfolio);
    if (equity < 5.0) {
      return {
        isHealthy: false,
        reason: `Account equity (${equity}) is too low to trade`,
        category: "equity"
      };
    }

    // Check recent error rate: if there are >= 3 order_placement_uncertain errors in the last 15 mins,
    // the broker is likely having transient issues.
    const recentErrors = countRecentAuditEvents("order_placement_uncertain", account.id, 15, userId);
    if (recentErrors >= 3) {
      return {
        isHealthy: false,
        reason: `Elevated error rate: ${recentErrors} order placement uncertainties in the last 15 minutes`,
        category: "error_rate"
      };
    }

    // Infrastructure place failures (5xx / OMS down / backend unreachable) — 2+ in 30 minutes
    // means further strategy LLM runs will just mint unplaceable proposals.
    const recentInfra = countRecentAuditEvents("order_place_infrastructure_failed", account.id, 30, userId);
    if (recentInfra >= 2) {
      return {
        isHealthy: false,
        reason: `Broker order path failing: ${recentInfra} infrastructure placement failures in the last 30 minutes`,
        category: "order_capability"
      };
    }

    // Optional proactive OMS/order-path probe (Tradier preview, Alpaca trading_blocked, …).
    // Throttled inside the gateway implementations so a multi-account scheduler tick does not
    // hammer the broker.
    if (typeof brokerGateway.probeOrderCapability === "function" && account.accountNumber) {
      const probe = await brokerGateway.probeOrderCapability(account.accountNumber);
      if (!probe.ok) {
        return {
          isHealthy: false,
          reason: probe.reason ?? "Broker reports orders cannot be placed",
          category: "order_capability"
        };
      }
    }

    return { isHealthy: true };
  } catch (err) {
    return {
      isHealthy: false,
      reason: `Broker connectivity failure: ${err instanceof Error ? err.message : String(err)}`,
      category: "connectivity"
    };
  }
}

// ── Auto-pause / auto-resume when the account cannot place orders ────────────

export type BrokerPlacementPauseMarker = {
  since: string;
  reason: string;
  category?: HealthSignals["category"];
  /** Always true for this path — owner manual halt is unmarked and never auto-resumed by us. */
  autoResume: true;
  /** systemState before we flipped it (should be "active"). */
  priorState: SystemState;
};

const pauseMarkerKey = (userId: string, accountScope: string) =>
  `broker:placement-paused:${userId}:${accountScope}`;

export function getBrokerPlacementPauseMarker(
  userId: string,
  accountScope: string
): BrokerPlacementPauseMarker | undefined {
  const raw = getInternalSetting<BrokerPlacementPauseMarker>(pauseMarkerKey(userId, accountScope));
  if (!raw || typeof raw !== "object" || typeof raw.since !== "string" || raw.autoResume !== true) return undefined;
  return raw;
}

export function clearBrokerPlacementPauseMarker(userId: string, accountScope: string): void {
  deleteInternalSetting(pauseMarkerKey(userId, accountScope));
}

export type ApplyBrokerPauseResult =
  | { action: "none" }
  | { action: "halted"; reason: string }
  | { action: "resumed"; priorReason?: string }
  | { action: "still_paused"; reason: string };

/**
 * When broker health says the account cannot place orders and the policy is `active`, flip
 * `systemState` to `halted` so future autonomous strategy runs (scheduler + locked loop) stop
 * burning LLM budget. When health recovers and the halt was ours (marker present), auto-resume
 * to `active`. Manual owner halts (no marker) are never auto-resumed.
 *
 * Safe to call every scheduler tick — notifications fire once per pause episode.
 */
export async function applyBrokerOrderPlacementPause(input: {
  userId: string;
  connectedAccountId?: string;
  accountScope: string;
  health: HealthSignals;
  /** Current policy snapshot (may be mutated in place when state flips). */
  policy: TradingPolicy;
}): Promise<ApplyBrokerPauseResult> {
  const { userId, connectedAccountId, accountScope, health, policy } = input;
  const marker = getBrokerPlacementPauseMarker(userId, accountScope);

  if (health.isHealthy) {
    if (!marker) return { action: "none" };
    // Only auto-resume if we still own the halt (marker present) and state is still halted.
    // If the owner already re-armed to active, just clear the marker.
    if (policy.systemState === "halted") {
      policy.systemState = "active";
      setPolicy(policy, userId, connectedAccountId);
      audit(
        "broker_placement_auto_resumed",
        {
          reason: marker.reason,
          category: marker.category,
          since: marker.since,
          from: "halted",
          to: "active"
        },
        userId,
        connectedAccountId
      );
      // enabledEvents gating is real (owner ruling 2026-08-12: no toggle is silently overridden)
      // — a persisted policy that predated risk_advisory got it backfilled once by the db
      // migration (backfillDefaultOnNotificationEvents in db.ts), not force-included per send.
      await sendNotification(
        {
          type: "risk_advisory",
          title: "Broker order path recovered — autonomous strategy resumed",
          payload: {
            reason: marker.reason,
            pausedSince: marker.since,
            action: "auto_resume"
          }
        },
        { policy, userId, connectedAccountId }
      );
      clearBrokerPlacementPauseMarker(userId, accountScope);
      return { action: "resumed", priorReason: marker.reason };
    }
    clearBrokerPlacementPauseMarker(userId, accountScope);
    return { action: "none" };
  }

  // Unhealthy.
  const reason = health.reason ?? "Broker cannot place orders";

  if (policy.systemState === "halted") {
    // Already halted — ensure marker exists if this was (or becomes) our pause, so auto-resume works.
    if (!marker) {
      // Do NOT claim ownership of a pre-existing owner halt. Without a marker we won't auto-resume.
      return { action: "still_paused", reason };
    }
    return { action: "still_paused", reason: marker.reason };
  }

  if (policy.systemState !== "active") {
    // close_only / liquidating: leave owner intent alone; still skip runs via health gate.
    return { action: "none" };
  }

  // Flip active → halted.
  const priorState = policy.systemState;
  policy.systemState = "halted";
  setPolicy(policy, userId, connectedAccountId);
  const nextMarker: BrokerPlacementPauseMarker = {
    since: new Date().toISOString(),
    reason,
    category: health.category,
    autoResume: true,
    priorState
  };
  setInternalSetting(pauseMarkerKey(userId, accountScope), nextMarker);
  audit(
    "broker_placement_auto_halted",
    {
      reason,
      category: health.category,
      from: priorState,
      to: "halted"
    },
    userId,
    connectedAccountId
  );
  await sendNotification(
    {
      type: "kill_switch",
      title: "Autonomous strategy paused — broker cannot place orders",
      payload: {
        reason,
        category: health.category,
        action: "auto_halt",
        note: "Will auto-resume when the broker order path recovers. You can also re-arm Start manually after fixing the connection."
      }
    },
    { policy, userId, connectedAccountId }
  );
  return { action: "halted", reason };
}

/**
 * True when a placeEquityOrder error message indicates infrastructure/OMS failure rather than a
 * normal validation or buying-power reject. Used to audit `order_place_infrastructure_failed` and
 * feed the broker-health consecutive-failure gate.
 */
export function isOrderPlacementInfrastructureFailure(message: string): boolean {
  const m = String(message ?? "");
  if (!m.trim()) return false;
  // Explicit non-infra rejects first (avoid false positives on "HTTP 403 insufficient buying power")
  if (
    /buying power|insufficient|notional|wash.?sale|pdt|day.?trad|fractional|qty|quantity|validation|OrderValidation|not tradable|halted|universe|margin.?call/i.test(
      m
    ) &&
    !/HTTP 5\d\d|backend|OmsUnavailable|OmsInternal|ECONN|ETIMEDOUT|fetch failed|network/i.test(m)
  ) {
    return false;
  }
  return (
    /HTTP 5\d\d/i.test(m) ||
    /communicating with the backend/i.test(m) ||
    /unexpected error occurred/i.test(m) ||
    /OmsUnavailable|OmsInternalError/i.test(m) ||
    /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|fetch failed|network/i.test(m) ||
    /broker (?:connectivity|unreachable|unavailable)/i.test(m) ||
    /Tradier HTTP 5\d\d/i.test(m) ||
    /Alpaca.*\b5\d\d\b/i.test(m)
  );
}

/**
 * Re-read policy for the account (used by scheduler after pause may have mutated state).
 */
export function freshPolicyForAccount(userId: string, connectedAccountId?: string): TradingPolicy {
  return getPolicy(userId, connectedAccountId);
}
