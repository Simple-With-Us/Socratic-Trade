import type { AuditFeedItem as DashboardAuditFeedItem, SymbolMeta as DashboardSymbolMeta, UnifiedActivityGroup } from "@/lib/dashboard-feed";
import type { AccountReadiness } from "@/lib/dashboard";
import type { AutonomyHaltCause } from "@/lib/autonomy-halt-cause";
import type { PositionStopPlan } from "@/lib/db";
import type { MacroData } from "@/lib/macro";
import type { MacroDerivedMetrics } from "@/lib/macro-metrics";
import type { MarketSignals } from "@/lib/market-signals";
import type { WeeklyMarketDigest } from "@/lib/weekly-market-digest";
import type { MarketNewsItem } from "@/lib/market-signals/massive";
import type { RedTeamEfficacy, RegimeStat, ThesisStat } from "@/lib/performance";
import type { TaxSummary } from "@/lib/tax";
import type { FmpTranscriptStatus } from "@/lib/web-sources/fmp-transcripts";
import type {
    BrokerageAccount,
    ConnectedAccount,
    EquityOrder,
    EquityPosition,
    MarketScan,
    NotificationEvent,
    PendingProposal,
    PerformanceSummary,
    Portfolio,
    RecentProposal,
    SocraticDecisionCase,
    SocraticFrameworkProposal,
    StrategyProfile,
    StrategyRunRow,
    TradeProposal,
    TradingPolicy, MarketQuote, OptionPosition } from "@/lib/types";
export type { AuditFeedItem, SymbolMeta, UnifiedActivityGroup } from "@/lib/dashboard-feed";

export interface AuditEvent {
  id: string;
  createdAt: string;
  kind: string;
  payload: unknown;
  connectedAccountId?: string;
}

export interface StrategyDecision {
  runId: string;
  createdAt?: string;
  status:
    | "completed"
    | "failed"
    | "skipped"
    | "skipped_budget"
    | "skipped_market_closed"
    | "skipped_broker_unhealthy";
  summary: string;
  proposals: Array<{ id?: string; proposal: TradeProposal; status: string; reasons: string[]; orderId?: string }>;
  marketScan?: MarketScan;
  accountNumber?: string;
}

