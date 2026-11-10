// lookahead-audit.ts — truncated-replay lookahead audit (freqtrade lookahead-analysis port).
//
// freqtrade's lookahead-analysis re-runs a strategy on data truncated at each decision point and
// flags any indicator whose value changes when the future is removed. This app's equivalent:
// for a sample of matured decisions from the persisted `signal_snapshot` evidence, recompute the
// decision inputs that ARE reconstructable point-in-time and diff them against what was persisted
// at decision time. Scoped per the gap analysis to the two genuinely reconstructable subsystems:
//   1. Momentum/liquidity factor sub-scores — replayed from a daily OHLC series truncated to
//      bar.date <= decision date, through the same pure scoreFactors the scan used.
//   2. RAG evidence — the deterministic filings query is rebuilt from the persisted decision and
//      re-run with asOf pinned to the decision stamp and strictAsOf, then diffed against the
//      persisted candidate-pool `used:true` rows (opt-in RAG_PERSIST_CANDIDATE_POOL receipts).
// Everything else (value/quality/sentiment/positioning/diversification, and volatility — which is
// only recomputable from the same persisted snapshot fields, a self-copy that can never expose a
// leak) is ALWAYS classified 'unverifiable' with a stored backtestSafety label, so the coverage
// gap is a visible receipt — never silently implied clean.
//
// Design split (intentional, mirrors backtest.ts): sampling/persistence/retrieval are the IO
// functions; truncation, factor replay, RAG classification, and the verdict are PURE and
// Date.now()-free so they unit-test with in-memory fixtures. Honest floors: below the verdict
// floor the aggregate is 'insufficient_sample', never a fabricated all-clear. Read-only and
// advisory — findings and the lookahead_leak notification gate nothing.
//
// Truncation boundary note: bars are truncated INCLUSIVE of the decision date (the same
// convention the outcome-horizon maturity gate uses), so an intraday decision replayed against
// the decision day's FINAL bar carries benign same-day drift — the tolerance knob absorbs it.
// Sub-daily leaks are below this audit's resolution and are not claimed either way.

import type { BacktestOHLCFetcher } from "./backtest";
import { audit, listUsers } from "./db";
import { claimDueJobs, completeDueJob, enqueueDueJob, failDueJob, getDueJobStats } from "./db-jobs";
import { listRagCandidatePoolAudit, listSignalSnapshotAuditAfter } from "./db-learning";
import {
  countLookaheadFindingsByClassification,
  upsertLookaheadAuditFindings,
  type LookaheadAuditFindingRow,
  type LookaheadClassification
} from "./db-lookahead-audit";
import { getInternalSetting, setInternalSetting } from "./db-settings";
import { fetchDailyOHLC, toBusinessDay } from "./history";
import { computeTechnicals, type OHLCBar } from "./indicators";
import { addTradingDays, marketDateOf } from "./market-calendar";
import { scoreFactors } from "./market";
import { normalizeSymbol } from "./money";
import type { CandidatePoolEntry } from "./rag/candidate-pool";
import { deterministicFilingsRetrievalQuery, strategyInformationRouting } from "./rag/information-routing";
import { hashQuery } from "./rag-metering";
import type { CandidateEvidence, MarketQuote } from "./types";

export type { LookaheadClassification };

const DAY_MS = 86_400_000;
/** Slot staggered off :00 and away from the r2 cold snapshot's Sunday 03:17. */
const SLOT_UTC_HOUR = 4;
const SLOT_UTC_MINUTE = 47;
/** Fewest truncated daily bars before a trailing 52-week high/low replay is honest. */
const MIN_52W_REPLAY_BARS = 20;
/** Trailing daily bars approximating 52 weeks for the high/low replay. */
const TRAILING_52W_BARS = 252;
/**
 * The aggregate verdict counts only findings from the trailing N days, not the full
 * lookahead_audit_findings table. Without a window, one ancient mismatch (since fixed) would pin
 * the verdict at 'lookahead_mismatch_detected' forever — every later clean pass could never
 * recover an all-clear. 90 days ≈ 12-13 weekly passes at the default 7-day cadence, long enough to
 * accumulate a real verdictFloor-sized sample while still letting a resolved leak age out. Full
 * history remains queryable as receipts via listLookaheadAuditFindings — only the rolled-up
 * verdict is windowed.
 */
export const LOOKAHEAD_VERDICT_WINDOW_DAYS = 90;

/** ISO stamp `LOOKAHEAD_VERDICT_WINDOW_DAYS` before `now` — the aggregate verdict's trailing
 *  window floor. Shared by the due-job pass and the read-only API route so both report the same
 *  windowed verdict. */
export function lookaheadVerdictWindowSinceIso(now: number = Date.now()): string {
  return new Date(now - LOOKAHEAD_VERDICT_WINDOW_DAYS * DAY_MS).toISOString();
}

export const LOOKAHEAD_AUDIT_JOB_TYPE = "lookahead_audit";

const WATERMARK_KEY_PREFIX = "lookahead_audit:watermark";
const DISABLED_AUDIT_KEY = "lookahead_audit:disabledAuditedReason";

/** One finding as the pure layer produces it — userId/createdAt attach at persistence. */
export type LookaheadFinding = Omit<LookaheadAuditFindingRow, "userId" | "createdAt">;

// ── Config (owner-adjustable env knobs; documented in .env.example) ───────────

