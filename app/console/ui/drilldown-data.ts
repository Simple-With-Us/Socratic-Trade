/** Pure data helpers for the console symbol drilldown. No React here — every
 *  function is total and honest: missing inputs produce `null`/`undefined`
 *  (rendered as an em dash), never a fabricated number.
 *
 *  The derived-metric math and signal-summary thresholds are the SAME ones the
 *  legacy drawer used: `deriveMetrics` is imported from src/lib/derived-metrics
 *  (the module that also feeds the LLM), and the pros/cons thresholds mirror
 *  app/ui/symbol-drilldown.tsx so the console never disagrees with the legacy
 *  dashboard about the same quote. */

import { deriveMetrics, type DerivedMetrics } from "@/lib/derived-metrics";
import { friendlySource, receivedLabel } from "@/lib/dashboard-ui";
import type {
  AnalystRatingDetail,
  EnrichmentFieldObservations,
  EnrichmentSources,
  EquityPosition,
  MarketFactorBreakdown,
  MarketQuote,
  MarketQuoteSummary
} from "@/lib/types";
// Type-only: erased at build time, so importing the shape doesn't pull the (server-only)
// provider implementations from data-providers.ts into the client bundle.
import type { SymbolEnrichment } from "@/lib/data-providers";

// ── Quote view (merged superset of MarketQuote / MarketQuoteSummary) ─────────

/** One shape the drilldown renders from, whichever scan tier knew the symbol.
 *  `full` is true when the symbol was a fully-enriched top candidate in the
 *  last scan (marketCap available; both tiers carry factor breakdown, volume,
 *  headlines, intraday change, and sector relative strength). */
export interface QuoteView {
  symbol: string;
  full: boolean;
  companyName?: string;
  price?: number;
  vwap?: number;
  bid?: number;
  ask?: number;
  volume?: number;
  marketCap?: number;
  intradayChangePct?: number;
  sector?: string;
  industry?: string;
  score?: number;
  factorBreakdown?: MarketFactorBreakdown;
  provider?: string;
  asOf?: string;
  sentiment?: number;
  peRatio?: number;
  headlines?: string[];
  analystRating?: string;
  analystScore?: number;
  analystBySource?: Record<string, AnalystRatingDetail>;
  dividendYield?: number;
  eps?: number;
  pbRatio?: number;
  returnOnEquity?: number;
  shortPercentOfFloat?: number;
  beta?: number;
  fiftyTwoWeekHigh?: number;
  fiftyTwoWeekLow?: number;
  insiderSentiment?: number;
  fcfYield?: number;
  debtToEquity?: number;
  epsGrowth?: number;
  senateTrades?: number;
  daysToEarnings?: number;
  institutionOwnershipPct?: number;
  nearTheMoneyIv?: number;
  putCallRatio?: number;
  targetMean?: number;
  targetHigh?: number;
  targetLow?: number;
  targetMedian?: number;
  sectorRelStrength?: number;
  evidenceBulletins?: string[];
  sources?: EnrichmentSources;
  fieldObservations?: EnrichmentFieldObservations;
}

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

const posNum = (v: unknown): number | undefined => {
  const n = num(v);
  return n !== undefined && n > 0 ? n : undefined;
};

/** Choose between a caller-supplied quote override (the quote object the
 *  opening screen is currently rendering — e.g. a freshly fetched /api/scan
 *  row) and the run-captured top-candidate quote from the snapshot. The
 *  override wins unless the run-captured quote is verifiably NEWER (both
 *  `asOf` timestamps parse and the run quote's is strictly later): what the
 *  user sees in the row and what the drilldown shows must not disagree. */
export function preferFreshQuote(
  override: MarketQuote | undefined,
  runQuote: MarketQuote | undefined
): MarketQuote | undefined {
  if (!override) return runQuote;
  if (!runQuote) return override;
  const overrideAt = override.asOf ? Date.parse(override.asOf) : NaN;
  const runAt = runQuote.asOf ? Date.parse(runQuote.asOf) : NaN;
  if (Number.isFinite(overrideAt) && Number.isFinite(runAt) && runAt > overrideAt) return runQuote;
  return override;
}

