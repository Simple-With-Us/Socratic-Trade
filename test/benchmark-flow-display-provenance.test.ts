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
    const result = await computeSpyBenchmarkDetailed(curve, undefined, Date.parse("2026-11-20T22:00:00Z"), [], activities);
    expect(result.status).toBe("ok");
    expect(result.comparison?.cashFlowSource).toBe(broker ? "broker" : "inferred");
    const { cashFlowSource, ...numbers } = result.comparison!;
    expect(numbers).toEqual(expected);
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
