import React from "react";
import { MarketQuote } from "@/lib/types";
import { deriveMetrics } from "@/lib/derived-metrics";
import { friendlySource, orderedSourceEntries, provenanceLabel } from "@/lib/dashboard-ui";
import type { TickerLogoDisplay } from "@/lib/ticker-logos";
import { Chip } from "./primitives";
import { PriceChart, type LatestChartBar } from "./price-chart";
import { TickerLogo } from "./ticker-logo";
import { Database, BrainCircuit, Zap, TrendingUp, Search, Calculator } from "lucide-react";

/** Compact dollar formatter for daily $ volume (input is in $millions). */
function formatDollarsM(millions: number): string {
  if (millions >= 1000) return `$${(millions / 1000).toFixed(2)}B`;
  if (millions >= 1) return `$${Math.round(millions)}M`;
  return `$${(millions * 1000).toFixed(0)}K`;
}

function displayPrice(price?: number): string {
  return typeof price === "number" && Number.isFinite(price) && price > 0
    ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(price)
    : "—";
}

function displayChange(pct?: number): string {
  return typeof pct === "number" && Number.isFinite(pct)
    ? `${pct >= 0 ? "+" : ""}${new Intl.NumberFormat("en-US", { style: "percent", minimumFractionDigits: 2 }).format(pct / 100)}`
    : "—";
}

function logoFallbackFor(symbol: string) {
  return (
    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--accent)]/20 px-1 text-center text-[11px] font-bold text-[var(--accent)]">
      {symbol}
    </div>
  );
}

export function SymbolDrilldownTitle({ quote, logoDisplay = "tile" }: { quote: MarketQuote; logoDisplay?: TickerLogoDisplay }) {
  const price = displayPrice(quote.price);
  const change = displayChange(quote.intradayChangePct);
  const changeTone = quote.intradayChangePct >= 0 ? "text-up" : "text-down";
  return (
    <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3">
      <TickerLogo symbol={quote.symbol} display={logoDisplay} fallback={logoFallbackFor(quote.symbol)} />
      <div className="min-w-0">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 text-base font-semibold text-fg">{quote.symbol}</span>
          <span className="truncate text-sm font-medium text-muted">{quote.companyName || quote.symbol}</span>
        </div>
        <div className="truncate text-xs text-faint">{quote.sector || "Unknown sector"}{quote.industry && quote.industry !== quote.sector ? ` · ${quote.industry}` : ""}</div>
      </div>
      <div className="shrink-0 text-right">
        <div className="tnum text-sm font-semibold text-fg">{price}</div>
        <div className={`tnum text-xs ${changeTone}`}>{change}</div>
      </div>
    </div>
  );
}

