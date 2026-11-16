/**
 * Delayed Yahoo fallback — owner ruling 2026-08-18.
 *
 * When live broker / Alpaca snapshot quotes fail, the cascade keeps the
 * freshest Yahoo print (~15–20m delayed) so openings still go through.
 * That tape is expected delay, not a broken cascade.  Approval cards stamp
 * user-facing "Delayed Quote" only — no coordinator notes.  Do not
 * fail-closed openings.  Do not skip Green/Red.
 */

/** Last regular-session close used to size an unquoted symbol.  Not Yahoo delayed tape. */
export const SESSION_CLOSE_PROVIDER = "session-close";

/** User-facing approval-card stamp (Title Case chip). */
export const DELAYED_QUOTE_STAMP = "Delayed Quote";

/** User-facing sentence under Proposed / Now.  Two spaces between sentences. */
export const DELAYED_QUOTE_NOTE =
  "This price is delayed.  You can still approve the order.";

/** @deprecated Use DELAYED_QUOTE_STAMP — kept so older test imports resolve. */
export const DELAYED_FALLBACK_STAMP = DELAYED_QUOTE_STAMP;

const EXPLICIT_DELAYED_YAHOO = new Set([
  "yahoo-finance-delayed",
  "yahoo-finance-delayed-quotes"
]);

const YAHOO_CASCADE_PROVIDERS = new Set([
  "yahoo-finance",
  "yahoo-finance-batch",
  "yahoo-finance-single"
]);

export function isExplicitDelayedYahooProvider(provider?: string | null): boolean {
  if (!provider) return false;
  return EXPLICIT_DELAYED_YAHOO.has(provider.toLowerCase());
}

export function isYahooCascadeProvider(provider?: string | null): boolean {
  if (!provider) return false;
  return YAHOO_CASCADE_PROVIDERS.has(provider.toLowerCase());
}

export function isYahooFallbackProvider(provider?: string | null): boolean {
  return isExplicitDelayedYahooProvider(provider) || isYahooCascadeProvider(provider);
}

export type DelayedFallbackQuote = {
  delayedFallback?: boolean;
  provider?: string;
  venuePriceAuthoritative?: boolean;
  asOf?: string;
  fetchedAt?: string;
};

/**
 * True when this quote is the delayed Yahoo fallback tape (not Tradier
 * venue-authoritative delay, and not a fresh Yahoo accept inside the live bar).
 */
export function isDelayedYahooFallbackQuote(
  quote?: DelayedFallbackQuote | null,
  nowMs: number = Date.now(),
  maxAgeSec: number = 120
): boolean {
  if (!quote || quote.venuePriceAuthoritative) return false;
  if (quote.delayedFallback === true) return true;
  if (isExplicitDelayedYahooProvider(quote.provider)) return true;
  if (!isYahooCascadeProvider(quote.provider)) return false;
  if (!quote.asOf) return true;
  const asOfMs = new Date(quote.asOf).getTime();
  if (Number.isNaN(asOfMs)) return true;
  return (nowMs - asOfMs) / 1000 > maxAgeSec;
}

export function delayedFallbackCardLabel(): string {
  return DELAYED_QUOTE_STAMP;
}

export function delayedFallbackCardTitle(): string {
  return DELAYED_QUOTE_NOTE;
}
