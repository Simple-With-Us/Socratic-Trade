import { describe, expect, it } from "vitest";
import { aggregateSourceValue, buildSourceAblations, summarizeSourceCoverage } from "../src/lib/source-value";
import type { MarketQuote } from "../src/lib/types";

function quote(overrides: Partial<MarketQuote> = {}): MarketQuote {
  return {
    symbol: "AAPL",
    price: 200,
    volume: 2_000_000,
    marketCap: 3_000_000_000_000,
    intradayChangePct: 4,
    positionMarketValue: 0,
    score: 0,
    peRatio: 12,
    fcfYield: 8,
    sentiment: 78,
    senateTrades: 3,
    insiderSentiment: 75,
    sources: {
      price: "live-market",
      volume: "live-market",
      intradayChangePct: "live-market",
      peRatio: "fundamentals-a",
      fcfYield: "fundamentals-a",
      sentiment: "news-a",
      senateTrades: "smart-money-a",
      insiderSentiment: "smart-money-a",
      companyName: "fundamentals-a"
    },
    ...overrides
  };
}

describe("source shadow ablation", () => {
  it("records one deterministic leave-winning-fields-out receipt per provider", () => {
    const rows = buildSourceAblations(quote());
    expect(rows.map((row) => row.provider)).toEqual([
      "fundamentals-a",
      "live-market",
      "news-a",
      "smart-money-a"
    ]);
    const fundamentals = rows.find((row) => row.provider === "fundamentals-a");
    expect(fundamentals).toMatchObject({
      scoringFields: ["fcfYield", "peRatio"],
      promptOnlyFields: ["companyName"],
      method: "leave_winning_fields_out/v1"
    });
    expect(fundamentals?.scoreDelta).not.toBe(0);
  });

  it("treats freeCashFlowYield as prompt-only (score uses fcfYield alias only)", () => {
    const rows = buildSourceAblations(
      quote({
        sources: {
          price: "live-market",
          volume: "live-market",
          intradayChangePct: "live-market",
          freeCashFlowYield: "fundamentals-a",
          fcfYield: "fundamentals-a"
        }
      })
    );
    const fundamentals = rows.find((row) => row.provider === "fundamentals-a");
    expect(fundamentals?.scoringFields).toEqual(["fcfYield"]);
    expect(fundamentals?.promptOnlyFields).toEqual(["freeCashFlowYield"]);
    expect(fundamentals?.scoreDelta).not.toBe(0);
  });

  it("summarizes successful fields and provider failures without hiding partial coverage", () => {
    const rows = summarizeSourceCoverage([
      quote({
        providerFailures: {
          paid: { source: "paid-provider", fetchedAt: "2026-07-13T12:00:00.000Z", status: "failed", errorKind: "timeout" }
        }
      }),
      { ...quote({ symbol: "MSFT" }), sources: { price: "live-market", volume: "live-market" } }
    ]);
    expect(rows.find((row) => row.provider === "live-market")).toMatchObject({
      symbolsCovered: 2,
      symbolCoveragePct: 100
    });
    expect(rows.find((row) => row.provider === "paid-provider")).toMatchObject({
      symbolsCovered: 0,
      failedSymbols: 1,
      failureKinds: ["timeout"]
    });
  });
});

describe("source outcome aggregation", () => {
  it("keeps chosen and skipped outcomes and labels small samples as insufficient", () => {
    const rows = aggregateSourceValue([
      { provider: "p", fields: ["sentiment"], scoreDelta: 4, returnPct: 6, chosen: true },
      { provider: "p", fields: ["sentiment"], scoreDelta: -2, returnPct: -3, chosen: false },
      { provider: "prompt-only", fields: ["companyName"], scoreDelta: 0, returnPct: 2, chosen: true }
    ]);
    expect(rows.find((row) => row.provider === "p")).toMatchObject({
      outcomes: 2,
      directionalOutcomes: 2,
      chosenOutcomes: 1,
      skippedOutcomes: 1,
      directionalAgreementRate: 100,
      directionalValuePct: 4.5,
      learningStatus: "insufficient"
    });
    expect(rows.find((row) => row.provider === "prompt-only")).toMatchObject({
      directionalOutcomes: 0,
      directionalValuePct: 0
    });
  });
});
