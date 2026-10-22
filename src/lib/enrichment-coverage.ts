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

/**
 * QuiverQuant direct-access carrier fields (lane retired 2026-08-04; provider never registered).
 * Excluded from coverage percentages so the admin board is not pinned at zero on dormant fields.
 */
export const COVERAGE_RETIRED_LANE_FIELDS = [
  "congressTradesQuiver",
  "insiderTradesQuiver",
  "govContractsQuiver",
  "lobbyingQuiver",
  "patentsQuiver"
] as const;

export type CoverageRetiredLaneField = (typeof COVERAGE_RETIRED_LANE_FIELDS)[number];

const COVERAGE_RETIRED_LANE_FIELD_SET = new Set<string>(COVERAGE_RETIRED_LANE_FIELDS);

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
  "marketCap",
  "sharesOutstanding",
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
  "grossProfitMargin"
] as const;

export type CoverageTrackedField = (typeof COVERAGE_TRACKED_FIELDS)[number];

/** Near-the-money IV and put/call ratio — specialty options fields (Cboe / Alpaca / Tradier / Robinhood). */
export const COVERAGE_OPTIONS_METRICS_FIELDS: readonly CoverageTrackedField[] = ["nearTheMoneyIv", "putCallRatio"];

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

/**
 * Scan-useful fields that justify Wave B (keyed non-scarce) spend.  The gate
 * drops quote microstructure (bid/ask/vwap/asOf), news (headlines/sentiment —
 * Alpaca Wave A owns those), and specialty (insiderSentiment, epsGrowth,
 * leverage, ROA/ROE, FCF, institution %) so Yahoo filling the scan core does
 * not force Finnhub/ROIC on every symbol.  Insider gaps stay Wave C.
 * Keep COVERAGE_GAP_FIELDS for reports.
 */
export const WAVE_B_GAP_FIELDS: readonly string[] = [
  "price",
  "intradayChangePct",
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
  "daysToEarnings"
];

/** RapidAPI last-resort must not spend quota on news.  Alpaca (Wave A) + Finnhub (Wave B) own that. */
const SCARCE_EXCLUDE_FIELDS = new Set(["headlines", "sentiment"]);

/** Price-family + profile fields that justify a SteadyAPI / YH-15 quote or modules call. */
export const STEADY_API_USEFUL_FIELDS: readonly string[] = ["price", "volume", "sector", "industry"];

/** AV RapidAPI OVERVIEW spend is justified by these core fund fields, not epsGrowth alone. */
export const AV_RAPIDAPI_OVERVIEW_CORE_FIELDS: readonly string[] = [
  "peRatio",
  "dividendYield",
  "eps",
  "sector",
  "industry",
  "pbRatio",
  "beta",
  "fiftyTwoWeekHigh",
  "fiftyTwoWeekLow"
];

const WAVE_B_GAP_FIELD_SET = new Set<string>(WAVE_B_GAP_FIELDS);

/**
 * Narrow field subset that justifies dispatching a scarce Wave C provider.
 * Full `suppliesFields` is too wide (52w, companyName, epsGrowth, targets) and
 * burns RapidAPI quote-only calls after Yahoo already filled the scan core.
 */
export function scarceProviderUsefulFields(
  providerName: string,
  suppliesFields: readonly string[]
): readonly string[] {
  const supply = new Set(suppliesFields);
  const pick = (keys: readonly string[]): string[] => keys.filter((key) => supply.has(key));
  if (
    providerName === "mboum-finance" ||
    providerName === "yahoo-finance15" ||
    providerName === "yh-finance-apidojo"
  ) {
    return pick(STEADY_API_USEFUL_FIELDS);
  }
  if (providerName === "alpha-vantage-rapidapi") {
    return pick(AV_RAPIDAPI_OVERVIEW_CORE_FIELDS);
  }
  if (providerName === "filingapi") {
    // Insiders RapidAPI already owns insiderSentiment; do not double-spend the
    // FilingAPI trial key on the same gap.
    return pick(["companyName", "sector", "industry", "daysToEarnings"]);
  }
  if (providerName === "marketaux") {
    // News specialist, not a RapidAPI quote last-resort.
    return pick(["headlines", "sentiment"]);
  }
  const useful = suppliesFields.filter(
    (field) => WAVE_B_GAP_FIELD_SET.has(field) && !SCARCE_EXCLUDE_FIELDS.has(field)
  );
  return useful.length > 0 ? useful : suppliesFields.filter((field) => !SCARCE_EXCLUDE_FIELDS.has(field));
}

/** True when a scarce provider can still add a scan-useful field for this symbol. */
export function scarceProviderHasUsefulGap(
  providerName: string,
  suppliesFields: readonly string[],
  filled: ReadonlySet<string>
): boolean {
  const useful = scarceProviderUsefulFields(providerName, suppliesFields);
  if (useful.length === 0) return false;
  return useful.some((field) => !filled.has(field));
}

