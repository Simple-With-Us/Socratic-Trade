// How a protective exit (synthetic-stop monitor OR proactive risk-exit) is routed with respect to the
// `allowExtendedHoursSyntheticStops` policy toggle ("App stops in extended hours").
//
// The honest default (toggle OFF, or a regular/closed session): a plain MARKET order tagged
// regular_hours — unchanged behavior. A stop that triggers pre/post-market rests at the broker until
// the 09:30 open (market-certainty at the open; you eat any overnight gap).
//
// When the toggle is ON *and* it is the pre/post session: a MARKETABLE-LIMIT order tagged
// extended_hours. This is the ONLY way the exit can actually fill after hours — Alpaca rejects a
// market order with extended_hours=true (extended-hours orders must be DAY limit orders), and the MCP
// path drops the flag entirely, so the previous "market + extended_hours" attempt either 422'd or
// no-op'd. The limit crosses the spread off the current quote so it fills in thin liquidity: a SELL
// prices DOWN off the BID and a COVER/buy-to-close UP off the ASK (the side the order must cross to
// be marketable — the composite quote price is ask-biased), by `marketableLimitBufferBps` (default
// 15). Residual risk the owner accepted: a violent gap can blow through the limit and not fill.
//
// Fails safe everywhere: no usable price, "limit" not in permittedOrderTypes, a fractional exit
// quantity (fractional orders are regular-hours-only at the broker and hard-blocked by policy), or
// the toggle off ⇒ fall back to the market/queue-to-open routing rather than leave a position
// unprotected.

import { getEarlyCloseDays } from "./market-calendar";
import { currentMarketSession, type MarketSession } from "./market-hours";
import type { TradeProposal, TradingPolicy } from "./types";

const DEFAULT_MARKETABLE_LIMIT_BUFFER_BPS = 15;
// Sanity ceiling for the tunable buffer: 500 bps = 5% through the quote. Anything past that is a
// typo/units mistake (e.g. percent typed into a bps field), not a plausible crossing buffer.
const MAX_MARKETABLE_LIMIT_BUFFER_BPS = 500;

export interface ProtectiveExitRouting {
  type: "market" | "limit";
  marketHours: "regular_hours" | "extended_hours";
  /** Set only when `type === "limit"`. */
  limitPrice?: number;
}

/**
 * Quote reference for pricing a protective exit. `bid`/`ask` (when real and positive) anchor the
 * side the order must cross; `price` is the composite/last price used as the fallback anchor when
 * that side is missing. Callers must not pass a synthesized (price-derived) spread side — leave it
 * undefined so the composite fallback applies (mirrors the entry marketable-limit guard).
 */
export interface ProtectiveExitQuote {
  price?: number;
  bid?: number;
  ask?: number;
}

const MARKET_REGULAR: ProtectiveExitRouting = { type: "market", marketHours: "regular_hours" };

/**
 * The validated marketable-limit buffer (bps) for THIS policy, ignoring session/toggle gating: the
 * policy route bounds NEW saves, but an already-stored zero/negative buffer would INVERT the
 * marketable price (a SELL limit at/above the reference rests unfilled) — fall back to the default
 * rather than price an exit off a nonsense buffer; an absurd stored value clamps to the ceiling.
 * Also the proportional tolerance for the approval-time reprice materiality check below.
 */
export function validatedMarketableLimitBufferBps(policy: TradingPolicy): number {
  const tuned = policy.tuning?.marketableLimitBufferBps;
  if (typeof tuned !== "number" || !Number.isFinite(tuned) || tuned <= 0) return DEFAULT_MARKETABLE_LIMIT_BUFFER_BPS;
  return Math.min(tuned, MAX_MARKETABLE_LIMIT_BUFFER_BPS);
}

/**
 * Session resolution for protective-exit routing, EARLY-CLOSE aware. currentMarketSession hard-codes
 * the 16:00 ET close, so on an NYSE early-close day (13:00 ET close — July 4th eve, Black Friday,
 * Christmas Eve; see getEarlyCloseDays) it misclassifies 13:00–16:00 ET as "regular", which would
 * downgrade an extended-hours protective limit to a regular-hours market order that queues to the
 * NEXT open (or rejects) during a session where after-hours trading is live. Minimal correct model:
 * on an early-close date, post-close wall-clock time is the "post" session. (The broker may end the
 * shortened after-hours session earlier than a normal day's 20:00 — that residual mirrors the
 * existing model's imprecision and fails toward an order the broker rejects into the queue-to-open
 * fallback, never toward a mispriced fill.)
 */
export function protectiveExitMarketSession(now?: Date): MarketSession {
  const session = currentMarketSession(now);
  if (session !== "regular") return session;
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  const parts = Object.fromEntries(fmt.formatToParts(now ?? new Date()).map((p) => [p.type, p.value]));
  const dateStr = `${parts.year}-${parts.month}-${parts.day}`;
  if (!getEarlyCloseDays(parseInt(parts.year, 10)).has(dateStr)) return session;
  const hour = parseInt(parts.hour === "24" ? "0" : parts.hour, 10);
  const totalMinutes = hour * 60 + parseInt(parts.minute, 10);
  const EARLY_CLOSE = 13 * 60; // 13:00 ET
  return totalMinutes >= EARLY_CLOSE ? "post" : "regular";
}

