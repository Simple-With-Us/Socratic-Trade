import { beforeEach, describe, expect, it } from "vitest";
import { readBenchmarkState, recordBenchmarkState, resetBenchmarkStateForTests } from "../src/lib/benchmark-state";

const base = {
  status: "unavailable" as const,
  reason: "snapshot-timing-unknown",
  detail: "x",
  cashFlowSource: null,
  brokerLedgerComplete: false,
  benchmarkSymbol: "SPY",
  startDate: null,
  endDate: null,
  accountReturnPct: null,
  benchmarkReturnPct: null,
  excessReturnPct: null,
  timedOutSections: [] as string[]
};

describe("benchmark state for ops", () => {
  beforeEach(() => resetBenchmarkStateForTests());

  it("is null until a dashboard load has recorded a result", () => {
    expect(readBenchmarkState("a")).toBeNull();
  });

  it("keeps the latest result per account with its time, and returns copies", () => {
    recordBenchmarkState("a", base, new Date("2026-11-24T04:00:00Z"));
    recordBenchmarkState("a", { ...base, status: "ok", reason: null, cashFlowSource: "broker", brokerLedgerComplete: true, accountReturnPct: 1.5, benchmarkReturnPct: 1, excessReturnPct: 0.5 }, new Date("2026-11-24T04:05:00Z"));
    const got = readBenchmarkState("a");
    expect(got?.status).toBe("ok");
    expect(got?.cashFlowSource).toBe("broker");
    expect(got?.computedAt).toBe("2026-11-24T04:05:00.000Z");
    got!.timedOutSections.push("mutated");
    expect(readBenchmarkState("a")?.timedOutSections).toEqual([]);
    expect(readBenchmarkState("b")).toBeNull();
  });

  it("ignores a missing account id and caps how many accounts it holds", () => {
    recordBenchmarkState(undefined, base);
    for (let i = 0; i < 250; i += 1) recordBenchmarkState(`acct-${i}`, base);
    expect(readBenchmarkState("acct-0")).toBeNull();
    expect(readBenchmarkState("acct-249")).not.toBeNull();
  });
});
