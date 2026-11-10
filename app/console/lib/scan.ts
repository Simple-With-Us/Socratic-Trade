/** Honest decomposition of a market scan's candidate count (item 26).
 *
 *  `topCandidates` is built from three additive groups (src/lib/market.ts): the ranked top-N cut
 *  (up to `candidateLimit`), a below-cutoff "notable outlier" reserve, and every held position —
 *  held positions are NEVER hidden regardless of rank. So `topCandidates.length` can legitimately
 *  exceed `candidateLimit` once held/outlier names are added on top — a bare "75/50 candidates"
 *  header reads like the cap was silently violated when it wasn't. This module turns the raw
 *  counts into a breakdown ("50 ranked + 14 held + 11 outliers") instead. */

export interface ScanCandidateBreakdown {
  /** Names shown purely because they ranked inside the configured cap. */
  ranked: number;
  /** Held positions forced in beyond the ranked cut and the outlier reserve. */
  held: number;
  /** Below-cutoff notable outliers kept for visibility. */
  outliers: number;
  /** Total distinct candidates actually rendered (topCandidates.length). */
  total: number;
  limit: number;
  /** False for scans persisted before `heldCandidateCount` existed — the breakdown falls back to
   *  a coarser (but still honest) two-part rendering rather than guessing a held count. */
  hasHeldBreakdown: boolean;
}

export function scanCandidateBreakdown(input: {
  totalCandidates: number;
  limit: number;
  outlierCandidateCount?: number;
  heldCandidateCount?: number;
}): ScanCandidateBreakdown {
  const outliers = Math.max(0, input.outlierCandidateCount ?? 0);
  const hasHeldBreakdown = typeof input.heldCandidateCount === "number";
  const held = Math.max(0, input.heldCandidateCount ?? 0);
  const ranked = Math.max(0, input.totalCandidates - outliers - held);
  return { ranked, held, outliers, total: input.totalCandidates, limit: input.limit, hasHeldBreakdown };
}

/** Compact header text, e.g. "50 ranked + 14 held + 11 outliers" or, for legacy scans without a
 *  held count, the coarser "75/50 candidates · 11 outliers". Zero-valued parts are omitted. */
export function formatScanCandidateBreakdown(breakdown: ScanCandidateBreakdown): string {
  if (!breakdown.hasHeldBreakdown) {
    const outlierPart = breakdown.outliers > 0 ? ` · ${breakdown.outliers} outlier${breakdown.outliers === 1 ? "" : "s"}` : "";
    return `${breakdown.total}/${breakdown.limit} candidates${outlierPart}`;
  }
  const parts = [`${breakdown.ranked} ranked`];
  if (breakdown.held > 0) parts.push(`${breakdown.held} held`);
  if (breakdown.outliers > 0) parts.push(`${breakdown.outliers} outlier${breakdown.outliers === 1 ? "" : "s"}`);
  return parts.join(" + ");
}