/**
 * The marketable-limit buffer (bps) to use for an extended-hours protective exit RIGHT NOW, or
 * undefined when extended-hours routing does not apply (toggle off, "limit" not permitted, or the
 * current session is regular/closed). Shared by the synthetic monitor and the async strategy run so
 * the session/permission decision is made in exactly one place. `now` is injectable for tests.
 */
export function extendedHoursExitBufferBps(policy: TradingPolicy, now?: Date): number | undefined {
  if (policy.allowExtendedHoursSyntheticStops !== true) return undefined;
  // A limit order is mandatory in the extended session; honor the permitted-order-types cage.
  if (!(policy.permittedOrderTypes?.includes("limit") ?? true)) return undefined;
  const session = protectiveExitMarketSession(now);
  if (session !== "pre" && session !== "post") return undefined;
  return validatedMarketableLimitBufferBps(policy);
}

/**
 * Tick-aware OUTWARD limit-price rounding, shared by the protective-exit reprice below and the
 * approval-time ordinary-limit reprice (src/lib/approval-reprice.ts). Symmetric Math.round can
 * UN-cross a thin quote: a SELL anchored to a $0.496 bid with a 15 bps buffer rounds UP to $0.50 —
 * above the bid, resting unfilled exactly where the exit must fill; rounding in the order's
 * marketable direction ("up" for buy-side, "down" for sell-side) can never make the price less
 * marketable than the exact input. Sub-$1 prices may quote in $0.0001 increments (SEC Rule 612), so
 * use 4 dp below $1 and whole pennies at/above $1.
 */
export function roundLimitOutwardToTick(raw: number, direction: "up" | "down"): number | undefined {
  const factor = raw < 1 ? 10_000 : 100;
  const scaled = raw * factor;
  const nearestTick = Math.round(scaled);
  // Snap float artifacts (e.g. 99.85 * 100 = 9984.999...94) to the exact tick instead of pushing a
  // genuinely-on-tick price one tick further out; otherwise round outward.
  const ticks = Math.abs(scaled - nearestTick) < 1e-6
    ? nearestTick
    : direction === "up"
      ? Math.ceil(scaled)
      : Math.floor(scaled);
  const price = ticks / factor;
  return price > 0 ? price : undefined;
}

/**
 * Marketable-limit price for a protective exit: cross the spread so a thin-liquidity extended-hours
 * order still fills. A SELL (long exit) prices DOWN off the BID and a COVER (short buy-to-close)
 * prices UP off the ASK — pricing a SELL off the composite quote price (ask ?? bid on Alpaca) would
 * leave the limit ABOVE the bid on any spread wider than the buffer, i.e. not marketable at all.
 * The composite `price` is only the fallback anchor when the crossing side is missing. Returns
 * undefined when no usable anchor exists so the caller falls back to a market order.
 *
 * Rounding is tick-aware and OUTWARD via roundLimitOutwardToTick (down for a SELL, up for a COVER):
 * the entry marketable-limit path rounds 2 dp, but protective exits need the finer sub-$1 tick to
 * stay marketable on sub-dollar symbols.
 */
export function marketableLimitExitPrice(quote: ProtectiveExitQuote, exitSide: "sell" | "cover", bufferBps: number): number | undefined {
  const usable = (value: number | undefined): number | undefined =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
  const anchor = exitSide === "cover" ? (usable(quote.ask) ?? usable(quote.price)) : (usable(quote.bid) ?? usable(quote.price));
  if (anchor === undefined) return undefined;
  const buffer = bufferBps / 10_000;
  const raw = exitSide === "cover" ? anchor * (1 + buffer) : anchor * (1 - buffer);
  return roundLimitOutwardToTick(raw, exitSide === "cover" ? "up" : "down");
}

/**
 * Resolve routing for a single protective exit given the live policy, the exit side, the last known
 * quote, and the exit quantity. Used by the every-tick synthetic monitor (which has `now` = wall
 * clock) and by the approval-time reprice below. Returns the market/queue-to-open default unless the
 * extended-hours toggle applies in the current session, the quantity is a whole share count
 * (fractional orders are regular-hours-only at the broker and hard-blocked by policy — routing one
 * to extended hours would block the exit instead of queuing it), and a usable marketable-limit price
 * can be computed.
 */
export function resolveProtectiveExitRouting(
  policy: TradingPolicy,
  exitSide: "sell" | "cover",
  quote: ProtectiveExitQuote | undefined,
  now?: Date,
  quantity?: number
): ProtectiveExitRouting {
  const bufferBps = extendedHoursExitBufferBps(policy, now);
  if (bufferBps === undefined || quote === undefined) return MARKET_REGULAR;
  if (quantity !== undefined && !Number.isInteger(quantity)) return MARKET_REGULAR;
  const limitPrice = marketableLimitExitPrice(quote, exitSide, bufferBps);
  if (limitPrice === undefined) return MARKET_REGULAR;
  return { type: "limit", marketHours: "extended_hours", limitPrice };
}

