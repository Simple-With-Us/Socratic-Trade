// True broker-held protective stops for Robinhood.
//
// Robinhood's MCP cannot hold a native OCO bracket (unlike Alpaca), so a held position is otherwise
// protected only by the app's synthetic scheduler-tick monitor — a single point of failure if the
// app is offline. This module places a resting broker-side stop-market SELL (GTC) at stopLossPct
// below entry for each open Robinhood LIVE long, and cancels it when the position closes or a
// synthetic exit fires (so an orphaned stop can't sell shares we no longer hold).
//
// Reconciliation runs from the synthetic-stop monitor each tick: it CANCELS stops for closed
// positions every time (risk-reducing, always safe) and PLACES missing stops only when the system is
// running. This self-heals — a restart re-places any missing stops for still-open positions. Gated
// to live Robinhood with the opt-in policy.robinhoodBrokerStops flag (default off): the synthetic
// monitor remains the always-on fallback, so this is purely additive protection.

import {
  audit,
  deleteBrokerProtectiveStop,
  listBrokerProtectiveStops,
  upsertBrokerProtectiveStop
} from "./db";
import { normalizeSymbol } from "./money";
import { livePreflightBlocks } from "./preflight-live-guard";
import type { BrokerGateway, EquityPosition, ExecutionMode, TradingPolicy } from "./types";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** True when broker-held protective stops should be maintained for this run. */
export function brokerProtectiveStopsEnabled(policy: TradingPolicy, executionMode: ExecutionMode): boolean {
  return (
    policy.robinhoodBrokerStops === true &&
    executionMode === "broker/live" &&
    policy.activeBroker === "robinhood" &&
    (policy.riskRules?.stopLossPct ?? 0) > 0
  );
}

/**
 * Cancel + forget the resting protective stop(s) for one symbol (best-effort). Safe to call
 * unconditionally — used when a synthetic exit fires so the resting stop can't double-sell.
 */
export async function cancelBrokerProtectiveStop(
  userId: string,
  accountNumber: string,
  symbol: string,
  gateway: BrokerGateway
): Promise<void> {
  const sym = normalizeSymbol(symbol);
  for (const row of listBrokerProtectiveStops(accountNumber, userId)) {
    if (normalizeSymbol(row.symbol) !== sym) continue;
    try {
      await gateway.cancelEquityOrder(accountNumber, row.brokerOrderId);
      deleteBrokerProtectiveStop(row.id, userId);
    } catch (err) {
      audit("broker_protective_stop_cancel_error", { symbol: sym, brokerOrderId: row.brokerOrderId, error: errMsg(err) }, userId);
      // Mark as pending_cancel in DB instead of deleting immediately, to retry later
      upsertBrokerProtectiveStop({ ...row, status: "pending_cancel" });
    }
  }
}

export interface ReconcileResult {
  placed: number;
  cancelled: number;
}

/**
 * Reconcile broker-held protective stops against current positions. Cancels stops whose position has
 * closed (always), then — only when `running` — places a resting stop for each open long that lacks
 * one. No-op unless the policy flag is on and execution is live Robinhood.
 */
