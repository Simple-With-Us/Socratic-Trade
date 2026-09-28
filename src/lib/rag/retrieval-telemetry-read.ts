// Read-side aggregation for the retrieval stage telemetry (P1-4, 2026-09-27).
//
// THE GAP THIS CLOSES. `rag_retrieval_stage_trace` and `rag_retrieval_quality` are written
// DEFAULT-ON (src/lib/vector-db.ts emits the stage trace; src/lib/rag-metering.ts emits the quality
// distribution) and record exactly the thing you need to diagnose a bad decision: which stage of
// recall threw the candidates away, and how long each stage took.  Before this module the only
// reference to either event anywhere in the repo was `audit-prune.ts`, which decides how long to
// KEEP them.  Nothing could read them.  So a recall stage that silently returned nothing was
// invisible in-product: the only symptom was a decision that looked inexplicable.
//
// This module is the aggregating read. It is deliberately a PURE FUNCTION over already-parsed
// payloads rather than a query: the caller (the admin route) does the bounded, filtered read, and
// this turns rows into the shape the page renders. That keeps the SQL in the route where the other
// admin routes keep theirs, and makes the aggregation trivially testable without a database.
//
// PRIVACY / DISCLOSURE. These payloads contain no raw query text and no document text — the query is
// represented only by a short deterministic digest (`queryDigest` in retrieval-stage-telemetry.ts,
// which states outright that it "is a correlation key, not a security or authentication primitive").
// What this module surfaces is therefore per-STAGE and per-SYMBOL aggregates: counts, durations, and
// drop arithmetic.  It never reconstructs a query and never echoes document text.

export type RetrievalStage =
  | "query_embed_cache"
  | "query_embed_api"
  | "dense_query"
  | "lexical_query"
  | "fusion"
  | "score_floor"
  | "rerank"
  | "asof_filter"
  | "relevance_floor"
  | "dedupe"
  | "final_injection";

export interface RetrievalStageReceipt {
  stage?: string;
  ordinal?: number;
  durationMs?: number;
  ok?: boolean;
  errorKind?: string;
  cacheHit?: boolean;
  candidatesIn?: number;
  candidatesOut?: number;
  dropped?: number;
  provider?: string;
  model?: string;
  route?: string;
}

export interface RetrievalTraceSnapshot {
  traceVersion?: number;
  queryHash?: string;
  symbol?: string;
  route?: string;
  wallDurationMs?: number;
  finalCandidates?: number;
  stages?: RetrievalStageReceipt[];
}

export interface RetrievalQualityPayload {
  queryHash?: string;
  k?: number;
  candidates?: number;
  droppedByMinScore?: number;
  droppedByAsOf?: number;
  hybrid?: boolean;
  rerankAttempted?: boolean;
  rerankRan?: boolean;
  topCosine?: number;
  topRelevanceScore?: number;
  finalCount?: number;
}

export interface RetrievalStageAggregate {
  stage: string;
  calls: number;
  errors: number;
  cacheHits: number;
  totalDurationMs: number;
  meanDurationMs: number;
  p95DurationMs: number;
  maxDurationMs: number;
  candidatesIn: number;
  candidatesOut: number;
  dropped: number;
  /** Share of calls in which this stage removed at least one candidate. 0 when it never drops. */
  dropRate: number;
  /** Distinct errorKind values seen, so a new failure mode is visible without a deploy. */
  errorKinds: string[];
  providers: string[];
  models: string[];
}

export interface RetrievalSymbolAggregate {
  symbol: string;
  traces: number;
  meanWallDurationMs: number;
  meanFinalCandidates: number;
  /** Traces whose final candidate count was zero — the "recall returned nothing" signal. */
  emptyTraces: number;
  totalDurationMs: number;
}

export interface RetrievalQualityAggregate {
  samples: number;
  meanCandidates: number;
  meanFinalCount: number;
  totalDroppedByMinScore: number;
  totalDroppedByAsOf: number;
  hybridSamples: number;
  rerankAttempted: number;
  rerankRan: number;
  meanTopCosine: number;
  meanTopRelevanceScore: number;
  /** The headline: retrievals that ended with nothing, as a share of samples. */
  emptyRate: number;
}

