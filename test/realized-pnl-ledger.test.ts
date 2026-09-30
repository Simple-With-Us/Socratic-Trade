import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { aggregateRoundTrip, calculatePnl, openLotSymbols, unrealizedFromOpenLots, type ClosedLot } from "../src/lib/performance";
import { getTaxSummary } from "../src/lib/tax";
import type { FillEvent, OrderSide } from "../src/lib/types";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-realized-pnl-ledger-${randomUUID()}.db`)}`;
});

const NOW = new Date("2026-06-16T12:00:00.000Z");
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY).toISOString();

function fill(
  input: Partial<FillEvent> & { id: string; side: OrderSide; quantity: number; price: number; filledAt: string }
): FillEvent {
  return {
    proposalId: undefined,
    runId: "r1",
    accountNumber: "LEDGER",
    source: "paper",
    symbol: "AAPL",
    status: "filled",
    notional: input.quantity * input.price,
    brokerOrderId: undefined,
    raw: undefined,
    ...input
  };
}

describe("listFillEvents — the accounting ledger read", () => {
  it("returns the WHOLE ledger by default, past the old 500-row cap", async () => {
    const { insertFillEvent, listFillEvents } = await import("../src/lib/db");
    const account = "LEDGER_UNBOUNDED";
    // 501 rows for one (account, source) — one more than the cap every accounting caller used to pass.
    for (let i = 0; i < 501; i++) {
      insertFillEvent({
        ...fill({
          id: `unbounded-${i}`,
          accountNumber: account,
          side: "buy",
          quantity: 1,
          price: 100,
          filledAt: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString()
        })
      });
    }

    const all = listFillEvents(account, "paper", undefined, "local");
    expect(all).toHaveLength(501);
    // The NEWEST fill must be present — the old ASC+LIMIT 500 read dropped it, silently freezing
    // realized P&L, open lots, tax, win rate and model stats at the pre-cap state.
    expect(all[all.length - 1].id).toBe("unbounded-500");
    expect(all[0].id).toBe("unbounded-0");
  });

  it("returns the NEWEST N (not the oldest) when a caller asks for a display window", async () => {
    const { insertFillEvent, listFillEvents } = await import("../src/lib/db");
    const account = "LEDGER_WINDOW";
    for (let i = 0; i < 40; i++) {
      insertFillEvent({
        ...fill({
          id: `window-${i}`,
          accountNumber: account,
          side: "buy",
          quantity: 1,
          price: 100,
          filledAt: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString()
        })
      });
    }

    // The tuner's "recentFills" window is 30. It must be the LAST 30 trades, not the first 30.
    const recent = listFillEvents(account, "paper", 30, "local");
    expect(recent).toHaveLength(30);
    expect(recent[0].id).toBe("window-10");
    expect(recent[recent.length - 1].id).toBe("window-39");
  });

  it("keeps same-millisecond fills in the order they were booked, windowed or not", async () => {
    const { insertFillEvent, listFillEvents } = await import("../src/lib/db");
    const account = "LEDGER_TIE";
    // One strategy run placing an entry and a partial exit lands both legs on the same timestamp.
    // If the exit replays first the FIFO walk finds no lot to close and the position books at the
    // wrong size — so the read must break the tie on insertion order, in BOTH query shapes.
    const sameMs = daysAgo(1);
    insertFillEvent({ ...fill({ id: "tie-open", accountNumber: account, symbol: "TSLA", side: "short", quantity: 3, price: 100, filledAt: sameMs }) });
    insertFillEvent({ ...fill({ id: "tie-close", accountNumber: account, symbol: "TSLA", side: "cover", quantity: 1, price: 90, filledAt: sameMs }) });

    for (const rows of [listFillEvents(account, "paper", undefined, "local"), listFillEvents(account, "paper", 100, "local")]) {
      expect(rows.map((f) => f.id)).toEqual(["tie-open", "tie-close"]);
      const pnl = calculatePnl(rows, { TSLA: 95 });
      expect(pnl.openLots.find((lot) => lot.symbol === "TSLA")?.quantity).toBeCloseTo(-2); // short 3, covered 1
      expect(pnl.unmatchedClosingFills).toEqual([]);
    }
  });

  it("scopes the unbounded read by source and user like the capped read did", async () => {
    const { insertFillEvent, listFillEvents } = await import("../src/lib/db");
    const account = "LEDGER_SCOPE";
    insertFillEvent({ ...fill({ id: "scope-paper", accountNumber: account, side: "buy", quantity: 1, price: 10, filledAt: daysAgo(3) }) });
    insertFillEvent({ ...fill({ id: "scope-live", accountNumber: account, source: "live", side: "buy", quantity: 1, price: 10, filledAt: daysAgo(2) }) });
    insertFillEvent({
      ...fill({ id: "scope-other-user", accountNumber: account, side: "buy", quantity: 1, price: 10, filledAt: daysAgo(1) }),
      userId: "someone-else"
    });

    expect(listFillEvents(account, "paper", undefined, "local").map((f) => f.id)).toEqual(["scope-paper"]);
    expect(listFillEvents(account, "live", undefined, "local").map((f) => f.id)).toEqual(["scope-live"]);
    expect(listFillEvents(account, undefined, undefined, "local").map((f) => f.id)).toEqual(["scope-paper", "scope-live"]);
    expect(listFillEvents(account, undefined, undefined, "someone-else").map((f) => f.id)).toEqual(["scope-other-user"]);
  });
});

