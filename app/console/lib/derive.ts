/** Client-side derivations over the DashboardSnapshot. These mirror server
 *  semantics (deriveExecutionState in src/lib/execution-mode.ts) — the words
 *  are load-bearing, the colors only reinforce. Nothing here fabricates data:
 *  every helper returns null/undefined when the snapshot can't answer. */

import type { DashboardSnapshot } from "../../dashboard-types";
import type {
  ConnectedAccount,
  EquityCurvePoint,
  EquityOrder,
  EquityPosition,
  ExecutionMode,
  PerformanceSummary,
  SystemState,
  TradingPolicy
} from "@/lib/types";

// ── Money-reality ────────────────────────────────────────────────────────────

export type RealityTone = "none" | "paper" | "live";

export interface RealityInfo {
  mode?: ExecutionMode;
  tone: RealityTone;
  /** The load-bearing word. */
  word: "NO ACCOUNT" | "TEST ACCOUNT" | "PAPER" | "BROKERAGE";
  /** The load-bearing qualifier next to the word. */
  phrase: "no account connected" | "Local Mock Paper Account" | "NOT real money" | "connected account";
  /** One-sentence honest clarification. */
  clarification: string;
  account?: ConnectedAccount;
}

export function activeConnectedAccount(snapshot: DashboardSnapshot): ConnectedAccount | undefined {
  return snapshot.connectedAccounts.find((a) => a.isActive);
}

export function realityForMode(mode: ExecutionMode | undefined): Pick<RealityInfo, "mode" | "tone" | "word" | "phrase" | "clarification"> {
  switch (mode) {
    case "broker/paper":
      return {
        mode,
        tone: "paper",
        word: "PAPER",
        phrase: "NOT real money",
        clarification: "Your broker's practice sandbox — real broker endpoints, zero real dollars."
      };
    case "broker/live":
      return {
        mode,
        tone: "live",
        word: "BROKERAGE",
        phrase: "connected account",
        clarification: "Orders route through this connected broker account when approved or permitted by Autopilot."
      };
    default:
      return {
        mode: undefined,
        tone: "none",
        word: "NO ACCOUNT",
        phrase: "no account connected",
        clarification: "Connect a broker account (paper or live) before the app can place orders."
      };
  }
}

/** Mirror of the server's deriveExecutionState(policy, activeAccount): an account is an
 *  account, purely by its `environment`. With no connected account there is no execution
 *  mode — the app cannot place orders. */
export function deriveReality(snapshot: DashboardSnapshot): RealityInfo {
  const account = activeConnectedAccount(snapshot);
  const mode: ExecutionMode | undefined = !account ? undefined : account.environment === "paper" ? "broker/paper" : "broker/live";
  return { ...realityForMode(mode), account };
}

/** Reality of a specific account ROW (switcher, connections list), derived from the
 *  account's own `environment` — an account is an account, whatever its broker. */
export function realityForAccount(account: ConnectedAccount): Pick<RealityInfo, "mode" | "tone" | "word" | "phrase" | "clarification"> {
  if (account.broker === "test") {
    return {
      mode: "broker/paper",
      tone: "paper",
      word: "TEST ACCOUNT",
      phrase: "Local Mock Paper Account",
      clarification: "Local simulated fills for learning and testing. It is not a broker account and cannot reach real money."
    };
  }
  return realityForMode(account.environment === "paper" ? "broker/paper" : "broker/live");
}

// ── Run-state / authority words ──────────────────────────────────────────────

export interface StateInfo {
  state: SystemState;
  /** Compound plain-words label, e.g. "Running · Ask-first". */
  label: string;
  /** One-line honest explanation. */
  detail: string;
  tone: "pos" | "warn" | "neg" | "muted";
}

export function deriveStateInfo(policy: TradingPolicy): StateInfo {
  const authority = policy.strategyAuthority === "decide" ? "Autopilot" : "Ask-first";
  switch (policy.systemState) {
    case "active":
      return {
        state: "active",
        label: `Running · ${authority}`,
        detail:
          policy.strategyAuthority === "decide"
            ? "The strategy runs on schedule and may place orders itself, inside your guardrails."
            : "The strategy runs on schedule. Every trade waits for your approval.",
        tone: policy.strategyAuthority === "decide" ? "warn" : "pos"
      };
    case "close_only":
      return {
        state: "close_only",
        label: "Exit-only",
        detail: "No new buys. Protective exits keep working. This is the state circuit breakers set.",
        tone: "warn"
      };
    case "liquidating":
      return {
        state: "liquidating",
        label: "Winding down",
        detail: "Only sell orders, until the account is in cash. This sells things.",
        tone: "warn"
      };
    default:
      return {
        state: "halted",
        label: "Stopped",
        detail:
          "Nothing trades — no buys, no sells, and this app's automatic stops are paused too. Broker-held brackets keep resting at the broker. Nothing is sold.",
        tone: "neg"
      };
  }
}

