/**
 * Tests for the per-run RAG budget ceiling (R16, 2026-07-01 RAG backlog).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ audit: vi.fn() }));
vi.mock("../src/lib/db", () => ({ audit: mocks.audit }));

async function freshModule() {
  vi.resetModules();
  return import("../src/lib/rag/run-budget");
}

describe("run-budget (R16)", () => {
  beforeEach(() => {
    delete process.env.RAG_RUN_BUDGET_ENABLED;
    delete process.env.RAG_RUN_BUDGET_CEILING;
    delete process.env.RAG_RUN_BUDGET_WINDOW_MS;
    mocks.audit.mockClear();
  });
  afterEach(() => {
    delete process.env.RAG_RUN_BUDGET_ENABLED;
    delete process.env.RAG_RUN_BUDGET_CEILING;
    delete process.env.RAG_RUN_BUDGET_WINDOW_MS;
  });

  it("is enabled by default (owner enablement 2026-07-24); set off to disable", async () => {
    const { runBudgetEnabled } = await freshModule();
    expect(runBudgetEnabled()).toBe(true);
    process.env.RAG_RUN_BUDGET_ENABLED = "off";
    const mod = await freshModule();
    expect(mod.runBudgetEnabled()).toBe(false);
  });

  it("recordRagOperation is a no-op and shouldDegradeForBudget always false when disabled", async () => {
    process.env.RAG_RUN_BUDGET_ENABLED = "off";
    const { recordRagOperation, shouldDegradeForBudget, resetRunBudget } = await freshModule();
    resetRunBudget();
    for (let i = 0; i < 10_000; i++) recordRagOperation();
    expect(shouldDegradeForBudget()).toBe(false);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  describe("when enabled", () => {
    beforeEach(() => {
      process.env.RAG_RUN_BUDGET_ENABLED = "on";
    });

    it("does not trip below the ceiling", async () => {
      process.env.RAG_RUN_BUDGET_CEILING = "5";
      const { recordRagOperation, shouldDegradeForBudget, resetRunBudget } = await freshModule();
      resetRunBudget();
      for (let i = 0; i < 4; i++) recordRagOperation();
      expect(shouldDegradeForBudget()).toBe(false);
    });

    it("trips once the ceiling is reached and emits exactly one audit row", async () => {
      process.env.RAG_RUN_BUDGET_CEILING = "3";
      const { recordRagOperation, shouldDegradeForBudget, resetRunBudget } = await freshModule();
      resetRunBudget();
      for (let i = 0; i < 3; i++) recordRagOperation();
      expect(shouldDegradeForBudget()).toBe(true);
      // Calling it again (as a second retrieveContextDetailed call would) must NOT re-audit.
      expect(shouldDegradeForBudget()).toBe(true);
      expect(mocks.audit).toHaveBeenCalledTimes(1);
      expect(mocks.audit).toHaveBeenCalledWith("rag_run_budget_tripped", expect.objectContaining({ ceiling: 3 }), "local");
    });

    it("prunes operations outside the rolling window", async () => {
      process.env.RAG_RUN_BUDGET_CEILING = "2";
      process.env.RAG_RUN_BUDGET_WINDOW_MS = "50";
      const { recordRagOperation, shouldDegradeForBudget, resetRunBudget } = await freshModule();
      resetRunBudget();
      const t0 = Date.now();
      recordRagOperation(t0);
      recordRagOperation(t0);
      expect(shouldDegradeForBudget(t0)).toBe(true);
      // After the window elapses, the old ops should no longer count.
      expect(shouldDegradeForBudget(t0 + 1000)).toBe(false);
    });
  });
});
