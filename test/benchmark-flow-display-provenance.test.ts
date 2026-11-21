import { describe, expect, it, vi } from "vitest";
vi.mock("../src/lib/history", () => ({ fetchDailyOHLC: vi.fn(async () => [
  { time: "2026-11-18", close: 500 }, { time: "2026-11-19", close: 501 }, { time: "2026-11-20", close: 502 }
]) }));
import { computeSpyBenchmarkDetailed, normalizeAgainstBenchmark } from "../src/lib/benchmark";
import { resolveExternalCashFlows } from "../src/lib/broker-cash-flows";
import type { AlpacaAccountActivity } from "../src/lib/alpaca-account-insights";
const curve = [
  { timestamp: "2026-11-18T20:00:00Z", equity: 100000, cash: 10000, source: "live" as const },
  { timestamp: "2026-11-19T20:00:00Z", equity: 101000, cash: 11000, source: "live" as const },
  { timestamp: "2026-11-20T20:00:00Z", equity: 102000, cash: 11000, source: "live" as const }
];
const closes = [{ date: "2026-11-18", close: 500 }, { date: "2026-11-19", close: 501 }, { date: "2026-11-20", close: 502 }];
describe("benchmark display provenance is not a numerical return repair", () => {
  for (const broker of [false, true]) it(`adds source metadata only (${broker ? "broker" : "inferred"})`, async () => {
    const activities: AlpacaAccountActivity[] = broker ? [{ id: "synthetic-transfer", activity_type: "CSD", date: "2026-11-19", net_amount: "1000" }] : [];
    const resolved = resolveExternalCashFlows({ equityCurve: curve, fills: [], brokerActivities: activities });
    const expected = normalizeAgainstBenchmark(curve, closes, "SPY", resolved.flows.size ? resolved.flows : undefined)!;
    if (broker && resolved.flows.size > 0) expected.cashFlowAdjusted = true;    const result = await computeSpyBenchmarkDetailed(curve, undefined, Date.parse("2026-11-20T22:00:00Z"), [], activities);
    expect(result.status).toBe("ok");
    expect(result.comparison?.cashFlowSource).toBe(broker ? "broker" : "inferred");
    const { cashFlowSource, ...numbers } = result.comparison!;
    expect(numbers).toEqual(expected);
  });


it("broker provenance alone cannot override a flow rejected by the return calculation", async () => {
  const activities: AlpacaAccountActivity[] = [{ id: "unverified", activity_type: "CSD", date: "2026-11-19", net_amount: "900000" }];
  const result = await computeSpyBenchmarkDetailed(curve, undefined, Date.parse("2026-11-20T22:00:00Z"), [], activities);
  expect(result.comparison?.cashFlowSource).toBe("broker");
  expect(result.comparison?.cashFlowAdjusted).toBe(false);
  const control = await computeSpyBenchmarkDetailed(curve, undefined, Date.parse("2026-11-20T22:00:00Z"), [],
    [{ id: "verified", activity_type: "CSD", date: "2026-11-19", net_amount: "1000" }]);
  expect(control.comparison?.cashFlowSource).toBe("broker");
  expect(control.comparison?.cashFlowAdjusted).toBe(true);
});

it("an overlapping unknown cash capture withholds comparison, broker ledger bypasses it", async () => {
  const timed = curve.map((p, i) => ({ ...p, runId: `r${i}`, runStartedAt: p.timestamp.replace("20:00", "19:00") }));
  const fills = [{ id: "synthetic-fill", accountNumber: "A1", source: "live" as const, symbol: "AAPL", side: "buy" as const,
    quantity: 10, price: 100, notional: 1000, status: "filled", filledAt: "2026-11-19T19:30:00Z" }];
  const result = await computeSpyBenchmarkDetailed(timed, undefined, Date.parse("2026-11-20T22:00:00Z"), fills, []);
  expect(result.comparison).toBeNull();
  expect(result.unavailable?.reason).toBe("snapshot-timing-unknown");
  const broker = await computeSpyBenchmarkDetailed(timed, undefined, Date.parse("2026-11-20T22:00:00Z"), fills,
    [{ id: "actual-capital", activity_type: "CSD", date: "2026-11-19", net_amount: "1000" }]);
  expect(broker.comparison?.cashFlowSource).toBe("broker");
  const safe = timed.map((p) => ({ ...p, runStartedAt: p.timestamp }));
  const control = await computeSpyBenchmarkDetailed(safe, undefined, Date.parse("2026-11-20T22:00:00Z"), fills, []);
  expect(control.status).toBe("ok");
  expect(control.comparison?.cashFlowSource).toBe("inferred");
});


it("preserves a labeled latest safe window rather than bridging uncertain history", async () => {
  const timed = [
    { ...curve[0]!, timestamp: "2026-11-17T20:00:00Z", runId: "old", runStartedAt: "2026-11-17T19:00:00Z" },
    ...curve.map((p, i) => ({ ...p, runId: `r${i}`, runStartedAt: p.timestamp.replace("20:00", "19:00") }))
  ];
  const fills = [{ id: "synthetic-fill", accountNumber: "A1", source: "live" as const, symbol: "AAPL", side: "buy" as const,
    quantity: 10, price: 100, notional: 1000, status: "filled", filledAt: "2026-11-18T19:30:00Z" }];
  const result = await computeSpyBenchmarkDetailed(timed, undefined, Date.parse("2026-11-20T22:00:00Z"), fills, []);
  expect(result.comparison?.startDate).toBe("2026-11-19");
  expect(result.comparison?.endDate).toBe("2026-11-20");
  expect(result.comparison?.timingWindowNote).toContain("not the full account-history return");
});

it("does not claim an applied broker adjustment when all ledger flows are excluded", async () => {
  const activities: AlpacaAccountActivity[] = [{ id: "synthetic-excluded-transfer", activity_type: "CSD", date: "2026-11-19", net_amount: "1000000" }];
  const result = await computeSpyBenchmarkDetailed(curve, undefined, Date.parse("2026-11-20T22:00:00Z"), [], activities);
  expect(result.comparison?.cashFlowSource).toBe("broker");
  expect(result.comparison?.cashFlowAdjusted).toBe(false);
  expect(result.comparison?.unverifiedFlows?.length).toBe(1);
  const resolved = resolveExternalCashFlows({ equityCurve: curve, brokerActivities: activities });
  const { cashFlowSource, ...numbers } = result.comparison!;
  expect(numbers).toEqual(normalizeAgainstBenchmark(curve, closes, "SPY", resolved.flows));
});
});
