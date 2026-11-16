/**
 * Pure commit decisions for console numeric fields.
 *
 * These live here rather than beside their inputs because Next.js App Router restricts what a
 * `page.tsx` may export -- only `default`, `metadata`, `dynamic`, `revalidate` and friends are
 * allowed, and any other named export fails the generated `.next/types` check with
 * "Property '<name>' is incompatible with index signature ... not assignable to type 'never'".
 * Exporting the helper from `app/console/settings/page.tsx` so a test could import it broke the
 * build for exactly that reason.  Put shared pure helpers in this module instead.
 *
 * The rule these encode: a blank or unparseable field commits NOTHING.  It must never fall through
 * to a fallback value, because these fields are risk and strategy knobs -- clearing one to retype
 * it used to write the fallback to the server as a real setting.
 */

/**
 * Decide what a data-source feature number field should commit on blur.
 *
 * Returns the parsed number to PATCH, or `null` to commit nothing.  `null` covers three distinct
 * cases that all mean "do not write": blank/whitespace, unparseable text, and a value identical to
 * what is already saved (no redundant PATCH).
 */
export function resolveSourceFeatureNumberCommit(raw: string, committed: number): number | null {
  const parsed = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(parsed)) return null;
  if (parsed === committed) return null;
  return parsed;
}

/**
 * Decide what an Admin > Operations server knob number field should commit on blur.
 *
 * Blank or unparseable text returns `null` so the field reverts to its current value
 * without writing the knob's default to the server. Clamps to [min, max] if specified.
 */
export function resolveServerKnobNumberCommit(
  raw: string,
  committed: number,
  min?: number,
  max?: number
): number | null {
  const parsed = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(parsed)) return null;
  let next = parsed;
  if (typeof min === "number") next = Math.max(min, next);
  if (typeof max === "number") next = Math.min(max, next);
  if (next === committed) return null;
  return next;
}

/**
 * Decide what a tax rate percentage field should commit on blur.
 *
 * Rates are percentages clamped between 0 and 100. Blank/unparseable text returns `null`.
 */
export function resolveTaxRateCommit(raw: string, committed: number): number | null {
  const parsed = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(parsed)) return null;
  const next = Math.min(100, Math.max(0, parsed));
  if (next === committed) return null;
  return next;
}

/**
 * Decide what a learning review threshold / wait days field should commit on blur.
 *
 * Must be at least 1. Blank/unparseable text returns `null`.
 */
export function resolveLearningReviewNumberCommit(raw: string, committed: number, min = 1): number | null {
  const parsed = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(parsed)) return null;
  const next = Math.max(min, parsed);
  if (next === committed) return null;
  return next;
}

/**
 * Decide what a scoring weight factor field should commit on blur.
 *
 * Weights are non-negative (>= 0). Blank/unparseable text returns `null`.
 */
export function resolveScoringWeightCommit(raw: string, committed: number): number | null {
  const parsed = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(parsed)) return null;
  const next = Math.max(0, parsed);
  if (next === committed) return null;
  return next;
}

