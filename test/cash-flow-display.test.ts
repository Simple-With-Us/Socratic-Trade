import { describe, expect, it } from "vitest";
import { dayPnlDisplayAvailable, externalFlowDisplayAvailable } from "../app/console/lib/cash-flow-display";
import type { DayPnl } from "../app/console/lib/derive";

describe("cash-flow timing presentation containment", () => {
  const day: DayPnl = { pnl: 123.45, pct: 0.12, baselineAt: "2026-11-19T20:00:00Z", baselineEquity: 100000, isStaleBaseline: false };
  it("keeps broker-backed Day P&L visible, including a zero amount", () => {
    expect(dayPnlDisplayAvailable({ ...day, cashFlowSource: "broker" }, { todayBrokerFlow: 0 })).toBe(true);
    expect(dayPnlDisplayAvailable({ ...day, pnl: 0, cashFlowSource: "broker" }, { todayBrokerFlow: 0 })).toBe(true);
  });
  it("withholds inferred and legacy no-hint Day P&L without changing the calculation", () => {
    for (const value of [{ ...day, cashFlowSource: "inferred" as const }, day]) {
      const before = JSON.stringify(value);
      expect(dayPnlDisplayAvailable(value)).toBe(false);
      expect(JSON.stringify(value)).toBe(before);
    }
    expect(dayPnlDisplayAvailable(null)).toBe(false);
    expect(dayPnlDisplayAvailable({ ...day, cashFlowSource: "broker" })).toBe(false);
    expect(dayPnlDisplayAvailable({ ...day, cashFlowSource: "broker" }, { todayBrokerFlow: Number.NaN })).toBe(false);
  });
  it("preserves broker flow display but not inferred or missing flow", () => {
    expect(externalFlowDisplayAvailable({ cashFlowSource: "broker" })).toBe(true);
    expect(externalFlowDisplayAvailable({ cashFlowSource: "inferred" })).toBe(false);
    expect(externalFlowDisplayAvailable({})).toBe(false);
    expect(externalFlowDisplayAvailable(undefined)).toBe(false);
  });
  it("does not mutate numeric payloads, even for zero inferred flow", () => {
    const payload = { cashFlowSource: "inferred" as const, netExternalFlows: 0, accountReturnPct: -3.35 };
    const before = JSON.stringify(payload);
    expect(externalFlowDisplayAvailable(payload)).toBe(false);
    expect(JSON.stringify(payload)).toBe(before);
  });
});
