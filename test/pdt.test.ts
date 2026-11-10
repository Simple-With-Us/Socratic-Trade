import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import { evaluateTradeProposal, MARGIN_MINIMUM_EQUITY } from "../src/lib/policy";
import type { AccountCapabilities, OrderSide, Portfolio, TradeProposal, TradingPolicy } from "../src/lib/types";

// Pattern-Day-Trader gate (FINRA Rule 4210). Owner-resolved decisions under test:
//   day-trade   = same-symbol round-trip OPENED and CLOSED on the same NY calendar day
//   lookback    = rolling 5 business days
//   equity      = Portfolio.totalMarketValue
//   threshold   = $25,000
//   action      = BLOCK the opening leg that would enable a 4th day-trade
//   scope       = LIVE/brokerage execution ONLY (Test/paper are never gated)

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-pdt-${randomUUID()}.db`)}`;
});

// asOf = Friday 2026-06-19. The 5-business-day window walks back Fri 6/19 → Mon 6/15 (inclusive).
const AS_OF = new Date("2026-06-19T18:00:00.000Z"); // 2pm EDT Fri

const policy: TradingPolicy = {
  ...DEFAULT_POLICY,
  systemState: "active",
  strategyAuthority: "decide",
  accountNumber: "LIVE1",
  includedIndices: [],
  additionalSymbols: ["AAPL", "MSFT", "NVDA", "TSLA"],
  // Staleness gate pinned off (defaults to 120s since 2026-07-28): these margin-minimum tests pass
  // no marketScan, and a missing quote timestamp blocks openings while the gate is on.
  maxQuoteAgeSec: 0
};

function portfolioWithEquity(equity: number, accountNumber = "LIVE1"): Portfolio {
  return {
    accountNumber,
    totalMarketValue: equity,
    buyingPower: equity,
    equityMarketValue: equity,
    optionMarketValue: 0,
    cash: equity
  };
}

const openingProposal: TradeProposal = {
  symbol: "AAPL",
  side: "buy",
  type: "market",
  dollarAmount: 100,
  timeInForce: "gfd",
  marketHours: "regular_hours",
  rationale: "test",
  tradeThesisTag: "test",
  entryMarketRegime: "test"
};

// Seed N distinct same-day round-trips (one symbol+day each) for an account, each on its own
// market day inside the 5-business-day window. Returns nothing — fills are persisted.
async function seedDayTrades(accountNumber: string, source: "live" | "paper", count: number) {
  const { insertFillEvent } = await import("../src/lib/db");
  // Each entry is a market day (NY) inside the window Mon 6/15 .. Fri 6/19; afternoon EDT timestamps.
  const days = ["2026-06-15", "2026-06-16", "2026-06-17", "2026-06-18", "2026-06-19"];
  const symbols = ["AAPL", "MSFT", "NVDA", "TSLA", "AMD"];
  for (let i = 0; i < count; i += 1) {
    const day = days[i];
    const symbol = symbols[i];
    const open = `${day}T17:00:00.000Z`; // 1pm EDT
    const close = `${day}T18:30:00.000Z`; // 2:30pm EDT, same NY day
    insertFillEvent({
      id: `${accountNumber}-${symbol}-open`,
      accountNumber,
      source,
      symbol,
      side: "buy" as OrderSide,
      quantity: 1,
      price: 100,
      notional: 100,
      status: "filled",
      filledAt: open
    });
    insertFillEvent({
      id: `${accountNumber}-${symbol}-close`,
      accountNumber,
      source,
      symbol,
      side: "sell" as OrderSide,
      quantity: 1,
      price: 110,
      notional: 110,
      status: "filled",
      filledAt: close
    });
  }
}

