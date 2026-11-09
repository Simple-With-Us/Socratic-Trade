import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { TradeProposal } from "../src/lib/types";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-tp-trim-${randomUUID()}.db`)}`;
});

describe("take_profit_trims ratchet persistence", () => {
  it("round-trips band + cost basis, upserts, and clears on close", async () => {
    const { getTakeProfitTrimBands, recordTakeProfitTrimBand, clearTakeProfitTrimBands } = await import("../src/lib/db");
    const acct = "ACCT1";

    expect(getTakeProfitTrimBands(acct)).toEqual({});

    recordTakeProfitTrimBand(acct, "NVDA", 1, 100);
    recordTakeProfitTrimBand(acct, "AAPL", 2, 200);
    expect(getTakeProfitTrimBands(acct)).toEqual({ NVDA: { band: 1, avgCost: 100 }, AAPL: { band: 2, avgCost: 200 } });

    // Upsert advances band (and basis) for the same key (no duplicate row).
    recordTakeProfitTrimBand(acct, "NVDA", 3, 100);
    expect(getTakeProfitTrimBands(acct)).toEqual({ NVDA: { band: 3, avgCost: 100 }, AAPL: { band: 2, avgCost: 200 } });

    expect(getTakeProfitTrimBands("OTHER")).toEqual({}); // scoped per account

    clearTakeProfitTrimBands(acct, []); // no-op
    expect(getTakeProfitTrimBands(acct)).toEqual({ NVDA: { band: 3, avgCost: 100 }, AAPL: { band: 2, avgCost: 200 } });
    clearTakeProfitTrimBands(acct, ["NVDA"]);
    expect(getTakeProfitTrimBands(acct)).toEqual({ AAPL: { band: 2, avgCost: 200 } });
  });

  it("floors the stored band to a non-negative integer", async () => {
    const { getTakeProfitTrimBands, recordTakeProfitTrimBand } = await import("../src/lib/db");
    recordTakeProfitTrimBand("ACCT2", "MSFT", 2.9, 50);
    expect(getTakeProfitTrimBands("ACCT2").MSFT).toEqual({ band: 2, avgCost: 50 });
  });
});

describe("take-profit band is committed ON FILL, not at plan time", () => {
  const trim = (takeProfitBand?: number): TradeProposal => ({
    symbol: "NVDA",
    side: "sell",
    type: "market",
    quantity: 4,
    timeInForce: "gfd",
    marketHours: "regular_hours",
    rationale: "take-profit trim",
    tradeThesisTag: "Risk-Exit",
    entryMarketRegime: "Active Risk Check",
    ...(takeProfitBand != null ? { takeProfitBand, takeProfitBasis: 100 } : {})
  });

  it("recordFillFromProposal advances the ratchet for a trim carrying a band", async () => {
    const { getTakeProfitTrimBands } = await import("../src/lib/db");
    const { recordFillFromProposal } = await import("../src/lib/performance");
    recordFillFromProposal({ accountNumber: "FILLACCT", source: "paper", status: "filled", proposal: trim(1) });
    expect(getTakeProfitTrimBands("FILLACCT")).toEqual({ NVDA: { band: 1, avgCost: 100 } });
  });

  it("recordFillFromProposal does NOT touch the ratchet for a non-trim fill (no band)", async () => {
    const { getTakeProfitTrimBands } = await import("../src/lib/db");
    const { recordFillFromProposal } = await import("../src/lib/performance");
    recordFillFromProposal({ accountNumber: "NOBANDACCT", source: "paper", status: "filled", proposal: trim(undefined) });
    expect(getTakeProfitTrimBands("NOBANDACCT")).toEqual({});
  });
});
