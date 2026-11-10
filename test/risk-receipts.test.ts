import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import type { EquityPosition, MarketQuote, MarketScan, Portfolio, TradeProposal } from "../src/lib/types";

// Mock only fetchDailyOHLC (keep toBusinessDay real) so correlationProfile's end-to-end fetch-vs-skip
// behavior is testable, mirroring test/correlation-cluster-gate.test.ts's pattern.
vi.mock("../src/lib/history", async (importActual) => {
  const actual = await importActual<typeof import("../src/lib/history")>();
  return { ...actual, fetchDailyOHLC: vi.fn() };
});

beforeEach(() => {
  vi.resetModules();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-risk-receipts-${randomUUID()}.db`)}`;
});

/** Build a daily OHLC series (ascending "YYYY-MM-DD" dates) from a returns array. */
function barsFromReturns(returns: number[], start = 100) {
  const bars: Array<{ time: string; close: number }> = [];
  let price = start;
  let day = Date.UTC(2026, 0, 1);
  bars.push({ time: new Date(day).toISOString().slice(0, 10), close: price });
  for (const r of returns) {
    price *= 1 + r;
    day += 24 * 3600 * 1000;
    bars.push({ time: new Date(day).toISOString().slice(0, 10), close: price });
  }
  return bars;
}
const R = Array.from({ length: 30 }, (_, i) => Math.sin(i * 0.7) / 50);

function buy(symbol: string, overrides: Partial<TradeProposal> = {}): TradeProposal {
  return {
    symbol,
    side: "buy",
    type: "market",
    timeInForce: "gfd",
    marketHours: "regular_hours",
    rationale: "base rationale",
    tradeThesisTag: "t",
    entryMarketRegime: "r",
    dollarAmount: 1000,
    ...overrides
  };
}

function quote(symbol: string, overrides: Partial<MarketQuote> = {}): MarketQuote {
  return {
    symbol,
    price: 100,
    volume: 1_000_000,
    intradayChangePct: 0,
    positionMarketValue: 0,
    score: 50,
    asOf: "2026-07-05T00:00:00.000Z",
    ...overrides
  };
}

function scan(quotes: MarketQuote[]): MarketScan {
  return {
    source: "test",
    generatedAt: "2026-07-05T00:00:00.000Z",
    scannedSymbols: quotes.length,
    returnedQuotes: quotes.length,
    topCandidates: quotes,
    sectorBySymbol: {},
    quotesBySymbol: Object.fromEntries(quotes.map((q) => [q.symbol, q])),
    warnings: []
  };
}

const portfolio: Portfolio = {
  accountNumber: "X",
  totalMarketValue: 100_000,
  buyingPower: 50_000,
  equityMarketValue: 100_000,
  optionMarketValue: 0,
  cash: 0
};

const held: EquityPosition[] = [{ symbol: "HELD", quantity: 10, averageCost: 100, marketValue: 10_000 }];

describe("applyRiskReceipts — flag OFF (explicit opt-out)", () => {
  it("is byte-identical: no [Risk] notes, no preVetoReasons, and fetchDailyOHLC is never called", async () => {
    const { fetchDailyOHLC } = await import("../src/lib/history");
    const { applyRiskReceipts } = await import("../src/lib/strategy");

    const proposals = [buy("AAA")];
    // riskReceipts defaulted ON 2026-07-28 (guard enablement); pin it OFF to keep testing the
    // flag-off code path.
    const policy = { ...DEFAULT_POLICY, accountNumber: "X", tuning: { riskReceipts: false } };
    const marketScan = scan([quote("AAA", { beta: 1.2 })]);

    const out = await applyRiskReceipts(proposals, policy, held, portfolio, marketScan, "local");

    expect(out).toHaveLength(1);
    expect(out[0].rationale).toBe("base rationale");
    expect(out[0].rationale).not.toContain("[Risk]");
    expect(out[0].preVetoReasons ?? []).toHaveLength(0);
    expect((fetchDailyOHLC as Mock)).not.toHaveBeenCalled();
  });

  it("earnings note is unconditional (independent of riskReceipts/earningsBlackout) but never tags", async () => {
    // Per spec, the informational earnings note is unconditional whenever daysToEarnings <= 7 (independent
    // of riskReceipts/earningsBlackout) — only the preVetoReasons TAG depends on earningsBlackout. This
    // test documents that: the note appears, but no tag and no correlation/stress notes.
    const { applyRiskReceipts } = await import("../src/lib/strategy");
    const proposals = [buy("AAA")];
    // riskReceipts pinned OFF (it defaults ON since the 2026-07-28 guard enablement) so this test
    // keeps isolating the unconditional earnings note from the correlation/stress receipts.
    const policy = { ...DEFAULT_POLICY, accountNumber: "X", tuning: { riskReceipts: false } };
    const marketScan = scan([quote("AAA", { daysToEarnings: 5 })]);

    const out = await applyRiskReceipts(proposals, policy, held, portfolio, marketScan, "local");
    expect(out[0].rationale).toContain("[Risk] Earnings in 5 trading day(s)");
    expect(out[0].rationale).not.toContain("blackout window");
    expect(out[0].rationale).not.toContain("Correlation");
    expect(out[0].rationale).not.toContain("Stress");
    expect(out[0].preVetoReasons ?? []).toHaveLength(0);
  });
});

