/**
 * test/coarse-credit.test.ts — coarse-credit attribution + MAE/MFE plumbing tests
 *
 * Covers:
 * - Change A: dual-sided attribution (entry run now receives credit)
 * - Change B: MAE/MFE plumbing through db-fills → calculatePnl → closedLots
 * - Change C: OOS-unvalidated weight changes withheld by default; opt-out preserves legacy
 * - Flag gating: compactPerformance strips entry/exit keys by default (byte-for-byte unchanged)
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";

// Hoist OOS mock — same pattern as strategy-tuning.test.ts
const mockRunWalkForwardOOS = vi.fn<() => Promise<import("../src/lib/backtest").OOSResult | null>>();
mockRunWalkForwardOOS.mockResolvedValue(null);

vi.mock("../src/lib/backtest", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/backtest")>();
  return { ...actual, runWalkForwardOOS: mockRunWalkForwardOOS };
});

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-coarse-credit-${randomUUID()}.db`)}`;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENROUTER_API_KEY;
  mockRunWalkForwardOOS.mockResolvedValue(null);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeFill(overrides: {
  id?: string;
  symbol?: string;
  side: "buy" | "sell" | "short" | "cover";
  quantity: number;
  price: number;
  notional: number;
  runId?: string;
  accountNumber?: string;
  source?: "paper" | "live";
  filledAt?: string;
  mae?: number;
  mfe?: number;
}): import("../src/lib/types").FillEvent {
  return {
    id: overrides.id ?? randomUUID(),
    symbol: overrides.symbol ?? "AAPL",
    side: overrides.side,
    quantity: overrides.quantity,
    price: overrides.price,
    notional: overrides.notional,
    runId: overrides.runId,
    accountNumber: overrides.accountNumber ?? "TEST-ACCT",
    source: overrides.source ?? "paper",
    status: "filled",
    filledAt: overrides.filledAt ?? new Date().toISOString(),
    mae: overrides.mae,
    mfe: overrides.mfe
  };
}

// ─── Change A tests ───────────────────────────────────────────────────────────

describe("Change A — dual-sided attribution", () => {
  it("credits the ENTRY run for realized P&L that previously went only to the exit run", async () => {
    const { calculatePnl } = await import("../src/lib/performance");

    const fills = [
      makeFill({ id: "buy-1", side: "buy", quantity: 10, price: 100, notional: 1000, runId: "entry-run", filledAt: "2026-01-01T10:00:00.000Z" }),
      makeFill({ id: "sell-1", side: "sell", quantity: 10, price: 110, notional: 1100, runId: "exit-run", filledAt: "2026-01-01T11:00:00.000Z" })
    ];

    const { attribution } = calculatePnl(fills);

    const entryAttr = attribution.find((a) => a.runId === "entry-run");
    const exitAttr = attribution.find((a) => a.runId === "exit-run");

    expect(entryAttr).toBeDefined();
    expect(exitAttr).toBeDefined();

    // Core fix: entry run now receives realizedPnlAsEntry === 100 (was 0 before)
    expect(entryAttr!.realizedPnlAsEntry).toBeCloseTo(100);
    // Exit run still gets the full realized P&L in the existing field
    expect(exitAttr!.realizedPnl).toBeCloseTo(100);
  });

  it("leaves the exit run's existing realizedPnl unchanged (backward compat)", async () => {
    const { calculatePnl } = await import("../src/lib/performance");

    const fills = [
      makeFill({ id: "buy-2", side: "buy", quantity: 10, price: 100, notional: 1000, runId: "entry-run", filledAt: "2026-01-01T10:00:00.000Z" }),
      makeFill({ id: "sell-2", side: "sell", quantity: 10, price: 110, notional: 1100, runId: "exit-run", filledAt: "2026-01-01T11:00:00.000Z" })
    ];

    const { attribution } = calculatePnl(fills);

    const entryAttr = attribution.find((a) => a.runId === "entry-run");
    const exitAttr = attribution.find((a) => a.runId === "exit-run");

    // Exit run: existing realizedPnl field unchanged
    expect(exitAttr!.realizedPnl).toBeCloseTo(100);

    // Entry run: realizedPnl stays 0 (the BUY fill contributes 0 realized P&L)
    expect(entryAttr!.realizedPnl).toBeCloseTo(0);

    // Entry run: fillCount is 1 (the BUY fill only — NOT incremented by entry-credit call)
    expect(entryAttr!.fillCount).toBe(1);

    // Entry run gets credit only via the new additive field
    expect(entryAttr!.realizedPnlAsEntry).toBeCloseTo(100);
  });

  it("same run opening and closing is credited once, not double-counted", async () => {
    const { calculatePnl } = await import("../src/lib/performance");

    const fills = [
      makeFill({ id: "buy-3", side: "buy", quantity: 10, price: 100, notional: 1000, runId: "solo", filledAt: "2026-01-01T10:00:00.000Z" }),
      makeFill({ id: "sell-3", side: "sell", quantity: 10, price: 110, notional: 1100, runId: "solo", filledAt: "2026-01-01T11:00:00.000Z" })
    ];

    const { attribution } = calculatePnl(fills);

    const soloAttr = attribution.find((a) => a.runId === "solo");
    expect(soloAttr).toBeDefined();

    // realizedPnl from exit fill (existing field)
    expect(soloAttr!.realizedPnl).toBeCloseTo(100);
    // realizedPnlAsExit mirrors it
    expect(soloAttr!.realizedPnlAsExit).toBeCloseTo(100);
    // realizedPnlAsEntry is undefined — guard prevented the addEntryAttribution call
    // since entry runId === exit runId
    expect(soloAttr!.realizedPnlAsEntry).toBeUndefined();
  });
});

// ─── Change B tests ───────────────────────────────────────────────────────────

describe("Change B — MAE/MFE plumbing through closedLots", () => {
  it("closedLot mae/mfe are undefined when fills have no excursion data", async () => {
    const { calculatePnl } = await import("../src/lib/performance");

    const fills = [
      makeFill({ id: "buy-mae-1", side: "buy", quantity: 1, price: 100, notional: 100, filledAt: "2026-01-01T10:00:00.000Z" }),
      makeFill({ id: "sell-mae-1", side: "sell", quantity: 1, price: 110, notional: 110, filledAt: "2026-01-01T11:00:00.000Z" })
    ];

    const { closedLots } = calculatePnl(fills);
    expect(closedLots.length).toBe(1);
    expect(closedLots[0].mae).toBeUndefined();
    expect(closedLots[0].mfe).toBeUndefined();
  });

  it("closedLot mae/mfe are populated when persisted on the exit fill (DB-backed)", async () => {
    const { insertFillEvent, upsertFillExcursions, listFillEvents } = await import("../src/lib/db");
    const { calculatePnl } = await import("../src/lib/performance");

    const userId = `excursion-test-${randomUUID()}`;
    const accountNumber = `ACC-MAE-${randomUUID().slice(0, 8)}`;

    const buyFill = insertFillEvent({
      userId,
      accountNumber,
      source: "paper",
      symbol: "TSLA",
      side: "buy",
      quantity: 1,
      price: 200,
      notional: 200,
      status: "filled",
      filledAt: "2026-01-01T10:00:00.000Z"
    });

    const sellFill = insertFillEvent({
      userId,
      accountNumber,
      source: "paper",
      symbol: "TSLA",
      side: "sell",
      quantity: 1,
      price: 220,
      notional: 220,
      status: "filled",
      filledAt: "2026-01-01T11:00:00.000Z"
    });

    // Persist MAE/MFE on the SELL (exit) fill row — as the post-mortem path would
    upsertFillExcursions(sellFill.id, -3.5, 12.0, userId);

    const fills = listFillEvents(accountNumber, "paper", 500, userId);
    const { closedLots } = calculatePnl(fills);

    expect(closedLots.length).toBe(1);
    expect(closedLots[0].mae).toBeCloseTo(-3.5);
    expect(closedLots[0].mfe).toBeCloseTo(12.0);
  });
});

// ─── Change C tests ───────────────────────────────────────────────────────────

describe("Change C — withhold OOS-unvalidated weight changes", () => {
  it("withholds OOS-unvalidated weight changes by default (oosWithholdUnvalidated not set)", async () => {
    const { insertFillEvent, setPolicy, setStrategyPrompt } = await import("../src/lib/db");
    const { proposeStrategyTuning } = await import("../src/lib/strategy-tuning");

    delete process.env.OPENROUTER_API_KEY;
    setStrategyPrompt("OOS WITHHOLD DEFAULT TEST");
    const customWeights = { liquidity: 1.0, momentum: 1.0, value: 1.0, quality: 1.0, volatility: 1.0, sentiment: 1.0, positioning: 1.0, diversification: 1.0 };
    // No tuning.oosWithholdUnvalidated set → default true → withhold
    setPolicy({ ...DEFAULT_POLICY, accountNumber: "OOS-WITHHOLD", scoringWeights: customWeights });

    let t = 0;
    for (let i = 0; i < 20; i++) {
      const sym = `W${i}`;
      insertFillEvent({ accountNumber: "OOS-WITHHOLD", source: "paper", symbol: sym, side: "buy", quantity: 1, price: 100, notional: 100, status: "filled", filledAt: `2026-06-15T00:0${Math.floor(t / 60)}:${String(t++ % 60).padStart(2, "0")}.000Z` });
      insertFillEvent({ accountNumber: "OOS-WITHHOLD", source: "paper", symbol: sym, side: "sell", quantity: 1, price: 90, notional: 90, status: "filled", filledAt: `2026-06-15T00:0${Math.floor(t / 60)}:${String(t++ % 60).padStart(2, "0")}.000Z` });
    }
    mockRunWalkForwardOOS.mockResolvedValueOnce(null); // insufficient snapshots

    const proposal = await proposeStrategyTuning();

    // Weights STRIPPED (new default behavior — withhold unvalidated changes)
    expect(proposal.proposedPatch.scoringWeights).toBeUndefined();

    const cautions = proposal.cautions.join(" ");
    expect(cautions).toMatch(/NOT out-of-sample validated/i);
    expect(cautions).toMatch(/insufficient snapshot/i);
  });

  it("keeps OOS-unvalidated weight changes when oosWithholdUnvalidated=false (legacy opt-out)", async () => {
    const { insertFillEvent, setPolicy, setStrategyPrompt } = await import("../src/lib/db");
    const { proposeStrategyTuning } = await import("../src/lib/strategy-tuning");

    delete process.env.OPENROUTER_API_KEY;
    setStrategyPrompt("OOS LEGACY KEEP TEST");
    const customWeights = { liquidity: 1.0, momentum: 1.0, value: 1.0, quality: 1.0, volatility: 1.0, sentiment: 1.0, positioning: 1.0, diversification: 1.0 };
    // Explicit opt-out: restore legacy keep-behavior
    setPolicy({ ...DEFAULT_POLICY, accountNumber: "OOS-LEGACY", scoringWeights: customWeights, tuning: { oosWithholdUnvalidated: false } });

    let t = 0;
    for (let i = 0; i < 20; i++) {
      const sym = `L${i}`;
      insertFillEvent({ accountNumber: "OOS-LEGACY", source: "paper", symbol: sym, side: "buy", quantity: 1, price: 100, notional: 100, status: "filled", filledAt: `2026-06-15T00:0${Math.floor(t / 60)}:${String(t++ % 60).padStart(2, "0")}.000Z` });
      insertFillEvent({ accountNumber: "OOS-LEGACY", source: "paper", symbol: sym, side: "sell", quantity: 1, price: 90, notional: 90, status: "filled", filledAt: `2026-06-15T00:0${Math.floor(t / 60)}:${String(t++ % 60).padStart(2, "0")}.000Z` });
    }
    mockRunWalkForwardOOS.mockResolvedValueOnce(null); // insufficient snapshots

    const proposal = await proposeStrategyTuning();

    // Weights KEPT (legacy opt-out behavior)
    expect(proposal.proposedPatch.scoringWeights).toBeDefined();

    const cautions = proposal.cautions.join(" ");
    expect(cautions).toMatch(/NOT out-of-sample validated/i);
  });
});

// ─── Flag gating test (Change A consumer) ────────────────────────────────────

describe("Change A consumer — compactPerformance flag gating", () => {
  it("flag OFF: attribution context excludes entry/exit credit keys (byte-for-byte unchanged)", async () => {
    const { compactPerformance } = await import("../src/lib/strategy-tuning");

    // Build a minimal PerformanceSummary stub with realizedPnlAsEntry/realizedPnlAsExit populated
    const stubAttribution: import("../src/lib/types").RunAttribution[] = [
      { runId: "run-a", fillCount: 1, notional: 1000, realizedPnl: 50, realizedPnlAsEntry: 75, realizedPnlAsExit: 50 },
      { runId: "run-b", fillCount: 2, notional: 2000, realizedPnl: -20, realizedPnlAsEntry: -10, realizedPnlAsExit: -20 }
    ];

    const stubPerf = {
      liveRealizedPnl: 0, paperRealizedPnl: 30,
      liveUnrealizedPnl: 0, paperUnrealizedPnl: 5,
      liveWinRate: 0, paperWinRate: 60,
      liveAverageReturnPct: 0, paperAverageReturnPct: 2.5,
      fills: [],
      attribution: stubAttribution,
      liveEquityCurve: [], paperEquityCurve: [],
      closedLots: [], openLots: [],
      liveClosedLots: [], paperClosedLots: []
    } as unknown as import("../src/lib/types").PerformanceSummary;

    // FLAG OFF (default) — new keys stripped
    const compactOff = compactPerformance(stubPerf, true, false);
    expect(compactOff).toBeDefined();
    for (const item of compactOff!.recentAttribution) {
      expect(Object.keys(item)).not.toContain("realizedPnlAsEntry");
      expect(Object.keys(item)).not.toContain("realizedPnlAsExit");
    }

    // FLAG ON — new keys present
    const compactOn = compactPerformance(stubPerf, true, true);
    expect(compactOn).toBeDefined();
    const itemsWithEntry = compactOn!.recentAttribution.filter((a) => "realizedPnlAsEntry" in a);
    expect(itemsWithEntry.length).toBeGreaterThan(0);
  });
});
