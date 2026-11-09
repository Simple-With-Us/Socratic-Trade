"use client";

/** Market Scan column definitions for the console. Every column carries a
 *  plain-language header tooltip (what it means + where it comes from) and a
 *  per-cell tooltip with the field's OWN provenance from `quote.sources` —
 *  attribution is always the specific provider that supplied the value, never
 *  a hardcoded name. Missing data renders as "—"; P/E follows the repo rule:
 *  "n/a" = negative/zero earnings (a real computed no-ratio state, decided by
 *  `eps`), "—" = the data simply wasn't available. */

import type { ReactNode } from "react";
import type { MarketQuote, EnrichmentSources } from "@/lib/types";
import { friendlySource, insiderSentimentTitle, ratingTitle, receivedLabel, sentimentTitle } from "@/lib/dashboard-ui";
import { fmtMoney, fmtPct } from "../lib/format";
import { Chip, Dash, SignedText } from "../ui/primitives";
import { SymbolButton } from "../ui/symbol-drilldown";

// Owner copy rule (docs/FLEET-UI-COPY.md "Money"): compact suffixes are
// lowercase ($1.2m, not $1.2M) — Intl always emits uppercase K/M/B/T, so
// every call site below lowercases the formatted result.
const compactNum = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

/** "Label\nSource: <provider>\nReceived <time>" — provenance strictly from the
 *  field's own recorded source; with no source the line is simply omitted. */
export function fieldTitle(label: string, source?: string, asOf?: string, isStale?: boolean): string {
  const parts = [label];
  if (source) parts.push(`Source: ${friendlySource(source)}`);
  const received = receivedLabel(asOf);
  if (received) {
    parts.push(isStale ? `(Stale: ${received.replace('Received ', '')})` : received);
  }
  return parts.join("\n");
}

export function isStaleField(q: MarketQuote, fieldKey?: keyof EnrichmentSources): boolean {
  const specificTime = fieldKey && q.fieldObservations?.[fieldKey]?.fetchedAt;
  const time = specificTime || q.asOf;
  if (!time) return false;
  return Date.now() - new Date(time).getTime() > 24 * 60 * 60 * 1000;
}

/** Price provenance is two-stage server-side: enrichment can refine the
 *  screener price (recording `sources.price`), and a later live broker/Yahoo
 *  quote merge (mergeQuoteData in src/lib/market.ts) can replace the price
 *  again — that merge updates the quote-level `provider` but NOT
 *  `sources.price`, so the two can legitimately disagree. Reading only
 *  `sources.price` would misattribute a merged live price to the older
 *  provider. When they agree (or only one is recorded) name it; when both
 *  exist and differ, name both honestly — the pipeline doesn't record which
 *  value survived, so we never guess a single winner. */
function priceTitle(q: MarketQuote): string {
  const quoteProvider = q.provider;
  const enrichedPrice = q.sources?.price;
  const parts = ["Last price"];
  if (quoteProvider && enrichedPrice && friendlySource(quoteProvider) !== friendlySource(enrichedPrice)) {
    parts.push(`Source: ${friendlySource(quoteProvider)} + ${friendlySource(enrichedPrice)} (merged quote + enrichment)`);
  } else {
    const single = quoteProvider ?? enrichedPrice;
    if (single) parts.push(`Source: ${friendlySource(single)}`);
  }
  const received = receivedLabel(q.asOf);
  if (received) parts.push(received);
  return parts.join("\n");
}

function SentimentChip({ value }: { value: number }) {
  const tone = value >= 60 ? "pos" : value <= 40 ? "neg" : "muted";
  const word = value >= 60 ? "Positive" : value <= 40 ? "Negative" : "Neutral";
  return (
    <Chip tone={tone}>
      {word} · {value}
    </Chip>
  );
}

function RatingChip({ label, score }: { label: string; score?: number }) {
  const tone = typeof score === "number" ? (score >= 65 ? "pos" : score <= 40 ? "neg" : "muted") : "muted";
  return <Chip tone={tone}>{typeof score === "number" ? `${label} · ${score}` : label}</Chip>;
}

