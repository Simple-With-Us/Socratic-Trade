"use client";

import type { TickerLogoDisplay } from "@/lib/ticker-logos";
import type { MarketQuote, MarketScan } from "@/lib/types";
import { cn } from "./cn";
import { TickerLogo } from "./ticker-logo";

/**
 * Resolve a full MarketQuote for a symbol from the captured run's scan so the
 * symbol drilldown can open from anywhere, not just the Market Scan table.
 */
function resolveScanQuote(symbol: string, scan: MarketScan | null | undefined): MarketQuote | null {
  if (!scan) return null;
  const normalized = symbol.trim().toUpperCase();
  const full = scan.topCandidates.find((q) => q.symbol.trim().toUpperCase() === normalized);
  if (full) return full;
  const summary = scan.quotesBySymbol[normalized] ?? Object.values(scan.quotesBySymbol).find((q) => q.symbol.trim().toUpperCase() === normalized);
  if (!summary) return null;
  return { volume: 0, intradayChangePct: 0, positionMarketValue: 0, ...summary };
}

/**
 * A ticker that opens the symbol drilldown, mirroring the Market Scan rows.
 * When scan data is missing, it still opens the drawer with a sparse symbol
 * record so event-only tickers do not fall back to inert bold text.
 */
export function SymbolButton({
  symbol,
  scan,
  quote: quoteProp,
  onDrilldown,
  className,
  title,
  variant = "underline",
  logoDisplay,
  showLogo = false
}: {
  symbol: string;
  scan?: MarketScan | null;
  quote?: MarketQuote | null;
  onDrilldown?: (q: MarketQuote) => void;
  className?: string;
  title?: string;
  variant?: "underline" | "chip";
  logoDisplay?: TickerLogoDisplay;
  showLogo?: boolean;
}) {
  const quote = quoteProp ?? (onDrilldown ? resolveScanQuote(symbol, scan) : null);
  const drilldownTarget = quote ?? ({ symbol, companyName: title, price: 0, volume: 0, intradayChangePct: 0, positionMarketValue: 0, score: 0, source: "", asOf: new Date().toISOString() } as MarketQuote);
  const content = showLogo && variant !== "chip" && logoDisplay && logoDisplay !== "off"
    ? (
      <span className="inline-flex items-center gap-1.5">
        <TickerLogo symbol={symbol} display={logoDisplay} />
        <span>{symbol}</span>
      </span>
    )
    : symbol;
  if (!onDrilldown) {
    return <span className={className} title={title}>{content}</span>;
  }
  const interactive =
    variant === "chip"
      ? "cursor-pointer transition-all duration-150 underline-offset-2 hover:font-bold hover:italic hover:underline active:scale-95 focus:outline-none focus-visible:rounded-sm focus-visible:ring-1 focus-visible:ring-current"
      : "cursor-pointer underline decoration-1 decoration-faint/50 underline-offset-[3px] transition-all duration-150 hover:text-info hover:decoration-2 hover:decoration-info active:scale-95 focus:outline-none focus-visible:rounded-sm focus-visible:ring-1 focus-visible:ring-info";
  return (
    <button
      type="button"
      title={title ?? "Open symbol intelligence"}
      onClick={(e) => {
        e.stopPropagation();
        onDrilldown(drilldownTarget);
      }}
      className={cn(className, interactive)}
    >
      {content}
    </button>
  );
}
