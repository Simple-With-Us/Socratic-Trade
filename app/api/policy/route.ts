import { DEFAULT_POLICY, DEFAULT_TAX_SETTINGS } from "@/lib/defaults";
import { getPolicy, setPolicy, setStrategyPrompt } from "@/lib/db";
import { isIndexUniverse, normalizeIncludedIndices } from "@/lib/index-universes";
import { getBrokerGateway } from "@/lib/broker";
import { stripNullsDeep } from "@/lib/policy-null-stripping";
import { normalizeExclusivePolicyCaps } from "@/lib/policy-normalization";
import { resolveRequestUserId } from "@/lib/request-user";
import {
  invalidSymbolMessage,
  newlyAddedInvalidSymbols,
  normalizePolicySymbolList,
  sanitizePolicySymbolList,
  validateNewCustomPolicySymbols
} from "@/lib/policy-symbol-validation";
import {
  MAX_MARKET_SCAN_CANDIDATE_LIMIT,
  MAX_MARKET_SCAN_OUTLIER_RESERVE,
  MIN_MARKET_SCAN_CANDIDATE_LIMIT,
  MIN_MARKET_SCAN_OUTLIER_RESERVE,
  normalizeMarketScanCandidateLimit,
  normalizeMarketScanOutlierReserve
} from "@/lib/scan-settings";
import { ALL_LLM_REASONING_EFFORTS, isDisallowedInteractiveStrategyReasoningConfig } from "@/lib/llm-request";
import { NOTIFICATION_EVENT_TYPES } from "@/lib/types";
import type { IndexUniverse, NotificationEventType, TradingPolicy } from "@/lib/types";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return NextResponse.json(getPolicy(resolveRequestUserId(request)));
}

export async function PUT(request: Request) {
  const body = await request.json();
  const userId = resolveRequestUserId(request, body);
  if (typeof body.strategyPrompt === "string") setStrategyPrompt(body.strategyPrompt, userId);
  const current = getPolicy(userId);
  const additionalSymbols = normalizePolicySymbolList(body.additionalSymbols, current.additionalSymbols ?? []);
  const blocklist = normalizePolicySymbolList(body.blocklist, current.blocklist ?? []);
  const invalidNewSymbols = newlyAddedInvalidSymbols([...additionalSymbols, ...blocklist], [
    ...(current.additionalSymbols ?? []),
    ...(current.blocklist ?? [])
  ]);
  if (invalidNewSymbols.length > 0) {
    return new NextResponse(invalidSymbolMessage(invalidNewSymbols), { status: 400 });
  }
  const customSymbolError = await validateNewCustomPolicySymbols(additionalSymbols, current.additionalSymbols ?? []);
  if (customSymbolError) return new NextResponse(customSymbolError, { status: 400 });
  const policy: TradingPolicy = {
    ...DEFAULT_POLICY,
    ...current,
    ...Object.fromEntries(Object.entries(body).filter(([key]) => key !== "strategyPrompt" && key !== "userId")),
    includedIndices: Array.isArray(body.includedIndices)
      ? normalizeIncludedIndices(Array.from(new Set(body.includedIndices.map(String).filter(isIndexUniverse))) as IndexUniverse[])
      : current.includedIndices,
    additionalSymbols: sanitizePolicySymbolList(additionalSymbols),
    blocklist: sanitizePolicySymbolList(blocklist),
    scoringWeights: {
      ...DEFAULT_POLICY.scoringWeights,
      ...current.scoringWeights,
      ...(typeof body.scoringWeights === "object" && body.scoringWeights ? body.scoringWeights : {})
    },
    sectorCaps: normalizeSectorCaps(typeof body.sectorCaps === "object" && body.sectorCaps ? body.sectorCaps : current.sectorCaps),
    riskRules: {
      ...DEFAULT_POLICY.riskRules,
      ...current.riskRules,
      ...(typeof body.riskRules === "object" && body.riskRules ? body.riskRules : {})
    },
    notificationSettings: {
      ...DEFAULT_POLICY.notificationSettings,
      ...current.notificationSettings,
      ...(typeof body.notificationSettings === "object" && body.notificationSettings ? body.notificationSettings : {}),
      enabledEvents:
        typeof body.notificationSettings === "object" &&
        body.notificationSettings &&
        Array.isArray(body.notificationSettings.enabledEvents)
          ? body.notificationSettings.enabledEvents.filter(isNotificationEvent)
          : current.notificationSettings.enabledEvents
    },
    taxSettings: {
      ...DEFAULT_TAX_SETTINGS,
      ...current.taxSettings,
      ...(typeof body.taxSettings === "object" && body.taxSettings ? body.taxSettings : {})
    },
    tuning: {
      ...current.tuning,
      ...(typeof body.tuning === "object" && body.tuning ? body.tuning : {})
    }
  };
  if (typeof body.redTeamLlmModel === "string" && body.redTeamLlmModel.trim().length === 0) {
    delete policy.redTeamLlmModel;
  }
  // The client serializes a CLEARED optional field as `null` (JSON.stringify drops `undefined`, which the
  // `...current` merge above would otherwise silently restore). Strip those nulls back to absent so blanking
  // a field actually turns the guard off / reverts it to its default.
  stripNullsDeep(policy as unknown as Record<string, unknown>);
  normalizeExclusivePolicyCaps(policy);
  // Only enforce the interactive gpt-5.5/high-reasoning rejection when THIS request actually
  // changes the model/effort combination. validatePolicy runs against the MERGED policy, so a
  // stored gpt-5.5+high config used to fail EVERY unrelated save (notification prefs, short
  // selling, ...) with a confusing model error. Stale stored configs are already safe at run
  // time — interactiveStrategyReasoningEffort clamps them to medium — so unrelated writes may
  // pass through; only a write that sets the disallowed combo is rejected.
  const reasoningConfigChanged =
    policy.llmModel !== current.llmModel ||
    policy.redTeamLlmModel !== current.redTeamLlmModel ||
    policy.llmReasoningEffort !== current.llmReasoningEffort;
  const validationError = await validatePolicy(policy, userId, { enforceInteractiveReasoningRule: reasoningConfigChanged });
  if (validationError) return new NextResponse(validationError, { status: 400 });
  setPolicy(policy, userId);
  return NextResponse.json(policy);
}

