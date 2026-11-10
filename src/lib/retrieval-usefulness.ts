// retrieval-usefulness.ts — the retrieval-usefulness join + advisory ranking nudge (handoff 4.1).
//
// Write side (already existed): every strategy run persists WHICH analog/coaching vector ids
// entered its prompts — the `experience_retrieval` audit event (strategy.ts) and ragAttributions
// on every socratic_decisions row (db-socratic.ts). Outcome side (already existed): the outcome
// engine (outcome-engine.ts) matures each decision case into a multi-horizon outcome
// (SocraticOutcomeHorizonRow[15m/1h/1d/1w] + a headline returnPct/status).
//
// This module performs the join those writers were built for:
//   1. `runRetrievalUsefulnessJoinIfDue` (scheduler, once per UTC day per user, bounded batch):
//      for each decision case with ragAttributions AND a matured (terminal) outcome, credit each
//      attributed doc_type / memory kind / vector id with the outcome's hit/return at every
//      resolved horizon. The credited ledger (db-retrieval-usefulness.ts) is the watermark:
//      each decision is credited exactly once, so passes are idempotent and never full recomputes.
//   2. `applyRetrievalUsefulnessWeighting`: a BOUNDED, RANK-STABLE advisory re-rank — the base is
//      positional (RRF-style 1/(K+rank) over the incoming order, so the caller's ordering semantics
//      survive; equal multipliers = identical order), kinds with enough credited samples and better
//      outcomes rank somewhat higher; unseen kinds get a neutral prior; nothing is ever excluded, and
//      any failure falls open to the incoming order. Off-switch: RETRIEVAL_USEFULNESS_WEIGHTING=off.
//      Callers: experience-memory.ts retrieval (analogs + coaching), and since 2026-09-27 the FILINGS
//      dossier path in strategy.ts. It previously had exactly one caller, which meant the statistics
//      this join exists to produce were credited and then never read on the path that retrieves the
//      majority of the evidence the proposer sees. The multiplier is keyed on AGGREGATE
//      `doc_type|memoryKind` statistics, never on a per-document attribution, so no document can be
//      re-ranked on the influence of documents it itself influenced — there is no feedback loop.
//
// Basis note (r4): the ':alpha' rows below are credited straight from each horizon's spyExcessPct
// as written by outcome-engine.ts, unchanged in shape here — but that figure's BASIS changed from
// the SPY ETF to the S&P 500 index (^GSPC, SPY fallback), or a symbol's own GICS sector
// index/ETF under policy.benchmarkMode === 'sector'. See outcome-horizons.ts's header.
import { audit, getPolicy } from "./db";
import {
  creditRetrievalUsefulness,
  getRetrievalUsefulnessStats,
  listDecisionsForUsefulnessJoin,
  type RetrievalMemoryKind,
  type RetrievalUsefulnessCredit
} from "./db-retrieval-usefulness";
import { getInternalSetting, setInternalSetting } from "./db-settings";
import type { OutcomeGradingMode } from "./types";

/** Env off-switch for the advisory ranking nudge (the join itself always runs — it is pure
 * bookkeeping). Default ON: the weight is bounded and fail-open. Set to "off" to disable. */
export const RETRIEVAL_USEFULNESS_WEIGHTING_ENV = "RETRIEVAL_USEFULNESS_WEIGHTING";

export function retrievalUsefulnessWeightingEnabled(): boolean {
  return (process.env[RETRIEVAL_USEFULNESS_WEIGHTING_ENV] ?? "on").trim().toLowerCase() !== "off";
}

/** Deterministic doc_type -> memory-kind mapping, mirroring experience-memory.ts's own split
 * (coachingChunks = doc_type === 'coach-note'; analogs = the other episodic decision docs). */
export function memoryKindForDocType(docType?: string): RetrievalMemoryKind {
  if (docType === "coach-note") return "coaching";
  if (docType === "socratic-decision" || docType === "lesson") return "analog";
  return "context";
}

const LAST_RUN_KEY_PREFIX = "retrieval_usefulness:lastRunDate";
const DEFAULT_BATCH_LIMIT = 50;
/** Horizon suffix for the SPY-excess companion stat rows (e.g. '1d:alpha'). The join writes them
 * whenever a credited horizon carries spyExcessPct; the weighting reads them ONLY under
 * outcomeGradingMode 'alpha' (raw mode ignores them, keeping default selection byte-identical). */
