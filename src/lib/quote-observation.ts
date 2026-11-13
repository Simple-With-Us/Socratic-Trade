/**
 * Observed quote price and time.
 *
 * Price is the provider's last print, then the two-sided mid.  A size, a
 * one-sided bid or ask, and a prior close are never the price.  The timestamp
 * is the provider's own observation time.  This module never reads the clock.
 */

export type ObservedPriceBasis = "last" | "mid";

export function positiveQuoteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.replace(/[$,\s]/g, ""));
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

/** Last print, else the mid of a two-sided book.  Anything else is not a price. */
export function selectObservedQuotePrice(input: {
  last?: unknown;
  bid?: unknown;
  ask?: unknown;
}): { price?: number; basis?: ObservedPriceBasis } {
  const last = positiveQuoteNumber(input.last);
  if (last !== undefined) return { price: last, basis: "last" };
  const bid = positiveQuoteNumber(input.bid);
  const ask = positiveQuoteNumber(input.ask);
  if (bid !== undefined && ask !== undefined) return { price: (bid + ask) / 2, basis: "mid" };
  return {};
}

/**
 * A provider timestamp, or undefined.  Epoch milliseconds, epoch seconds, and
 * ISO strings are accepted.  The wall clock is never substituted.
 */
export function providerObservationIso(value: unknown): string | undefined {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value > 1e9 ? value * 1000 : Number.NaN;
    return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    if (/^\d+$/.test(trimmed)) return providerObservationIso(Number(trimmed));
    const ms = Date.parse(trimmed);
    // Keep the provider's own string when it already parses.  Reformatting
    // would replace their timestamp with a clock we generated.
    return Number.isFinite(ms) ? trimmed : undefined;
  }
  return undefined;
}
