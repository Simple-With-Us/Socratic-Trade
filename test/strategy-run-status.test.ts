import { describe, expect, it } from "vitest";
import { shouldAutoTuneAfterStrategyRun } from "../src/lib/scheduler";
import {
  classifyStrategyRunSkip,
  finishStatusForSkipClass,
  isStrategyRunDecisionCompletion,
  isStrategyRunSkipStatus,
  strategyRunStatusLabel
} from "../src/lib/strategy-run-status";
import { feedStatusLabel } from "../src/lib/dashboard-ui";

describe("strategy-run-status taxonomy (UX PR-A1)", () => {
  it("finishStatusForSkipClass covers the three honest skip classes", () => {
    expect(finishStatusForSkipClass("budget")).toBe("skipped_budget");
    expect(finishStatusForSkipClass("market_closed")).toBe("skipped_market_closed");
    expect(finishStatusForSkipClass("broker_unhealthy")).toBe("skipped_broker_unhealthy");
    expect(finishStatusForSkipClass("other")).toBe("skipped");
  });

  it("labels each skip class for Thesis last-run + Activity chips", () => {
    const cases: Array<{ status: string; summary?: string; label: string }> = [
      { status: "skipped_budget", label: "Skipped — LLM budget" },
      { status: "skipped_market_closed", label: "Skipped — market closed" },
      { status: "skipped_broker_unhealthy", label: "Skipped — broker unhealthy" },
      {
        status: "skipped",
        summary: "Strategy run skipped — Daily LLM/RAG budget reached.",
        label: "Skipped — LLM budget"
      },
      {
        status: "skipped",
        summary: "Market is closed (holiday or weekend). Skipping strategy run.",
        label: "Skipped — market closed"
      },
      {
        status: "skipped",
        summary: "Broker health check failed: connection refused. Skipping strategy run to avoid consuming budget.",
        label: "Skipped — broker unhealthy"
      }
    ];
    for (const c of cases) {
      expect(strategyRunStatusLabel(c.status, c.summary)).toBe(c.label);
      // feedStatusLabel is used on Activity unified feed when only the status string is present
      if (c.status !== "skipped") {
        expect(feedStatusLabel(c.status)).toBe(c.label);
      }
    }
  });

  it("classifies legacy skipped summaries without a migration", () => {
    expect(classifyStrategyRunSkip("skipped", "over usage budget")).toBe("budget");
    expect(classifyStrategyRunSkip("skipped", "Market closed overnight")).toBe("market_closed");
    expect(classifyStrategyRunSkip("skipped", "Broker health check failed")).toBe("broker_unhealthy");
    expect(classifyStrategyRunSkip("skipped", "Account total equity below minimum")).toBe("other");
    expect(classifyStrategyRunSkip("skipped_budget", "anything")).toBe("budget");
  });

  it("never treats pure skips as decision completions (liveness / auto-tune)", () => {
    expect(isStrategyRunDecisionCompletion("skipped_budget")).toBe(false);
    expect(isStrategyRunDecisionCompletion("skipped_market_closed")).toBe(false);
    expect(isStrategyRunDecisionCompletion("skipped_broker_unhealthy")).toBe(false);
    expect(isStrategyRunDecisionCompletion("skipped")).toBe(false);
    expect(isStrategyRunDecisionCompletion("completed")).toBe(true);

    expect(shouldAutoTuneAfterStrategyRun({ status: "skipped_budget" })).toBe(false);
    expect(shouldAutoTuneAfterStrategyRun({ status: "skipped_market_closed" })).toBe(false);
    expect(shouldAutoTuneAfterStrategyRun({ status: "skipped_broker_unhealthy" })).toBe(false);
    expect(shouldAutoTuneAfterStrategyRun({ status: "skipped" })).toBe(false);
    expect(shouldAutoTuneAfterStrategyRun({ status: "completed" })).toBe(true);
    expect(shouldAutoTuneAfterStrategyRun({ status: "failed" })).toBe(false);
  });

  it("isStrategyRunSkipStatus covers every skip variant", () => {
    expect(isStrategyRunSkipStatus("skipped")).toBe(true);
    expect(isStrategyRunSkipStatus("skipped_budget")).toBe(true);
    expect(isStrategyRunSkipStatus("skipped_market_closed")).toBe(true);
    expect(isStrategyRunSkipStatus("skipped_broker_unhealthy")).toBe(true);
    expect(isStrategyRunSkipStatus("completed")).toBe(false);
    expect(isStrategyRunSkipStatus("running")).toBe(false);
  });
});