export const ALPHA_HORIZON_SUFFIX = ":alpha";
/** Minimum signed samples before a kind's stats move its rank at all (below = neutral prior). */
export const USEFULNESS_MIN_SAMPLES = 5;
/** Multiplier BOUNDS — a backstop, not the operating range.
 *
 *  Widened from ±10% to ±25% on 2026-09-27 (P1-3). The old pair was BINDING, which is the actual
 *  bug: `usefulnessMultiplier` computes `1 + (hitRate - 0.5) * 0.4`, so its reachable range is
 *  0.8–1.2 (±20%) and the 0.9/1.1 clamp was silently clipping a third off both ends. A document type
 *  with a perfect realized hit rate could not out-rank one with a merely good one by more than 10%,
 *  and on the filings path — which then slices to a small top-k — that was not enough to move
 *  anything. Restoring the full ±20% is a 2x widening of what actually reached the ranking.
 *
 *  The constants are kept as a BACKSTOP rather than deleted, because they are what makes "a nudge,
 *  never a takeover" a property of the code: they bound the multiplier regardless of what the
 *  coefficient above is later changed to. Widening the clamp is NOT what doubled the nudge — the
 *  coefficient was always ±20%; the clamp is now 0.75/1.25 so it only engages if someone raises it.
 *  Off-switch (RETRIEVAL_USEFULNESS_WEIGHTING=off) and the fail-open path are unchanged. */
export const USEFULNESS_MULTIPLIER_MIN = 0.75;
export const USEFULNESS_MULTIPLIER_MAX = 1.25;

