import { listSignalSnapshotAuditAfter, type SignalSnapshotAuditRow } from "./db";
import { fetchDailyOHLC, toBusinessDay } from "./history";
import type { OHLCBar } from "./indicators";
import { normalizeSymbol } from "./money";

const DAY_MS = 86_400_000;
const DEFAULT_HORIZON_DAYS = 63;
const DEFAULT_AUDIT_LIMIT = 1000;

export type CongressScoreEvalDirection = "BUY" | "SELL" | "NEUTRAL";
export type CongressScoreOHLCFetcher = (symbol: string, now?: number, userId?: string) => Promise<OHLCBar[] | null>;

export interface CongressScoreObservation {
  date: string;
  symbol: string;
  congressScore: number;
  congressSignedScore?: number;
  congressDirection?: CongressScoreEvalDirection;
  forwardReturn: number;
  benchmarkReturn?: number | null;
  baselineScore?: number;
  returnKind?: "excess" | "raw_with_benchmark" | "raw";
}

export interface CongressRankMetric {
  meanIC: number;
  nDates: number;
  tStat: number;
}

export interface CongressQuantileStat {
  bucket: number;
  n: number;
  avgReturn: number;
  hitRate: number;
}

export interface CongressScoreEvaluation {
  observations: number;
  rawDates: number;
  dates: number;
  tickers: number;
  rankIC: CongressRankMetric;
  marginalIC?: CongressRankMetric;
  quantiles: CongressQuantileStat[];
  topMinusBottomReturn: number | null;
  topHitRate: number | null;
  benchmarkCoveragePct: number;
  placeboRankIC?: CongressRankMetric;
  placeboDeltaIC?: number;
  goNoGo: {
    pass: boolean;
    reasons: string[];
  };
}

export interface EvaluateCongressScoreOptions {
  quantiles?: number;
  minNamesPerDate?: number;
  minObservations?: number;
  minDates?: number;
  minTickers?: number;
  minTopBucketObservations?: number;
  requireBenchmarkReturn?: boolean;
  placeboSeed?: number;
  /**
   * P2-3 (default false): when true, the go/no-go additionally requires the TOP score bucket's OWN excess
   * return (top.avgReturn − bottom.avgReturn, i.e. the long-leg edge) to be strictly positive with at least
   * `minTopBucketObservations` names. This blocks a symmetric top-minus-bottom spread whose edge lives
   * entirely in the (short) bottom leg from promoting a long-biased congress signal. Off by default → the
   * verdict is unchanged. (The bottom-inclusive `topMinusBottomReturn > 0` check already runs; this adds a
   * check that the TOP bucket itself carries positive edge, not just that the spread is positive.)
   */
  requireTopBucketPositive?: boolean;
}

export interface CongressScoreExportParseOptions {
  horizonDays?: number;
}

export interface BuildCongressScoreObservationsOptions {
  horizonDays?: number;
  auditLimit?: number;
  now?: number;
  fetchOHLC?: CongressScoreOHLCFetcher;
}

interface SignalSnapshotPayload {
  asOf?: string;
  signals?: Array<{
    symbol?: string;
    refPrice?: number;
    score?: number;
    preCongressScore?: number;
    congressCompositeScore?: number;
    congressCompositeSignedScore?: number;
    congressCompositeDirection?: CongressScoreEvalDirection;
    congressCompositeConfidence?: number;
  }>;
}

