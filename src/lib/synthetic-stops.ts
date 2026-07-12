import crypto from "crypto";
import {
  audit,
  claimSyntheticStop,
  dailyExecutionStats,
  deleteSyntheticStop,
  getActiveConnectedAccount,
  insertFillEvent,
  listSyntheticStops,
  revertSyntheticStopClaim,
  upsertSyntheticStop,
  type SyntheticTrailingStop
} from "./db";
import { getBrokerGateway } from "./broker";
import { applyPaperExitCost } from "./execution-cost";
import { cancelBrokerProtectiveStop, reconcileBrokerProtectiveStops } from "./broker-protective-stops";
import { deriveExecutionState } from "./execution-mode";
import { normalizeSymbol } from "./money";
import { evaluateTradeProposal } from "./policy";
import type { EquityOrder, EquityPosition, ExecutionMode, FillSource, TradeProposal, TradingPolicy } from "./types";

const BAD_TICK_PCT = 0.1; // ignore a single print deviating >10% from the last good price

// Order states that mean a broker order is still RESTING (not filled/canceled/expired/rejected).
// We list only clearly-live states so a terminal or unknown-status order never makes us skip
// synthetic protection (bias: when unsure, protect).
const LIVE_ORDER_STATES = new Set([
  "new", "accepted", "pending_new", "accepted_for_bidding", "held", "calculated", "partially_filled", "open"
]);

/** A resting broker-held stop leg (e.g. an Alpaca OCO bracket stop) — a live order whose type is a stop. */
function isLiveBrokerStop(order: EquityOrder): boolean {
  return /stop/i.test(order.type) && LIVE_ORDER_STATES.has(String(order.state).trim().toLowerCase());
}

export interface StopEvaluation {
  newExtreme: number;
  triggerPrice: number;
  triggered: boolean;
  badTick: boolean;
}

/**
 * Pure trailing-stop evaluation (R2 §2.5). Given a stop and a fresh price, returns the updated
 * extreme (high-watermark for a long, low for a short), the trail trigger price, whether it has
 * triggered, and whether the print looks like a bad tick (>10% off the last good price) — which is
 * ignored so a single spurious print can neither move the trail nor fire an exit.
 */
export function evaluateStop(
  stop: Pick<SyntheticTrailingStop, "side" | "extremePrice" | "trailPercent" | "trailAmount" | "lastPrice">,
  price: number
): StopEvaluation {
  const prev = stop.lastPrice;
  const badTick = prev != null && prev > 0 && Math.abs(price - prev) / prev > BAD_TICK_PCT;
  const newExtreme = badTick
    ? stop.extremePrice
    : stop.side === "long"
      ? Math.max(stop.extremePrice, price)
      : Math.min(stop.extremePrice, price);
  const triggerPrice =
    stop.side === "long"
      ? stop.trailPercent != null
        ? newExtreme * (1 - stop.trailPercent / 100)
        : newExtreme - (stop.trailAmount ?? 0)
      : stop.trailPercent != null
        ? newExtreme * (1 + stop.trailPercent / 100)
        : newExtreme + (stop.trailAmount ?? 0);
  const triggered = !badTick && price > 0 && (stop.side === "long" ? price <= triggerPrice : price >= triggerPrice);
  return { newExtreme, triggerPrice, triggered, badTick };
}

export interface MonitorResult {
  evaluated: number;
  triggered: number;
  exited: number;
  purged: number;
}

/**
 * Synthetic trailing-stop monitor (works for any broker, incl. Robinhood MCP). Detection — extreme
 * tracking, trigger computation, bad-tick filtering — is always safe. Placing the market EXIT only
 * happens when `running` is true (the system was deliberately Started or is in a protective state
 * such as close_only/liquidating). Purges stops for positions that have closed, and auto-registers
 * a stop for each open position when `policy.riskRules.trailingStopPct` is configured and none
 * exists yet.
 */
