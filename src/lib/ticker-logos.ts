export type TickerLogoDisplay = "tile" | "transparent" | "off";

// Default to the transparent (clean, no background tile) treatment. When a
// symbol has no loadable logo, TickerLogo automatically falls back to a tile
// monogram, so this default never leaves a bare gap.
export const DEFAULT_TICKER_LOGO_DISPLAY: TickerLogoDisplay = "transparent";

const TICKER_LOGO_VALUES = new Set<TickerLogoDisplay>(["tile", "transparent", "off"]);
const TICKER_LOGO_BASE_URL = "https://raw.githubusercontent.com/davidepalazzo/ticker-logos/main/ticker_icons";
const SYMBOL_PATTERN = /^[A-Z0-9._-]{1,20}$/;

export function isTickerLogoDisplay(value: unknown): value is TickerLogoDisplay {
  return typeof value === "string" && TICKER_LOGO_VALUES.has(value as TickerLogoDisplay);
}

export function normalizeTickerLogoSymbol(value: string | null | undefined): string | null {
  const symbol = value?.trim().replace(/^\$/, "").toUpperCase();
  if (!symbol || !SYMBOL_PATTERN.test(symbol)) return null;
  return symbol;
}

export function tickerLogoCandidates(value: string | null | undefined): string[] {
  const symbol = normalizeTickerLogoSymbol(value);
  if (!symbol) return [];
  return Array.from(new Set([
    symbol,
    symbol.replace(/\./g, "-"),
    symbol.replace(/-/g, "."),
    symbol.replace(/[.-]/g, "_")
  ]));
}

export function tickerLogoRawUrl(symbol: string): string {
  return `${TICKER_LOGO_BASE_URL}/${encodeURIComponent(symbol)}.png`;
}

// ── logo.dev (cascade fallback) ───────────────────────────────────────────────
// Two lookup strategies:
//   By ticker:  img.logo.dev/ticker/AAPL   — publicly-traded equities
//   By domain:  img.logo.dev/apple.com     — any company with a web presence
//
// Both require a publishable token (LOGO_DEV_TOKEN env var). The proxy route
// sets Referer to the app's own origin so domain-restricted keys work correctly.
// fallback=monogram generates a letter badge when no logo is found (always returns something).

export interface LogoDevOptions {
  theme?: "light" | "dark" | "auto";
  retina?: boolean;
  fallback?: "monogram" | "404";
}

function logoDevParams(token: string, opts: LogoDevOptions = {}): string {
  const p = new URLSearchParams({
    token,
    format: "png",
    fallback: opts.fallback ?? "monogram",
    theme: opts.theme ?? "dark",
    ...(opts.retina ? { retina: "true" } : {})
  });
  return p.toString();
}

const LOGO_DEV_BASE = "https://img.logo.dev";

export function logoDevTickerUrl(symbol: string, token: string, opts?: LogoDevOptions): string {
  return `${LOGO_DEV_BASE}/ticker/${encodeURIComponent(symbol)}?${logoDevParams(token, opts)}`;
}

export function logoDevDomainUrl(domain: string, token: string, opts?: LogoDevOptions): string {
  return `${LOGO_DEV_BASE}/${encodeURIComponent(domain)}?${logoDevParams(token, opts)}`;
}