export async function buildCongressScoreObservations(
  userId: string = "local",
  options: BuildCongressScoreObservationsOptions = {}
): Promise<CongressScoreObservation[]> {
  const now = options.now ?? Date.now();
  const horizonDays = boundedInteger(options.horizonDays ?? DEFAULT_HORIZON_DAYS, 1, 504, DEFAULT_HORIZON_DAYS);
  const auditLimit = boundedInteger(options.auditLimit ?? DEFAULT_AUDIT_LIMIT, 1, 5000, DEFAULT_AUDIT_LIMIT);
  const fetchOHLC = options.fetchOHLC ?? fetchDailyOHLC;
  const rows = listSignalSnapshotAuditAfter(userId, undefined, auditLimit);
  const barsBySymbol = new Map<string, OHLCBar[] | null>();
  const spyBars = await fetchOHLC("SPY", now, userId).catch(() => null);
  const observations: CongressScoreObservation[] = [];

  for (const row of rows) {
    const parsed = parseSnapshot(row);
    if (!parsed) continue;
    const { snapshotDate, signals } = parsed;
    const targetDate = targetDateAfter(snapshotDate, horizonDays);

    for (const signal of signals) {
      const symbol = normalizeSymbol(signal.symbol ?? "");
      const refPrice = positiveNumber(signal.refPrice);
      const congressScore = finiteNumber(signal.congressCompositeScore);
      if (!symbol || !refPrice || congressScore === undefined || congressScore <= 0) continue;

      let bars = barsBySymbol.get(symbol);
      if (bars === undefined) {
        bars = await fetchOHLC(symbol, now, userId);
        barsBySymbol.set(symbol, bars);
      }
      const exit = bars ? selectExitClose(bars, targetDate) : undefined;
      if (exit === undefined) continue;

      observations.push({
        date: snapshotDate,
        symbol,
        congressScore,
        congressSignedScore: finiteNumber(signal.congressCompositeSignedScore),
        congressDirection: signal.congressCompositeDirection,
        forwardReturn: (exit - refPrice) / refPrice,
        benchmarkReturn: spyBars ? benchmarkReturn(spyBars, snapshotDate, targetDate) ?? null : null,
        baselineScore: finiteNumber(signal.preCongressScore),
        returnKind: spyBars ? "raw_with_benchmark" : "raw"
      });
    }
  }

  return observations;
}

export function evaluateCongressScore(
  observations: CongressScoreObservation[],
  options: EvaluateCongressScoreOptions = {}
): CongressScoreEvaluation {
  const clean = observations
    .map(normalizeObservation)
    .filter((obs): obs is Required<Pick<CongressScoreObservation, "date" | "symbol" | "congressScore" | "forwardReturn">> & CongressScoreObservation =>
      Boolean(obs && Number.isFinite(signedScore(obs)) && Number.isFinite(targetReturn(obs)))
    );
  const quantileCount = boundedInteger(options.quantiles ?? 5, 2, 20, 5);
  const minNamesPerDate = boundedInteger(options.minNamesPerDate ?? 10, 2, 1000, 10);
  const minObservations = boundedInteger(options.minObservations ?? 500, 1, 1_000_000, 500);
  const minDates = boundedInteger(options.minDates ?? 60, 1, 10_000, 60);
  const minTickers = boundedInteger(options.minTickers ?? 50, 1, 100_000, 50);
  const minTopBucketObservations = boundedInteger(options.minTopBucketObservations ?? 100, 1, 1_000_000, 100);
  const requireBenchmarkReturn = options.requireBenchmarkReturn ?? true;
  const rankIC = computeRankMetric(clean, (obs) => signedScore(obs), (obs) => targetReturn(obs), minNamesPerDate);
  const marginalIC = clean.some((obs) => Number.isFinite(obs.baselineScore))
    ? computeMarginalMetric(clean, minNamesPerDate)
    : undefined;
  const quantiles = computeQuantiles(clean, quantileCount, minNamesPerDate);
  const top = quantiles[quantiles.length - 1];
  const bottom = quantiles[0];
  const topMinusBottomReturn = top && bottom ? round6(top.avgReturn - bottom.avgReturn) : null;
  const topHitRate = top ? top.hitRate : null;
  const rawDates = new Set(clean.map((obs) => obs.date)).size;
  const dates = rankIC.nDates;
  const tickers = new Set(clean.map((obs) => obs.symbol)).size;
  const benchmarked = clean.filter((obs) => obs.returnKind === "excess" || (obs.benchmarkReturn !== null && obs.benchmarkReturn !== undefined)).length;
  const benchmarkCoveragePct = clean.length > 0 ? round6(benchmarked / clean.length) : 0;
  const placebo = options.placeboSeed !== undefined
    ? evaluateCongressScore(rotateScoresByDate(clean, options.placeboSeed), { quantiles: quantileCount, minNamesPerDate })
    : undefined;
  const reasons: string[] = [];
  if (clean.length < minObservations) reasons.push(`insufficient observations (${clean.length} < ${minObservations})`);
  if (dates < minDates) reasons.push(`insufficient dates (${dates} < ${minDates})`);
  if (tickers < minTickers) reasons.push(`insufficient distinct tickers (${tickers} < ${minTickers})`);
  if ((top?.n ?? 0) < minTopBucketObservations) reasons.push(`insufficient top-bucket observations (${top?.n ?? 0} < ${minTopBucketObservations})`);
  if (requireBenchmarkReturn && benchmarked < clean.length) reasons.push("benchmarkReturn is required for excess-return evaluation");
  if (rankIC.meanIC <= 0) reasons.push("rank IC is not positive");
  if (rankIC.tStat < 2) reasons.push("rank IC t-stat is below 2");
  if (topMinusBottomReturn == null || topMinusBottomReturn <= 0) reasons.push("top-minus-bottom quantile spread is not positive");
  // P2-3 (opt-in): the LONG-leg edge must be positive on its own — the top bucket's own excess return (not
  // just the top-minus-bottom spread, which can be carried entirely by the short bottom leg). Off by default.
  if ((options.requireTopBucketPositive ?? false) && (top == null || !(top.avgReturn > 0) || (top.n ?? 0) < minTopBucketObservations)) {
    reasons.push(`top-bucket long-leg excess return is not positive (avgReturn ${top ? round6(top.avgReturn) : "n/a"}, n ${top?.n ?? 0})`);
  }
  if (placebo && rankIC.meanIC <= placebo.rankIC.meanIC) reasons.push("placebo IC is not lower than real IC");

  return {
    observations: clean.length,
    rawDates,
    dates,
    tickers,
    rankIC,
    marginalIC,
    quantiles,
    topMinusBottomReturn,
    topHitRate,
    benchmarkCoveragePct,
    placeboRankIC: placebo?.rankIC,
    placeboDeltaIC: placebo ? round6(rankIC.meanIC - placebo.rankIC.meanIC) : undefined,
    goNoGo: {
      pass: clean.length > 0 && reasons.length === 0,
      reasons
    }
  };
}

