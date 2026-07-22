import type { DerivedMetrics } from "./derived-metrics";
import type { FieldObservation, ProviderFailureReceipt } from "./evidence-facts";

export class OrderValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrderValidationError";
  }
}
export type OrderSide = "buy" | "sell" | "short" | "cover";
export type OrderType = "market" | "limit" | "stop_market" | "stop_limit";
export type TimeInForce = "gfd" | "gtc";
export type MarketHours = "regular_hours" | "extended_hours" | "all_day_hours";
export type IndexUniverse =
  | "sp100"
  | "sp500"
  | "nasdaq100"
  | "nasdaqComposite"
  | "dow30"
  | "russell2000"
  | "nyseComposite"
  | "ftWilshire5000";
export type SystemState = "active" | "halted" | "close_only" | "liquidating";
export type StrategyAuthority = "propose" | "decide";

// Sell-to-fund-buy (PR 3): when a run's intended BUYs exceed buying power, how to raise cash by
// trimming holdings. "off" (default) = never, behavior unchanged. "suggest" = surface the plan only.
// "propose" = queue the funding sells for human approval. "automated" = let them execute under the
// account's existing authority (auto-placed only when the account is already in "decide" mode).
export type SellToFundBuyMode = "off" | "suggest" | "propose" | "automated";

export type LlmReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
/** Intended holding horizon — shapes the agent's setup selection, exit timing, and tax awareness. */
export type HoldingHorizon = "intraday" | "swing" | "position" | "longterm";
export type FillSource = "live" | "paper";
export type ExecutionMode = "broker/paper" | "broker/live";
/**
 * The LLM's chosen per-position stop-loss TYPE (distinct from `TradeProposal.bracketStopLoss`,
 * which is a per-trade stop PRICE). "default" (or the field absent) defers entirely to the
 * account's own precedence (ATR → beta-scaled → flat, plus trailing if configured) — no behavior
 * change from before this field existed. "fixed"/"atr" PIN this position to that one distance rule
 * (skipping the account's other rules for this symbol only) rather than letting the account's
 * ATR/beta toggles decide; "atr" falls back to the flat base % when bars are unavailable for the
 * symbol, same honesty as the account-wide ATR fallback. "trailing" makes this position's ONLY
 * per-position stop a trail (skipping the fixed/ATR proactive exit), using the account's configured
 * trailingStopPct, or — if the account hasn't set one — this position's own effective stop distance
 * as the trail %. "none" is a genuine, owner-preference no-stop choice (real trading, owner's risk —
 * never hard-blocked) and is never silent: it requires a rationale and is surfaced loudly wherever
 * this position's protection is shown.
 */
export type StopPlanStyle = "default" | "fixed" | "atr" | "trailing" | "none";
export const STOP_PLAN_STYLES: readonly StopPlanStyle[] = ["default", "fixed", "atr", "trailing", "none"];
export interface StopPlan {
  style: StopPlanStyle;
  /** Required when style is "none" — the LLM's justification for carrying no stop, shown wherever
   *  this position's protection is displayed. Optional for every other style. */
  rationale?: string;
}
/**
 * Shared fallback stop-loss distance (%) for a per-position "fixed"/"atr" plan (or the trail % for
 * a "trailing" plan) when the account's own configured distance is 0/unset — so a per-position plan
 * is genuinely usable even on an account that otherwise runs with no stop-loss configured at all
 * (universal-availability requirement). Shared across strategy.ts, synthetic-stops.ts, and
 * broker-protective-stops.ts so the same position never sees a different fallback depending on
 * which enforcement layer is evaluating it.
 */
export const STOP_PLAN_FALLBACK_STOP_PCT = 8;
export const NOTIFICATION_EVENT_TYPES = [
  "fill",
  "block",
  "run_failed",
  "pending_approval",
  "kill_switch",
  "price_alert",
  "proposal_withdrawn",
  "limit_order_stale",
  "provider_degraded",
  "budget_alert",
  "learning_review",
  "deterministic_bear_veto",
  "red_team_veto_override_requested",
  "red_team_veto_overridden",
  "prompt_injection_suspected",
  "evidence_age_anomaly",
  "storage_warning",
  "autonomy_halted_on_boot",
  "option_alert"
] as const;
export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];
export type PriceAlertOp = "<" | ">";
export type PriceAlertStatus = "armed" | "triggered";

export interface PriceAlert {
  id: string;
  userId: string;
  symbol: string;
  op: PriceAlertOp;
  price: number;
  note: string;
  status: PriceAlertStatus;
  createdAt: string;
  triggeredAt: string | null;
  triggeredPrice: number | null;
}

export interface WatchlistItem {
  symbol: string;
  addedAt: string;
}
export type NotificationStatus = "sent" | "failed" | "skipped";
/** Direction of a bar-based technical read (TradingView push or in-house computed). */
export type TechnicalDirection = "bullish" | "bearish" | "neutral";

export interface ScoringWeights {
  liquidity: number;
  momentum: number;
  value: number;
  quality: number;
  volatility: number;
  sentiment: number;
  /** Smart-money positioning: congressional net buying, insider buying, short-squeeze potential. */
  positioning: number;
  diversification: number;
}

/** US tax-mitigation settings (estimates only — not tax advice). */
/**
 * Tax treatment of an account. IRAs (Roth/Traditional) are tax-sheltered: there is no annual
 * capital-gains tax, and the IRC §1091 wash-sale lockout does not apply WITHIN a single IRA
 * (a wash sale has no benefit there). A loss realized in a TAXABLE account, however, still locks
 * rebuys of that symbol across ALL of the user's accounts — including the IRAs — for 30 days,
 * because buying the replacement in the IRA permanently destroys the disallowed basis.
 */
export type TaxationType = "taxable" | "roth_ira" | "traditional_ira";

/**
 * What a brokerage account can actually do. Populated from the broker API on
 * connect and stored as a JSON blob alongside the account row. Every boolean
 * field defaults to false so legacy/unpopulated rows are never accidentally
 * granted a capability the broker hasn't confirmed.
 *
 * Future asset classes (futures, crypto) are included here so policy checks
 * can reference capabilities.futuresTrading without a later schema change —
 * they will simply read false until the broker gateway sets them.
 */
export interface AccountCapabilities {
  /** Equity (stock/ETF) buying and selling. True for all current brokers. */
  equityTrading: boolean;
  /**
   * Equity short selling (borrowing shares to sell).
   * Robinhood MCP: always false — the MCP's review_equity_order explicitly
   * prohibits short sells. Alpaca: parsed from account.shorting_enabled.
   */
  shortSelling: boolean;
  /** Options contracts allowed at all. */
  optionsTrading: boolean;
  /**
   * CBOE/broker options approval tier:
   *   0 = none  1 = covered calls + cash-secured puts
   *   2 = long calls/puts  3 = spreads/straddles  4 = naked/uncovered
   * Undefined when optionsTrading is false or the broker does not report a level.
   */
  optionsLevel?: 0 | 1 | 2 | 3 | 4;
  /** Futures/commodities contracts. Not supported by any current broker. */
  futuresTrading: boolean;
  /**
   * Cryptocurrency spot trading. Not supported by current stock brokers.
   * Reserved for future crypto-exchange connections — wire a crypto gateway
   * and set this true there; stock brokers remain false.
   */
  cryptoTrading: boolean;
  /** Whether the account has margin (borrowing) enabled. */
  marginEnabled: boolean;
  /** Broker's required maintenance margin percentage (e.g. 25 = 25%). */
  marginRequirementPct?: number;
  /**
   * Account structure, which determines the applicable tax regime:
   *   "brokerage"       → standard taxable account
   *   "traditional_ira" → tax-deferred (contributions pre-tax; withdrawals taxed as income)
   *   "roth_ira"        → tax-free growth (contributions post-tax; qualified withdrawals free)
   *   "crypto_exchange" → crypto-only venue; taxable but no equity trading
   * For new accounts this supersedes the separate taxationType field on ConnectedAccount.
   */
  accountType: "brokerage" | "traditional_ira" | "roth_ira" | "crypto_exchange";
}

/**
 * What a wash-sale lockout MEANS for a BUY in a taxable account (taxSettings.washSaleHandling):
 *   - "block": the buy is refused outright — the original hard-stop behavior. A stricter opt-in;
 *              no longer the default (owner decision 2026-07-03 — see defaults.ts).
 *   - "ask":   the buy becomes a PENDING-APPROVAL card (in both propose and decide authority)
 *              priced with the estimated forfeited deduction; the owner decides.
 *   - "auto":  (DEFAULT) the buy ALWAYS proceeds. Historically this mode vetoed the buy unless a
 *              deterministic expected-edge calculation cleared a fixed multiple of the priced tax
 *              cost; the owner rejected that as pseudo-math (the "edge" side of the comparison was
 *              itself derived from the LLM's own confidenceScore/bracketTakeProfit outputs, so it
 *              wasn't an independent check). The priced tax cost is still real information — it
 *              rides decision.washSale as receipt telemetry and is threaded into the strategist
 *              prompt (taxContext.washSaleRebuyCosts) so the model weighs it against conviction
 *              itself. Never silent; never a hard block by default.
 * The IRA-replacement rule (Rev. Rul. 2008-5) is governed SEPARATELY by
 * taxSettings.iraWashSaleHandling: an IRA buying a symbol locked by a taxable-account loss
 * defaults to "disregard" (see IraWashSaleHandling) for the same reason — the owner may still
 * opt an account into the stricter "block".
 */
export type WashSaleHandling = "block" | "ask" | "auto";

/**
 * What an IRA-replacement wash sale MEANS for a BUY in an IRA (taxSettings.iraWashSaleHandling):
 *   - "block": the buy is refused outright in EVERY washSaleHandling mode — Rev. Rul.
 *     2008-5: buying the replacement inside the IRA permanently destroys the disallowed loss,
 *     with no basis adjustment ever recoverable. A stricter per-account opt-in; no longer the
 *     default.
 *   - "disregard": (DEFAULT) the buy proceeds through the normal authority flow (all other gates
 *     unchanged). Rationale (owner decision 2026-07-03): brokers do not report cross-account IRA
 *     wash sales to the IRS — the rule only bites under audit — so respecting it is the account
 *     owner's call, not a hard system stop. NEVER silent: the decision carries outcome
 *     "ira_disregarded" with the verbatim annotation "Wash Sale (Technically, but IRA purchase
 *     unreported to IRS)" plus the priced lock provenance, an audit event fires, and the note
 *     renders wherever the purchase shows. This is still an explicit audit-risk acceptance —
 *     the transparency machinery is unchanged, only the default toggle position.
 */
export type IraWashSaleHandling = "block" | "disregard";

export interface TaxSettings {
  /** Tax treatment driving rates + wash-sale handling. Defaults to "taxable". */
  taxationType?: TaxationType;
  /** Block the agent from rebuying a symbol it closed at a loss within 30 days (IRC §1091). */
  washSaleGuard: boolean;
  /** How a wash-sale lockout is handled for BUYs. Default "auto" (see WashSaleHandling). */
  washSaleHandling?: WashSaleHandling;
  /** How an IRA-replacement wash sale is handled. Default "disregard" (see IraWashSaleHandling). */
  iraWashSaleHandling?: IraWashSaleHandling;
  /**
   * Optional floor (dollars) for a realized loss to trigger the wash-sale rebuy lockout.
   * Losses smaller than this are ignored when building the 30-day locked-symbol set, so a
   * trivial loss doesn't freeze a symbol for a month. Default undefined = every loss locks
   * (current behavior). This changes only THIS APP's guardrail — the IRS still applies
   * §1091 to any size of loss; the disallowed-loss REPORTING here is unaffected.
   */
  washSaleMinLossUsd?: number;
  /** Marginal rate applied to short-term realized gains (ordinary income), e.g. 24. */
  shortTermRatePct: number;
  /** Marginal rate applied to long-term realized gains, e.g. 15. */
  longTermRatePct: number;
  /** When true, the Performance view shows realized P&L net of the estimated tax burden. */
  subtractFromResults?: boolean;
}