export interface RetrievalTelemetryReport {
  /** Audit rows read, after the route's own bound/filter. */
  rowsRead: number;
  sinceIso: string;
  traces: number;
  stages: RetrievalStageAggregate[];
  symbols: RetrievalSymbolAggregate[];
  quality: RetrievalQualityAggregate;
  /** Oldest and newest trace timestamps actually observed, so "no data" is distinguishable from
   * "the telemetry was off for the whole window" — the two look identical without them. */
  firstTraceAt: string | null;
  lastTraceAt: string | null;
  /** Routes observed, so a trace that only ever came from one caller is obvious. */
  routes: string[];
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value: number, dp = 2): number {
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
}

/** Nearest-rank p95 over a copy; returns 0 for an empty input. */
function percentile95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(0.95 * sorted.length) - 1));
  return sorted[index];
}

/** Cap every string dimension so a malformed or adversarial payload cannot grow the response. */
function capString(value: unknown, max = 80): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return value.slice(0, max);
}

/**
 * Aggregate stage traces. Pure: it takes already-read payloads and never touches the database.
 * A malformed snapshot (bad JSON was already handled upstream, but a payload of the wrong SHAPE
 * certainly will arrive) is skipped rather than thrown on — a diagnostics endpoint that 500s because
 * one row is odd is worse than one that reports 99 good rows.
 */
export function aggregateRetrievalStageTraces(
  snapshots: readonly RetrievalTraceSnapshot[]
): { stages: RetrievalStageAggregate[]; symbols: RetrievalSymbolAggregate[]; routes: string[] } {
  interface StageAccumulator {
    calls: number;
    errors: number;
    cacheHits: number;
    durations: number[];
    candidatesIn: number;
    candidatesOut: number;
    dropped: number;
    dropCalls: number;
    errorKinds: Set<string>;
    providers: Set<string>;
    models: Set<string>;
  }
  const byStage = new Map<string, StageAccumulator>();
  const bySymbol = new Map<string, { traces: number; wall: number[]; finalCandidates: number[]; empty: number; total: number }>();
  const routes = new Set<string>();

  for (const snapshot of snapshots) {
    if (!snapshot || typeof snapshot !== "object") continue;
    // A snapshot whose `stages` is not an array carries no information at all — no stage receipts
    // means nothing to aggregate and no symbol worth bucketing under "unknown".
    if (!Array.isArray(snapshot.stages)) continue;
    // Same for a snapshot whose receipts are all junk: a trace with no USABLE stage is not a trace,
    // and bucketing it would invent a meaningless "unknown" symbol row in the report.
    const stages = snapshot.stages.filter(
      (stage): stage is RetrievalStageReceipt =>
        Boolean(stage) && typeof stage === "object" && capString(stage.stage, 40) !== null
    );
    if (stages.length === 0) continue;

    const wall = finite(snapshot.wallDurationMs);
    const finalCandidates = finite(snapshot.finalCandidates);
    const symbol = capString(snapshot.symbol, 16) ?? "unknown";
    const symbolRow = bySymbol.get(symbol) ?? { traces: 0, wall: [], finalCandidates: [], empty: 0, total: 0 };
    symbolRow.traces += 1;
    if (wall !== undefined) symbolRow.wall.push(wall);
    if (finalCandidates !== undefined) symbolRow.finalCandidates.push(finalCandidates);
    // A trace that reached the end with no candidates is the "recall silently returned nothing"
    // case this whole feature exists to make visible.
    if (finalCandidates === 0) symbolRow.empty += 1;
    symbolRow.total += stages.reduce((sum, stage) => sum + (finite(stage?.durationMs) ?? 0), 0);
    bySymbol.set(symbol, symbolRow);

    const route = capString(snapshot.route, 60);
    if (route) routes.add(route);

    for (const stage of stages) {
      // Already filtered to a named stage above.
      const name = capString(stage.stage, 40);
      if (!name) continue;
      const acc = byStage.get(name) ?? {
        calls: 0,
        errors: 0,
        cacheHits: 0,
        durations: [],
        candidatesIn: 0,
        candidatesOut: 0,
        dropped: 0,
        dropCalls: 0,
        errorKinds: new Set<string>(),
        providers: new Set<string>(),
        models: new Set<string>()
      };
      acc.calls += 1;
      if (stage.ok === false) acc.errors += 1;
      if (stage.cacheHit === true) acc.cacheHits += 1;
      const duration = finite(stage.durationMs);
      if (duration !== undefined) acc.durations.push(duration);
      const inCount = finite(stage.candidatesIn);
      const outCount = finite(stage.candidatesOut);
      const dropped = finite(stage.dropped);
      if (inCount !== undefined) acc.candidatesIn += inCount;
      if (outCount !== undefined) acc.candidatesOut += outCount;
      if (dropped !== undefined) acc.dropped += dropped;
      // dropRate counts CALLS that dropped, not candidates dropped, so a stage that removes 1 of
      // 500 is not reported as more consequential than one that removes 400 of 400.
      if ((dropped !== undefined && dropped > 0) || (inCount !== undefined && outCount !== undefined && outCount < inCount)) {
        acc.dropCalls += 1;
      }
      const errorKind = capString(stage.errorKind, 60);
      if (errorKind) acc.errorKinds.add(errorKind);
      const provider = capString(stage.provider, 60);
      if (provider) acc.providers.add(provider);
      const model = capString(stage.model, 60);
      if (model) acc.models.add(model);
      byStage.set(name, acc);
    }
  }

  const stages: RetrievalStageAggregate[] = [...byStage.entries()]
    .map(([stage, acc]) => ({
      stage,
      calls: acc.calls,
      errors: acc.errors,
      cacheHits: acc.cacheHits,
      totalDurationMs: round(acc.durations.reduce((sum, value) => sum + value, 0)),
      meanDurationMs: round(mean(acc.durations)),
      p95DurationMs: round(percentile95(acc.durations)),
      maxDurationMs: round(acc.durations.length ? Math.max(...acc.durations) : 0),
      candidatesIn: acc.candidatesIn,
      candidatesOut: acc.candidatesOut,
      dropped: acc.dropped,
      dropRate: acc.calls ? round(acc.dropCalls / acc.calls, 4) : 0,
      errorKinds: [...acc.errorKinds].sort(),
      providers: [...acc.providers].sort(),
      models: [...acc.models].sort()
    }))
    // Busiest stage first: the point of the page is "which stage is eating the retrieval".
    .sort((a, b) => b.calls - a.calls || a.stage.localeCompare(b.stage));

  const symbols: RetrievalSymbolAggregate[] = [...bySymbol.entries()]
    .map(([symbol, row]) => ({
      symbol,
      traces: row.traces,
      meanWallDurationMs: round(mean(row.wall)),
      meanFinalCandidates: round(mean(row.finalCandidates), 3),
      emptyTraces: row.empty,
      totalDurationMs: round(row.total)
    }))
    .sort((a, b) => b.traces - a.traces || a.symbol.localeCompare(b.symbol));

  return { stages, symbols, routes: [...routes].sort() };
}

