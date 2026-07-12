"use client";

/** Reusable symbol drilldown for the console: a clickable ticker
 *  (<SymbolButton>) that opens a drawer with the company identity, a daily
 *  price chart over /api/history, and — when the last market scan knew the
 *  symbol — the full research drawer: your exposure (position, pending ideas,
 *  recent orders), a plain-language signal summary, the eleven backend-derived
 *  metric tiles, the seven-factor score breakdown, analyst ratings + price
 *  targets, deep fundamentals, evidence bulletins, and per-field data-source
 *  provenance. Everything degrades honestly: no history → a sentence, no
 *  quote → em dashes and a notice, never a crash or a fabricated number. */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { MarketQuote, MarketQuoteSummary } from "@/lib/types";
import { useConsoleData } from "../lib/useConsoleData";
import { cx, fmtMoney, fmtPct, EM_DASH } from "../lib/format";
import { Chip } from "./primitives";
import { useSymbolDrawer } from "./symbol-drawer";
import { TickerLogo } from "./ticker-logo";
import { deriveForView, preferFreshQuote, toQuoteView, withProvenance } from "./drilldown-data";
import {
  AnalystSection,
  DerivedTilesSection,
  EvidenceSection,
  ExposureSection,
  FactorSection,
  FundamentalsSection,
  SignalSummarySection,
  SourcesSection
} from "./drilldown-sections";

// ── Data ─────────────────────────────────────────────────────────────────────

interface HistoryBar {
  time: string; // YYYY-MM-DD
  open?: number;
  high?: number;
  low?: number;
  close: number;
  volume?: number;
}

type HistoryState =
  | { status: "loading" }
  | { status: "empty" }
  | { status: "error" }
  | { status: "ready"; bars: HistoryBar[] };

