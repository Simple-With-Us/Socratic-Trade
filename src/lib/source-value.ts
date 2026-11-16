import { scoreFactors } from "./market";
import type {
  EnrichmentSources,
  MarketQuote,
  ScoringWeights,
  SourceAblationReceipt,
  SourceCoverageReceipt,
  SourceValueStat
} from "./types";

/**
 * Score-affecting enrichment fields and the neutral value used by the decision-time shadow pass.
 * The pass never fabricates a replacement provider. It asks the narrower question: how would the
 * deterministic score have moved if fields won by this provider had been unavailable?
 */
const SCORE_FIELD_NEUTRALIZERS: Partial<
  Record<keyof EnrichmentSources, (quote: Record<string, unknown>) => void>
> = {
  volume: (quote) => { quote.volume = 0; },
  intradayChangePct: (quote) => { quote.intradayChangePct = 0; },
  sentiment: (quote) => { quote.sentiment = undefined; },
  peRatio: (quote) => { quote.peRatio = undefined; },
  shortPercentOfFloat: (quote) => { quote.shortPercentOfFloat = undefined; },
  beta: (quote) => { quote.beta = undefined; },
  fiftyTwoWeekHigh: (quote) => { quote.fiftyTwoWeekHigh = undefined; },
  fiftyTwoWeekLow: (quote) => { quote.fiftyTwoWeekLow = undefined; },
  insiderSentiment: (quote) => { quote.insiderSentiment = undefined; },
  fcfYield: (quote) => { quote.fcfYield = undefined; },
  debtToEquity: (quote) => { quote.debtToEquity = undefined; },
  epsGrowth: (quote) => { quote.epsGrowth = undefined; },
  senateTrades: (quote) => { quote.senateTrades = undefined; }
};

function round(value: number, digits = 2): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

/** Build deterministic leave-one-winning-provider-out receipts while the full quote still exists. */
export function buildSourceAblations(
  quote: MarketQuote,
  scoringWeights?: ScoringWeights
): SourceAblationReceipt[] {
  const byProvider = new Map<string, Array<keyof EnrichmentSources>>();
  for (const [field, rawProvider] of Object.entries(quote.sources ?? {}) as Array<[keyof EnrichmentSources, string]>) {
    const provider = rawProvider?.trim();
    if (!provider) continue;
    const fields = byProvider.get(provider) ?? [];
    fields.push(field);
    byProvider.set(provider, fields);
  }
  const originalScore = quote.factorBreakdown?.weightedTotal ?? scoreFactors(quote, scoringWeights).weightedTotal;
  return [...byProvider.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([provider, fields]) => {
      const shadow = { ...quote } as MarketQuote;
      const scoringFields: string[] = [];
      const promptOnlyFields: string[] = [];
      for (const field of fields) {
        const neutralize = SCORE_FIELD_NEUTRALIZERS[field];
        if (neutralize) {
          neutralize(shadow as unknown as Record<string, unknown>);
          scoringFields.push(field);
        } else {
          promptOnlyFields.push(field);
        }
      }
      const shadowScore = scoreFactors(shadow, scoringWeights).weightedTotal;
      return {
        provider,
        affectedFields: [...fields].sort(),
        scoringFields: scoringFields.sort(),
        promptOnlyFields: promptOnlyFields.sort(),
        originalScore: round(originalScore),
        shadowScore: round(shadowScore),
        scoreDelta: round(originalScore - shadowScore),
        method: "leave_winning_fields_out/v1" as const
      };
    });
}

