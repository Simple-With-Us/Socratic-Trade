/** Pure derivations for the Orders screen. Open orders come from the dashboard
 *  snapshot's `orders` array (GET /api/dashboard → gateway.getEquityOrders for
 *  the ACTIVE account). Stale-limit detection mirrors the server's
 *  src/lib/stale-limit-orders.ts `listStaleLimitOrders` EXACTLY — the same rule
 *  gates POST /api/orders/replace-market server-side, so a row flagged here is
 *  a row the server will actually accept a replacement for (and vice versa).
 *  src/lib is read-only for this screen; the mirrored constants are annotated
 *  with their source of truth. */

import { isWorkingOrderState as sharedIsWorkingOrderState } from "@/lib/broker-held-orders";
import { normalizeSymbol } from "@/lib/money";
import type { EquityOrder, EquityPosition, MarketQuoteSummary, TradingPolicy } from "@/lib/types";
import { estimatedClosingPnl, isClosingOrder, positionMarkPrice, type EstimatedClosingPnl } from "../lib/derive";

/** Mirrors DEFAULT_POLICY.staleLimitOrderMinutes (src/lib/defaults.ts). */
export const DEFAULT_STALE_LIMIT_MINUTES = 15;

/** Mirrors MARKET_REPLACE_TYPES in src/lib/order-replacement.ts — the only
 *  order types the replace endpoint accepts. */
const REPLACEABLE_TYPES = new Set(["limit", "stop_limit"]);

/** Re-export shared broker working-state check (excludes terminal `done_for_day`). */
export function isWorkingOrderState(state: string | undefined): boolean {
  return sharedIsWorkingOrderState(state);
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

/** Plain-English order type: "stop_market" -> "Stop-market" (decided vocabulary — leading
 *  capital, hyphenated compound). */
export function orderTypeLabel(type: string | undefined): string {
  const hyphenated = String(type ?? "").replace(/_/g, "-");
  if (!hyphenated) return "—";
  return hyphenated.charAt(0).toUpperCase() + hyphenated.slice(1);
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

/** The held position (if any) matching this order's symbol, normalized the same way the
 *  drilldown join does — so a bare/exchange-suffixed mismatch can't silently fail. */
export function matchPosition(positions: EquityPosition[] | undefined, symbol: string): EquityPosition | undefined {
  if (!positions || positions.length === 0) return undefined;
  const normalized = normalizeSymbol(symbol);
  return positions.find((p) => normalizeSymbol(p.symbol) === normalized);
}

/** Durable last-stored price for a symbol (server-side read of the
 *  symbol_field_latest store, threaded through the snapshot as
 *  `orderPriceFallbacks`). Can be hours or days old — always rendered with an
 *  age tag, never as if it were fresh. */
export interface StoredPrice {
  price: number;
  asOf: string;
  source?: string;
}

/** The snapshot's durable-store price for this order's symbol, if any. Keys are
 *  normalized server-side with the same normalizeSymbol the lookup uses. */
export function storedPriceFor(
  fallbacks: Record<string, StoredPrice> | undefined,
  symbol: string
): StoredPrice | null {
  if (!fallbacks) return null;
  const stored = fallbacks[normalizeSymbol(symbol)];
  if (!stored || typeof stored.price !== "number" || !Number.isFinite(stored.price) || stored.price <= 0) return null;
  return stored;
}

export interface EffectivePrice {
  price: number;
  source: "position" | "scan" | "store";
  asOf?: string;
  provider?: string;
}

/** The freshest price this screen can show for a symbol: when the account currently holds
 *  it, the position's OWN mark (marketValue/quantity — from the SAME snapshot as the order,
 *  so it can't be stale in a way the last scan isn't) beats the market-scan cache, which can
 *  be minutes old (see lastScanPrice). Falls back to the scan price when the symbol isn't
 *  held, then to the durable per-symbol store's last-known price (which can be hours/days
 *  old — always rendered with an age tag). Null when none is available — render "—", never
 *  invent.
 *
 *  When the position's mark price equals its average cost (within float epsilon), the broker
 *  likely had no live quote and fell back to cost basis — skip the fake mark and prefer a real
 *  scan quote when available (Robinhood getEquityPositions does this). */
export function effectiveOrderPrice(
  position: EquityPosition | undefined,
  scan: ScanPrice | null,
  stored: StoredPrice | null = null
): EffectivePrice | null {
  const markPrice = positionMarkPrice(position);
  if (markPrice !== null) {
    // Robinhood falls back to marketValue = quantity * averageCost when no quote is available,
    // making marketValue/quantity === averageCost. Prefer a real scan price in that case.
    if (scan && position && position.averageCost > 0 && Math.abs(markPrice - position.averageCost) / position.averageCost < 1e-9) {
      return { price: scan.price, source: "scan", asOf: scan.asOf, provider: scan.provider };
    }
    return { price: markPrice, source: "position" };
  }
  if (scan) return { price: scan.price, source: "scan", asOf: scan.asOf, provider: scan.provider };
  if (stored) return { price: stored.price, source: "store", asOf: stored.asOf, provider: stored.source };
  return null;
}

/** Estimated P/L for an open order that would CLOSE/REDUCE the matched position (see
 *  isClosingOrder), using the UNFILLED remainder as the closing share count (what would
 *  actually execute from here) and the freshest available price (see effectiveOrderPrice).
 *  The share count is capped to the current position size so stale oversize exit orders
 *  (e.g. the user manually reduced the position after the approval card was created) don't
 *  overstate the P/L estimate. Null for an opening order, an order with no matching position,
 *  or a missing/non-positive price or remainder — never fabricated. */
export function closingOrderPnl(
  order: EquityOrder,
  remaining: number,
  position: EquityPosition | undefined,
  effectivePrice: EffectivePrice | null
): EstimatedClosingPnl | null {
  if (!isClosingOrder(order, position) || !position) return null;
  const shares = Math.min(remaining, Math.abs(position.quantity));
  return estimatedClosingPnl({ position, shares, currentPrice: effectivePrice?.price });
}

/** Coarse age for stored-price tags — "12m" / "23h" / "3d". Null when the
 *  timestamp is missing or unparseable (render no tag, never invent one). */
export function fmtAge(iso: string | undefined, now = Date.now()): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const minutes = Math.max(0, Math.floor((now - t) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
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