/** Merge the best-available scan data for a symbol into one view. Prefers the
 *  fully-enriched top-candidate quote; falls back to the lighter summary tier;
 *  null when the last scan didn't know the symbol at all. */
export function toQuoteView(full: MarketQuote | undefined, summary: MarketQuoteSummary | undefined): QuoteView | null {
  const q = full ?? summary;
  if (!q) return null;
  const view: QuoteView = {
    symbol: q.symbol,
    full: Boolean(full),
    companyName: q.companyName,
    price: posNum(q.price),
    vwap: posNum(q.vwap),
    bid: posNum(q.bid),
    ask: posNum(q.ask),
    sector: q.sector,
    industry: q.industry,
    score: num(q.score),
    provider: q.provider,
    asOf: q.asOf,
    sentiment: num(q.sentiment),
    peRatio: num(q.peRatio),
    analystRating: q.analystRating,
    analystScore: num(q.analystScore),
    analystBySource: q.analystBySource,
    dividendYield: num(q.dividendYield),
    eps: num(q.eps),
    pbRatio: num(q.pbRatio),
    returnOnEquity: num(q.returnOnEquity),
    shortPercentOfFloat: num(q.shortPercentOfFloat),
    beta: num(q.beta),
    fiftyTwoWeekHigh: posNum(q.fiftyTwoWeekHigh),
    fiftyTwoWeekLow: posNum(q.fiftyTwoWeekLow),
    insiderSentiment: num(q.insiderSentiment),
    fcfYield: num(q.fcfYield),
    debtToEquity: num(q.debtToEquity),
    epsGrowth: num(q.epsGrowth),
    senateTrades: num(q.senateTrades),
    daysToEarnings: num(q.daysToEarnings),
    institutionOwnershipPct: num(q.institutionOwnershipPct),
    nearTheMoneyIv: num(q.nearTheMoneyIv),
    putCallRatio: num(q.putCallRatio),
    targetMean: posNum(q.targetMean),
    targetHigh: posNum(q.targetHigh),
    targetLow: posNum(q.targetLow),
    targetMedian: posNum(q.targetMedian),
    evidenceBulletins: q.evidenceBulletins,
    sources: q.sources,
    fieldObservations: q.fieldObservations,
    // Both tiers carry these now (summary quotes gained them in market.ts
    // quotesBySymbol); `q = full ?? summary` already prefers the full tier.
    volume: posNum(q.volume),
    intradayChangePct: num(q.intradayChangePct),
    factorBreakdown: q.factorBreakdown,
    headlines: q.headlines,
    sectorRelStrength: num(q.sectorRelStrength)
  };
  if (full) {
    view.marketCap = posNum(full.marketCap);
  }
  return view;
}

/** Build a QuoteView from an on-demand single-symbol enrichment fetch (`/api/quote`),
 *  used when the last market scan didn't know the symbol at all. Deliberately omits
 *  `score`, `factorBreakdown`, `marketCap`, and `sectorRelStrength` — those rank the
 *  symbol against the scan's candidate universe and are never approximated here. */
export function toQuoteViewFromEnrichment(symbol: string, enrichment: Partial<SymbolEnrichment>): QuoteView {
  return {
    symbol,
    full: false,
    companyName: enrichment.companyName,
    price: posNum(enrichment.price),
    vwap: posNum(enrichment.vwap),
    bid: posNum(enrichment.bid),
    ask: posNum(enrichment.ask),
    sector: enrichment.sector,
    industry: enrichment.industry,
    asOf: enrichment.asOf,
    sentiment: num(enrichment.sentiment),
    peRatio: num(enrichment.peRatio),
    analystRating: enrichment.analystRating,
    analystScore: num(enrichment.analystScore),
    analystBySource: enrichment.analystBySource,
    dividendYield: num(enrichment.dividendYield),
    eps: num(enrichment.eps),
    pbRatio: num(enrichment.pbRatio),
    returnOnEquity: num(enrichment.returnOnEquity),
    shortPercentOfFloat: num(enrichment.shortPercentOfFloat),
    beta: num(enrichment.beta),
    fiftyTwoWeekHigh: posNum(enrichment.fiftyTwoWeekHigh),
    fiftyTwoWeekLow: posNum(enrichment.fiftyTwoWeekLow),
    insiderSentiment: num(enrichment.insiderSentiment),
    fcfYield: num(enrichment.fcfYield),
    debtToEquity: num(enrichment.debtToEquity),
    epsGrowth: num(enrichment.epsGrowth),
    senateTrades: num(enrichment.senateTrades),
    daysToEarnings: num(enrichment.daysToEarnings),
    institutionOwnershipPct: num(enrichment.institutionOwnershipPct),
    nearTheMoneyIv: num(enrichment.nearTheMoneyIv),
    putCallRatio: num(enrichment.putCallRatio),
    targetMean: posNum(enrichment.targetMean),
    targetHigh: posNum(enrichment.targetHigh),
    targetLow: posNum(enrichment.targetLow),
    targetMedian: posNum(enrichment.targetMedian),
    volume: posNum(enrichment.volume),
    intradayChangePct: num(enrichment.intradayChangePct),
    headlines: enrichment.headlines,
    sources: enrichment.sources
  };
}