export interface LookaheadAuditConfig {
  /** Default ON (read-only, non-blocking). LOOKAHEAD_AUDIT_ENABLED=0/off/false/no kills the lane. */
  enabled: boolean;
  disabledReason?: "kill_switch";
  /** Matured decisions sampled per pass. Default 25. */
  sampleSize: number;
  /** Minimum clean+mismatch observations before an aggregate all-clear. Default 20. */
  verdictFloor: number;
  /** Factor sub-score mismatch tolerance (0-100 points). Default 15. */
  tolerancePoints: number;
  /** Minimum Jaccard similarity of persisted-used vs replay chunk ids. Default 0.5. */
  jaccardMin: number;
  /** Days between passes. Default 7 (weekly). */
  cadenceDays: number;
  /** Outcome-horizon maturity gate in trading days — decisions younger than this are skipped. */
  horizonDays: number;
}

// Number("") is 0 — an unset/blank knob must fall back, not clamp to the minimum.
function boundedInt(raw: string | undefined, min: number, max: number, fallback: number): number {
  if (raw == null || raw.trim() === "") return fallback;
  const numeric = Math.floor(Number(raw));
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, numeric));
}

function boundedNum(raw: string | undefined, min: number, max: number, fallback: number): number {
  if (raw == null || raw.trim() === "") return fallback;
  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, numeric));
}

export function loadLookaheadAuditConfig(env: NodeJS.ProcessEnv = process.env): LookaheadAuditConfig {
  // Explicit kill-token semantics (r2-cold-snapshot precedent): default ON, and only a deliberate
  // off token disables — a typo'd value must not silently kill an on-by-default audit lane.
  const killRaw = env.LOOKAHEAD_AUDIT_ENABLED?.trim().toLowerCase();
  const killed = killRaw === "0" || killRaw === "off" || killRaw === "false" || killRaw === "no";
  return {
    enabled: !killed,
    ...(killed ? { disabledReason: "kill_switch" as const } : {}),
    sampleSize: boundedInt(env.LOOKAHEAD_AUDIT_SAMPLE, 1, 200, 25),
    verdictFloor: boundedInt(env.LOOKAHEAD_AUDIT_VERDICT_FLOOR, 1, 1000, 20),
    // min 0 (not 1): the doc'd range is 0-100 and an explicit "zero tolerance" must be honored,
    // not silently promoted to 1 — Number("") is 0 too, but boundedNum's blank check above already
    // routes an unset knob to the `fallback` before this floor is ever applied.
    tolerancePoints: boundedNum(env.LOOKAHEAD_AUDIT_TOLERANCE_POINTS, 0, 100, 15),
    jaccardMin: boundedNum(env.LOOKAHEAD_AUDIT_JACCARD_MIN, 0, 1, 0.5),
    cadenceDays: boundedInt(env.LOOKAHEAD_AUDIT_CADENCE_DAYS, 1, 90, 7),
    horizonDays: boundedInt(env.LOOKAHEAD_AUDIT_HORIZON_DAYS, 1, 60, 5)
  };
}

// ── Sampling (IO: reads signal_snapshot audit rows) ───────────────────────────

export interface LookaheadDecisionInput {
  /** `${signal_snapshot audit id}:${symbol}`. */
  decisionId: string;
  auditRowid: number;
  runId?: string;
  symbol: string;
  /** Market day (America/New_York) the decision belongs to. */
  decisionDate: string;
  /** Decision snapshot ISO stamp — the point-in-time pin. */
  asOf?: string;
  evidence: CandidateEvidence;
}

export interface LookaheadSampleResult {
  decisions: LookaheadDecisionInput[];
  /** Highest snapshot rowid consumed this pass — the caller's next watermark. */
  nextWatermarkRowid?: number;
  /** True when the scan stopped at a not-yet-matured snapshot (the maturity frontier). */
  stoppedAtUnmatured: boolean;
}

interface SignalSnapshotPayload {
  runId?: string;
  asOf?: string;
  signals?: CandidateEvidence[];
}

/**
 * Sample up to `sampleSize` matured decisions (one decision = one candidate in one snapshot),
 * walking `signal_snapshot` audit rows oldest-first from the caller's watermark. A snapshot still
 * inside the outcome horizon stops the scan (rowid order tracks time), so the watermark never
 * advances past unmatured evidence. When a snapshot holds more signals than the remaining sample
 * capacity, the surplus is skipped and the watermark still advances — this is a sampling audit,
 * not an exhaustive one.
 */