/** Tunable constants that are otherwise arbitrary code-level defaults. */
export interface TuningSettings {
  /** Bayesian shrinkage pseudo-count for small-sample win/return toward a neutral prior. Default 5. */
  shrinkPrior?: number;
  /** Minimum closed lots before the auto-tuner may shift factor weights (phase-7 §3.E). Default 20. */
  minClosedLotsForWeightShift?: number;
  /** Minimum % of max order notional the deterministic sizer will ever allocate. Default 10. */
  sizingFloorPct?: number;
  /** Maximum % of max order notional the deterministic sizer will ever allocate. Default 100. */
  sizingCeilingPct?: number;
  // `redTeamConvictionThreshold` and `redTeamNotionalPctOfNavThreshold` were REMOVED 2026-07-07
  // (single-adversary consolidation, decision O2): the Red Team review now runs on EVERY risk-adding
  // opening — coverage is structural, not conviction/stakes-gated — so both trigger thresholds (and
  // `shouldRunRedTeamDebate`) are gone. Stale values in persisted tuning JSON are simply ignored.
  /** Optional max opening order notional as % of portfolio in crisis/inverted regimes. Undefined or <=0 disables. */
  crisisMaxOpeningExposurePct?: number;
  /**
   * Max value AI confidence may contribute to the conviction sizing multiplier (0–1) when the
   * thesis's realized edge does NOT corroborate it. Caps only the UPSIDE — low confidence still
   * shrinks size fully. Default 0.6. Prevents an inflated confidenceScore from sizing up a
   * proven-but-mediocre thesis on AI conviction alone. (Reads only realized scorecard stats +
   * the proposal's own confidenceScore — never learned_context.)
   */
  convictionCapUncorroborated?: number;
  /** Shrunk realized win rate (%) at/above which conviction is treated as corroborated (cap lifts). Default 58. */
  corroborationWinRatePct?: number;
  /** Shrunk realized avg return (%) strictly above which conviction is treated as corroborated. Default 0. */
  corroborationEdgePct?: number;
  /**
   * Deterministic fundamentals hard-veto on BUYS, applied model-free in deterministicBearFilter
   * (independent of the Bull/Bear LLMs). Veto a buy when the candidate's free-cash-flow yield is
   * below this floor (e.g. 0 → veto any negative-FCF-yield buy). Undefined disables the rule. The
   * rule is skipped when fcfYield is unavailable so a missing field never false-vetoes.
   */
  bearVetoFcfYieldFloorPct?: number;
  /**
   * Companion fundamentals hard-veto: veto a buy when the candidate's debt/equity exceeds this
   * ceiling (e.g. 3 → veto names levered beyond 300%). Undefined disables; skipped when the field
   * is unavailable.
   */
  bearVetoDebtToEquityCeiling?: number;
  /**
   * Buffer (basis points) used when policy.marketableLimitEntries converts a deterministic OPENING
   * market order into a marketable limit: the limit is priced through the quote by this much (above
   * the ask for buys, below the bid for shorts) so it still fills promptly but can't chase an
   * arbitrarily bad print in a fast tape. Default 15 bps.
   */
  marketableLimitBufferBps?: number;
  /**
   * OPTIONAL negative-expectancy skip gate (default OFF). When true, a deterministic opening
   * proposal is SKIPPED entirely (not opened) if its thesis is PROVEN (≥ minClosedLotsForWeightShift
   * closed lots) AND its shrunk realized avg edge — already net of the paper cost model — is at or
   * below `skipNegativeExpectancyEdgePct`. Off by default on purpose: the normal sizer DOWNSIZES
   * such theses to the exploratory floor rather than skipping, which keeps gathering data; this gate
   * is the more conservative "don't open a proven money-loser" stance for operators who want it.
   * UNPROVEN theses are never skipped by this gate (their floor sizing is intentional exploration).
   */
  skipNegativeExpectancy?: boolean;
  /** Edge threshold (%) for skipNegativeExpectancy: skip when shrunk avg edge ≤ this. Default 0. */
  skipNegativeExpectancyEdgePct?: number;
  /**
   * Default OFF. When true, a run whose proposal rationales COLLAPSE to near-identical reasoning
   * (mean pairwise trigram similarity above the collapse threshold — a sign the LLM is emitting
   * input-agnostic boilerplate rather than name-specific analysis) has its OPENING proposals
   * (buy/short) routed to human review instead of auto-executing. Exits (sell/cover) are never gated
   * — routing a risk-reducing trade to a human is unsafe. Off = today's advisory-only behavior
   * (the collapse is logged but never affects proposal generation, selection, or execution).
   */
  gateOnRationaleCollapse?: boolean;
  /**
   * When true (DEFAULT), proposed factor-weight changes are WITHHELD (stripped from the patch)
   * whenever the OOS walk-forward gate could not validate them (data-fetch failure, insufficient
   * snapshot history, or missing composite IC). When false, the prior behavior is restored:
   * weights are kept as proposed with a "NOT out-of-sample validated" caution. Default true is
   * strictly more conservative — it only ever REMOVES unjustified weight moves, never adds one.
   */
  oosWithholdUnvalidated?: boolean;
  /**
   * OPT-IN (DEFAULT false): when true, the tuner's compacted performance context surfaces per-run
   * ENTRY-run P&L credit (realizedPnlAsEntry) in addition to the existing exit-keyed attribution.
   * Pure context/advisory data for the LLM; it does NOT alter sizing or weight math. Off by default
   * so tuning input is byte-for-byte unchanged unless an operator opts in.
   */
  useEntryRunAttribution?: boolean;
  /**
   * Minimum scan score (0–100) a candidate must have to be sent to the LLM for proposal generation.
   * Candidates below this threshold are dropped before the LLM sees them. If ALL candidates are below
   * the threshold, the LLM call is skipped entirely and an audit event is emitted.
   * Default 0 (unfiltered — preserves current behavior). Exposed in Settings → Tuning.
   */
  minProposalScoreThreshold?: number;
  /**
   * Hard per-user/day LLM + RAG TOKEN ceiling. When today's summed model + retrieval usage reaches
   * this, the run skips every model/RAG spend for the rest of the day (non-LLM risk maintenance still
   * runs). `undefined` (blank in the UI) INHERITS the operator env default
   * `TRIGGER_LLM_DAILY_TOKEN_BUDGET`; an explicit `0` means NO LIMIT (opt out of the default); a
   * positive value is that ceiling. Modifiable in Settings → Tuning. Enforced at the spend primitives
   * (`withLlmGeneration`, `retrieveContextDetailed`), so it covers every spend site.
   */
  llmDailyTokenBudget?: number;
  /**
   * Hard per-user/day LLM + RAG COST ceiling in USD (estimated). Same semantics as
   * `llmDailyTokenBudget`: `undefined` inherits env `TRIGGER_LLM_DAILY_COST_BUDGET_USD`, `0` = no limit.
   */
  llmDailyCostBudgetUsd?: number;

  // ── Workstream B: learning-loop auto-tuning (all DEFAULT OFF) ──────────────────
  /**
   * OPT-IN (DEFAULT false): when true, a cadence-gated caller may AUTONOMOUSLY apply the
   * auto-tuner's proposed factor-weight changes — but ONLY after the existing OOS walk-forward
   * gate passes, every delta is clamped to MAX_WEIGHT_STEP, and a previous-weights snapshot is
   * stored (audit kind "auto_weight_apply") so a revert can restore the prior vector. Off by
   * default: today the tuner only ever feeds a manual proposal / read-only route, so default
   * behavior is byte-identical. Never applies weights when the OOS gate strips them.
   */
  autoApplyWeights?: boolean;
  /**
   * OPT-IN (DEFAULT 0 = current strict `>` behavior, panel P0-2): minimum OOS composite IC improvement
   * (candidate − baseline) the autonomous apply path requires BEFORE the paired-t significance test. A
   * flat margin alone is the floor; the paired-t (computed from the per-date IC-difference series) is the
   * correct form and is ALSO required. 0 keeps today's behavior (the existing env `AUTO_TUNE_MIN_IC_DELTA`
   * still supplies a small default margin); a positive value tightens the margin. Surfaced as an audited
   * no-op when it silently blocks autonomy.
   */
  minOosICImprovement?: number;
  /**
   * OPT-IN (DEFAULT 0 = paired-t OFF, panel P0-2): minimum PAIRED t-statistic on the per-date
   * candidate-vs-baseline IC-difference series that the autonomous apply path requires. 0 disables the
   * significance test entirely (byte-identical to pre-P0-2 autonomy); a positive value (e.g. 1.5–2.0)
   * requires the candidate's OOS edge to be statistically distinguishable from the baseline on the shared
   * fold, not merely a point-estimate margin. Defaults to a no-op so nothing changes unless an operator
   * opts in.
   */
  minOosPairedTStat?: number;
  /**
   * ESCAPE HATCH (DEFAULT false, panel P0-3): explicitly allow `autoApplyWeights` to run even when
   * `oosWithholdUnvalidated` is false. Without this override the fail-closed invariant guard SKIPS the
   * autonomous apply (it must not run while unvalidated weight moves are kept). Set this only if you
   * deliberately want autonomy under a permissive OOS-withhold posture.
   */
  autoApplyOverrideUnvalidated?: boolean;
  /**
   * OPT-IN (DEFAULT false): when true, the scan composite gates the congressional contribution on
   * the congress-score-eval go/no-go verdict — a "no-go" signal (below the eval's t-stat / marginal-IC
   * thresholds) no longer lifts a name into the candidate set or up the composite. Off by default:
   * the congress term is applied unconditionally today, so default scans are unchanged.
   */
  congressGoNoGoGating?: boolean;
  /**
   * OPT-IN (DEFAULT false): when true, matured missed-opportunity evidence (skipped names that beat
   * the benchmark) produces a small, clamped, audited per-factor nudge into the scan composite weights
   * used for THIS run's scoring, subject to the sample gate. Off by default: today these stats only
   * feed the manual tuning proposal, so default scan scoring is unchanged.
   */
  missedOpportunityNudge?: boolean;
  /**
   * Minimum count of benchmark-beating missed winners a single dominant factor must recur across before
   * `summarizeMissedOpportunities` flags it as a recurring factor. Default 2 (current behavior). Item-4
   * hardening raises this to 5 via the benchmark-relative path when `benchmarkRelativeMisses` is on.
   */
  recurringFactorMinCount?: number;
  /**
   * OPT-IN (DEFAULT false): when true, a skipped name only counts as a "missed winner" if it beat SPY
   * over the same horizon (return minus the SPY return), not merely returnPct > 0, and the recurring-factor
   * threshold is raised to `recurringFactorMinCount` (>= 5 recommended). Off by default: the winner test
   * stays `returnPct > 0` with no market adjustment, so default missed-opportunity stats are unchanged.
   */
  benchmarkRelativeMisses?: boolean;
  /**
   * OPT-IN (DEFAULT false): when true, the deterministic sizer remaps the proposal's confidenceScore
   * through the account's realized confidence-calibration curve BEFORE it becomes the conviction sizing
   * multiplier — a poorly-calibrated high-confidence band is sized down toward its realized win rate. Off
   * by default: the sizer uses the raw confidenceScore/100 exactly as today. Still respects the existing
   * convictionCapUncorroborated cap.
   */
  calibrationSizing?: boolean;
  /**
   * OPT-IN (DEFAULT false): when true AND per-regime sample sizes are sufficient, regime-conditioned
   * factor-weight vectors (keyed off determineMarketRegime) are applied in scan scoring. Off by default;
   * when the per-regime sample is too thin, the app produces only the admin-side per-regime IC report and
   * leaves application off regardless of this flag.
   */
  perRegimeWeights?: boolean;

  // ── Broader backlog (Chat B, 2026-07-01) — all DEFAULT OFF / no-op ─────────────
  /**
   * OPT-IN (DEFAULT false, panel P1-2): when true, `runWalkForwardOOS`'s chronological train/test split
   * additionally PURGES train rows whose forward-return window `[date, date+horizonDays]` overlaps the first
   * test date (they share realized bars with the test fold → leakage that inflates OOS IC). The embargo of
   * `horizonDays` snapshot-date buckets after the boundary is applied EITHER way (it predates this flag); this
   * flag only adds the purge. Off by default → the split is byte-identical to today (embargo only, no purge).
   */
  oosPurgeEmbargo?: boolean;
  /**
   * OPT-IN (DEFAULT false, panel P1-3): when true, each autonomous-tuning EVALUATION records a SHADOW ledger
   * row — what the tuner WOULD have applied and the OOS readout — WITHOUT applying it (never touches policy).
   * A forward-A/B audit trail so an operator can watch the tuner's decisions accrue before trusting autonomy.
   * Off by default → no shadow rows are written. Independent of `autoApplyWeights` (works whether or not real
   * auto-apply is on); when both are on, a real apply is recorded in the ledger as usual and no duplicate
   * shadow row is written for that same evaluation.
   */
  shadowWeightLedger?: boolean;
  /**
   * OPT-IN (DEFAULT false, panel P2-1): when true, `summarizeMissedOpportunities` only flags a recurring
   * factor when, among ALL matured skipped candidates (winners AND losers), that factor's benchmark-beating
   * hit rate — SHRUNK toward the overall skipped hit rate — clears the base rate with a minimum denominator.
   * Off by default → recurring-factor flagging uses the winners-only count exactly as today. Sequence AFTER
   * `benchmarkRelativeMisses` (it reuses the same benchmark-relative winner test).
   */
  missedOpportunityRequireHitRate?: boolean;
  /**
   * OPT-IN (DEFAULT false, panel P2-3): when true AND `congressGoNoGoGating` is on, the congress go/no-go
   * verdict additionally requires the TOP score bucket's own excess return (over the bottom bucket) to be
   * positive with a minimum observation floor before it may PASS. A symmetric top-minus-bottom spread whose
   * edge lives entirely in the (unused) short leg no longer promotes a long-biased congress signal. Off by
   * default and inert unless the congress gate is evaluated → default verdicts are unchanged.
   */
  congressRequireTopBucketPositive?: boolean;
  /**
   * OPT-IN (DEFAULT 0 = no shrinkage, panel P2-4): shrinkage λ (0–1) applied when the OOS harness derives
   * weights from ICs — `w_final = λ·w_IC + (1−λ)·w_default`. 0 keeps today's pure-IC derivation (byte-
   * identical); a positive λ pulls the derived vector toward `DEFAULT_SCORING_WEIGHTS`, damping a single
   * high-IC factor on a thin fold. Applied BEFORE the MAX_WEIGHT_STEP clamp on the apply path.
   */
  icWeightShrinkage?: number;
  /**
   * OPT-IN (DEFAULT false, panel P2-5): when true (and `autoApplyWeights` is on), the autonomous apply is
   * BLOCKED when the candidate's OOS max-drawdown exceeds the baseline's beyond a small tolerance — but only
   * when the OOS test fold has at least `minOosTestDates` (or the panel's floor) distinct dates; below that,
   * the drawdown guard is skipped and the IC/paired-t gate governs alone. Off by default → autonomy is
   * governed purely by the IC + paired-t gate as today.
   */
  autoApplyDrawdownGuard?: boolean;
  /**
   * OPT-IN (DEFAULT 0 = OFF, panel P2-6): minimum number of DISTINCT OOS test-fold dates the autonomous apply
   * path requires before it may persist (a starvation guard so a thin fixed 500-row window that spans only a
   * few dates can't pass the gate). 0 keeps the existing behavior (the env `AUTO_TUNE_MIN_TEST_DATES`, default
   * 4, still supplies a floor). A positive value raises the distinct-test-date floor above that env default.
   */
  minOosTestDates?: number;
  /**
   * VESTIGIAL since the 2026-07-07 single-adversary consolidation (§3.5): exits (sell/cover) and
   * net-risk-reducing trades are now STRUCTURALLY exempt from the Red Team review — they can never
   * be debate-unavailable because they are never debated — so this opt-in no longer has a
   * production call site (`routeOnAdversaryUnavailable` still honors it as a pure function). Kept
   * (rather than deleted) so persisted tuning JSON round-trips unchanged; it may be removed once
   * the consolidation has soaked.
   */
  deRiskExitsOnAdversaryUnavailable?: boolean;
  /**
   * OPT-IN (DEFAULT false): when true, the multi-signal regime severity scorer (src/lib/regime-severity.ts,
   * Lane 5) is computed and (a) surfaced as a compact `regimeSeverity` block in the Bull/Bear prompt
   * userContent next to `currentMarketRegime`, (b) stamped as `entryRegimeSeverity` on persisted
   * TradeProposals, and (c) included as `severityMacroOnly` in the `regime_flip` audit payload. Default
   * false: default behavior is byte-identical — the scorer is not invoked, no regimeSeverity block is
   * added to any prompt, no entryRegimeSeverity field is stamped, and no severityMacroOnly key is added
   * to the regime_flip audit event. Purely a new advisory/receipt channel — does NOT change any cap/gate
   * behavior (crisis cap, bear filter, escalation trigger) either on or off.
   */
  regimeSeverityScoring?: boolean;
  /**
   * OPT-IN (DEFAULT false): when true, each OPENING proposal gets two additional advisory receipts
   * appended to its rationale (+ matching audit events) — a per-candidate correlation profile
   * (pearson/EWMA/downside correlation vs current holdings) and a pre-trade parametric stress
   * scenario (book impact under a -shockSigmas market shock, with and without the candidate). Both
   * require extra fetchDailyOHLC bar fetches per candidate (correlation) or reuse quote betas (stress,
   * free). Off by default: no extra data fetches, and prompts/rationale/audit trail are BYTE-IDENTICAL
   * to today. One flag covers both since they're the two halves of the same "risk receipts" feature
   * and share the same cost-bounding rationale. Never blocks/drops/modifies a proposal — receipts only.
   */
  riskReceipts?: boolean;
  /**
   * OPT-IN (DEFAULT false): when true AND the candidate's `daysToEarnings` is at/below
   * `earningsBlackoutDays`, the OPENING proposal is TAGGED with an overridable
   * `earnings_blackout: …` preVetoReasons entry (folds into the sized PolicyDecision exactly like the
   * deterministic-bear/red-team pre-vetoes — see PR #814's `preVetoReasons` pattern) instead of being
   * silently allowed through. `isHardGateReason` classifies it as a preference, so an agent-authored
   * `autonomyOverride` thesis can still pass it (subject to socraticOverrideMode). Off by default: the
   * advisory rationale note (see `earningsBlackoutDays` doc) still appears whenever daysToEarnings is
   * known and small, but no proposal is tagged/blocked unless this is on. Never affects proposals whose
   * `daysToEarnings` is unknown (Yahoo returned no future earnings date) — skipped silently, never
   * fabricated to 0.
   */
  earningsBlackout?: boolean;
  /**
   * Trading-day window (default 3 when `earningsBlackout` is enabled) at/below which an opening is
   * inside the advisory earnings blackout. Independent of the flag: an informational
   * "Earnings in N trading day(s)" rationale note is appended whenever daysToEarnings <= 7 REGARDLESS
   * of `earningsBlackout`; only the preVetoReasons TAG (and the "inside advisory blackout window"
   * phrase) depends on the flag being on and `daysToEarnings <= earningsBlackoutDays`.
   */
  earningsBlackoutDays?: number;
  /**
   * OPT-IN (DEFAULT false): when true, the deterministic sizer additionally computes a
   * fractional-Kelly suggestion from the thesis bucket's realized win/loss payoff split
   * (avgWinPct/avgLossPct) and downside-dispersion penalty (downsideDeviationPct), and — ONLY
   * when the suggestion is STRICTLY SMALLER than the existing sizing multiplier — reduces the
   * final size to the Kelly suggestion. Kelly can only shrink size vs today, never grow it
   * (advisory taper, not a booster). Off by default: a rationale receipt is still appended
   * whenever the bucket has enough closed lots and a computable payoff ratio (informational
   * only), but the size itself is byte-identical to today unless this flag is on.
   */
  fractionalKellySizing?: boolean;
  /**
   * Fraction of full Kelly used by the fractional-Kelly sizing suggestion (0.5 = "half-Kelly",
   * the conventional conservative default — full Kelly is notoriously volatile in practice).
   * Default 0.5. Only meaningful when `fractionalKellySizing` is on, or informationally in the
   * always-on rationale receipt.
   */
  kellyFraction?: number;

