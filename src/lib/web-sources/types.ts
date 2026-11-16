import type { TechnicalDirection } from "../types";

// Shared types for the backend "web sources" subsystem.
//
// These connectors read data from sources that have NO free, key-based API — most
// of it is scraped/parsed from public disclosure sites (Senate eFD, SEC EDGAR) or
// public JSON back-ends (Capitol Trades). Everything here runs server-side only.
//
// Design rules (see docs/phase-9-web-sources.md):
//   1. Never fabricate. If every adapter fails, the connector yields NOTHING — the
//      dashboard shows "—" and the agent simply has no signal, never a fake one.
//   2. Low frequency. Each connector refreshes on its own cadence (default daily),
//      gated by a persisted "fetchedAt" timestamp so restarts don't re-scrape.
//   3. Persisted. Datasets live in the SQLite `settings` KV via setInternalSetting,
//      so a scrape survives a server restart and is reused until the next refresh.

/** A single normalized congressional (or other "smart money") trade disclosure.
 *  This is App B's internal representation. The shared package's `CongressTransaction`
 *  type (in @jaywedgeworth22/congress-trading-shared) is the cross-app wire format used
 *  by App A's API. See `coerceCongressTrade()` in congress.ts for the conversion. */
export interface CongressTrade {
  symbol: string; // normalized ticker (uppercase, no class suffix)
  member: string; // e.g. "John Boozman"
  chamber: "senate" | "house" | "executive";
  side: "buy" | "sell" | "exchange";
  amountLow?: number; // lower bound of the disclosed dollar range
  amountHigh?: number; // upper bound of the disclosed dollar range
  owner?: string; // Self / Joint / Spouse / Child
  tradedAt: string; // ISO date the trade occurred (txDate)
  disclosedAt?: string; // ISO date the report was filed.  Absent when the filing date was not disclosed.
  source: string; // adapter id that produced this record
  /** App A transaction id.  Present rows dedupe on this instead of the lossy summary key. */
  id?: string;
  docId?: string;
  rowKey?: string;
  party?: string;
  bioguideId?: string;
  pdfUrl?: string;
  disclosureLagDays?: number;
  stockActStatus?: string;
  priceAtTrade?: number;
  spxAtTrade?: number;
  priceAtFiling?: number;
  spxAtFiling?: number;
  latencyProbeHealth?: string;
  latencyProbeDelayMs?: number;
  providerPublishedAt?: string;
}

/** Per-symbol aggregate of recent congressional trading (the overlay the scan reads).
 *  This is App B-internal — the shared package (@jaywedgeworth22/congress-trading-shared)
 *  does not define a signal aggregate; it provides the raw `CongressTransaction` row type
 *  and analytics types (TickerLeader, ConvictionTicker, etc.) consumed by the analytics overlay. */
export interface CongressSignal {
  /** Net directional vote within the window: distinct-buy members minus distinct-sell members. */
  netSignal: number;
  buyCount: number; // number of buy disclosures in window
  sellCount: number; // number of sell disclosures in window
  buyMembers: string[]; // distinct members who bought (most recent first)
  sellMembers: string[]; // distinct members who sold
  windowDays: number;
  lastTradedAt?: string;
  /** ISO date the most recent disclosure was filed (the date the market could act on it). */
  lastDisclosedAt?: string;
  /** One-line bulletin for the agent prompt (raw rows are kept OUT of the prompt). */
  bulletin: string;
}

/**
 * App A (congress.trade) aggregate analytics for a ticker — the public "Trends" composite App B can't
 * derive from raw trades alone (dollar-weighted net flow, distinct-member counts, cluster buys, member
 * track-record). Populated only when CONGRESS_ANALYTICS_ENABLED is on; additive to the scraped signal.
 */
export interface CongressAnalytics {
  netFlowUsd?: number; // estimated net $ flow (buys − sells) over the analytics window
  estVolumeUsd?: number;
  tradeCount?: number;
  buyCount?: number;
  sellCount?: number;
  memberCount?: number; // distinct members trading the ticker
  netSentiment?: number; // -1..1
  cluster?: boolean; // appears in App A's cluster-buys (many members → same ticker)
  clusterMemberCount?: number;
  topMemberScore?: number; // 0–100 best member-quality among the ticker's cluster members
  /** Prefer realized_skill_filing (copy-trade since disclosure); trade = politician timing; activity = volume proxy. */
  topMemberScoreSource?: "realized_skill_filing" | "realized_skill_trade" | "realized_skill" | "activity_prominence";
  /** Raw skill stats for the winning cluster member (from App A dual performance). */
  topMemberFilerId?: string;
  topMemberFilingAvgExcess?: number | null;
  topMemberFilingWinRate?: number | null;
  topMemberFilingScoredCount?: number;
  topMemberFilingAvgAnnualizedExcess?: number | null;
  topMemberTradeAvgExcess?: number | null;
  topMemberTradeWinRate?: number | null;
  topMemberTradeScoredCount?: number;
  /** App A composite conviction score 0–100; null = too thin (< 3 resolved-side trades). */
  convictionScore?: number | null;
  /** Direction the conviction score points: "BUY" or "SELL". null = no directional signal. */
  convictionDirection?: "BUY" | "SELL" | null;
  /** True when App A's conviction score used proxy/fallback inputs due sparse realized-skill coverage. */
  convictionFallback?: boolean;
  /** Committee-sector overlap flags in the analytics window. Context only; not a legal conclusion. */
  conflictCount?: number;
}

/** The per-symbol overlay produced by all web sources, merged onto quotes in the scan. */
export interface SymbolWebSignal {
  congress?: CongressSignal;
  /** App A aggregate analytics overlay (dollar net flow, cluster buys, member quality). */
  congressAnalytics?: CongressAnalytics;
  /** Recent insider (Form 4) net buy sentiment 0–100 (50 = balanced), from SEC EDGAR. */
  insiderSentiment?: number;
  /** Latest daily short volume as % of total volume (FINRA). */
  shortVolumeRatio?: number;
  /** Bar-based technical read (TradingView push or in-house computed). */
  technical?: {
    score: number; // 0–100, 50 = neutral
    direction: TechnicalDirection;
    signals: string[];
    tf?: string;
    asOf?: string;
    source: "tradingview" | "computed";
  };
  /** One-line evidence bulletins from every source, deduped, for the agent prompt. */
  bulletins: string[];
}

/** Result of a single connector refresh, for auditing + the dashboard health panel. */
export interface WebSourceRefreshResult {
  id: string;
  ok: boolean;
  recordCount: number;
  sources: string[]; // which adapter(s) actually contributed
  fetchedAt: string;
  skipped?: boolean; // true when not yet due (no network performed)
  warning?: string;
}

/** A registered backend connector. Each owns its cadence, persistence, and parsing. */
export interface WebSourceConnector {
  id: string;
  label: string;
  /** Refresh cadence in ms (how stale the cache may get before a re-scrape). */
  cadenceMs: number;
  /** Whether this connector should run at all (env gate; default enabled). */
  isEnabled(): boolean;
  /** Re-scrape if the persisted dataset is older than cadenceMs. No-op (skipped) otherwise. */
  refresh(now?: number): Promise<WebSourceRefreshResult>;
}
