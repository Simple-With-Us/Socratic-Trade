// Canonical model identity — the single source of truth for collapsing a route-qualified
// model ID onto the bare catalog name.
//
// Under universal OpenRouter routing, an LLM call records a route-qualified model
// (`anthropic/claude-sonnet-5`, `openai/gpt-4o`), while the same model called directly — and
// the offline benchmark JSON and the model-picker catalog — uses the bare name
// (`claude-sonnet-5`, `gpt-4o`). Everything that keys on the model (cost, latency, realized-P&L
// / win-rate benchmark, reviewer efficacy, the Usage cost page) must canonicalize to the bare
// name so live, historical, and benchmark stats align across the routing cutover.
//
// This consolidates two previously-duplicated definitions: `cleanModelId` (src/lib/model-stats.ts,
// AG / PR #1703) and `canonicalModelId` (app/admin/llm-usage/model-merge.ts, PR #1716). The logic
// below is AG's verified `cleanModelId` behavior verbatim (last path segment, case-preserving),
// so importing it here is a no-op behavior change for the benchmark stats.
//
// Assumption (verified against app/ui/llm-model-catalog.ts): catalog model names are
// vendor-unique — no two distinct models share a bare name — so taking the last `/` segment only
// ever unifies the same model across routes, never merges two different models. If the catalog
// ever gains a cross-vendor bare-name collision, harden this to strip only the known OpenRouter
// vendor prefixes (anthropic/openai/xai/google/mistralai/deepseek + the openrouter/ meta-prefix)
// rather than any slash.

/** Bare catalog identity for a (possibly route-qualified) model id. Empty string for null/blank.
 *  Case-preserving: model ids are conventionally lowercase, and the benchmark/catalog lookup keys
 *  match case, so this must not lowercase. */
export function canonicalModelId(model: string | null | undefined): string {
  if (!model) return "";
  const name = model.trim();
  if (name.includes("/")) {
    return name.split("/").pop() || name;
  }
  return name;
}