async function validatePolicy(
  policy: TradingPolicy,
  userId: string,
  options: { enforceInteractiveReasoningRule?: boolean } = {}
): Promise<string | undefined> {
  // Invalid legacy watchlist / ignore-list symbols are sanitized out in the PUT handler above, so stale
  // bad data cannot block unrelated policy updates. Newly added custom Additional Watchlist symbols are
  // quote-checked before save so the user gets an explicit reason when a ticker cannot be tracked.

  if (!["propose", "decide"].includes(policy.strategyAuthority)) return "strategyAuthority must be propose or decide.";
  if (policy.socraticOverrideMode !== undefined && !["off", "propose", "execute"].includes(policy.socraticOverrideMode)) return "socraticOverrideMode must be off, propose, or execute.";
  if (policy.socraticOverrideMaxPctOfNav !== undefined && (!Number.isFinite(policy.socraticOverrideMaxPctOfNav) || policy.socraticOverrideMaxPctOfNav <= 0 || policy.socraticOverrideMaxPctOfNav > 100)) return "socraticOverrideMaxPctOfNav must be between 0 and 100.";
  if (policy.sellToFundBuy !== undefined && !["off", "suggest", "propose", "automated"].includes(policy.sellToFundBuy)) return "sellToFundBuy must be off, suggest, propose, or automated.";
  if (policy.llmModel !== undefined && (typeof policy.llmModel !== "string" || policy.llmModel.trim().length === 0 || policy.llmModel.length > 64)) return "llmModel must be a non-empty model id.";
  if (policy.redTeamLlmModel !== undefined && (typeof policy.redTeamLlmModel !== "string" || policy.redTeamLlmModel.trim().length === 0 || policy.redTeamLlmModel.length > 64)) return "redTeamLlmModel must be a non-empty model id.";
  if (policy.llmReasoningEffort !== undefined && !ALL_LLM_REASONING_EFFORTS.includes(policy.llmReasoningEffort)) {
    return "llmReasoningEffort must be none, minimal, low, medium, high, xhigh, or max.";
  }
  if (
    (options.enforceInteractiveReasoningRule ?? true) &&
    (isDisallowedInteractiveStrategyReasoningConfig(policy.llmModel, policy.llmReasoningEffort) ||
      isDisallowedInteractiveStrategyReasoningConfig(policy.redTeamLlmModel, policy.llmReasoningEffort))
  ) return "gpt-5.5 with high reasoning is disabled for interactive strategy runs. Use medium/low reasoning or choose a faster model.";
  if (policy.holdingHorizon && !["intraday", "swing", "position", "longterm"].includes(policy.holdingHorizon)) return "holdingHorizon must be intraday, swing, position, or longterm.";
  if (policy.maxOrderNotional !== undefined && policy.maxOrderNotional <= 0) return "maxOrderNotional must be positive.";
  if (policy.maxOrderPctOfNav !== undefined && (policy.maxOrderPctOfNav <= 0 || policy.maxOrderPctOfNav > 100)) return "maxOrderPctOfNav must be between 0 and 100.";
  if (policy.maxDailyNotional !== undefined && policy.maxOrderNotional !== undefined && policy.maxDailyNotional < policy.maxOrderNotional) return "maxDailyNotional must be at least maxOrderNotional.";
  if (policy.maxSymbolExposurePct !== undefined && (policy.maxSymbolExposurePct <= 0 || policy.maxSymbolExposurePct > 100)) return "maxSymbolExposurePct must be between 0 and 100.";
  if (policy.maxPortfolioBeta !== undefined && (!Number.isFinite(policy.maxPortfolioBeta) || policy.maxPortfolioBeta <= 0 || policy.maxPortfolioBeta > 10)) return "maxPortfolioBeta must be a positive number (≤ 10).";
  if (policy.maxAvgCorrelation !== undefined && (!Number.isFinite(policy.maxAvgCorrelation) || policy.maxAvgCorrelation <= 0 || policy.maxAvgCorrelation > 1)) return "maxAvgCorrelation must be between 0 (off) and 1.";
  if (policy.maxEntryDriftPct !== undefined && (!Number.isFinite(policy.maxEntryDriftPct) || policy.maxEntryDriftPct < 0 || policy.maxEntryDriftPct > 100)) return "maxEntryDriftPct must be between 0 (off) and 100.";
  if (policy.tuning?.llmDailyTokenBudget !== undefined && (!Number.isFinite(policy.tuning.llmDailyTokenBudget) || policy.tuning.llmDailyTokenBudget < 0)) return "tuning.llmDailyTokenBudget must be a non-negative number (0 = no limit).";
  if (policy.tuning?.llmDailyCostBudgetUsd !== undefined && (!Number.isFinite(policy.tuning.llmDailyCostBudgetUsd) || policy.tuning.llmDailyCostBudgetUsd < 0)) return "tuning.llmDailyCostBudgetUsd must be a non-negative number (0 = no limit).";
  if (policy.atrStops !== undefined && typeof policy.atrStops !== "boolean") return "atrStops must be a boolean.";
  if (policy.riskRules.atrStopPeriod !== undefined && (!Number.isInteger(policy.riskRules.atrStopPeriod) || policy.riskRules.atrStopPeriod < 5 || policy.riskRules.atrStopPeriod > 100)) return "riskRules.atrStopPeriod must be an integer between 5 and 100.";
  if (policy.riskRules.atrStopMultiple !== undefined && (!Number.isFinite(policy.riskRules.atrStopMultiple) || policy.riskRules.atrStopMultiple <= 0 || policy.riskRules.atrStopMultiple > 10)) return "riskRules.atrStopMultiple must be between 0 (exclusive) and 10.";
  if (policy.maxGrossExposurePct !== undefined && (!Number.isFinite(policy.maxGrossExposurePct) || policy.maxGrossExposurePct <= 0 || policy.maxGrossExposurePct > 100)) return "maxGrossExposurePct must be between 0 and 100.";
  if (policy.maxNetExposurePct !== undefined && (!Number.isFinite(policy.maxNetExposurePct) || policy.maxNetExposurePct <= 0 || policy.maxNetExposurePct > 100)) return "maxNetExposurePct must be between 0 and 100.";
  if (policy.maxShortExposurePct !== undefined && (!Number.isFinite(policy.maxShortExposurePct) || policy.maxShortExposurePct <= 0 || policy.maxShortExposurePct > 100)) return "maxShortExposurePct must be between 0 and 100.";
  if (policy.maxShortOrderNotional !== undefined && (!Number.isFinite(policy.maxShortOrderNotional) || policy.maxShortOrderNotional <= 0)) return "maxShortOrderNotional must be positive.";
  if (policy.maxOrderPctOfAdv !== undefined && (!Number.isFinite(policy.maxOrderPctOfAdv) || policy.maxOrderPctOfAdv <= 0 || policy.maxOrderPctOfAdv > 100)) return "maxOrderPctOfAdv must be between 0 and 100.";
  if (policy.maxQuoteAgeSec !== undefined && (!Number.isFinite(policy.maxQuoteAgeSec) || policy.maxQuoteAgeSec < 0)) return "maxQuoteAgeSec must be a non-negative number of seconds (0 or blank disables).";
  if (policy.maxFundamentalsAgeSec !== undefined && (!Number.isFinite(policy.maxFundamentalsAgeSec) || policy.maxFundamentalsAgeSec < 0)) return "maxFundamentalsAgeSec must be a non-negative number of seconds (0 or blank disables).";
  if (policy.volPanicVixThreshold !== undefined && (!Number.isFinite(policy.volPanicVixThreshold) || policy.volPanicVixThreshold < 0)) return "volPanicVixThreshold must be a non-negative number.";
  if (policy.volPanicVvixThreshold !== undefined && (!Number.isFinite(policy.volPanicVvixThreshold) || policy.volPanicVvixThreshold < 0)) return "volPanicVvixThreshold must be a non-negative number.";
  if (policy.volPanicSkewThreshold !== undefined && (!Number.isFinite(policy.volPanicSkewThreshold) || policy.volPanicSkewThreshold < 0)) return "volPanicSkewThreshold must be a non-negative number.";
  if (policy.permittedOrderTypes !== undefined) {
    const validTypes = ["market", "limit", "stop_market", "stop_limit"];
    if (!Array.isArray(policy.permittedOrderTypes) || policy.permittedOrderTypes.some((t) => !validTypes.includes(String(t)))) {
      return "permittedOrderTypes must be a subset of market, limit, stop_market, stop_limit.";
    }
  }
  if (policy.universeFloor !== undefined) {
    for (const key of ["minPrice", "minMarketCapUsd", "minDollarVolume"] as const) {
      const v = policy.universeFloor[key];
      if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || v < 0)) return `universeFloor.${key} must be a non-negative number.`;
    }
  }
  if (policy.riskRules.takeProfitTrimPct !== undefined && (!Number.isFinite(policy.riskRules.takeProfitTrimPct) || policy.riskRules.takeProfitTrimPct <= 0 || policy.riskRules.takeProfitTrimPct > 100)) return "riskRules.takeProfitTrimPct must be between 0 (exclusive) and 100.";
  if (policy.riskRules.maxDrawdownPct !== undefined && policy.riskRules.maxDrawdownPct > 100) return "riskRules.maxDrawdownPct must be between 0 and 100.";
  if (policy.riskRules.trailingStopPct !== undefined && policy.riskRules.trailingStopPct > 100) return "riskRules.trailingStopPct must be between 0 and 100.";
  if (policy.maxDailyOrders <= 0) return "maxDailyOrders must be positive.";
  if (policy.marketScanCandidateLimit !== undefined) {
    if (normalizeMarketScanCandidateLimit(policy.marketScanCandidateLimit) !== policy.marketScanCandidateLimit) {
      return `marketScanCandidateLimit must be an integer between ${MIN_MARKET_SCAN_CANDIDATE_LIMIT} and ${MAX_MARKET_SCAN_CANDIDATE_LIMIT}.`;
    }
  }
  if (policy.marketScanOutlierReserve !== undefined) {
    const candidateLimit = normalizeMarketScanCandidateLimit(policy.marketScanCandidateLimit);
    if (
      normalizeMarketScanOutlierReserve(policy.marketScanOutlierReserve, candidateLimit) !== policy.marketScanOutlierReserve ||
      policy.marketScanOutlierReserve > candidateLimit
    ) {
      return `marketScanOutlierReserve must be an integer between ${MIN_MARKET_SCAN_OUTLIER_RESERVE} and ${Math.min(MAX_MARKET_SCAN_OUTLIER_RESERVE, candidateLimit)}.`;
    }
  }
  if (policy.runCadenceMinutes < 1) return "runCadenceMinutes must be at least 1 minute.";
  if (policy.proposalExpiryMinutes !== undefined && (!Number.isFinite(policy.proposalExpiryMinutes) || policy.proposalExpiryMinutes < 0)) return "proposalExpiryMinutes must be 0 (off) or a positive number of minutes.";
  if (policy.proposalRevalidateCadenceHours !== undefined && (!Number.isFinite(policy.proposalRevalidateCadenceHours) || policy.proposalRevalidateCadenceHours < 0)) return "proposalRevalidateCadenceHours must be 0 (off) or a positive number of hours.";
  if (policy.staleLimitOrderMinutes !== undefined && (!Number.isFinite(policy.staleLimitOrderMinutes) || policy.staleLimitOrderMinutes < 0)) return "staleLimitOrderMinutes must be 0 (off) or a positive number of minutes.";
  if (Object.values(policy.scoringWeights).some((value) => !Number.isFinite(Number(value)) || Number(value) < 0)) return "scoring weights must be non-negative numbers.";
  if (Object.values(policy.sectorCaps).some((value) => !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 100)) return "sector caps must be between 0 and 100.";
  if (policy.riskRules.drawdownBreakerAction !== undefined && !["advisory", "close_only", "halt"].includes(policy.riskRules.drawdownBreakerAction)) return "riskRules.drawdownBreakerAction must be advisory, close_only, or halt.";
  // drawdownBreakerAction is a string enum (validated above), so exclude it from the numeric sweep — an
  // enum value like "close_only" is NaN under Number(...) and would otherwise reject the whole save (and
  // then every subsequent save, since it is merged from `...current.riskRules`).
  if (Object.entries(policy.riskRules).some(([key, value]) => key !== "drawdownBreakerAction" && value !== undefined && (!Number.isFinite(Number(value)) || Number(value) < 0))) return "risk rules must be non-negative numbers.";
  if (policy.taxSettings) {
    const { shortTermRatePct, longTermRatePct, washSaleMinLossUsd, washSaleHandling, iraWashSaleHandling } = policy.taxSettings;
    if (!Number.isFinite(shortTermRatePct) || shortTermRatePct < 0 || shortTermRatePct > 100) return "shortTermRatePct must be between 0 and 100.";
    if (!Number.isFinite(longTermRatePct) || longTermRatePct < 0 || longTermRatePct > 100) return "longTermRatePct must be between 0 and 100.";
    if (washSaleMinLossUsd !== undefined && (!Number.isFinite(washSaleMinLossUsd) || washSaleMinLossUsd < 0)) return "taxSettings.washSaleMinLossUsd must be a non-negative dollar amount (blank = every loss locks).";
    if (washSaleHandling !== undefined && !["block", "ask", "auto"].includes(washSaleHandling)) return "taxSettings.washSaleHandling must be block, ask, or auto.";
    if (iraWashSaleHandling !== undefined && !["block", "disregard"].includes(iraWashSaleHandling)) return "taxSettings.iraWashSaleHandling must be block or disregard.";
  }
  if (policy.llmFallbackModels !== undefined && (!Array.isArray(policy.llmFallbackModels) || policy.llmFallbackModels.some((m) => typeof m !== "string"))) {
    return "llmFallbackModels must be an array of model-id strings.";
  }
  if (policy.tuning) {
    const { shrinkPrior, minClosedLotsForWeightShift, sizingFloorPct, sizingCeilingPct, redTeamConvictionThreshold, crisisMaxOpeningExposurePct, bearVetoFcfYieldFloorPct, bearVetoDebtToEquityCeiling, skipNegativeExpectancy, skipNegativeExpectancyEdgePct, gateOnRationaleCollapse } = policy.tuning;
    if (shrinkPrior !== undefined && (!Number.isFinite(shrinkPrior) || shrinkPrior < 0 || shrinkPrior > 100)) return "tuning.shrinkPrior must be between 0 and 100.";
    if (minClosedLotsForWeightShift !== undefined && (!Number.isFinite(minClosedLotsForWeightShift) || minClosedLotsForWeightShift < 1 || minClosedLotsForWeightShift > 1000)) return "tuning.minClosedLotsForWeightShift must be between 1 and 1000.";
    if (sizingFloorPct !== undefined && (!Number.isFinite(sizingFloorPct) || sizingFloorPct < 0 || sizingFloorPct > 100)) return "tuning.sizingFloorPct must be between 0 and 100.";
    if (sizingCeilingPct !== undefined && (!Number.isFinite(sizingCeilingPct) || sizingCeilingPct < 1 || sizingCeilingPct > 100)) return "tuning.sizingCeilingPct must be between 1 and 100.";
    if (sizingFloorPct !== undefined && sizingCeilingPct !== undefined && sizingFloorPct > sizingCeilingPct) return "tuning.sizingFloorPct must not exceed sizingCeilingPct.";
    if (redTeamConvictionThreshold !== undefined && (!Number.isFinite(redTeamConvictionThreshold) || redTeamConvictionThreshold < 0 || redTeamConvictionThreshold > 100)) return "tuning.redTeamConvictionThreshold must be between 0 and 100.";
    if (crisisMaxOpeningExposurePct !== undefined && (!Number.isFinite(crisisMaxOpeningExposurePct) || crisisMaxOpeningExposurePct < 0 || crisisMaxOpeningExposurePct > 100)) return "tuning.crisisMaxOpeningExposurePct must be between 0 and 100.";
    if (bearVetoFcfYieldFloorPct !== undefined && (!Number.isFinite(bearVetoFcfYieldFloorPct) || bearVetoFcfYieldFloorPct < -100 || bearVetoFcfYieldFloorPct > 100)) return "tuning.bearVetoFcfYieldFloorPct must be between -100 and 100.";
    if (bearVetoDebtToEquityCeiling !== undefined && (!Number.isFinite(bearVetoDebtToEquityCeiling) || bearVetoDebtToEquityCeiling < 0)) return "tuning.bearVetoDebtToEquityCeiling must be a non-negative number.";
    if (skipNegativeExpectancy !== undefined && typeof skipNegativeExpectancy !== "boolean") return "tuning.skipNegativeExpectancy must be a boolean.";
    if (gateOnRationaleCollapse !== undefined && typeof gateOnRationaleCollapse !== "boolean") return "tuning.gateOnRationaleCollapse must be a boolean.";
    if (skipNegativeExpectancyEdgePct !== undefined && (!Number.isFinite(skipNegativeExpectancyEdgePct) || skipNegativeExpectancyEdgePct < -100 || skipNegativeExpectancyEdgePct > 100)) return "tuning.skipNegativeExpectancyEdgePct must be between -100 and 100.";
  }
  if (policy.notificationSettings.webhookUrl?.trim()) {
    try {
      new URL(policy.notificationSettings.webhookUrl);
    } catch {
      return "webhookUrl must be a valid URL.";
    }
  }
  if (policy.systemState === "active" && !policy.accountNumber) return "Select an account before enabling autonomy.";
  if (policy.systemState === "active" && policy.includedIndices.length === 0 && policy.additionalSymbols.length === 0) return "Select at least one base index or additional watchlist symbol before enabling autonomy.";
  if (policy.systemState === "active" && policy.accountNumber) {
    // Don't let a transient broker/network failure here surface as an unhandled 500 (which renders as a
    // raw error page) — return a clean, actionable message instead.
    try {
      const accounts = await getBrokerGateway(policy, userId).getAccounts();
      const account = accounts.find((item) => item.accountNumber === policy.accountNumber);
      if (!account) return "Selected account is not available.";
      if (!account.agenticAllowed) return "Selected account is not agentic_allowed.";
    } catch {
      return "Could not verify the selected account right now. Please try again in a moment.";
    }
  }
}

function normalizeSectorCaps(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, raw]) => [key.trim(), Number(raw)] as const)
      .filter(([key, cap]) => key.length > 0 && Number.isFinite(cap))
  );
}

function isNotificationEvent(value: unknown): value is NotificationEventType {
  return NOTIFICATION_EVENT_TYPES.includes(value as NotificationEventType);
}