describe("calculatePnl — closing fills with no opening lot", () => {
  it("books an unmatched close instead of dropping it, and keeps it out of realized P&L", () => {
    // A pre-app / manually opened position exiting through the broker: the app never saw the buy.
    const pnl = calculatePnl([
      fill({ id: "orphan-exit", side: "sell", quantity: 5, price: 130, filledAt: daysAgo(2) })
    ]);

    expect(pnl.realized).toBeCloseTo(0); // no cost basis exists — never invent one
    expect(pnl.closedLots).toHaveLength(0);
    expect(pnl.unmatchedClosingFills).toEqual([
      { symbol: "AAPL", side: "sell", quantity: 5, price: 130, filledAt: daysAgo(2) }
    ]);
  });

  it("books only the REMAINDER when a close partially matches a tracked lot", () => {
    const pnl = calculatePnl([
      fill({ id: "open-2", side: "buy", quantity: 2, price: 100, filledAt: daysAgo(5) }),
      fill({ id: "close-5", side: "sell", quantity: 5, price: 110, filledAt: daysAgo(1) })
    ]);

    expect(pnl.realized).toBeCloseTo(20); // 2 shares matched at +$10
    expect(pnl.unmatchedClosingFills).toHaveLength(1);
    expect(pnl.unmatchedClosingFills[0].quantity).toBeCloseTo(3);
  });

  it("reports nothing when the ledger reconciles", () => {
    const pnl = calculatePnl([
      fill({ id: "clean-open", side: "buy", quantity: 2, price: 100, filledAt: daysAgo(5) }),
      fill({ id: "clean-close", side: "sell", quantity: 2, price: 110, filledAt: daysAgo(1) })
    ]);

    expect(pnl.realized).toBeCloseTo(20);
    expect(pnl.unmatchedClosingFills).toEqual([]);
  });
});

describe("aggregateRoundTrip — scaled-out positions", () => {
  const exit = (over: Partial<ClosedLot>): ClosedLot => ({
    pnl: 0,
    returnPct: 0,
    quantity: 1,
    symbol: "AAPL",
    side: "long",
    entryPrice: 100,
    entryAt: daysAgo(10),
    exitAt: daysAgo(1),
    ...over
  });

  it("stays open while only part of the entry has been closed", () => {
    // Sold 3 of 10 shares at a profit — the trade is not over and must not be graded yet.
    const trim = exit({ quantity: 3, pnl: 60, returnPct: 20, exitAt: daysAgo(4) });
    expect(aggregateRoundTrip([trim], 10)).toBeUndefined();
  });

  it("grades the whole round trip, not the first profitable trim", () => {
    // 10 shares in at $100. Two trims of 2 at +$20/share (+$80), then 6 out at -$30/share (-$180).
    const trimA = exit({ quantity: 2, pnl: 40, returnPct: 20, exitAt: daysAgo(6) });
    const trimB = exit({ quantity: 2, pnl: 40, returnPct: 20, exitAt: daysAgo(5) });
    const remainder = exit({ quantity: 6, pnl: -180, returnPct: -30, exitAt: daysAgo(2) });

    const roundTrip = aggregateRoundTrip([trimA, trimB, remainder], 10);
    expect(roundTrip).toBeDefined();
    expect(roundTrip!.pnl).toBeCloseTo(-100); // a LOSS, not the +$40 first trim
    expect(roundTrip!.quantity).toBeCloseTo(10);
    // Capital-weighted: -100 / (100 * 10) = -10%, not the unweighted mean of +20/+20/-30.
    expect(roundTrip!.returnPct).toBeCloseTo(-10);
    expect(roundTrip!.exitAt).toBe(daysAgo(2)); // the exit that finished it
  });

  it("passes a single full exit straight through", () => {
    const only = exit({ quantity: 4, pnl: 80, returnPct: 20 });
    expect(aggregateRoundTrip([only], 4)).toBe(only);
  });

  it("returns undefined when there are no exits", () => {
    expect(aggregateRoundTrip([], 10)).toBeUndefined();
  });
});