describe("applyRiskReceipts — riskReceipts ON", () => {
  it("attaches correlation + stress notes with mocked bars, and audits both receipts", async () => {
    const { fetchDailyOHLC } = await import("../src/lib/history");
    const candBars = barsFromReturns(R);
    const heldBars = barsFromReturns(R.map((x) => x * 0.9)); // strongly correlated
    (fetchDailyOHLC as Mock).mockImplementation(async (sym: string) => {
      if (sym === "AAA") return candBars;
      if (sym === "HELD") return heldBars;
      return null;
    });
    const dbModule = await import("../src/lib/db");
    const auditSpy = vi.spyOn(dbModule, "audit");
    const { applyRiskReceipts } = await import("../src/lib/strategy");

    const proposals = [buy("AAA")];
    const policy = { ...DEFAULT_POLICY, accountNumber: "X", tuning: { riskReceipts: true } };
    const marketScan = scan([quote("AAA", { beta: 1.2 })]);

    const out = await applyRiskReceipts(proposals, policy, held, portfolio, marketScan, "local");

    expect(out[0].rationale).toContain("[Risk] Correlation: max");
    expect(out[0].rationale).toContain("HELD");
    expect(out[0].rationale).toContain("[Risk] Stress");
    expect(out[0].rationale).toContain("% (mkt): book");
    expect(auditSpy).toHaveBeenCalledWith("correlation_receipt", expect.objectContaining({ symbol: "AAA" }), "local", policy.connectedAccountId);
    expect(auditSpy).toHaveBeenCalledWith("stress_receipt", expect.objectContaining({ symbol: "AAA" }), "local", policy.connectedAccountId);
  });

  it("never appends a correlation note when there are no holdings or bar data is insufficient (never fabricates)", async () => {
    const { fetchDailyOHLC } = await import("../src/lib/history");
    (fetchDailyOHLC as Mock).mockResolvedValue(null);
    const { applyRiskReceipts } = await import("../src/lib/strategy");

    const proposals = [buy("AAA")];
    const policy = { ...DEFAULT_POLICY, accountNumber: "X", tuning: { riskReceipts: true } };
    const marketScan = scan([quote("AAA", { beta: 1.2 })]);

    // No holdings at all → correlationProfile returns undefined immediately (no fetch needed since
    // holdings.length===0 short-circuits before any bar fetch).
    const out = await applyRiskReceipts(proposals, policy, [], portfolio, marketScan, "local");
    expect(out[0].rationale).not.toContain("Correlation");
    // Stress receipt still fires (positions=[] is a valid, if empty, book).
    expect(out[0].rationale).toContain("[Risk] Stress");
  });

  it("exits (sell/cover) are never touched", async () => {
    const { applyRiskReceipts } = await import("../src/lib/strategy");
    const proposals: TradeProposal[] = [buy("HELD", { side: "sell" })];
    const policy = { ...DEFAULT_POLICY, accountNumber: "X", tuning: { riskReceipts: true, earningsBlackout: true } };
    const marketScan = scan([quote("HELD", { daysToEarnings: 1 })]);

    const out = await applyRiskReceipts(proposals, policy, held, portfolio, marketScan, "local");
    expect(out[0].rationale).toBe("base rationale");
    expect(out[0].preVetoReasons ?? []).toHaveLength(0);
  });

  it("re-proves ownership after correlation IO before mutating rationale or auditing", async () => {
    const { fetchDailyOHLC } = await import("../src/lib/history");
    const candBars = barsFromReturns(R);
    (fetchDailyOHLC as Mock).mockImplementation(async () => candBars);
    const dbModule = await import("../src/lib/db");
    const auditSpy = vi.spyOn(dbModule, "audit");
    const { applyRiskReceipts } = await import("../src/lib/strategy");
    const proposal = buy("AAA");
    let checks = 0;
    const assertOwned = () => {
      checks++;
      if (checks === 2) throw new Error("lease lost after risk IO");
    };

    await expect(applyRiskReceipts(
      [proposal],
      { ...DEFAULT_POLICY, accountNumber: "X", tuning: { riskReceipts: true } },
      held,
      portfolio,
      scan([quote("AAA")]),
      "local",
      assertOwned
    )).rejects.toThrow("lease lost after risk IO");
    expect(proposal.rationale).toBe("base rationale");
    expect(auditSpy).not.toHaveBeenCalledWith("correlation_receipt", expect.anything(), expect.anything(), expect.anything());
  });
});

