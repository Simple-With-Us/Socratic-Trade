/**
 * Zod schema for PUT /api/policy.  The route still applies domain validation after this
 * parse; this schema only rejects non-objects, unknown keys, and wrong field types.
 * Optional fields accept `null` so a client can clear them (see stripNullsDeep).
 */
import { z } from "zod";

const optionalString = z.string().nullable().optional();
const optionalNumber = z.number().nullable().optional();
const optionalBoolean = z.boolean().nullable().optional();
// Lists stay loosely typed so route-level validators keep their specific 400 messages.
const optionalList = z.unknown().nullable().optional();
const optionalObject = z.record(z.string(), z.unknown()).nullable().optional();

export const PolicyUpdateSchema = z
  .object({
    // Request-only fields (not all are persisted as policy columns).
    strategyPrompt: optionalString,
    userId: optionalString,
    targetConnectedAccountId: optionalString,

    systemState: optionalString,
    accountNumber: optionalString,
    connectedAccountId: optionalString,
    includedIndices: optionalList,
    additionalSymbols: optionalList,
    blocklist: optionalList,
    universeFloor: optionalObject,
    strategyAuthority: optionalString,
    requireTypedConfirmation: optionalBoolean,
    socraticOverrideMode: optionalString,
    socraticOverrideMaxPctOfNav: optionalNumber,
    sellToFundBuy: optionalString,
    llmModel: optionalString,
    redTeamLlmModel: optionalString,
    rotationPin: optionalObject,
    learningReviewEnabled: optionalBoolean,
    learningReviewMode: optionalString,
    learningReviewModel: optionalString,
    learningReviewReasoningEffort: optionalString,
    learningReviewMinNewLessons: z.union([z.number(), z.string()]).nullable().optional(),
    learningReviewMaxWaitDays: z.union([z.number(), z.string()]).nullable().optional(),
    outcomeGradingMode: optionalString,
    benchmarkMode: optionalString,
    llmFallbackModels: optionalList,
    redTeamFallbackModels: optionalList,
    llmRotationModels: optionalList,
    redTeamRotationModels: optionalList,
    llmReasoningEffort: optionalString,
    redTeamReasoningEffort: optionalString,
    holdingHorizon: optionalString,
    maxOrderNotional: optionalNumber,
    maxOrderPctOfNav: optionalNumber,
    maxDailyNotional: optionalNumber,
    maxHourlyNotional: optionalNumber,
    allowExtendedHoursSyntheticStops: optionalBoolean,
    maxDailyPctOfNav: optionalNumber,
    maxSymbolExposurePct: optionalNumber,
    maxSymbolExposureNotional: optionalNumber,
    maxGrossExposurePct: optionalNumber,
    maxNetExposurePct: optionalNumber,
    maxDailyOrders: optionalNumber,
    maxProposalsPerRun: optionalNumber,
    marketScanCandidateLimit: optionalNumber,
    marketScanOutlierReserve: optionalNumber,
    proposalExpiryMinutes: optionalNumber,
    proposalRevalidateCadenceHours: optionalNumber,
    staleLimitOrderMinutes: optionalNumber,
    autoRemediateStaleExits: optionalBoolean,
    brokerMinimumHandling: optionalString,
    permittedOrderTypes: optionalList,
    permitExtendedHours: optionalBoolean,
    runCadenceMinutes: optionalNumber,
    runDuringExtendedHours: optionalBoolean,
    scoringWeights: optionalObject,
    sectorCaps: optionalObject,
    riskRules: optionalObject,
    notificationSettings: optionalObject,
    taxSettings: optionalObject,
    tuning: optionalObject,
    triggerSettings: optionalObject,
    activeProfileId: optionalString,
    activeBroker: optionalString,
    shortSellingEnabled: optionalBoolean,
    brokerStopsForShorts: optionalBoolean,
    exitsReleaseAppStops: optionalBoolean,
    optionsTradingEnabled: optionalBoolean,
    eventContractsEnabled: optionalBoolean,
    maxShortOrderNotional: optionalNumber,
    maxShortExposurePct: optionalNumber,
    maxPortfolioBeta: optionalNumber,
    maxAvgCorrelation: optionalNumber,
    maxEntryDriftPct: optionalNumber,
    secondaryBuyPullbackPct: optionalNumber,
    brokerBracketsEnabled: optionalBoolean,
    robinhoodBrokerStops: optionalBoolean,
    brokerTrailingStops: optionalBoolean,
    betaScaledStops: optionalBoolean,
    atrStops: optionalBoolean,
    marketableLimitEntries: optionalBoolean,
    maxOrderPctOfAdv: optionalNumber,
    volPanicBrakeEnabled: optionalBoolean,
    volPanicVixThreshold: optionalNumber,
    volPanicVvixThreshold: optionalNumber,
    volPanicSkewThreshold: optionalNumber,
    maxQuoteAgeSec: optionalNumber,
    maxFundamentalsAgeSec: optionalNumber,
    fmpRealTimeDataEnabled: optionalBoolean,
    fmpMacroDataEnabled: optionalBoolean,
    kalshiMacroEnabled: optionalBoolean,
    fmpEventsDataEnabled: optionalBoolean,
    fmpFundamentalsDataEnabled: optionalBoolean
  })
  .strict();

export type PolicyUpdatePayload = z.infer<typeof PolicyUpdateSchema>;