function utcDate(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export interface RetrievalUsefulnessJoinResult {
  scanned: number;
  /** Decisions newly marked credited this pass (idempotency ledger rows written). */
  credited: number;
  /** Individual (attribution unit x horizon) stat increments written. */
  creditsWritten: number;
}

/**
 * The incremental join pass: bounded batch, credited-ledger watermark, exactly-once per decision.
 * Cheap and offline-safe — reads/writes SQLite only, no provider calls, no LLM.
 */
export function runRetrievalUsefulnessJoin(
  userId: string = "local",
  opts: { limit?: number; now?: number } = {}
): RetrievalUsefulnessJoinResult {
  const now = opts.now ?? Date.now();
  const nowIso = new Date(now).toISOString();
  const decisions = listDecisionsForUsefulnessJoin(userId, { limit: opts.limit ?? DEFAULT_BATCH_LIMIT });
  let credited = 0;
  let creditsWritten = 0;
  for (const decision of decisions) {
    const credits: RetrievalUsefulnessCredit[] = [];
    // One credit per attributed document per horizon: dedupe attribution rows by chunk id (or by
    // doc_type when the id is absent) so a doc quoted twice in one case isn't double-counted.
    const seen = new Set<string>();
    const units = decision.ragAttributions.filter((attr) => {
      const key = attr.chunkId ?? `doc_type:${attr.docType ?? "unknown"}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const horizonRows = (decision.outcome.outcomes ?? []).filter(
      (row) => row.resolution === "ok" && typeof row.returnPct === "number" && Number.isFinite(row.returnPct)
    );
    for (const unit of units) {
      const docType = unit.docType ?? "unknown";
      const memoryKind = memoryKindForDocType(unit.docType);
      for (const row of horizonRows) {
        credits.push({ docType, memoryKind, docId: unit.chunkId, horizon: row.horizon, returnPct: row.returnPct as number });
        // Alpha companion row: win/loss re-judged on the SPY-excess figure so alpha-mode weighting
        // has its own ledger. Only written when spyExcessPct was actually measured — never fabricated.
        if (typeof row.spyExcessPct === "number" && Number.isFinite(row.spyExcessPct)) {
          credits.push({
            docType,
            memoryKind,
            docId: unit.chunkId,
            horizon: `${row.horizon}${ALPHA_HORIZON_SUFFIX}`,
            returnPct: row.spyExcessPct
          });
        }
      }
      if (typeof decision.outcome.returnPct === "number" && Number.isFinite(decision.outcome.returnPct)) {
        credits.push({ docType, memoryKind, docId: unit.chunkId, horizon: "headline", returnPct: decision.outcome.returnPct });
      }
    }
    // Credit even when `credits` is empty (e.g. terminal 'unresolvable' with no resolved horizon):
    // the ledger row is what stops the case from being rescanned forever.
    if (creditRetrievalUsefulness(userId, decision.id, credits, nowIso)) {
      credited += 1;
      creditsWritten += credits.length;
    }
  }
  if (credited > 0) {
    audit(
      "retrieval_usefulness_join",
      { scanned: decisions.length, credited, creditsWritten, batchLimit: opts.limit ?? DEFAULT_BATCH_LIMIT },
      userId
    );
  }
  return { scanned: decisions.length, credited, creditsWritten };
}

/**
 * Scheduler entry point: once per UTC day per user (same self-guarded style as
 * runDailyLearningReviewIfDue in learning-review.ts), bounded batch per pass. Never throws.
 */
export function runRetrievalUsefulnessJoinIfDue(userId: string, now: number = Date.now()): RetrievalUsefulnessJoinResult | undefined {
  try {
    const key = `${LAST_RUN_KEY_PREFIX}:${userId}`;
    if (getInternalSetting<string>(key) === utcDate(now)) return undefined;
    const result = runRetrievalUsefulnessJoin(userId, { now });
    setInternalSetting(key, utcDate(now));
    return result;
  } catch (err) {
    console.warn(`[retrieval-usefulness] join pass failed for ${userId}:`, err instanceof Error ? err.message : String(err));
    return undefined;
  }
}

/** The bounded advisory multiplier for one kind's aggregated stats. Neutral (1.0) when the kind is
 * unseen or under-sampled; otherwise scaled by hit-rate distance from coin-flip, clamped to
 * [USEFULNESS_MULTIPLIER_MIN, USEFULNESS_MULTIPLIER_MAX]. Exported for tests. */
export function usefulnessMultiplier(stat: { samples: number; wins: number; losses: number } | undefined): number {
  if (!stat) return 1;
  const signed = stat.wins + stat.losses;
  if (stat.samples < USEFULNESS_MIN_SAMPLES || signed === 0) return 1;
  const hitRate = stat.wins / signed;
  const raw = 1 + (hitRate - 0.5) * 0.4;
  return Math.min(USEFULNESS_MULTIPLIER_MAX, Math.max(USEFULNESS_MULTIPLIER_MIN, raw));
}

/** Structural chunk shape the weighting needs — matches RetrievedChunk (vector-db.ts) without
 * importing that module into the retrieval hot path. Only doc_type matters: the re-rank is
 * POSITIONAL (RRF-style base from the incoming rank), deliberately not score-based, so it
 * respects whatever ordering semantics the caller established (similarity sort, RRF fusion, ...)
 * instead of silently re-sorting by a score that may not be the caller's ranking key. */
export interface WeightableChunk {
  doc_type?: string;
}

/** RRF-style positional constant: base(i) = 1 / (K + i) over the INCOMING order. The standard
 * K=60 keeps adjacent-rank base ratios small (~1.6% at the top), so the bounded ±10% multiplier
 * perturbs ranks proportionally rather than letting any single kind vault the whole list. */
export const USEFULNESS_RRF_K = 60;

type KindStats = Map<string, { samples: number; wins: number; losses: number }>;

/** Short-TTL per-user cache of the grading mode + kind-level stats so the retrieval hot path costs
 * ~zero (one policy read + one stats read per user per TTL window). */
const kindStatsCache = new Map<string, { at: number; mode: OutcomeGradingMode; stats: KindStats }>();
const KIND_STATS_TTL_MS = 60_000;

export function clearRetrievalUsefulnessWeightCache(): void {
  kindStatsCache.clear();
}

/** The owner's grading-mode knob, failing OPEN to "raw" — a settings-store failure on this hot
 * path must degrade to the original raw-stat selection, never abort retrieval (same contract as
 * getUserSourceSettingsMap, source-settings.ts). */
function outcomeGradingModeFor(userId: string): OutcomeGradingMode {
  try {
    return getPolicy(userId).outcomeGradingMode ?? "raw";
  } catch {
    return "raw";
  }
}

function kindStatsFor(userId: string, now: number): KindStats {
  const mode = outcomeGradingModeFor(userId);
  // The mode is part of the cache key's validity: a cached entry built under the other grading
  // mode must not be served for up to a TTL after the owner flips the knob (the mode read itself
  // is cheap — the stats DB read is what the cache exists to avoid).
  const cached = kindStatsCache.get(userId);
  if (cached && cached.mode === mode && now - cached.at < KIND_STATS_TTL_MS) return cached.stats;
  // Kind-level ('' doc_id) rows, split by grading mode: raw uses only the plain-horizon rows
  // (byte-identical selection to before the alpha ledger existed); alpha uses only the ':alpha'
  // rows. Prefer the headline horizon (raw only — no 'headline:alpha' row exists), fall back to
  // the best-sampled row so early data (e.g. only 1d resolved so far) still informs the nudge.
  const best = new Map<string, { horizon: string; samples: number; wins: number; losses: number }>();
  for (const row of getRetrievalUsefulnessStats(userId)) {
    if (row.horizon.endsWith(ALPHA_HORIZON_SUFFIX) !== (mode === "alpha")) continue;
    const key = `${row.docType}|${row.memoryKind}`;
    const existing = best.get(key);
    const replaces =
      !existing ||
      (existing.horizon !== "headline" && (row.horizon === "headline" || row.samples > existing.samples));
    if (replaces) best.set(key, { horizon: row.horizon, samples: row.samples, wins: row.wins, losses: row.losses });
  }
  const stats: KindStats = new Map(
    [...best.entries()].map(([key, row]) => [key, { samples: row.samples, wins: row.wins, losses: row.losses }])
  );
  kindStatsCache.set(userId, { at: now, mode, stats });
  return stats;
}

/**
 * Advisory usefulness re-rank over retrieval candidates, BEFORE the caller's top-k slice.
 * Guarantees (product philosophy: advisory, never a cage):
 *  - never excludes a chunk or kind — only reorders;
 *  - RANK-STABLE: the base score is positional (1/(K + incomingIndex), RRF-style), NOT the raw
 *    similarity score, so the caller's ordering semantics (plain similarity sort, HYBRID_RETRIEVAL
 *    RRF-fused order, ...) are preserved exactly whenever every multiplier is equal — with
 *    all-neutral stats the output is byte-identical to the input; differentiated multipliers only
 *    perturb ranks proportionally;
 *  - bounded: the multiplier moves each chunk's positional base by at most ±10%;
 *  - neutral prior for unseen/under-sampled kinds (multiplier 1.0);
 *  - grading-mode aware: outcomeGradingMode 'alpha' selects the ':alpha' (SPY-excess) stat rows;
 *    'raw' (default) uses only the plain rows — the mode read itself fails open to raw;
 *  - fail-open: stats missing, DB unavailable, or toggle off => input order returned unchanged;
 *  - observable: logs when the reweighting actually changed the order.
 */
export function applyRetrievalUsefulnessWeighting<T extends WeightableChunk>(
  chunks: T[],
  userId: string,
  now: number = Date.now()
): T[] {
  if (chunks.length < 2 || !retrievalUsefulnessWeightingEnabled()) return chunks;
  try {
    const stats = kindStatsFor(userId, now);
    if (stats.size === 0) return chunks;
    const scored = chunks.map((chunk, index) => {
      const docType = chunk.doc_type ?? "unknown";
      const multiplier = usefulnessMultiplier(stats.get(`${docType}|${memoryKindForDocType(chunk.doc_type)}`));
      return { chunk, index, multiplier, weighted: multiplier / (USEFULNESS_RRF_K + index) };
    });
    const reordered = [...scored].sort((a, b) => b.weighted - a.weighted || a.index - b.index);
    const changed = reordered.some((entry, position) => entry.index !== position);
    if (changed) {
      console.log(
        `[retrieval-usefulness] advisory reweighting reordered retrieval candidates for ${userId}: ` +
          reordered.map((entry) => `#${entry.index}(${entry.chunk.doc_type ?? "?"} x${entry.multiplier.toFixed(2)})`).join(" ")
      );
    }
    return reordered.map((entry) => entry.chunk);
  } catch (err) {
    console.warn("[retrieval-usefulness] weighting unavailable, using similarity order:", err instanceof Error ? err.message : String(err));
    return chunks;
  }
}