  // ── Volatility-targeting sizing + portfolio-heat budget (continuous taper, advisory) ──────────
  /**
   * OPT-IN (DEFAULT false): when true, the deterministic sizer additionally tapers an OPENING
   * proposal's size by `targetPortfolioVolPct / realizedVolPct` (never up, floored) when the
   * candidate's realized annualized volatility exceeds the target, AND continuously tapers toward
   * the remaining `portfolioHeatBudgetPct` when set. Off by default: sizing is byte-identical — the
   * realized-vol/heat numbers are still computed and surfaced as an advisory rationale note (when
   * cheaply available) regardless of this flag, but never change the order size unless it's true.
   */
  volTargeting?: boolean;
  /**
   * Per-position annualized realized-volatility target (%) used by the taper above. Advisory
   * guidance: typical 15-25. Only meaningful when `volTargeting` is true; undefined disables the
   * vol-target taper (the heat-budget taper below is independent and can still apply).
   */
  targetPortfolioVolPct?: number;
  /**
   * Advisory portfolio-heat budget as % of equity (typical 4-8) — the book's total distance-to-stop
   * dollar risk should not exceed this. When set (and `volTargeting` is true), an opening order's
   * incremental risk is continuously tapered to fit whatever budget remains; it is never sized
   * below the existing exploratory floor and this is never a hard block — an overridable advisory
   * reason is tagged on the rationale instead. Undefined disables the heat-budget taper.
   */
  portfolioHeatBudgetPct?: number;
}

export interface RiskRules {
  stopLossPct?: number;
  stopLossNotional?: number;
  takeProfitPct?: number;
  /**
   * Fraction of the position to sell when take-profit triggers (1–100; 100 = full exit). Default 50 —
   * take partial profit and let the rest ride. Laddered by take-profit "band"
   * (floor(returnPct / takeProfitPct)) so it trims once per band, not every run (state in the
   * `take_profit_trims` table). NOTE: `mergePolicy` injects the DEFAULT (50) into stored policies that
   * lack the key, so existing take-profit users move from full-exit to a 50% trim — a deliberate
   * behavior change, not a no-op upgrade. A literal `undefined` (only reachable in non-merged policy
   * objects / tests) is clamped to 100 (full exit).
   */
  takeProfitTrimPct?: number;
  takeProfitNotional?: number;
  trailingStopPct?: number;
  // SHORT_SELLING: Hard stop-loss for short positions (e.g. 5% max adverse excursion).
  // Required on any short proposal per docs/phase-7-strategy.md §C.
  shortStopLossPct?: number;
  /**
   * ATR-based stop tuning (only used when policy.atrStops is on). The protective stop DISTANCE becomes
   * atrStopMultiple × ATR(atrStopPeriod) expressed as a % of entry, instead of the fixed stopLossPct —
   * a volatility-aware stop driven by the name's own realized daily range. Falls back to the fixed/beta
   * stop when bars are unavailable. atrStopPeriod default 14, atrStopMultiple default 2.0.
   */
  atrStopPeriod?: number;
  atrStopMultiple?: number;
  /**
   * Account-level circuit breaker: max trailing drawdown (%) from the equity high-water mark
   * before the breaker fires (systemState flips per `drawdownBreakerAction`) and a kill-switch
   * notification is sent. Undefined or <=0 disables the breaker entirely. Unlike the per-position
   * stopLossPct, this bounds the whole account's bleed, not one name's. Evaluated at the top of
   * each run.
   */
  maxDrawdownPct?: number;
  /**
   * Account-level circuit breaker: max single-day equity loss (account currency) from the day's
   * starting equity before the breaker fires (per `drawdownBreakerAction`). Undefined or <=0 disables.
   */
  maxDailyLossNotional?: number;
  /**
   * What the account-level breaker (maxDrawdownPct / maxDailyLossNotional) does on breach — the
   * owner's overridable preference. Per the governing philosophy ("nothing is hard except which
   * account to work in; agent decides, logs everything"), the DEFAULT is "advisory": guardrails
   * inform the agent, they never seize control.
   * - "advisory" (DEFAULT): does NOT change systemState. It writes a `policy_violation_drawdown`
   *   receipt and surfaces the drawdown as decision context to the strategist (see `drawdownAdvisory`
   *   threading in strategy.ts) so the agent can choose to de-risk — advisory awareness, no halting.
   *   The account boundary remains the only absolute.
   * - "close_only": OPT-IN hard enforcement — flip systemState → "close_only": block only NEW entries;
   *   risk-reducing exits (sell/cover) still flow.
   * - "halt": OPT-IN hard enforcement — flip systemState → "halted": a full stop until the owner
   *   manually re-arms. The strongest response; the owner must explicitly choose it.
   * The breaker itself is still opt-in via the thresholds above (unset ⇒ no breaker at all).
   */
  drawdownBreakerAction?: "advisory" | "close_only" | "halt";
  /**
   * Allow synthetic trailing-stops to fire exits even when systemState is 'halted'.
   * Never registers or updates to looser stops, but will trigger existing ones.
   */
  protectWhileHalted?: boolean;
}

export interface NotificationSettings {
  webhookUrl?: string;
  enabledEvents: NotificationEventType[];
}

export interface ConnectedAccount {
  id: string;
  userId: string;
  /**
   * Broker identifier. Add new values here when connecting a new venue
   * (e.g. "coinbase" for a crypto exchange) and wire a matching BrokerGateway.
   */
  broker: "alpaca" | "alpaca-mcp" | "robinhood" | "test" | "tradier";
  environment: "paper" | "live";
  /**
   * @deprecated Use capabilities.accountType instead for new accounts.
   * Retained for backwards compatibility with existing rows that predate
   * the AccountCapabilities field.
   */
  taxationType?: TaxationType;
  accountNumber?: string;
  label: string;
  apiKey?: string;
  apiSecret?: string;
  baseUrl?: string;
  isActive: boolean;
  isDraining?: boolean;
  /**
   * Persisted snapshot of the capabilities last reported by the broker for
   * this account. Populated on connect/re-sync; undefined for legacy rows
   * (treat all capabilities as false when absent).
   */
  capabilities?: AccountCapabilities;
  createdAt: string;
  updatedAt: string;
}

export interface BrokerageAccount {
  accountNumber: string;
  label: string;
  agenticAllowed: boolean;
  /** Live capabilities reported by the broker for this account. */
  capabilities?: AccountCapabilities;
}

export interface Portfolio {
  accountNumber: string;
  totalMarketValue: number;
  buyingPower: number;
  equityMarketValue: number;
  optionMarketValue: number;
  cash: number;
}

export interface EquityPosition {
  symbol: string;
  quantity: number;
  averageCost: number;
  marketValue: number;
  sector?: string;
  industry?: string;
}

export interface OptionPosition {
  symbol: string;
  underlyingSymbol: string;
  expirationDate: string;
  optionType: "call" | "put";
  strikePrice: number;
  quantity: number;
  averageCost: number;
  marketValue: number;
}

export interface EquityOrder {
  id: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  state: string;
  quantity?: number;
  dollarAmount?: number;
  filledQuantity?: number;
  averagePrice?: number;
  /** Resting limit price as the broker reports it (Alpaca `limit_price`, Robinhood `price`). */
  limitPrice?: number;
  /** Stop trigger price as the broker reports it. */
  stopPrice?: number;
  /** Broker-reported time-in-force, raw (Alpaca "day"/"gtc"/"ioc"/…, Robinhood "gfd"/"gtc") —
   *  wider than our order-INPUT `TimeInForce` union, so it stays a string here. */
  timeInForce?: string;
  createdAt: string;
  updatedAt?: string;
  placedAgent?: string;
  /**
   * The idempotency key we sent at placement (Alpaca `client_order_id`, Robinhood `ref_id`).
   * Lets the run-start sweep match a stale "placing" intent against the broker's order list to
   * recover an order whose placement response was lost (broker-truth-first reconciliation).
   */
  clientOrderId?: string;
  /**
   * Broker-reported order-class family (Alpaca `order_class`: "simple" | "bracket" | "oco" | "oto"),
   * carried through unchanged on both the parent AND the split child legs once a bracket's entry
   * fills. The ONLY authoritative signal that two resting exit orders are true bracket/OCO siblings
   * (as opposed to two independently-placed orders that merely happen to match in quantity, or in
   * quantity and rough timing) — `liveExitOrderCoverage` requires this before pairing two legs into
   * one unit of coverage (Codex review, PR #1331: a quantity-only, or quantity+time-window, match
   * can still conflate an owner's separately-placed same-size stop and limit, which can BOTH fill
   * and over-sell the position). Absent for brokers without a bracket concept (Robinhood) or for a
   * manually-placed simple order — absence never pairs, which only risks the bounded,
   * previously-accepted "half-bracket looks fully covered" gap, never a false-positive pair that
   * could stack two real exits on the same shares.
   */
  orderClass?: string;
}

export interface BrokerQuote {
  symbol: string;
  price?: number;
  bid?: number;
  ask?: number;
  volume?: number;
  asOf?: string;
  provider?: string;
  /** True when bid/ask were synthesized from price (no real quoted spread) — e.g. a Yahoo batch quote
   *  used by the Test-mode gateway. Consumers (mergeQuoteData provenance, hasRealAsk) must not treat a
   *  synthetic spread as a real quoted one. `syntheticSpread` stays true only when BOTH sides were
   *  derived; the side-specific flags preserve the real side of a one-sided quote. */
  syntheticSpread?: boolean;
  /** True when only the BID was derived from price (the ask may be real). */
  syntheticBid?: boolean;
  /** True when only the ASK was derived from price (the bid may be real). */
  syntheticAsk?: boolean;
}

/**
 * Universe eligibility floor — excludes penny / illiquid micro-cap names from the SCANNED candidate set
 * (index + dynamic-universe sources). It is an opening-eligibility filter only: explicitly listed
 * `additionalSymbols` and currently-held positions are ALWAYS exempt (deliberate user intent / never trap
 * an exit), and exits are never affected. Each bound is applied only when set (`> 0`) and, for market cap /
 * dollar-volume, only when that datum is known for the name — missing data never excludes (the price floor
 * is the reliable penny gate). Surfaced in settings; see passesUniverseFloor/applyUniverseFloor in market.ts.
 */
export interface UniverseFloor {
  /** Minimum share price in USD (the primary penny-stock gate). */
  minPrice?: number;
  /** Minimum market capitalization in USD. Applied only when market cap is known for the name. */
  minMarketCapUsd?: number;
  /** Minimum recent daily dollar-volume (latest price × volume) — a liquidity floor. Applied only when volume is known. */
  minDollarVolume?: number;
}

