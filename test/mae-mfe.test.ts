import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { enrichClosedLotsWithExcursions } from "../src/lib/learning-loop";
import type { ClosedLot } from "../src/lib/performance";
import type { FillEvent } from "../src/lib/types";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-mae-mfe-${randomUUID()}.db`)}`;
});

function makeLot(overrides: Partial<ClosedLot> = {}): ClosedLot {
  return {
    pnl: 10,
    returnPct: 10,
    symbol: "TSLA",
    side: "long",
    entryPrice: 200,
    entryAt: "2026-06-01T00:00:00.000Z",
    exitAt: "2026-06-10T00:00:00.000Z",
    thesisTag: "Breakout",
    ...overrides
  };
}

function fill(
  input: Partial<FillEvent> & {
    id: string;
    side: "buy" | "sell";
    quantity: number;
    price: number;
    notional: number;
    filledAt: string;
  }
): FillEvent {
  return {
    proposalId: "p-mae1",
    runId: "r-mae1",
    accountNumber: "MAE1",
    source: "paper",
    symbol: "TSLA",
    status: "filled",
    raw: undefined,
    ...input
  };
}

describe("enrichClosedLotsWithExcursions", () => {
  it("stamps mae and mfe onto qualifying lots using the mock fetcher", async () => {
    const mockCompute = async () => ({ mae: -3.5, mfe: 12.0 });

    const lots: ClosedLot[] = [makeLot()];
    const enriched = await enrichClosedLotsWithExcursions(lots, mockCompute);

    expect(enriched).toHaveLength(1);
    expect(enriched[0].mae).toBeCloseTo(-3.5);
    expect(enriched[0].mfe).toBeCloseTo(12.0);
    // Original fields untouched
    expect(enriched[0].pnl).toBe(10);
    expect(enriched[0].symbol).toBe("TSLA");
  });

  it("leaves lots unchanged when the fetcher returns null", async () => {
    const mockCompute = async () => null;

    const lots: ClosedLot[] = [makeLot()];
    const enriched = await enrichClosedLotsWithExcursions(lots, mockCompute);

    expect(enriched).toHaveLength(1);
    expect(enriched[0].mae).toBeUndefined();
    expect(enriched[0].mfe).toBeUndefined();
  });

  it("skips lots missing required fields (no symbol, no entryPrice, etc.)", async () => {
    const mockCompute = async () => ({ mae: -1, mfe: 5 });

    const incomplete: ClosedLot[] = [
      makeLot({ symbol: undefined }),
      makeLot({ entryPrice: undefined }),
      makeLot({ entryAt: undefined }),
      makeLot({ exitAt: undefined }),
      makeLot({ side: undefined })
    ];
    const enriched = await enrichClosedLotsWithExcursions(incomplete, mockCompute);

    for (const lot of enriched) {
      expect(lot.mae).toBeUndefined();
      expect(lot.mfe).toBeUndefined();
    }
  });

  it("de-duplicates fetcher calls for identical lot keys (cache)", async () => {
    let callCount = 0;
    const mockCompute = async () => {
      callCount++;
      return { mae: -2, mfe: 8 };
    };

    // Two lots with identical symbol/entryAt/exitAt/side → one fetch
    const lots: ClosedLot[] = [makeLot(), makeLot({ thesisTag: "Value" })];
    await enrichClosedLotsWithExcursions(lots, mockCompute);

    expect(callCount).toBe(1);
  });
});

describe("MAE/MFE DB persistence via upsertFillExcursionsByKey", () => {
  it("reads back mae/mfe written to fill_events by exit key", async () => {
    const { insertFillEvent, upsertFillExcursionsByKey, listFillEvents } = await import("../src/lib/db");

    // Insert a buy fill (open)
    insertFillEvent(
      fill({
        id: "mae-buy1",
        side: "buy",
        quantity: 2,
        price: 200,
        notional: 400,
        filledAt: "2026-06-01T00:00:00.000Z"
      })
    );

    // Insert the corresponding sell fill (close)
    insertFillEvent(
      fill({
        id: "mae-sell1",
        side: "sell",
        quantity: 2,
        price: 220,
        notional: 440,
        filledAt: "2026-06-10T00:00:00.000Z"
      })
    );

    // Persist excursions for the exit fill
    upsertFillExcursionsByKey("MAE1", "TSLA", "2026-06-10T00:00:00.000Z", -4.0, 15.0);

    // Read back all fills and find the sell fill
    const fills = listFillEvents("MAE1", "paper");
    const sellFill = fills.find((f) => f.id === "mae-sell1") as (FillEvent & { mae?: number; mfe?: number }) | undefined;
    expect(sellFill).toBeDefined();

    // Directly query the DB for mae/mfe since FillEvent type doesn't carry them yet
    const { getDb } = await import("../src/lib/db");
    const row = getDb()
      .prepare("SELECT mae, mfe FROM fill_events WHERE id = ?")
      .get("mae-sell1") as { mae: number | null; mfe: number | null } | undefined;

    expect(row).toBeDefined();
    expect(row!.mae).toBeCloseTo(-4.0);
    expect(row!.mfe).toBeCloseTo(15.0);
  });

  it("upsertFillExcursions by id also persists correctly", async () => {
    const { insertFillEvent, upsertFillExcursions, getDb } = await import("../src/lib/db");

    insertFillEvent(
      fill({
        id: "mae-byid1",
        side: "sell",
        quantity: 1,
        price: 210,
        notional: 210,
        filledAt: "2026-06-15T00:00:00.000Z"
      })
    );

    upsertFillExcursions("mae-byid1", -2.5, 9.0);

    const row = getDb()
      .prepare("SELECT mae, mfe FROM fill_events WHERE id = ?")
      .get("mae-byid1") as { mae: number | null; mfe: number | null } | undefined;

    expect(row).toBeDefined();
    expect(row!.mae).toBeCloseTo(-2.5);
    expect(row!.mfe).toBeCloseTo(9.0);
  });
});
