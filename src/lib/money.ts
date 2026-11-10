export function asMoney(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2
  }).format(value);
}

export function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Alpaca price increment: >= $1 must be pennies; below $1 may be $0.0001.
 * Sub-penny limits on names like T (24.865) 422 with
 * "limit price must be increment of 0.01".
 */
export function roundAlpacaPrice(value: number): number {
  if (!Number.isFinite(value)) return value;
  if (Math.abs(value) >= 1) return Math.round(value * 100) / 100;
  return Math.round(value * 10_000) / 10_000;
}

export function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

// Our canonical symbol format uses a hyphen for share classes (e.g. "BRK-B", the Robinhood
// convention — see sp500.ts). Alpaca's asset/order/quote/news/snapshot APIs reject that and
// require a dot ("BRK.B") — an unconverted hyphen produces an HTTP 422/400 depending on the
// endpoint. Convert at the Alpaca boundary only — internal state stays hyphenated.
export function toAlpacaSymbol(symbol: string): string {
  return normalizeSymbol(symbol).replace(/-/g, ".");
}

// Inverse of toAlpacaSymbol — normalize symbols coming back from Alpaca (orders, positions,
// quotes, news, streams) to our canonical hyphenated format so they match watchlist/proposal
// symbols elsewhere.
export function fromAlpacaSymbol(symbol: string): string {
  return normalizeSymbol(symbol).replace(/\./g, "-");
}

export function formatQuantity(value: number | undefined | null, _symbol?: string): string {
  if (value == null) return "0";
  const abs = Math.abs(value);
  if (abs === 0) return "0";

  // Significant figures to show: at least 3, but always enough to show EVERY integer
  // digit so a large whole-share count is never truncated — i.e. "3 significant figures
  // OR all digits of the whole number, whichever is larger" (12,489.242 -> "12,489";
  // 0.167333 -> "0.167"; 1.5 -> "1.5"). Comma-grouped; trailing zeros stripped.
  const intDigits = abs >= 1 ? Math.trunc(abs).toString().length : 0;
  const sigFigs = Math.max(3, intDigits);
  return Number(value.toPrecision(sigFigs)).toLocaleString("en-US", { maximumFractionDigits: 20 });
}

