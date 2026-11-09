import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const strategy = readFileSync("src/lib/strategy.ts", "utf8");
const orchestrator = readFileSync("src/lib/chat/orchestrator.ts", "utf8");
const harness = readFileSync("scripts/eval/rag-eval-harness.ts", "utf8");
const productionEval = readFileSync("scripts/eval/rag-production-eval.ts", "utf8");

describe("production RAG path contract (audit R1)", () => {
  it("strategy and chat retrieve through retrieveContextDetailed, not search-fusion", () => {
    expect(strategy).toMatch(/retrieveContextDetailed/);
    expect(strategy).not.toMatch(/retrieveFusedContext/);
    expect(orchestrator).toMatch(/retrieveContextDetailed/);
    expect(orchestrator).not.toMatch(/retrieveFusedContext/);
  });

  it("chat searchKnowledge always passes asOf so VECTOR_ASOF_STRICT can fire", () => {
    expect(orchestrator).toMatch(/asOf:\s*resolveRetrievalAsOf/);
  });

  it("the merge-gate CLI and golden harness call retrieveContextDetailed, not retrieveFusedContext", () => {
    expect(productionEval).toMatch(/retrieveContextDetailedWithStatus/);
    expect(productionEval).not.toMatch(/retrieveFusedContext/);
    expect(harness).toMatch(/retrieveContextDetailed/);
    expect(harness).not.toMatch(/retrieveFusedContext/);
    expect(harness).toMatch(/strictAsOf:\s*true/);
  });
});
