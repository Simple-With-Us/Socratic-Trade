// Shared label helper for the LLM Usage & Cost dashboard (app/admin/llm-usage/llm-usage-client.tsx)
// and any other UI surface that needs a human label for a raw `context` string written to the
// llm_usage ledger (see recordLlmUsage in src/lib/llm-usage.ts).
//
// PRESENTATION-ONLY: the raw `context` strings themselves are load-bearing — src/lib/model-stats.ts
// (roleForUsageContext) keys directly off "strategy" / "red-team" / "strategy-bear" /
// "strategy-tuning" to attribute spend to a green/red/tuning role. NEVER change what a call site
// WRITES to make a label prettier here — only this map's OUTPUT (the label string) changes.
//
// Every context string any code path in this repo actually writes to llm_usage.context has an
// entry below (see the exhaustive list asserted in llm-usage-labels.test.ts). Anything unmapped
// (a future context nobody added here yet, or a legacy/typo'd row) falls through to `humanize`,
// which title-cases the raw string instead of ever rendering it as lowercase-kebab to the owner.

export const LLM_USAGE_CONTEXT_LABELS: Record<string, string> = {
  chat: "Chat",
  strategy: "Green Team (proposer)",
  "red-team": "Red Team (reviewer)",
  "strategy-bear": "Red Team (reviewer, legacy)",
  "strategy-tuning": "AI strategy review",
  "proposal-revalidation": "Proposal revalidation",
  "post-mortem": "Post-mortem reflection",
  "outcome-postmortem": "Outcome post-mortem",
  "framework-review": "Framework proposal review",
  "learning-review": "Learning review",
  "rag-hyde": "RAG query drafting (HyDE)",
  "chat-salience": "Chat memory extraction",
  "eval-judge": "Eval judge (dev)",
  "eval-faithfulness": "Eval faithfulness judge (dev)",
  unknown: "Uncategorized",
  "benchmark:green": "Benchmark (proposer)",
  "benchmark:red": "Benchmark (reviewer)"
};

/** Title-case a raw context string by splitting on -, _, and : — e.g. "some-new_thing" -> "Some New Thing". */
function humanize(raw: string): string {
  const words = raw.split(/[-_:]+/).filter(Boolean);
  if (words.length === 0) return raw;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/**
 * Human label for a raw `llm_usage.context` string. Falls through, in order:
 *   1. the exact map above
 *   2. the generic `benchmark:<role>` prefix (any role, not just green/red — the benchmark script
 *      accepts an arbitrary `--role`, so a future role still gets a sane "Benchmark (X)" label)
 *   3. `humanize` — title-cases the raw string so nothing ever renders as lowercase-kebab.
 * Never returns the raw string itself as a fallback.
 */
export function llmUsageContextLabel(ctx: string): string {
  if (!ctx) return LLM_USAGE_CONTEXT_LABELS.unknown;
  const exact = LLM_USAGE_CONTEXT_LABELS[ctx];
  if (exact) return exact;
  if (ctx.startsWith("benchmark:")) {
    const role = ctx.slice("benchmark:".length);
    return `Benchmark (${humanize(role) || "unknown role"})`;
  }
  return humanize(ctx);
}
