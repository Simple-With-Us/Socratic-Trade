import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Real unrealized P&L in GET /api/ops/performance (lane h4).  Before this every account reported
 * `pricesUnavailable: true` with unrealized hardcoded to 0, so ~$100K of paper equity in open
 * positions read as flat.  These tests pin the behaviour AND the bounds: the quote fetch must be
 * abortable, budgeted, memoised across accounts, and must never fail the request.
 */

const cascade = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("../src/lib/quotes-cascade", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/quotes-cascade")>();
  return { ...actual, fetchFreshQuotesCascade: cascade.fn };
});

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `ops-perf-unrealized-${randomUUID()}.db`)}`;
});

beforeEach(() => {
  cascade.fn.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

type Mark = number | null;
const quotesFor = (marks: Record<string, Mark>) => async (symbols: string[]) => {
  const out: Record<string, { symbol: string; price?: number }> = {};
  for (const symbol of symbols) {
    const mark = marks[symbol];
    if (mark !== undefined) out[symbol] = { symbol, ...(mark === null ? {} : { price: mark }) };
  }
  return out;
};

async function seedAccount(
  positions: Array<{ symbol: string; side: "buy" | "short"; quantity: number; price: number }>,
  opts: { userId?: string; label?: string } = {}
) {
  const db = await import("../src/lib/db");
  const userId = opts.userId ?? `unreal-user-${randomUUID()}`;
  const accountId = `unreal-acct-${randomUUID()}`;
  const accountNumber = `UN-${randomUUID()}`;
  db.upsertConnectedAccount({ id: accountId, userId, broker: "alpaca", environment: "paper", accountNumber, label: opts.label ?? "Unrealized", isActive: true });
  db.setPolicy({ ...db.getPolicy(userId, accountId), systemState: "active", strategyAuthority: "decide" }, userId, accountId);
  const filledAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
  for (const p of positions) {
    db.insertFillEvent({
      accountNumber,
      source: "paper",
      symbol: p.symbol,
      side: p.side,
      quantity: p.quantity,
      price: p.price,
      notional: p.quantity * p.price,
      status: "filled",
      userId,
      filledAt
    });
  }
  return { userId, accountId, accountNumber };
}

async function build(input: Record<string, unknown>) {
  const { buildOpsPerformanceSnapshot } = await import("../src/lib/ops-performance");
  return buildOpsPerformanceSnapshot(input);
}

describe("ops performance — unrealized P&L from real marks", () => {
  it("marks open longs and shorts and reports them as priced", async () => {
    const { accountId } = await seedAccount([
      { symbol: "UAAA", side: "buy", quantity: 10, price: 100 },
      { symbol: "UBBB", side: "short", quantity: 4, price: 50 }
    ]);
    cascade.fn.mockImplementation(quotesFor({ UAAA: 120, UBBB: 45 }));

    const account = (await build({ connectedAccountId: accountId, days: 30 })).accounts[0];

    expect(account.error).toBeUndefined();
    // long 10 * (120 - 100) = 200; short 4 * (50 - 45) = 20
    expect(account.paperUnrealizedPnl).toBeCloseTo(220, 2);
    expect(account.liveUnrealizedPnl).toBe(0);
    expect(account.pricesUnavailable).toBe(false);
    expect(account.unrealizedUnpricedSymbols).toEqual([]);
    // The dashboard's own cascade, never the account's own broker a second time.
    expect(cascade.fn).toHaveBeenCalledTimes(1);
    const [symbols, userId, , connectedAccountId, options] = cascade.fn.mock.calls[0];
    expect([...symbols].sort()).toEqual(["UAAA", "UBBB"]);
    expect(typeof userId).toBe("string");
    expect(connectedAccountId).toBe(accountId);
    expect(options).toMatchObject({ skipActiveBroker: true });
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("prices what it can, lists the rest, and never fabricates a $0 mark", async () => {
    const { accountId } = await seedAccount([
      { symbol: "UCCC", side: "buy", quantity: 10, price: 100 },
      { symbol: "UDDD", side: "buy", quantity: 10, price: 100 },
      { symbol: "UEEE", side: "buy", quantity: 10, price: 100 }
    ]);
    // UCCC priced, UDDD returned with no price, UEEE not returned at all.
    cascade.fn.mockImplementation(quotesFor({ UCCC: 110, UDDD: null }));

    const account = (await build({ connectedAccountId: accountId, days: 30 })).accounts[0];

    expect(account.paperUnrealizedPnl).toBeCloseTo(100, 2); // only UCCC: 10 * (110 - 100)
    expect(account.pricesUnavailable).toBe(false); // partial coverage is not "unavailable"...
    expect(account.unrealizedUnpricedSymbols).toEqual(["UDDD", "UEEE"]); // ...but it is disclosed
  });

  it("reports pricesUnavailable when nothing could be priced, and still returns the account", async () => {
    const { accountId } = await seedAccount([{ symbol: "UFFF", side: "buy", quantity: 10, price: 100 }]);
    cascade.fn.mockRejectedValue(new Error("every quote tier down"));

    const account = (await build({ connectedAccountId: accountId, days: 30 })).accounts[0];

    expect(account.error).toBeUndefined();
    expect(account.paperUnrealizedPnl).toBe(0);
    expect(account.pricesUnavailable).toBe(true);
    expect(account.unrealizedUnpricedSymbols).toEqual(["UFFF"]);
    expect(account.paperRealizedPnl).toBe(0); // realized side of the account is unaffected
  });

  it("ignores a non-positive quote instead of marking the position at zero", async () => {
    const { accountId } = await seedAccount([{ symbol: "UGGG", side: "buy", quantity: 10, price: 100 }]);
    cascade.fn.mockImplementation(quotesFor({ UGGG: 0 }));

    const account = (await build({ connectedAccountId: accountId, days: 30 })).accounts[0];

    expect(account.paperUnrealizedPnl).toBe(0);
    expect(account.pricesUnavailable).toBe(true);
    expect(account.unrealizedUnpricedSymbols).toEqual(["UGGG"]);
  });

  it("makes no quote call for an account with no open positions", async () => {
    const { accountId } = await seedAccount([]);
    const account = (await build({ connectedAccountId: accountId, days: 30 })).accounts[0];

    expect(cascade.fn).not.toHaveBeenCalled();
    expect(account.pricesUnavailable).toBe(false);
    expect(account.unrealizedUnpricedSymbols).toEqual([]);
  });

  it("includeMarks:false skips every quote call and reports the positions unpriced", async () => {
    const { accountId } = await seedAccount([{ symbol: "UHHH", side: "buy", quantity: 10, price: 100 }]);
    cascade.fn.mockImplementation(quotesFor({ UHHH: 999 }));

    const account = (await build({ connectedAccountId: accountId, days: 30, includeMarks: false })).accounts[0];

    expect(cascade.fn).not.toHaveBeenCalled();
    expect(account.paperUnrealizedPnl).toBe(0);
    expect(account.pricesUnavailable).toBe(true);
    expect(account.unrealizedUnpricedSymbols).toEqual(["UHHH"]);
  });

  it("quotes a ticker held in several accounts once per build", async () => {
    const userId = `unreal-shared-${randomUUID()}`;
    await seedAccount([{ symbol: "USHR", side: "buy", quantity: 10, price: 100 }], { userId, label: "One" });
    await seedAccount([{ symbol: "USHR", side: "buy", quantity: 20, price: 100 }], { userId, label: "Two" });
    cascade.fn.mockImplementation(quotesFor({ USHR: 110 }));

    const snapshot = await build({ days: 30 });
    const mine = snapshot.accounts.filter((a) => a.userId === userId);

    expect(mine).toHaveLength(2);
    expect(mine.map((a) => a.paperUnrealizedPnl).sort((a, b) => a - b)).toEqual([100, 200]);
    // Both accounts priced, but the cascade was only asked for USHR once.
    const askedForShr = cascade.fn.mock.calls.filter(([symbols]) => (symbols as string[]).includes("USHR"));
    expect(askedForShr).toHaveLength(1);
  });

  it("caps the symbols quoted for one account and reports the overflow as unpriced", async () => {
    const positions = Array.from({ length: 105 }, (_, i) => ({
      symbol: `UCAP${String(i).padStart(3, "0")}`,
      side: "buy" as const,
      quantity: 1,
      price: 10
    }));
    const { accountId } = await seedAccount(positions);
    cascade.fn.mockImplementation(async (symbols: string[]) => quotesFor(Object.fromEntries(symbols.map((s) => [s, 11])))(symbols));

    const account = (await build({ connectedAccountId: accountId, days: 30 })).accounts[0];

    expect((cascade.fn.mock.calls[0][0] as string[]).length).toBe(100);
    expect(account.unrealizedUnpricedSymbols).toHaveLength(5);
    expect(account.paperUnrealizedPnl).toBeCloseTo(100, 2); // 100 priced positions x $1
    expect(account.pricesUnavailable).toBe(false);
  });
});

describe("ops performance — the quote fetch is bounded", () => {
  it("aborts a hung cascade at the per-account timeout instead of stalling the request", async () => {
    const { accountId } = await seedAccount([{ symbol: "UHNG", side: "buy", quantity: 10, price: 100 }]);
    let seenSignal: AbortSignal | undefined;
    cascade.fn.mockImplementation((_symbols: string[], _u: string, _a: string, _c: string, options: { signal: AbortSignal }) => {
      seenSignal = options.signal;
      return new Promise(() => undefined); // never settles
    });

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const pending = build({ connectedAccountId: accountId, days: 30 });
    let done = false;
    void pending.then(() => {
      done = true;
    });
    for (let i = 0; i < 40 && !done; i += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const account = (await pending).accounts[0];

    expect(done).toBe(true);
    expect(seenSignal?.aborted).toBe(true); // a real abort, not just a dropped race
    expect(account.error).toBeUndefined();
    expect(account.pricesUnavailable).toBe(true);
    expect(account.unrealizedUnpricedSymbols).toEqual(["UHNG"]);
  });

  it("stops quoting once the request-level budget is spent", async () => {
    // Four accounts that each hang: 8s + 8s + the 4s left of the 20s budget, then nothing.
    const userId = `unreal-budget-${randomUUID()}`;
    for (let i = 0; i < 4; i += 1) {
      await seedAccount([{ symbol: `UBUD${i}`, side: "buy", quantity: 1, price: 10 }], { userId, label: `Budget ${i}` });
    }
    cascade.fn.mockImplementation(() => new Promise(() => undefined));

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const pending = build({ days: 30 });
    let done = false;
    void pending.then(() => {
      done = true;
    });
    for (let i = 0; i < 80 && !done; i += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const snapshot = await pending;
    const mine = snapshot.accounts.filter((a) => a.userId === userId);

    expect(mine).toHaveLength(4);
    // The fourth account was never even attempted: the budget was already gone.
    const budgetCalls = cascade.fn.mock.calls.filter(([symbols]) => (symbols as string[]).some((s) => s.startsWith("UBUD")));
    expect(budgetCalls).toHaveLength(3);
    expect(mine.every((a) => a.pricesUnavailable && a.unrealizedUnpricedSymbols.length === 1)).toBe(true);
  });

  it("route: marks=0 reaches the builder as includeMarks:false and keys the cache separately", async () => {
    process.env.OPS_DIAGNOSTIC_TOKEN = "test-ops-token";
    const { accountId } = await seedAccount([{ symbol: "URTE", side: "buy", quantity: 10, price: 100 }]);
    cascade.fn.mockImplementation(quotesFor({ URTE: 150 }));
    const { resetOpsPerformanceCacheForTests } = await import("../src/lib/ops-performance");
    resetOpsPerformanceCacheForTests();
    const { GET } = await import("../app/api/ops/performance/route");
    const call = (query: string) =>
      GET(new Request(`http://localhost/api/ops/performance?account=${accountId}${query}`, { headers: { "x-ops-token": "test-ops-token" } }));

    const cheap = await (await call("&marks=0")).json();
    expect(cascade.fn).not.toHaveBeenCalled();
    expect(cheap.accounts[0].paperUnrealizedPnl).toBe(0);
    expect(cheap.accounts[0].pricesUnavailable).toBe(true);

    // Same account and window, marks on: must NOT be served the cheap cached answer.
    const priced = await (await call("")).json();
    expect(cascade.fn).toHaveBeenCalledTimes(1);
    expect(priced.accounts[0].paperUnrealizedPnl).toBeCloseTo(500, 2);
    expect(priced.accounts[0].pricesUnavailable).toBe(false);

    delete process.env.OPS_DIAGNOSTIC_TOKEN;
    resetOpsPerformanceCacheForTests();
  });
});
