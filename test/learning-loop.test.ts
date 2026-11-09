import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { getExcursionsByThesis } from "../src/lib/learning-loop";
import type { FillEvent } from "../src/lib/types";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-learning-${randomUUID()}.db`)}`;
});

function fill(input: Partial<FillEvent> & { id: string; side: "buy" | "sell"; quantity: number; price: number; notional: number; filledAt: string }): FillEvent {
  return {
    proposalId: "p1",
    runId: "r1",
    accountNumber: "EXC1",
    source: "paper",
    symbol: "AAPL",
    status: "filled",
    raw: undefined,
    ...input
  };
}

describe("getExcursionsByThesis", () => {
  it("aggregates MAE/MFE and capture-of-favorable-move per thesis", async () => {
    const { insertFillEvent } = await import("../src/lib/db");
    // +10% winner opened under "Momentum".
    insertFillEvent(
      fill({
        id: "ex-b1",
        side: "buy",
        quantity: 1,
        price: 100,
        notional: 100,
        filledAt: "2026-06-10T00:00:00.000Z",
        raw: { proposal: { tradeThesisTag: "Momentum", entryMarketRegime: "Bull" } }
      })
    );
    insertFillEvent(fill({ id: "ex-s1", side: "sell", quantity: 1, price: 110, notional: 110, filledAt: "2026-06-12T00:00:00.000Z" }));

    // Deterministic fake excursion fetcher: 20% favorable move was available, 5% adverse.
    const compute = async () => ({ mae: -5, mfe: 20 });
    const stats = await getExcursionsByThesis("EXC1", "paper", { compute });

    expect(stats).toHaveLength(1);
    const momentum = stats[0];
    expect(momentum.thesisTag).toBe("Momentum");
    expect(momentum.trades).toBe(1);
    expect(momentum.avgMaePct).toBeCloseTo(-5);
    expect(momentum.avgMfePct).toBeCloseTo(20);
    // Captured 10% of a 20% available move => 50%.
    expect(momentum.capturePct).toBe(50);
  });

  it("returns an empty array when there are no qualifying closed lots", async () => {
    const stats = await getExcursionsByThesis("NO_TRADES", "paper", { compute: async () => ({ mae: -1, mfe: 1 }) });
    expect(stats).toEqual([]);
  });
});