function useHistory(symbol: string, enabled: boolean): HistoryState {
  const [state, setState] = useState<HistoryState>({ status: "loading" });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setState({ status: "loading" });
    (async () => {
      try {
        const res = await fetch(`/api/history?symbol=${encodeURIComponent(symbol)}`);
        if (!res.ok) throw new Error(`history ${res.status}`);
        const json: { bars?: HistoryBar[] } = await res.json();
        const bars = (json.bars ?? []).filter((b) => typeof b.close === "number" && Number.isFinite(b.close));
        if (cancelled) return;
        setState(bars.length >= 2 ? { status: "ready", bars } : { status: "empty" });
      } catch {
        if (!cancelled) setState({ status: "error" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [symbol, enabled]);

  return state;
}

/** Best-available quote summary for a symbol from the snapshot's last scan. */
function resolveQuote(
  quotesBySymbol: Record<string, MarketQuoteSummary> | undefined,
  symbol: string
): MarketQuoteSummary | null {
  if (!quotesBySymbol) return null;
  const normalized = symbol.trim().toUpperCase();
  return (
    quotesBySymbol[normalized] ??
    Object.values(quotesBySymbol).find((q) => q.symbol?.trim().toUpperCase() === normalized) ??
    null
  );
}

/** Fully-enriched top-candidate quote (factor breakdown, volume, headlines)
 *  when the symbol made the last scan's candidate list. */
function resolveFullQuote(candidates: MarketQuote[] | undefined, symbol: string): MarketQuote | undefined {
  const normalized = symbol.trim().toUpperCase();
  return candidates?.find((q) => q.symbol?.trim().toUpperCase() === normalized);
}

// ── Chart ────────────────────────────────────────────────────────────────────

const TIMEFRAMES = ["1M", "6M", "1Y", "All"] as const;
type Timeframe = (typeof TIMEFRAMES)[number];

function cutoffFor(tf: Timeframe, lastDay: string): string | null {
  if (tf === "All") return null;
  const d = new Date(`${lastDay}T00:00:00Z`);
  if (!Number.isFinite(d.getTime())) return null;
  if (tf === "1M") d.setUTCMonth(d.getUTCMonth() - 1);
  else if (tf === "6M") d.setUTCMonth(d.getUTCMonth() - 6);
  else d.setUTCFullYear(d.getUTCFullYear() - 1);
  return d.toISOString().slice(0, 10);
}

const W = 640;
const H = 180;
const PAD = 6;

/** Self-contained SVG close-price line (same honest style as EquityChart):
 *  no interpolation, fewer than two visible points renders a sentence. */
function PriceHistoryChart({ bars }: { bars: HistoryBar[] }) {
  const [tf, setTf] = useState<Timeframe>("1Y");

  const visible = useMemo(() => {
    const cutoff = cutoffFor(tf, bars[bars.length - 1].time);
    const inRange = cutoff ? bars.filter((b) => b.time >= cutoff) : bars;
    // A recent IPO may have no bars inside the window — fall back to everything.
    return inRange.length >= 2 ? inRange : bars;
  }, [bars, tf]);

  const vMin = Math.min(...visible.map((b) => b.close));
  const vMax = Math.max(...visible.map((b) => b.close));
  const vSpan = vMax - vMin || 1;
  const x = (i: number) => PAD + (i / (visible.length - 1)) * (W - PAD * 2);
  const y = (v: number) => H - PAD - ((v - vMin) / vSpan) * (H - PAD * 2);
  const path = visible.map((b, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(b.close).toFixed(1)}`).join(" ");
  const first = visible[0].close;
  const last = visible[visible.length - 1].close;
  const changePct = first > 0 ? ((last - first) / first) * 100 : undefined;
  const rising = last >= first;
  const stroke = rising ? "var(--con-pos)" : "var(--con-neg)";

  return (
    <figure>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="con-num text-[length:var(--con-fs-xs)]" style={{ color: stroke }}>
          {changePct !== undefined ? `${fmtPct(changePct, 1, true)} over ${tf === "All" ? "all history" : tf}` : EM_DASH}
        </span>
        <div className="flex items-center gap-1">
          {TIMEFRAMES.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTf(t)}
              title={t === "All" ? "Show all available daily history" : `Show the last ${t === "1M" ? "month" : t === "6M" ? "6 months" : "year"}`}
              className={cx(
                "rounded px-2 py-0.5 text-[length:var(--con-fs-xs)] font-semibold transition-colors",
                t === tf
                  ? "bg-[color:var(--con-accent-soft)] text-[color:var(--con-accent)]"
                  : "text-[color:var(--con-faint)] hover:text-[color:var(--con-fg)]"
              )}
            >
              {t}
            </button>
          ))}
        </div>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full rounded-lg border border-[color:var(--con-line)] bg-[color:var(--con-surface-2)]"
        role="img"
        aria-label={`Daily closes from ${fmtMoney(first)} to ${fmtMoney(last)}`}
      >
        <path d={path} fill="none" stroke={stroke} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      <figcaption className="con-num mt-1 flex justify-between text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
        <span>
          {visible[0].time} · {fmtMoney(first)}
        </span>
        <span>
          low {fmtMoney(vMin)} · high {fmtMoney(vMax)}
        </span>
        <span>
          {visible[visible.length - 1].time} · {fmtMoney(last)}
        </span>
      </figcaption>
    </figure>
  );
}

// ── Drilldown drawer ─────────────────────────────────────────────────────────

export function SymbolDrilldownSheet({
  symbol,
  quote
}: {
  symbol: string;
  /** Optional: the quote object the opening screen is currently rendering
   *  (e.g. a freshly fetched /api/scan row). When provided — and not older
   *  than the snapshot's run-captured quote — the sheet renders from it, so
   *  the drilldown can never disagree with the row the user clicked. */
  quote?: MarketQuote;
}) {
  const { snapshot } = useConsoleData();
  const normalized = symbol.trim().toUpperCase();
  const history = useHistory(normalized, true);

  const scan = snapshot?.latestStrategyRun?.marketScan;
  const override = quote && quote.symbol?.trim().toUpperCase() === normalized ? quote : undefined;
  const fullQuote = preferFreshQuote(override, resolveFullQuote(scan?.topCandidates, normalized));
  const usingOverride = override !== undefined && fullQuote === override;
  const summaryQuote = resolveQuote(scan?.quotesBySymbol, normalized);
  const view = useMemo(() => toQuoteView(fullQuote, summaryQuote ?? undefined), [fullQuote, summaryQuote]);

  const position = snapshot?.positions?.find((p) => p.symbol.trim().toUpperCase() === normalized);
  const pending = useMemo(
    () => (snapshot?.pendingProposals ?? []).filter((p) => p.proposal.symbol.trim().toUpperCase() === normalized),
    [snapshot?.pendingProposals, normalized]
  );
  const recentOrders = useMemo(
    () =>
      (snapshot?.orders ?? [])
        .filter((o) => o.symbol?.trim().toUpperCase() === normalized)
        .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))
        .slice(0, 4),
    [snapshot?.orders, normalized]
  );
  // Current price: prefer the scan quote; otherwise the last daily close.
  const lastBars = history.status === "ready" ? history.bars : [];
  const lastBar = lastBars.length > 0 ? lastBars[lastBars.length - 1] : undefined;
  const prevClose = lastBars.length > 1 ? lastBars[lastBars.length - 2].close : undefined;
  const price = view?.price ?? lastBar?.close;

  // Day change: prefer the scan's intraday change (fully-enriched quotes only);
  // fall back to last daily close vs the previous close from real history bars.
  const scanChangePct = view?.intradayChangePct;
  const historyChangePct =
    typeof lastBar?.close === "number" && typeof prevClose === "number" && prevClose > 0
      ? ((lastBar.close - prevClose) / prevClose) * 100
      : undefined;
  const dayChangePct = scanChangePct ?? historyChangePct;
  const dayChangeTitle =
    scanChangePct !== undefined && view
      ? withProvenance("Intraday % change captured by the last market scan.", view, "intradayChangePct")
      : "Last daily close vs the previous daily close, from the price history.";

  const derived = view ? deriveForView(view, lastBar?.volume) : null;
  const earningsSoon = typeof view?.daysToEarnings === "number" && view.daysToEarnings <= 7;

  return (
    <div className="flex flex-col gap-4">
        {/* Price line */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span
            className="con-num text-[length:var(--con-fs-xl)] font-semibold leading-tight cursor-default"
            title={
              view
                ? withProvenance(
                    usingOverride ? "Latest price from the scan currently on screen." : "Latest price known to the last market scan.",
                    view,
                    "price"
                  )
                : "Latest daily close from the price history."
            }
          >
            {fmtMoney(price)}
          </span>
          {typeof dayChangePct === "number" && (
            <span
              className="con-num cursor-default text-[length:var(--con-fs-sm)] font-semibold"
              style={{ color: dayChangePct >= 0 ? "var(--con-pos)" : "var(--con-neg)" }}
              title={dayChangeTitle}
            >
              {fmtPct(dayChangePct, 2, true)}
              {scanChangePct === undefined ? " last close" : " today"}
            </span>
          )}
          {typeof view?.score === "number" && (
            <Chip
              tone="accent"
              title="Composite 0–100 score from the last market scan — the policy-weighted total of the factor breakdown below. Higher = the screener ranked it more attractive."
            >
              Score {Math.round(view.score)}
            </Chip>
          )}
          {earningsSoon && typeof view?.daysToEarnings === "number" && (
            <Chip
              tone="warn"
              title={withProvenance(
                "Trading days until the next scheduled earnings report. Prices can gap sharply on the report — entries this close to earnings carry extra risk.",
                view,
                "daysToEarnings"
              )}
            >
              Earnings in {Math.round(view.daysToEarnings)}d
            </Chip>
          )}
          {view?.sector && (
            <span
              className="cursor-default text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]"
              title={withProvenance("Sector and industry classification.", view, "sector")}
            >
              {view.sector}
              {view.industry && view.industry !== view.sector ? ` · ${view.industry}` : ""}
            </span>
          )}
        </div>

        {/* Chart */}
        {history.status === "loading" && (
          <p className="py-8 text-center text-[length:var(--con-fs-sm)] text-[color:var(--con-faint)]">
            Loading price history…
          </p>
        )}
        {history.status === "empty" && (
          <p className="py-8 text-center text-[length:var(--con-fs-sm)] text-[color:var(--con-faint)]">
            No price history is available for {normalized} yet.
          </p>
        )}
        {history.status === "error" && (
          <p className="py-8 text-center text-[length:var(--con-fs-sm)] text-[color:var(--con-faint)]">
            Couldn&apos;t load price history for {normalized}.
          </p>
        )}
        {history.status === "ready" && <PriceHistoryChart bars={history.bars} />}

        {/* Your exposure — account truth, available even when the scan didn't know the symbol */}
        <ExposureSection symbol={normalized} position={position} pending={pending} orders={recentOrders} />

        {view && derived ? (
          <>
            <SignalSummarySection view={view} derived={derived} />
            <DerivedTilesSection view={view} derived={derived} />
            <FactorSection view={view} />
            <AnalystSection view={view} />
            <FundamentalsSection view={view} />
            <EvidenceSection view={view} />
            <SourcesSection view={view} />
          </>
        ) : (
          <p className="text-[length:var(--con-fs-xs)] leading-snug text-[color:var(--con-faint)]">
            {normalized} wasn&apos;t in the last market scan, so fundamentals, factor scores, and signals aren&apos;t
            available yet. The chart and your account data above are still real. Run a scan that includes {normalized}{" "}
            to fill this in.
          </p>
        )}

        {view?.asOf && (
          <p
            className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]"
            title="When this symbol's quote data was captured. The chart above refreshes independently from free daily history."
          >
            Quote data from {usingOverride ? "the scan currently on screen" : "the last market scan"} (
            {new Date(view.asOf).toLocaleString()}).
          </p>
        )}
    </div>
  );
}

function SymbolDrilldownTitle({ symbol, companyName }: { symbol: string; companyName?: string }) {
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <TickerLogo symbol={symbol} size="md" />
      <span className="min-w-0">
        <span className="block leading-tight">{symbol}</span>
        {companyName && (
          <span className="block truncate text-[length:var(--con-fs-xs)] font-normal text-[color:var(--con-faint)]">
            {companyName}
          </span>
        )}
      </span>
    </span>
  );
}

// ── SymbolButton ─────────────────────────────────────────────────────────────

/** A ticker rendered as logo + text that opens the drilldown sheet. Drop this
 *  wherever a table shows a symbol. */
export function SymbolButton({
  symbol,
  className,
  title,
  showLogo = true,
  logoSize = "sm",
  quote,
  children
}: {
  symbol: string;
  className?: string;
  title?: string;
  showLogo?: boolean;
  logoSize?: "sm" | "md" | "lg";
  /** Optional: the quote object this button's row is currently rendering
   *  (e.g. a freshly fetched /api/scan result). Passed through to the sheet
   *  so the drilldown matches the row instead of the snapshot's last run. */
  quote?: MarketQuote;
  /** Optional custom label; defaults to the symbol text. */
  children?: ReactNode;
}) {
  const { openDrawer } = useSymbolDrawer();
  const normalized = symbol.trim().toUpperCase();
  const companyName = quote?.companyName;

  return (
    <button
      type="button"
      title={title ?? `Open ${normalized} details`}
      onClick={(e) => {
        e.stopPropagation();
        openDrawer({
          title: <SymbolDrilldownTitle symbol={normalized} companyName={companyName} />,
          ariaLabel: `${normalized} details`,
          body: <SymbolDrilldownSheet key={normalized} symbol={normalized} quote={quote} />
        });
      }}
      className={cx(
        "inline-flex cursor-pointer items-center gap-1.5 font-semibold underline decoration-[color:var(--con-line-strong)] decoration-1 underline-offset-[3px] transition-colors hover:text-[color:var(--con-accent)] hover:decoration-[color:var(--con-accent)]",
        className
      )}
    >
      {showLogo && <TickerLogo symbol={normalized} size={logoSize} />}
      <span>{children ?? normalized}</span>
    </button>
  );
}
