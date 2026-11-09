import { describe, expect, it } from "vitest";
import { describeLastRun, LAST_RUN_CAUSE_CHARS } from "../app/console/lib/last-run";
import {
  isStrategyRunDecisionCompletion,
  isStrategyRunSkipStatus,
  strategyRunStatusLabel
} from "../src/lib/strategy-run-status";

describe("console home last-run line", () => {
  it("surfaces the persisted failure cause instead of dropping it", () => {
    const d = describeLastRun({ status: "failed", summary: "Kill switch is active." });
    expect(d.failed).toBe(true);
    expect(d.skipped).toBe(false);
    expect(d.statusLabel).toBe("Failed");
    expect(d.cause).toBe("Kill switch is active.");
    expect(d.title).toBe("Kill switch is active.");
  });

  it("truncates a long cause inline but keeps the whole thing for the tooltip", () => {
    const summary =
      "Process restarted mid-run - marked failed by stale-run sweep after the scheduler lease expired.";
    expect(summary.length).toBeGreaterThan(LAST_RUN_CAUSE_CHARS);

    const d = describeLastRun({ status: "failed", summary });
    expect(d.cause).toBe(`${summary.slice(0, LAST_RUN_CAUSE_CHARS).trimEnd()}...`);
    expect(d.cause!.length).toBeLessThanOrEqual(LAST_RUN_CAUSE_CHARS + 3);
    expect(d.title).toBe(summary);
  });

  it("renders nothing extra for a failed run that recorded no summary", () => {
    // Guards the dangling "Last run failed -" with nothing after it.
    expect(describeLastRun({ status: "failed", summary: undefined }).cause).toBeUndefined();
    expect(describeLastRun({ status: "failed", summary: "   " })).toEqual({
      failed: true,
      skipped: false,
      statusLabel: "Failed",
      title: undefined,
      cause: undefined
    });
  });

  it("leaves completed runs muted and uncluttered", () => {
    const completed = describeLastRun({ status: "completed", summary: "Placed 2 orders." });
    expect(completed.failed).toBe(false);
    expect(completed.skipped).toBe(false);
    expect(completed.statusLabel).toBe("Completed");
    expect(completed.cause).toBeUndefined();
    expect(completed.title).toBe("Placed 2 orders.");
  });

  it("labels market-closed skips honestly without duplicating the bar chip cause", () => {
    const skipped = describeLastRun({
      status: "skipped_market_closed",
      summary: "Market is closed (holiday or weekend). Skipping strategy run."
    });
    expect(skipped.skipped).toBe(true);
    expect(skipped.failed).toBe(false);
    expect(skipped.statusLabel).toBe("Skipped — market closed");
    // Market-closed already has a strategy-bar chip; cause stays tooltip-only.
    expect(skipped.cause).toBeUndefined();
    expect(skipped.title).toMatch(/Market is closed/);
  });

  it("labels LLM-budget skips with warn-class copy and an inline cause", () => {
    const skipped = describeLastRun({
      status: "skipped_budget",
      summary: "Strategy run skipped — over usage budget. Daily token limit."
    });
    expect(skipped.skipped).toBe(true);
    expect(skipped.statusLabel).toBe("Skipped — LLM budget");
    expect(skipped.cause).toMatch(/budget/i);
  });

  it("labels broker-unhealthy skips honestly", () => {
    const skipped = describeLastRun({
      status: "skipped_broker_unhealthy",
      summary: "Broker health check failed: timeout. Skipping strategy run to avoid consuming budget."
    });
    expect(skipped.skipped).toBe(true);
    expect(skipped.statusLabel).toBe("Skipped — broker unhealthy");
    expect(skipped.cause).toMatch(/Broker health/i);
  });

  it("classifies legacy status=skipped rows from summary text", () => {
    expect(
      describeLastRun({ status: "skipped", summary: "Market is closed (holiday or weekend)." }).statusLabel
    ).toBe("Skipped — market closed");
    expect(
      describeLastRun({ status: "skipped", summary: "Strategy run skipped — over usage budget." }).statusLabel
    ).toBe("Skipped — LLM budget");
    expect(
      describeLastRun({
        status: "skipped",
        summary: "Broker health check failed: 503. Skipping strategy run to avoid consuming budget."
      }).statusLabel
    ).toBe("Skipped — broker unhealthy");
  });
});

describe("strategy run skip status → UI label (UX PR-A1)", () => {
  it("maps each skip class to the acceptance chip label", () => {
    expect(strategyRunStatusLabel("skipped_budget")).toBe("Skipped — LLM budget");
    expect(strategyRunStatusLabel("skipped_market_closed")).toBe("Skipped — market closed");
    expect(strategyRunStatusLabel("skipped_broker_unhealthy")).toBe("Skipped — broker unhealthy");
    expect(strategyRunStatusLabel("skipped")).toBe("Skipped");
    expect(strategyRunStatusLabel("completed")).toBe("Completed");
    expect(strategyRunStatusLabel("failed")).toBe("Failed");
  });

  it("treats every skip status as non-success for liveness/auto-tune gates", () => {
    for (const s of [
      "skipped",
      "skipped_budget",
      "skipped_market_closed",
      "skipped_broker_unhealthy"
    ] as const) {
      expect(isStrategyRunSkipStatus(s)).toBe(true);
      expect(isStrategyRunDecisionCompletion(s)).toBe(false);
    }
    expect(isStrategyRunDecisionCompletion("completed")).toBe(true);
    expect(isStrategyRunSkipStatus("completed")).toBe(false);
    expect(isStrategyRunSkipStatus("failed")).toBe(false);
  });
});
