/** Client-side derivations over the DashboardSnapshot. These mirror server
 *  semantics (deriveExecutionState in src/lib/execution-mode.ts) — the words
 *  are load-bearing, the colors only reinforce. Nothing here fabricates data:
 *  every helper returns null/undefined when the snapshot can't answer. */

import type { DashboardSnapshot } from "../../dashboard-types";
import type { PositionStopPlan } from "@/lib/db";
import { normalizeSymbol } from "@/lib/money";
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
import { resolveDailyOpeningCap, type DailyOpeningCapMode } from "@/lib/policy-caps";
import { isRunAllowedNow, nextMarketOpenHint, previousTradingDayStart } from "@/lib/market-hours";

// ── Money-reality ────────────────────────────────────────────────────────────

export type RealityTone = "none" | "paper" | "live";

export interface RealityInfo {
  mode?: ExecutionMode;
  tone: RealityTone;
  /** The load-bearing word. */
  word: "NO ACCOUNT" | "PAPER" | "BROKERAGE";
  /** The load-bearing qualifier next to the word. */
  phrase: "nothing connected yet" | "broker practice account" | "live orders";
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
        phrase: "broker practice account",
        clarification:
          "Same broker-mediated trading path as live — practice dollars at the broker. Useful for reps and system training; live is the primary focus."
      };
    case "broker/live":
      return {
        mode,
        tone: "live",
        word: "BROKERAGE",
        phrase: "live orders",
        clarification: "Orders route through this connected live broker account when approved or permitted by Autopilot."
      };
    default:
      return {
        mode: undefined,
        tone: "none",
        word: "NO ACCOUNT",
        // Not "no account connected" — the banner renders "WORD · phrase", and
        // repeating the word's meaning made it a tautology.
        phrase: "nothing connected yet",
        clarification: "Connect a broker account before the app can place orders. Prefer live when ready; paper is for training reps."
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

/** Reality of a specific product account row, derived solely from its broker environment. */
export function realityForAccount(account: ConnectedAccount): Pick<RealityInfo, "mode" | "tone" | "word" | "phrase" | "clarification"> {
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
  /** Only meaningful when state === "active" — whether the market (per current session + the
   *  account's extended-hours policy) is open right now. undefined for every other state (those
   *  don't run on a market clock) AND for active policies whose `runDuringExtendedHours` wasn't
   *  in the payload — without it the answer isn't knowable, so no paused/running split is made. A
   *  configured-running account with the market closed is still `state: "active"` (nothing about
   *  the underlying run-state changed) — only the label/detail/tone reflect the pause, so this is
   *  purely a display fix, never a behavior change. */
  marketOpen?: boolean;
}

/** `now` is injectable for tests; every real caller uses the default (current time). */
export function deriveStateInfo(
  policy: Pick<TradingPolicy, "systemState" | "strategyAuthority"> & { runDuringExtendedHours?: boolean },
  now: Date = new Date()
): StateInfo {
  const authority = policy.strategyAuthority === "decide" ? "Autopilot" : "Ask-first";
  switch (policy.systemState) {
    case "active": {
      // undefined ≠ false: a payload that doesn't carry runDuringExtendedHours (older snapshot
      // shapes, or a projection that forgot the field) cannot answer "is this account's market
      // window open?" — an extended-hours account would be mislabeled "Paused · market closed"
      // while genuinely running a pre/post session. In that case skip the split entirely and
      // keep the plain "Running" claim. Only a real boolean opts into the market-aware display.
      const marketOpen =
        policy.runDuringExtendedHours === undefined ? undefined : isRunAllowedNow(policy.runDuringExtendedHours, now);
      if (marketOpen === false) {
        return {
          state: "active",
          label: "Paused · market closed",
          detail:
            `Scheduled runs pause while the market is closed and resume automatically once it reopens ` +
            `(next open ${nextMarketOpenHint(now, policy.runDuringExtendedHours === true)}). ` +
            (policy.strategyAuthority === "decide"
              ? "Autonomous placement is paused too — nothing places itself outside market hours."
              : "Every trade still waits for your approval once runs resume."),
          tone: "muted",
          marketOpen: false
        };
      }
      return {
        state: "active",
        label: `Running · ${authority}`,
        detail:
          policy.strategyAuthority === "decide"
            ? "The strategy runs on schedule and may place orders itself, inside your guardrails."
            : "The strategy runs on schedule. Every trade waits for your approval.",
        tone: policy.strategyAuthority === "decide" ? "warn" : "pos",
        ...(marketOpen === undefined ? {} : { marketOpen: true })
      };
    }
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

const STOP_PLAN_LABEL: Record<string, string> = { fixed: "Fixed", atr: "ATR", trailing: "Trailing", none: "None" };

/** Honest protection derivation from what the snapshot actually carries:
 *  a resting broker stop order that closes the position, else the app-managed
 *  stop rules (which pause while Stopped), else nothing. Shorts mirror the
 *  server's rules: the stop distance is riskRules.shortStopLossPct, falling
 *  back to stopLossPct (generateProactiveRiskProposals), and the app skips
 *  shorts entirely while shortSellingEnabled is off (synthetic-stops monitor
 *  and proactive exits both do). An optional per-position stopPlan (the LLM's
 *  own choice at buy time, from position_stop_plans) is layered on top —
 *  NEVER a silent override: it always annotates the detail text, and a "none"
 *  plan is called out prominently (never rendered as if nothing was ever
 *  configured) rather than blending into the generic no-protection case. */
export function deriveProtection(
  position: EquityPosition,
  orders: EquityOrder[],
  policy: TradingPolicy,
  stopPlan?: PositionStopPlan
): ProtectionInfo {
  const base = deriveBaseProtection(position, orders, policy);
  if (!stopPlan || stopPlan.style === "default") return base;
  const planLabel = STOP_PLAN_LABEL[stopPlan.style] ?? stopPlan.style;
  if (stopPlan.style === "none") {
    // Only a REAL, independently-verified resting broker stop order ("Broker stop") survives a
    // "none" plan — every enforcement layer (synthetic monitor, broker-protective-stops.ts)
    // deliberately suppresses ITS OWN stop for this symbol once "none" is set, so an "App stop..."
    // label here would just be reflecting account-wide CONFIG that no longer actually applies to
    // this position — showing it as protected would be misleading for a position the owner/LLM
    // chose to run bare (Codex review, PR #1371).
    const hasRealBrokerStop = base.label === "Broker stop";
    return {
      label: hasRealBrokerStop ? base.label : "No stop (LLM choice)",
      detail:
        `Per-position plan: NO stop-loss — a deliberate LLM/owner choice for this position` +
        (stopPlan.rationale ? ` ("${stopPlan.rationale}")` : "") +
        `. ${base.detail}`,
      tone: hasRealBrokerStop ? base.tone : "warn"
    };
  }
  // A REAL, independently-verified resting broker stop order protects regardless of what any plan
  // says (accuracy over the plan's intent, same principle as the "none" branch above) — keep it
  // exactly as `deriveBaseProtection` reported it.
  if (base.label === "Broker stop") {
    return { ...base, detail: `Per-position plan: ${planLabel} (pins this position's stop, overriding the account's own default distance/trailing choice). ${base.detail}` };
  }
  // A short position with short selling turned off: every enforcement layer (synthetic monitor,
  // proactive risk exits, broker-protective-stops) skips shorts entirely while shortSellingEnabled is
  // off, regardless of any per-position plan — a "Fixed"/"ATR"/"Trailing plan" label here would show
  // active protection for a short the app has deliberately stopped managing (Codex review, PR #1371).
  // Preserve deriveBaseProtection's muted/unsafe state instead of building an active plan label.
  if (position.quantity < 0 && !policy.shortSellingEnabled) {
    return { ...base, detail: `Per-position plan: ${planLabel} (would pin this position's stop, but it never takes effect while short selling is off). ${base.detail}` };
  }
  // Otherwise, build the label/tone from the PLAN itself, never from the account-wide base label's
  // CONTENT — that label describes whatever mechanism the ACCOUNT happens to have configured (e.g.
  // "App stop −8%" for a flat stop), which may be an entirely different mechanism than what this
  // plan actually pins (e.g. "trailing" on an account with only a flat stop configured, or "atr" on
  // one with none at all) — reusing it would show a protection lane/price that isn't the one
  // actually protecting this position. An explicit plan is real, active protection via
  // STOP_PLAN_FALLBACK_STOP_PCT even on a bare account (universal availability) — but like every
  // other app-managed enforcement layer, it pauses while the system is Stopped (Codex review, PR
  // #1371).
  const halted = policy.systemState === "halted";
  return {
    label: halted ? `${planLabel} plan · paused` : `${planLabel} plan`,
    detail:
      `Per-position plan: ${planLabel} (pins this position's stop, overriding the account's own default distance/trailing choice)` +
      (halted ? " — paused while the system is Stopped; resumes when you start or switch to Exit-only." : "") +
      `. ${base.detail}`,
    tone: halted ? "warn" : "pos"
  };
}

function deriveBaseProtection(
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
  // A fixed stop and a trailing stop COEXIST — they are not alternatives. The fixed % drives the
  // proactive risk-exit (and any broker bracket); the trailing % drives the synthetic scheduler-tick
  // monitor, which runs on top. Naming ONLY the trailing one implied it replaced the fixed stop, so a
  // held name with both configured looked protected by a single, wider trail. Show whichever apply.
  const hasFixed = typeof baseStopPct === "number" && baseStopPct > 0;
  const hasTrailing = !!(rules.trailingStopPct && rules.trailingStopPct > 0);
  if (hasFixed || hasTrailing) {
    const parts: string[] = [];
    if (hasFixed) parts.push(`stop −${baseStopPct}%`);
    if (hasTrailing) parts.push(`trailing −${rules.trailingStopPct}%`);
    const word = `App ${isShort ? "short " : ""}${parts.join(" + ")}`;
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
  /** False when `baselineAt` is dated on (or after) the most recent prior trading session — the
   *  normal case. True when the baseline predates that session, meaning one or more daily
   *  snapshots are missing (the strategy didn't run/snapshot for a stretch) and this P&L is being
   *  compared across a real gap (e.g. a July 7 baseline read on July 17), not just "yesterday". */
  isStaleBaseline: boolean;
}

/** Change in equity vs the last persisted snapshot before today (local time)
 *  in the current mode's bucket. Null when there is no prior-day snapshot or
 *  no current equity — render "—", never invent. `now` is injectable for tests. */
export function deriveDayPnl(
  performance: PerformanceSummary | undefined,
  mode: ExecutionMode | undefined,
  currentEquity: number | undefined,
  now: Date = new Date()
): DayPnl | null {
  if (!performance || typeof currentEquity !== "number" || !Number.isFinite(currentEquity)) return null;
  const curve = mode === "broker/live" ? performance.liveEquityCurve : performance.paperEquityCurve;
  if (!curve || curve.length === 0) return null;
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  let baseline: { timestamp: string; equity: number } | undefined;
  for (const point of curve) {
    const t = new Date(point.timestamp).getTime();
    if (Number.isFinite(t) && t < todayStart) baseline = point;
  }
  if (!baseline || !Number.isFinite(baseline.equity) || baseline.equity === 0) return null;
  const pnl = currentEquity - baseline.equity;
  const baselineDay = new Date(baseline.timestamp);
  const baselineDayStart = new Date(baselineDay.getFullYear(), baselineDay.getMonth(), baselineDay.getDate()).getTime();
  const priorSessionStart = previousTradingDayStart(now).getTime();
  const isStaleBaseline = Number.isFinite(baselineDayStart) && baselineDayStart < priorSessionStart;
  return {
    pnl,
    pct: (pnl / baseline.equity) * 100,
    baselineAt: baseline.timestamp,
    baselineEquity: baseline.equity,
    isStaleBaseline
  };
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
      title: "Setup: add an LLM key",
      detail:
        "Strategy runs need OpenRouter (or another configured LLM key) so Green/Red teams can propose and debate. Market data, positions, and guardrails still work without it.",
      href: "/console/connections#api-keys"
    });
  }
  // First-run / setup checklist (robust for many users; still useful as sole-operator checklist).
  if (!activeConnectedAccount(snapshot) && snapshot.connectedAccounts.length === 0) {
    items.push({
      id: "setup-broker",
      tone: "accent",
      title: "Setup: connect a broker account",
      detail:
        "Connect Alpaca or Robinhood (live preferred when ready; paper is fine for training reps). The app cannot place orders without a connected account.",
      href: "/console/connections"
    });
  }
  const greenModel = snapshot.policy.llmModel?.trim();
  if (!greenModel && snapshot.llmConfigured !== false) {
    items.push({
      id: "setup-models",
      tone: "warn",
      title: "Setup: choose Green team model",
      detail: "Strategy → Models — pick the model that writes trade ideas. Red team is optional; blank means you are the sole adversary.",
      href: "/console/strategy"
    });
  }
  if (snapshot.accountReadiness && !snapshot.accountReadiness.ok) {
    items.push({
      id: "readiness",
      tone: "warn",
      title: "Account not ready to run",
      detail: snapshot.accountReadiness.detail,
      href: "/console/connections"
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
  capMode?: DailyOpeningCapMode;
  capConfiguredValue?: number;
  capPctOfNav?: number;
  usedOrders: number;
  capOrders: number;
}

export function deriveSpend(snapshot: DashboardSnapshot): SpendInfo {
  const cap = resolveDailyOpeningCap(snapshot.policy, snapshot.portfolio?.totalMarketValue);
  return {
    usedNotional: snapshot.dailyStats?.notional ?? 0,
    capNotional: cap?.notional,
    capMode: cap?.mode,
    capConfiguredValue: cap?.configuredValue,
    capPctOfNav: cap?.pctOfNav,
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

// ── Estimated closing P/L (sell-of-long / cover-of-short) ───────────────────

/** The position's current per-share price implied by its own marked-to-market value
 *  (marketValue / quantity) — for a short both are negative, so the ratio is still a
 *  positive price. This is the SAME snapshot the position itself came from, so it is
 *  fresher than a market-scan cache that can be minutes old. Null when the position is
 *  missing, flat (quantity 0), or the ratio isn't a finite positive number — never invent
 *  a price for a closed/degenerate position. */
export function positionMarkPrice(
  position: Pick<EquityPosition, "quantity" | "marketValue"> | undefined | null
): number | null {
  if (!position || !Number.isFinite(position.quantity) || position.quantity === 0) return null;
  if (!Number.isFinite(position.marketValue)) return null;
  const price = position.marketValue / position.quantity;
  return Number.isFinite(price) && price > 0 ? price : null;
}

export interface EstimatedClosingPnl {
  pnl: number;
  pnlPct: number;
  basisPrice: number;
  currentPrice: number;
  shares: number;
}

/** Estimated realized P/L from closing `shares` of an existing position at `currentPrice`
 *  right now. `shares` is always the POSITIVE count of shares this order would close —
 *  independent of, and possibly smaller than, the position's own signed quantity (a
 *  partial exit). Sign-correct for BOTH directions: a long-sell profits when currentPrice
 *  is above the average cost; a short-cover profits when it's below (mirrors
 *  positionEconomics's short handling in ui/drilldown-data.ts, which gets the same sign
 *  for free from `quantity * (currentPrice - averageCost)` since a short's quantity is
 *  negative — here `shares` is unsigned, so the direction is read explicitly off
 *  `position.quantity`'s sign instead). Returns null when any input is missing or
 *  non-positive — never invent a number from a partial picture. */
export function estimatedClosingPnl(input: {
  position: Pick<EquityPosition, "quantity" | "averageCost">;
  shares: number | null | undefined;
  currentPrice: number | null | undefined;
}): EstimatedClosingPnl | null {
  const { position, shares, currentPrice } = input;
  const basisPrice = position.averageCost;
  if (!Number.isFinite(basisPrice) || basisPrice <= 0) return null;
  if (typeof shares !== "number" || !Number.isFinite(shares) || shares <= 0) return null;
  if (typeof currentPrice !== "number" || !Number.isFinite(currentPrice) || currentPrice <= 0) return null;
  const isShort = position.quantity < 0;
  const perShare = isShort ? basisPrice - currentPrice : currentPrice - basisPrice;
  return {
    pnl: perShare * shares,
    pnlPct: (perShare / basisPrice) * 100,
    basisPrice,
    currentPrice,
    shares
  };
}

/** True when a resting order would REDUCE/CLOSE the matched position: a long (quantity >
 *  0) closes with a sell; a short (quantity < 0) closes with a buy or cover (brokers that
 *  infer open/close from the account's position, e.g. Alpaca, report a short's cover as a
 *  raw "buy" — src/lib/broker-side.ts toBrokerSide). A flat position (quantity 0, or no
 *  matching position at all) has nothing to close. Symbols are compared via the same
 *  normalizeSymbol the drilldown join uses, so a bare/exchange-suffixed mismatch can't
 *  silently fail the match. */
export function isClosingOrder(
  order: Pick<EquityOrder, "symbol" | "side">,
  position: Pick<EquityPosition, "symbol" | "quantity"> | undefined | null
): boolean {
  if (!position || !Number.isFinite(position.quantity) || position.quantity === 0) return false;
  if (normalizeSymbol(order.symbol) !== normalizeSymbol(position.symbol)) return false;
  return position.quantity < 0 ? order.side === "buy" || order.side === "cover" : order.side === "sell";
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
