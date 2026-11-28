// Time-decayed importance + capped blended retrieval score (FinMem port).
//
// Pure math only. Recency is exponential with a per-doc_type half-life. Importance
// comes from already-credited per-doc retrieval_usefulness_stats (never synthesized).
// The blend is capped so outcome-earned importance can nudge rank but never override
// semantic similarity.
//
// `applyMemoryDecayWeighting` below is the ST-4652 retrieval hook: a bounded, rank-stable
// recency nudge in the same shape as retrieval-usefulness.ts / past-decision-cases.ts
// (positional RRF-style base, fail-open, never excludes). Owner-approved ON by default
// (OD-7, 2026-11-25): unset now ENABLES the nudge; `RAG_MEMORY_DECAY_WEIGHTING=off`
// (or 0 / false / no) restores the pre-ST-4652 order byte-for-byte.

import { envFlagOn } from "./rag/env-flag";

export type MemoryDocType = "lesson" | "coach-note" | "socratic-decision" | "experience" | string;

export interface UsefulnessStatRow {
  samples: number;
  wins: number;
  losses: number;
}

const LN2 = Math.LN2;

export const DEFAULT_HALFLIFE_DAYS: Record<string, number> = {
  lesson: 180,
  "coach-note": 180,
  "socratic-decision": 45,
  experience: 45
};

export function halfLifeDaysFor(docType: MemoryDocType, override?: number): number {
  if (typeof override === "number" && Number.isFinite(override) && override > 0) return override;
  const envKey = `RAG_MEMORY_DECAY_HALFLIFE_${String(docType).toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_DAYS`;
  const fromEnv = Number(process.env[envKey]);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return DEFAULT_HALFLIFE_DAYS[docType] ?? 45;
}

/** exp(-ln2 * ageDays / halfLife). Age <= 0 → 1. Missing half-life → 1. */
export function recencyScore(ageDays: number, halfLifeDays: number): number {
  if (!Number.isFinite(ageDays) || ageDays <= 0) return 1;
  if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) return 1;
  return Math.exp((-LN2 * ageDays) / halfLifeDays);
}

/**
 * 0..100 from credited win/loss rows. Neutral 50 when there is no credited history
 * so new/unproven docs are never penalized.
 */
export function docImportance(statRow?: UsefulnessStatRow | null): number {
  if (!statRow || !Number.isFinite(statRow.samples) || statRow.samples <= 0) return 50;
  const decided = Math.max(0, (statRow.wins ?? 0) + (statRow.losses ?? 0));
  if (decided <= 0) return 50;
  const winRate = (statRow.wins ?? 0) / decided;
  return Math.max(0, Math.min(100, winRate * 100));
}

/**
 * Capped blend: similarity stays the dominant term. Recency and importance each
 * contribute at most `nudge` (default 0.15) so they cannot invert a large
 * similarity gap.
 */
export function blendedScore(
  similarity: number,
  recency: number,
  importance: number,
  nudge = 0.15
): number {
  const sim = Number.isFinite(similarity) ? similarity : 0;
  const rec = Number.isFinite(recency) ? Math.max(0, Math.min(1, recency)) : 1;
  const imp = Number.isFinite(importance) ? Math.max(0, Math.min(100, importance)) / 100 : 0.5;
  const cap = Number.isFinite(nudge) && nudge > 0 ? Math.min(0.45, nudge) : 0.15;
  const remainder = Math.max(0, 1 - 2 * cap);
  return remainder * sim + cap * rec + cap * imp;
}

export function ageDaysSince(iso: string | undefined, nowMs: number): number {
  if (typeof iso !== "string" || !iso) return 0;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, (nowMs - ms) / 86_400_000);
}

export function shouldSoftArchive(input: {
  recency: number;
  blended: number;
  ageDays: number;
  docType: MemoryDocType;
  recencyFloor?: number;
  blendedFloor?: number;
  graceDays?: number;
}): boolean {
  const type = String(input.docType);
  if (type === "lesson" || type === "coach-note") return false;
  const grace = input.graceDays ?? 90;
  if (input.ageDays < grace) return false;
  const recencyFloor = input.recencyFloor ?? 0.15;
  const blendedFloor = input.blendedFloor ?? 0.25;
  return input.recency < recencyFloor && input.blended < blendedFloor;
}

/** Env flag for the advisory recency re-rank. Owner-approved ON by default (OD-7,
 * 2026-11-25): unset enables it; an explicit `off`/`0`/`false`/`no` preserves the caller's
 * order exactly. This is the same env-flag off-switch convention as
 * PAST_DECISION_CASE_AFFINITY / EXPERIENCE_MEMORY. */
export const MEMORY_DECAY_WEIGHTING_ENV = "RAG_MEMORY_DECAY_WEIGHTING";

export function memoryDecayWeightingEnabled(): boolean {
  return envFlagOn(MEMORY_DECAY_WEIGHTING_ENV, true);
}