export interface DashboardSnapshot {
  currentUser?: {
    userId: string;
    email?: string;
    name?: string;
    imageUrl?: string;
    loginProvider?: string;
    isAdmin: boolean;
  };
  /** At least one LLM provider has a resolvable credential for this user (own key OR operator failover).
   *  Gates the two LLM-driven actions (Run once / chat); optional so older payloads default to allowed. */
  llmConfigured?: boolean;
  policy: TradingPolicy;
  strategyPrompt: string;
  accounts: BrokerageAccount[];
  accountReadiness?: AccountReadiness;
  connectedAccounts: ConnectedAccount[];
  /** Per-account run-state projection for the account switcher. `runDuringExtendedHours` is
   *  optional (older payloads predate it): deriveStateInfo treats undefined as "can't know" and
   *  skips the market-open/paused split rather than mislabeling an extended-hours account. */
  connectedAccountPolicies?: Record<
    string,
    Pick<TradingPolicy, "systemState" | "strategyAuthority"> & Partial<Pick<TradingPolicy, "runDuringExtendedHours">>
  >;
  /** Real pending-proposal count per connected account (not just the active one) — the
   *  scheduler runs every connected account independently of which is loaded, so a
   *  non-active account can genuinely have proposals waiting. Keyed by ConnectedAccount.id,
   *  same as connectedAccountPolicies. */
  connectedAccountPendingCounts?: Record<string, number>;
  portfolio?: Portfolio;
  portfolioReadError?: string;
  positions: EquityPosition[];
  options?: OptionPosition[];
  symbolMetaBySymbol: Record<string, DashboardSymbolMeta>;
  /** Per-position stop PLAN (LLM-chosen stop TYPE, persisted at fill time), keyed by symbol — see
   *  StopPlanStyle/position_stop_plans. Absent entry = "default" (account's own precedence). */
  stopPlanBySymbol?: Record<string, PositionStopPlan>;
  livePortfolio?: Portfolio;
  livePositions?: EquityPosition[];
  liveOptions?: OptionPosition[];
  paperPortfolio?: Portfolio;
  paperPositions?: EquityPosition[];
  paperOptions?: OptionPosition[];
  orders: EquityOrder[];
  /** Durable last-known price per order symbol (from the shared symbol_field_latest
   *  store, PR #2503) — the Orders screen's FINAL "Last price" fallback when a symbol
   *  is neither held nor covered by the latest scan. Keyed by normalized symbol; each
   *  entry carries its own as_of so the UI always age-tags it. Optional: older payloads
   *  and empty stores simply omit it ("—" remains the last resort). */
  orderPriceFallbacks?: Record<string, { price: number; asOf: string; source?: string }>;
  /** Raw audit rows are server-only feed input; console clients use auditFeed/unifiedFeed. */
  audit?: AuditEvent[];
  auditFeed: DashboardAuditFeedItem[];
  unifiedFeed: UnifiedActivityGroup[];
  latestStrategyRun?: StrategyDecision;
  latestScan?: MarketScan;
  /** Native weekly value + momentum screens from this account's scan tape. */
  weeklyMarketDigest?: WeeklyMarketDigest;
  dailyStats: { orderCount: number; openingOrderCount: number; notional: number };
  strategyRuns: StrategyRunRow[];
  pendingProposals: PendingProposal[];
  recentProposals?: RecentProposal[];
  scheduler?: { lastRunAt: string | null; nextRunAt: string | null; runsToday?: number };
  webSources?: {
    congress: { enabled: boolean; fetchedAt?: string; recordCount: number; sources: string[]; due: boolean; ttlMs: number };
    insider: { enabled: boolean; fetchedAt?: string; recordCount: number; sources: string[]; due: boolean; ttlMs: number };
    finra?: { enabled: boolean; fetchedAt?: string; recordCount: number; sources: string[]; due: boolean; ttlMs: number; asOf?: string };
    sec8k?: { enabled: boolean; fetchedAt?: string; recordCount: number; sources: string[]; due: boolean; ttlMs: number };
    earningsTranscripts?: FmpTranscriptStatus;
    technical?: { enabled: boolean; source: "tradingview" | "computed"; fetchedAt?: string; recordCount: number; due: boolean; ttlMs: number; secretConfigured: boolean };
    thirteenF?: { enabled: boolean; fetchedAt?: string; recordCount: number; sources: string[]; due: boolean; ttlMs: number };
    ark?: { enabled: boolean; fetchedAt?: string; recordCount: number; sources: string[]; due: boolean; ttlMs: number; asOf?: string };
  };
  smartMoney?: {
    congress: Array<{ symbol: string; member: string; chamber: string; side: "buy" | "sell"; amountLow?: number; amountHigh?: number; tradedAt: string; disclosedAt?: string }>;
    insider: Array<{ symbol: string; owner: string; buyTx: number; sellTx: number; filedAt: string }>;
    thirteenF?: Array<{ ticker: string; filerName: string; periodEnd: string; shares: number; valueUsd: number }>;
    ark?: Array<{ ticker: string; fund: string; asOf: string; weightPct: number; shares: number }>;
    /** Cached congress-score go/no-go verdict (pass/fail + stats); null when never evaluated.
     *  Nested here alongside the other smart-money congress data to match the server payload
     *  (src/lib/dashboard.ts). */
    congressScoreVerdict?: import("@/lib/congress-score-gate").CongressScoreVerdictRead | null;
  };
  marketSession?: string;
  /** Backend macro/market-regime board (FRED macro + derived metrics + free market-wide signals). */
  macroBoard?: {
    macro: MacroData;
    derived: MacroDerivedMetrics;
    signals: MarketSignals;
    regime: string;
    /** Trailing ~90-day daily histories for sparklines (keyed: tenY, twoY, vix, hyCreditSpread, usd, wti). */
    history?: Record<string, number[]>;
    /** Recent market-wide news headlines (Massive). */
    news?: MarketNewsItem[];
  };
  performance?: PerformanceSummary;
  redTeamEfficacy?: RedTeamEfficacy & {
    /** Opening Bear vetoes routed to the Socratic override path. */
    overrideVetoes: number;
    /** Opening Bear vetoes whose Socratic override actually applied. */
    appliedOverrideVetoes: number;
    /** Blocking vetoes + override-path vetoes; survived Red Team reviews are not persisted here. */
    vetoDecisions: number;
    /** appliedOverrideVetoes / vetoDecisions (%), 0 when no veto decisions exist. */
    overrideSharePct: number;
    /** #2552: aggregate critic health — failed reviews / attempted reviews across the user's
     *  proposals in the trailing window (user-wide; a model/config condition, not an account one). */
    criticFailure?: {
      windowDays: number;
      reviews: number;
      failures: number;
      failureRatePct: number;
      byKind: Record<string, number>;
      topFailure?: { model?: string; kind: string; count: number };
    };
  };
  thesisScorecard?: ThesisStat[];
  regimeScorecard?: RegimeStat[];
  tax?: TaxSummary;
  profiles: StrategyProfile[];
  activeProfile?: StrategyProfile;
  notifications: NotificationEvent[];
  notificationStatus: {
    configured: boolean;
    enabledEvents: string[];
  };
  /** True when activeBroker is not Robinhood, or when it is and an OAuth token is stored. */
  robinhoodMcpConnected: boolean;
  /** Per-user setting: when true, accounts left in "active" state auto-resume on server boot. */
  autoResumeOnBoot: boolean;
  /** Why the viewed account is halted and whether it starts again by itself (lane h5).  null when
   *  it is not halted; optional so older payloads and test fixtures stay valid. */
  haltCause?: AutonomyHaltCause | null;
  socratic?: {
    decisions: SocraticDecisionCase[];
    frameworkProposals: SocraticFrameworkProposal[];
  };
}

export type SortDir = "asc" | "desc";
export type PolicyPatch = Partial<TradingPolicy> & { strategyPrompt?: string };
export type RobinhoodMcpHealth = {
      adapter?: "mcp";
      ok: boolean;
      configured: boolean;
      authenticated: boolean;
      url?: string;
      protocolVersion?: string;
      transport?: string;
      tools: string[];
      checkedAt: string;
      error?: string;
      warning?: string;
    };
export type ScanColumn = {
      id: string;
      label: string;
      title: string; // rich header tooltip: acronym expansion + methodology + source
      align?: "right";
      defaultHidden?: boolean;
      /** Sort by a raw quote field… */
      sortKey?: keyof MarketQuote;
      /** …or by a computed value (for backend-derived columns not stored on the quote). */
      sortValue?: (q: MarketQuote) => number | string | undefined;
      render: (q: MarketQuote) => React.ReactNode;
      cellClass?: (q: MarketQuote) => string;
      cellTitle?: (q: MarketQuote) => string | undefined;
    };
export type ApiKeyStatus = {
      service: string;
      label: string;
      category: string;
      required: boolean;
      unlocks: string;
      docsUrl?: string;
      envVar?: string;
      configured: boolean;
      source: "user" | "env" | "none";
      updatedAt?: string;
    };