describe("applyRiskReceipts — earnings blackout", () => {
  it("flag ON + within window: tags preVetoReasons with an overridable earnings_blackout reason", async () => {
    const { isHardGateReason } = await import("../src/lib/policy");
    const { applyRiskReceipts } = await import("../src/lib/strategy");
    const proposals = [buy("AAA")];
    const policy = { ...DEFAULT_POLICY, accountNumber: "X", tuning: { earningsBlackout: true, earningsBlackoutDays: 3 } };
    const marketScan = scan([quote("AAA", { daysToEarnings: 2 })]);

    const out = await applyRiskReceipts(proposals, policy, [], portfolio, marketScan, "local");
    expect(out[0].rationale).toContain("[Risk] Earnings in 2 trading day(s) — inside advisory blackout window");
    expect(out[0].preVetoReasons).toHaveLength(1);
    expect(out[0].preVetoReasons![0]).toMatch(/^earnings_blackout: opening within 2 day\(s\) of earnings \(window 3\)$/);
    expect(isHardGateReason(out[0].preVetoReasons![0])).toBe(false); // overridable, per house convention
  });

  it("flag ON but OUTSIDE window: note present, no tag", async () => {
    const { applyRiskReceipts } = await import("../src/lib/strategy");
    const proposals = [buy("AAA")];
    const policy = { ...DEFAULT_POLICY, accountNumber: "X", tuning: { earningsBlackout: true, earningsBlackoutDays: 3 } };
    const marketScan = scan([quote("AAA", { daysToEarnings: 6 })]);

    const out = await applyRiskReceipts(proposals, policy, [], portfolio, marketScan, "local");
    expect(out[0].rationale).toContain("[Risk] Earnings in 6 trading day(s)");
    expect(out[0].rationale).not.toContain("blackout window");
    expect(out[0].preVetoReasons ?? []).toHaveLength(0);
  });

  it("flag OFF: note still present (unconditional <=7d note) but never tagged", async () => {
    const { applyRiskReceipts } = await import("../src/lib/strategy");
    const proposals = [buy("AAA")];
    const policy = { ...DEFAULT_POLICY, accountNumber: "X" }; // earningsBlackout undefined -> off
    const marketScan = scan([quote("AAA", { daysToEarnings: 1 })]);

    const out = await applyRiskReceipts(proposals, policy, [], portfolio, marketScan, "local");
    expect(out[0].rationale).toContain("[Risk] Earnings in 1 trading day(s)");
    expect(out[0].rationale).not.toContain("blackout window");
    expect(out[0].preVetoReasons ?? []).toHaveLength(0);
  });

  it("unknown daysToEarnings is skipped silently — no note, no tag, never fabricated", async () => {
    const { applyRiskReceipts } = await import("../src/lib/strategy");
    const proposals = [buy("AAA")];
    const policy = { ...DEFAULT_POLICY, accountNumber: "X", tuning: { earningsBlackout: true, earningsBlackoutDays: 3 } };
    const marketScan = scan([quote("AAA", {})]); // no daysToEarnings field

    const out = await applyRiskReceipts(proposals, policy, [], portfolio, marketScan, "local");
    expect(out[0].rationale).toBe("base rationale");
    expect(out[0].preVetoReasons ?? []).toHaveLength(0);
  });
});