export interface TradingPolicy {
  systemState: SystemState;
  accountNumber?: string;
  connectedAccountId?: string;
  includedIndices: IndexUniverse[];
  additionalSymbols: string[];
  blocklist?: string[];
  /** Penny/illiquid exclusion for the scanned candidate universe (explicit symbols + positions exempt). */
  universeFloor?: UniverseFloor;
  strategyAuthority: StrategyAuthority;
  /**
   * Typed confirmation for high-impact LIVE actions — approving a broker order, replacing a live
   * order at market, and loosening a guardrail on a live account. true/undefined (default) = the
   * owner types the phrase (e.g. `APPROVE LIVE <SYMBOL>`, `CONFIRM`) before the action runs; false =
   * those become ordinary one-click actions. This is an adjustable OWNER PREFERENCE with an easy
   * off-switch (Settings → Advanced action confirmation), NOT a hard safety gate: real money is the
   * app's normal, in-domain case, not a gated exception. Genuinely destructive actions — wind-down
   * (which SELLS) and account deletion — keep their own typed confirmation regardless of this flag.
   */
  requireTypedConfirmation?: boolean;
  /**
   * Socratic Trade may explicitly override owner preference gates when it can state a structured
   * override thesis. "execute" lets a Decide-mode account act through those preference conflicts;
   * "propose" queues the action with the override note; "off" treats every preference gate normally.
   * Broker/account/integrity gates remain authoritative in all modes.
   */
  socraticOverrideMode?: "off" | "propose" | "execute";
  /** Optional per-decision ceiling for override actions as % of portfolio NAV. Undefined = no extra override cap. */
  socraticOverrideMaxPctOfNav?: number;
  /** Sell-to-fund-buy mode (PR 3). Defaults to "off" — no funding sells unless explicitly enabled. */
  sellToFundBuy?: SellToFundBuyMode;
  /**
   * The Green Team / Bull proposer model — REQUIRED to run (owner directive 2026-07-07: no model
   * defaults, ever; the former OPENAI_MODEL/DEFAULT_OPENAI_MODEL fallbacks are gone). Unset
   * resolves to "" and the strategy run fails closed with an actionable Settings message.
   * May also hold the "__rotate__" rotation sentinel (LLM_MODEL_ROTATION_SENTINEL) — resolved to a
   * concrete round-robin pick at run start (src/lib/model-rotation.ts), never served literally.
   */
  llmModel?: string;
  /**
   * The Red Team reviewer model — REQUIRED to run (owner directive 2026-07-07: no model defaults,
   * ever). It NEVER falls back to `llmModel` or any cross-family default: unset resolves to "" and
   * every risk-adding opening fails closed to human review (`not_configured`). The SAME model as
   * `llmModel` is ALLOWED when explicitly chosen — independence is a non-blocking Settings hint,
   * never a gate. May also hold the "__rotate__" rotation sentinel (see `llmModel`).
   */
  redTeamLlmModel?: string;
  /**
   * Daily LLM learning review (default OFF): once per UTC day a frontier-class model audits the
   * system's LEARNING DECISIONS — recent learned_context rows + the pending risk-tier queue —
   * against a system-history digest (execution-failure audits, recent rollout notes), so lessons
   * whose evidence was corrupted by an execution/infrastructure defect (e.g. losses from a stale
   * exit deadlock blamed on the thesis) get caught instead of compounding.
   */
  learningReviewEnabled?: boolean;
  /**
   * "decide" (default) = verdicts are APPLIED via the existing learned-context mutation paths
   * (delete/expire rows; approve/reject pending items), every application audited. "annotate" =
   * verdicts are recorded as audits + a notification only; nothing changes.
   */
  learningReviewMode?: "annotate" | "decide";
  /** Model for the learning review. Default claude-fable-5 (an explicit value, not a hidden
   *  fallback — a blank model skips the review with reason "no-model"). */
  learningReviewModel?: string;
  /**
   * Provider reasoning/thinking effort for the daily learning review. User-level, like the
   * review model. When unset, the runner derives the role-specific recommendation for the chosen
   * model; selecting a curated model in Settings persists that recommendation explicitly.
   */
  learningReviewReasoningEffort?: LlmReasoningEffort;
  /**
   * TRIGGER — the review fires when EITHER threshold is met (whichever comes first), capped at one
   * run per UTC day. Both user-level; the review is user-scoped (one run per user per day).
   */
  /** Run once at least this many NEW reviewable lessons (learned facts + pending items) have
   *  accumulated since the last review. Default 5. */
  learningReviewMinNewLessons?: number;
  /** …or run anyway once the oldest un-reviewed lesson has waited this many days, so nothing
   *  corrupted lingers when new learning is slow. Default 7. */
  learningReviewMaxWaitDays?: number;
  /**
   * Ordered cross-provider FAILOVER models for the Green Team (Bull) call. Default OFF (empty/unset).
   * When non-empty, a TRANSIENT primary failure (HTTP 429/5xx or timeout) transparently re-issues the
   * SAME request against each model in order; the first success serves the run. The failover is
   * recorded loudly — a `strategy_llm_failover` audit per hop, plus the served model/provider and a
   * reason on the Green Team llm step. Empty/unset = single primary endpoint, byte-identical to before.
   */
  llmFallbackModels?: string[];
  /**
   * Optional ordered list of failover models (e.g. `["gemini-2.5-flash", "claude-3-5-haiku-20241022"]`)
   * to try if the primary `redTeamLlmModel` fails (timeout, rate limit, or 5xx).
   */
  redTeamFallbackModels?: string[];
  /**
   * The Green Team / proposer's provider-specific reasoning/thinking effort, for models that
   * support it (ignored by models without that knob). Per-team split 2026-07-10: this legacy
   * field is the PROPOSER's; the reviewer has its own `redTeamReasoningEffort` below.
   */
  llmReasoningEffort?: LlmReasoningEffort;
  /**
   * The Red Team reviewer's reasoning/thinking effort (named to mirror `redTeamLlmModel`).
   * UNSET falls back to the proposer's `llmReasoningEffort` — resolve it ONLY via
   * `resolveReviewerReasoningEffort` (src/lib/llm-request.ts) so the fallback stays in one place.
   * Deliberately NO default (unlike `llmReasoningEffort`'s "medium"): a stored value here means
   * the owner EXPLICITLY split the teams; absent means "inherit the proposer's".
   */
  redTeamReasoningEffort?: LlmReasoningEffort;
  /** Intended holding horizon for new positions (default "swing" — days to weeks). */
  holdingHorizon?: HoldingHorizon;
  maxOrderNotional?: number;
  maxOrderPctOfNav?: number;
  /** Daily opening-order ceiling in fixed dollars. Mutually exclusive with maxDailyPctOfNav. */
  maxDailyNotional?: number;
  /** Hard ceiling on total order notional executed within any rolling 60-minute window. On breach the account auto-reverts strategyAuthority to "propose" and the order is rejected. */
  maxHourlyNotional?: number;
  /** Allow synthetic trailing-stop monitoring to act during extended hours. Default false (regular hours only). */
  allowExtendedHoursSyntheticStops?: boolean;
  /** Daily opening-order ceiling as a percentage of current portfolio value. Mutually exclusive with maxDailyNotional. */
  maxDailyPctOfNav?: number;
  maxSymbolExposurePct?: number;
  maxSymbolExposureNotional?: number;
  maxGrossExposurePct?: number;
  maxNetExposurePct?: number;
  maxDailyOrders: number;
  maxProposalsPerRun: number;
  /**
   * Number of ranked Market Scan candidates that receive expensive enrichment and are exposed to the
   * LLM as `marketScan.topCandidates`. Lower values reduce cost/noise; higher values broaden choice.
   */
  marketScanCandidateLimit?: number;
  /**
   * Maximum number of below-cutoff candidates with notable cached web signals (congressional buying,
   * insider buying, short pressure, or strong technicals) that may replace lower-ranked plain top
   * candidates inside the candidate limit.
   */
  marketScanOutlierReserve?: number;
  /**
   * Hard time-to-live for a still-pending (unapproved/unrejected) proposal, in minutes.
   * A proposal older than this is auto-expired (status → "expired") so the approval queue
   * never implies the agent is still actively recommending an hours/days-old idea. 0 or
   * undefined disables hard expiry — the on-run LLM re-validation below still applies.
   */
  proposalExpiryMinutes?: number;
  /**
   * How often each still-pending proposal is re-validated by the LLM, as the minimum hours
   * between re-checks for a given proposal. Re-checks ride on strategy runs and happen during
   * regular market hours only (never overnight). 0 = every run; 24 = once per day; 120 = every
   * 5 days. Default 0 (every run).
   */
  proposalRevalidateCadenceHours?: number;
  /**
   * Alert when a broker-backed limit order remains working this many minutes after submission.
   * 0 or undefined disables the stale-limit alert. Default 15.
   */
  staleLimitOrderMinutes?: number;
  /**
   * Auto-cancel-and-replace a STALE EXIT limit order (sell/cover) with a market order once it passes
   * staleLimitOrderMinutes, so a protective exit a resting limit failed to fill cannot strand the
   * position (the MU deadlock). Default ON. On a live account it defers to human typed confirmation
   * when requireTypedConfirmation is on; entries are never auto-forced to market. Owner-tunable.
   */
  autoRemediateStaleExits?: boolean;
  /**
   * What to do with a fractional/dollar-based order that lands below the active broker's minimum
   * order size (e.g. Robinhood's $1 floor — typically a pct-of-NAV-clamped trim on a small
   * account). "bump" (default; owner ruling 2026-07-09): raise the order TO the floor and place
   * it, audited as order_bumped_broker_minimum; sells are capped at the full held position and
   * the bumped order still passes normal policy evaluation. "skip": block it pre-flight instead
   * (the pre-ruling behavior), audited as order_skipped_broker_minimum with a cooldown-gated alert.
   */
  brokerMinimumHandling?: "bump" | "skip";
  permittedOrderTypes: OrderType[];
  permitExtendedHours: boolean;
  runCadenceMinutes: number;
  runDuringExtendedHours: boolean;
  scoringWeights: ScoringWeights;
  sectorCaps: Record<string, number>;
  riskRules: RiskRules;
  notificationSettings: NotificationSettings;
  taxSettings?: TaxSettings;
  tuning?: TuningSettings;
  activeProfileId?: string;
  activeBroker?: "alpaca" | "alpaca-mcp" | "robinhood" | "test" | "tradier";
  // SHORT_SELLING: Feature gate for short/cover order sides.
  // When true, policy.ts will allow short/cover proposals through (with stricter
  // guardrails). When false or absent, short/cover proposals are unconditionally
  // rejected. Requires broker-side support (Robinhood does not currently support
  // equity shorting via MCP). See docs/phase-7-strategy.md §C.
  shortSellingEnabled?: boolean;
  // SHORT_SELLING: Per-order notional cap for short positions. Should be lower
  // than maxOrderNotional per the design doc's risk guidance.
  maxShortOrderNotional?: number;
  // SHORT_SELLING: Max total short exposure as a percentage of portfolio value.
  maxShortExposurePct?: number;
  /**
   * Cap on the projected NET portfolio beta (Σ signedMarketValue·beta ÷ totalEquity, including the
   * candidate). Bounds the book's aggregate market-directional exposure so a cluster of individually
   * approved high-beta names can't accumulate a correlated drawdown the per-symbol/sector caps miss.
   * An opening order is blocked only when it pushes |projected beta| above this cap AND further from
   * the current level (a risk-reducing trade always passes). Undefined disables. Per-name beta is read
   * from the market scan; names without a beta count as 1.0. Especially relevant once shorting is on.
   */
  maxPortfolioBeta?: number;
  /**
   * OPTIONAL correlation cluster cap (0–1; undefined disables). The precise version of the beta cap:
   * an OPENING buy/short is SKIPPED when the candidate's average daily-return correlation (over ~90
   * trading days) to the current holdings exceeds this value — i.e. it would pile onto an
   * already-correlated cluster the per-symbol/sector/beta caps don't see. Exits/reductions are never
   * blocked; the gate is skipped (never false-rejects) when there is too little overlapping bar data.
   */
  maxAvgCorrelation?: number;
  /**
   * Max allowed % drift between a proposal's recorded entry anchor (referencePrice) and the current
   * market price, enforced at the approval/execution moment for OPENING market/dollar orders only
   * (limit orders are already protected by the broker's limit). Rejects a stale proposal whose
   * technical entry trigger has moved away — closing the gap where an hours-old market order approved
   * off the run cadence (or with no LLM revalidation key) still executes at a materially worse price.
   * Undefined or <=0 disables.
   */
  maxEntryDriftPct?: number;
  /**
   * Auto-attach broker-held bracket (OCO) legs — a stop-loss and take-profit resting at the broker's
   * matching engine — to opening orders on brokers that support native brackets (Alpaca), derived
   * from riskRules.stopLossPct/takeProfitPct. Makes protective exits survive local downtime instead
   * of relying solely on the synthetic scheduler-tick monitor. Defaults to enabled (treated as true
   * when undefined); set false to opt out. No-op for brokers without native bracket support.
   */
  brokerBracketsEnabled?: boolean;
  /**
   * Robinhood-only: maintain a TRUE broker-held protective stop. Robinhood's MCP cannot hold a
   * native OCO bracket (unlike Alpaca), so a held position is otherwise protected only by the app's
   * synthetic scheduler-tick monitor — a single point of failure if the app is offline. When enabled,
   * the monitor places a resting broker-side stop-market SELL (GTC) at riskRules.stopLossPct below
   * entry for each open Robinhood LIVE position, and cancels it when the position closes or a synthetic
   * exit fires (so an orphaned stop can't sell shares we no longer hold). DEFAULT OFF (opt-in): the
   * exact Robinhood MCP stop semantics should be verified against a live account before enabling, and
   * the synthetic monitor remains the always-on fallback either way.
   */
  robinhoodBrokerStops?: boolean;
  /**
   * Broker-held TRAILING stops (default ON; inert until riskRules.trailingStopPct > 0). When a
   * trailing % is configured, the protective-stop reconciler maintains a broker-held trailing stop
   * for each open long instead of (not in addition to — shares can only back one resting sell) the
   * fixed broker stop:
   *  - Alpaca REST (paper or live): a TRUE native `trailing_stop` order — the broker trails the
   *    high-water mark itself, so the trail keeps moving even while this app is offline. An
   *    alpaca-mcp account takes the Robinhood-style ratcheted lane through its MCP transport
   *    instead (an endpoint-only account has no REST keys for the native order type).
   *  - Robinhood (live only, and additionally gated on `robinhoodBrokerStops` — the existing
   *    "resting stops at Robinhood are live-verified" opt-in): the Robinhood MCP exposes no
   *    verified native trailing parameter, so the reconciler places a resting GTC stop-market at
   *    trailingStopPct below the high-water mark and RATCHETS it upward (cancel-replace) on each
   *    scheduler tick as the price rises. Between ticks the broker holds a real fixed stop, so
   *    protection survives app downtime; the trail catches up on the app's cadence.
   * Positions already covered by another live exit-side order (e.g. an Alpaca bracket stop leg)
   * are skipped — the synthetic scheduler-tick monitor remains the always-on fallback for anything
   * a broker-held stop doesn't cover. Set false to keep trailing purely app-managed.
   */
  brokerTrailingStops?: boolean;
  /**
   * Scale per-position stop-loss distance by the name's beta (clamped 0.5×–2.0×) so high-beta names
   * get wider stops (fewer noise stop-outs) and low-beta names tighter stops (cut losers sooner),
   * instead of one flat % for every ticker. Applies to the pre-trade gate, the proactive risk-exit
   * generator, and the synthetic trailing stop. Default false (flat stops). Beta is read from the
   * scan; names without a beta are unaffected (factor 1.0).
   */
  betaScaledStops?: boolean;
  /**
   * ATR-based stops (opt-in, default false). When on, the per-position protective stop DISTANCE is
   * computed from the name's Average True Range — atrStopMultiple × ATR(atrStopPeriod) as a % of entry
   * (see riskRules.atrStopPeriod/atrStopMultiple) — instead of the fixed riskRules.stopLossPct. This is
   * a volatility-aware stop driven by the name's own realized daily range; it adapts per-symbol without
   * needing a beta. Takes precedence over betaScaledStops for the stop distance when both are on. Only
   * applies when stopLossPct > 0 (it sets the DISTANCE of the configured stop), and falls back to the
   * fixed/beta stop whenever recent bars are unavailable — a position is never left unprotected.
   */
  atrStops?: boolean;
  /**
   * Convert deterministic OPENING market orders into marketable-limit orders (priced through the
   * quote by tuning.marketableLimitBufferBps) so a fast-regime entry can't fill arbitrarily far past
   * the quote. Default false. Protective EXIT orders intentionally stay market for fill certainty —
   * broker brackets are the exit-reliability mechanism.
   */
  marketableLimitEntries?: boolean;
  /**
   * Cap an opening order's notional at this percentage of the name's recent daily dollar-volume
   * (ADV proxy = latest scan price × volume; the app ingests no historical bars). Bounds market
   * impact so a high-edge thesis can't size a position into an illiquid name far past what the tape
   * can absorb — the slippage the execution-cost model debits but never prevented. Applied both in
   * deterministic sizing (right-sizes the order) and as an approval-time gate (rejects oversize
   * proposals from any path). Undefined or <=0 disables. Rarely binds for small accounts / liquid
   * names; matters at scale. Default 5.
   */
  maxOrderPctOfAdv?: number;
  /**
   * Volatility panic auto-brake: when ON, an extreme reading on any configured tail-risk gauge
   * (VIX / Cboe VVIX / Cboe SKEW) at the top of a run flips an active system to "close_only"
   * (risk-reducing exits still flow; no new entries) and fires a kill-switch notification — the
   * automatic defensive state the crisis-regime entry cap never triggered on its own. Thresholds
   * are deliberately set at rare tail extremes so this is a safeguard, not a frequent gate. Default
   * enabled.
   */
  volPanicBrakeEnabled?: boolean;
  /** VIX level at/above which the vol panic brake trips. Undefined falls back to the built-in default (40). */
  volPanicVixThreshold?: number;
  /** Cboe VVIX level at/above which the vol panic brake trips. Undefined falls back to the built-in default (150). */
  volPanicVvixThreshold?: number;
  /** Cboe SKEW level at/above which the vol panic brake trips. Undefined falls back to the built-in default (160). */
  volPanicSkewThreshold?: number;
  /**
   * Market-data staleness gate (fail-safe, additive, DEFAULT OFF). Enforced at proposal REVIEW for
   * OPENING orders only — exits are never blocked. When set (> 0), an opening proposal whose backing
   * market data is older than the threshold is BLOCKED. Fail-safe direction only: stale → block; a
   * missing timestamp is treated as stale (block) ONLY when the gate is enabled. Undefined or <= 0
   * disables (no behavior change). Read from the run's MarketScan timestamps; never fabricated.
   */
  /** Max age (seconds) of the per-symbol quote (MarketScan.quotesBySymbol[sym].asOf, fallback the
   *  candidate's asOf). Undefined/<=0 disables. */
  maxQuoteAgeSec?: number;
  /** Max age (seconds) of the scan's fundamentals/enrichment data, using MarketScan.generatedAt as the
   *  available proxy (no per-symbol fundamentals timestamp is surfaced on the quote). Undefined/<=0 disables. */
  maxFundamentalsAgeSec?: number;
  /** Whether the FMP Real-Time Quotes and ETF data integration is enabled. */
  fmpRealTimeDataEnabled?: boolean;
  /** Whether the FMP Macro & Commodities data integration is enabled. */
  fmpMacroDataEnabled?: boolean;
  /** Whether the FMP Events & News data integration is enabled. */
  fmpEventsDataEnabled?: boolean;
  /** Whether the FMP Deep Fundamentals data integration is enabled. */
  fmpFundamentalsDataEnabled?: boolean;
}