describe("countDayTradesInLastBusinessDays", () => {
  it("counts a same-day round-trip per symbol+day and excludes orphan legs", async () => {
    const { insertFillEvent, countDayTradesInLastBusinessDays } = await import("../src/lib/db");
    const account = "COUNT1";
    // Two qualifying round-trips on two business days (buy+sell same NY day each).
    insertFillEvent({ id: "c1o", accountNumber: account, source: "live", symbol: "AAPL", side: "buy", quantity: 1, price: 100, notional: 100, status: "filled", filledAt: "2026-06-16T17:00:00.000Z" });
    insertFillEvent({ id: "c1c", accountNumber: account, source: "live", symbol: "AAPL", side: "sell", quantity: 1, price: 105, notional: 105, status: "filled", filledAt: "2026-06-16T18:00:00.000Z" });
    insertFillEvent({ id: "c2o", accountNumber: account, source: "live", symbol: "MSFT", side: "buy", quantity: 1, price: 200, notional: 200, status: "filled", filledAt: "2026-06-17T17:00:00.000Z" });
    insertFillEvent({ id: "c2c", accountNumber: account, source: "live", symbol: "MSFT", side: "sell", quantity: 1, price: 210, notional: 210, status: "filled", filledAt: "2026-06-17T18:00:00.000Z" });
    // Orphan: an open with no same-day close → NOT a day-trade.
    insertFillEvent({ id: "c3o", accountNumber: account, source: "live", symbol: "NVDA", side: "buy", quantity: 1, price: 50, notional: 50, status: "filled", filledAt: "2026-06-18T17:00:00.000Z" });
    // Different calendar days for the same symbol → buy on one day, sell on the next → NOT a day-trade.
    insertFillEvent({ id: "c4o", accountNumber: account, source: "live", symbol: "TSLA", side: "buy", quantity: 1, price: 60, notional: 60, status: "filled", filledAt: "2026-06-15T18:00:00.000Z" });
    insertFillEvent({ id: "c4c", accountNumber: account, source: "live", symbol: "TSLA", side: "sell", quantity: 1, price: 65, notional: 65, status: "filled", filledAt: "2026-06-16T15:00:00.000Z" });

    expect(countDayTradesInLastBusinessDays(account, 5, AS_OF)).toBe(2);
  });

  it("counts a short→cover same-day round-trip and respects the rolling window edge", async () => {
    const { insertFillEvent, countDayTradesInLastBusinessDays } = await import("../src/lib/db");
    const account = "COUNT2";
    // short→cover same NY day inside the window → a day-trade.
    insertFillEvent({ id: "s1o", accountNumber: account, source: "live", symbol: "AAPL", side: "short", quantity: 1, price: 100, notional: 100, status: "filled", filledAt: "2026-06-17T17:00:00.000Z" });
    insertFillEvent({ id: "s1c", accountNumber: account, source: "live", symbol: "AAPL", side: "cover", quantity: 1, price: 95, notional: 95, status: "filled", filledAt: "2026-06-17T18:00:00.000Z" });
    // A round-trip on Fri 6/12 — one business day BEFORE the window start (Mon 6/15) → excluded.
    insertFillEvent({ id: "s2o", accountNumber: account, source: "live", symbol: "MSFT", side: "buy", quantity: 1, price: 200, notional: 200, status: "filled", filledAt: "2026-06-12T17:00:00.000Z" });
    insertFillEvent({ id: "s2c", accountNumber: account, source: "live", symbol: "MSFT", side: "sell", quantity: 1, price: 205, notional: 205, status: "filled", filledAt: "2026-06-12T18:00:00.000Z" });

    expect(countDayTradesInLastBusinessDays(account, 5, AS_OF)).toBe(1);
  });
});