/** Aggregate the retrieval-quality distribution rows. Same pure-function contract. */
export function aggregateRetrievalQuality(
  payloads: readonly RetrievalQualityPayload[]
): RetrievalQualityAggregate {
  let samples = 0;
  const candidates: number[] = [];
  const finalCounts: number[] = [];
  const topCosines: number[] = [];
  const topRelevance: number[] = [];
  let droppedByMinScore = 0;
  let droppedByAsOf = 0;
  let hybridSamples = 0;
  let rerankAttempted = 0;
  let rerankRan = 0;

  for (const payload of payloads) {
    if (!payload || typeof payload !== "object") continue;
    samples += 1;
    const candidateCount = finite(payload.candidates);
    if (candidateCount !== undefined) candidates.push(candidateCount);
    const finalCount = finite(payload.finalCount);
    if (finalCount !== undefined) finalCounts.push(finalCount);
    const cosine = finite(payload.topCosine);
    if (cosine !== undefined) topCosines.push(cosine);
    const relevance = finite(payload.topRelevanceScore);
    if (relevance !== undefined) topRelevance.push(relevance);
    droppedByMinScore += finite(payload.droppedByMinScore) ?? 0;
    droppedByAsOf += finite(payload.droppedByAsOf) ?? 0;
    if (payload.hybrid === true) hybridSamples += 1;
    if (payload.rerankAttempted === true) rerankAttempted += 1;
    if (payload.rerankRan === true) rerankRan += 1;
  }

  const empty = finalCounts.filter((count) => count === 0).length;
  return {
    samples,
    meanCandidates: round(mean(candidates), 3),
    meanFinalCount: round(mean(finalCounts), 3),
    totalDroppedByMinScore: droppedByMinScore,
    totalDroppedByAsOf: droppedByAsOf,
    hybridSamples,
    rerankAttempted,
    rerankRan,
    meanTopCosine: round(mean(topCosines), 4),
    meanTopRelevanceScore: round(mean(topRelevance), 4),
    emptyRate: finalCounts.length ? round(empty / finalCounts.length, 4) : 0
  };
}
