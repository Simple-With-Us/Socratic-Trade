/**
 * Shared fail-closed boolean env-flag parser (R6, 2026-07-01 RAG backlog).
 *
 * Before this module, RAG flags parsed booleans two different ways:
 *   - `rerankEnabled()` / `hybridRetrievalEnabled()` (vector-db.ts) accepted the permissive
 *     set `['1','true','on','yes']`.
 *   - `disclosureRagEnabled()` (disclosure-rag.ts) required the EXACT string `'on'` — so an
 *     operator setting `RAG_EMBED_DISCLOSURES=true` (a value every other flag in this app
 *     accepts) silently no-op'd. That inconsistency was a real operator footgun, not a stylistic
 *     nit — see docs/reviews/2026-07-01-rag-knowledge-expansion.md C3/R6.
 *
 * `envFlagOn` is the one parser every RAG boolean flag should route through going forward.
 * Pure/dependency-free (no DB, no Node-specific APIs beyond `process.env`) so it's safe to
 * import from anywhere, including modules that must stay DB-free (e.g. salience.ts's siblings).
 *
 * Fail-closed: any value NOT in the accepted truthy set (including unset, empty, or garbage
 * input) resolves to `false` — a typo in an env var must never silently enable paid embedding
 * calls or a behavior change.
 */

const TRUTHY = new Set(["1", "true", "on", "yes"]);

export type EnvSource = Readonly<Record<string, string | undefined>>;

/**
 * Resolve a boolean env flag. Accepts (case/whitespace-insensitive) "1", "true", "on", "yes" as
 * truthy; everything else (including unset) resolves to `default_`.
 *
 * NOTE on the one intentional behavior change this enables: routing `RAG_EMBED_DISCLOSURES`
 * through this parser (see disclosure-rag.ts) means `RAG_EMBED_DISCLOSURES=true` or `=1` or
 * `=yes` now correctly enables disclosure embedding, where previously only the exact string
 * `on` worked. This is a SAFE-DIRECTION change (an operator who set any of those values was
 * already trying to turn the flag ON) but it does mean an operator relying on the old exact-'on'
 * quirk to silently no-op with a "look-alike" value will now see disclosures actually embed
 * (real Voyage/Pinecone cost). Called out explicitly in the rollout note.
 */
export function envFlagOn(name: string, default_: boolean, env: EnvSource = process.env): boolean {
  const raw = env[name];
  if (raw == null) return default_;
  const v = raw.trim().toLowerCase();
  if (v === "") return default_;
  return TRUTHY.has(v);
}