export function authorityWord(policy: TradingPolicy): "Ask-first" | "Autopilot" {
  return policy.strategyAuthority === "decide" ? "Autopilot" : "Ask-first";
}

// ── Per-position protection status ───────────────────────────────────────────

export interface ProtectionInfo {
  /** Short cell text, or null when nothing protects the position (render "—"). */
  label: string | null;
  detail: string;
  tone: "pos" | "warn" | "muted";
}

const TERMINAL_ORDER_STATES = new Set(["filled", "cancelled", "canceled", "rejected", "expired", "failed", "done_for_day", "replaced"]);

/** True when a resting broker stop order would CLOSE this position: a long is
 *  protected by a sell-side stop; a short by a cover (or buy — broker listings
 *  vary) stop. A same-direction stop (e.g. a stop-limit ENTRY working on the
 *  same symbol) protects nothing and must not be counted. */
function hasWorkingClosingStop(orders: EquityOrder[], symbol: string, isShort: boolean): boolean {
  return orders.some((o) => {
    if (o.symbol?.toUpperCase() !== symbol.toUpperCase()) return false;
    if (o.type !== "stop_market" && o.type !== "stop_limit") return false;
    if (TERMINAL_ORDER_STATES.has((o.state || "").toLowerCase())) return false;
    return isShort ? o.side === "cover" || o.side === "buy" : o.side === "sell";
  });
}

/** Honest protection derivation from what the snapshot actually carries:
 *  a resting broker stop order that closes the position, else the app-managed
 *  stop rules (which pause while Stopped), else nothing. Shorts mirror the
 *  server's rules: the stop distance is riskRules.shortStopLossPct, falling
 *  back to stopLossPct (generateProactiveRiskProposals), and the app skips
 *  shorts entirely while shortSellingEnabled is off (synthetic-stops monitor
 *  and proactive exits both do). */
export function deriveProtection(
  position: EquityPosition,
  orders: EquityOrder[],
  policy: TradingPolicy
): ProtectionInfo {
  const isShort = position.quantity < 0;
  if (hasWorkingClosingStop(orders, position.symbol, isShort)) {
    return {
      label: "Broker stop",
      detail: "A stop order is resting at the broker. It keeps protecting even if this app is down or stopped.",
      tone: "pos"
    };
  }
  const rules = policy.riskRules;
  if (isShort && !policy.shortSellingEnabled) {
    return {
      label: null,
      detail: "Short position, but short selling is off in policy — the app's stop monitor skips it, and no closing broker stop order is resting.",
      tone: "muted"
    };
  }
  const baseStopPct = isShort
    ? rules.shortStopLossPct && rules.shortStopLossPct > 0
      ? rules.shortStopLossPct
      : rules.stopLossPct
    : rules.stopLossPct;
  const trailing = !!(rules.trailingStopPct && rules.trailingStopPct > 0);
  const stopPct = trailing ? rules.trailingStopPct : baseStopPct;
  if (typeof stopPct === "number" && stopPct > 0) {
    const word = `App ${trailing ? "trailing " : ""}${isShort ? "short " : ""}stop −${stopPct}%`;
    if (policy.systemState === "halted") {
      return {
        label: `${word} · paused`,
        detail: "App-managed stop rules are configured but paused while the system is Stopped. They resume when you start or switch to Exit-only.",
        tone: "warn"
      };
    }
    return {
      label: word,
      detail: `Managed by this app on its scheduler tick${isShort ? " (exits with a buy-to-cover)" : ""}. It requires the app to be running and pauses if you Stop everything.`,
      tone: "pos"
    };
  }
  return {
    label: null,
    detail: `No ${isShort ? "short " : ""}stop rule is configured and no closing broker stop order is resting for this symbol.`,
    tone: "muted"
  };
}

// ── Day P&L (honest: derived from persisted snapshots, labeled as such) ──────