/** Compact, per-run provider coverage/failure manifest for prompt receipts and diagnostics. */
export function summarizeSourceCoverage(quotes: readonly MarketQuote[]): SourceCoverageReceipt[] {
  interface MutableCoverage {
    symbols: Set<string>;
    fields: Set<string>;
    fieldsObserved: number;
    failedSymbols: Set<string>;
    failureKinds: Set<string>;
  }
  const rows = new Map<string, MutableCoverage>();
  const rowFor = (provider: string): MutableCoverage => {
    const existing = rows.get(provider);
    if (existing) return existing;
    const created: MutableCoverage = {
      symbols: new Set(),
      fields: new Set(),
      fieldsObserved: 0,
      failedSymbols: new Set(),
      failureKinds: new Set()
    };
    rows.set(provider, created);
    return created;
  };

  for (const quote of quotes) {
    for (const [field, rawProvider] of Object.entries(quote.sources ?? {})) {
      const provider = String(rawProvider ?? "").trim();
      if (!provider) continue;
      const row = rowFor(provider);
      row.symbols.add(quote.symbol);
      row.fields.add(field);
      row.fieldsObserved += 1;
    }
    if (quote.provider?.trim()) {
      const row = rowFor(quote.provider.trim());
      row.symbols.add(quote.symbol);
      row.fields.add("candidate");
    }
    for (const [fallbackName, failure] of Object.entries(quote.providerFailures ?? {})) {
      const provider = failure.source?.trim() || fallbackName.trim();
      if (!provider) continue;
      const row = rowFor(provider);
      row.failedSymbols.add(quote.symbol);
      if (failure.errorKind) row.failureKinds.add(failure.errorKind);
      else row.failureKinds.add(failure.status);
    }
  }

  const denominator = Math.max(1, quotes.length);
  return [...rows.entries()]
    .map(([provider, row]) => ({
      provider,
      symbolsCovered: row.symbols.size,
      symbolCoveragePct: round((row.symbols.size / denominator) * 100, 1),
      fieldsObserved: row.fieldsObserved,
      fields: [...row.fields].sort(),
      failedSymbols: row.failedSymbols.size,
      failureKinds: [...row.failureKinds].sort()
    }))
    .sort((a, b) => b.symbolsCovered - a.symbolsCovered || a.provider.localeCompare(b.provider));
}

export interface SourceValueObservation {
  provider: string;
  fields: readonly string[];
  scoreDelta: number;
  returnPct: number;
  chosen: boolean;
}

/**
 * Outcome-linked source telemetry. It is explicitly observational and selection-biased; callers
 * should use it to prioritize experiments and detect persistently harmful directions, never as an
 * automatic causal weight update. `directionalValuePct` is the average sign(score delta) × return.
 */
export function aggregateSourceValue(observations: readonly SourceValueObservation[]): SourceValueStat[] {
  const grouped = new Map<string, SourceValueObservation[]>();
  for (const observation of observations) {
    if (!observation.provider.trim() || !Number.isFinite(observation.returnPct) || !Number.isFinite(observation.scoreDelta)) continue;
    const rows = grouped.get(observation.provider) ?? [];
    rows.push(observation);
    grouped.set(observation.provider, rows);
  }

  return [...grouped.entries()]
    .map(([provider, rows]) => {
      const directional = rows.filter((row) => row.scoreDelta !== 0 && row.returnPct !== 0);
      const directionalValues = directional.map((row) => Math.sign(row.scoreDelta) * row.returnPct);
      const wins = rows.filter((row) => row.returnPct > 0).length;
      const agreements = directionalValues.filter((value) => value > 0).length;
      const fields = [...new Set(rows.flatMap((row) => [...row.fields]))].sort();
      return {
        provider,
        outcomes: rows.length,
        directionalOutcomes: directional.length,
        chosenOutcomes: rows.filter((row) => row.chosen).length,
        skippedOutcomes: rows.filter((row) => !row.chosen).length,
        winRate: round((wins / rows.length) * 100, 1),
        avgReturnPct: round(rows.reduce((sum, row) => sum + row.returnPct, 0) / rows.length),
        avgScoreDelta: round(rows.reduce((sum, row) => sum + row.scoreDelta, 0) / rows.length),
        directionalValuePct: directional.length
          ? round(directionalValues.reduce((sum, value) => sum + value, 0) / directional.length)
          : 0,
        directionalAgreementRate: directional.length ? round((agreements / directional.length) * 100, 1) : 0,
        fields,
        learningStatus: directional.length >= 20 ? "established" as const : directional.length >= 5 ? "directional" as const : "insufficient" as const
      };
    })
    .sort((a, b) => b.directionalOutcomes - a.directionalOutcomes || b.outcomes - a.outcomes || a.provider.localeCompare(b.provider));
}