export function congressScoreObservationsFromExportRows(
  rows: unknown[],
  options: CongressScoreExportParseOptions = {}
): CongressScoreObservation[] {
  return rows
    .map((row) => exportRowToObservation(row, options.horizonDays ?? DEFAULT_HORIZON_DAYS))
    .filter((row): row is CongressScoreObservation => Boolean(row));
}

function exportRowToObservation(row: unknown, horizonDays: number): CongressScoreObservation | undefined {
  if (!row || typeof row !== "object") return undefined;
  const r = row as Record<string, unknown>;
  const hasPitLabels = pitLabelsPresent(r.labels);
  const label = pitLabelForHorizon(r.labels, horizonDays);
  const date = hasPitLabels
    ? pitAvailabilityDate(r)
    : stringValue(r.date ?? r.asOf ?? r.disclosureAvailableAt ?? r.disclosedAt ?? r.filingDate);
  const symbol = stringValue(r.symbol ?? r.ticker);
  const congressScore = finiteNumber(r.congressScore ?? r.compositeScore);
  const signed = finiteNumber(r.congressSignedScore ?? r.signedScore);
  const dir = direction(r.congressDirection ?? r.direction);
  if (signed === undefined && dir === undefined) return undefined;
  if (hasPitLabels && (!pitValidityAllowsHistoricalValidation(r) || !label || !pitLabelIsPointInTime(r, label, date) || !pitMemberSkillIsPointInTime(r, date))) return undefined;
  const explicitExcessReturn = hasPitLabels ? finiteNumber(label?.excessReturn) : finiteNumber(r.forwardExcessReturn ?? r.excessReturn);
  const forwardReturn = hasPitLabels
    ? finiteNumber(label?.assetReturn) ?? explicitExcessReturn
    : finiteNumber(r.forwardReturn ?? r.return) ?? explicitExcessReturn;
  if (!date || !symbol || congressScore === undefined || forwardReturn === undefined) return undefined;
  const benchmarkReturn = explicitExcessReturn !== undefined && (hasPitLabels || finiteNumber(r.forwardReturn ?? r.return) === undefined)
    ? null
    : hasPitLabels
      ? finiteNumber(label?.spxReturn) ?? null
      : finiteNumber(r.benchmarkReturn ?? r.spxReturn ?? r.marketReturn) ?? null;
  return {
    date,
    symbol,
    congressScore,
    congressSignedScore: signed,
    congressDirection: dir,
    forwardReturn,
    benchmarkReturn,
    baselineScore: pitBaselineScore(r.baselines) ?? finiteNumber(r.preCongressScore),
    returnKind: explicitExcessReturn !== undefined && benchmarkReturn === null
      ? "excess"
      : benchmarkReturn !== null && benchmarkReturn !== undefined
        ? "raw_with_benchmark"
        : "raw"
  };
}