export async function runSyntheticStopMonitor(userId: string, policy: TradingPolicy, running: boolean): Promise<MonitorResult> {
  const result: MonitorResult = { evaluated: 0, triggered: 0, exited: 0, purged: 0 };
  const accountNumber = policy.accountNumber;
  if (!accountNumber) return result;

  const activeAccount = getActiveConnectedAccount(userId);
  const executionState = deriveExecutionState(policy, activeAccount);
  // An account is an account: with none connected there is no broker to protect against.
  if (!executionState.mode) return result;
  const executionMode: ExecutionMode = executionState.mode;
  const gateway = getBrokerGateway(policy, userId);
  const source: FillSource = executionMode === "broker/live" ? "live" : "paper";

  let positions: EquityPosition[];
  try {
    positions = await gateway.getEquityPositions(accountNumber);
  } catch {
    return result; // can't evaluate safely without positions
  }
  const liveSymbols = new Set(positions.filter((p) => Math.abs(p.quantity) > 0.000001).map((p) => normalizeSymbol(p.symbol)));

  // Symbols that already carry a broker-held stop (Alpaca OCO bracket). We must NOT also auto-register
  // a synthetic trailing stop on these: with two exit paths, if the synthetic market-sells first the
  // broker's resting stop leg is stranded and can later fill as an oversell (an unintended short).
  // Keyed off ACTUAL resting orders (not policy inference) so a position is never left unprotected —
  // if listing orders fails or no live broker stop exists, the synthetic still registers below.
  let brokerStopSymbols = new Set<string>();
  try {
    const openOrders = await gateway.getEquityOrders(accountNumber);
    brokerStopSymbols = new Set(openOrders.filter(isLiveBrokerStop).map((o) => normalizeSymbol(o.symbol)));
  } catch {
    // Can't list orders — fall back to registering synthetic stops (protection over dedup).
  }

  // Purge stops whose position has closed (size hit 0).
  for (const stop of listSyntheticStops(accountNumber, userId)) {
    if (!liveSymbols.has(stop.symbol.toUpperCase())) {
      deleteSyntheticStop(stop.id, userId);
      result.purged++;
    }
  }

  // Robinhood true broker-held protective stops (opt-in): place resting stops for open longs and
  // cancel them on close. No-op unless policy.robinhoodBrokerStops is on and execution is live RH.
  try {
    await reconcileBrokerProtectiveStops({ userId, policy, accountNumber, gateway, positions, executionMode, running });
  } catch (err) {
    audit("broker_protective_stop_reconcile_error", { error: err instanceof Error ? err.message : String(err) }, userId);
  }

  // Auto-register a trailing stop for each open position when a trail % is configured.
  // Longs trail from a high-watermark and exit with a sell; shorts (only when short
  // selling is enabled) trail from a low-watermark and exit with a cover.
  const trailPct = policy.riskRules?.trailingStopPct ?? 0;
  if (trailPct > 0) {
    const existing = new Set(listSyntheticStops(accountNumber, userId).map((s) => s.symbol.toUpperCase()));
    for (const pos of positions) {
      const sym = normalizeSymbol(pos.symbol);
      // Skip symbols already covered by a broker-held stop — the broker bracket is the exit path there.
      if (Math.abs(pos.quantity) <= 0.000001 || existing.has(sym) || brokerStopSymbols.has(sym)) continue;
      const isShort = pos.quantity < 0;
      if (isShort && !policy.shortSellingEnabled) continue;
      const mark = pos.marketValue / pos.quantity; // sign-correct for long (+/+) and short (-/-)
      upsertSyntheticStop({
        id: `synstop-${userId}-${accountNumber}-${sym}`,
        userId,
        accountNumber,
        symbol: sym,
        side: isShort ? "short" : "long",
        quantity: Math.abs(pos.quantity),
        entryPrice: pos.averageCost,
        extremePrice: isShort ? Math.min(mark, pos.averageCost) : Math.max(mark, pos.averageCost),
        trailPercent: trailPct,
        status: "active"
      });
    }
  }

  const stops = listSyntheticStops(accountNumber, userId);
  if (stops.length === 0) return result;

  let quotes: Record<string, { price?: number; symbol?: string }> = {};
  try {
    quotes = await gateway.getEquityQuotes(accountNumber, stops.map((s) => normalizeSymbol(s.symbol)));
  } catch (err) {
    // API outage fallback: populate quotes with the last known price from database
    console.error("[synthetic-stops] gateway quotes fetch failed, using lastPrice database cache fallback:", err);
    for (const stop of stops) {
      if (stop.lastPrice && stop.lastPrice > 0) {
        quotes[normalizeSymbol(stop.symbol)] = { price: stop.lastPrice, symbol: stop.symbol };
      }
    }
  }
  const priceFor = (sym: string): number | undefined => {
    const q = quotes[sym] ?? quotes[normalizeSymbol(sym)];
    return q && typeof q.price === "number" && q.price > 0 ? q.price : undefined;
  };
  const marketHours = policy.allowExtendedHoursSyntheticStops ? "extended_hours" : "regular_hours";

  for (const stop of stops) {
    const price = priceFor(stop.symbol);
    result.evaluated++;
    if (price == null) continue;

    const evaln = evaluateStop(stop, price);
    // Persist the updated extreme + last good price (a bad tick keeps the previous lastPrice).
    upsertSyntheticStop({ ...stop, extremePrice: evaln.newExtreme, lastPrice: evaln.badTick ? stop.lastPrice : price });
    if (!evaln.triggered) continue;
    result.triggered++;

    if (!running) {
      audit("synthetic_stop_would_trigger", { symbol: stop.symbol, side: stop.side, price, triggerPrice: evaln.triggerPrice, note: "system not running — exit suppressed" }, userId);
      continue;
    }

    // Gated execution: fire the protective market exit (sell a long / cover a short).
    const posQty = positions.find((p) => normalizeSymbol(p.symbol) === normalizeSymbol(stop.symbol))?.quantity ?? stop.quantity;
    const qty = Math.abs(posQty); // order/fill quantity is always a positive magnitude (cover qty for shorts)
    if (qty <= 0.000001) {
      deleteSyntheticStop(stop.id, userId);
      continue;
    }
    const exitSide = stop.side === "long" ? "sell" : "cover";
    const exitProposal: TradeProposal = {
      symbol: normalizeSymbol(stop.symbol),
      side: exitSide,
      type: "market",
      quantity: qty,
      timeInForce: "gfd",
      marketHours,
      rationale: "Synthetic trailing stop fired from the protective scheduler.",
      tradeThesisTag: "Synthetic Stop",
      entryMarketRegime: "Risk Exit"
    };
    const tradability = await gateway.getEquityTradability(accountNumber, [exitProposal.symbol]).catch((err) => {
      audit("synthetic_stop_blocked", { symbol: stop.symbol, reason: "tradability_check_failed", error: err instanceof Error ? err.message : String(err) }, userId);
      return undefined;
    });
    if (!tradability?.[exitProposal.symbol]?.tradable) {
      audit("synthetic_stop_blocked", {
        symbol: stop.symbol,
        reason: tradability?.[exitProposal.symbol]?.reason ?? "Symbol is not tradable for the protective exit."
      }, userId);
      continue;
    }
    const portfolio = await gateway.getPortfolio(accountNumber).catch((err) => {
      audit("synthetic_stop_blocked", { symbol: stop.symbol, reason: "portfolio_check_failed", error: err instanceof Error ? err.message : String(err) }, userId);
      return undefined;
    });
    if (!portfolio) continue;
    const daily = dailyExecutionStats(accountNumber, new Date(), userId);
    const policyDecision = evaluateTradeProposal(exitProposal, {
      policy,
      portfolio,
      positions,
      dailyNotionalUsed: daily.notional,
      dailyOrderCount: daily.openingOrderCount,
      estimatedNotional: qty * price,
      isLiveExecution: executionMode === "broker/live"
    });
    if (!policyDecision.approved) {
      audit("synthetic_stop_blocked", { symbol: stop.symbol, reasons: policyDecision.reasons }, userId);
      continue;
    }
    // Atomically claim this stop (active -> triggered) BEFORE placing. If a previous tick's
    // monitor is still mid-placement (slow broker call spanning the next 60s tick), it already
    // claimed the stop and this run skips it — so the same protective exit can't fire twice.
    if (!claimSyntheticStop(stop.id, userId)) {
      audit("synthetic_stop_skipped_inflight", { symbol: stop.symbol, note: "already claimed/triggered by a concurrent monitor run" }, userId);
      continue;
    }
    // Deterministic ref id (stop id + trigger price) so the broker's own client_order_id
    // dedupe is a second line of defense against a duplicate exit.
    const refId = `sstop-${stop.id}-${Math.round(evaln.triggerPrice * 100)}`;
    try {
      const exec = await gateway.placeEquityOrder({
        accountNumber,
        symbol: stop.symbol,
        side: exitSide,
        type: "market",
        quantity: qty,
        timeInForce: "gfd",
        marketHours,
        refId
      });
      // B8: a paper/test protective exit is booked at the raw quote here (no broker reconciliation), so
      // debit the same execution-cost model the entry path uses — otherwise the losing tail exits cost-free
      // and overstates realized edge feeding the tuner/sizer. Live exits are unchanged (reconciled later).
      const exitPrice = applyPaperExitCost(price, exitSide, source);
      insertFillEvent({
        userId,
        accountNumber,
        source,
        executionMode,
        symbol: normalizeSymbol(stop.symbol),
        side: exitSide,
        quantity: qty,
        price: exitPrice,
        notional: qty * exitPrice,
        // Live exits are provisional at the quote price; reconcilePendingFills books the
        // real fill price/qty from the broker (brokerOrderId is the match key). Booking
        // 'filled' at the quote understates slippage at the worst possible moment. Paper/
        // test fills have no reconciliation, so they're final.
        status: source === "live" ? "pending_reconciliation" : "filled",
        brokerOrderId: exec.orderId,
        raw: { syntheticStop: true, triggerPrice: evaln.triggerPrice }
      });
      // If a broker-held protective stop is resting for this symbol, cancel it now so it can't
      // also fire on shares this synthetic exit is selling (double-sell). Best-effort.
      await cancelBrokerProtectiveStop(userId, accountNumber, stop.symbol, gateway).catch(() => {});
      // Already 'triggered' via the claim; this just records the final lastPrice.
      upsertSyntheticStop({ ...stop, status: "triggered", lastPrice: price });
      result.exited++;
      audit("synthetic_stop_triggered", { symbol: stop.symbol, side: stop.side, exitSide, price, triggerPrice: evaln.triggerPrice, quantity: qty, orderId: exec.orderId }, userId);
    } catch (err) {
      // Placement failed/uncertain — re-arm the stop so a later tick can retry rather than
      // leaving the position unprotected behind a stuck 'triggered' row.
      revertSyntheticStopClaim(stop.id, userId);
      audit("synthetic_stop_error", { symbol: stop.symbol, error: err instanceof Error ? err.message : String(err) }, userId);
    }
  }

  return result;
}
