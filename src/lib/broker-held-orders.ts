import { normalizeSymbol } from "./money";
import { shortOrderLabel } from "./order-labels";
import type { EquityOrder, EquityPosition, TradeProposal } from "./types";

const EPSILON = 1e-6;

// Exported so broker-side.test.ts can assert LIVE_ORDER_STATES (broker-side.ts) stays a superset —
// an order this module counts as active/held must also count as live protection over there.
export const ACTIVE_BROKER_ORDER_STATES = new Set([
  "accepted",
  "accepted_for_bidding",
  "confirmed",
  "held",
  "new",
  "open",
  "partially_filled",
  "pending", // Tradier bare resting state
  "pending_cancel",
  "pending_new",
  "pending_replace",
  "queued",
  "submitted",
  "suspended",
  "unconfirmed"
]);

export interface BrokerHeldExitAvailability {
  symbol: string;
  side: "sell" | "cover";
  positionQuantity: number;
  heldQuantity: number;
  availableQuantity: number;
  requestedQuantity: number;
  heldOrderIds: string[];
}

export function isActiveBrokerOrderState(state: string | undefined): boolean {
  return ACTIVE_BROKER_ORDER_STATES.has(String(state ?? "").trim().toLowerCase());
}

/**
 * Broker states that are not in ACTIVE_BROKER_ORDER_STATES but still mean the order can fill
 * or needs operator attention (stale-limit / Orders "open" list).
 *
 * Deliberately excludes `done_for_day`: that is a terminal day-order outcome that persists
 * forever in Alpaca `getEquityOrders` (`status:"all"`) history. Counting it as working made
 * the Orders screen and stale-limit path treat hundreds of historical day orders as "pending
 * open" — matching owner reports of 300+ pending on Alpaca (and similarly inflated lists on
 * other brokers that return full history).
 *
 * `stopped` — stop triggered, fill still pending. `calculated` — Alpaca pre-accept.
 * Both remain actionable; `done_for_day` does not.
 */
export const EXTRA_WORKING_ORDER_STATES = new Set(["stopped", "calculated"]);

/** True when an order should appear on the open/working Orders list (and stale-limit scan). */
export function isWorkingOrderState(state: string | undefined): boolean {
  const normalized = String(state ?? "").trim().toLowerCase();
  return isActiveBrokerOrderState(normalized) || EXTRA_WORKING_ORDER_STATES.has(normalized);
}

// CANONICAL HOME: broker-side.ts. This module previously carried its own drifted local copy
// ({canceled, cancelled, rejected, expired} — missing "failed" and "error") with NO importers;
// found by the §7 conformance audit and replaced by this re-export so the two modules can never
// diverge again. The conformance tables (broker-status-conformance.ts) lock the canonical set
// against every broker's documented vocabulary in CI.
export { isRejectedOrCanceledState } from "./broker-side";

export function evaluateBrokerHeldExitAvailability(
  proposal: TradeProposal,
  positions: EquityPosition[],
  orders: EquityOrder[]
): BrokerHeldExitAvailability | null {
  if (proposal.side !== "sell" && proposal.side !== "cover") return null;

  const symbol = normalizeSymbol(proposal.symbol);
  const exitSide: "sell" | "cover" = proposal.side;
  const requestedQuantity = requestedExitQuantity(proposal);
  if (requestedQuantity == null || requestedQuantity <= EPSILON) return null;

  const position = positions.find((item) => normalizeSymbol(item.symbol) === symbol);
  const positionQuantity = exitSide === "sell"
    ? Math.max(position?.quantity ?? 0, 0)
    : Math.max(-(position?.quantity ?? 0), 0);
  const heldOrders = orders.filter((order) =>
    normalizeSymbol(order.symbol) === symbol &&
    isActiveBrokerOrderState(order.state) &&
    orderSideHoldsExit(order, exitSide)
  );
  const heldQuantity = round6(Math.min(positionQuantity, estimatedHeldExitQuantity(heldOrders)));
  const availableQuantity = round6(Math.max(positionQuantity - heldQuantity, 0));

  if (requestedQuantity <= availableQuantity + EPSILON) return null;

  return {
    symbol,
    side: exitSide,
    positionQuantity: round6(positionQuantity),
    heldQuantity,
    availableQuantity,
    requestedQuantity: round6(requestedQuantity),
    heldOrderIds: heldOrders.map((order) => order.id).filter(Boolean)
  };
}

export function brokerHeldExitBlockReason(availability: BrokerHeldExitAvailability): string {
  const orderList = availability.heldOrderIds.length > 0
    ? ` Related open order(s): ${availability.heldOrderIds.map(shortOrderLabel).join(", ")}.`
    : "";
  return (
    `Existing open ${availability.side === "sell" ? "sell" : "cover"} order(s) already hold ` +
    `${formatQty(availability.heldQuantity)} of ${formatQty(availability.positionQuantity)} ${availability.symbol} shares ` +
    `(available ${formatQty(availability.availableQuantity)}, requested ${formatQty(availability.requestedQuantity)}). ` +
    `Cancel or replace the existing broker order before placing another ${availability.symbol} ${availability.side}.` +
    orderList
  );
}

/** Exported so UI derivations (e.g. app/console/lib/derive.ts's approval-card P/L estimate)
 *  can reuse the SAME shares-being-sold math as the broker-held-exit-availability check
 *  above, instead of re-deriving it and risking drift. Structural param (only the sizing
 *  fields) so narrow client-side proposal shapes (mobile snapshot) can call it too. */
export function requestedExitQuantity(
  proposal: Pick<TradeProposal, "quantity" | "dollarAmount" | "limitPrice" | "stopPrice" | "referencePrice">
): number | undefined {
  if (proposal.quantity != null) return Math.abs(proposal.quantity);
  if (proposal.dollarAmount != null) {
    const price = proposal.limitPrice ?? proposal.stopPrice ?? proposal.referencePrice;
    if (price != null && price > 0) return Math.abs(proposal.dollarAmount / price);
  }
  return undefined;
}

function orderSideHoldsExit(order: EquityOrder, exitSide: "sell" | "cover"): boolean {
  if (exitSide === "sell") return order.side === "sell";
  return order.side === "buy" || order.side === "cover";
}

function estimatedHeldExitQuantity(orders: EquityOrder[]): number {
  const heldOcoGroups = new Set<string>();
  let total = 0;
  for (const order of orders) {
    const remaining = remainingOrderQuantity(order);
    if (remaining <= 0) continue;
    const state = String(order.state ?? "").trim().toLowerCase();
    if (state === "held") {
      const groupKey = `${normalizeSymbol(order.symbol)}:${order.side}:${order.createdAt}:${remaining}`;
      if (heldOcoGroups.has(groupKey)) continue;
      heldOcoGroups.add(groupKey);
    }
    total += remaining;
  }
  return total;
}

function remainingOrderQuantity(order: EquityOrder): number {
  const quantity = order.quantity ?? 0;
  if (quantity <= 0) return 0;
  const filled = order.filledQuantity ?? 0;
  return Math.max(quantity - filled, 0);
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function formatQty(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}