// Fields worth rendering the reduced on-demand fundamentals sections for. Deliberately
// excludes `sources`/`asOf` (the cascade always sets `sources` to an object — possibly
// empty — so its mere presence isn't a signal) and the scan-only fields above.
const ENRICHED_SIGNAL_KEYS: (keyof QuoteView)[] = [
  "price", "vwap", "bid", "ask", "volume", "intradayChangePct", "sector", "industry", "sentiment",
  "peRatio", "analystRating", "analystScore", "dividendYield", "eps", "pbRatio", "shortPercentOfFloat",
  "beta", "fiftyTwoWeekHigh", "fiftyTwoWeekLow", "insiderSentiment", "fcfYield", "debtToEquity",
  "epsGrowth", "senateTrades", "daysToEarnings", "institutionOwnershipPct", "nearTheMoneyIv",
  "putCallRatio", "targetMean", "targetHigh", "targetLow", "targetMedian", "companyName"
];

/** True when an on-demand enrichment view carries at least one real field worth
 *  rendering — as opposed to every provider having come back empty for the symbol. */
export function hasEnrichedData(view: QuoteView): boolean {
  return ENRICHED_SIGNAL_KEYS.some((key) => view[key] !== undefined) || (view.headlines?.length ?? 0) > 0;
}

// ── P/E honesty (repo convention) ────────────────────────────────────────────

/** P/E display per the repo convention: eps DECIDES the no-ratio state —
 *  negative/zero trailing earnings ⇒ "n/a" (a real, computed "no ratio"
 *  state) BEFORE any provider-reported ratio is accepted (a positive ratio
 *  alongside eps ≤ 0 is stale/inconsistent cross-provider data; the
 *  conservative honest read wins). Otherwise only a strictly POSITIVE ratio
 *  renders as a number — a non-positive ratio is never displayed as one
 *  (same guard as the legacy scan table). null = the data simply wasn't
 *  available (render an em dash). */
export function peDisplay(peRatio?: number, eps?: number): { text: string; na: boolean } | null {
  if (typeof eps === "number" && Number.isFinite(eps) && eps <= 0) {
    return { text: "n/a", na: true };
  }
  if (typeof peRatio === "number" && Number.isFinite(peRatio) && peRatio > 0) {
    return { text: peRatio.toFixed(1), na: false };
  }
  return null;
}

// ── Derived metrics (same math the LLM sees) ─────────────────────────────────

export interface DerivedResult {
  metrics: DerivedMetrics;
  /** True when daily $ volume used the latest daily history bar because the
   *  scan tier didn't carry share volume for this symbol. */
  volumeFromHistory: boolean;
}

/** Run src/lib/derived-metrics.deriveMetrics over the view. When the scan tier
 *  lacks share volume (summary quotes don't carry it), fall back to the latest
 *  daily bar's real volume so daily $ volume stays available — both inputs are
 *  real, and the tile's tooltip says which was used. */
