import { normalizeSymbol } from "./money";
import type { EquityOrder, OrderSide } from "./types";

// Our internal OrderSide encodes intent relative to the position: "buy"/"sell" act on a long,
// "short"/"cover" act on a short. Real equity broker order APIs (Alpaca, Robinhood) only accept
// "buy" or "sell" — the broker infers open-vs-close from the account's current position. So a
// "short" is submitted to the broker as a "sell" (sell shares you don't own → opens a short), and a
// "cover" is submitted as a "buy" (buy to close the short). Forwarding the raw 4-value side to the
// broker produces an invalid request; every broker submission must translate through this function.

/** Translate our 4-value intent side to the broker's 2-value equity order side. */
export function toBrokerSide(side: OrderSide): "buy" | "sell" {
  return side === "buy" || side === "cover" ? "buy" : "sell";
}

/** The short-side intents that a broker without equity shorting (e.g. Robinhood) must reject. */
export function isShortIntent(side: OrderSide): boolean {
  return side === "short" || side === "cover";
}

// Broker order-state vocabularies aren't normalized to one canonical enum (Alpaca and Robinhood
// each return their own raw state strings, with spelling variants like "canceled"/"cancelled").
// This is the single broker-agnostic check for "the broker declined/terminated this order without
// a fill" — used both immediately after placement (so a synchronous broker rejection isn't
// mislabeled "placed") and by the later reconciliation sweep (so both spellings/brokers match).
const TERMINAL_DECLINE_STATES = new Set([
  "rejected", "canceled", "cancelled", "failed", "expired",
  // Tradier-flavored terminal-decline (beyond the shared 7 words above).
  "error"
]);

export function isRejectedOrCanceledState(state: string | undefined | null): boolean {
  return TERMINAL_DECLINE_STATES.has(String(state ?? "").trim().toLowerCase());
}

/** Broker terminal state does not prove zero execution: a cancel/reject/expire can arrive after a
 * partial fill. Every placement/reconciliation path must inspect the broker-reported quantity
 * before classifying the order as wholly declined. */
export function hasBrokerReportedFill(order: { filledQuantity?: number | null }): boolean {
  return typeof order.filledQuantity === "number" && Number.isFinite(order.filledQuantity) && order.filledQuantity > 0;
}

/** A broker-reported execution is safe to book only when both cumulative quantity and the
 * broker's realized average price are present. Proposal/reference prices are useful estimates,
 * but substituting them here would permanently turn an unresolved broker receipt into invented
 * realized P&L. */
export function hasBrokerReportedPricedFill(order: {
  filledQuantity?: number | null;
  averagePrice?: number | null;
}): boolean {
  return hasBrokerReportedFill(order)
    && typeof order.averagePrice === "number"
    && Number.isFinite(order.averagePrice)
    && order.averagePrice > 0;
}

// The complementary broker-agnostic check: "this order is still RESTING/LIVE at the broker"
// (placed, not yet filled/canceled/expired/rejected/failed). Like the decline check above, the raw
// vocabularies aren't normalized to one enum — Alpaca emits new/accepted/pending_new/…/partially_
// filled, while Robinhood's resting states are queued/confirmed/unconfirmed. Both vocabularies are
// listed here so a caller (e.g. the synthetic-stop monitor deciding whether a symbol is already
// protected by a broker-held stop) recognizes a live order regardless of broker. The two
// vocabularies are disjoint — Alpaca never emits queued/confirmed/unconfirmed and Robinhood never
// emits Alpaca's — so recognizing Robinhood's resting states here can never reclassify an Alpaca
// order. Bias: list only clearly-live states, so a terminal or unknown status is treated as NOT
// live (when unsure, don't suppress protection).
const LIVE_ORDER_STATES = new Set([
  // Alpaca-flavored resting/working states.
  "new", "accepted", "pending_new", "accepted_for_bidding", "held", "calculated", "partially_filled", "open",
  // Robinhood-flavored resting states (get_equity_orders reports a working stop as one of these).
  "queued", "confirmed", "unconfirmed",
  // Tradier-flavored resting state. "pending" is a bare Tradier working state (open/partially_filled
  // are already covered above); it is also added to broker-held-orders.ts ACTIVE_BROKER_ORDER_STATES,
  // so it must be here too to keep the superset invariant guarded by broker-side.test.ts.
  "pending",
  // Non-terminal in-transition states. "pending_cancel"/"pending_replace" are deliberate: an order
  // whose cancel/replace is merely REQUESTED can still fill, so it must keep counting as live
  // protection/coverage until the broker confirms it dead — treating it as gone is what lets a
  // duplicate exit stack on top of it. This set must stay a superset of broker-held-orders.ts's
  // ACTIVE_BROKER_ORDER_STATES (guarded by a test in broker-side.test.ts) so the two active-state
  // vocabularies can't silently drift apart again.
  "submitted", "pending_cancel", "pending_replace", "suspended"
]);

export function isLiveOrderState(state: string | undefined | null): boolean {
  return LIVE_ORDER_STATES.has(String(state ?? "").trim().toLowerCase());
}

/**
 * A live open order that EXITS the position — market, limit, or stop; any of them reduces the
 * position when it executes, so any of them counts as protection. Only recognizing /stop/i-type
 * orders is what let the 2026-07-08 MU monitor fire again on top of its own resting market sell.
 * A long exits with a sell; a short exits with a cover, which brokers that infer open/close from
 * the position (Alpaca) report as a raw "buy". A broker-held stop (an Alpaca OCO bracket leg, or a
 * Robinhood broker-held protective stop in queued/confirmed/unconfirmed) is just a live exit-side
 * order, so it counts here too — there is deliberately NO separate "symbol has a live stop"
 * shortcut, which was side- and quantity-blind: a stop-BUY add-on, or a stop covering 10 of 100
 * shares, suppressed synthetic protection for shares it never covered.
 */