function pitLabelsPresent(labels: unknown): boolean {
  if (!labels || typeof labels !== "object") return false;
  return Array.isArray((labels as { horizons?: unknown }).horizons);
}

function pitValidityAllowsHistoricalValidation(row: Record<string, unknown>): boolean {
  const validity = objectValue(row.pitValidity);
  if (!validity) return true;
  if (validity.scoreInputsPitSafe === false) return false;
  if (validity.historicalValidationReady === false) return false;
  if (validity.ready === false || validity.pitSafe === false) return false;
  return true;
}

function pitAvailabilityDate(row: Record<string, unknown>): string | undefined {
  return stringValue(row.asOf ?? row.disclosureAvailableAt ?? row.marketAvailableAt);
}

function pitLabelForHorizon(labels: unknown, horizonDays: number): Record<string, unknown> | undefined {
  if (!labels || typeof labels !== "object") return undefined;
  const horizons = (labels as { horizons?: unknown }).horizons;
  if (!Array.isArray(horizons)) return undefined;
  const target = `${horizonDays}d`;
  return horizons.find((h): h is Record<string, unknown> => {
    if (!h || typeof h !== "object") return false;
    const row = h as Record<string, unknown>;
    return finiteNumber(row.days) === horizonDays || stringValue(row.horizon) === target;
  });
}

function pitBaselineScore(baselines: unknown): number | undefined {
  if (!baselines || typeof baselines !== "object") return undefined;
  const b = baselines as Record<string, unknown>;
  return finiteNumber(b.appBPreCongressScanScore ?? b.preCongressScore);
}

function pitLabelIsPointInTime(row: Record<string, unknown>, label: Record<string, unknown>, asOf: string | undefined): boolean {
  if (!asOf) return false;
  const asOfDate = toBusinessDay(asOf);
  if (!asOfDate) return false;
  const dataCutoffAt = stringValue(row.dataCutoffAt ?? objectValue(row.provenance)?.scoreInputsCutoffAt);
  if (dataCutoffAt && compareTime(dataCutoffAt, asOf) > 0) return false;
  const labels = objectValue(row.labels);
  const rawInputs = objectValue(row.rawInputs);
  const entryDate = stringValue(label.entryDate ?? labels?.conservativeLabelEntryDate ?? rawInputs?.conservativeLabelEntryDate);
  const entryDay = entryDate ? toBusinessDay(entryDate) : undefined;
  if (!entryDay) return false;
  if (entryDay < asOfDate) return false;
  return true;
}

function pitMemberSkillIsPointInTime(row: Record<string, unknown>, asOf: string | undefined): boolean {
  if (!asOf) return false;
  const skill = objectValue(row.memberSkill);
  if (!skill) return true;
  const score = finiteNumber(skill.skillScore);
  if (score === undefined || score <= 0) return true;
  const skillAsOf = stringValue(skill.skillAsOf);
  const scoredThrough = stringValue(skill.skillScoredThrough);
  if (!skillAsOf || !scoredThrough) return false;
  return compareTime(skillAsOf, asOf) <= 0 && compareTime(scoredThrough, asOf) <= 0;
}

function computeRankMetric(
  observations: CongressScoreObservation[],
  xOf: (obs: CongressScoreObservation) => number,
  yOf: (obs: CongressScoreObservation) => number,
  minNamesPerDate: number
): CongressRankMetric {
  const perDate: number[] = [];
  for (const group of groupByDate(observations).values()) {
    if (group.length < minNamesPerDate) continue;
    const xs = group.map(xOf);
    const ys = group.map(yOf);
    if (xs.some((v) => !Number.isFinite(v)) || ys.some((v) => !Number.isFinite(v))) continue;
    const ic = spearman(xs, ys);
    if (ic !== undefined) perDate.push(ic);
  }
  return summarizeICs(perDate);
}