/**
 * Wave B paid providers still fire when ANY of suppliesFields is empty, including
 * bid/ask/vwap.  Intersect with WAVE_B_GAP_FIELDS so Finnhub does not run a quote
 * just because microstructure is missing on a symbol that already has a scan-core gap
 * (e.g. daysToEarnings).  Providers that declare no suppliesFields stay ungated.
 */
export function paidProviderHasUsefulWaveBGap(
  suppliesFields: readonly string[],
  filled: ReadonlySet<string>
): boolean {
  const useful = suppliesFields.filter((field) => WAVE_B_GAP_FIELD_SET.has(field));
  if (useful.length === 0) return false;
  return useful.some((field) => !filled.has(field));
}

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
  /**
   * Carrier fields excluded from fill scoring and the admin table (direct vendor retired;
   * no registered producer). Documented for API consumers; not shown as 0% gaps.
   */
  retiredLaneFields?: readonly CoverageRetiredLaneField[];
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

// The coverage persist is scheduled as a fire-and-forget dynamic import, and
// persistEnrichmentCoverageReport resolves the database it writes to when the write lands,
// not when it was scheduled.  A test file that restores DATABASE_URL while that write is still
// in flight therefore has the write land in the database the worker is pointing at by then,
// which is the shared one.  These handles let such a file wait for the pending write before it
// restores anything.
//
// The handles live on globalThis because a test file can call vi.resetModules(), which replaces
// this module's instance and would otherwise orphan a promise that is still pending.
interface PendingPersistHost {
  __socraticPendingCoveragePersists?: Set<Promise<void>>;
}

function pendingPersists(): Set<Promise<void>> {
  const host = globalThis as unknown as PendingPersistHost;
  if (!host.__socraticPendingCoveragePersists) {
    host.__socraticPendingCoveragePersists = new Set<Promise<void>>();
  }
  return host.__socraticPendingCoveragePersists;
}

export function getLastEnrichmentCoverageReport(): EnrichmentCoverageReport | null {
  return lastCoverageReport;
}

export function setLastEnrichmentCoverageReport(report: EnrichmentCoverageReport | null): void {
  lastCoverageReport = report;
  if (!report) return;
  const handles = pendingPersists();
  const pending: Promise<void> = import("./db-enrichment-coverage")
    .then((mod) => {
      // persistEnrichmentCoverageReport is synchronous.  It resolves the database, opens the
      // handle and writes the rows inside a better-sqlite3 transaction, and returns void, so
      // the write has landed by the time this callback returns and the tracked promise settles
      // only after it.  The asynchronous part is the dynamic import above, and that is what
      // makes the tracked promise worth awaiting: the module resolves the database only when
      // the write lands, which is why a teardown that restores DATABASE_URL before this
      // promise settles hands the write to the wrong database.
      mod.persistEnrichmentCoverageReport(report);
    })
    .catch(() => {
      // Best-effort durability — never break a cascade run (tests may omit DB).
    });
  handles.add(pending);
  void pending.then(() => {
    handles.delete(pending);
  });
}

/** Test helper — waits for every coverage persist that is still in flight.
 *
 *  The persist is scheduled as a fire-and-forget dynamic import, so it can still be pending
 *  when the calling file's teardown runs.  A file that restores DATABASE_URL before the write
 *  lands would have the write land in the shared database instead of its own.  Call this
 *  before restoring, while the file's own database is still the target.
 */
