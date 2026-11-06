// What a `-latest` alias row actually resolved to.
//
// The concrete model a provider served is recorded per call in llm_usage.served_model (written
// by recordLlmUsage from the API response's own `model` field). The model stats modal reads the
// most recent non-empty value per catalog display slug so "claude-opus-latest" can say which
// concrete model it currently points at. When no call has recorded one yet, the catalog's
// nativeSlug is shown as the EXPECTED target instead.

import { getDb } from "./db";
import { catalogEntryFor, displaySlugFor } from "./llm-model-catalog";

/** Most recent non-empty served_model per catalog display slug for ONE user (llm_usage.model
 *  canonicalised through displaySlugFor; unknown ids keep their raw value).  Always user-scoped:
 *  the only caller (the model stats route) is per user, and a blank userId returns an empty map
 *  rather than silently reading every user's rows.  Never throws: a failure yields an empty map
 *  so the stats route keeps working. */
export function getLatestServedModels(opts: { userId: string }): Map<string, string> {
  const result = new Map<string, string>();
  const userId = typeof opts?.userId === "string" ? opts.userId.trim() : "";
  if (!userId) return result;
  try {
    const params: unknown[] = [userId];
    const userClause = "AND user_id = ?";
    const rows = getDb()
      .prepare(
        `SELECT model, served_model, MAX(created_at) AS last_at
         FROM llm_usage
         WHERE model IS NOT NULL AND model != ''
           AND served_model IS NOT NULL AND TRIM(served_model) != ''
           ${userClause}
         GROUP BY model, served_model`
      )
      .all(...params) as Array<{ model: string; served_model: string; last_at: string | null }>;
    const newest = new Map<string, string>();
    for (const r of rows) {
      const slug = displaySlugFor(r.model) || r.model;
      const at = r.last_at ?? "";
      const prior = newest.get(slug);
      if (prior === undefined || at >= prior) {
        newest.set(slug, at);
        result.set(slug, r.served_model.trim());
      }
    }
  } catch {
    return new Map();
  }
  return result;
}

/** Attach `servedModel` (when the recorded concrete model differs from the row's display slug)
 *  or, for a `-latest` alias with nothing recorded, `expectedModel` (the catalog nativeSlug). */
export function attachServedModels<T extends { model: string }>(
  rows: readonly T[],
  served: ReadonlyMap<string, string>
): Array<T & { servedModel?: string; expectedModel?: string }> {
  return rows.map((row) => {
    const recorded = served.get(row.model);
    if (recorded) return recorded !== row.model ? { ...row, servedModel: recorded } : { ...row };
    if (row.model.endsWith("-latest")) {
      // expectedLatestSlug wins: the native route can deliberately lag the alias (Sonnet row).
      const entry = catalogEntryFor(row.model);
      const expected = entry?.expectedLatestSlug || entry?.nativeSlug;
      if (expected && expected !== row.model) return { ...row, expectedModel: expected };
    }
    return { ...row };
  });
}
