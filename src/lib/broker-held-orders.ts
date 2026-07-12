import { normalizeSymbol } from "./money";
import type { EquityOrder, EquityPosition, TradeProposal } from "./types";

const EPSILON = 1e-6;

const ACTIVE_BROKER_ORDER_STATES = new Set([
  "accepted",
  "accepted_for_bidding",
  "confirmed",
  "held",
  "new",
  "open",
  "partially_filled",
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
    ? ` Related open order(s): ${availability.heldOrderIds.join(", ")}.`
    : "";
  return (
    `Existing open ${availability.side === "sell" ? "sell" : "cover"} order(s) already hold ` +
    `${formatQty(availability.heldQuantity)} of ${formatQty(availability.positionQuantity)} ${availability.symbol} shares ` +
    `(available ${formatQty(availability.availableQuantity)}, requested ${formatQty(availability.requestedQuantity)}). ` +
    `Cancel or replace the existing broker order before placing another ${availability.symbol} ${availability.side}.` +
    orderList
  );
}

function requestedExitQuantity(proposal: TradeProposal): number | undefined {
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
