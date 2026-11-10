import { normalizeSymbol } from "./money";
import { deriveMetrics } from "./derived-metrics";
import { buildSourceAblations } from "./source-value";
import type { CandidateEvidence, MarketQuote, OrderSide, ScoringWeights } from "./types";

/** Max web-source bulletins to keep per candidate in the persisted digest. */
const MAX_BULLETINS = 3;

/**
 * Build the compact per-candidate evidence digest persisted in the per-run
 * `signal_snapshot` audit (see {@link CandidateEvidence}). Works for both the
 * chosen set (pass side/status/thesisTag) and the skipped set (omit them), so a
 * single shape covers the whole scored universe. `undefined` fields are dropped by
 * `JSON.stringify` at the audit boundary, so the stored row stays small.
 */
export function buildCandidateEvidence(
  quote: MarketQuote | undefined,
  opts: {
    symbol: string;
    chosen: boolean;
    regime: string;
    side?: OrderSide;
    status?: string;
    thesisTag?: string;
    scoringWeights?: ScoringWeights;
  }
): CandidateEvidence {
  const q = quote;
  // Derived ratios (PEG, earnings yield, ROE, payout, $ volume, spread) computed from the
  // same quote — captured at decision time so future learning can attribute outcomes to them.
  const derived = q ? deriveMetrics(q) : undefined;
  return {
    symbol: normalizeSymbol(opts.symbol),
    chosen: opts.chosen,
    ...(opts.side ? { side: opts.side } : {}),
    ...(opts.status ? { status: opts.status } : {}),
    ...(opts.thesisTag ? { thesisTag: opts.thesisTag } : {}),
    regime: opts.regime,
    score: q?.score,
    refPrice: q?.price,
    sector: q?.sector,
    factorBreakdown: q?.factorBreakdown,
    congressNet: q?.senateTrades,
    insiderSentiment: q?.insiderSentiment,
    shortPercentOfFloat: q?.shortPercentOfFloat,
    beta: q?.beta,
    intradayChangePct: q?.intradayChangePct,
    sectorRelStrength: q?.sectorRelStrength,
    technicalScore: q?.technicalScore,
    technicalDirection: q?.technicalDirection,
    technicalSignals: q?.technicalSignals,
    congressCompositeScore: q?.congressCompositeScore,
    congressCompositeSignedScore: q?.congressCompositeSignedScore,
    congressCompositeDirection: q?.congressCompositeDirection,
    congressCompositeConfidence: q?.congressCompositeConfidence,
    congressCompositeComponents: q?.congressCompositeComponents,
    congressCompositeProvenance: q?.congressCompositeProvenance,
    congressCompositeVersion: q?.congressCompositeVersion,
    congressCompositeWeights: q?.congressCompositeWeights,
    preCongressScore: q?.preCongressScore,
    congressMemberSkillScore: q?.congressMemberSkillScore,
    congressMemberSkillSource: q?.congressMemberSkillSource,
    congressMemberFilerId: q?.congressMemberFilerId,
    congressMemberFilingAvgExcess: q?.congressMemberFilingAvgExcess,
    congressMemberFilingWinRate: q?.congressMemberFilingWinRate,
    congressMemberFilingScoredCount: q?.congressMemberFilingScoredCount,
    congressMemberFilingAvgAnnualizedExcess: q?.congressMemberFilingAvgAnnualizedExcess,
    congressMemberTradeAvgExcess: q?.congressMemberTradeAvgExcess,
    congressMemberTradeWinRate: q?.congressMemberTradeWinRate,
    congressMemberTradeScoredCount: q?.congressMemberTradeScoredCount,
    asOf: q?.asOf,
    provider: q?.provider,
    bid: q?.bid,
    ask: q?.ask,
    bidSize: q?.bidSize,
    askSize: q?.askSize,
    volume: q?.volume,
    fetchedAt: q?.fetchedAt,
    delayedFallback: q?.delayedFallback,
    syntheticBid: q?.syntheticBid,
    syntheticAsk: q?.syntheticAsk,
    venuePriceAuthoritative: q?.venuePriceAuthoritative,
    sources: q?.sources,
    ...(q ? { sourceAblations: buildSourceAblations(q, opts.scoringWeights) } : {}),
    providerFailures: q?.providerFailures,
    bulletins: q?.evidenceBulletins?.slice(0, MAX_BULLETINS),
    ...(derived && Object.keys(derived).length > 0 ? { derived } : {})
  };
}