export function deriveForView(view: QuoteView, historyBarVolume?: number): DerivedResult {
  const volumeFromHistory = view.volume === undefined && typeof historyBarVolume === "number" && historyBarVolume > 0;
  const metrics = deriveMetrics({
    price: view.price ?? 0,
    eps: view.eps,
    peRatio: view.peRatio,
    pbRatio: view.pbRatio,
    dividendYield: view.dividendYield,
    fiftyTwoWeekHigh: view.fiftyTwoWeekHigh,
    fiftyTwoWeekLow: view.fiftyTwoWeekLow,
    volume: view.volume ?? (volumeFromHistory ? historyBarVolume : undefined),
    epsGrowth: view.epsGrowth,
    bid: view.bid,
    ask: view.ask,
    returnOnEquity: view.returnOnEquity
  });
  return { metrics, volumeFromHistory };
}

// ── Derived tiles (ports every legacy tile, plus dynamic readings) ───────────

export interface DerivedTile {
  key: string;
  label: string;
  /** Formatted value, or null when the inputs were missing (render an em dash). */
  value: string | null;
  /** Plain-language tooltip: what the metric is + how to read this value. */
  title: string;
  tone?: "pos" | "neg";
}

/** Compact dollar formatter for daily $ volume (input is in $millions) — same
 *  buckets as the legacy drawer. */
export function formatDollarsM(millions: number): string {
  if (millions >= 1000) return `$${(millions / 1000).toFixed(2)}B`;
  if (millions >= 1) return `$${Math.round(millions)}M`;
  return `$${(millions * 1000).toFixed(0)}K`;
}

const COMPUTED = "Computed by this app from the last scan's quote data — the same value handed to the agent.";

/** All eleven legacy derived tiles, in the legacy order, each with a
 *  what-it-is + how-to-read-this-value tooltip. */
