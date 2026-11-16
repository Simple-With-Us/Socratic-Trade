// Time-decayed importance + capped blended retrieval score (FinMem port).
//
// Pure math only. Recency is exponential with a per-doc_type half-life. Importance
// comes from already-credited per-doc retrieval_usefulness_stats (never synthesized).
// The blend is capped so outcome-earned importance can nudge rank but never override
// semantic similarity.

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
