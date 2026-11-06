// model-rotation-selection.ts — the owner's per-seat rotation set (ST-4589).
//
// Owner request: "make it so users can select to rotate between whichever models they choose …
// both for green and red teams."  `TradingPolicy.llmRotationModels` (Green) and
// `redTeamRotationModels` (Red) hold catalog DISPLAY slugs.  Undefined or empty keeps the
// pre-ST-4589 behaviour (rotate over the whole eligible pool).  Everything here is driven from the
// catalog exports so catalog rows can be added or removed without touching this file.
import { CATALOG_DISPLAY_SLUGS, displaySlugFor } from "./llm-model-catalog";

/** Longest single model id accepted (same bound as `llmModel` / `redTeamLlmModel`). */
export const ROTATION_SELECTION_MAX_ID_LENGTH = 64;
/** Most entries one seat's rotation set may hold (after dedupe). */
export const ROTATION_SELECTION_MAX_ENTRIES = 40;

export type RotationSelectionField = "llmRotationModels" | "redTeamRotationModels";

/** Catalog display slug for a catalog model, or the trimmed id unchanged for a custom id. */
export function canonicalRotationModelId(model: string): string {
  const trimmed = model.trim();
  return displaySlugFor(trimmed) || trimmed;
}

/**
 * Validate and normalise one seat's rotation set for PUT /api/policy: an array of strings, each
 * trimmed, non-empty and at most 64 characters, canonicalised to the catalog display slug, deduped
 * (first occurrence wins), at most 40 entries.  Ids outside the catalog pass (custom ids are allowed
 * elsewhere too) — rotation simply cannot serve them (see `catalogRotationSelection`).
 */
export function normalizeRotationModelSelection(
  field: RotationSelectionField,
  raw: unknown
): { ok: true; value: string[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.some((m) => typeof m !== "string")) {
    return { ok: false, error: `${field} must be an array of model-id strings.` };
  }
  const seen = new Set<string>();
  const value: string[] = [];
  for (const entry of raw as string[]) {
    const trimmed = entry.trim();
    if (trimmed.length === 0 || trimmed.length > ROTATION_SELECTION_MAX_ID_LENGTH) {
      return { ok: false, error: `${field} entries must be non-empty model ids of at most ${ROTATION_SELECTION_MAX_ID_LENGTH} characters.` };
    }
    const canonical = canonicalRotationModelId(trimmed);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    value.push(canonical);
  }
  if (value.length > ROTATION_SELECTION_MAX_ENTRIES) {
    return { ok: false, error: `${field} may list at most ${ROTATION_SELECTION_MAX_ENTRIES} models.` };
  }
  return { ok: true, value };
}

/**
 * The catalog models a stored rotation set names, in catalog order.  Tolerates stored data that
 * bypassed the route (non-array, non-strings, non-canonical spellings).  `ignored` lists entries
 * rotation cannot serve because they are not catalog models.
 */
export function catalogRotationSelection(raw: unknown): { models: string[]; ignored: string[] } {
  if (!Array.isArray(raw)) return { models: [], ignored: [] };
  const wanted = new Set<string>();
  const ignored: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || !entry.trim()) continue;
    const slug = displaySlugFor(entry);
    // A retired row still resolves to a display slug but is no longer offered: report it as
    // ignored rather than dropping it silently.
    if (slug && CATALOG_DISPLAY_SLUGS.includes(slug)) wanted.add(slug);
    else ignored.push(entry.trim());
  }
  return { models: CATALOG_DISPLAY_SLUGS.filter((slug) => wanted.has(slug)), ignored };
}
