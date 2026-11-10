import { describe, expect, it } from "vitest";
import { buildScanDataCoverage } from "../src/lib/enrichment-coverage";
import { policyStubForConnectedAccount } from "../src/lib/quotes-cascade";
import { DEFAULT_POLICY } from "../src/lib/defaults";

describe("buildScanDataCoverage", () => {
  it("reports total blanks loudly and names shortfall fields", () => {
    const report = buildScanDataCoverage([
      { symbol: "AAPL", volume: 1e6, sector: "Technology" },
      { symbol: "MSFT", volume: 2e6 }
    ]);
    expect(report.symbolCount).toBe(2);
    expect(report.missingFields).toContain("peRatio");
    expect(report.missingFields).toContain("epsGrowth");
    expect(report.fieldFillRates.volume).toBe(1);
    expect(report.fieldFillRates.sector).toBe(0.5);
    expect(report.shortfallSummary).toMatch(/shortfall|blank|Data shortfall/i);
    expect(report.durableStoreSeededCount).toBe(0);
  });

  it("counts durable store seeds from fieldObservations", () => {
    const report = buildScanDataCoverage([
      {
        symbol: "JNJ",
        peRatio: 15,
        fieldObservations: {
          peRatio: { fetchedAt: "2026-08-05T12:00:00.000Z", source: "yahoo-finance" }
        },
        sources: { peRatio: "yahoo-finance" }
      }
    ]);
    expect(report.durableStoreSeededCount).toBe(1);
    expect(report.fieldFillRates.peRatio).toBe(1);
    expect(report.contributingSources).toContain("yahoo-finance");
  });
});

describe("policyStubForConnectedAccount", () => {
  it("points gateway resolution at that account's broker without reusing active-only state", () => {
    const stub = policyStubForConnectedAccount({
      id: "acct-2",
      userId: "local",
      broker: "alpaca",
      environment: "paper",
      accountNumber: "PA123",
      label: "Alpaca paper",
      isActive: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    } as never);
    expect(stub.activeBroker).toBe("alpaca");
    expect(stub.connectedAccountId).toBe("acct-2");
    expect(stub.accountNumber).toBe("PA123");
    expect(stub).not.toBe(DEFAULT_POLICY);
  });
});