/**
 * The claim condition for the approval-time protective-exit reprice below: an extended-hours
 * protective-exit limit. Exported so the ordinary-limit reprice (src/lib/approval-reprice.ts) can
 * decline exactly what this path owns — including when this path deliberately KEPT the stored limit
 * (fresh routing priced the same marketable limit), which must not then be ratio-re-anchored off the
 * composite price by the sibling path.
 */
export function isApprovalRepriceProtectiveExit(proposal: TradeProposal): boolean {
  return (
    (proposal.tradeThesisTag === "Risk-Exit" || proposal.tradeThesisTag === "Synthetic Stop") &&
    proposal.type === "limit" &&
    proposal.marketHours === "extended_hours" &&
    (proposal.side === "sell" || proposal.side === "cover")
  );
}

/**
 * Re-resolve a STORED protective exit's routing at placement time. Under propose authority the
 * Risk-Exit card can sit for minutes/hours between generation and the human Approve; an
 * extended-hours marketable-limit is only as good as the quote it was priced off, so a market that
 * moved through the stale limit would leave the once-marketable order resting unfilled exactly where
 * the queue-to-open market exit would still get out. Recomputes routing against the fresh quote and
 * wall clock, degrading to market/regular_hours when extended-hours routing no longer applies
 * (session over, toggle off, no usable quote). Anything that is not an extended-hours
 * protective-exit limit passes through untouched — entries and regular-hours exits keep their
 * reviewed shape.
 */
export function repriceStoredProtectiveExit(
  proposal: TradeProposal,
  policy: TradingPolicy,
  quote: ProtectiveExitQuote | undefined,
  now?: Date
): TradeProposal {
  if (proposal.side !== "sell" && proposal.side !== "cover") return proposal;
  if (!isApprovalRepriceProtectiveExit(proposal)) return proposal;
  const routing = resolveProtectiveExitRouting(policy, proposal.side, quote, now, proposal.quantity);
  if (routing.type === "limit" && routing.limitPrice === proposal.limitPrice) return proposal;
  return { ...proposal, type: routing.type, limitPrice: routing.limitPrice, marketHours: routing.marketHours };
}

export interface ProtectiveExitRepriceDrift {
  material: boolean;
  toleranceBps: number;
  priceDriftBps?: number;
  notionalDriftBps?: number;
}

/**
 * Materiality of an approval-time protective-exit reprice, for the LIVE typed-confirmation
 * invariant: the phrase the user typed confirmed the STORED order, so on broker/live with typed
 * confirmations on, a reprice may only place silently when the change is immaterial — price (and,
 * when a confirmed notional exists, notional) within the marketable-limit buffer tolerance, the
 * same validated bps the reprice itself uses. Anything larger goes back to the human (repo
 * precedent: autoRemediateStaleExitOrders defers live+typed-confirm remediation to the human).
 *
 * The fresh reference price is the repriced limit, or — when the reprice degraded to the
 * market/queue-to-open default — the marketable price a fresh limit WOULD take off the current
 * quote (so a pure session-expiry degrade with an unmoved quote is immaterial). No stored price or
 * no usable fresh reference ⇒ material: what would be placed cannot be verified against what was
 * confirmed, so defer to the human rather than guess.
 */
export function assessProtectiveExitRepriceDrift(
  stored: TradeProposal,
  repriced: TradeProposal,
  policy: TradingPolicy,
  quote: ProtectiveExitQuote | undefined,
  confirmedNotional?: number
): ProtectiveExitRepriceDrift {
  const toleranceBps = validatedMarketableLimitBufferBps(policy);
  const usable = (value: number | undefined): number | undefined =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
  const storedPrice = usable(stored.limitPrice);
  const exitSide = repriced.side === "cover" ? "cover" : "sell";
  const freshRef = repriced.type === "limit"
    ? usable(repriced.limitPrice)
    : quote !== undefined
      ? marketableLimitExitPrice(quote, exitSide, toleranceBps)
      : undefined;
  if (storedPrice === undefined || freshRef === undefined) return { material: true, toleranceBps };
  const priceDriftBps = (Math.abs(freshRef - storedPrice) / storedPrice) * 10_000;
  const quantity = typeof repriced.quantity === "number" && Number.isFinite(repriced.quantity) ? repriced.quantity : undefined;
  const confirmed = usable(confirmedNotional);
  const notionalDriftBps = confirmed !== undefined && quantity !== undefined
    ? (Math.abs(quantity * freshRef - confirmed) / confirmed) * 10_000
    : undefined;
  return {
    material: priceDriftBps > toleranceBps || (notionalDriftBps !== undefined && notionalDriftBps > toleranceBps),
    toleranceBps,
    priceDriftBps,
    notionalDriftBps
  };
}