describe("applyRiskReceipts — reference identity (regression)", () => {
  it("returns the SAME object reference for an opening proposal, so a Set<TradeProposal> built before this call (e.g. requiresHumanReview) still recognizes it after", async () => {
    const { applyRiskReceipts } = await import("../src/lib/strategy");
    const proposals = [buy("AAA")];
    // requiresHumanReview mirrors runStrategyOnce's Set<TradeProposal>, built (as it is there) from an
    // EARLIER gate — before applyRiskReceipts ever runs.
    const requiresHumanReview = new Set(proposals);
    // riskReceipts ON + a nearby daysToEarnings so this proposal actually picks up BOTH a stress note
    // and an earnings note — the exact combination the regression required (any risk-receipt note
    // appended to a proposal already routed to human review by an earlier gate).
    const policy = { ...DEFAULT_POLICY, accountNumber: "X", tuning: { riskReceipts: true } };
    const marketScan = scan([quote("AAA", { beta: 1.1, daysToEarnings: 5 })]);

    const out = await applyRiskReceipts(proposals, policy, held, portfolio, marketScan, "local");

    expect(out[0]).toBe(proposals[0]); // same reference, not a rebuilt copy
    expect(out[0].rationale).toContain("[Risk] Stress");
    expect(out[0].rationale).toContain("[Risk] Earnings in 5 trading day(s)");
    // The Set built BEFORE applyRiskReceipts ran must still recognize this exact proposal afterward —
    // this is what the placement loop's `requiresHumanReview.has(proposal)` depends on.
    expect(requiresHumanReview.has(out[0])).toBe(true);
  });

  it("preserves reference identity for an exit (sell/cover), which applyRiskReceipts never touches", async () => {
    const { applyRiskReceipts } = await import("../src/lib/strategy");
    const proposals: TradeProposal[] = [buy("HELD", { side: "sell" })];
    const requiresHumanReview = new Set(proposals);
    const policy = { ...DEFAULT_POLICY, accountNumber: "X", tuning: { riskReceipts: true } };
    const marketScan = scan([quote("HELD", { beta: 1.1 })]);

    const out = await applyRiskReceipts(proposals, policy, held, portfolio, marketScan, "local");

    expect(out[0]).toBe(proposals[0]);
    expect(requiresHumanReview.has(out[0])).toBe(true);
  });
});

describe("applyEarningsBlackoutTag — ordering (regression)", () => {
  it("tags preVetoReasons independently and BEFORE applyRiskReceipts runs, matching the order runStrategyOnce now uses (tag on debatedProposals, then later stages read preVetoReasons)", async () => {
    const { applyEarningsBlackoutTag, applyRiskReceipts } = await import("../src/lib/strategy");
    const proposals = [buy("AAA")];
    const policy = { ...DEFAULT_POLICY, accountNumber: "X", tuning: { earningsBlackout: true, earningsBlackoutDays: 3 } };
    const marketScan = scan([quote("AAA", { daysToEarnings: 2 })]);

    // Simulate runStrategyOnce's ordering: tag on debatedProposals FIRST (before FIX#3 pre-routing /
    // sell-to-fund would read preVetoReasons in the real pipeline)...
    applyEarningsBlackoutTag(proposals, policy, marketScan, "local");
    expect(proposals[0].preVetoReasons).toHaveLength(1);
    expect(proposals[0].preVetoReasons![0]).toMatch(/^earnings_blackout:/);

    // ...then applyRiskReceipts runs later at the gatedProposals stage and must NOT double-tag or
    // double-append the note (idempotent per proposal).
    const out = await applyRiskReceipts(proposals, policy, [], portfolio, marketScan, "local");
    expect(out[0].preVetoReasons).toHaveLength(1);
    expect(out[0].rationale.match(/\[Risk\] Earnings in/g)).toHaveLength(1);
  });
});