export function sampleDecisionsForLookaheadAudit(
  userId: string = "local",
  options: { sampleSize?: number; horizonDays?: number; now?: number; afterRowid?: number } = {}
): LookaheadSampleResult {
  const sampleSize = Math.max(1, Math.min(200, Math.floor(options.sampleSize ?? 25)));
  const horizonDays = Math.max(1, Math.min(60, Math.floor(options.horizonDays ?? 5)));
  const now = options.now ?? Date.now();
  const nowIso = new Date(now).toISOString();
  const todayMarket = marketDateOf(nowIso) ?? nowIso.slice(0, 10);

  const decisions: LookaheadDecisionInput[] = [];
  let watermark = options.afterRowid;
  let nextWatermarkRowid: number | undefined;
  let stoppedAtUnmatured = false;

  outer: for (let scan = 0; scan < 20; scan++) {
    const rows = listSignalSnapshotAuditAfter(
      userId,
      watermark !== undefined ? { lastAuditRowid: watermark } : undefined,
      25
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      watermark = row.rowid;
      const payload = row.payload as SignalSnapshotPayload | undefined;
      const decisionDate =
        (typeof payload?.asOf === "string" ? marketDateOf(payload.asOf) : undefined) ?? marketDateOf(row.createdAt);
      if (!payload || !Array.isArray(payload.signals) || !decisionDate) {
        nextWatermarkRowid = row.rowid; // malformed/undatable — consume and move on
        continue;
      }
      if (addTradingDays(decisionDate, horizonDays) > todayMarket) {
        stoppedAtUnmatured = true;
        break outer;
      }
      for (const signal of payload.signals) {
        if (decisions.length >= sampleSize) break;
        const symbol = normalizeSymbol(signal?.symbol ?? "");
        if (!symbol) continue;
        decisions.push({
          decisionId: `${row.id}:${symbol}`,
          auditRowid: row.rowid,
          ...(typeof payload.runId === "string" ? { runId: payload.runId } : {}),
          symbol,
          decisionDate,
          asOf: typeof payload.asOf === "string" ? payload.asOf : row.createdAt,
          evidence: signal
        });
      }
      nextWatermarkRowid = row.rowid;
      if (decisions.length >= sampleSize) break outer;
    }
  }

  return { decisions, ...(nextWatermarkRowid !== undefined ? { nextWatermarkRowid } : {}), stoppedAtUnmatured };
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  const numeric = finiteNumber(value);
  return numeric !== undefined && numeric > 0 ? numeric : undefined;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** Bars at/before the decision date (see the truncation-boundary note above), oldest first. */
export function truncateBarsToDecision(bars: OHLCBar[] | null | undefined, decisionDate: string): OHLCBar[] {
  if (!Array.isArray(bars)) return [];
  return bars
    .map((bar) => ({ bar, date: toBusinessDay(bar.time) }))
    .filter((entry): entry is { bar: OHLCBar; date: string } =>
      Boolean(entry.date && entry.date <= decisionDate && finiteNumber(entry.bar.close) !== undefined)
    )
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((entry) => entry.bar);
}

/** Jaccard similarity of two id sets; two empty sets agree perfectly (1). Pure. */
export function jaccardSimilarity(a: readonly string[], b: readonly string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  let intersection = 0;
  for (const id of setA) if (setB.has(id)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

/** Epoch ms from an as-of stamp that may be ISO or a numeric epoch (s or ms). Pure. */
export function asOfEpochMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const numeric = Number(trimmed);
    if (!Number.isFinite(numeric)) return undefined;
    return numeric > 1e12 ? numeric : numeric * 1000;
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

// ── Factor replay (pure) ──────────────────────────────────────────────────────

/** The always-unverifiable factors and the honest reason each cannot be replayed. */
export const LOOKAHEAD_UNVERIFIABLE_FACTORS = [
  "value",
  "quality",
  "volatility",
  "sentiment",
  "positioning",
  "diversification"
] as const;

const UNVERIFIABLE_FACTOR_REASONS: Record<(typeof LOOKAHEAD_UNVERIFIABLE_FACTORS)[number], string> = {
  value: "P/E, FCF yield, and market cap carry no persisted point-in-time history to replay.",
  quality: "Debt/equity, EPS growth, and market cap carry no persisted point-in-time history to replay.",
  volatility:
    "Recomputable only from the same persisted snapshot fields (intraday change, beta) — a self-copy can never expose a leak, so it is not counted as verified.",
  sentiment: "Decision-time news sentiment has no persisted point-in-time source to replay.",
  positioning: "Congressional/insider/short-interest overlays are not reconstructable as of the decision date.",
  diversification: "Depends on decision-time portfolio holdings, which this audit does not reconstruct."
};

export const LOOKAHEAD_BACKTEST_SAFETY_LABEL = "not_point_in_time_replayable";

/**
 * PURE. Replay the momentum and liquidity factor sub-scores from a truncated bar series and diff
 * against the persisted factorBreakdown; emit the always-unverifiable factors as labeled receipts.
 * The replay clone mirrors the decision-time quote's FIELD AVAILABILITY (per-field `sources`
 * provenance + the persisted technicalScore) so a field the original quote never had is not
 * invented into the replay — availability that cannot be mirrored classifies as 'unverifiable',
 * never as a fabricated clean/mismatch.
 */
export function replayFactorFindings(
  decision: LookaheadDecisionInput,
  bars: OHLCBar[] | null,
  tolerancePoints: number
): LookaheadFinding[] {
  const evidence = decision.evidence;
  const breakdown = evidence.factorBreakdown;
  const base = {
    decisionId: decision.decisionId,
    ...(decision.runId ? { runId: decision.runId } : {}),
    symbol: decision.symbol,
    ...(decision.asOf ? { asOf: decision.asOf } : {})
  };
  const findings: LookaheadFinding[] = [];

  const unverifiable = (
    factorOrField: string,
    persistedValue: number | undefined,
    reason: string,
    extra: Record<string, unknown> = {}
  ): LookaheadFinding => ({
    ...base,
    factorOrField,
    classification: "unverifiable",
    ...(persistedValue !== undefined ? { persistedValue } : {}),
    detail: { reason, ...extra }
  });

  const truncated = truncateBarsToDecision(bars, decision.decisionDate);
  const lastBar = truncated[truncated.length - 1];
  const lastBarDate = lastBar ? toBusinessDay(lastBar.time) : undefined;
  const hasDecisionDayBar = lastBarDate === decision.decisionDate;

  const persistedMomentum = finiteNumber(breakdown?.momentum);
  const persistedLiquidity = finiteNumber(breakdown?.liquidity);
  const intraday = finiteNumber(evidence.intradayChangePct);
  const refPrice = positiveNumber(evidence.refPrice);
  const hadTech = finiteNumber(evidence.technicalScore) !== undefined;
  const had52w = Boolean(evidence.sources?.fiftyTwoWeekHigh) && Boolean(evidence.sources?.fiftyTwoWeekLow);
  const hadVolume = Boolean(evidence.sources?.volume);

  const replayTech = hadTech && truncated.length > 0 ? computeTechnicals(truncated)?.score : undefined;
  let replay52: { high: number; low: number } | undefined;
  if (had52w && truncated.length >= MIN_52W_REPLAY_BARS) {
    const window = truncated.slice(-TRAILING_52W_BARS);
    let high = -Infinity;
    let low = Infinity;
    for (const bar of window) {
      high = Math.max(high, finiteNumber(bar.high) ?? bar.close);
      low = Math.min(low, finiteNumber(bar.low) ?? bar.close);
    }
    if (Number.isFinite(high) && Number.isFinite(low) && high > low) replay52 = { high, low };
  }
  const decisionDayVolume = hasDecisionDayBar ? positiveNumber(lastBar?.volume) : undefined;

  const clone: MarketQuote = {
    symbol: decision.symbol,
    price: refPrice ?? finiteNumber(lastBar?.close) ?? 0,
    volume: decisionDayVolume ?? 0,
    intradayChangePct: intraday ?? 0,
    positionMarketValue: 0,
    score: 0,
    ...(hadTech && replayTech !== undefined ? { technicalScore: replayTech } : {}),
    ...(replay52 ? { fiftyTwoWeekHigh: replay52.high, fiftyTwoWeekLow: replay52.low } : {})
  };
  const recomputed = scoreFactors(clone);

  // momentum
  if (persistedMomentum === undefined) {
    findings.push(unverifiable("momentum", undefined, "no_persisted_factor_breakdown"));
  } else if (intraday === undefined) {
    findings.push(unverifiable("momentum", persistedMomentum, "no_persisted_intraday_change"));
  } else if (refPrice === undefined) {
    findings.push(unverifiable("momentum", persistedMomentum, "no_persisted_ref_price"));
  } else if (!hasDecisionDayBar) {
    findings.push(
      unverifiable("momentum", persistedMomentum, "no_decision_day_bar", {
        lastBarDate,
        barCount: truncated.length
      })
    );
  } else if (hadTech && replayTech === undefined) {
    findings.push(
      unverifiable("momentum", persistedMomentum, "insufficient_bars_for_technical_replay", {
        barCount: truncated.length
      })
    );
  } else if (had52w && !replay52) {
    findings.push(
      unverifiable("momentum", persistedMomentum, "insufficient_bars_for_52w_replay", { barCount: truncated.length })
    );
  } else {
    const value = round2(recomputed.momentum);
    const delta = round2(Math.abs(persistedMomentum - value));
    findings.push({
      ...base,
      factorOrField: "momentum",
      classification: delta > tolerancePoints ? "mismatch" : "clean",
      persistedValue: persistedMomentum,
      recomputedValue: value,
      delta,
      detail: {
        tolerancePoints,
        barCount: truncated.length,
        lastBarDate,
        ...(hadTech ? { replayTechnicalScore: replayTech, persistedTechnicalScore: evidence.technicalScore } : {}),
        ...(replay52 ? { replayFiftyTwoWeekHigh: round2(replay52.high), replayFiftyTwoWeekLow: round2(replay52.low) } : {})
      }
    });
  }

  // liquidity
  if (persistedLiquidity === undefined) {
    findings.push(unverifiable("liquidity", undefined, "no_persisted_factor_breakdown"));
  } else if (!hadVolume) {
    findings.push(
      unverifiable("liquidity", persistedLiquidity, "no_persisted_volume_provenance", {
        note: "Decision-time liquidity may have scored from market cap, which has no point-in-time history."
      })
    );
  } else if (!hasDecisionDayBar) {
    findings.push(
      unverifiable("liquidity", persistedLiquidity, "no_decision_day_bar", {
        lastBarDate,
        barCount: truncated.length
      })
    );
  } else if (decisionDayVolume === undefined) {
    findings.push(unverifiable("liquidity", persistedLiquidity, "no_decision_day_volume", { lastBarDate }));
  } else {
    const value = round2(recomputed.liquidity);
    const delta = round2(Math.abs(persistedLiquidity - value));
    findings.push({
      ...base,
      factorOrField: "liquidity",
      classification: delta > tolerancePoints ? "mismatch" : "clean",
      persistedValue: persistedLiquidity,
      recomputedValue: value,
      delta,
      detail: {
        tolerancePoints,
        decisionDayVolume,
        basis: "decision_day_bar_volume_vs_live_snapshot_volume"
      }
    });
  }

  // The rest of the factor set: always 'unverifiable', with the coverage gap stored as a receipt.
  for (const factor of LOOKAHEAD_UNVERIFIABLE_FACTORS) {
    const persisted = finiteNumber(breakdown?.[factor]);
    findings.push({
      ...base,
      factorOrField: factor,
      classification: "unverifiable",
      ...(persisted !== undefined ? { persistedValue: persisted } : {}),
      detail: { backtestSafety: LOOKAHEAD_BACKTEST_SAFETY_LABEL, reason: UNVERIFIABLE_FACTOR_REASONS[factor] }
    });
  }

  return findings;
}

// ── RAG evidence replay (pure classification + IO wrapper) ────────────────────

export interface RagPoolRecordForReplay {
  auditId: string;
  queryHash?: string;
  asOf?: string;
  candidates: CandidatePoolEntry[];
}

export function parseRagPoolRecord(row: { id: string; payload: unknown }): RagPoolRecordForReplay | undefined {
  const payload = row.payload as { queryHash?: unknown; asOf?: unknown; candidates?: unknown } | undefined;
  if (!payload || !Array.isArray(payload.candidates)) return undefined;
  const candidates: CandidatePoolEntry[] = [];
  for (const raw of payload.candidates) {
    const entry = raw as { id?: unknown; used?: unknown; docType?: unknown; asOf?: unknown } | undefined;
    if (!entry || typeof entry.id !== "string") continue;
    candidates.push({
      id: entry.id,
      used: entry.used === true,
      ...(typeof entry.docType === "string" ? { docType: entry.docType } : {}),
      ...(typeof entry.asOf === "string" ? { asOf: entry.asOf } : {})
    });
  }
  return {
    auditId: row.id,
    ...(typeof payload.queryHash === "string" ? { queryHash: payload.queryHash } : {}),
    ...(typeof payload.asOf === "string" ? { asOf: payload.asOf } : {}),
    candidates
  };
}

export interface RagReplayResult {
  /** RetrievalStatus receipt from the replay call, when the pipeline reported one. */
  status?: string;
  chunks: Array<{ id: string; doc_type?: string; as_of?: string }>;
}

const MAX_RECEIPT_IDS = 16;

/**
 * PURE. Classify one decision's RAG evidence replay:
 *  - no persisted pool → 'unverifiable' (RAG_PERSIST_CANDIDATE_POOL is off; the knob is the
 *    owner's choice — this audit never forces it on),
 *  - no pool matching the rebuilt deterministic query's hash → 'unverifiable' (builder drift),
 *  - ANY used candidate stamped after the pinned as-of → HARD 'mismatch' (post-as-of evidence in
 *    the decision context — no replay needed to prove it),
 *  - replay unavailable (missing keys / budget) → 'unverifiable',
 *  - ANY replay chunk stamped after the pin → HARD 'mismatch' (the strict PIT filter leaked),
 *  - otherwise Jaccard similarity of used vs replay chunk ids against `jaccardMin` — benign
 *    reranker drift stays 'clean'; drift beyond tolerance is 'mismatch'.
 */
export function classifyRagEvidenceReplay(input: {
  decision: LookaheadDecisionInput;
  pools: RagPoolRecordForReplay[];
  expectedQueryHash: string;
  replay?: RagReplayResult;
  jaccardMin: number;
}): LookaheadFinding {
  const { decision, pools, expectedQueryHash, replay, jaccardMin } = input;
  const base = {
    decisionId: decision.decisionId,
    ...(decision.runId ? { runId: decision.runId } : {}),
    symbol: decision.symbol,
    ...(decision.asOf ? { asOf: decision.asOf } : {}),
    factorOrField: "rag_evidence"
  };
  const unverifiable = (reason: string, extra: Record<string, unknown> = {}): LookaheadFinding => ({
    ...base,
    classification: "unverifiable",
    detail: { reason, ...extra }
  });

  if (pools.length === 0) {
    return unverifiable("candidate_pool_not_persisted", { knob: "RAG_PERSIST_CANDIDATE_POOL" });
  }
  const pool = pools.find((candidate) => candidate.queryHash === expectedQueryHash);
  if (!pool) {
    return unverifiable("query_builder_drift", {
      expectedQueryHash,
      persistedQueryHashes: pools.map((candidate) => candidate.queryHash ?? "<missing>").slice(0, 8)
    });
  }
  const pinnedAsOf = pool.asOf ?? decision.asOf;
  const pinnedMs = asOfEpochMs(pinnedAsOf);
  if (pinnedMs === undefined) return unverifiable("no_persisted_asof_pin");

  const used = pool.candidates.filter((candidate) => candidate.used);
  const usedIds = used.map((candidate) => candidate.id);
  const postAsOfPersisted = used.filter((candidate) => {
    const stamp = asOfEpochMs(candidate.asOf);
    return stamp !== undefined && stamp > pinnedMs;
  });
  if (postAsOfPersisted.length > 0) {
    return {
      ...base,
      classification: "mismatch",
      persistedValue: used.length,
      ...(replay ? { recomputedValue: replay.chunks.length } : {}),
      delta: 1,
      detail: {
        reason: "post_asof_chunk_in_decision_context",
        pinnedAsOf,
        postAsOfChunkIds: postAsOfPersisted.map((candidate) => candidate.id).slice(0, MAX_RECEIPT_IDS)
      }
    };
  }

  if (!replay || replay.status === "lookup_failed" || replay.status === "budget_skipped") {
    return unverifiable("retrieval_replay_unavailable", { ...(replay?.status ? { status: replay.status } : {}) });
  }

  // A clean "no_memory" replay (pipeline ran fine, zero chunks matched) is indistinguishable from
  // corpus turnover since the decision — a re-embed that reassigned chunk ids, or pruned documents
  // — and neither of those is a lookahead leak. Treat it as an honest coverage gap rather than a
  // fabricated Jaccard-0 mismatch (or a vacuous clean when the persisted used set is non-empty).
  if (replay.status === "no_memory") {
    return unverifiable("replay_corpus_empty", {
      persistedUsedCount: used.length,
      note:
        "Replay returned zero chunks from a clean pipeline run (RetrievalStatus 'no_memory') — " +
        "likely re-embed/prune corpus turnover after the decision, not proof of a lookahead leak."
    });
  }

  const replayIds = replay.chunks.map((chunk) => chunk.id);
  const postAsOfReplay = replay.chunks.filter((chunk) => {
    const stamp = asOfEpochMs(chunk.as_of);
    return stamp !== undefined && stamp > pinnedMs;
  });
  if (postAsOfReplay.length > 0) {
    return {
      ...base,
      classification: "mismatch",
      persistedValue: used.length,
      recomputedValue: replay.chunks.length,
      delta: 1,
      detail: {
        reason: "post_asof_chunk_in_strict_replay",
        pinnedAsOf,
        postAsOfChunkIds: postAsOfReplay.map((chunk) => chunk.id).slice(0, MAX_RECEIPT_IDS)
      }
    };
  }

  const jaccard = round4(jaccardSimilarity(usedIds, replayIds));
  const undatedUsedCount = used.filter((candidate) => asOfEpochMs(candidate.asOf) === undefined).length;
  return {
    ...base,
    classification: jaccard >= jaccardMin ? "clean" : "mismatch",
    persistedValue: used.length,
    recomputedValue: replay.chunks.length,
    delta: round4(1 - jaccard),
    detail: {
      ...(jaccard >= jaccardMin ? {} : { reason: "retrieval_drift_beyond_tolerance" }),
      jaccard,
      jaccardMin,
      pinnedAsOf,
      usedChunkIds: usedIds.slice(0, MAX_RECEIPT_IDS),
      replayChunkIds: replayIds.slice(0, MAX_RECEIPT_IDS),
      usedDocTypes: Array.from(new Set(used.map((candidate) => candidate.docType).filter(Boolean))),
      replayDocTypes: Array.from(new Set(replay.chunks.map((chunk) => chunk.doc_type).filter(Boolean))),
      ...(undatedUsedCount > 0 ? { undatedUsedCount } : {})
    }
  };
}

// ── Verdict (pure) ────────────────────────────────────────────────────────────

export interface LookaheadVerdict {
  verdict: "no_lookahead_bias_detected" | "lookahead_mismatch_detected" | "insufficient_sample";
  /** Verifiable observations (clean + mismatch); unverifiable rows never qualify. */
  qualifying: number;
  clean: number;
  mismatches: number;
  unverifiable: number;
  floor: number;
}

/**
 * PURE. The verdict floor gates ONLY the all-clear: any mismatch is evidence regardless of sample
 * size, but "no lookahead bias detected" requires at least `floor` verifiable observations —
 * below it the honest aggregate is 'insufficient_sample', never an under-sampled all-clear.
 */
export function computeLookaheadVerdict(
  counts: { clean: number; mismatch: number; unverifiable: number },
  floor: number
): LookaheadVerdict {
  const qualifying = counts.clean + counts.mismatch;
  const verdict =
    counts.mismatch > 0
      ? ("lookahead_mismatch_detected" as const)
      : qualifying >= floor
        ? ("no_lookahead_bias_detected" as const)
        : ("insufficient_sample" as const);
  return {
    verdict,
    qualifying,
    clean: counts.clean,
    mismatches: counts.mismatch,
    unverifiable: counts.unverifiable,
    floor
  };
}

// ── The audit pass (IO) ───────────────────────────────────────────────────────

export type LookaheadRetrieveFn = (
  query: string,
  symbol: string,
  limit: number,
  userId: string,
  options: { docType?: string[]; asOf?: string; strictAsOf: true; onStatus?: (status: string) => void }
) => Promise<Array<{ id: string; doc_type?: string; as_of?: string }>>;

/** Default retrieval: the production pipeline with the same floors the strategy pass uses. */
const defaultRetrieve: LookaheadRetrieveFn = async (query, symbol, limit, userId, options) => {
  const { retrieveContextDetailed, defaultMinScore, defaultRelevanceFloor, defaultDedupeSimilarity } = await import(
    "./vector-db"
  );
  return retrieveContextDetailed(query, symbol, limit, userId, {
    ...options,
    minScore: defaultMinScore(),
    minRelevanceScore: defaultRelevanceFloor(),
    dedupeSimilarity: defaultDedupeSimilarity()
  });
};

const TRANSCRIPT_DOC_TYPES = new Set(["earnings-transcript", "earnings-summary"]);

/** Replay docType filter: filings always; transcripts only when the persisted pool shows the
 *  decision-time retrieval actually surfaced transcript chunks (entitlements at decision time are
 *  otherwise unreconstructable). */
function replayDocTypesForPool(pool: RagPoolRecordForReplay): string[] {
  const hadTranscripts = pool.candidates.some(
    (candidate) => candidate.docType && TRANSCRIPT_DOC_TYPES.has(candidate.docType)
  );
  return strategyInformationRouting(hadTranscripts).semantic.documentTypes;
}

async function replayRagEvidence(
  decision: LookaheadDecisionInput,
  opts: { userId: string; retrieve?: LookaheadRetrieveFn; jaccardMin: number }
): Promise<LookaheadFinding> {
  const expectedQuery = deterministicFilingsRetrievalQuery(decision.symbol);
  const expectedQueryHash = hashQuery(expectedQuery);
  const pools = decision.runId
    ? listRagCandidatePoolAudit(opts.userId, decision.runId, decision.symbol)
        .map(parseRagPoolRecord)
        .filter((pool): pool is RagPoolRecordForReplay => Boolean(pool))
    : [];
  const pool = pools.find((candidate) => candidate.queryHash === expectedQueryHash);
  let replay: RagReplayResult | undefined;
  const pinnedAsOf = pool ? (pool.asOf ?? decision.asOf) : undefined;
  // Retrieval is invoked only for a verifiable pool (hash-matched, pinned) — an unverifiable
  // decision must not spend Voyage/Pinecone budget.
  if (pool && pinnedAsOf) {
    const usedCount = pool.candidates.filter((candidate) => candidate.used).length;
    const limit = Math.max(1, Math.min(8, usedCount || 1));
    let status: string | undefined;
    try {
      const retrieve = opts.retrieve ?? defaultRetrieve;
      const chunks = await retrieve(expectedQuery, decision.symbol, limit, opts.userId, {
        docType: replayDocTypesForPool(pool),
        asOf: pinnedAsOf,
        strictAsOf: true,
        onStatus: (value) => {
          status = value;
        }
      });
      replay = { ...(status ? { status } : {}), chunks };
    } catch {
      replay = undefined; // classified as retrieval_replay_unavailable
    }
  }
  return classifyRagEvidenceReplay({ decision, pools, expectedQueryHash, replay, jaccardMin: opts.jaccardMin });
}

export interface LookaheadAuditPassResult {
  sampled: number;
  findings: number;
  clean: number;
  mismatches: number;
  unverifiable: number;
  /** Aggregate verdict over the trailing LOOKAHEAD_VERDICT_WINDOW_DAYS window after this pass's writes. */
  verdict: LookaheadVerdict;
  stoppedAtUnmatured: boolean;
  notified: boolean;
}

export interface RunLookaheadAuditOptions {
  now?: number;
  fetchOHLC?: BacktestOHLCFetcher;
  retrieve?: LookaheadRetrieveFn;
  sampleSize?: number;
  tolerancePoints?: number;
  jaccardMin?: number;
  verdictFloor?: number;
  horizonDays?: number;
  /** Default true; false suppresses the advisory lookahead_leak notification (tests). */
  notifyOnMismatch?: boolean;
}

/**
 * One audit pass for one user: sample matured decisions past the durable watermark, replay
 * factors + RAG evidence, persist findings (idempotent upsert), advance the watermark, and fire
 * the advisory lookahead_leak notification when the pass produced mismatches. Never fabricates:
 * every unreplayable input becomes an 'unverifiable' receipt.
 */
export async function runLookaheadAuditPass(
  userId: string = "local",
  options: RunLookaheadAuditOptions = {}
): Promise<LookaheadAuditPassResult> {
  const cfg = loadLookaheadAuditConfig();
  const now = options.now ?? Date.now();
  const tolerancePoints = options.tolerancePoints ?? cfg.tolerancePoints;
  const jaccardMin = options.jaccardMin ?? cfg.jaccardMin;
  const verdictFloor = options.verdictFloor ?? cfg.verdictFloor;
  const fetchOHLC = options.fetchOHLC ?? fetchDailyOHLC;

  const watermarkKey = `${WATERMARK_KEY_PREFIX}:${userId}`;
  const afterRowid = getInternalSetting<number>(watermarkKey);
  const sample = sampleDecisionsForLookaheadAudit(userId, {
    sampleSize: options.sampleSize ?? cfg.sampleSize,
    horizonDays: options.horizonDays ?? cfg.horizonDays,
    now,
    ...(typeof afterRowid === "number" ? { afterRowid } : {})
  });

  const findings: LookaheadFinding[] = [];
  const barsBySymbol = new Map<string, OHLCBar[] | null>();
  for (const decision of sample.decisions) {
    let bars = barsBySymbol.get(decision.symbol);
    if (bars === undefined) {
      bars = await fetchOHLC(decision.symbol, now, userId).catch(() => null);
      barsBySymbol.set(decision.symbol, bars);
    }
    findings.push(...replayFactorFindings(decision, bars, tolerancePoints));
    findings.push(await replayRagEvidence(decision, { userId, retrieve: options.retrieve, jaccardMin }));
  }

  if (findings.length > 0) {
    upsertLookaheadAuditFindings(
      findings.map((finding) => ({ ...finding, userId })),
      new Date(now).toISOString()
    );
  }
  if (sample.nextWatermarkRowid !== undefined) setInternalSetting(watermarkKey, sample.nextWatermarkRowid);

  const passCounts = { clean: 0, mismatch: 0, unverifiable: 0 };
  for (const finding of findings) passCounts[finding.classification] += 1;
  const verdict = computeLookaheadVerdict(
    countLookaheadFindingsByClassification(userId, { sinceIso: lookaheadVerdictWindowSinceIso(now) }),
    verdictFloor
  );
  audit(
    "lookahead_audit_pass",
    {
      sampled: sample.decisions.length,
      findings: findings.length,
      ...passCounts,
      verdict: verdict.verdict,
      qualifying: verdict.qualifying,
      stoppedAtUnmatured: sample.stoppedAtUnmatured
    },
    userId
  );

  let notified = false;
  if (passCounts.mismatch > 0 && (options.notifyOnMismatch ?? true)) {
    try {
      await notifyLookaheadMismatch(
        userId,
        findings.filter((finding) => finding.classification === "mismatch")
      );
      notified = true;
    } catch (err) {
      console.warn(
        `[lookahead-audit] mismatch notification failed for ${userId}:`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  return {
    sampled: sample.decisions.length,
    findings: findings.length,
    clean: passCounts.clean,
    mismatches: passCounts.mismatch,
    unverifiable: passCounts.unverifiable,
    verdict,
    stoppedAtUnmatured: sample.stoppedAtUnmatured,
    notified
  };
}

/** One batched advisory notification per pass with mismatches — NEVER fired on 'unverifiable'.
 *  Delivery honors the user's real enabledEvents toggle (owner ruling 2026-08-12, "ALL toggles
 *  must be real" — no force-include). A legacy stored enabledEvents array predating this event
 *  type was backfilled once by migration 78 (db.ts); after that the toggle is genuinely the
 *  user's. ntfy titles are raw HTTP header values — ASCII only. */
async function notifyLookaheadMismatch(userId: string, mismatches: LookaheadFinding[]): Promise<void> {
  const { sendNotification } = await import("./notifications");
  const { getPolicy } = await import("./db");
  const policy = getPolicy(userId);
  const count = mismatches.length;
  const fields = Array.from(new Set(mismatches.map((finding) => finding.factorOrField))).join(", ");
  const symbols = Array.from(new Set(mismatches.map((finding) => finding.symbol))).slice(0, 5).join(", ");
  const body =
    `The weekly lookahead audit replayed decision inputs from data truncated to each decision date and found ` +
    `${count} mismatch${count === 1 ? "" : "es"} beyond tolerance (${fields}; ${symbols}).  ` +
    `That can mean future data leaked into decision-time inputs, or that a pinned as-of replay no longer reproduces ` +
    `what the decision actually saw.  Advisory only: nothing is halted.  ` +
    `Review the Lookahead audit panel on the Results page.`;
  await sendNotification(
    {
      type: "lookahead_leak",
      title: `Lookahead audit: ${count} mismatch${count === 1 ? "" : "es"}`,
      payload: {
        count,
        fields: fields.split(", "),
        findings: mismatches.slice(0, 10).map((finding) => ({
          decisionId: finding.decisionId,
          symbol: finding.symbol,
          factorOrField: finding.factorOrField,
          ...(finding.delta !== undefined ? { delta: finding.delta } : {})
        }))
      }
    },
    { userId, policy, directBody: body }
  );
}

// ── Due-job scheduling + drain (scheduler wiring) ────────────────────────────

/** Next cadence-aligned slot (epoch-day grid, 04:47 UTC) strictly after `nowMs`. Pure. */
export function nextLookaheadAuditDueAt(nowMs: number, cadenceDays: number): { dueAtISO: string; dedupeDate: string } {
  const cadence = Math.max(1, Math.floor(cadenceDays));
  const slotMs = (SLOT_UTC_HOUR * 60 + SLOT_UTC_MINUTE) * 60_000;
  let day = Math.floor(Math.floor(nowMs / DAY_MS) / cadence) * cadence;
  let dueMs = day * DAY_MS + slotMs;
  while (dueMs <= nowMs) {
    day += cadence;
    dueMs = day * DAY_MS + slotMs;
  }
  const dueAtISO = new Date(dueMs).toISOString();
  return { dueAtISO, dedupeDate: dueAtISO.slice(0, 10) };
}

/** One audit row per distinct disabled-reason (not one per tick) — r2-cold-snapshot's contract. */
function recordDisabledOnce(reason: string): void {
  try {
    if (getInternalSetting<string>(DISABLED_AUDIT_KEY) === reason) return;
    setInternalSetting(DISABLED_AUDIT_KEY, reason);
    audit("lookahead_audit.disabled", { reason });
  } catch {
    // never throw into the scheduler tick
  }
}

/**
 * Idempotently ensure the next cadence slot has one job per user (dedupe key `${userId}-<date>`).
 * Silent no-op (one audit row) under the kill switch. Returns the number of NEW rows inserted.
 */
export function ensureLookaheadAuditJobsScheduled(now: number = Date.now()): number {
  try {
    const cfg = loadLookaheadAuditConfig();
    if (!cfg.enabled) {
      recordDisabledOnce(cfg.disabledReason ?? "kill_switch");
      return 0;
    }
    const { dueAtISO, dedupeDate } = nextLookaheadAuditDueAt(now, cfg.cadenceDays);
    let inserted = 0;
    for (const userId of listUsers()) {
      if (
        enqueueDueJob({
          jobType: LOOKAHEAD_AUDIT_JOB_TYPE,
          dedupeKey: `${userId}-${dedupeDate}`,
          dueAt: dueAtISO,
          userId
        })
      ) {
        inserted += 1;
      }
    }
    return inserted;
  } catch (err) {
    console.error("[lookahead-audit] schedule error:", err);
    return 0;
  }
}

export interface LookaheadAuditDrainResult {
  drained: number;
  lastResult?: LookaheadAuditPassResult;
}

/**
 * Claim and run due lookahead-audit jobs (drained like outcome-horizons' intraday sampler:
 * claim → run → complete/fail with db-jobs backoff). Never throws into the scheduler tick.
 */
export async function drainLookaheadAuditJobs(
  now: number = Date.now(),
  deps: { fetchOHLC?: BacktestOHLCFetcher; retrieve?: LookaheadRetrieveFn } = {}
): Promise<LookaheadAuditDrainResult> {
  const claimant = `lookahead-audit:${process.pid}`;
  const jobs = claimDueJobs(LOOKAHEAD_AUDIT_JOB_TYPE, {
    limit: 2,
    leaseMs: 10 * 60_000,
    claimant,
    now: new Date(now)
  });
  if (jobs.length === 0) return { drained: 0 };

  let lastResult: LookaheadAuditPassResult | undefined;
  for (const job of jobs) {
    try {
      const cfg = loadLookaheadAuditConfig();
      if (!cfg.enabled) {
        completeDueJob(job.id, claimant, { skipped: "kill_switch" });
        continue;
      }
      const result = await runLookaheadAuditPass(job.userId ?? "local", { now, ...deps });
      lastResult = result;
      completeDueJob(job.id, claimant, {
        sampled: result.sampled,
        findings: result.findings,
        mismatches: result.mismatches,
        verdict: result.verdict.verdict
      });
    } catch (err) {
      failDueJob(job.id, claimant, err instanceof Error ? err.message : String(err));
    }
  }

  audit("lookahead_audit.drain", {
    drained: jobs.length,
    lastVerdict: lastResult?.verdict.verdict,
    stats: getDueJobStats(LOOKAHEAD_AUDIT_JOB_TYPE)
  });
  return { drained: jobs.length, ...(lastResult ? { lastResult } : {}) };
}
