import { NOTIFICATION_EVENT_TYPES } from "./types";
import type { NotificationSettings, RiskRules, ScoringWeights, TaxSettings, TradingPolicy } from "./types";
import { DEFAULT_MARKET_SCAN_CANDIDATE_LIMIT, DEFAULT_MARKET_SCAN_OUTLIER_RESERVE } from "./scan-settings";

export const DEFAULT_TAX_SETTINGS: TaxSettings = {
  washSaleGuard: true,
  // Owner decision (2026-07-03): the wash-sale gate is advisory, not a hard block, by default.
  // "auto" always proceeds — an earlier deterministic edge-vs-tax-cost veto was removed because it
  // re-arithmetized the LLM's own outputs (confidenceScore, bracketTakeProfit) rather than adding
  // independent judgment. The priced tax cost still rides the decision as receipt telemetry and is
  // threaded into the strategist prompt so the model weighs it against conviction itself. "block"
  // and "ask" remain valid, stricter opt-ins (see policy.ts) for anyone who wants the old hard-stop
  // or a priced approval prompt.
  washSaleHandling: "auto",
  // IRA-replacement rebuys (Rev. Rul. 2008-5) default to "disregard" for the same reason: brokers
  // do not report cross-account IRA wash sales to the IRS, so the permanent-loss-forfeiture rule
  // only bites under audit — the owner treats that as their call, not a hard system stop. Every
  // disregarded purchase is still annotated + audited ("Wash Sale (Technically, but IRA purchase
  // unreported to IRS)"); "block" remains available as a stricter per-account opt-in.
  iraWashSaleHandling: "disregard",
  shortTermRatePct: 24,
  longTermRatePct: 15
};

export const DEFAULT_SCORING_WEIGHTS: ScoringWeights = {
  liquidity: 1.4,
  momentum: 1.2,
  value: 0.8,
  quality: 0.8,
  volatility: 0.8,
  sentiment: 0.6,
  positioning: 0.8,
  diversification: 1
};

export const DEFAULT_RISK_RULES: RiskRules = {
  stopLossPct: 8,
  takeProfitPct: 20,
  // Take partial profit at the target and let the rest ride (laddered per take-profit band).
  takeProfitTrimPct: 50,
  trailingStopPct: 0
};

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  webhookUrl: "",
  enabledEvents: [...NOTIFICATION_EVENT_TYPES]
};

export const DEFAULT_POLICY: TradingPolicy = {
  systemState: "halted",
  includedIndices: ["sp500"],
  additionalSymbols: [],
  blocklist: [],
  // Penny/illiquid exclusion for the SCANNED universe (explicit symbols + held positions always exempt).
  // No-op for the default S&P-500 universe (every member clears it); it bites only when the universe is
  // broadened to other indexes / the wider screener. Tunable in settings.
  universeFloor: { minPrice: 5, minMarketCapUsd: 100_000_000, minDollarVolume: 1_000_000 },
  strategyAuthority: "propose",
  socraticOverrideMode: "execute",
  socraticOverrideMaxPctOfNav: 100,
  sellToFundBuy: "off",
  llmModel: "gpt-5.4-mini",
  llmReasoningEffort: "medium",
  holdingHorizon: "swing",
  maxOrderPctOfNav: 5,
  maxDailyNotional: 500,
  maxSymbolExposurePct: 25,
  maxGrossExposurePct: 80,  // keep ≥20% cash buffer by default; users can raise in policy settings
  maxNetExposurePct: 80,    // consistent with gross; net > gross is impossible for long-only anyway
  maxEntryDriftPct: 10,     // reject a stale opening market/dollar order whose price drifted >10% from the proposed entry
  maxOrderPctOfAdv: 5,      // cap an opening order at 5% of the name's recent daily $-volume (market-impact guard; rarely binds for small accounts/liquid names)
  volPanicBrakeEnabled: true, // flip active→close_only on a rare VIX/VVIX/SKEW tail extreme (defaults below)
  volPanicVixThreshold: 40,
  volPanicVvixThreshold: 150,
  volPanicSkewThreshold: 160,
  brokerBracketsEnabled: true, // attach broker-held stop/take brackets on native-bracket brokers (Alpaca)
  robinhoodBrokerStops: false, // opt-in: true broker-held resting stop on live Robinhood (verify RH MCP stop semantics first)
  maxDailyOrders: 10,
  maxProposalsPerRun: 3,
  marketScanCandidateLimit: DEFAULT_MARKET_SCAN_CANDIDATE_LIMIT,
  marketScanOutlierReserve: DEFAULT_MARKET_SCAN_OUTLIER_RESERVE,
  proposalExpiryMinutes: 2880,
  proposalRevalidateCadenceHours: 0,
  staleLimitOrderMinutes: 15,
  permittedOrderTypes: ["market", "limit"],
  permitExtendedHours: false,
  runCadenceMinutes: 60,
  runDuringExtendedHours: false,
  scoringWeights: DEFAULT_SCORING_WEIGHTS,
  sectorCaps: {},
  riskRules: DEFAULT_RISK_RULES,
  notificationSettings: DEFAULT_NOTIFICATION_SETTINGS,
  taxSettings: DEFAULT_TAX_SETTINGS
  // No default broker: a fresh policy is broker-neutral. activeBroker is set when a real broker is
  // connected (see db-profiles.ts). With no connected account the app cannot place orders — there is
  // no local-sim fallback.
};