export function buildDerivedTiles(view: QuoteView, derived: DerivedResult): DerivedTile[] {
  const m = derived.metrics;
  const tiles: DerivedTile[] = [];

  const pegReading =
    typeof m.peg === "number"
      ? m.peg > 0 && m.peg < 1
        ? `At ${m.peg.toFixed(2)}, it looks cheap for its growth.`
        : m.peg > 2.5
          ? `At ${m.peg.toFixed(2)}, it looks expensive for its growth.`
          : `At ${m.peg.toFixed(2)}, it's roughly fairly priced for its growth.`
      : "";
  tiles.push({
    key: "peg",
    label: "PEG",
    value: typeof m.peg === "number" ? m.peg.toFixed(2) : null,
    title: `P/E divided by EPS-growth %.  Under 1 = cheap for its growth; over 2.5 = expensive. ${pegReading} ${COMPUTED}`.trim(),
    tone: typeof m.peg === "number" ? (m.peg > 0 && m.peg < 1 ? "pos" : m.peg > 2.5 ? "neg" : undefined) : undefined
  });

  tiles.push({
    key: "earnYld",
    label: "Earnings yield",
    value: typeof m.earnYld === "number" ? `${m.earnYld.toFixed(2)}%` : null,
    title: `EPS ÷ price — the inverse of P/E. ${
      typeof m.earnYld === "number" ? (m.earnYld >= 0 ? "Positive: the company earns money on today's price." : "Negative: the company is losing money.") : "Negative means the company is losing money."
    } ${COMPUTED}`,
    tone: typeof m.earnYld === "number" ? (m.earnYld >= 0 ? "pos" : "neg") : undefined
  });

  tiles.push({
    key: "roe",
    label: "ROE",
    value: typeof m.roe === "number" ? `${m.roe.toFixed(1)}%` : null,
    title: `Return on equity — provider-reported (trailing twelve months) when available, otherwise EPS ÷ book value per share.  Higher = more efficient use of shareholder capital; 20%+ is excellent, negative means losses.  ${COMPUTED}`,
    tone: typeof m.roe === "number" ? (m.roe >= 0 ? "pos" : "neg") : undefined
  });

  tiles.push({
    key: "payout",
    label: "Payout ratio",
    value: typeof m.payout === "number" ? `${m.payout.toFixed(0)}%` : null,
    title: `Dividends ÷ EPS.  Over 100% means the dividend exceeds earnings and may be unsustainable. ${
      typeof m.payout === "number" ? (m.payout > 100 ? "This one currently exceeds earnings." : "This one is currently covered by earnings.") : ""
    } ${COMPUTED}`.trim(),
    tone: typeof m.payout === "number" && m.payout > 100 ? "neg" : undefined
  });

  tiles.push({
    key: "dollarVolM",
    label: "Daily $ volume",
    value: typeof m.dollarVolM === "number" ? formatDollarsM(m.dollarVolM) : null,
    title: `Price × daily share volume — how much money trades in a day.  Higher = easier to enter and exit without moving the price. ${
      derived.volumeFromHistory ? "Share volume here comes from the latest daily price bar (the scan tier didn't carry it)." : ""
    } ${COMPUTED}`.trim()
  });

  tiles.push({
    key: "spreadBps",
    label: "Bid-ask spread",
    value: typeof m.spreadBps === "number" ? `${m.spreadBps.toFixed(1)} bps` : null,
    title: `(ask − bid) ÷ mid, in basis points — the cost of crossing the spread.  Wide spreads favor limit orders.  ${COMPUTED}`
  });

  tiles.push({
    key: "grahamNumber",
    label: "Graham value",
    value: typeof m.grahamNumber === "number" ? `$${m.grahamNumber.toFixed(2)}` : null,
    title: `Benjamin Graham's intrinsic-value estimate = √(22.5 × EPS × book value per share) — a conservative fair-value yardstick for profitable companies.  Compare it to the current price.  ${COMPUTED}`
  });

  tiles.push({
    key: "marginOfSafety",
    label: "Margin of safety",
    value: typeof m.marginOfSafety === "number" ? `${m.marginOfSafety >= 0 ? "+" : ""}${m.marginOfSafety.toFixed(1)}%` : null,
    title: `(Graham value − price) ÷ price. ${
      typeof m.marginOfSafety === "number"
        ? m.marginOfSafety >= 0
          ? "Positive: trading below the Graham estimate — a value cushion."
          : "Negative: trading above the Graham estimate."
        : "Positive = trading below intrinsic value (a value cushion); negative = above it."
    } ${COMPUTED}`,
    tone: typeof m.marginOfSafety === "number" ? (m.marginOfSafety >= 0 ? "pos" : "neg") : undefined
  });

  tiles.push({
    key: "pctFromHigh",
    label: "% from 52w high",
    value: typeof m.pctFromHigh === "number" ? `${m.pctFromHigh.toFixed(1)}%` : null,
    title: `(price − 52-week high) ÷ high. 0% = at the high (breakout zone); deeply negative = a large pullback.  ${COMPUTED}`
  });

  tiles.push({
    key: "rr52w",
    label: "Reward:risk (52w)",
    value: typeof m.rr52w === "number" ? m.rr52w.toFixed(2) : null,
    title: `(52w high − price) ÷ (price − 52w low).  Above 1 = more room up to the high than down to the low.  ${COMPUTED}`,
    tone: typeof m.rr52w === "number" ? (m.rr52w >= 1 ? "pos" : "neg") : undefined
  });

  tiles.push({
    key: "sectorRelStrength",
    label: "Sector rel. strength",
    value:
      typeof view.sectorRelStrength === "number"
        ? `${view.sectorRelStrength >= 0 ? "+" : ""}${view.sectorRelStrength.toFixed(2)}%`
        : null,
    title: `Today's % move minus the average move of its sector among the scan candidates.  Positive = outperforming its sector today.  ${COMPUTED}`,
    tone: typeof view.sectorRelStrength === "number" ? (view.sectorRelStrength >= 0 ? "pos" : "neg") : undefined
  });

  return tiles;
}

// ── Signal summary (faithful port of the legacy pros/cons thresholds) ────────

export interface SignalSummary {
  pros: string[];
  cons: string[];
}