function computeMarginalMetric(observations: CongressScoreObservation[], minNamesPerDate: number): CongressRankMetric {
  const perDate: number[] = [];
  for (const group of groupByDate(observations).values()) {
    const usable = group.filter((obs) => Number.isFinite(obs.baselineScore));
    if (usable.length < minNamesPerDate) continue;
    const baseline = usable.map((obs) => obs.baselineScore as number);
    const scoreResiduals = residualize(usable.map((obs) => signedScore(obs)), baseline);
    const returnResiduals = residualize(usable.map((obs) => targetReturn(obs)), baseline);
    const ic = spearman(scoreResiduals, returnResiduals);
    if (ic !== undefined) perDate.push(ic);
  }
  return summarizeICs(perDate);
}

function computeQuantiles(observations: CongressScoreObservation[], quantiles: number, minNamesPerDate: number): CongressQuantileStat[] {
  const buckets = Array.from({ length: quantiles }, (_, i) => ({ bucket: i + 1, returns: [] as number[] }));
  for (const group of groupByDate(observations).values()) {
    if (group.length < Math.max(quantiles, minNamesPerDate)) continue;
    const sorted = [...group].sort((a, b) => signedScore(a) - signedScore(b));
    sorted.forEach((obs, i) => {
      const bucket = Math.min(quantiles - 1, Math.floor((i * quantiles) / sorted.length));
      buckets[bucket].returns.push(targetReturn(obs));
    });
  }
  return buckets.map((bucket) => ({
    bucket: bucket.bucket,
    n: bucket.returns.length,
    avgReturn: bucket.returns.length ? round6(mean(bucket.returns)) : 0,
    hitRate: bucket.returns.length ? round6(bucket.returns.filter((r) => r > 0).length / bucket.returns.length) : 0
  }));
}

function rotateScoresByDate(observations: CongressScoreObservation[], seed: number): CongressScoreObservation[] {
  const out: CongressScoreObservation[] = [];
  for (const [date, group] of groupByDate(observations)) {
    const sorted = [...group].sort((a, b) => a.symbol.localeCompare(b.symbol));
    const offset = sorted.length > 1 ? 1 + (Math.abs(hash(`${seed}:${date}`)) % (sorted.length - 1)) : 0;
    sorted.forEach((obs, i) => {
      const donor = sorted[(i + offset) % sorted.length];
      out.push({
        ...obs,
        congressScore: donor.congressScore,
        congressSignedScore: donor.congressSignedScore,
        congressDirection: donor.congressDirection
      });
    });
  }
  return out;
}

function parseSnapshot(row: SignalSnapshotAuditRow): { snapshotDate: string; signals: NonNullable<SignalSnapshotPayload["signals"]> } | undefined {
  const payload = row.payload as SignalSnapshotPayload | undefined;
  if (!payload || !Array.isArray(payload.signals)) return undefined;
  const snapshotDate = toBusinessDay(payload.asOf) ?? toBusinessDay(row.createdAt);
  if (!snapshotDate) return undefined;
  return { snapshotDate, signals: payload.signals };
}

function normalizeObservation(obs: CongressScoreObservation): CongressScoreObservation | undefined {
  const symbol = normalizeSymbol(obs.symbol);
  const date = toBusinessDay(obs.date);
  const congressScore = finiteNumber(obs.congressScore);
  const forwardReturn = finiteNumber(obs.forwardReturn);
  if (!symbol || !date || congressScore === undefined || forwardReturn === undefined) return undefined;
  return { ...obs, symbol, date, congressScore, forwardReturn };
}