export interface ScanColumn {
  id: string;
  label: string;
  /** Concise plain-language header tooltip: meaning + methodology + source. */
  headerTitle: string;
  /** Right-aligned tabular numerals (adds the con-table `num` class). */
  num?: boolean;
  /** Text/cell content alignment (defaults to "center"). */
  align?: "left" | "center" | "right";
  /** Value the column sorts on; undefined always sorts last. */
  sortValue: (q: MarketQuote) => number | string | undefined;
  render: (q: MarketQuote) => ReactNode;
  cellTitle?: (q: MarketQuote) => string | undefined;
}

export const SCAN_COLUMNS: ScanColumn[] = [
  {
    id: "symbol",
    label: "Symbol",
    headerTitle: "Ticker symbol — click one to open the drilldown with a price chart and key stats.  Hover a row for the company name.",
    align: "left",
    sortValue: (q) => q.symbol,
    render: (q) => (
      <span className="flex items-center gap-1.5 whitespace-nowrap">
        {/* Pass the row's own quote so the drilldown renders the SAME scan the
            table shows — a page-refreshed scan can be fresher than the run
            capture the sheet would otherwise resolve from. */}
        <SymbolButton
          symbol={q.symbol}
          quote={q}
          title={q.companyName ? `${q.companyName} — open ${q.symbol} details` : `Open ${q.symbol} details`}
        />
        {/* marketValue = quantity × mark (see src/lib/dashboard.ts / alpaca.ts),
            so a SHORT position carries a NEGATIVE value — any non-zero value is
            an open position, and the sign distinguishes direction. */}
        {typeof q.positionMarketValue === "number" && Number.isFinite(q.positionMarketValue) && q.positionMarketValue !== 0 && (
          q.positionMarketValue < 0 ? (
            <Chip
              tone="warn"
              title={`You hold a SHORT position in ${q.symbol} — about ${fmtMoney(Math.abs(q.positionMarketValue))} of market value at scan time (position value is negative because it's owed).`}
            >
              short
            </Chip>
          ) : (
            <Chip tone="accent" title={`You hold a position in ${q.symbol} — about ${fmtMoney(q.positionMarketValue)} at scan time.`}>
              held
            </Chip>
          )
        )}
      </span>
    ),
    cellTitle: (q) => q.companyName
  },
  {
    id: "score",
    label: "Score",
    headerTitle:
      "Composite 0–100 scan score — a weighted blend of liquidity, momentum, value, quality, volatility, sentiment and diversification factors, computed by the scanner (weights are configurable in strategy settings).  Higher = ranked more attractive this run.",
    num: true,
    align: "center",
    sortValue: (q) => q.score,
    // Defensive typeof: historical/compact run captures may omit per-quote
    // fields the current MarketScan type marks required.
    render: (q) => (typeof q.score === "number" ? <span className="font-semibold">{q.score.toFixed(1)}</span> : <Dash />),
    cellTitle: (q) =>
      typeof q.score === "number"
        ? fieldTitle(
            `Scan score ${q.score.toFixed(1)}/100 — computed by the scanner from this run's per-factor inputs, not a provider value.`,
            undefined,
            q.asOf
          )
        : "No scan score was recorded for this candidate."
  },
  {
    id: "price",
    label: "Price",
    headerTitle: "Last traded price (may be delayed).  Hover a cell for the provider(s) that supplied it.",
    num: true,
    align: "right",
    sortValue: (q) => q.price,
    render: (q) => (q.price > 0 ? fmtMoney(q.price) : <Dash />),
    cellTitle: (q) => priceTitle(q)
  },
  {
    id: "change",
    label: "Chg",
    headerTitle: "Intraday change — percent move vs the prior session's close.  Green up, red down.",
    num: true,
    align: "center",
    sortValue: (q) => q.intradayChangePct,
    render: (q) =>
      typeof q.intradayChangePct === "number" && Number.isFinite(q.intradayChangePct) ? (
        <SignedText value={q.intradayChangePct}>{fmtPct(q.intradayChangePct, 2, true)}</SignedText>
      ) : (
        <Dash />
      ),
    cellTitle: (q) => fieldTitle("Intraday change vs prior close", q.sources?.intradayChangePct, q.asOf)
  },
  {
    id: "volume",
    label: "Vol",
    headerTitle: "Shares traded today (some providers report the 10-day average after hours).",
    num: true,
    align: "center",
    sortValue: (q) => (q.volume > 0 ? q.volume : undefined),
    render: (q) => (q.volume > 0 ? compactNum.format(q.volume).toLowerCase() : <Dash />),
    cellTitle: (q) => fieldTitle("Share volume", q.sources?.volume, q.asOf)
  },
  {
    id: "peRatio",
    label: "P/E",
    headerTitle:
      "Price-to-earnings ratio = price ÷ trailing 12-month earnings per share; lower is cheaper relative to earnings. \"n/a\" = negative or zero earnings (no meaningful ratio); \"—\" = the data wasn't available.",
    num: true,
    align: "center",
    sortValue: (q) => (typeof q.peRatio === "number" && q.peRatio > 0 ? q.peRatio : undefined),
    render: (q) => {
      const isStale = isStaleField(q, "peRatio");
      return typeof q.peRatio === "number" && q.peRatio > 0 ? (
        <span className={isStale ? "italic opacity-70" : ""}>{q.peRatio.toFixed(1)}</span>
      ) : typeof q.eps === "number" && q.eps <= 0 ? (
        <span className="text-[color:var(--con-faint)]">n/a</span>
      ) : (
        <Dash />
      );
    },
    cellTitle: (q) => {
      const isStale = isStaleField(q, "peRatio");
      if (typeof q.peRatio === "number" && q.peRatio > 0) return fieldTitle("P/E ratio", q.sources?.peRatio, q.fieldObservations?.peRatio?.fetchedAt || q.asOf, isStale);
      if (typeof q.eps === "number" && q.eps <= 0) {
        return fieldTitle("n/a — trailing earnings are negative or zero, so there is no meaningful P/E ratio.", q.sources?.eps, q.fieldObservations?.eps?.fetchedAt || q.asOf, isStale);
      }
      return "P/E wasn't available from any provider for this symbol.";
    }
  },
  {
    id: "epsGrowth",
    label: "EPS gr",
    headerTitle: "Earnings-per-share growth, year over year.  Positive = earnings expanding.",
    num: true,
    align: "center",
    sortValue: (q) => q.epsGrowth,
    render: (q) => {
      const isStale = isStaleField(q, "epsGrowth");
      return typeof q.epsGrowth === "number" ? (
        <span className={isStale ? "italic opacity-70" : ""}>
          <SignedText value={q.epsGrowth}>{fmtPct(q.epsGrowth * 100, 0, true)}</SignedText>
        </span>
      ) : (
        <Dash />
      );
    },
    cellTitle: (q) => fieldTitle("EPS growth (year over year)", q.sources?.epsGrowth, q.fieldObservations?.epsGrowth?.fetchedAt || q.asOf, isStaleField(q, "epsGrowth"))
  },
  {
    id: "dividendYield",
    label: "Div",
    headerTitle: "Annual dividend yield = trailing dividends per share ÷ price.",
    num: true,
    align: "center",
    sortValue: (q) => q.dividendYield,
    render: (q) => {
      const isStale = isStaleField(q, "dividendYield");
      return typeof q.dividendYield === "number" ? (
        <span className={isStale ? "italic opacity-70" : ""}>{fmtPct(q.dividendYield, 2)}</span>
      ) : (
        <Dash />
      );
    },
    cellTitle: (q) => fieldTitle("Dividend yield", q.sources?.dividendYield, q.fieldObservations?.dividendYield?.fetchedAt || q.asOf, isStaleField(q, "dividendYield"))
  },
  {
    id: "sentiment",
    label: "News",
    headerTitle: "News sentiment score 0–100 (50 = neutral), scored from recent headlines.  Hover a cell for the headlines behind the number.",
    align: "center",
    sortValue: (q) => q.sentiment,
    render: (q) => (typeof q.sentiment === "number" ? <SentimentChip value={q.sentiment} /> : <Dash />),
    cellTitle: (q) => sentimentTitle(q)
  },
  {
    id: "insiderSentiment",
    label: "Insiders",
    headerTitle: "Insider sentiment score 0–100 (50 = neutral), derived from SEC Form 4 insider transaction disclosures.  Hover a cell for details.",
    align: "center",
    sortValue: (q) => q.insiderSentiment,
    render: (q) => (typeof q.insiderSentiment === "number" ? <SentimentChip value={q.insiderSentiment} /> : <Dash />),
    cellTitle: (q) => insiderSentimentTitle(q)
  },
  {
    id: "analystScore",
    label: "Rating",
    headerTitle: "Analyst consensus 0–100, blended across providers (Strong Buy = 100 … Strong Sell = 0).  Hover a cell for the per-provider breakdown.",
    align: "center",
    sortValue: (q) => q.analystScore,
    render: (q) => (q.analystRating ? <RatingChip label={q.analystRating} score={q.analystScore} /> : <Dash />),
    cellTitle: (q) => ratingTitle(q)
  },
  {
    id: "senateTrades",
    label: "Congress",
    headerTitle:
      "Congressional trading composite score and disclosures (Conviction, Consensus, Skill, Flow, Freshness).  Hover or tap a cell for full details.",
    num: true,
    align: "center",
    sortValue: (q) => q.congressCompositeSignedScore ?? q.congressCompositeScore ?? q.senateTrades,
    render: (q) => {
      const score = q.congressCompositeSignedScore ?? q.congressCompositeScore;
      if (typeof score === "number" && score !== 0) {
        return (
          <SignedText value={score}>
            {score > 0 ? `+${score}` : String(score)}
          </SignedText>
        );
      }
      if (typeof q.senateTrades === "number" && q.senateTrades !== 0) {
        return (
          <SignedText value={q.senateTrades}>
            {q.senateTrades > 0 ? `+${q.senateTrades}` : String(q.senateTrades)}
          </SignedText>
        );
      }
      return <Dash />;
    },
    cellTitle: (q) => {
      const parts: string[] = [];
      const score = q.congressCompositeSignedScore ?? q.congressCompositeScore;
      if (typeof score === "number") {
        const dir = q.congressCompositeDirection ? ` (${q.congressCompositeDirection})` : "";
        parts.push(`Congress Composite Score: ${score > 0 ? "+" : ""}${score}${dir}`);
      }
      if (typeof q.senateTrades === "number") {
        parts.push(`Net congressional activity: ${q.senateTrades > 0 ? "+" : ""}${q.senateTrades} (distinct members buying minus selling over ~60 days).`);
      }
      if (q.evidenceBulletins?.length) {
        parts.push(q.evidenceBulletins.join("\n"));
      }
      if (q.sources?.senateTrades) {
        parts.push(`Source: ${friendlySource(q.sources.senateTrades)}`);
      }
      return parts.length ? parts.join("\n\n") : "No recent congressional disclosures for this symbol.";
    }
  },
  {
    id: "sector",
    label: "Sector",
    headerTitle: "Company sector classification.",
    align: "center",
    sortValue: (q) => q.sector,
    render: (q) =>
      q.sector ? (
        <span className="inline-block max-w-[10rem] truncate align-bottom text-[color:var(--con-muted)]">{q.sector}</span>
      ) : (
        <Dash />
      ),
    cellTitle: (q) =>
      q.sector
        ? fieldTitle(q.industry && q.industry !== q.sector ? `${q.sector} · ${q.industry}` : q.sector, q.sources?.sector, q.asOf)
        : "Sector wasn't available from any provider for this symbol."
  }
];

export const DEFAULT_VISIBLE_SCAN_COLUMN_IDS = SCAN_COLUMNS.map((column) => column.id);