export interface DayPnl {
  pnl: number;
  pct: number;
  baselineAt: string;
  baselineEquity: number;
}

/** Change in equity vs the last persisted snapshot before today (local time)
 *  in the current mode's bucket. Null when there is no prior-day snapshot or
 *  no current equity — render "—", never invent. */
export function deriveDayPnl(
  performance: PerformanceSummary | undefined,
  mode: ExecutionMode | undefined,
  currentEquity: number | undefined
): DayPnl | null {
  if (!performance || typeof currentEquity !== "number" || !Number.isFinite(currentEquity)) return null;
  const curve = mode === "broker/live" ? performance.liveEquityCurve : performance.paperEquityCurve;
  if (!curve || curve.length === 0) return null;
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  let baseline: { timestamp: string; equity: number } | undefined;
  for (const point of curve) {
    const t = new Date(point.timestamp).getTime();
    if (Number.isFinite(t) && t < todayStart) baseline = point;
  }
  if (!baseline || !Number.isFinite(baseline.equity) || baseline.equity === 0) return null;
  const pnl = currentEquity - baseline.equity;
  return { pnl, pct: (pnl / baseline.equity) * 100, baselineAt: baseline.timestamp, baselineEquity: baseline.equity };
}

// ── Needs-attention inbox ────────────────────────────────────────────────────

export interface AttentionItem {
  id: string;
  tone: "neg" | "warn" | "accent";
  title: string;
  detail: string;
  href?: string;
}

export function deriveAttention(snapshot: DashboardSnapshot): AttentionItem[] {
  const items: AttentionItem[] = [];
  const pending = snapshot.pendingProposals.length;
  if (pending > 0) {
    items.push({
      id: "pending",
      tone: "accent",
      title: `${pending} trade ${pending === 1 ? "idea is" : "ideas are"} waiting for you`,
      detail: "Nothing happens until you approve or reject each one. Doing nothing lets them expire.",
      href: "/console/approvals"
    });
  }
  const state = snapshot.policy.systemState;
  if (state === "halted") {
    items.push({
      id: "halted",
      tone: "neg",
      title: "The strategy is stopped",
      detail:
        "No runs, no orders — and this app's automatic stops are paused. Broker-held brackets keep resting. Approving or rejecting proposals is refused while stopped.",
      href: "/console/guardrails"
    });
  } else if (state === "close_only") {
    items.push({
      id: "close-only",
      tone: "warn",
      title: "Exit-only mode",
      detail: "No new buys will happen. Protective sells still work. A circuit breaker or a person set this.",
      href: "/console/activity"
    });
  } else if (state === "liquidating") {
    items.push({
      id: "liquidating",
      tone: "warn",
      title: "Winding down",
      detail: "Only sell orders are allowed until the account is in cash."
    });
  }
  if (snapshot.llmConfigured === false) {
    items.push({
      id: "llm",
      tone: "warn",
      title: "No LLM key configured",
      detail: "Runs that generate proposals need one. Market data, positions, and guardrails still work without it."
    });
  }
  if (snapshot.accountReadiness && !snapshot.accountReadiness.ok) {
    items.push({
      id: "readiness",
      tone: "warn",
      title: "Account not ready to run",
      detail: snapshot.accountReadiness.detail
    });
  }
  const failed = (snapshot.recentProposals ?? []).filter((p) => p.status === "placing_failed");
  if (failed.length > 0) {
    items.push({
      id: "placing-failed",
      tone: "neg",
      title: `${failed.length} order ${failed.length === 1 ? "intent" : "intents"} awaiting reconciliation`,
      detail:
        "A broker call failed or its response was lost. The durable intent was recorded before the call, so it cannot double-place — the broker-truth sweep will resolve it. Do not retry manually.",
      href: "/console/activity"
    });
  }
  const activeAccount = activeConnectedAccount(snapshot);
  const recentKill = snapshot.notifications.filter((n) => n.type === "kill_switch").slice(0, 1);
  for (const n of recentKill) {
    // Only surface if it's fresh (last 48h) — older breaker events live in Activity.
    const t = new Date(n.createdAt).getTime();
    if (Number.isFinite(t) && Date.now() - t < 48 * 3600_000) {
      // Notifications are user-wide; a breaker event may belong to a different
      // account than the one this console is scoped to. Say so instead of
      // implying the active account tripped a breaker.
      let title = "A circuit breaker fired";
      let detail = n.title;
      if (n.connectedAccountId && n.connectedAccountId !== activeAccount?.id) {
        const other = snapshot.connectedAccounts.find((a) => a.id === n.connectedAccountId);
        const name = other?.label || other?.broker || "another account";
        title = `A circuit breaker fired on ${name}`;
        detail = `${n.title} — this happened on ${name}, not the account you're viewing.`;
      } else if (!n.connectedAccountId && snapshot.connectedAccounts.length > 1) {
        detail = `${n.title} — recorded without an account tag; it may concern any of your accounts.`;
      }
      items.push({
        id: `kill-${n.id}`,
        tone: "neg",
        title,
        detail,
        href: "/console/activity"
      });
    }
  }
  return items;
}