function direction(value: unknown): CongressScoreEvalDirection | undefined {
  const v = stringValue(value)?.toUpperCase();
  return v === "BUY" || v === "SELL" || v === "NEUTRAL" ? v : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function signedScore(obs: CongressScoreObservation): number {
  const explicit = finiteNumber(obs.congressSignedScore);
  if (explicit !== undefined) return explicit;
  const score = finiteNumber(obs.congressScore) ?? 0;
  return obs.congressDirection === "SELL" ? -score : score;
}

function targetReturn(obs: CongressScoreObservation): number {
  const forward = finiteNumber(obs.forwardReturn) ?? 0;
  const benchmark = finiteNumber(obs.benchmarkReturn);
  return benchmark === undefined ? forward : forward - benchmark;
}

function targetDateAfter(date: string, horizonDays: number): string {
  const time = Date.parse(date);
  if (!Number.isFinite(time)) return date;
  return new Date(time + horizonDays * DAY_MS).toISOString().slice(0, 10);
}

function selectExitClose(bars: OHLCBar[], targetDate: string): number | undefined {
  return bars
    .map((bar) => ({ date: toBusinessDay(bar.time), close: positiveNumber(bar.close) }))
    .filter((bar): bar is { date: string; close: number } => Boolean(bar.date && bar.close))
    .sort((a, b) => a.date.localeCompare(b.date))
    .find((bar) => bar.date >= targetDate)?.close;
}

function benchmarkReturn(bars: OHLCBar[], entryDate: string, exitDate: string): number | undefined {
  const entry = selectExitClose(bars, entryDate);
  const exit = selectExitClose(bars, exitDate);
  if (entry === undefined || exit === undefined) return undefined;
  return (exit - entry) / entry;
}

function groupByDate(observations: CongressScoreObservation[]): Map<string, CongressScoreObservation[]> {
  const byDate = new Map<string, CongressScoreObservation[]>();
  for (const obs of observations) {
    const bucket = byDate.get(obs.date);
    if (bucket) bucket.push(obs);
    else byDate.set(obs.date, [obs]);
  }
  return byDate;
}

function residualize(values: number[], control: number[]): number[] {
  const cMean = mean(control);
  const vMean = mean(values);
  let cov = 0;
  let variance = 0;
  for (let i = 0; i < values.length; i++) {
    const dc = control[i] - cMean;
    cov += dc * (values[i] - vMean);
    variance += dc * dc;
  }
  if (variance <= 0) return values.map((v) => v - vMean);
  const beta = cov / variance;
  return values.map((v, i) => v - (vMean + beta * (control[i] - cMean)));
}

function summarizeICs(values: number[]): CongressRankMetric {
  if (values.length === 0) return { meanIC: 0, nDates: 0, tStat: 0 };
  const avg = mean(values);
  if (values.length < 3) return { meanIC: round6(avg), nDates: values.length, tStat: 0 };
  const variance = values.reduce((sum, v) => sum + (v - avg) ** 2, 0) / (values.length - 1);
  const std = Math.sqrt(variance);
  const tStat = std > 1e-9 ? avg / (std / Math.sqrt(values.length)) : 0;
  return { meanIC: round6(avg), nDates: values.length, tStat: round6(tStat) };
}

function spearman(xs: number[], ys: number[]): number | undefined {
  if (xs.length !== ys.length || xs.length < 2) return undefined;
  return pearson(averageRanks(xs), averageRanks(ys));
}

function averageRanks(values: number[]): number[] {
  const indexed = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const ranks = new Array<number>(values.length);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (j + 1 < indexed.length && indexed[j + 1].value === indexed[i].value) j += 1;
    const avgRank = (i + 1 + (j + 1)) / 2;
    for (let k = i; k <= j; k++) ranks[indexed[k].index] = avgRank;
    i = j + 1;
  }
  return ranks;
}

function pearson(xs: number[], ys: number[]): number | undefined {
  const mx = mean(xs);
  const my = mean(ys);
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  if (vx <= 0 || vy <= 0) return undefined;
  return cov / Math.sqrt(vx * vy);
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function hash(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h | 0;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function compareTime(a: string, b: string): number {
  const at = Date.parse(a);
  const bt = Date.parse(b);
  if (Number.isFinite(at) && Number.isFinite(bt)) return at - bt;
  const ad = toBusinessDay(a);
  const bd = toBusinessDay(b);
  if (!ad || !bd) return 0;
  return ad.localeCompare(bd);
}

function boundedInteger(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = Math.floor(Number(value));
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, numeric));
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