export interface ProposalSizingSnapshot {
  portfolioValue: number;
  estimatedNotional: number;
  /** Exact broker-routing basis reviewed by Red (quantity wins when present). */
  sizeBasis?: "quantity" | "notional";
  /** Exact routed quantity when sizeBasis is quantity. */
  quantity?: number;
  /** Exact routed dollar amount when sizeBasis is notional. */
  dollarAmount?: number;
  estimatedPctOfNav?: number;
  dailyOpeningCap?: {
    mode: "pct_nav" | "dollar";
    configuredValue: number;
    effectiveNotional: number;
    pctOfNav?: number;
  };
  dailyNotionalUsed?: number;
  remainingDailyNotional?: number;
}

export type HumanReviewReasonCode =
  | "initial_red_team"
  | "rationale_collapse"
  | "pre_veto_override"
  | "final_size_red_team"
  | "override_resolution";

/** Durable explanation for why an otherwise reviewable proposal requires an owner decision.
 * Keeping these structured prevents a rationale-diversity or override hold from being mislabeled
 * as a Red Team outage after the proposal leaves the strategy loop. */
export interface HumanReviewReasonReceipt {
  code: HumanReviewReasonCode;
  title: string;
  summary: string;
}

export interface TradeProposal {
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity?: number;
  dollarAmount?: number;
  limitPrice?: number;
  stopPrice?: number;
  timeInForce: TimeInForce;
  marketHours: MarketHours;
  rationale: string;
  /**
   * The Green Team's original rationale before deterministic sizing/risk receipts and Red Team text
   * are appended to the legacy `rationale` string. Optional for persisted proposals created before
   * the narrative split; readers fall back to the pre-Red portion of `rationale`.
   */
  greenTeamRationale?: string;
  /** App-computed sizing arithmetic captured before Red Team review; never model-authored. */
  sizingSnapshot?: ProposalSizingSnapshot;
  tradeThesisTag: string;
  entryMarketRegime: string;
  /**
   * Multi-signal regime severity ([0,1], rounded 2dp) from `computeMultiSignalSeverity`
   * (src/lib/regime-severity.ts), stamped alongside `entryMarketRegime` when the scorer's inputs
   * were available at proposal time. Additive/optional: legacy persisted proposals predate it.
   * Not consumed by any gate or sizer today — a receipt for future regime-conditioned scorecards
   * to bucket by (do NOT build the scorecard now; see the lane-5 rollout doc).
   */
  entryRegimeSeverity?: number;
  confidenceScore?: number;
  /**
   * The FAILOVER-AWARE model that actually generated this proposal (the Green/Bull step's served
   * model, which can differ from policy.llmModel when a fallback served the run). Persisted with
   * the proposal JSON so approval-time model attribution stays accurate even if the owner swaps
   * models between proposal and review. Optional: legacy persisted proposals predate it — readers
   * fall back to the snapshot policy's configured model.
   */
  proposedByModel?: string;
  /**
   * The model that reviewed this proposal (Red Team). Persisted with the proposal JSON so Red
   * attribution joins outcome analytics symmetrically. Optional: legacy proposals predate it.
   */
  reviewedByModel?: string;
  /**
   * Decision-time market price captured when the proposal was generated. Serves as the entry anchor
   * for the deterministic entry-drift guard (policy.maxEntryDriftPct) at approval time. Persisted with
   * the proposal so the guard can compare it against the fresh price even when approval happens hours
   * later or off the run cadence.
   */
  referencePrice?: number;
  /**
   * Approval-time limit re-anchor receipts (src/lib/approval-reprice.ts): a pending ordinary limit
   * proposal is re-anchored to the fresh approval-time quote before placement, preserving the
   * stored limit-to-anchor ratio. All additive/optional — proposals never repriced don't carry them.
   *   - `repriceAnchorPrice`: the fresh quote the MOST RECENT reprice anchored to. Subsequent
   *     reprices measure ratio and drift from here, never compounding off the original
   *     `referencePrice` (which stays untouched so the entry-drift guard and
   *     "performance since proposal" analytics keep their generation-time anchor).
   *   - `repricedFromLimit`: the stored limit the most recent reprice replaced.
   *   - `priceRequoteReason` / `priceRequotedAt`: stamped only when a MATERIAL reprice on a live
   *     typed-confirmation account re-queued the card for a fresh approval instead of placing —
   *     the price analog of `finalSizeReview.ownerApprovalRequoteReason` (which stays a SIZE
   *     receipt; reusing it for a price requote would misreport a broker_minimum_bump).
   */
  repriceAnchorPrice?: number;
  repricedFromLimit?: number;
  priceRequoteReason?: string;
  priceRequotedAt?: string;
  /**
   * Where `referencePrice` came from, stamped by insertProposal (db-proposals.ts):
   * "provided" = the proposal arrived with its own reference (a genuine decision-time quote from
   * the strategy/enrichment path); "limit-fallback" = insertProposal defensively copied the
   * limit/stop price because no reference existed (chat/manual/legacy paths). The approval-time
   * re-anchor treats "limit-fallback" as a hard price (never repriced); rows predating this field
   * fall back to the conservative equality heuristic.
   */
  referencePriceProvenance?: "provided" | "limit-fallback";
  /** Limit price for the take-profit leg of a bracket order. */
  bracketTakeProfit?: number;
  /** Stop price for the stop-loss leg of a bracket order. */
  bracketStopLoss?: number;
  /**
   * Optional limit price for the stop-loss leg, making it a stop-limit order.
   * When absent the stop-loss leg is a plain stop-market.
   */
  bracketStopLimit?: number;
  /**
   * The LLM's chosen stop-loss TYPE for this position (see `StopPlanStyle`) — set only on an
   * OPENING (buy/short) proposal. Persisted per position at fill time (`position_stop_plans`,
   * mirroring the `takeProfitBand`/`take_profit_trims` pattern below) and read back by every
   * stop-enforcement layer (`generateProactiveRiskProposals`, `enrichOpeningProposal`,
   * `runSyntheticStopMonitor`, `reconcileBrokerProtectiveStops`) for the life of the position, so
   * the choice made at entry — including "none" — survives across runs instead of being
   * re-decided (or silently dropped) on every cycle. Absent = "default" (no change in behavior).
   */
  stopPlan?: StopPlan;
  /**
   * Take-profit trim bookkeeping (set only on proactive take-profit trim proposals by
   * planTakeProfitTrims). `takeProfitBand` = the take-profit band this trim corresponds to; its position
   * cost basis is `takeProfitBasis`. The ratchet (take_profit_trims) is advanced ONLY when the trim
   * actually fills (recordFillFromProposal), so a blocked/rejected/un-approved trim is re-offered next run.
   */
  takeProfitBand?: number;
  takeProfitBasis?: number;
  /**
   * The single Red Team review verdict for this proposal, mirroring `RedTeamDebateResult`
   * (src/lib/red-team.ts). Set by the strategy loop for EVERY risk-adding opening (buy/short that
   * increases |net exposure|) — coverage is structural since the 2026-07-07 single-adversary
   * consolidation, no longer conviction-gated. Surfaced as its own "Red Team Review" block on the
   * approval card. Optional so existing/persisted proposals and test fixtures that predate the
   * field render unchanged.
   *   - `verdict`: the three-way, down-only verdict — "approve" (full finalized size),
   *     "approve-at-half" (one discrete 0.5× haircut; if half isn't placeable the proposal is HELD
   *     for human review rather than proceeding at full size), or "reject". Absent on legacy
   *     persisted verdicts (which carried only `rejected`) and when `available` is false.
   *   - `rejected`: `verdict === "reject"` (kept for legacy persisted verdicts/readers; a persisted
   *     surviving proposal normally has `rejected: false`).
   *   - `available`: the review actually ran and returned a valid verdict (vs skipped / failed).
   *   - `reason`: the reviewer's counter-argument, haircut justification, or approval reasoning.
   *   - `model`: the model that actually served the review (per-account Red Team resolution).
   *     Optional: legacy persisted verdicts predate it — readers fall back to the snapshot
   *     policy's configured red-team model.
   *   - `trigger`: why the review ran. "all_openings" for every verdict written since the
   *     consolidation (universal coverage); the legacy stakes-scaled-dissent values ("confidence",
   *     "notional", "live_opening", "override_requested", "escalation_regime") remain readable on
   *     older persisted verdicts. Optional: the oldest persisted verdicts predate the field and
   *     always meant "confidence".
   */
  redTeamVerdict?: {
    verdict?: "approve" | "approve-at-half" | "reject";
    rejected: boolean;
    available: boolean;
    reason: string;
    model?: string;
    trigger?: "all_openings" | "confidence" | "notional" | "live_opening" | "override_requested" | "escalation_regime";
    /**
     * Legacy-named marker that the Bear REJECTED and an agent-authored `autonomyOverride` requested
     * the advisory path. It is set before `resolveSocraticOverride`, so it does NOT prove the final
     * override applied. Renderers and decision evidence must use `PolicyDecision.socraticOverride.applied`
     * (or the final SocraticOverrideResolution) for that claim.
     */
    overridden?: boolean;
    /** A human explicitly approved the final broker-adjusted size after a fresh Red objection,
     * unavailable review, or incompatible half-size recommendation. Unlike `overridden`, this is
     * a consumed owner action, not merely an agent request. */
    humanOverrideApplied?: boolean;
    /**
     * Structured reason the debate was unavailable (`available: false`) — mirrors
     * `RedTeamDebateResult.failureKind` (src/lib/red-team.ts), persisted onto the decision case so
     * the "RED TEAM FAILED" signal survives beyond the run (dashboard badge, audit correlation).
     * Absent when `available: true`.
     */
    failureKind?: "not_configured" | "timeout" | "provider_error" | "rate_limited" | "malformed_response";
  };
  /** One-shot receipt for a broker-minimum size mutation that required a fresh Red review. When
   * ownerApprovalRequired is true the updated card must be approved once more; that next click
   * consumes the marker instead of rerunning Red indefinitely. */
  finalSizeReview?: {
    trigger: "broker_minimum_bump";
    fromNotional: number;
    toNotional: number;
    reviewedAt: string;
    ownerApprovalRequired: boolean;
    ownerApprovalReason?: string;
    /** Broker estimate the pending owner consent currently covers. Defaults to toNotional on
     * legacy receipts. It can advance only after a material upward requote is shown again. */
    ownerApprovalNotional?: number;
    /** Explains why a prior click was not consumed after the broker estimate increased. */
    ownerApprovalRequoteReason?: string;
    ownerApprovalRequotedAt?: string;
    ownerOverrideAppliedAt?: string;
  };
  /** Every independent hold that must be resolved before placement, in strategy evaluation order. */
  humanReviewReasons?: HumanReviewReasonReceipt[];
  /**
   * Advisory PRE-POLICY veto reasons (deterministic-bear filter, approval-time Red Team) attached to a
   * TAGGED-not-dropped candidate. They are folded into the single sized PolicyDecision as OVERRIDABLE
   * reasons immediately before the one resolveSocraticOverride call, so `isHardGateReason` classifies
   * them as preferences (both `deterministic_bear_veto: …` and `red_team_veto: …` are non-hard) and an
   * `autonomyOverride` thesis can pass them — on OPENINGS only, subject to socraticOverrideMode and the
   * override cap. With no override thesis (or mode "off") the reason keeps the candidate blocked exactly
   * as the old hard-drop did. Each entry is prefixed with its veto kind (`deterministic_bear_veto: …`
   * or `red_team_veto: …`).
   */
  preVetoReasons?: string[];
  /**
   * Explicit agent-authored request to override owner preference gates for this decision.
   * This is not a client-side bypass token and does not override broker/account/integrity gates.
   * It exists so Socratic Trade can say, in structured form, "I know this conflicts with the
   * configured preference, and here is why I still think acting is wiser."
   */
  autonomyOverride?: {
    requested: boolean;
    thesis: string;
    /** Which preference gates the agent believes should be overridden. */
    preferenceConflicts?: string[];
    /** What would make the override wrong, for later outcome review. */
    invalidation?: string;
    /** Optional intended cash deployment when the override is about buying a panic discount. */
    cashDeploymentPct?: number;
  };
}

export type SocraticDecisionStatus =
  | "planned"
  | "proposed"
  | "placing"
  | "placed"
  | "filled"
  | "blocked"
  | "rejected"
  | "rejected_by_broker"
  | "not_placed"
  | "expired"
  | "withdrawn"
  | "error"
  | "observed";

/** Forward-return measurement horizons for decision outcomes. 15m/1h resolve only when a live-quote
 * sampling window was actually hit (no intraday history source exists); 1d/1w resolve from daily
 * closes via the provider cascade. Horizon arithmetic is TRADING days (market-calendar), never
 * calendar-ms. */
export type SocraticOutcomeHorizon = "15m" | "1h" | "1d" | "1w";

/** Terminal resolution of one outcome horizon. 'unresolvable' is a first-class, HONEST terminal
 * state (delisted symbol, no intraday source, series ends before target) — never fabricated data,
 * and it stays in every denominator so coverage disclosure can say "N/M resolved". */
export type SocraticOutcomeResolution = "ok" | "unresolvable";

/** One measured (or terminally unmeasurable) forward-return row for a single horizon. */
export interface SocraticOutcomeHorizonRow {
  horizon: SocraticOutcomeHorizon;
  /** Side-adjusted % return over this horizon (positive = the decided/considered direction worked;
   * mirrors returnSinceProposalPct's sign convention). Present only when resolution === 'ok'. */
  returnPct?: number;
  /** returnPct minus the same-window SPY return under the same side convention (long: vs holding
   * SPY; short: vs shorting SPY). Undefined when no SPY series covered the window (15m/1h have no
   * intraday SPY basis). */
  spyExcessPct?: number;
  /** Optional % return of the alternative actually taken instead (reserved; populated when an
   * alternative join exists — never fabricated). */
  altReturnPct?: number;
  /** When this horizon's outcome was measured (or declared unresolvable). */
  maturedAt?: string;
  /** Honest provenance of the entry->exit prices, e.g. "fill->daily_close",
   * "ref_price->daily_close", "fill->live_quote(+22m)". */
  priceBasis?: string;
  resolution: SocraticOutcomeResolution;
  /** Why the horizon could not be resolved, e.g. "no_intraday_source", "no_price_series",
   * "no_bar_at_or_after_target". Present only when resolution === 'unresolvable'. */
  reason?: string;
}

