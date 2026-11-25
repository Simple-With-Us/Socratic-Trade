// OD-3 tighten-only defaults (owner-approved 2026-11-24, ST-4680; child of ST-4668).
// Pins the new DEFAULT_POLICY values, the default sector-cap fallback seam (gate + sizer),
// and the earnings-blackout default-on merge inheritance. The separate-decision subset
// (trailing stops, marketableLimitEntries, VIX severity sizing, Thompson routing, alpha
// grading, FUNDAMENTALS_ASOF_STRICT) is deliberately NOT touched here.
// Temp SQLite per run — never the dev app.db.
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import { evaluateTradeProposal } from "../src/lib/policy";
import type { EquityPosition, MarketScan, Portfolio, TradeProposal, TradingPolicy } from "../src/lib/types";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-od3-tighten-${randomUUID()}.db`)}`;
});

const portfolio: Portfolio = {
  accountNumber: "OD3",
  totalMarketValue: 10_000,
  buyingPower: 10_000,
  equityMarketValue: 5_000,
  optionMarketValue: 0,
  cash: 5_000
};

function buy(overrides: Partial<TradeProposal> = {}): TradeProposal {
  return {
    symbol: "NVDA",
    side: "buy",
    type: "market",
    dollarAmount: 10,
    timeInForce: "gfd",
    marketHours: "regular_hours",
    rationale: "test",
    tradeThesisTag: "test",
    entryMarketRegime: "test",
    ...overrides
  };
}

function activePolicy(overrides: Partial<TradingPolicy> = {}): TradingPolicy {
  return {
    ...DEFAULT_POLICY,
    systemState: "active",
    strategyAuthority: "decide",
    accountNumber: "OD3",
    includedIndices: [],
    additionalSymbols: ["NVDA", "MSFT"],
    maxQuoteAgeSec: 0,
    ...overrides
  };
}

const techScan = {
  sectorBySymbol: { NVDA: "Technology", MSFT: "Technology" },
  quotesBySymbol: {},
  topCandidates: []
} as unknown as MarketScan;

describe("OD-3 DEFAULT_POLICY values", () => {
  it("tightened risk defaults are present", () => {
    expect(DEFAULT_POLICY.maxEntryDriftPct).toBe(3);
    expect(DEFAULT_POLICY.proposalExpiryMinutes).toBe(240);
    expect(DEFAULT_POLICY.maxSymbolExposurePct).toBe(15);
    expect(DEFAULT_POLICY.defaultSectorCapPct).toBe(30);
    expect(DEFAULT_POLICY.tuning?.earningsBlackout).toBe(true);
  });

  it("autoApplyWeights stays OFF (the separate-decision subset is out of scope)", () => {
    expect(DEFAULT_POLICY.tuning?.autoApplyWeights ?? false).toBe(false);
  });

  it("mergePolicy({}) inherits every tightened default", async () => {
    const { mergePolicy } = await import("../src/lib/db-profiles");
    const merged = mergePolicy({});
    expect(merged.maxEntryDriftPct).toBe(3);
    expect(merged.proposalExpiryMinutes).toBe(240);
    expect(merged.maxSymbolExposurePct).toBe(15);
    expect(merged.defaultSectorCapPct).toBe(30);
    expect(merged.tuning?.earningsBlackout).toBe(true);
  });

  it("explicit stored values still win over the tightened defaults", async () => {
    const { mergePolicy } = await import("../src/lib/db-profiles");
    const merged = mergePolicy({
      maxEntryDriftPct: 10,
      proposalExpiryMinutes: 2880,
      maxSymbolExposurePct: 25,
      defaultSectorCapPct: 0,
      tuning: { earningsBlackout: false }
    });
    expect(merged.maxEntryDriftPct).toBe(10);
    expect(merged.proposalExpiryMinutes).toBe(2880);
    expect(merged.maxSymbolExposurePct).toBe(25);
    expect(merged.defaultSectorCapPct).toBe(0);
    expect(merged.tuning?.earningsBlackout).toBe(false);
  });
});

