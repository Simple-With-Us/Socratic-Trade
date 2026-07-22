import type { AuditFeedItem as DashboardAuditFeedItem, SymbolMeta as DashboardSymbolMeta, UnifiedActivityGroup } from "@/lib/dashboard-feed";
import type { AccountReadiness } from "@/lib/dashboard";
import type { PositionStopPlan } from "@/lib/db";
import type { MacroData } from "@/lib/macro";
import type { MacroDerivedMetrics } from "@/lib/macro-metrics";
import type { MarketSignals } from "@/lib/market-signals";
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
  status: "completed" | "failed" | "skipped";
  summary: string;
  proposals: Array<{ proposal: TradeProposal; status: string; reasons: string[]; orderId?: string }>;
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
  portfolio?: Portfolio;
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
  audit: AuditEvent[];
  auditFeed: DashboardAuditFeedItem[];
  unifiedFeed: UnifiedActivityGroup[];
  latestStrategyRun?: StrategyDecision;
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
  };
  smartMoney?: {
    congress: Array<{ symbol: string; member: string; chamber: string; side: "buy" | "sell"; amountLow?: number; amountHigh?: number; tradedAt: string; disclosedAt?: string }>;
    insider: Array<{ symbol: string; owner: string; buyTx: number; sellTx: number; filedAt: string }>;
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