export async function reconcileBrokerProtectiveStops(args: {
  userId: string;
  policy: TradingPolicy;
  accountNumber: string;
  gateway: BrokerGateway;
  positions: EquityPosition[];
  executionMode: ExecutionMode;
  running: boolean;
}): Promise<ReconcileResult> {
  const { userId, policy, accountNumber, gateway, positions, executionMode, running } = args;
  const out: ReconcileResult = { placed: 0, cancelled: 0 };
  if (!brokerProtectiveStopsEnabled(policy, executionMode)) return out;
  const stopPct = policy.riskRules!.stopLossPct!;

  // Robinhood is long-only, so protective stops only apply to long positions. Computed UP FRONT
  // (before any cancel) so the guards below know which positions are still open.
  const liveLongs = new Map<string, EquityPosition>();
  for (const p of positions) {
    if (p.quantity > 0.000001) liveLongs.set(normalizeSymbol(p.symbol), p);
  }
  // Would a live REPLACEMENT stop be blocked (broker/live without ALLOW_LIVE_TRADING)? If so, we must
  // not cancel an OPEN position's only stop with no replacement — that would leave it unprotected.
  // Cancels for CLOSED positions stay risk-reducing and are never blocked.
  const liveReplaceBlocked = livePreflightBlocks({ mode: executionMode });

  // 1. Retry pending cancellations first — but for a STILL-OPEN position, skip the retry when a
  //    replacement can't be placed (keep its existing stop rather than orphaning the position).
  for (const row of listBrokerProtectiveStops(accountNumber, userId)) {
    if (row.status === "pending_cancel") {
      if (liveReplaceBlocked && liveLongs.has(normalizeSymbol(row.symbol))) continue;
      try {
        await gateway.cancelEquityOrder(accountNumber, row.brokerOrderId);
        deleteBrokerProtectiveStop(row.id, userId);
        out.cancelled++;
      } catch (err) {
        // Keep it in DB as pending_cancel to retry on the next tick
        console.error(`[protective-stops] retry cancel failed for ${row.symbol} order ${row.brokerOrderId}:`, err);
      }
    }
  }

  // 2. Cancel-on-close (runs regardless of `running` — cancelling is always risk-reducing).
  for (const row of listBrokerProtectiveStops(accountNumber, userId)) {
    if (row.status === "pending_cancel") continue; // already handled
    if (!liveLongs.has(normalizeSymbol(row.symbol))) {
      try {
        await gateway.cancelEquityOrder(accountNumber, row.brokerOrderId);
        deleteBrokerProtectiveStop(row.id, userId);
        out.cancelled++;
      } catch (err) {
        audit("broker_protective_stop_cancel_error", { symbol: row.symbol, brokerOrderId: row.brokerOrderId, error: errMsg(err) }, userId);
        // Mark as pending_cancel to retry later
        upsertBrokerProtectiveStop({ ...row, status: "pending_cancel" });
      }
    }
  }

  if (!running) return out;

  // 3. Mismatch detection: if quantity or stop price has drifted, cancel the existing stop.
  // On the next loop, it will be re-placed with correct values. This is a cancel-THEN-place: if the
  // re-place (section 4) would be blocked (`liveReplaceBlocked`, computed above), skip the cancel so we
  // KEEP the existing (slightly-mismatched) protective stop rather than orphaning the position.
  const existingStops = listBrokerProtectiveStops(accountNumber, userId);
  for (const [sym, pos] of liveLongs) {
    const existingStop = existingStops.find((r) => normalizeSymbol(r.symbol) === sym);
    if (existingStop && existingStop.status === "resting") {
      const qty = Math.abs(pos.quantity);
      const targetStopPrice = round2(pos.averageCost * (1 - stopPct / 100));

      const qtyMismatch = Math.abs(existingStop.quantity - qty) > 0.000001;
      const priceMismatch = Math.abs(existingStop.stopPrice - targetStopPrice) > 0.02;

      if ((qtyMismatch || priceMismatch) && !liveReplaceBlocked) {
        audit("broker_protective_stop_mismatch", {
          symbol: sym,
          oldQty: existingStop.quantity,
          newQty: qty,
          oldStopPrice: existingStop.stopPrice,
          newStopPrice: targetStopPrice
        }, userId);

        try {
          await gateway.cancelEquityOrder(accountNumber, existingStop.brokerOrderId);
          deleteBrokerProtectiveStop(existingStop.id, userId);
          out.cancelled++;
        } catch (err) {
          audit("broker_protective_stop_cancel_error", { symbol: sym, brokerOrderId: existingStop.brokerOrderId, error: errMsg(err) }, userId);
          upsertBrokerProtectiveStop({ ...existingStop, status: "pending_cancel" });
        }
      }
    }
  }

  // 4. Place-if-missing for each open long without a resting stop (excluding pending_cancel ones).
  const currentStops = listBrokerProtectiveStops(accountNumber, userId);
  const existing = new Set(
    currentStops
      .filter((r) => r.status !== "pending_cancel")
      .map((r) => normalizeSymbol(r.symbol))
  );

  for (const [sym, pos] of liveLongs) {
    if (existing.has(sym)) continue;
    if (!(pos.averageCost > 0)) continue;
    const qty = Math.abs(pos.quantity);
    const stopPrice = round2(pos.averageCost * (1 - stopPct / 100));
    if (!(stopPrice > 0)) continue;
    const refId = `protstop-${userId}-${accountNumber}-${sym}-${Date.now()}`;
    try {
      const exec = await gateway.placeEquityOrder({
        accountNumber,
        symbol: sym,
        side: "sell",
        type: "stop_market",
        quantity: qty,
        stopPrice,
        timeInForce: "gtc",
        marketHours: "regular_hours",
        refId
      });
      if (!exec.orderId) {
        // No broker order id means we couldn't later cancel it — don't record an untrackable stop.
        audit("broker_protective_stop_error", { symbol: sym, stopPrice, error: "broker returned no order id" }, userId);
        continue;
      }
      upsertBrokerProtectiveStop({
        id: `protstop-${userId}-${accountNumber}-${sym}`,
        userId,
        accountNumber,
        symbol: sym,
        brokerOrderId: exec.orderId,
        quantity: qty,
        stopPrice,
        status: "resting"
      });
      out.placed++;
      audit("broker_protective_stop_placed", { symbol: sym, stopPrice, quantity: qty, brokerOrderId: exec.orderId }, userId);
    } catch (err) {
      audit("broker_protective_stop_error", { symbol: sym, stopPrice, error: errMsg(err) }, userId);
    }
  }
  return out;
}
