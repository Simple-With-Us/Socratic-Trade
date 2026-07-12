/** Pure derivations for the Orders screen. Open orders come from the dashboard
 *  snapshot's `orders` array (GET /api/dashboard → gateway.getEquityOrders for
 *  the ACTIVE account). Stale-limit detection mirrors the server's
 *  src/lib/stale-limit-orders.ts `listStaleLimitOrders` EXACTLY — the same rule
 *  gates POST /api/orders/replace-market server-side, so a row flagged here is
 *  a row the server will actually accept a replacement for (and vice versa).
 *  src/lib is read-only for this screen; the mirrored constants are annotated
 *  with their source of truth. */

import { isActiveBrokerOrderState } from "@/lib/broker-held-orders";
import type { EquityOrder, MarketQuoteSummary, TradingPolicy } from "@/lib/types";

/** Mirrors DEFAULT_POLICY.staleLimitOrderMinutes (src/lib/defaults.ts). */
export const DEFAULT_STALE_LIMIT_MINUTES = 15;

/** Mirrors EXTRA_WORKING_STATES in src/lib/stale-limit-orders.ts — broker
 *  pseudo-active states that still count as "working" for staleness. */
const EXTRA_WORKING_STATES = new Set(["done_for_day", "stopped", "calculated"]);

/** Mirrors MARKET_REPLACE_TYPES in src/lib/order-replacement.ts — the only
 *  order types the replace endpoint accepts. */
const REPLACEABLE_TYPES = new Set(["limit", "stop_limit"]);

export function isWorkingOrderState(state: string | undefined): boolean {
  const normalized = String(state ?? "").trim().toLowerCase();
  return isActiveBrokerOrderState(normalized) || EXTRA_WORKING_STATES.has(normalized);
}

export function isReplaceableType(type: string | undefined): boolean {
  return REPLACEABLE_TYPES.has(String(type ?? "").trim().toLowerCase());
}

/** Unfilled remainder — what a market replacement would actually submit.
 *  Dollar-based orders carry no share quantity, so their remainder is 0 and
 *  they can never be replaced (same as the server). */
export function remainingQuantity(order: EquityOrder): number {
  const quantity = order.quantity ?? 0;
  const filled = order.filledQuantity ?? 0;
  return Math.max(quantity - filled, 0);
}

/** Mirrors staleLimitOrderThresholdMinutes (src/lib/stale-limit-orders.ts):
 *  policy value, defaulting to 15; 0 (or negative) disables stale detection. */
export function staleThresholdMinutes(policy: Pick<TradingPolicy, "staleLimitOrderMinutes">): number {
  const threshold = policy.staleLimitOrderMinutes ?? DEFAULT_STALE_LIMIT_MINUTES;
  return Number.isFinite(threshold) && threshold > 0 ? threshold : 0;
}

export interface OpenOrderRow {
  order: EquityOrder;
  /** Whole minutes since the broker accepted the order; null when createdAt is
   *  unparseable or in the future (clock skew) — the server skips those too. */
  ageMinutes: number | null;
  remaining: number;
  /** True exactly when the server's listStaleLimitOrders would include this
   *  order: limit/stop-limit, working, unfilled remainder, and at least
   *  `thresholdMinutes` old. Stale ⇔ replace-at-market is accepted. */
  stale: boolean;
  thresholdMinutes: number;
}

export function deriveOpenOrders(
  orders: EquityOrder[],
  policy: Pick<TradingPolicy, "staleLimitOrderMinutes">,
  now: Date = new Date()
): OpenOrderRow[] {
  const thresholdMinutes = staleThresholdMinutes(policy);
  const nowMs = now.getTime();
  return orders
    .filter((order) => isWorkingOrderState(order.state))
    .map((order) => {
      const createdMs = Date.parse(order.createdAt);
      const ageMinutes =
        Number.isFinite(createdMs) && createdMs <= nowMs ? Math.floor((nowMs - createdMs) / 60_000) : null;
      const remaining = remainingQuantity(order);
      const stale =
        thresholdMinutes > 0 &&
        isReplaceableType(order.type) &&
        ageMinutes !== null &&
        ageMinutes >= thresholdMinutes &&
        remaining > 0;
      return { order, ageMinutes, remaining, stale, thresholdMinutes };
    })
    .sort(
      // Stale rows first (they need a decision), then longest-working first.
      (a, b) => Number(b.stale) - Number(a.stale) || (b.ageMinutes ?? -1) - (a.ageMinutes ?? -1)
    );
}

function orderSortTime(order: EquityOrder): number {
  const t = Date.parse(order.updatedAt ?? order.createdAt);
  return Number.isFinite(t) ? t : 0;
}

/** Finished (non-working) orders, newest first, for the history section. */
export function terminalOrders(orders: EquityOrder[], limit = 20): EquityOrder[] {
  return orders
    .filter((order) => !isWorkingOrderState(order.state))
    .sort((a, b) => orderSortTime(b) - orderSortTime(a))
    .slice(0, limit);
}

/** "partially_filled" → "Partially Filled" (mirrors the legacy dashboard's
 *  readableOrderState). */
export function readableState(state: string | undefined): string {
  return String(state ?? "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function orderTypeLabel(type: string | undefined): string {
  return String(type ?? "").replace(/_/g, "-") || "—";
}

/** Mirrors marketReplaceText in src/lib/order-replacement.ts. On any mismatch
 *  the server answers 409 with ITS authoritative expectedText, which the sheet
 *  renders verbatim — this is only the optimistic first guess. */
export function marketReplaceText(symbol: string): string {
  return `REPLACE LIVE ${symbol.trim().toUpperCase()}`;
}

export interface ScanPrice {
  price: number;
  asOf?: string;
  provider?: string;
}

/** Latest price this app knows for a symbol — from the most recent market
 *  scan in the snapshot (same source the symbol drilldown uses). Null when the
 *  last scan didn't cover the symbol; render "—", never invent. */
export function lastScanPrice(
  quotesBySymbol: Record<string, MarketQuoteSummary> | undefined,
  symbol: string
): ScanPrice | null {
  if (!quotesBySymbol) return null;
  const normalized = symbol.trim().toUpperCase();
  const quote =
    quotesBySymbol[normalized] ??
    Object.values(quotesBySymbol).find((q) => q.symbol?.trim().toUpperCase() === normalized);
  if (!quote || typeof quote.price !== "number" || !Number.isFinite(quote.price)) return null;
  return { price: quote.price, asOf: quote.asOf, provider: quote.provider };
}

/** "17m" / "3h 2m" / "2d 5h" for whole-minute ages. */
export function fmtMinutes(minutes: number | null): string {
  if (minutes === null || !Number.isFinite(minutes) || minutes < 0) return "—";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}
