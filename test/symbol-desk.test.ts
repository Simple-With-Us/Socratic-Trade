import { describe, expect, it } from "vitest";
import {
  buildSymbolDesk,
  collectPeerHoldings,
  compactExit,
  compactLastCall,
  findHeldLot,
  peerHoldingFromLot,
  signedQuantityToDirection
} from "../src/lib/symbol-desk";
import type { ConnectedAccount, EquityPosition, PendingProposal } from "../src/lib/types";

const stamp = "2026-08-16T00:00:00.000Z";
const ira = {
  id: "ira",
  userId: "u1",
  broker: "alpaca" as const,
  environment: "live" as const,
  label: "Roth IRA",
  accountNumber: "IRA-1",
  isActive: false,
  createdAt: stamp,
  updatedAt: stamp
} as ConnectedAccount;
const brokerage = {
  id: "brk",
  userId: "u1",
  broker: "alpaca" as const,
  environment: "live" as const,
  label: "Brokerage",
  accountNumber: "BRK-1",
  isActive: true,
  createdAt: stamp,
  updatedAt: stamp
} as ConnectedAccount;

function lot(symbol: string, quantity: number): EquityPosition {
  return { symbol, quantity, averageCost: 100, marketValue: quantity * 110 };
}

describe("symbol desk helpers", () => {
  it("maps signed quantity to long/short and ignores flat lots", () => {
    expect(signedQuantityToDirection(12)).toBe("long");
    expect(signedQuantityToDirection(-4)).toBe("short");
    expect(signedQuantityToDirection(0)).toBeUndefined();
  });

  it("finds the held lot by normalized symbol", () => {
    expect(findHeldLot([lot("goog", 3), lot("AAPL", 0)], "GOOG")?.quantity).toBe(3);
    expect(findHeldLot([lot("AAPL", 0)], "AAPL")).toBeUndefined();
  });

  it("peer mention is size + direction only — no cost or P&L", () => {
    const peer = peerHoldingFromLot(ira, lot("NVDA", -8), "2026-08-16T00:00:00.000Z");
    expect(peer).toEqual({
      accountId: "ira",
      label: "Roth IRA",
      environment: "live",
      direction: "short",
      quantity: 8,
      recordedAt: "2026-08-16T00:00:00.000Z"
    });
    expect(JSON.stringify(peer)).not.toMatch(/averageCost|marketValue|100|110/);
  });

  it("skips the current account and accounts with no recorded lot", () => {
    const peers = collectPeerHoldings({
      symbol: "NVDA",
      currentAccountNumber: "BRK-1",
      accounts: [brokerage, ira],
      latestPositions: (accountNumber) =>
        accountNumber === "IRA-1"
          ? { positions: [lot("NVDA", 5)], recordedAt: "2026-08-15T12:00:00.000Z" }
          : { positions: [lot("NVDA", 99)] }
    });
    expect(peers).toHaveLength(1);
    expect(peers[0].accountId).toBe("ira");
    expect(peers[0].quantity).toBe(5);
    expect(peers[0].direction).toBe("long");
  });

  it("compacts exit-contract fields and omits empty default plans", () => {
    expect(compactExit({ style: "default", avgCost: 10 }, undefined)).toBeUndefined();
    expect(
      compactExit(
        {
          style: "trailing",
          avgCost: 100,
          trailPercent: 6,
          stopPrice: 94,
          takeProfitPrice: 130,
          rationale: "trail the trend",
          invalidation: "close below 20-day"
        },
        { band: 1, avgCost: 100 }
      )
    ).toEqual({
      style: "trailing",
      rationale: "trail the trend",
      stopPrice: 94,
      takeProfitPrice: 130,
      trailPercent: 6,
      invalidation: "close below 20-day",
      trimBand: 1
    });
  });

  it("builds a desk payload with pending ideas and peer mention", () => {
    const pending = [
      {
        id: "p1",
        createdAt: "2026-08-16T01:00:00.000Z",
        proposal: {
          symbol: "NVDA",
          side: "buy",
          quantity: 2,
          rationale: "green team: momentum intact",
          tradeThesisTag: "momentum",
          confidenceScore: 72
        }
      }
    ] as unknown as PendingProposal[];
    const desk = buildSymbolDesk({
      symbol: "nvda",
      currentAccountNumber: "BRK-1",
      accounts: [brokerage, ira],
      latestPositions: (n) => (n === "IRA-1" ? { positions: [lot("NVDA", -3)] } : undefined),
      stopPlan: { style: "atr", avgCost: 100, resolvedStopPct: 7.5 },
      pending
    });
    expect(desk.symbol).toBe("NVDA");
    expect(desk.peerAccounts[0]).toMatchObject({ direction: "short", quantity: 3, accountId: "ira" });
    expect(desk.exit).toEqual({ style: "atr", resolvedStopPct: 7.5 });
    expect(desk.pending[0].rationale).toMatch(/green team/);
  });

  it("last call is a clipped Green/Red pair with no evidence dump", () => {
    const last = compactLastCall(
      [
        {
          id: "c1",
          userId: "u1",
          createdAt: stamp,
          updatedAt: stamp,
          symbol: "NVDA",
          side: "buy",
          status: "placed",
          authority: "decide",
          thesis: "momentum",
          rationale: "x".repeat(300),
          greenTeamRationale: "Hold the core; trail.",
          action: "buy",
          evidence: [{ text: "secret evidence" }],
          ragAttributions: [],
          dissent: [],
          redTeamVerdict: { rejected: false, available: true, verdict: "approve", reason: "size ok" },
          outcome: { status: "won", outcomes: [] }
        } as never
      ],
      "NVDA"
    );
    expect(last?.id).toBe("c1");
    expect(last?.green).toBe("Hold the core; trail.");
    expect(last?.red).toMatch(/^Red approve/);
    expect(last?.outcome).toBe("won");
    expect(JSON.stringify(last)).not.toMatch(/secret evidence/);
    expect((last?.green ?? "").length).toBeLessThanOrEqual(200);
  });
});
