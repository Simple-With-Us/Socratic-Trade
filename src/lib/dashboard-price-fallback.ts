/**
 * Price-fill fallback for the dashboard snapshot.
 *
 * Realtime venues keep the historical behaviour: when a symbol has no live
 * quote, the position's own market value is divided by its quantity so the UI
 * shows *something* (a derived cost basis).
 *
 * A VENUE-DELAYED tape (Alpaca PAPER `delayed_sip`, Tradier paper) must NOT
 * do that.  When the paper broker did not price a symbol,
 * `marketValue / quantity` is a derived cost basis, not a quote — surfacing it
 * as a current price would let the console show a stale cost-basis number as
 * if it were the venue's live tape.  The symbol stays absent instead.
 */
import { normalizeSymbol } from "./money";
import type { EquityPosition } from "./types";

/** Mirrors `VenueQuoteMode` from quotes-cascade without importing the cascade. */
export type PriceFallbackVenueMode = "realtime" | "venue_delayed" | "venue_locked";

export function applyPositionPriceFallback(
  currentPrices: Record<string, number>,
  positions: EquityPosition[],
  venueMode: PriceFallbackVenueMode
): Record<string, number> {
  // Delayed venue tape: a missing broker quote stays missing.  Never invent a
  // price from the position's own market value.
  if (venueMode === "venue_delayed") return currentPrices;
  for (const position of positions) {
    const symbol = normalizeSymbol(position.symbol);
    if (!(symbol in currentPrices) && position.quantity > 0) {
      currentPrices[symbol] = position.marketValue / position.quantity;
    }
  }
  return currentPrices;
}
