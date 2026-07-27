/**
 * Enrichment coverage reporting — aggregates per-scan cascade results into a
 * field-by-field fill/source/missing report the owner can inspect via admin UI
 * and the ops snapshot.
 *
 * Built from the cascade's already-stamped `sources` / `providerFailures` so it
 * never invents provenance; it only summarizes what CascadingEnrichmentProvider
 * already decided.
 *
 * Kept free of imports from data-providers.ts to avoid a circular module graph
 * (the cascade imports this module after merge).
 */

/** Scalar fields we track for "did the cascade fill this?" reporting. */
export const COVERAGE_TRACKED_FIELDS = [
  "price",
  "bid",
  "ask",
  "intradayChangePct",
  "vwap",
  "asOf",
  "sentiment",
  "peRatio",
  "analystRating",
  "sector",
  "industry",
  "volume",
  "dividendYield",
  "eps",
  "companyName",
  "pbRatio",
  "shortPercentOfFloat",
  "beta",
  "fiftyTwoWeekHigh",
  "fiftyTwoWeekLow",
  "insiderSentiment",
  "fcfYield",
  "debtToEquity",
  "epsGrowth",
  "senateTrades",
  "daysToEarnings",
  "institutionOwnershipPct",
  "nearTheMoneyIv",
  "putCallRatio",
  "targetMean",
  "targetHigh",
  "targetLow",
  "targetMedian",
  "returnOnEquity",
  "returnOnAssets",
  "revenueGrowth",
  "freeCashFlowYield",
  "grossProfitMargin",
  "congressTradesQuiver",
  "insiderTradesQuiver",
  "govContractsQuiver",
  "lobbyingQuiver",
  "patentsQuiver"
] as const;

export type CoverageTrackedField = (typeof COVERAGE_TRACKED_FIELDS)[number];

/**
 * Core fields that free/keyless + RapidAPI failover are expected to cover for a useful scan.
 * Used to decide whether a paid provider (without its own `suppliesFields`) still has work —
 * specialty-only gaps (Quiver / options IV / price targets) must NOT force every paid lane
 * to re-fetch a symbol Yahoo already filled comprehensively.
 */
export const COVERAGE_GAP_FIELDS: readonly string[] = [
  "price",
  "bid",
  "ask",
  "intradayChangePct",
  "vwap",
  "asOf",
  "sentiment",
  "peRatio",
  "analystRating",
  "sector",
  "industry",
  "volume",
  "dividendYield",
  "eps",
  "companyName",
  "pbRatio",
  "shortPercentOfFloat",
  "beta",
  "fiftyTwoWeekHigh",
  "fiftyTwoWeekLow",
  "insiderSentiment",
  "fcfYield",
  "debtToEquity",
  "epsGrowth",
  "daysToEarnings",
  "institutionOwnershipPct",
  "returnOnEquity",
  "returnOnAssets",
  "revenueGrowth",
  "freeCashFlowYield",
  "grossProfitMargin",
  "headlines"
];

export interface EnrichmentFieldCoverage {
  field: string;
  filledCount: number;
  totalSymbols: number;
  fillRate: number;
  /** Winning source → how many symbols that source supplied this field for. */
  winningSources: Record<string, number>;
  /** Source with the highest win count for this field, or null when nothing filled. */
  mostFrequentSource: string | null;
  /** Sample of symbols still missing this field (capped). */
  missingSymbols: string[];
}

export interface EnrichmentProviderFailureSummary {
  provider: string;
  failureCount: number;
  errorKinds: string[];
}

export interface EnrichmentCoverageReport {
  asOf: string;
  symbolCount: number;
  /** Fields with at least one fill opportunity, sorted by fillRate desc then name. */
  fields: EnrichmentFieldCoverage[];
  /** Fields with fillRate === 0 across the whole batch. */
  missingFields: string[];
  /** Fields filled for some but not all symbols. */
  partialFields: string[];
  /** Aggregate wins across all fields (source → total field-wins). */
  sourceWinTotals: Record<string, number>;
  /** Providers that threw / returned failure receipts during the run. */
  providerFailures: EnrichmentProviderFailureSummary[];
  /** Providers that contributed ≥1 accepted field. */
  contributingSources: string[];
  /** Headlines fill summary (array field, tracked separately). */
  headlines?: EnrichmentFieldCoverage;
}

/** Minimal shape the coverage builder needs from a cascade merge record. */
export interface EnrichmentCoverageRecord {
  sources?: Partial<Record<string, string>>;
  headlines?: string[];
  providerFailures?: Record<string, { errorKind?: string }>;
}

const MISSING_SYMBOL_CAP = 40;

function recordField(record: EnrichmentCoverageRecord | undefined, field: string): unknown {
  if (!record) return undefined;
  return (record as Record<string, unknown>)[field];
}

let lastCoverageReport: EnrichmentCoverageReport | null = null;

export function getLastEnrichmentCoverageReport(): EnrichmentCoverageReport | null {
  return lastCoverageReport;
}

export function setLastEnrichmentCoverageReport(report: EnrichmentCoverageReport | null): void {
  lastCoverageReport = report;
}

/** Test helper — clears the in-memory last-report slot. */
export function __resetEnrichmentCoverageForTests(): void {
  lastCoverageReport = null;
}

export function isFilledEnrichmentValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