export function SymbolDrilldown({
  quote,
  logoDisplay = "tile",
  onQuoteUpdate
}: {
  quote: MarketQuote;
  logoDisplay?: TickerLogoDisplay;
  onQuoteUpdate?: (patch: Partial<MarketQuote>) => void;
}) {
  // Local parser for the "Why this matters" summary
  const generateSummary = (q: MarketQuote) => {
    const pros = [];
    const cons = [];
    
    if (q.score >= 70) pros.push("Strong overall composite score.");
    else if (q.score <= 35) cons.push("Weak overall composite score.");
    
    if (q.peRatio && q.peRatio > 0 && q.peRatio < 15) pros.push("Attractive P/E valuation.");
    if (q.peRatio && q.peRatio > 50) cons.push("Elevated P/E valuation implies high growth expectations.");
    
    if (typeof q.sentiment === "number" && q.sentiment >= 60) pros.push("Positive news sentiment detected.");
    else if (typeof q.sentiment === "number" && q.sentiment <= 40) cons.push("Negative news sentiment detected.");
    
    if (typeof q.insiderSentiment === "number" && q.insiderSentiment >= 60) pros.push("Bullish insider transaction activity.");
    else if (typeof q.insiderSentiment === "number" && q.insiderSentiment <= 40) cons.push("Bearish insider transaction activity.");
    
    if (q.senateTrades && q.senateTrades > 0) pros.push("Delayed congressional disclosure context is net positive.");
    else if (q.senateTrades && q.senateTrades < 0) cons.push("Delayed congressional disclosure context is net negative.");

    if (typeof q.factorBreakdown?.momentum === "number" && q.factorBreakdown.momentum >= 65) pros.push("Strong relative momentum.");
    if (typeof q.factorBreakdown?.quality === "number" && q.factorBreakdown.quality >= 65) pros.push("High quality fundamentals (FCF/Debt/Growth).");
    if (typeof q.factorBreakdown?.value === "number" && q.factorBreakdown.value <= 35) cons.push("Extended fundamental valuation.");

    // Backend-derived ratios as plain-language conviction signals.
    const m = deriveMetrics(q);
    if (typeof m.peg === "number" && m.peg > 0 && m.peg < 1) pros.push("Cheap relative to its growth (PEG < 1).");
    else if (typeof m.peg === "number" && m.peg > 2.5) cons.push("Expensive relative to its growth (PEG > 2.5).");
    if (typeof m.roe === "number" && m.roe >= 20) pros.push("High return on equity (efficient capital use).");
    else if (typeof m.roe === "number" && m.roe < 0) cons.push("Negative return on equity (losing money on equity).");
    if (typeof m.payout === "number" && m.payout > 100) cons.push("Dividend exceeds earnings (payout > 100%, may be unsustainable).");

    return { pros, cons };
  };

  const { pros, cons } = generateSummary(quote);
  const fb = quote.factorBreakdown;
  const dm = deriveMetrics(quote);
  const sourceEntries = orderedSourceEntries(quote.sources);
  const handleLatestBar = React.useCallback((bar: LatestChartBar) => {
    const latest = bar.latest;
    const previousClose = bar.previous?.close;
    const patch: Partial<MarketQuote> = {
      price: latest.close,
      ...(typeof latest.volume === "number" ? { volume: latest.volume } : {}),
      ...(typeof latest.vwap === "number" ? { vwap: latest.vwap } : {})
    };
    if (typeof previousClose === "number" && previousClose > 0) {
      patch.intradayChangePct = ((latest.close - previousClose) / previousClose) * 100;
    }
    onQuoteUpdate?.(patch);
  }, [onQuoteUpdate]);

  // Backend-computed ratios (not returned by any API) — see src/lib/derived-metrics.ts.
  const derivedTiles: { label: string; value: string | null; title: string; tone?: "up" | "down" }[] = [
    { label: "PEG", value: typeof dm.peg === "number" ? dm.peg.toFixed(2) : null,
      title: "P/E ÷ EPS-growth%. <1 = cheap for its growth, >2 = expensive. Source: Calculated from live quotes.",
      tone: typeof dm.peg === "number" ? (dm.peg < 1 ? "up" : dm.peg > 2.5 ? "down" : undefined) : undefined },
    { label: "Earnings yield", value: typeof dm.earnYld === "number" ? `${dm.earnYld.toFixed(2)}%` : null,
      title: "EPS ÷ price (inverse of P/E). Negative = the company is losing money. Source: Calculated from live quotes.",
      tone: typeof dm.earnYld === "number" ? (dm.earnYld >= 0 ? "up" : "down") : undefined },
    { label: "ROE", value: typeof dm.roe === "number" ? `${dm.roe.toFixed(1)}%` : null,
      title: "Return on equity = EPS ÷ book value per share. Higher = more efficient capital use. Source: Calculated from live quotes.",
      tone: typeof dm.roe === "number" ? (dm.roe >= 0 ? "up" : "down") : undefined },
    { label: "Payout ratio", value: typeof dm.payout === "number" ? `${dm.payout.toFixed(0)}%` : null,
      title: "Dividends ÷ EPS. >100% means the dividend exceeds earnings (at risk). Source: Calculated from live quotes.",
      tone: typeof dm.payout === "number" && dm.payout > 100 ? "down" : undefined },
    { label: "Daily $ volume", value: typeof dm.dollarVolM === "number" ? formatDollarsM(dm.dollarVolM) : null,
      title: "Price × volume — liquidity gauge for sizing and slippage. Source: Calculated from live quotes." },
    { label: "Bid-ask spread", value: typeof dm.spreadBps === "number" ? `${dm.spreadBps.toFixed(1)} bps` : null,
      title: "(ask − bid) ÷ mid in basis points — execution cost; wide spreads favor limit orders. Source: Calculated from live quotes." },
    { label: "Graham value", value: typeof dm.grahamNumber === "number" ? `$${dm.grahamNumber.toFixed(2)}` : null,
      title: "Benjamin Graham's intrinsic-value estimate = √(22.5 × EPS × book value per share). A defensive fair-value yardstick. Source: Calculated from live quotes." },
    { label: "Margin of safety", value: typeof dm.marginOfSafety === "number" ? `${dm.marginOfSafety >= 0 ? "+" : ""}${dm.marginOfSafety.toFixed(1)}%` : null,
      title: "(Graham value − price) ÷ price. Positive = trading below intrinsic value (a value cushion); negative = above it. Source: Calculated from live quotes.",
      tone: typeof dm.marginOfSafety === "number" ? (dm.marginOfSafety >= 0 ? "up" : "down") : undefined },
    { label: "% from 52w high", value: typeof dm.pctFromHigh === "number" ? `${dm.pctFromHigh.toFixed(1)}%` : null,
      title: "(price − 52-week high) ÷ high. 0 = at the high (breakout zone); deeply negative = a large pullback. Source: Calculated from live quotes." },
    { label: "Reward:risk (52w)", value: typeof dm.rr52w === "number" ? dm.rr52w.toFixed(2) : null,
      title: "(52w high − price) ÷ (price − 52w low). >1 = more upside room to the high than downside to the low. Source: Calculated from live quotes.",
      tone: typeof dm.rr52w === "number" ? (dm.rr52w >= 1 ? "up" : "down") : undefined },
    { label: "Sector rel. strength", value: typeof quote.sectorRelStrength === "number" ? `${quote.sectorRelStrength >= 0 ? "+" : ""}${quote.sectorRelStrength.toFixed(2)}%` : null,
      title: "Intraday % move minus the average move of its sector among the scan candidates. Positive = outperforming its sector today. Source: Calculated from live quotes.",
      tone: typeof quote.sectorRelStrength === "number" ? (quote.sectorRelStrength >= 0 ? "up" : "down") : undefined }
  ];

  // Factor subscores are normalized 0-100; the weighted score is shown separately.
  const factorItems = fb ? [
    { label: "Value", value: fb.value },
    { label: "Momentum", value: fb.momentum },
    { label: "Quality", value: fb.quality },
    { label: "Positioning", value: fb.positioning },
    { label: "Sentiment", value: fb.sentiment },
    { label: "Liquidity", value: fb.liquidity },
    { label: "Volatility", value: fb.volatility },
  ] : [];

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-6 pb-24 text-sm text-fg">
      {/* Price chart (TradingView Lightweight Charts, fed our own free OHLC) */}
      <PriceChart symbol={quote.symbol} onLatestBar={handleLatestBar} />

      {/* Why this matters */}
      <div className="rounded-xl border border-line bg-surface/50 p-4 backdrop-blur-md">
        <h3 className="mb-3 flex items-center gap-2 font-semibold text-fg"><BrainCircuit size={16} className="text-info" /> Signal Summary</h3>
        {pros.length === 0 && cons.length === 0 ? (
          <p className="text-faint">Insufficient edge signals to form a strong fundamental narrative.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {pros.length > 0 && (
              <ul className="space-y-1.5">
                {pros.map((p, i) => (
                  <li key={i} className="flex gap-2 text-up text-[13px] leading-snug">
                    <span className="shrink-0 font-bold">+</span>
                    <span>{p}</span>
                  </li>
                ))}
              </ul>
            )}
            {cons.length > 0 && (
              <ul className="space-y-1.5">
                {cons.map((p, i) => (
                  <li key={i} className="flex gap-2 text-down text-[13px] leading-snug">
                    <span className="shrink-0 font-bold">-</span>
                    <span>{p}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {/* Derived Metrics (computed in the backend, not from any API) */}
      <div className="rounded-xl border border-line p-4">
        <h3 className="mb-1 flex items-center gap-2 font-semibold text-fg"><Calculator size={16} className="text-[var(--accent)]" /> Derived Metrics</h3>
        <p className="text-faint text-xs mb-4">Computed from the raw data we already pull — the same values handed to the agent.</p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {derivedTiles.map((t) => (
            <div key={t.label} className="rounded-lg border border-line/60 bg-surface/40 p-3" title={t.title}>
              <div className="text-faint text-[11px] uppercase tracking-wide">{t.label}</div>
              <div className={`tnum mt-1 text-base font-semibold ${t.tone === "up" ? "text-up" : t.tone === "down" ? "text-down" : "text-fg"}`}>
                {t.value ?? <span className="text-faint">—</span>}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Evidence Bulletins */}
      <div className="rounded-xl border border-line p-4">
        <h3 className="mb-4 flex items-center gap-2 font-semibold text-fg"><Search size={16} /> Evidence Bulletins</h3>
        <div className="space-y-3">
          {(quote.evidenceBulletins && quote.evidenceBulletins.length > 0) ? (
            quote.evidenceBulletins.map((bull: string, i: number) => (
              <div key={i} className="flex items-start gap-3 text-[13px] border-l-2 border-info/50 pl-3 py-0.5">
                <span className="text-fg leading-relaxed">{bull}</span>
              </div>
            ))
          ) : (
            <p className="text-sm text-faint">No notable catalyst bulletins found.</p>
          )}

          {quote.headlines && quote.headlines.length > 0 && (
            <div className="mt-4 pt-4 border-t border-line">
              <h4 className="text-xs font-semibold text-faint mb-3 uppercase tracking-wider">Recent Headlines</h4>
              <ul className="space-y-2">
                {quote.headlines.map((hl: string, i: number) => (
                  <li key={i} className="text-[13px] text-muted list-disc list-inside">{hl}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>

      {/* Factor Scores */}
      <div className="rounded-xl border border-line p-4">
        <h3 className="mb-4 flex items-center gap-2 font-semibold text-fg"><TrendingUp size={16} className="text-[var(--accent)]" /> Factor Scores</h3>
        {fb ? (
          <div className="space-y-3">
            {factorItems.map(item => (
              <div key={item.label} className="relative">
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-faint">{item.label}</span>
                  <span className="text-fg font-medium">{item.value.toFixed(1)}</span>
                </div>
                {/* Visual bar */}
                <div className="h-1.5 w-full bg-surface-3 rounded-full overflow-hidden">
                  <div className="h-full bg-up rounded-full" style={{ width: `${Math.max(0, Math.min(100, item.value))}%` }} />
                </div>
              </div>
            ))}
            <div className="mt-4 pt-3 border-t border-line flex justify-between font-bold">
              <span>Composite Score</span>
              <span className="text-fg">{quote.score.toFixed(1)}</span>
            </div>
          </div>
        ) : (
          <p className="text-sm text-faint">No factor breakdown available.</p>
        )}
      </div>

      {/* Source Provenance & Freshness — kept last so the data lineage sits at the bottom of the drawer */}
      <div className="rounded-xl border border-line p-4">
        <h3 className="mb-4 flex items-center gap-2 font-semibold text-fg"><Database size={16} className="text-info" /> Source Provenance</h3>
        <div className="space-y-2 text-xs">
          <div className="flex justify-between items-center py-1 border-b border-line/50 last:border-0">
            <span className="text-faint">Signal strength</span>
            <Chip tone="neutral" className="bg-surface-2">Calculated</Chip>
          </div>
          <div className="flex justify-between items-center py-1 border-b border-line/50 last:border-0">
            <span className="text-faint">Derived metrics</span>
            <Chip tone="neutral" className="bg-surface-2">Calculated</Chip>
          </div>
          {sourceEntries.length > 0 ? (
            sourceEntries.map(([field, provider]) => (
              <div key={field} className="flex justify-between items-center py-1 border-b border-line/50 last:border-0">
                <span className="text-faint">{provenanceLabel(field)}</span>
                <Chip tone="neutral" className="bg-surface-2">{friendlySource(provider)}</Chip>
              </div>
            ))
          ) : (
            <p className="text-faint">No source attribution provided.</p>
          )}
          {quote.asOf && (
            <div className="pt-2 mt-2 border-t border-line text-faint flex items-center gap-2">
              <Zap size={14} /> Data as of {new Date(quote.asOf).toLocaleString()}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