export function isLiveExitOrder(order: EquityOrder, positionSide: "long" | "short"): boolean {
  if (!isLiveOrderState(order.state)) return false;
  const side = String(order.side).trim().toLowerCase();
  return positionSide === "long" ? side === "sell" : side === "cover" || side === "buy";
}

// The broker-reported order-class families that mean "this leg is one half of a bracket/OCO pair,
// not a standalone order" (Alpaca `order_class`). Case-insensitive match against EquityOrder.orderClass.
const BRACKET_ORDER_CLASSES = new Set(["bracket", "oco", "oto"]);

export function isBracketOrderClass(orderClass: string | undefined): boolean {
  return typeof orderClass === "string" && BRACKET_ORDER_CLASSES.has(orderClass.trim().toLowerCase());
}

/**
 * Quantity-aware protection coverage from live exit orders. `coveredQty` sums the REMAINING open
 * quantity (quantity - filledQuantity, per the stale-limit-orders convention) across live exit
 * orders for the symbol/side — but an Alpaca OCO bracket's stop-loss and take-profit legs are
 * mutually exclusive exits for the SAME shares (filling one auto-cancels the other), so a
 * stop-type leg and a limit-type leg at the SAME remaining quantity, where BOTH report a
 * bracket-family `orderClass` (Alpaca's own broker-verified sibling identity — see
 * `isBracketOrderClass`), are paired and counted ONCE, not summed — otherwise a fully-bracketed
 * position's two legs (e.g. two live 50-share legs on a 100-share position covering only 50 real
 * shares, if the bracket was only ever half the position) look like double the real coverage,
 * silently hiding an uncovered remainder from every caller that sizes a NEW protective order off
 * this number (Codex review, PR #1331). Requiring the broker's own order-class identity — not
 * quantity alone, and not quantity plus a created-together time window — is what prevents the
 * opposite mistake: two INDEPENDENT equal-quantity exits the owner placed separately (e.g. a manual
 * 50-share stop plus a separate 50-share take-profit limit against a 100-share position, both of
 * which can actually fill, possibly even within the same few seconds) must NOT be treated as one
 * pair — that would undercount real coverage and let a new exit stack on top of a still-live one
 * (Codex review, PR #1331, twice: a time-window heuristic alone was shown to still admit this false
 * positive). An order with no orderClass (Robinhood, which has no bracket concept, or a manually
 * placed "simple" Alpaca order) never pairs — the residual risk of NOT pairing a true bracket is
 * bounded (a half-bracket looks fully covered, a pre-existing and previously-accepted gap), whereas
 * a false-positive pair risks an actual duplicate sell. Unpaired legs (e.g. a lone resting stop, or
 * a manual take-profit-only limit sell) still count on their own — pairing is opportunistic, never
 * assumed. `unknownQty` is true when any live exit order's remaining quantity is unknowable (e.g. a
 * notional/dollarAmount order reports no share quantity) — callers must then treat the position as
 * fully covered, failing toward no-duplicate-sell: those shares are broker-held, and a second sell
 * of them would be rejected anyway. A FULL-size resting exit at any price correctly blocks firing
 * for the same reason — the stale-limit-order notifier is the surface that flags a far-from-market
 * full-size limit, not a duplicate market sell from here.
 */
export function liveExitOrderCoverage(
  orders: EquityOrder[],
  symbol: string,
  positionSide: "long" | "short"
): { coveredQty: number; unknownQty: boolean } {
  let unknownQty = false;
  const stopLegs: Array<{ qty: number; bracketSibling: boolean }> = [];
  const limitLegs: Array<{ qty: number; bracketSibling: boolean }> = [];
  let otherQty = 0;
  for (const order of orders) {
    if (normalizeSymbol(order.symbol) !== symbol || !isLiveExitOrder(order, positionSide)) continue;
    if (typeof order.quantity !== "number" || !Number.isFinite(order.quantity) || order.quantity <= 0) {
      unknownQty = true;
      continue;
    }
    const remaining = Math.max(order.quantity - (order.filledQuantity ?? 0), 0);
    const bracketSibling = isBracketOrderClass(order.orderClass);
    if (order.type === "stop_market" || order.type === "stop_limit") stopLegs.push({ qty: remaining, bracketSibling });
    else if (order.type === "limit") limitLegs.push({ qty: remaining, bracketSibling });
    else otherQty += remaining;
  }
  // Pair each stop-type leg with an unused limit-type leg at a matching quantity, but ONLY when
  // both report a bracket-family orderClass — the broker's own verified sibling identity (Alpaca
  // creates both legs of a bracket/OCO together, each carrying the entry's own quantity and the
  // same order_class). Counts once per matched pair; a stop leg with no matching bracket-verified
  // sibling (no bracket, just a resting stop, or two independently-placed "simple" orders) counts
  // on its own instead.
  let coveredQty = otherQty;
  const usedLimitIdx = new Set<number>();
  for (const stopLeg of stopLegs) {
    const pairIdx = stopLeg.bracketSibling
      ? limitLegs.findIndex(
          (leg, i) => !usedLimitIdx.has(i) && leg.bracketSibling && Math.abs(leg.qty - stopLeg.qty) < 0.000001
        )
      : -1;
    if (pairIdx >= 0) usedLimitIdx.add(pairIdx);
    coveredQty += stopLeg.qty;
  }
  for (let i = 0; i < limitLegs.length; i++) {
    if (!usedLimitIdx.has(i)) coveredQty += limitLegs[i].qty;
  }
  return { coveredQty, unknownQty };
}