export interface SocraticRagAttribution {
  symbol: string;
  /** Stable ref to the exact retrieved chunk; safe to persist/audit without prompt or query text. */
  evidenceRef?: string;
  /** Legacy rows may retain this raw query. New writes use queryHash instead. */
  query?: string;
  /** SHA-256 query fingerprint for new attribution rows; raw queries are not persisted. */
  queryHash?: string;
  chunkId?: string;
  source?: string;
  docType?: string;
  title?: string;
  url?: string;
  publishedAt?: string;
  score?: number;
  relevanceScore?: number;
  text: string;
  contribution: string;
}

export interface SocraticEvidenceItem {
  kind:
    | "market_scan"
    | "candidate"
    | "rag"
    | "red_team"
    | "policy"
    | "outcome"
    | "learning"
    | "coaching"
    | "framework"
    | "override"
    /** Advisory prompt-safety receipts (injection-pattern scan, evidence-age anomalies) — see
     * src/lib/prompt-safety.ts. Never a block; purely a surfaced receipt. */
    | "safety";
  title: string;
  summary: string;
  source?: string;
  symbol?: string;
  score?: number;
  tone?: "positive" | "warning" | "negative" | "neutral";
  data?: unknown;
}

export interface SocraticDecisionCase {
  id: string;
  userId: string;
  connectedAccountId?: string;
  runId?: string;
  proposalId?: string;
  accountNumber?: string;
  createdAt: string;
  updatedAt: string;
  symbol?: string;
  side?: OrderSide;
  status: SocraticDecisionStatus;
  authority: StrategyAuthority;
  thesis: string;
  rationale: string;
  /** Green Team rationale before deterministic receipts and Red Team review text were appended. */
  greenTeamRationale?: string;
  /** App-computed sizing arithmetic captured with the proposal. */
  sizingSnapshot?: ProposalSizingSnapshot;
  action: string;
  thesisTag?: string;
  regime?: string;
  confidenceScore?: number;
  notional?: number;
  model?: string;
  redTeamVerdict?: TradeProposal["redTeamVerdict"];
  policyDecision?: PolicyDecision;
  evidence: SocraticEvidenceItem[];
  ragAttributions: SocraticRagAttribution[];
  /**
   * Typed retrieval-status receipt (typed-retrieval-status, 2026-07-06): the per-symbol/PORTFOLIO
   * classification of WHY each RAG/episodic retrieval pass this run made came back the way it did
   * (no_memory / lookup_failed / budget_skipped / degraded / ok, or the experience-memory-specific
   * flag_off / ok_empty) — see `RetrievalStatus` (vector-db.ts) and `ExperienceRetrievalStatus`
   * (experience-memory.ts). PERSISTENCE ONLY, not rendered anywhere; a receipt that must never gate,
   * alter, or drop retrieval/proposals. Optional/additive — omitted on any case built before this.
   */
  ragRetrievalStatus?: { symbol: string; status: string; reason?: string }[];
  dissent: SocraticEvidenceItem[];
  /** Matured outcome written by the outcome engine (src/lib/outcome-engine.ts) — the closure of
   * loop step 5. `outcomes[]` is the multi-horizon truth (15m/1h/1d/1w, each individually ok or
   * honestly 'unresolvable'); the top-level fields are the headline: realized P&L for placed
   * decisions whose lot closed, otherwise the longest resolved counterfactual horizon. status
   * 'open' = still maturing (job revisits); 'unresolvable' = terminal, no horizon could resolve. */
  outcome?: {
    status: "open" | "won" | "lost" | "flat" | "unknown" | "unresolvable";
    returnPct?: number;
    pnlUsd?: number;
    note?: string;
    measuredAt?: string;
    outcomes: SocraticOutcomeHorizonRow[];
  };
  autonomyOverride?: TradeProposal["autonomyOverride"] & {
    applied: boolean;
    conflicts: string[];
  };
  lessons: string[];
  coachNotes: string[];
}

export type SocraticFrameworkOwnerVerb = "accept" | "reject" | "rewrite";
export type SocraticFrameworkProposalStatus = "pending" | "accepted" | "rejected" | "applied";

/** Advisory AI review attached to a pending framework proposal by the single-call
 *  batched reviewer. It is a RECOMMENDATION only — it never changes the proposal's
 *  status or owner verb; the owner still makes the final accept/reject/rewrite call. */
export interface SocraticFrameworkAiReview {
  verdict: SocraticFrameworkOwnerVerb; // accept | reject | rewrite (recommended)
  rationale: string;
  rewrittenChange?: string; // present when verdict is "rewrite": the AI's improved proposedChange
  model: string;
  reviewedAt: string;
}

export interface SocraticFrameworkProposal {
  id: string;
  userId: string;
  connectedAccountId?: string;
  decisionId?: string;
  runId?: string;
  createdAt: string;
  updatedAt: string;
  status: SocraticFrameworkProposalStatus;
  priority: "low" | "medium" | "high";
  subsystem: "strategy" | "risk" | "sizing" | "universe" | "evidence" | "coaching";
  title: string;
  rationale: string;
  proposedChange: string;
  evidence: SocraticEvidenceItem[];
  ownerVerb?: SocraticFrameworkOwnerVerb;
  ownerResponse?: string;
  /** Advisory AI recommendation from the batched reviewer; owner decision still required. */
  aiReview?: SocraticFrameworkAiReview;
}

export interface SocraticDecisionTrace {
  decision: SocraticDecisionCase;
  run?: StrategyRunRow;
}

// Per-field provenance: which provider supplied each enriched value. Used for the
// single-source tooltips in the market scan table.
export type EnrichmentSources = Partial<
  Record<
    "price" | "bid" | "ask" | "intradayChangePct" | "asOf" | "sentiment" | "peRatio" | "analystRating" | "sector" | "industry" | "volume" | "dividendYield" | "eps" | "companyName" | "pbRatio" | "shortPercentOfFloat" | "beta" | "fiftyTwoWeekHigh" | "fiftyTwoWeekLow" | "insiderSentiment" | "fcfYield" | "debtToEquity" | "epsGrowth" | "senateTrades" | "daysToEarnings" | "institutionOwnershipPct" | "nearTheMoneyIv" | "putCallRatio" | "vwap" | "targetMean" | "targetHigh" | "targetLow" | "targetMedian" | "returnOnEquity" | "returnOnAssets" | "revenueGrowth" | "freeCashFlowYield" | "grossProfitMargin" | "congressTradesQuiver" | "insiderTradesQuiver" | "govContractsQuiver" | "lobbyingQuiver" | "patentsQuiver",
    string
  >
>;

/** Optional source-faithful receipts for enriched scalar fields. */
export type EnrichmentFieldObservations = Partial<
  Record<keyof EnrichmentSources, FieldObservation<unknown>>
>;

export interface AnalystRatingDetail {
  score: number;
  label: string;
  counts?: { strongBuy: number; buy: number; hold: number; sell: number; strongSell: number };
  mean?: number;
  /** Canonical upstream source family, used to avoid blending duplicate redistributions. */
  upstreamFamily?: string;
}

export interface MarketQuote {
  symbol: string;
  companyName?: string;
  price: number;
  /** Latest available daily volume-weighted average price. Source-provided only; never fabricated. */
  vwap?: number;
  bid?: number;
  ask?: number;
  volume: number;
  marketCap?: number;
  intradayChangePct: number;
  netChange?: number;
  sector?: string;
  industry?: string;
  positionMarketValue: number;
  score: number;
  factorBreakdown?: MarketFactorBreakdown;
  provider?: string;
  stale?: boolean;
  cached?: boolean;
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
  shortPercentOfFloat?: number;
  beta?: number;
  fiftyTwoWeekHigh?: number;
  fiftyTwoWeekLow?: number;
  insiderSentiment?: number;
  fcfYield?: number;
  debtToEquity?: number;
  epsGrowth?: number;
  senateTrades?: number; // Net congressional trade signal (distinct buy members minus sell members)
  /** Trading days until the next scheduled earnings date (Yahoo calendarEvents). Source-provided
   *  only; undefined when the API does not return a future earnings date — never fabricated to 0. */
  daysToEarnings?: number;
  /** Percentage of shares held by institutions (Yahoo institutionOwnership / majorHoldersBreakdown). */
  institutionOwnershipPct?: number;
  /** Near-the-money implied volatility (%) derived from the Robinhood option chain (opt-in tier). */
  nearTheMoneyIv?: number;
  /** Put/call open-interest ratio around the money (Robinhood option chain; opt-in tier). */
  putCallRatio?: number;
  /** Numeric analyst price targets (FMP price-target-consensus; opt-in FMP_PRICE_TARGETS_ENABLED). */
  targetMean?: number;
  targetHigh?: number;
  targetLow?: number;
  targetMedian?: number;
  returnOnEquity?: number;
  returnOnAssets?: number;
  revenueGrowth?: number;
  freeCashFlowYield?: number;
  grossProfitMargin?: number;
  congressTradesQuiver?: number;
  insiderTradesQuiver?: number;
  govContractsQuiver?: number;
  lobbyingQuiver?: number;
  patentsQuiver?: number;
  /** Cross-sectional: this name's intraday % move minus the average move of its sector among
   *  the scan candidates. >0 = outperforming its sector today (relative strength). Computed in-house. */
  sectorRelStrength?: number;
  /** True when the bid was synthesized from price (no real quoted bid from an exchange/market maker). */
  syntheticBid?: boolean;
  /** True when the ask was synthesized from price (no real quoted ask from an exchange/market maker). */
  syntheticAsk?: boolean;
  /** Bar-based technical strength, 0–100 (50 = neutral). From the technical web source
   *  (TradingView push or in-house computed). Lifts/dings `momentumScore`. */
  technicalScore?: number;
  technicalDirection?: TechnicalDirection;
  /** Named technical conditions that fired, e.g. ["sma50_200_golden_cross","rsi_reclaim_oversold"]. */
  technicalSignals?: string[];
  /** Composite Congress.Trade score 0-100, with direction separated so bearish evidence stays explicit. */
  congressCompositeScore?: number;
  congressCompositeSignedScore?: number;
  congressCompositeDirection?: "BUY" | "SELL" | "NEUTRAL";
  congressCompositeConfidence?: number;
  congressCompositeComponents?: Record<string, number>;
  congressCompositeProvenance?: Record<string, string[]>;
  congressCompositeVersion?: string;
  congressCompositeWeights?: Record<string, number>;
  preCongressScore?: number;
  evidenceBulletins?: string[]; // 1-line backend web-source bulletins (congress, insider, etc.)
  sources?: EnrichmentSources;
  fieldObservations?: EnrichmentFieldObservations;
  providerFailures?: Record<string, ProviderFailureReceipt>;
}

export interface MarketScan {
  source: string;
  generatedAt: string;
  scannedSymbols: number;
  returnedQuotes: number;
  /** Configured cap for enriched/prompted candidates in this scan. */
  candidateLimit?: number;
  /** Configured reserve for below-cutoff notable outliers inside `candidateLimit`. */
  outlierReserve?: number;
  /** Number of notable below-cutoff candidates included in `topCandidates`. */
  outlierCandidateCount?: number;
  /** Number of forced-held-position candidates in `topCandidates` beyond the ranked cut and the
   *  outlier reserve — held positions are never hidden regardless of rank, so `topCandidates.length`
   *  can legitimately exceed `candidateLimit` by this much (plus outliers). Undefined on scans
   *  persisted before this field existed; the UI falls back to a coarser breakdown rather than
   *  guessing a count. */
  heldCandidateCount?: number;
  /** Market breadth: % of the full screener advancing today (risk-on/off gauge). */
  breadthPct?: number;
  topCandidates: MarketQuote[];
  sectorBySymbol: Record<string, string>;
  quotesBySymbol: Record<string, MarketQuoteSummary>;
  cacheTtlMs?: number;
  cached?: boolean;
  warnings: string[];
}

export type MarketFactor = keyof ScoringWeights;

export type MarketFactorBreakdown = Record<MarketFactor, number> & {
  weightedTotal: number;
};

/**
 * Compact per-candidate evidence digest persisted in the per-run `signal_snapshot`
 * audit for the FULL scored set — chosen AND skipped — so future learning can
 * correlate the deterministic evidence that preceded a decision with its realized
 * outcome (signal efficacy), run counterfactuals on names that were passed over
 * (forward return from `refPrice`), and attribute outcomes to the dominant factor
 * (`factorBreakdown`). Raw provider rows stay out; only this digest is stored.
 */
export interface CandidateEvidence {
  symbol: string;
  /** true = the agent acted on it this run; false = top-ranked but skipped. */
  chosen: boolean;
  side?: OrderSide; // present when chosen
  status?: string; // proposal status when chosen (placed/paper/proposed/blocked)
  thesisTag?: string; // present when chosen
  /** Run market regime — the same deterministic regime for every candidate this run. */
  regime: string;
  score?: number;
  /** Decision-time price; the anchor for counterfactual forward-return tracking. */
  refPrice?: number;
  sector?: string;
  factorBreakdown?: MarketFactorBreakdown;
  congressNet?: number; // senateTrades (distinct buy members minus sell members)
  insiderSentiment?: number;
  shortPercentOfFloat?: number;
  beta?: number;
  intradayChangePct?: number;
  sectorRelStrength?: number; // intraday move vs sector average at decision time
  technicalScore?: number; // bar-based technical strength 0–100 at decision time
  technicalDirection?: TechnicalDirection;
  technicalSignals?: string[]; // named technical conditions that fired
  /** Composite Congress.Trade score at decision time. Positive strength is 0-100; direction carries BUY/SELL. */
  congressCompositeScore?: number;
  congressCompositeSignedScore?: number;
  congressCompositeDirection?: "BUY" | "SELL" | "NEUTRAL";
  congressCompositeConfidence?: number;
  congressCompositeComponents?: Record<string, number>;
  congressCompositeProvenance?: Record<string, string[]>;
  congressCompositeVersion?: string;
  congressCompositeWeights?: Record<string, number>;
  preCongressScore?: number;
  asOf?: string; // candidate data freshness (most-recent enrichment timestamp)
  provider?: string; // primary provider
  sources?: EnrichmentSources; // per-field provenance (source attribution)
  /** Decision-time leave-one-provider-out score estimate. This is shadow telemetry, not a causal
   *  claim: it removes only fields that provider won in the cascade and does not invent a fallback
   *  value from a provider that was not retained. */
  sourceAblations?: SourceAblationReceipt[];
  /** Provider failures visible during this symbol's enrichment pass. */
  providerFailures?: Record<string, ProviderFailureReceipt>;
  bulletins?: string[]; // up to 3 web-source evidence bulletins
  /** Backend-derived ratios at decision time (PEG, earnings yield, ROE, payout, $ volume, spread).
   *  Persisted so the learning loop can correlate, e.g., low-PEG entries with realized outcomes. */
  derived?: DerivedMetrics;
}

export interface SourceAblationReceipt {
  provider: string;
  affectedFields: string[];
  scoringFields: string[];
  promptOnlyFields: string[];
  originalScore: number;
  shadowScore: number;
  /** originalScore - shadowScore; positive means this source lifted deterministic rank. */
  scoreDelta: number;
  method: "leave_winning_fields_out/v1";
}