/** RRF-style positional constant, matching retrieval-usefulness.ts / past-decision-cases.ts
 * so the three advisory re-ranks compose predictably. */
export const MEMORY_DECAY_RRF_K = 60;

/** Half-width of the recency multiplier band. A just-written doc earns at most
 * `1 + MEMORY_DECAY_NUDGE` and an infinitely old doc at least `1 - MEMORY_DECAY_NUDGE`
 * against the positional base -- the same 0.15 cap blendedScore gives recency. */
export const MEMORY_DECAY_NUDGE = 0.15;

/** Minimal structural chunk shape -- deliberately not `RetrievedChunk`, so this pure module
 * stays out of the vector-db import graph. Age comes from the chunk's OWN stamped date
 * (`as_of`, else metadata acceptance/timestamp), never from a lifecycle-table lookup: a
 * missing vector_doc_lifecycle row therefore cannot change ordering, and a chunk with no
 * parseable date at all is neutral (multiplier exactly 1). */
export interface DecayingChunk {
  doc_type?: string;
  as_of?: string;
  metadata?: Record<string, unknown>;
}

function chunkDateIso(chunk: DecayingChunk): string | undefined {
  if (typeof chunk.as_of === "string" && chunk.as_of) return chunk.as_of;
  const md = chunk.metadata;
  if (!md || typeof md !== "object") return undefined;
  for (const key of ["acceptance_datetime", "as_of", "timestamp"]) {
    const value = md[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

/**
 * Bounded recency multiplier for one chunk at `nowMs`, in
 * `[1 - MEMORY_DECAY_NUDGE, 1 + MEMORY_DECAY_NUDGE]`. A doc exactly one half-life old
 * (recency 0.5) and an undated/unparseable/future-dated doc are all exactly 1.0 (neutral).
 */
export function memoryDecayMultiplier(chunk: DecayingChunk, nowMs: number): number {
  const iso = chunkDateIso(chunk);
  if (!iso) return 1;
  const ms = Date.parse(iso);
  // Future stamps are untrusted (typo, clock skew, gamed metadata): neutral, never max boost.
  if (!Number.isFinite(ms) || ms > nowMs) return 1;
  const recency = recencyScore(ageDaysSince(iso, nowMs), halfLifeDaysFor(chunk.doc_type ?? ""));
  return 1 + MEMORY_DECAY_NUDGE * (2 * recency - 1);
}

/**
 * Advisory recency re-rank over ALREADY-RETRIEVED chunks, BEFORE the caller's top-k slice.
 * Guarantees (mirroring the sibling weightings):
 *  - on by default (OD-7); an explicit `RAG_MEMORY_DECAY_WEIGHTING=off` returns the input
 *    array order unchanged;
 *  - never excludes a chunk -- only reorders;
 *  - RANK-STABLE: the base is positional (1/(K + incomingIndex)), never the raw similarity
 *    score, so equal multipliers produce a byte-identical order and the caller's ordering
 *    semantics (similarity sort, usefulness/affinity re-ranks upstream) survive;
 *  - bounded displacement: with K=60 and a +/-15% band, a fresh doc at incoming rank r can
 *    overtake an infinitely old doc at rank 0 only when 1.15/(60+r) > 0.85/60, i.e. r <= 21 --
 *    older high-similarity/usefulness/affinity docs beyond that reach cannot be displaced
 *    by recency alone;
 *  - undated chunks are neutral (multiplier 1.0), so missing lifecycle rows / legacy
 *    vectors without a stamped date are never silently demoted or boosted;
 *  - fail-open: any error returns the incoming order unchanged.
 */
export function applyMemoryDecayWeighting<T extends DecayingChunk>(
  chunks: T[],
  nowMs: number = Date.now()
): T[] {
  if (chunks.length < 2 || !memoryDecayWeightingEnabled()) return chunks;
  try {
    const scored = chunks.map((chunk, index) => {
      const multiplier = memoryDecayMultiplier(chunk, nowMs);
      return { chunk, index, multiplier, weighted: multiplier / (MEMORY_DECAY_RRF_K + index) };
    });
    const reordered = [...scored].sort((a, b) => b.weighted - a.weighted || a.index - b.index);
    const changed = reordered.some((entry, position) => entry.index !== position);
    if (changed) {
      // Count-only: this runs on the retrieval hot path when the flag is on, so no
      // per-chunk string building (unlike the always-on sibling weightings' logs).
      console.log(`[memory-decay] advisory recency reweighting reordered ${chunks.length} retrieved chunk(s)`);
    }
    return reordered.map((entry) => entry.chunk);
  } catch (err) {
    console.warn(
      "[memory-decay] weighting unavailable, using incoming order:",
      err instanceof Error ? err.message : String(err)
    );
    return chunks;
  }
}