// ── Daily spend meter ────────────────────────────────────────────────────────

export interface SpendInfo {
  usedNotional: number;
  capNotional?: number;
  usedOrders: number;
  capOrders: number;
}

export function deriveSpend(snapshot: DashboardSnapshot): SpendInfo {
  return {
    usedNotional: snapshot.dailyStats?.notional ?? 0,
    capNotional: snapshot.policy.maxDailyNotional,
    usedOrders: snapshot.dailyStats?.openingOrderCount ?? snapshot.dailyStats?.orderCount ?? 0,
    capOrders: snapshot.policy.maxDailyOrders
  };
}

export interface MarkToMarketInfo {
  costBasis: number;
  marketValue: number;
  unrealizedPnl: number;
  unrealizedPct?: number;
  positionsValue: number;
  cash?: number;
  buyingPower?: number;
}

export function deriveMarkToMarket(snapshot: DashboardSnapshot): MarkToMarketInfo | null {
  const positions = snapshot.positions ?? [];
  if (positions.length === 0 && !snapshot.portfolio) return null;
  const costBasis = positions.reduce((sum, position) => sum + position.averageCost * position.quantity, 0);
  const marketValue = positions.reduce((sum, position) => sum + (Number.isFinite(position.marketValue) ? position.marketValue : 0), 0);
  const unrealizedPnl = marketValue - costBasis;
  return {
    costBasis,
    marketValue,
    unrealizedPnl,
    unrealizedPct: costBasis > 0 ? (unrealizedPnl / costBasis) * 100 : undefined,
    positionsValue: snapshot.portfolio?.equityMarketValue ?? marketValue,
    cash: snapshot.portfolio?.cash,
    buyingPower: snapshot.portfolio?.buyingPower
  };
}

export interface UtilizationMeter {
  used: number;
  limit?: number;
  pct?: number;
}

export interface RiskUtilizationInfo {
  dailyNotional: UtilizationMeter;
  dailyOrders: UtilizationMeter;
  investedCapital: UtilizationMeter;
}

export function deriveRiskUtilization(snapshot: DashboardSnapshot): RiskUtilizationInfo {
  const spend = deriveSpend(snapshot);
  const equity = snapshot.portfolio?.totalMarketValue;
  const positions = snapshot.positions ?? [];
  const invested = snapshot.portfolio?.equityMarketValue ?? positions.reduce((sum, position) => sum + Math.abs(position.marketValue), 0);
  return {
    dailyNotional: {
      used: spend.usedNotional,
      limit: spend.capNotional,
      pct: spend.capNotional && spend.capNotional > 0 ? (spend.usedNotional / spend.capNotional) * 100 : undefined
    },
    dailyOrders: {
      used: spend.usedOrders,
      limit: spend.capOrders,
      pct: spend.capOrders > 0 ? (spend.usedOrders / spend.capOrders) * 100 : undefined
    },
    investedCapital: {
      used: invested,
      limit: equity,
      pct: equity && equity > 0 ? (invested / equity) * 100 : undefined
    }
  };
}

export function selectEquityWindow(points: EquityCurvePoint[], now = new Date()): { points: EquityCurvePoint[]; label: string } {
  if (points.length < 2) return { points, label: "Equity" };
  const sameDay = (iso: string) => {
    const date = new Date(iso);
    return (
      date.getFullYear() === now.getFullYear() &&
      date.getMonth() === now.getMonth() &&
      date.getDate() === now.getDate()
    );
  };
  const intraday = points.filter((point) => sameDay(point.timestamp));
  if (intraday.length >= 2) return { points: intraday, label: "Intraday mark-to-market" };
  return { points: points.slice(-24), label: "Recent equity" };
}