export interface SourceCoverageReceipt {
  provider: string;
  symbolsCovered: number;
  symbolCoveragePct: number;
  fieldsObserved: number;
  fields: string[];
  failedSymbols: number;
  failureKinds: string[];
}

export interface SourceValueStat {
  provider: string;
  outcomes: number;
  directionalOutcomes: number;
  chosenOutcomes: number;
  skippedOutcomes: number;
  winRate: number;
  avgReturnPct: number;
  avgScoreDelta: number;
  /** Average sign(scoreDelta) * realized return. Positive means the source's rank direction aligned
   *  with subsequent returns. Observational and selection-biased; never treated as causal. */
  directionalValuePct: number;
  directionalAgreementRate: number;
  fields: string[];
  learningStatus: "insufficient" | "directional" | "established";
}

export interface MarketQuoteSummary {
  symbol: string;
  companyName?: string;
  price: number;
  vwap?: number;
  bid?: number;
  ask?: number;
  sector?: string;
  industry?: string;
  score: number;
  provider?: string;
  asOf?: string;
  sentiment?: number;
  peRatio?: number;
  analystRating?: string;
  analystScore?: number;
  analystBySource?: Record<string, AnalystRatingDetail>;
  dividendYield?: number;
  eps?: number;
  pbRatio?: number;
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
  congressTradesQuiver?: number;
  insiderTradesQuiver?: number;
  govContractsQuiver?: number;
  lobbyingQuiver?: number;
  patentsQuiver?: number;
  returnOnEquity?: number;
  returnOnAssets?: number;
  revenueGrowth?: number;
  freeCashFlowYield?: number;
  grossProfitMargin?: number;
  syntheticBid?: boolean;
  syntheticAsk?: boolean;
  evidenceBulletins?: string[];
  /** Factor-score digest for the drilldown's factor bars (same shape MarketQuote carries). */
  factorBreakdown?: MarketFactorBreakdown;
  headlines?: string[];
  intradayChangePct?: number;
  volume?: number;
  sectorRelStrength?: number;
  sources?: EnrichmentSources;
  fieldObservations?: EnrichmentFieldObservations;
  providerFailures?: Record<string, ProviderFailureReceipt>;
}

export interface MarketDataProviderOptions {
  scoringWeights?: ScoringWeights;
  ttlMs?: number;
  /** Cancels the current scan's outbound discovery reads when its caller deadline expires. */
  signal?: AbortSignal;
  userId?: string;
  dynamicUniverses?: IndexUniverse[];
  candidateLimit?: number;
  outlierReserve?: number;
  /** Penny/illiquid exclusion for index + dynamic-universe candidates (explicit symbols + positions exempt). */
  universeFloor?: UniverseFloor;
  /**
   * Item 2: multiplier applied to the congressional contribution in scan scoring. Default (undefined → 1)
   * leaves the congress term unchanged; 0 zeroes it when the congress-score go/no-go gate returned a no-go
   * verdict and `policy.tuning.congressGoNoGoGating` is on. Resolved by the caller from the cached verdict.
   */
  congressMultiplier?: number;
  /**
   * Interactive refreshes must not enqueue the multi-minute fundamentals cascade.
   * They still return real screener, broker, and persisted web-signal data; the full
   * strategy/scheduler path keeps deep enrichment enabled.
   */
  enrichmentMode?: "full" | "skip";
  /** Slow-changing facts from the latest completed strategy scan. */
  seedEnrichment?: Record<string, MarketQuoteSummary>;
}

export interface MarketDataProvider {
  name: string;
  scan(symbols: string[], positions: EquityPosition[], options?: MarketDataProviderOptions): Promise<MarketScan>;
}

/**
 * Which policy gates may mark a failure ESCALATABLE (routable to a pending-approval card
 * instead of a dead blocked entry). This is a closed allowlist — gates not named here
 * (per-order notional caps, blocklist/universe, shorting disabled, IRA wash-sale, margin
 * minimum, ...) can never produce an escalation entry, so they can never be escalated.
 */
export type GateEscalationKind =
  | "wash_sale_ask" // taxSettings.washSaleHandling === "ask": rebuy needs the owner's call
  | "daily_notional_cap" // time-context: today's opening-notional budget already consumed
  | "hourly_notional_cap" // time-context: rolling 60-minute notional budget consumed
  | "daily_order_cap" // time-context: today's opening-order count consumed
  | "quote_staleness"; // time-context: quote/scan data older than the freshness gate allows

/**
 * One escalatable gate failure inside a PolicyDecision. Produced ONLY by
 * evaluateTradeProposal (server-side); `token` is minted ONLY by the strategy run loop when it
 * persists the escalated pending card, and is read back ONLY from that stored row at approval
 * time — no client payload can create, inject, or alter it.
 */
export interface GateEscalation {
  kind: GateEscalationKind;
  /** The exact matching entry in decision.reasons that this escalation covers. */
  reason: string;
  /** Normalized symbol the escalation is scoped to. */
  symbol: string;
  /** Wash-sale provenance + priced cost (kind "wash_sale_ask" only). */
  washSale?: {
    /** Account whose loss binds the lockout. */
    account?: string;
    /** ISO date the lockout clears (binding loss exit + 30d). */
    clearDate?: string;
    /** Total still-in-window disallowed loss dollars for the symbol. */
    disallowedLossUsd?: number;
    /** disallowedLossUsd × taxSettings.shortTermRatePct — the deduction value forfeited. */
    estimatedTaxCostUsd?: number;
  };
  /** Server-minted, server-stored approval token (see interface doc). */
  token?: string;
}

/** Approval-path override handle: derived server-side from a STORED escalated proposal row. */
export interface ApprovedEscalation {
  kind: GateEscalationKind;
  symbol: string;
  token: string;
  /**
   * The estimatedTaxCostUsd PRICED ON THE CARD the user approved (from the stored escalation's
   * washSale payload). The wash-sale gate honors the token only while the freshly recomputed
   * cost stays within washSaleOverrideCostTolerance of this figure — if new losses posted since
   * escalation and the real cost is now materially higher, the stale approval is refused and
   * the card is re-escalated at the current price instead of executing.
   */
  approvedCostUsd?: number;
}

/**
 * Audit record of what the wash-sale gate did for a BUY of a locked symbol — attached to the
 * decision whether the gate blocked, escalated, or allowed, so no outcome is ever silent.
 */
export interface WashSaleGateAudit {
  handling: WashSaleHandling;
  symbol: string;
  /** Account whose loss binds the lockout (when provenance is available). */
  account?: string;
  /** ISO timestamp the lockout clears. */
  clearDate?: string;
  disallowedLossUsd?: number;
  estimatedTaxCostUsd?: number;
  /**
   * "auto" handling RECEIPT telemetry (outcome auto_proceeded) — no longer a gate threshold (owner
   * decision 2026-07-03: the old edge-vs-cost veto re-arithmetized the LLM's own outputs, so it was
   * removed; "auto" always proceeds now). Kept only so the priced tax-cost math stays on the record
   * and can still be surfaced to the model/owner. requiredEdgeUsd is legacy/unused going forward.
   */
  expectedEdgeUsd?: number;
  requiredEdgeUsd?: number;
  edgeMultiple?: number;
  /** Token of the honored server-stored override (outcome approved_via_override). */
  overrideToken?: string;
  /**
   * Human-facing annotation for outcomes that proceed despite a technical wash sale — set to
   * IRA_WASH_SALE_DISREGARD_NOTE (verbatim) for outcome "ira_disregarded". Rendered wherever
   * the purchase shows (approvals card, activity) so the acceptance is never invisible.
   */
  note?: string;
  outcome:
    | "blocked" // handling "block" (a stricter opt-in, no longer the default): refused outright
    | "blocked_ira" // IRA replacement purchase — hard block (Rev. Rul. 2008-5; iraWashSaleHandling "block", a stricter opt-in)
    | "ira_disregarded" // IRA replacement purchase allowed by iraWashSaleHandling "disregard" (the default) — annotated + audited, never silent
    | "ask_escalated" // handling "ask": refused here, marked escalatable for the run loop
    | "auto_proceeded" // handling "auto" (the default): always proceeds — priced tax cost recorded as receipt telemetry, never a veto
    | "approved_via_override" // approval path honored the stored ask/auto override token
    | "reescalated_cost_changed"; // stale override refused: cost moved past tolerance since approval — re-escalated at the current price
}

export interface PolicyDecision {
  approved: boolean;
  reasons: string[];
  socraticOverride?: {
    applied: boolean;
    mode: "propose" | "execute";
    conflicts: string[];
    thesis: string;
    invalidation?: string;
    cashDeploymentPct?: number;
  };
  /**
   * Escalatable failures among `reasons` (see GateEscalation). Present only when the gate
   * refused the proposal AND at least one failure belongs to the escalatable allowlist. The
   * strategy loop escalates ONLY when EVERY reason is covered (shouldEscalateDecision).
   */
  escalations?: GateEscalation[];
  /** Wash-sale gate audit trail — present whenever a BUY hit a wash-sale lock (never silent). */
  washSale?: WashSaleGateAudit;
  /**
   * Machine-readable "the Red Team review could not run for this proposal" flag (single-adversary
   * consolidation R18/R19), persisted with the stored decision on BOTH the propose-mode and the
   * requiresHumanReview inserts so the pending-approval badge reads a stable stored field — the
   * notification payload flag covers only the feed/title path. The human-readable reason is also
   * appended to `reasons`. Absent (not false) when the review ran normally.
   */
  adversaryUnavailable?: boolean;
  adversaryUnavailableReason?: string;
  projectedSymbolExposurePct?: number;
  dailyNotionalUsed?: number;
}

export interface ReviewedOrder {
  estimatedNotional: number;
  alerts: string[];
  /**
   * Structured pre-flight rejection signal parsed from the broker's own order-review response
   * (e.g. Robinhood's `order_checks.alertType` == EQUITY_DOLLAR_BASED_MINIMUM_AMOUNT_ERROR /
   * EQUITY_SUB_DOLLAR_SHARE_BASED_ORDER). When present, the broker has already told us this exact
   * order WILL be rejected — callers should skip placement/proposal instead of retrying a
   * guaranteed failure every run. Absent when the review carries no recognized blocking signal.
   */
  preflightBlock?: {
    alertTypes: string[];
    message: string;
  };
  raw: unknown;
}

export interface ExecutedOrder {
  orderId?: string;
  refId: string;
  state: string;
  filledQuantity?: number;
  averagePrice?: number;
  raw: unknown;
}

export interface EquityOrderInput {
  accountNumber: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity?: number;
  dollarAmount?: number;
  /** Entry-price anchor captured when the proposal was generated/reviewed. */
  referencePrice?: number;
  limitPrice?: number;
  stopPrice?: number;
  timeInForce: TimeInForce;
  marketHours: MarketHours;
  /** Limit price for the take-profit leg of a bracket order. */
  bracketTakeProfit?: number;
  /** Stop price for the stop-loss leg of a bracket order. */
  bracketStopLoss?: number;
  /**
   * Optional limit price for the stop-loss leg, making it a stop-limit order.
   * When absent the stop-loss leg is a plain stop-market.
   */
  bracketStopLimit?: number;
  /**
   * Native broker-held trailing stop distance (% below the high-water mark). Alpaca translates this
   * to a `trailing_stop` order with `trail_percent` (the broker trails the extreme itself; any
   * `stopPrice` is ignored for that order type). Brokers WITHOUT a verified native trailing
   * parameter (Robinhood MCP) must fail closed — the protective-stop reconciler emulates trailing
   * there by ratcheting a plain stop_market instead, and never sets this field for them.
   */
  trailPercent?: number;
}

export interface BrokerGateway {
  /**
   * True when getEquityOrders returns a list that reliably includes recently-TERMINAL orders
   * (filled/canceled/rejected/expired) for at least the placement-reconcile lookback window — not
   * just currently-live/open orders. reconcilePlacementError only concludes `not_placed`
   * (safe-to-retry, self-clearing) when this is true; otherwise an order absent from the list is
   * treated as `uncertain` (keep 'placing' + the protected alert), because absence can't distinguish
   * "never placed" from "placed, filled, and already aged out of a live-only list" — and dropping a
   * possibly-real order is the money-path hazard. Undefined ⇒ conservative (treated as false).
   * Alpaca sets this true (getEquityOrders pages status:"all"); Robinhood leaves it unset because its
   * get_equity_orders terminal-inclusion window can't be verified without a live token.
   */
  readonly ordersListIncludesTerminal?: boolean;
  getAccounts(): Promise<BrokerageAccount[]>;
  getPortfolio(accountNumber: string): Promise<Portfolio>;
  getEquityPositions(accountNumber: string): Promise<EquityPosition[]>;
  getOptionPositions?(accountNumber: string): Promise<OptionPosition[]>;
  getEquityOrders(accountNumber: string): Promise<EquityOrder[]>;
  getEquityQuotes(accountNumber: string, symbols: string[]): Promise<Record<string, BrokerQuote>>;
  getEquityTradability(accountNumber: string, symbols: string[]): Promise<Record<string, { tradable: boolean; fractional: boolean; reason?: string }>>;
  reviewEquityOrder(input: EquityOrderInput): Promise<ReviewedOrder>;
  placeEquityOrder(input: EquityOrderInput & { refId: string }): Promise<ExecutedOrder>;
  cancelEquityOrder(accountNumber: string, orderId: string): Promise<ExecutedOrder>;
  /**
   * Identify and cancel the still-resting sibling legs (take-profit/stop-loss) of a broker-native
   * bracket order (Alpaca order_class "bracket", Tradier "otoco"), given the ORIGINAL entry order's
   * own ID — used when a per-position stop plan changes away from "fixed"/"atr" after an earlier
   * opening already placed a bracket, whose legs `enrichOpeningProposal` has no other way to reach
   * (only strips bracket fields from the NEW order being placed, not a resting one). Best-effort:
   * a leg that already filled/cancelled between lookup and cancel is simply skipped, not an error.
   * Optional — undefined on a broker/adapter with no bracket support (e.g. Robinhood).
   */
  cancelBracketSiblingLegs?(accountNumber: string, originalOrderId: string): Promise<{ cancelledOrderIds: string[] }>;
}

export interface StrategyRun {
  id: string;
  startedAt: string;
  finishedAt?: string;
  /** skipped = pre-decision gate (budget/market/broker); not a successful evaluation */
  status: "running" | "completed" | "failed" | "skipped";
  summary?: string;
}

export interface StrategyRunRow {
  id: string;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "completed" | "failed" | "skipped";
  summary?: string;
  connectedAccountId?: string;
  placedCount: number;
  paperCount: number;
  blockedCount: number;
  proposedCount: number;
  totalCount: number;
}

export interface PendingProposal {
  id: string;
  createdAt: string;
  proposal: TradeProposal;
  decision: PolicyDecision;
  review?: ReviewedOrder;
  estimatedNotional?: number;
  /** Last time a strategy run re-validated this still-pending proposal via the LLM. */
  lastRevalidatedAt?: string;
  /** The LLM's most recent re-validation note (why it still stands). */
  revalidationNote?: string;
  accountNumber?: string;
  executionMode?: ExecutionMode;
  /** Side-adjusted % move from the proposal's referencePrice to the current price (positive = the proposed direction worked). Undefined when no anchor/current price is available. */
  performanceSinceProposalPct?: number;
  /** The entry anchor the performance is measured from. */
  proposalReferencePrice?: number;
  /** The current price used for the performance figure. */
  proposalCurrentPrice?: number;
}

