import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { TradeProposal } from "../src/lib/types";
import { coerceProtectiveExitToMarket } from "../src/lib/strategy-execution";

// A protective Risk-Exit must execute as a MARKET order so it cannot rest unfilled the way the MU
// Risk-Exit limit @ $991 did (never filled as MU fell to -8%, then blocked every re-exit). Other
// exits keep their chosen type.
beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `coerce-exit-${randomUUID()}.db`)}`;
});

const base = (o: Partial<TradeProposal>): TradeProposal => ({
  symbol: "MU",
  side: "sell",
  type: "limit",
  quantity: 1,
  limitPrice: 991,
  timeInForce: "gfd",
  marketHours: "regular_hours",
  rationale: "exit",
  tradeThesisTag: "Risk-Exit",
  confidenceScore: 70,
  entryMarketRegime: "Neutral (Normal Volatility)",
  ...o
});

describe("coerceProtectiveExitToMarket", () => {
  it("routes a Risk-Exit sell LIMIT to a market order (no resting limit that can miss the fill)", () => {
    const out = coerceProtectiveExitToMarket(base({ type: "limit", limitPrice: 991 }));
    expect(out.type).toBe("market");
    expect(out.limitPrice).toBeUndefined();
  });

  it("routes a Risk-Exit stop_limit to market too (clears both prices)", () => {
    const out = coerceProtectiveExitToMarket(base({ type: "stop_limit", limitPrice: 991, stopPrice: 992 }));
    expect(out.type).toBe("market");
    expect(out.limitPrice).toBeUndefined();
    expect(out.stopPrice).toBeUndefined();
  });

  it("leaves a Risk-Exit that is ALREADY a market order unchanged", () => {
    const p = base({ type: "market", limitPrice: undefined });
    expect(coerceProtectiveExitToMarket(p)).toEqual(p);
  });

  it("leaves a NON-Risk-Exit limit sell (e.g. a profit-taking trim) unchanged", () => {
    const out = coerceProtectiveExitToMarket(base({ tradeThesisTag: "Momentum-Breakout", type: "limit", limitPrice: 991 }));
    expect(out.type).toBe("limit");
    expect(out.limitPrice).toBe(991);
  });

  it("leaves a buy proposal unchanged", () => {
    const out = coerceProtectiveExitToMarket(base({ side: "buy", type: "limit", limitPrice: 100, tradeThesisTag: "Risk-Exit" }));
    expect(out.type).toBe("limit");
  });
});