export const DEFAULT_STRATEGY_PROMPT = `OBJECTIVE
Maximize risk-adjusted total return on this equity account. Compound gains by rotating capital toward the strongest opportunities in the allowed universe each session.

SELECTION LOGIC
Use the market scan's topCandidates as your primary opportunity set — they are pre-ranked by a composite score of volume, momentum, and portfolio underweight. Apply judgment on top of that ranking:

  1. Prioritize candidates with strong intraday momentum (intradayChangePct > 0) AND above-average volume. High volume confirms conviction behind a move.
  2. Among equally ranked candidates, prefer sectors not already represented in the portfolio. Concentration in one sector amplifies risk without improving expected return.
  3. Avoid stocks showing a sharp single-day spike (>8%) with no prior momentum — these often revert. Prefer steady climbers over one-day wonders.
  4. Give meaningful weight to names already held that are continuing to trend — adding to a winner within position limits is higher conviction than buying something new.

SELL AND TRIM RULES
  - Trim any position that has grown above maxSymbolExposurePct. Rebalancing into other opportunities is better than letting a single name dominate.
  - Sell a held position if it is down more than 8% intraday with no sector-wide explanation. Cut losers early; the opportunity cost of staying in a falling stock is real.
  - If a held stock ranks near the bottom of the current scan while another candidate ranks highly, propose a rotation: sell the laggard, fund the leader.

SIZING AND LIMITS
  - Choose a fresh advised size for every proposal from the trade's risk/reward, conviction, liquidity, diversification, and account context. maxOrderNotional is a hard safety cap, not the default target.
  - Respect remainingDailyOrders — if it is low, concentrate on the single best trade rather than spreading across several mediocre ones.
  - Use market orders for stocks with marketCap >= $5B. Use limit orders for stocks with marketCap < $5B or where marketCap is unknown.
  - If a candidate includes an ask price, a buy limit may be priced near or slightly below ask. If no ask price is provided, do not invent one; use market orders for liquid names or current price-based limits for smaller names.
  - Dollar-amount orders must use regular_hours.

OUTPUT
Return a JSON proposals array. Each entry requires: symbol, side, type, dollarAmount or quantity, timeInForce (gfd), marketHours, and a rationale. The rationale must be specific — name the signal (e.g. "ranked #2 in scan, +2.1% on 3× average volume, no sector overlap" or "position exceeded 26% allocation, trimming to fund higher-ranked scan candidates"). Vague rationales like "looks good" are not acceptable.`;