describe("unrealizedFromOpenLots — mark-to-market over already-computed open lots", () => {
  it("matches calculatePnl's own unrealized figure for the same prices, without re-running FIFO", () => {
    const fills = [
      fill({ id: "open-long", side: "buy", quantity: 10, price: 100, filledAt: daysAgo(5) }),
      fill({ id: "open-short", symbol: "MSFT", side: "short", quantity: 4, price: 50, filledAt: daysAgo(3) })
    ];
    const prices = { AAPL: 120, MSFT: 45 };
    const withPrices = calculatePnl(fills, prices);
    const withoutPrices = calculatePnl(fills, {});
    // long AAPL: 10*(120-100)=200; short MSFT: 4*(50-45)=20 -> 220
    expect(withPrices.unrealized).toBeCloseTo(220);
    expect(unrealizedFromOpenLots(withoutPrices.openLots, prices)).toBeCloseTo(withPrices.unrealized);
  });

  it("skips a symbol with no price rather than fabricating a $0 mark", () => {
    const fills = [fill({ id: "open", side: "buy", quantity: 10, price: 100, filledAt: daysAgo(5) })];
    const { openLots } = calculatePnl(fills, {});
    expect(unrealizedFromOpenLots(openLots, {})).toBe(0);
    expect(unrealizedFromOpenLots(openLots, { AAPL: 0 })).toBe(0);
    expect(unrealizedFromOpenLots(openLots, { AAPL: 150 })).toBeCloseTo(500);
  });

  it("marks a short as a profit when the price falls and a loss when it rises", () => {
    const fills = [fill({ id: "open-short", symbol: "MSFT", side: "short", quantity: 4, price: 50, filledAt: daysAgo(3) })];
    const { openLots } = calculatePnl(fills, {});
    expect(unrealizedFromOpenLots(openLots, { MSFT: 45 })).toBeCloseTo(20);
    expect(unrealizedFromOpenLots(openLots, { MSFT: 60 })).toBeCloseTo(-40);
  });

  it("openLotSymbols returns each open symbol once across books", () => {
    const live = calculatePnl(
      [
        fill({ id: "a", side: "buy", quantity: 1, price: 10, filledAt: daysAgo(5) }),
        fill({ id: "b", side: "buy", quantity: 1, price: 11, filledAt: daysAgo(4) })
      ],
      {}
    ).openLots;
    const paper = calculatePnl([fill({ id: "c", symbol: "MSFT", side: "buy", quantity: 1, price: 10, filledAt: daysAgo(4) })], {}).openLots;
    expect(openLotSymbols(live, paper).sort()).toEqual(["AAPL", "MSFT"]);
  });
});

describe("tax — covered shorts are realized, and always short-term", () => {
  it("counts a profitable short/cover round trip in short-term realized", async () => {
    const { insertFillEvent } = await import("../src/lib/db");
    const account = "TAX_SHORT_REALIZED";
    // Short @100 20 days ago, cover @80 10 days ago -> +$20 realized on a SHORT lot.
    insertFillEvent({ ...fill({ id: "st-1", accountNumber: account, symbol: "TSLA", side: "short", quantity: 1, price: 100, filledAt: daysAgo(20) }) });
    insertFillEvent({ ...fill({ id: "st-2", accountNumber: account, symbol: "TSLA", side: "cover", quantity: 1, price: 80, filledAt: daysAgo(10) }) });

    const summary = getTaxSummary(account, "paper", {}, undefined, NOW);
    expect(summary.shortTermRealized).toBeCloseTo(20);
    expect(summary.longTermRealized).toBeCloseTo(0);
  });

  it("keeps a >1-year short short-term (the holding period runs from the cover)", async () => {
    const { insertFillEvent } = await import("../src/lib/db");
    const account = "TAX_SHORT_LONG_HELD";
    insertFillEvent({ ...fill({ id: "sl-1", accountNumber: account, symbol: "NVDA", side: "short", quantity: 1, price: 100, filledAt: daysAgo(400) }) });
    insertFillEvent({ ...fill({ id: "sl-2", accountNumber: account, symbol: "NVDA", side: "cover", quantity: 1, price: 70, filledAt: daysAgo(10) }) });

    const summary = getTaxSummary(account, "paper", {}, undefined, NOW);
    expect(summary.shortTermRealized).toBeCloseTo(30);
    expect(summary.longTermRealized).toBeCloseTo(0);
  });

  it("still treats a >1-year LONG as long-term (control)", async () => {
    const { insertFillEvent } = await import("../src/lib/db");
    const account = "TAX_LONG_CONTROL";
    insertFillEvent({ ...fill({ id: "lc-1", accountNumber: account, symbol: "MSFT", side: "buy", quantity: 1, price: 100, filledAt: daysAgo(400) }) });
    insertFillEvent({ ...fill({ id: "lc-2", accountNumber: account, symbol: "MSFT", side: "sell", quantity: 1, price: 130, filledAt: daysAgo(10) }) });

    const summary = getTaxSummary(account, "paper", {}, undefined, NOW);
    expect(summary.longTermRealized).toBeCloseTo(30);
    expect(summary.shortTermRealized).toBeCloseTo(0);
  });
});