export interface RecentProposal {
  id: string;
  runId: string;
  accountNumber: string;
  createdAt: string;
  proposal: TradeProposal;
  decision: PolicyDecision;
  review?: ReviewedOrder;
  estimatedNotional?: number;
  status: string;
  executionMode?: ExecutionMode;
  /** Side-adjusted % move from the proposal's referencePrice to the current price. For a REJECTED proposal this is the realized counterfactual ("what it did since we passed"); for an accepted one it's how the entry has fared. Undefined when no anchor/current price is available. */
  performanceSinceProposalPct?: number;
  /** The entry anchor the performance is measured from. */
  proposalReferencePrice?: number;
  /** The current price used for the performance figure. */
  proposalCurrentPrice?: number;
  /** Broker or network error message when status is placing_failed. */
  errorMessage?: string;
}

export interface StrategyOutcome {
  proposalId?: string;
  runId?: string;
  accountNumber: string;
  source: "paper" | "live";
  symbol: string;
  side: "buy" | "sell" | "short" | "cover";
  rationale: string;
  entryPrice?: number;
  entryAt?: string;
  exitPrice?: number;
  exitAt?: string;
  currentPrice?: number;
  realizedPnl?: number;
  unrealizedPnl?: number;
  returnPct?: number;
  holdingDays?: number;
  sector?: string;
  tradeThesisTag?: string; // e.g., Mean Reversion, Breakout, Value
  riskExit?: "stop_loss" | "take_profit" | "trailing_stop";
  entryMarketRegime?: string; // Snapshot of SPY, QQQ, VIX at entry
  exitMarketRegime?: string; // Snapshot of SPY, QQQ, VIX at exit
  mae?: number; // Maximum Adverse Excursion during holding
  mfe?: number; // Maximum Favorable Excursion during holding
}

export interface StrategyProfile {
  id: string;
  name: string;
  policy: TradingPolicy;
  prompt: string;
  scoringWeights: ScoringWeights;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface StrategyTuningPatch {
  prompt?: string;
  scoringWeights?: Partial<ScoringWeights>;
  policy?: Partial<
    Pick<
      TradingPolicy,
      | "maxOrderNotional"
      | "maxOrderPctOfNav"
      | "maxDailyNotional"
      | "maxDailyPctOfNav"
      | "maxHourlyNotional"
      | "maxSymbolExposurePct"
      | "maxDailyOrders"
      | "maxProposalsPerRun"
      | "runCadenceMinutes"
      | "strategyAuthority"
      | "runDuringExtendedHours"
    >
  > & {
    riskRules?: Partial<RiskRules>;
    sectorCaps?: Record<string, number>;
  };
}

export interface StrategyTuningProposal {
  summary: string;
  rationale: string;
  marketContext: string;
  performanceReadout: string;
  proposedPatch: StrategyTuningPatch;
  cautions: string[];
  confidenceScore: number;
  generatedBy: "llm" | "local_rules";
}

export interface PortfolioSnapshot {
  id: string;
  runId?: string;
  accountNumber: string;
  source: FillSource;
  executionMode?: ExecutionMode;
  equity: number;
  cash: number;
  buyingPower: number;
  positionsValue: number;
  positions: EquityPosition[];
  createdAt: string;
}

export interface FillEvent {
  id: string;
  proposalId?: string;
  runId?: string;
  accountNumber: string;
  source: FillSource;
  executionMode?: ExecutionMode;
  symbol: string;
  side: OrderSide;
  quantity: number;
  price: number;
  notional: number;
  status: string;
  brokerOrderId?: string;
  raw?: unknown;
  /** Max Adverse Excursion (%) persisted on this fill row by the post-mortem path; undefined until then. */
  mae?: number;
  /** Max Favorable Excursion (%) persisted on this fill row by the post-mortem path; undefined until then. */
  mfe?: number;
  filledAt: string;
}

export interface EquityCurvePoint {
  timestamp: string;
  equity: number;
  source: FillSource;
  /** Cash balance at the snapshot (when the underlying portfolio snapshot recorded one).
   *  Used to infer external deposits/withdrawals for time-weighted return math; absent on
   *  synthetic curves so consumers must degrade honestly rather than assume zero flows. */
  cash?: number;
}

export interface RunAttribution {
  runId: string;
  fillCount: number;
  notional: number;
  realizedPnl: number;
  /** P&L credited to this run as the ENTRY/decision run (sum over lots it opened that later closed). Additive; undefined until any dual-credit accrues. */
  realizedPnlAsEntry?: number;
  /** P&L credited to this run as the EXIT/closing run (mirror of the slice of realizedPnl from closing fills). Additive. */
  realizedPnlAsExit?: number;
}

/** One point on a benchmark-normalized curve (base date = 100). */
export interface BenchmarkSeriesPoint {
  date: string;
  index: number;
}

/**
 * SPY-benchmark equity-curve comparison: the account's equity curve and a SPY buy-and-hold curve,
 * both normalized to 100 at the first common date, plus the window's total returns. The honest
 * "are we beating the market" readout. Computed on the fly from portfolio snapshots + SPY daily
 * closes; null/absent when there isn't enough history or SPY data is unavailable (degrade to "—").
 */
export interface BenchmarkComparison {
  equityIndex: BenchmarkSeriesPoint[];
  benchmarkIndex: BenchmarkSeriesPoint[];
  /** Account total return over the window (%, base→last). */
  accountReturnPct: number;
  /** Benchmark (SPY) total return over the same window (%). */
  benchmarkReturnPct: number;
  /** accountReturnPct − benchmarkReturnPct, in percentage points (positive = outperformance). */
  excessReturnPct: number;
  startDate: string;
  endDate: string;
  points: number;
  benchmarkSymbol: string;
  /** True when the account line is a time-weighted return chained over inferred external
   *  deposits/withdrawals (at least one material flow was detected and neutralized).
   *  False/absent = plain equity growth, which counts any transfers as if they were returns. */
  cashFlowAdjusted?: boolean;
  /** Net inferred external flow over the window in dollars (deposits positive, withdrawals
   *  negative). Present only when cashFlowAdjusted is true. Inferred from snapshot cash deltas
   *  minus recorded trade cash — an estimate, not a broker transfer ledger. */
  netExternalFlows?: number;
}

export interface PerformanceSummary {
  liveEquityCurve: EquityCurvePoint[];
  paperEquityCurve: EquityCurvePoint[];
  /** SPY-benchmark comparison for the active execution mode's equity curve (absent when insufficient data). */
  benchmark?: BenchmarkComparison;
  liveRealizedPnl: number;
  paperRealizedPnl: number;
  liveUnrealizedPnl: number;
  paperUnrealizedPnl: number;
  liveWinRate: number;
  paperWinRate: number;
  liveAverageReturnPct: number;
  paperAverageReturnPct: number;
  attribution: RunAttribution[];
  fills: FillEvent[];
}

export interface NotificationEvent {
  id: string;
  createdAt: string;
  type: NotificationEventType;
  title: string;
  status: NotificationStatus;
  webhookUrl?: string;
  payload: unknown;
  error?: string;
  /** Connected account the event was recorded against (from the policy that
   *  triggered it). Absent for user-wide events and rows written before the
   *  column was surfaced — consumers must not assume the ACTIVE account. */
  connectedAccountId?: string;
  /** When the user (or an auto-ack sweep/repeat-dedup) marked this event as seen.
   *  Undefined means still unacknowledged — the row still counts toward "Attention". */
  acknowledgedAt?: string;
}

// --- Out-of-app multi-channel alert delivery (ported from Atlas) ---
/** Out-of-app delivery channels for triggered alerts. */
export type NotifyChannelId = "push" | "webhook" | "email" | "sms";

/** Per-user notification preferences: enabled channels + per-channel delivery target. */
export interface NotifyPrefs {
  userId: string;
  channels: NotifyChannelId[];
  pushTarget: string;
  webhookUrl: string;
  email: string;
  phone: string;
  updatedAt: string | null;
}

export interface NotifyMessage {
  title: string;
  body: string;
  kind?: string;
  data?: unknown;
}

export interface NotifyChannelResult {
  channel: NotifyChannelId;
  ok: boolean;
  skipped?: "not_configured" | "no_target";
  error?: string;
}

/** UI metadata so the client shows only usable channels and the right target field. */
export interface NotifyChannelDescriptor {
  id: NotifyChannelId;
  label: string;
  available: boolean;
  provider?: string | null;
  targetField: string;
  targetLabel: string;
  placeholder: string;
  hint: string;
}

// --- Conversation transcript (chat history, ported from Atlas) ---
export type ChatTurnRole = "user" | "assistant";

export interface ChatTurn {
  id: string;
  userId: string;
  role: ChatTurnRole;
  text: string;
  citations: string[];
  intent: string | null;
  /** True when redact-on-write stripped a secret/PII from `text` before persistence. */
  redacted: boolean;
  /** Model that produced this turn (assistant turns only, e.g. "gpt-5.4-mini", "claude-opus-4-8", "mock"). */
  model?: string | null;
  /** Client-generated idempotency key (user turns only): reused on Retry so a retried send doesn't duplicate the turn. */
  clientTurnId?: string | null;
  createdAt: string;
}

// --- Salience-gated per-user memory (Atlas Deep Dive 12) ---
export type MemoryKind = "constraint" | "preference" | "goal" | "correction" | "pattern" | "decision" | "oneoff";
export type MemoryDecision = "WRITE" | "HOLD" | "SKIP";

/** A scored extraction candidate (pre-persistence). */
export interface MemoryCandidate {
  kind: MemoryKind;
  subject: string;
  value: string;
  source: string;
  confidence: number;
  hard: boolean;
  specificity: number;
  pii: boolean;
}

/** A persisted memory. `supersededBy` non-null means it was reconciled away by a newer value. */
export interface MemoryItem {
  id: string;
  userId: string;
  kind: MemoryKind;
  subject: string;
  value: string;
  source: string;
  confidence: number;
  hard: boolean;
  assertedAt: string;
  supersededBy: string | null;
}

// ── learned_context (the tiered crossover-learning store) ──────────────────────
// A SQLite channel, distinct from user_memory and the Pinecone corpus, holding durable
// learned FACTS that reach the strategy brain ONLY as advisory prompt DATA — never as a
// numeric input to sizing or scoring weights. The risk classifier (classify.ts) is the
// single chokepoint: anything not clearly a non-risk fact is fail-closed to 'risk' and, in
// this fact-tier slice, is audit-logged-and-dropped (the pending queue is a later slice).
export type LearnedContextScope = "private" | "shared";
export type LearnedContextKind = "pattern" | "decision" | "fact";
export type LearnedContextOrigin = "chat" | "autonomous" | "ingest";
export type LearnedContextRiskTier = "fact" | "risk" | "strategy-directive";
/**
 * Which decision boundary a lesson is allowed to cross.
 *
 * - account: evidence learned from one connected broker account; exact-account retrieval only.
 * - portfolio: owner-supplied/general context that is safe across the owner's accounts.
 * - research: an explicitly transfer-tested result that may inform sibling accounts.
 * - legacy: pre-scoping autonomous data whose account provenance cannot be reconstructed.
 */
export type LearnedContextLearningScope = "account" | "portfolio" | "research" | "legacy";
/** Paper-derived research stays `candidate` until corroborated; only `validated` research is retrievable. */
export type LearnedContextTransferState = "not_applicable" | "candidate" | "validated" | "rejected";
export type LearnedContextAccountEnvironment = "paper" | "live";

/** A persisted learned-context row. `supersededBy` non-null means a newer fact replaced it. */
export interface LearnedContextRow {
  id: string;
  userId: string;
  scope: LearnedContextScope;
  kind: LearnedContextKind;
  subject: string;
  symbol: string | null;
  value: string;
  source: string;
  origin: LearnedContextOrigin;
  riskTier: LearnedContextRiskTier;
  confidence: number;
  contributorUserId: string | null;
  connectedAccountId: string | null;
  accountEnvironment: LearnedContextAccountEnvironment | null;
  learningScope: LearnedContextLearningScope;
  transferState: LearnedContextTransferState;
  assertedAt: string;
  supersededBy: string | null;
  expiresAt: string | null;
}

/** A pre-persistence learned-context candidate (origin/scope are assigned at ingest time). */
export interface LearnedContextCandidate {
  kind: LearnedContextKind;
  subject: string;
  value: string;
  symbol?: string | null;
  source?: string;
  confidence?: number;
  /** Optional intent hint from the producer; the classifier may use it to force 'risk'. */
  intent?: string;
}

/** Status of a queued risk-tier candidate awaiting explicit human confirmation. */
export type LearnedContextPendingStatus = "pending" | "approved" | "rejected";

/**
 * A risk-tier candidate (tier 'risk' | 'strategy-directive') from an autonomous/ingest producer that
 * was routed to the human confirmation queue instead of being audit-dropped. It lives OUTSIDE the
 * brain until a human approves it; approval applies it SAFELY (advisory promote / prompt append) and
 * NEVER auto-derives a numeric policy change. Chat-origin risk candidates are still hard-capped and
 * never reach this queue.
 */
export interface LearnedContextPendingRow {
  id: string;
  userId: string;
  scope: LearnedContextScope;
  kind: LearnedContextKind;
  subject: string;
  symbol: string | null;
  value: string;
  source: string;
  origin: LearnedContextOrigin;
  /** Only the two human-confirmable tiers are ever queued. */
  riskTier: Exclude<LearnedContextRiskTier, "fact">;
  connectedAccountId: string | null;
  accountEnvironment: LearnedContextAccountEnvironment | null;
  learningScope: LearnedContextLearningScope;
  transferState: LearnedContextTransferState;
  classifierReason: string | null;
  createdAt: string;
  status: LearnedContextPendingStatus;
  resolvedAt: string | null;
  /** Set only when the daily Learning Review LLM (src/lib/learning-review.ts) reviewed this item
   *  and returned a "defer" verdict — it could not confidently decide, so it left the item exactly
   *  as-is (still pending) and explained why here. Optional so every pre-existing row/fixture that
   *  never went through review (or was decided keep/reject) simply omits it. Null once approved or
   *  rejected? No — deliberately left in place even after resolution, so a human who acted on a
   *  previously-deferred item can still see why the reviewer punted it to them. */
  reviewNote?: string | null;
}

/**
 * Advisory result from the per-run rationale-diversity check (improvement-program item #8).
 *
 * Populated after proposals are generated; never blocks, drops, or modifies any proposal.
 * Persisted via `audit("rationale_diversity", ...)` and optionally attached to `StrategyResult`.
 */
export interface RationaleDiversity {
  /** Number of rationale strings evaluated. */
  count: number;
  /** Mean pairwise character-trigram Jaccard similarity across all N*(N-1)/2 pairs, in [0, 1]. */
  meanPairwiseSimilarity: number;
  /** Maximum pairwise similarity observed across any single pair, in [0, 1]. */
  maxPairwiseSimilarity: number;
  /** True when meanPairwiseSimilarity exceeds `threshold` — indicates likely template collapse. */
  collapsed: boolean;
  /** Similarity threshold used to set `collapsed` (default 0.85). */
  threshold: number;
}