describe("OD-3 default sector cap — policy gate fallback", () => {
  const techPositions: EquityPosition[] = [
    { symbol: "MSFT", quantity: 10, averageCost: 250, marketValue: 2_500, sector: "Technology" } // 25% of $10k
  ];

  it("no explicit sectorCaps entry: the 30% default fallback blocks a sector-over-cap opening", () => {
    // MSFT 2500 + NVDA 1000 = 3500 = 35% Technology > the 30% fallback.
    const decision = evaluateTradeProposal(buy({ dollarAmount: 1_000 }), {
      policy: activePolicy(),
      portfolio,
      positions: techPositions,
      marketScan: techScan,
      dailyNotionalUsed: 0,
      dailyOrderCount: 0,
      estimatedNotional: 1_000
    });
    expect(decision.approved).toBe(false);
    expect(decision.reasons.join(" ")).toContain("Technology sector exposure");
  });

  it("an opening that stays under the 30% fallback is not sector-blocked", () => {
    // MSFT 2500 + NVDA 400 = 2900 = 29% Technology <= 30%.
    const decision = evaluateTradeProposal(buy({ dollarAmount: 400 }), {
      policy: activePolicy(),
      portfolio,
      positions: techPositions,
      marketScan: techScan,
      dailyNotionalUsed: 0,
      dailyOrderCount: 0,
      estimatedNotional: 400
    });
    expect(decision.reasons.join(" ")).not.toContain("sector exposure");
  });

  it("an explicit per-sector entry WINS over the fallback (looser)", () => {
    // Technology: 50 allows the 35% projection the 30% fallback would block.
    const decision = evaluateTradeProposal(buy({ dollarAmount: 1_000 }), {
      policy: activePolicy({ sectorCaps: { Technology: 50 } }),
      portfolio,
      positions: techPositions,
      marketScan: techScan,
      dailyNotionalUsed: 0,
      dailyOrderCount: 0,
      estimatedNotional: 1_000
    });
    expect(decision.reasons.join(" ")).not.toContain("sector exposure");
  });

  it("an explicit per-sector entry WINS over the fallback (stricter, case-insensitive match kept)", () => {
    // technology: 10 blocks a 26% projection even though the fallback is 30%.
    const decision = evaluateTradeProposal(buy({ dollarAmount: 100 }), {
      policy: activePolicy({ sectorCaps: { technology: 10 } }),
      portfolio,
      positions: techPositions,
      marketScan: techScan,
      dailyNotionalUsed: 0,
      dailyOrderCount: 0,
      estimatedNotional: 100
    });
    expect(decision.approved).toBe(false);
    expect(decision.reasons.join(" ")).toContain("Technology sector exposure");
  });

  it("defaultSectorCapPct 0 disables the fallback (pre-ST-4680 behavior)", () => {
    const decision = evaluateTradeProposal(buy({ dollarAmount: 1_000 }), {
      policy: activePolicy({ defaultSectorCapPct: 0 }),
      portfolio,
      positions: techPositions,
      marketScan: techScan,
      dailyNotionalUsed: 0,
      dailyOrderCount: 0,
      estimatedNotional: 1_000
    });
    expect(decision.reasons.join(" ")).not.toContain("sector exposure");
  });
});

describe("OD-3 default sector cap — deterministic sizer fallback", () => {
  it("trims an opening to remaining DEFAULT sector capacity when no explicit entry matches", async () => {
    const { applyDeterministicSizing } = await import("../src/lib/strategy");
    const positions: EquityPosition[] = [
      { symbol: "MSFT", quantity: 12, averageCost: 200, marketValue: 2_800, sector: "Technology" } // 28% of $10k
    ];
    const sized = applyDeterministicSizing(
      buy({ dollarAmount: 900 }),
      activePolicy(),
      portfolio,
      "paper",
      "local",
      positions,
      techScan
    );
    // 30% of $10k = $3000 cap − $2800 held = $200 sector room.
    const match = sized.rationale.match(/risk controls limited it to \$([0-9,]+)/);
    expect(match).not.toBeNull();
    expect(Number(match![1].replace(/,/g, ""))).toBe(200);
    expect(sized.rationale).toContain("Technology sector cap");
  });

  it("an explicit per-sector entry still wins in the sizer", async () => {
    const { applyDeterministicSizing } = await import("../src/lib/strategy");
    const positions: EquityPosition[] = [
      { symbol: "MSFT", quantity: 12, averageCost: 200, marketValue: 2_400, sector: "Technology" } // 24% of $10k
    ];
    const sized = applyDeterministicSizing(
      buy({ dollarAmount: 900 }),
      activePolicy({ sectorCaps: { Technology: 25 } }),
      portfolio,
      "paper",
      "local",
      positions,
      techScan
    );
    // Explicit 25% cap: $2500 − $2400 = $100 room (NOT the 30% fallback's $600).
    const match = sized.rationale.match(/risk controls limited it to \$([0-9,]+)/);
    expect(match).not.toBeNull();
    expect(Number(match![1].replace(/,/g, ""))).toBe(100);
  });
});

describe("OD-3 earnings blackout — default-on merge inheritance", () => {
  it("a stored tuning object that never set earningsBlackout inherits true", async () => {
    const { mergePolicy } = await import("../src/lib/db-profiles");
    const merged = mergePolicy({ tuning: { volTargeting: false } });
    expect(merged.tuning?.earningsBlackout).toBe(true);
    expect(merged.tuning?.volTargeting).toBe(false);
  });
});