export function buildSignalSummary(view: QuoteView, metrics: DerivedMetrics): SignalSummary {
  const pros: string[] = [];
  const cons: string[] = [];

  if (typeof view.score === "number") {
    if (view.score >= 70) pros.push("Strong overall composite score.");
    else if (view.score <= 35) cons.push("Weak overall composite score.");
  }

  if (view.peRatio && view.peRatio > 0 && view.peRatio < 15) pros.push("Attractive P/E valuation.");
  if (view.peRatio && view.peRatio > 50) cons.push("Elevated P/E valuation implies high growth expectations.");

  if (typeof view.sentiment === "number" && view.sentiment >= 60) pros.push("Positive news sentiment detected.");
  else if (typeof view.sentiment === "number" && view.sentiment <= 40) cons.push("Negative news sentiment detected.");

  if (typeof view.insiderSentiment === "number" && view.insiderSentiment >= 60) pros.push("Bullish insider transaction activity.");
  else if (typeof view.insiderSentiment === "number" && view.insiderSentiment <= 40) cons.push("Bearish insider transaction activity.");

  if (view.senateTrades && view.senateTrades > 0) pros.push("Delayed congressional disclosure context is net positive.");
  else if (view.senateTrades && view.senateTrades < 0) cons.push("Delayed congressional disclosure context is net negative.");

  const fb = view.factorBreakdown;
  if (typeof fb?.momentum === "number" && fb.momentum >= 65) pros.push("Strong relative momentum.");
  if (typeof fb?.quality === "number" && fb.quality >= 65) pros.push("High quality fundamentals (FCF/Debt/Growth).");
  if (typeof fb?.value === "number" && fb.value <= 35) cons.push("Extended fundamental valuation.");

  if (typeof metrics.peg === "number" && metrics.peg > 0 && metrics.peg < 1) pros.push("Cheap relative to its growth (PEG < 1).");
  else if (typeof metrics.peg === "number" && metrics.peg > 2.5) cons.push("Expensive relative to its growth (PEG > 2.5).");
  if (typeof metrics.roe === "number" && metrics.roe >= 20) pros.push("High return on equity (efficient capital use).");
  else if (typeof metrics.roe === "number" && metrics.roe < 0) cons.push("Negative return on equity (losing money on equity).");
  if (typeof metrics.payout === "number" && metrics.payout > 100) cons.push("Dividend exceeds earnings (payout > 100%, may be unsustainable).");

  return { pros, cons };
}

// ── Signal chips (sentiment / insiders / congress / earnings proximity) ──────

export interface SignalChip {
  key: string;
  label: string;
  tone: "pos" | "neg" | "warn" | "muted";
  title: string;
}

export function buildSignalChips(view: QuoteView): SignalChip[] {
  const chips: SignalChip[] = [];
  if (typeof view.daysToEarnings === "number") {
    const d = Math.round(view.daysToEarnings);
    chips.push({
      key: "earnings",
      label: d <= 0 ? "Earnings imminent" : `Earnings in ${d} trading day${d === 1 ? "" : "s"}`,
      tone: d <= 7 ? "warn" : "muted",
      title: withProvenance(
        "Trading days until the next scheduled earnings report.  Prices can gap sharply on the report, so entries this close to earnings carry extra risk.",
        view,
        "daysToEarnings"
      )
    });
  }
  if (typeof view.sentiment === "number") {
    chips.push({
      key: "sentiment",
      label: `News ${Math.round(view.sentiment)}/100`,
      tone: view.sentiment >= 60 ? "pos" : view.sentiment <= 40 ? "neg" : "muted",
      title: withProvenance(
        "News tone computed from recent headlines (0–100, 50 = neutral). 60+ reads positive; 40 and below reads negative.",
        view,
        "sentiment"
      )
    });
  }
  if (typeof view.insiderSentiment === "number") {
    chips.push({
      key: "insider",
      label: `Insiders ${Math.round(view.insiderSentiment)}/100`,
      tone: view.insiderSentiment >= 60 ? "pos" : view.insiderSentiment <= 40 ? "neg" : "muted",
      title: withProvenance(
        "Share of recent insider Form 4 open-market transactions that were buys (0–100, 50 = balanced). 60+ = insiders are net buying; 40 and below = net selling.",
        view,
        "insiderSentiment"
      )
    });
  }
  if (typeof view.senateTrades === "number" && view.senateTrades !== 0) {
    chips.push({
      key: "congress",
      label: `Congress ${view.senateTrades > 0 ? "+" : ""}${view.senateTrades}`,
      tone: view.senateTrades > 0 ? "pos" : "neg",
      title: withProvenance(
        "Net congressional trading from delayed public disclosures: distinct members buying minus members selling.  Positive = net buying.  Disclosures lag the trades by up to 45 days.",
        view,
        "senateTrades"
      )
    });
  }
  return chips;
}