export async function __awaitPendingEnrichmentCoveragePersist(): Promise<void> {
  // The loop covers a persist that schedules another one while it settles.
  while (true) {
    const handles = [...pendingPersists()];
    if (handles.length === 0) return;
    await Promise.all(handles);
  }
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

/**
 * Strip retired-lane rows from a coverage report (e.g. durable rows written before ST-3854).
 * Idempotent for reports already built without those fields.
 */
export function sanitizeEnrichmentCoverageReport(
  report: EnrichmentCoverageReport
): EnrichmentCoverageReport {
  const fields = report.fields.filter((f) => !COVERAGE_RETIRED_LANE_FIELD_SET.has(f.field));
  const missingFields = report.missingFields.filter((f) => !COVERAGE_RETIRED_LANE_FIELD_SET.has(f));
  const partialFields = report.partialFields.filter((f) => !COVERAGE_RETIRED_LANE_FIELD_SET.has(f));
  const retiredLaneFields = report.retiredLaneFields ?? [...COVERAGE_RETIRED_LANE_FIELDS];
  if (
    fields.length === report.fields.length &&
    missingFields.length === report.missingFields.length &&
    partialFields.length === report.partialFields.length &&
    report.retiredLaneFields
  ) {
    return report;
  }
  return {
    ...report,
    fields,
    missingFields,
    partialFields,
    retiredLaneFields
  };
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
    retiredLaneFields: [...COVERAGE_RETIRED_LANE_FIELDS],
    fields,
    missingFields: missingFields.sort(),
    partialFields: partialFields.sort(),
    sourceWinTotals,
    providerFailures,
    contributingSources: [...contributingSources],
    headlines
  };
  setLastEnrichmentCoverageReport(report);
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
      // Yahoo writes recommendationMean as analystBySource, not analystRating.
      // Treating them as the same scan-core fill stops Wave B on every symbol.
      if (key === "analystBySource") filled.add("analystRating");
      if (key === "analystRating") filled.add("analystBySource");
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

/** Fields the Scan table and LLM care about most — used for user-facing shortfalls. */
export const SCAN_DISPLAY_COVERAGE_FIELDS = [
  "peRatio",
  "epsGrowth",
  "dividendYield",
  "analystRating",
  "sentiment",
  "volume",
  "sector",
  "eps",
  "headlines",
  "insiderSentiment"
] as const;

export interface ScanCandidateCoverageInput {
  symbol: string;
  peRatio?: number;
  epsGrowth?: number;
  dividendYield?: number;
  analystRating?: string;
  sentiment?: number;
  volume?: number;
  sector?: string;
  eps?: number;
  headlines?: string[];
  insiderSentiment?: number;
  sources?: Partial<Record<string, string>>;
  fieldObservations?: Partial<Record<string, { fetchedAt?: string; source?: string }>>;
}

/**
 * Build a loud, plain-language coverage report for topCandidates so blanks are never silent.
 */
export function buildScanDataCoverage(
  candidates: ScanCandidateCoverageInput[]
): {
  symbolCount: number;
  fieldFillRates: Record<string, number>;
  missingFields: string[];
  partialFields: string[];
  shortfallSummary: string;
  contributingSources: string[];
  durableStoreSeededCount: number;
  topGaps: Array<{ field: string; fillRate: number; missingCount: number }>;
} {
  const symbolCount = candidates.length;
  const fieldFillRates: Record<string, number> = {};
  const missingFields: string[] = [];
  const partialFields: string[] = [];
  const topGaps: Array<{ field: string; fillRate: number; missingCount: number }> = [];
  const sources = new Set<string>();
  let durableStoreSeededCount = 0;

  for (const c of candidates) {
    for (const src of Object.values(c.sources ?? {})) {
      if (src) sources.add(src);
    }
    if (c.fieldObservations && Object.keys(c.fieldObservations).length > 0) {
      durableStoreSeededCount += 1;
    }
  }

  const readField = (c: ScanCandidateCoverageInput, field: string): unknown =>
    (c as unknown as Record<string, unknown>)[field];

  for (const field of SCAN_DISPLAY_COVERAGE_FIELDS) {
    let filled = 0;
    for (const c of candidates) {
      if (isFilledEnrichmentValue(readField(c, field))) filled += 1;
    }
    const fillRate = symbolCount === 0 ? 0 : filled / symbolCount;
    fieldFillRates[field] = fillRate;
    const missingCount = symbolCount - filled;
    if (filled === 0) missingFields.push(field);
    else if (filled < symbolCount) partialFields.push(field);
    if (fillRate < 1) topGaps.push({ field, fillRate, missingCount });
  }

  topGaps.sort((a, b) => a.fillRate - b.fillRate || b.missingCount - a.missingCount);

  let shortfallSummary: string;
  if (symbolCount === 0) {
    shortfallSummary = "No candidates in this scan — nothing to cover.";
  } else if (missingFields.length === 0 && partialFields.length === 0) {
    shortfallSummary = `All key fields filled for ${symbolCount} candidates (${Array.from(sources).slice(0, 6).join(", ") || "no sources stamped"}).`;
  } else {
    const worst = topGaps
      .slice(0, 5)
      .map((g) => `${g.field} ${Math.round(g.fillRate * 100)}% (${g.missingCount} blank)`)
      .join("; ");
    const storeNote =
      durableStoreSeededCount > 0
        ? ` Durable store seeded ${durableStoreSeededCount}/${symbolCount}.`
        : " Durable field store had no prior rows for these names — run a full enrich (strategy/freshness) to populate.";
    shortfallSummary = `Data shortfall on ${symbolCount} candidates — ${worst}.${storeNote}`;
  }

  return {
    symbolCount,
    fieldFillRates,
    missingFields,
    partialFields,
    shortfallSummary,
    contributingSources: Array.from(sources).sort(),
    durableStoreSeededCount,
    topGaps: topGaps.slice(0, 10)
  };
}
