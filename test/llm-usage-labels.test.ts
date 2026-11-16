/**
 * llmUsageContextLabel (app/ui/llm-usage-labels.ts) — the shared label helper the LLM Usage & Cost
 * dashboard (app/admin/llm-usage/llm-usage-client.tsx) uses to render a raw `llm_usage.context`
 * string as a human label.
 *
 * The owner's complaint this fixes: several real contexts ("outcome-postmortem",
 * "framework-review", "learning-review", "rag-hyde", "benchmark:green/red", "unknown") rendered as
 * raw lowercase-kebab strings because the dashboard's old inline map only covered 7 of the ~16
 * contexts actually written to the ledger. This test asserts EVERY context string any code path in
 * this repo writes to llm_usage.context maps to a non-raw, properly capitalized label, plus the
 * generic fallback humanizer for anything unmapped.
 */
import { describe, expect, it } from "vitest";
import { llmUsageContextLabel, LLM_USAGE_CONTEXT_LABELS } from "../app/ui/llm-usage-labels";

// Every context string a `recordLlmUsage({ context: ... })` call site in this repo actually writes,
// as of this test (see grep `context:\s*"` across src/lib + scripts, and the LlmUsageOpts default in
// src/lib/chat/llm.ts). "strategy-bear" is legacy (no longer written by any live code path) but
// still appears in historical ledger rows, so it must keep a real label too.
const WRITTEN_CONTEXTS = [
  "chat",
  "strategy",
  "red-team",
  "strategy-bear",
  "strategy-tuning",
  "proposal-revalidation",
  "post-mortem",
  "outcome-postmortem",
  "framework-review",
  "learning-review",
  "rag-hyde",
  "chat-salience",
  "eval-judge",
  "eval-faithfulness",
  "unknown",
  "benchmark:green",
  "benchmark:red"
];

/** A raw lowercase-kebab/snake/colon string that never got a friendly label. */
function looksRaw(label: string, ctx: string): boolean {
  return label === ctx || /^[a-z0-9]+([-_:][a-z0-9]+)*$/.test(label);
}

describe("llmUsageContextLabel", () => {
  it.each(WRITTEN_CONTEXTS)("maps written context %s to a non-raw label", (ctx) => {
    const label = llmUsageContextLabel(ctx);
    expect(label).toBeTruthy();
    expect(looksRaw(label, ctx)).toBe(false);
    // Sentence case: starts with an uppercase letter (or a digit/paren for edge cases — none here).
    expect(label[0]).toBe(label[0].toUpperCase());
  });

  it("every WRITTEN_CONTEXTS entry has an exact map entry (no silent fallback-only coverage)", () => {
    for (const ctx of WRITTEN_CONTEXTS) {
      if (ctx.startsWith("benchmark:")) continue; // handled by the generic prefix branch, see below
      expect(LLM_USAGE_CONTEXT_LABELS[ctx], `missing exact label for "${ctx}"`).toBeTruthy();
    }
  });

  it("known exact labels match the spec", () => {
    expect(llmUsageContextLabel("chat")).toBe("Chat");
    expect(llmUsageContextLabel("strategy")).toBe("Green Team (proposer)");
    expect(llmUsageContextLabel("red-team")).toBe("Red Team (reviewer)");
    expect(llmUsageContextLabel("strategy-bear")).toBe("Red Team (reviewer, legacy)");
    expect(llmUsageContextLabel("strategy-tuning")).toBe("AI strategy review");
    expect(llmUsageContextLabel("proposal-revalidation")).toBe("Proposal revalidation");
    expect(llmUsageContextLabel("post-mortem")).toBe("Post-mortem reflection");
    expect(llmUsageContextLabel("outcome-postmortem")).toBe("Outcome post-mortem");
    expect(llmUsageContextLabel("framework-review")).toBe("Framework proposal review");
    expect(llmUsageContextLabel("learning-review")).toBe("Learning review");
    expect(llmUsageContextLabel("rag-hyde")).toBe("RAG query drafting (HyDE)");
    expect(llmUsageContextLabel("chat-salience")).toBe("Chat memory extraction");
    expect(llmUsageContextLabel("eval-judge")).toBe("Eval judge (dev)");
    expect(llmUsageContextLabel("eval-faithfulness")).toBe("Eval faithfulness judge (dev)");
    expect(llmUsageContextLabel("unknown")).toBe("Uncategorized");
    expect(llmUsageContextLabel("benchmark:green")).toBe("Benchmark (proposer)");
    expect(llmUsageContextLabel("benchmark:red")).toBe("Benchmark (reviewer)");
  });

  it("falsy input falls back to the unknown label rather than throwing or rendering blank", () => {
    expect(llmUsageContextLabel("")).toBe("Uncategorized");
  });

  it("generic benchmark:<role> prefix produces a sane label for an unmapped role", () => {
    const label = llmUsageContextLabel("benchmark:support");
    expect(label).toBe("Benchmark (Support)");
    expect(looksRaw(label, "benchmark:support")).toBe(false);
  });

  it("unmapped, non-benchmark context falls back to the humanizer (never raw kebab-case)", () => {
    const label = llmUsageContextLabel("some-brand-new-context");
    expect(label).toBe("Some Brand New Context");
    expect(looksRaw(label, "some-brand-new-context")).toBe(false);
  });

  it("humanizer also splits underscores and colons", () => {
    expect(llmUsageContextLabel("foo_bar")).toBe("Foo Bar");
    expect(llmUsageContextLabel("foo:bar")).toBe("Foo Bar");
  });
});