// ── Factor breakdown rows (labels + honest explainers) ───────────────────────

/** Known factor labels/explainers, following the actual scoring inputs in
 *  src/lib/market.ts (scoreFactors). Order mirrors the legacy drawer's seven,
 *  with diversification — which the legacy drawer omitted even though it is a
 *  weighted input of the composite — appended last. */
const FACTOR_META: Record<string, { label: string; title: string; order: number }> = {
  value: { order: 0, label: "Value", title: "How cheap the stock looks: P/E bands (≤15 scores best) lifted or dinged by free-cash-flow yield. 0–100; higher = cheaper." },
  momentum: { order: 1, label: "Momentum", title: "Price strength: today's move blended with the position in the 52-week range and, when available, bar-based technical reads (RSI/MACD/moving averages).  Higher = stronger trend." },
  quality: { order: 2, label: "Quality", title: "Business sturdiness: size/liquidity base adjusted by debt-to-equity (lower is better) and EPS growth (higher is better).  Higher = sturdier fundamentals." },
  positioning: { order: 3, label: "Positioning", title: "Smart-money positioning: net congressional buying, insider open-market buying, and squeeze-level short interest. 50 = neutral; higher = accumulation." },
  sentiment: { order: 4, label: "Sentiment", title: "News tone from recent headlines, 0–100. 50 = neutral; higher = more positive coverage." },
  liquidity: { order: 5, label: "Liquidity", title: "How easily a position trades, from daily share volume (or market cap as a proxy).  Higher = cheaper to get in and out." },
  volatility: { order: 6, label: "Volatility", title: "Price steadiness: penalizes large intraday swings and high beta.  Higher = calmer, easier to size." },
  diversification: { order: 7, label: "Diversification", title: "Portfolio-concentration guard: 80 when this account holds no position in the name, 45 when it already does — steering the ranking toward names you don't already own." }
};

export interface FactorRow {
  key: string;
  label: string;
  title: string;
  value: number;
}

/** Every weighted factor sub-score actually present on the breakdown (the
 *  composite `weightedTotal` is excluded — it's rendered separately). Derived
 *  from the object's own keys so a factor added to ScoringWeights later can
 *  never silently vanish from the drawer; unknown keys get a titleized label
 *  and a generic explainer. */
export function factorRows(fb: MarketFactorBreakdown): FactorRow[] {
  return Object.entries(fb)
    .filter(([key, value]) => key !== "weightedTotal" && typeof value === "number" && Number.isFinite(value))
    .map(([key, value]) => ({
      key,
      label: FACTOR_META[key]?.label ?? key.charAt(0).toUpperCase() + key.slice(1).replace(/([A-Z])/g, " $1").toLowerCase(),
      title:
        FACTOR_META[key]?.title ??
        "Factor sub-score (0–100) included in the composite scan score at the weight your policy assigns it.",
      value: value as number
    }))
    .sort((a, b) => {
      const ao = FACTOR_META[a.key]?.order ?? Number.MAX_SAFE_INTEGER;
      const bo = FACTOR_META[b.key]?.order ?? Number.MAX_SAFE_INTEGER;
      return ao !== bo ? ao - bo : a.key.localeCompare(b.key);
    });
}

// ── Position economics (same math as the legacy positions table) ─────────────

export interface PositionEconomics {
  costBasis: number;
  pnl: number;
  /** Undefined when cost basis isn't positive (e.g. short positions) — render an em dash. */
  returnPct?: number;
  isShort: boolean;
}

export function positionEconomics(position: EquityPosition): PositionEconomics {
  const costBasis = position.averageCost * position.quantity;
  const pnl = position.marketValue - costBasis;
  return {
    costBasis,
    pnl,
    returnPct: costBasis > 0 ? (pnl / costBasis) * 100 : undefined,
    isShort: position.quantity < 0
  };
}

// ── Analyst rating + price targets ───────────────────────────────────────────

export interface RatingDistribution {
  source: string;
  counts: { strongBuy: number; buy: number; hold: number; sell: number; strongSell: number };
  total: number;
}

/** First analyst source that reports per-bucket counts (used for the
 *  distribution bar); the tooltip still lists every source. */
