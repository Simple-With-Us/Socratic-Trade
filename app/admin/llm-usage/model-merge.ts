// Merge LLM usage across the OpenRouter / direct-provider split, for the Usage page.
//
// WHY: the llm_usage ledger stores each call as (provider, model). Before OpenRouter routing a
// Claude call was recorded as provider="anthropic", model="claude-sonnet-5". Once universal
// OpenRouter routing lands (PR #1703) the SAME underlying model is recorded as
// provider="openrouter", model="anthropic/claude-sonnet-5". Grouping by (provider, model) would
// therefore show the same model twice and split its history at the routing cutover.
//
// This module merges those rows by a CANONICAL model id (the bare model name, vendor prefix
// stripped) so one line per model shows the combined total, while retaining a per-provider
// breakdown so the pre-OpenRouter (direct) and OpenRouter portions stay visible. It is
// READ/DISPLAY-ONLY: the raw ledger rows are never rewritten, so historical stats are preserved
// exactly.

/** The subset of an llm_usage aggregate row this merge needs. */
export interface UsageLike {
  provider: string;
  model: string | null;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
}

export interface ProviderSlice {
  /** Raw provider string as stored ("openrouter", "anthropic", …). */
  provider: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
}

export interface ModelUsageAggregate {
  /** Merge key: the bare model id (e.g. "claude-sonnet-5"); "" for a null/blank model. */
  canonicalId: string;
  /** Human display of the model (bare id, original casing). */
  displayName: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  /** One entry per distinct provider that served this model, sorted by cost desc. */
  providers: ProviderSlice[];
}

// Canonical model identity is shared with src/lib/model-stats.ts (the benchmark/perf rollup) —
// one definition, so the cost page here and the Model Stats drawer collapse route-qualified IDs
// the same way. Re-exported for this module's existing consumers. `displayModelName` is the same
// bare-name derivation, named for readability at display sites.
import { canonicalModelId } from "@/lib/model-identity";
export { canonicalModelId };
export const displayModelName = canonicalModelId;

/** Merge usage rows by canonical model. Each aggregate sums calls/tokens/cost across every
 *  provider that served the model, and keeps a per-provider breakdown (sorted by cost desc).
 *  Aggregates are returned sorted by cost desc, then calls desc. Pure — no ledger mutation. */
export function aggregateUsageByModel(rows: UsageLike[]): ModelUsageAggregate[] {
  const byModel = new Map<string, ModelUsageAggregate>();
  // Per-model, per-provider accumulator so multiple ledger rows for the same (model, provider)
  // — e.g. different contexts/accounts — collapse into one provider slice.
  const providerAcc = new Map<string, Map<string, ProviderSlice>>();

  for (const row of rows) {
    const id = canonicalModelId(row.model);
    const mergeKey = id.toLowerCase();
    let agg = byModel.get(mergeKey);
    if (!agg) {
      agg = {
        canonicalId: id,
        displayName: displayModelName(row.model),
        calls: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        providers: []
      };
      byModel.set(mergeKey, agg);
      providerAcc.set(mergeKey, new Map());
    }
    agg.calls += row.calls;
    agg.promptTokens += row.promptTokens;
    agg.completionTokens += row.completionTokens;
    agg.totalTokens += row.totalTokens;
    agg.costUsd += row.costUsd;

    const slices = providerAcc.get(mergeKey)!;
    let slice = slices.get(row.provider);
    if (!slice) {
      slice = { provider: row.provider, calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0 };
      slices.set(row.provider, slice);
    }
    slice.calls += row.calls;
    slice.promptTokens += row.promptTokens;
    slice.completionTokens += row.completionTokens;
    slice.totalTokens += row.totalTokens;
    slice.costUsd += row.costUsd;
  }

  const out = Array.from(byModel.values());
  for (const agg of out) {
    agg.providers = Array.from(providerAcc.get(agg.canonicalId.toLowerCase())!.values()).sort(
      (a, b) => b.costUsd - a.costUsd || b.calls - a.calls
    );
  }
  out.sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls);
  return out;
}