function mostFrequent(counts: Record<string, number>): string | null {
  let best: string | null = null;
  let bestCount = 0;
  for (const [source, count] of Object.entries(counts)) {
    if (count > bestCount || (count === bestCount && best !== null && source < best)) {
      best = source;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Build a coverage report from a finished cascade merge.
 * `contributingSources` should already be registration-order filtered (cascade.activeSources).
 */
export function buildEnrichmentCoverageReport(
  // Accept any enrichment-shaped record (e.g. SymbolEnrichment) without forcing an index signature.
  merged: Record<string, EnrichmentCoverageRecord>,
  contributingSources: string[] = []
): EnrichmentCoverageReport {
  const symbols = Object.keys(merged).sort();
  const totalSymbols = symbols.length;
  const asOf = new Date().toISOString();
  const sourceWinTotals: Record<string, number> = {};
  const failureCounts = new Map<string, { count: number; kinds: Set<string> }>();

  for (const symbol of symbols) {
    const failures = merged[symbol]?.providerFailures;
    if (!failures) continue;
    for (const [provider, receipt] of Object.entries(failures)) {
      const entry = failureCounts.get(provider) ?? { count: 0, kinds: new Set<string>() };
      entry.count += 1;
      if (receipt.errorKind) entry.kinds.add(receipt.errorKind);
      failureCounts.set(provider, entry);
    }
  }

  const fields: EnrichmentFieldCoverage[] = [];
  for (const field of COVERAGE_TRACKED_FIELDS) {
    const winningSources: Record<string, number> = {};
    const missingSymbols: string[] = [];
    let filledCount = 0;
    for (const symbol of symbols) {
      const record = merged[symbol];
      const value = recordField(record, field);
      if (isFilledEnrichmentValue(value)) {
        filledCount += 1;
        const source = record?.sources?.[field] ?? "unknown";
        winningSources[source] = (winningSources[source] ?? 0) + 1;
        sourceWinTotals[source] = (sourceWinTotals[source] ?? 0) + 1;
      } else if (missingSymbols.length < MISSING_SYMBOL_CAP) {
        missingSymbols.push(symbol);
      }
    }
    fields.push({
      field,
      filledCount,
      totalSymbols,
      fillRate: totalSymbols === 0 ? 0 : filledCount / totalSymbols,
      winningSources,
      mostFrequentSource: mostFrequent(winningSources),
      missingSymbols
    });
  }

  const headlineSources: Record<string, number> = {};
  const headlineMissing: string[] = [];
  let headlineFilled = 0;
  for (const symbol of symbols) {
    const record = merged[symbol];
    if (record?.headlines && record.headlines.length > 0) {
      headlineFilled += 1;
      const source =
        record.sources?.headlines ??
        (contributingSources.find((s) => /news|finnhub|alpaca-news|fintech/i.test(s)) ?? "unknown");
      headlineSources[source] = (headlineSources[source] ?? 0) + 1;
      sourceWinTotals[source] = (sourceWinTotals[source] ?? 0) + 1;
    } else if (headlineMissing.length < MISSING_SYMBOL_CAP) {
      headlineMissing.push(symbol);
    }
  }
  const headlines: EnrichmentFieldCoverage = {
    field: "headlines",
    filledCount: headlineFilled,
    totalSymbols,
    fillRate: totalSymbols === 0 ? 0 : headlineFilled / totalSymbols,
    winningSources: headlineSources,
    mostFrequentSource: mostFrequent(headlineSources),
    missingSymbols: headlineMissing
  };

  fields.sort((a, b) => b.fillRate - a.fillRate || a.field.localeCompare(b.field));

  const missingFields = fields.filter((f) => f.filledCount === 0).map((f) => f.field);
  if (headlines.filledCount === 0) missingFields.push("headlines");
  const partialFields = fields
    .filter((f) => f.filledCount > 0 && f.filledCount < totalSymbols)
    .map((f) => f.field);
  if (headlines.filledCount > 0 && headlines.filledCount < totalSymbols) {
    partialFields.push("headlines");
  }

  const providerFailures: EnrichmentProviderFailureSummary[] = Array.from(failureCounts.entries())
    .map(([provider, { count, kinds }]) => ({
      provider,
      failureCount: count,
      errorKinds: Array.from(kinds).sort()
    }))
    .sort((a, b) => b.failureCount - a.failureCount || a.provider.localeCompare(b.provider));

  const report: EnrichmentCoverageReport = {
    asOf,
    symbolCount: totalSymbols,
    fields,
    missingFields: missingFields.sort(),
    partialFields: partialFields.sort(),
    sourceWinTotals,
    providerFailures,
    contributingSources: [...contributingSources],
    headlines
  };
  lastCoverageReport = report;
  return report;
}

/** Collect which keys are already filled for a symbol from prior wave results. */
export function collectFilledFields(
  results: Array<{ data: Record<string, EnrichmentCoverageRecord> }>,
  symbol: string,
  providerIndexes?: number[]
): Set<string> {
  const filled = new Set<string>();
  const indexes = providerIndexes ?? results.map((_, i) => i);
  for (const providerIndex of indexes) {
    const record = results[providerIndex]?.data[symbol];
    if (!record) continue;
    for (const [key, value] of Object.entries(record as Record<string, unknown>)) {
      if (key === "sources" || key === "fieldObservations" || key === "providerFailures" || key === "fieldDates") {
        continue;
      }
      if (!isFilledEnrichmentValue(value)) continue;
      filled.add(key);
    }
  }
  return filled;
}

/** True when at least one gap field is still empty for the symbol. */
export function symbolHasCoverageGap(
  filled: Set<string>,
  fields: readonly string[] = COVERAGE_GAP_FIELDS
): boolean {
  return fields.some((field) => !filled.has(field));
}