export function ratingDistribution(view: QuoteView): RatingDistribution | null {
  for (const [source, detail] of Object.entries(view.analystBySource ?? {})) {
    if (detail.counts) {
      const c = detail.counts;
      const total = c.strongBuy + c.buy + c.hold + c.sell + c.strongSell;
      if (total > 0) return { source, counts: c, total };
    }
  }
  return null;
}

/** Multi-line analyst tooltip, mirroring the legacy ratingTitle text. */
export function ratingTooltip(view: QuoteView): string {
  if (typeof view.analystScore !== "number") return "No analyst rating data";
  const header = `Blended ${view.analystScore}/100 (${view.analystRating ?? "n/a"})`;
  const lines = Object.entries(view.analystBySource ?? {}).map(([src, detail]) => {
    const suffix = detail.counts
      ? ` (Strong Buy ${detail.counts.strongBuy}, Buy ${detail.counts.buy}, Hold ${detail.counts.hold}, Sell ${detail.counts.sell}, Strong Sell ${detail.counts.strongSell})`
      : typeof detail.mean === "number"
        ? ` (Yahoo mean ${detail.mean}; 1.0 = Strong Buy, 3.0 = Hold, 5.0 = Strong Sell)`
        : "";
    return `${friendlySource(src)}: ${detail.label} ${detail.score}${suffix}`;
  });
  return [header, ...lines].join("\n");
}

/** Implied % move from the current price to the consensus target
 *  (mean, else median). Undefined without both real numbers. */
export function targetUpsidePct(view: QuoteView): number | undefined {
  const target = view.targetMean ?? view.targetMedian;
  if (typeof target !== "number" || typeof view.price !== "number" || view.price <= 0) return undefined;
  return ((target - view.price) / view.price) * 100;
}

// ── Provenance tooltips ("via Yahoo Finance") ────────────────────────────────

/** Append per-field provenance + freshness to a tooltip when the scan recorded
 *  which provider supplied the field. When no provider supplied it, append
 *  neither — stamping "Received <time>" on a field no provider returned claims
 *  freshness for data we never got. */
export function isStaleViewField(view: QuoteView, fieldKey?: keyof EnrichmentSources): boolean {
  const specificTime = fieldKey && view.fieldObservations?.[fieldKey]?.fetchedAt;
  const time = specificTime || view.asOf;
  if (!time) return false;
  return Date.now() - new Date(time).getTime() > 24 * 60 * 60 * 1000;
}

export function withProvenance(base: string, view: QuoteView, field: keyof EnrichmentSources): string {
  const parts = [base];
  const source = view.sources?.[field];
  if (source) {
    parts.push(`Source: ${friendlySource(source)}.`);
    const specificTime = view.fieldObservations?.[field]?.fetchedAt;
    const timeToUse = specificTime || view.asOf;
    const received = receivedLabel(timeToUse);
    const isStale = isStaleViewField(view, field);
    if (received) {
      parts.push(isStale ? `(Stale: ${received.replace('Received ', '')}).` : `${received}.`);
    }
  }
  return parts.join(" ");
}

// ── Compact big-number formatting (market cap / share volume) ────────────────

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 });

// Owner copy rule (docs/FLEET-UI-COPY.md "Money"): compact suffixes are
// lowercase ($1.2m, not $1.2M). Intl's compact notation always emits
// uppercase K/M/B/T, so lowercase the whole formatted string — safe because
// digits, "$", ".", and "-" have no case.
export function fmtCompact(v: number | undefined): string | null {
  return typeof v === "number" && Number.isFinite(v) ? compact.format(v).toLowerCase() : null;
}

/** Display-normalize debt/equity the same way the legacy scan table does:
 *  providers report either a ratio (1.5) or a percentage (150); values > 10
 *  are treated as percentages EXCEPT when sourced from sec-xbrl, which always
 *  emits a true ratio. */
export function normalizedDebtToEquity(view: QuoteView): number | undefined {
  if (typeof view.debtToEquity !== "number") return undefined;
  return view.sources?.debtToEquity !== "sec-xbrl" && view.debtToEquity > 10
    ? view.debtToEquity / 100
    : view.debtToEquity;
}