describe("evaluateTradeProposal — margin-minimum gate (PDT rule retired, FINRA Notice 26-10)", () => {
  // The Pattern-Day-Trader rule ($25k minimum + 4-day-trades-in-5-days) was retired by SEC/FINRA.
  // The replacement is broker-side real-time intraday margin + a $2,000 minimum for MARGIN accounts.
  // The gate now enforces ONLY that static minimum, on LIVE margin accounts, for opening legs.
  const caps = (marginEnabled: boolean): AccountCapabilities => ({
    equityTrading: true,
    shortSelling: false,
    optionsTrading: false,
    futuresTrading: false,
    cryptoTrading: false,
    marginEnabled,
    accountType: "brokerage"
  });

  function evaluate(opts: {
    equity: number;
    isLiveExecution?: boolean;
    marginEnabled?: boolean;
    proposal?: TradeProposal;
    accountNumber?: string;
  }) {
    return evaluateTradeProposal(opts.proposal ?? openingProposal, {
      policy: { ...policy, accountNumber: opts.accountNumber ?? "LIVE1" },
      portfolio: portfolioWithEquity(opts.equity, opts.accountNumber ?? "LIVE1"),
      positions: [],
      dailyNotionalUsed: 0,
      dailyOrderCount: 0,
      estimatedNotional: 100,
      isLiveExecution: opts.isLiveExecution,
      accountCapabilities: opts.marginEnabled === undefined ? undefined : caps(opts.marginEnabled)
    });
  }

  it("BLOCKS a LIVE margin opening order below the $2,000 minimum", () => {
    const decision = evaluate({ equity: MARGIN_MINIMUM_EQUITY - 1, isLiveExecution: true, marginEnabled: true });
    expect(decision.approved).toBe(false);
    expect(decision.reasons.some((r) => r.includes("margin_minimum"))).toBe(true);
  });

  it("does NOT block at or above the $2,000 minimum", () => {
    expect(evaluate({ equity: MARGIN_MINIMUM_EQUITY, isLiveExecution: true, marginEnabled: true }).reasons.some((r) => r.includes("margin_minimum"))).toBe(false);
    const ample = evaluate({ equity: 50_000, isLiveExecution: true, marginEnabled: true });
    expect(ample.reasons.some((r) => r.includes("margin_minimum"))).toBe(false);
    expect(ample.approved).toBe(true);
  });

  it("does NOT block a CASH (non-margin) account below $2,000", () => {
    const decision = evaluate({ equity: 1000, isLiveExecution: true, marginEnabled: false });
    expect(decision.reasons.some((r) => r.includes("margin_minimum"))).toBe(false);
  });

  it("BLOCKS a paper/Test margin account below $2,000 only when margin is on (uniform gate, no paper exemption)", () => {
    // Below $2K + margin → blocked (the paper exemption was removed 2026-07-23).
    expect(evaluate({ equity: 100, isLiveExecution: false, marginEnabled: true }).reasons.some((r) => r.includes("margin_minimum"))).toBe(true);
    // Below $2K + margin but isLiveExecution undefined → still blocked (the gate no longer gates on isLiveExecution).
    expect(evaluate({ equity: 100, isLiveExecution: undefined, marginEnabled: true }).reasons.some((r) => r.includes("margin_minimum"))).toBe(true);
    // Below $2K + CASH (margin off) → not blocked (cash accounts are never subject to margin minimum).
    expect(evaluate({ equity: 100, isLiveExecution: false, marginEnabled: false }).reasons.some((r) => r.includes("margin_minimum"))).toBe(false);
    // Above $2K + margin → not blocked.
    const paperHigh = evaluate({ equity: 100_000, isLiveExecution: false, marginEnabled: true });
    expect(paperHigh.reasons.some((r) => r.includes("margin_minimum"))).toBe(false);
    expect(paperHigh.approved).toBe(true);
  });

  it("never blocks a CLOSING order (sell) on the margin minimum", () => {
    const sell: TradeProposal = { ...openingProposal, symbol: "AAPL", side: "sell", dollarAmount: undefined, quantity: 1 };
    const decision = evaluate({ equity: 100, isLiveExecution: true, marginEnabled: true, proposal: sell });
    expect(decision.reasons.some((r) => r.includes("margin_minimum"))).toBe(false);
  });
});
