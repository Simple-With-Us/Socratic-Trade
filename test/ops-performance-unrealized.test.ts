import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Real unrealized P&L in GET /api/ops/performance (lane h4).  Before this every account reported
 * `pricesUnavailable: true` with unrealized hardcoded to 0, so ~$100K of paper equity in open
 * positions read as flat.  The first cut marked through the trading quote cascade; review found
 * that too heavy for a diagnostic GET (after-hours Finnhub/Tiingo/Yahoo/ROIC walk, all gathered
 * prices dropped on timeout, policy rows seeded through getPolicy, other-broker history fan-out).
 * These tests pin the replacement: the DEFAULT reads stored latest-price rows with no network and
 * no policy read; `marks=live` adds ONE bounded Alpaca snapshot batch and keeps the stored marks on
 * a timeout; `marks=off` skips marking; the trading cascade is never called.
 */

const cascade = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("../src/lib/quotes-cascade", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/quotes-cascade")>();
  return { ...actual, fetchFreshQuotesCascade: cascade.fn };
});

const alpaca = vi.hoisted(() => ({ enrich: vi.fn() }));
vi.mock("../src/lib/data-providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/data-providers")>();
  class FakeAlpacaSnapshotEnrichmentProvider {
    readonly name = "alpaca-snapshot";
    readonly configured = true;
    enrich(symbols: string[]) {
      return alpaca.enrich(symbols);
    }
  }
  return { ...actual, AlpacaSnapshotEnrichmentProvider: FakeAlpacaSnapshotEnrichmentProvider };
});

const ALPACA_ENV = [
  "ALPACA_LIVE_API_KEY",
  "ALPACA_LIVE_SECRET_KEY",
  "APCA_API_KEY_ID",
  "APCA_API_SECRET_KEY",
  "ALPACA_API_KEY",
  "ALPACA_SECRET_KEY",
  "ALPACA_PAPER_API_KEY",
  "ALPACA_PAPER_SECRET_KEY"
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `ops-perf-unrealized-${randomUUID()}.db`)}`;
  // Load the heavy modules once up front so no single test pays the cold-import cost.
  await import("../src/lib/ops-performance");
}, 300_000);

beforeEach(() => {
  cascade.fn.mockReset();
  cascade.fn.mockRejectedValue(new Error("the trading quote cascade must never run for an ops read"));
  alpaca.enrich.mockReset();
  for (const key of ALPACA_ENV) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  vi.useRealTimers();
  for (const key of ALPACA_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function withAlpacaCredentials(): void {
  process.env.ALPACA_LIVE_API_KEY = "test-live-key";
  process.env.ALPACA_LIVE_SECRET_KEY = "test-live-secret";
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Write stored latest-price rows (the store the dashboard and every quote refresh keep warm). */
async function seedStoredPrices(prices: Record<string, number>, ageMs = HOUR_MS): Promise<string> {
  const { upsertSymbolFieldLatest } = await import("../src/lib/db-fundamentals");
  const asOf = new Date(Date.now() - ageMs).toISOString();
  upsertSymbolFieldLatest(
    Object.entries(prices).map(([symbol, price]) => ({
      symbol,
      field: "price",
      valueJson: JSON.stringify(price),
      source: "test-feed",
      asOf,
      fetchedAt: asOf
    }))
  );
  return asOf;
}

/** What `provider.enrich` resolves for the live path: symbol -> enrichment with a price. */
const snapshotFor = (prices: Record<string, number | null>) => async (symbols: string[]) => {
  const out: Record<string, { price?: number }> = {};
  for (const symbol of symbols) {
    const price = prices[symbol];
    out[symbol] = price === undefined || price === null ? {} : { price };
  }
  return out;
};

async function seedAccount(
  positions: Array<{ symbol: string; side: "buy" | "short"; quantity: number; price: number }>,
  opts: { userId?: string; label?: string; seedPolicy?: boolean } = {}
) {
  const db = await import("../src/lib/db");
  const userId = opts.userId ?? `unreal-user-${randomUUID()}`;
  const accountId = `unreal-acct-${randomUUID()}`;
  const accountNumber = `UN-${randomUUID()}`;
  db.upsertConnectedAccount({ id: accountId, userId, broker: "alpaca", environment: "paper", accountNumber, label: opts.label ?? "Unrealized", isActive: true });
  if (opts.seedPolicy !== false) {
    db.setPolicy({ ...db.getPolicy(userId, accountId), systemState: "active", strategyAuthority: "decide" }, userId, accountId);
  }
  const filledAt = new Date(Date.now() - 5 * DAY_MS).toISOString();
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

async function strategyStateRows(accountId: string): Promise<number> {
  const { getDb } = await import("../src/lib/db");
  const row = getDb().prepare("SELECT COUNT(*) AS n FROM account_strategy_state WHERE connected_account_id = ?").get(accountId) as { n: number };
  return row.n;
}

describe("ops performance - stored marks (the default)", () => {
  it("marks open longs and shorts from stored prices with no network, no cascade, no live fetch", async () => {
    await seedStoredPrices({ UAAA: 120, UBBB: 45 });
    const { accountId } = await seedAccount([
      { symbol: "UAAA", side: "buy", quantity: 10, price: 100 },
      { symbol: "UBBB", side: "short", quantity: 4, price: 50 }
    ]);
    const fetchSpy = vi.fn(async () => {
      throw new Error("no network for a default ops read");
    });
    vi.stubGlobal("fetch", fetchSpy);

    const account = (await build({ connectedAccountId: accountId, days: 30 })).accounts[0];
    vi.unstubAllGlobals();

    expect(account.error).toBeUndefined();
    // long 10 * (120 - 100) = 200; short 4 * (50 - 45) = 20
    expect(account.paperUnrealizedPnl).toBeCloseTo(220, 2);
    expect(account.liveUnrealizedPnl).toBe(0);
    expect(account.pricesUnavailable).toBe(false);
    expect(account.unrealizedUnpricedSymbols).toEqual([]);
    expect(account.unrealizedMarkBasis).toBe("stored");
    expect(cascade.fn).not.toHaveBeenCalled();
    expect(alpaca.enrich).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports the age of the figure: the oldest as_of among the marks in use", async () => {
    const older = await seedStoredPrices({ UOLD: 110 }, 3 * DAY_MS);
    await seedStoredPrices({ UNEW: 110 }, 2 * HOUR_MS);
    const { accountId } = await seedAccount([
      { symbol: "UOLD", side: "buy", quantity: 1, price: 100 },
      { symbol: "UNEW", side: "buy", quantity: 1, price: 100 }
    ]);

    const account = (await build({ connectedAccountId: accountId, days: 30 })).accounts[0];

    expect(account.unrealizedMarksOldestAsOf).toBe(older);
  });

  it("never seeds a policy row: a read-only diagnostic must not write account_strategy_state", async () => {
    await seedStoredPrices({ UPOL: 110 });
    const { accountId } = await seedAccount([{ symbol: "UPOL", side: "buy", quantity: 1, price: 100 }], { seedPolicy: false });
    expect(await strategyStateRows(accountId)).toBe(0);

    for (const marks of ["stored", "live", "off"] as const) {
      withAlpacaCredentials();
      alpaca.enrich.mockImplementation(snapshotFor({ UPOL: 111 }));
      await build({ connectedAccountId: accountId, days: 30, marks });
    }

    expect(await strategyStateRows(accountId)).toBe(0);
  });

  it("prices what it can, lists the rest, and never fabricates a $0 mark", async () => {
    await seedStoredPrices({ UCCC: 110 });
    const { accountId } = await seedAccount([
      { symbol: "UCCC", side: "buy", quantity: 10, price: 100 },
      { symbol: "UDDD", side: "buy", quantity: 10, price: 100 },
      { symbol: "UEEE", side: "buy", quantity: 10, price: 100 }
    ]);

    const account = (await build({ connectedAccountId: accountId, days: 30 })).accounts[0];

    expect(account.paperUnrealizedPnl).toBeCloseTo(100, 2); // only UCCC: 10 * (110 - 100)
    expect(account.pricesUnavailable).toBe(false); // partial coverage is not "unavailable"...
    expect(account.unrealizedUnpricedSymbols).toEqual(["UDDD", "UEEE"]); // ...but it is disclosed
  });

  it("treats a stored price older than the cutoff as unpriced instead of marking off a stale print", async () => {
    await seedStoredPrices({ USTL: 150 }, 30 * DAY_MS);
    const { accountId } = await seedAccount([{ symbol: "USTL", side: "buy", quantity: 10, price: 100 }]);

    const account = (await build({ connectedAccountId: accountId, days: 30 })).accounts[0];

    expect(account.paperUnrealizedPnl).toBe(0);
    expect(account.pricesUnavailable).toBe(true);
    expect(account.unrealizedUnpricedSymbols).toEqual(["USTL"]);
    expect(account.unrealizedMarksOldestAsOf).toBeNull();
  });

  it("reports pricesUnavailable when nothing is stored, and still returns the account", async () => {
    const { accountId } = await seedAccount([{ symbol: "UFFF", side: "buy", quantity: 10, price: 100 }]);

    const account = (await build({ connectedAccountId: accountId, days: 30 })).accounts[0];

    expect(account.error).toBeUndefined();
    expect(account.paperUnrealizedPnl).toBe(0);
    expect(account.pricesUnavailable).toBe(true);
    expect(account.unrealizedUnpricedSymbols).toEqual(["UFFF"]);
    expect(account.paperRealizedPnl).toBe(0); // realized side of the account is unaffected
  });

  it("ignores a non-positive stored price instead of marking the position at zero", async () => {
    await seedStoredPrices({ UGGG: 0 });
    const { accountId } = await seedAccount([{ symbol: "UGGG", side: "buy", quantity: 10, price: 100 }]);

    const account = (await build({ connectedAccountId: accountId, days: 30 })).accounts[0];

    expect(account.paperUnrealizedPnl).toBe(0);
    expect(account.pricesUnavailable).toBe(true);
    expect(account.unrealizedUnpricedSymbols).toEqual(["UGGG"]);
  });

  it("caps the symbols marked for one account and reports the overflow as unpriced", async () => {
    const symbols = Array.from({ length: 205 }, (_, i) => `UCAP${String(i).padStart(3, "0")}`);
    await seedStoredPrices(Object.fromEntries(symbols.map((s) => [s, 11])));
    const { accountId } = await seedAccount(symbols.map((symbol) => ({ symbol, side: "buy" as const, quantity: 1, price: 10 })));

    const account = (await build({ connectedAccountId: accountId, days: 30 })).accounts[0];

    expect(account.unrealizedUnpricedSymbols).toHaveLength(5);
    expect(account.paperUnrealizedPnl).toBeCloseTo(200, 2); // 200 priced positions x $1
    expect(account.pricesUnavailable).toBe(false);
  });

  it("makes no lookup for an account with no open positions", async () => {
    const { accountId } = await seedAccount([]);
    const account = (await build({ connectedAccountId: accountId, days: 30 })).accounts[0];

    expect(account.pricesUnavailable).toBe(false);
    expect(account.unrealizedUnpricedSymbols).toEqual([]);
    expect(account.unrealizedMarksOldestAsOf).toBeNull();
  });

  it("marks:off skips marking even when stored prices exist and reports the positions unpriced", async () => {
    await seedStoredPrices({ UHHH: 999 });
    const { accountId } = await seedAccount([{ symbol: "UHHH", side: "buy", quantity: 10, price: 100 }]);

    const account = (await build({ connectedAccountId: accountId, days: 30, marks: "off" })).accounts[0];

    expect(account.paperUnrealizedPnl).toBe(0);
    expect(account.pricesUnavailable).toBe(true);
    expect(account.unrealizedUnpricedSymbols).toEqual(["UHHH"]);
    expect(account.unrealizedMarkBasis).toBe("off");
  });
});

describe("ops performance - marks=live is one bounded Alpaca snapshot batch", () => {
  it("upgrades a stored mark from the live snapshot and never calls the trading cascade", async () => {
    await seedStoredPrices({ ULIV: 100 });
    withAlpacaCredentials();
    alpaca.enrich.mockImplementation(snapshotFor({ ULIV: 130 }));
    const { accountId } = await seedAccount([{ symbol: "ULIV", side: "buy", quantity: 10, price: 100 }]);

    const account = (await build({ connectedAccountId: accountId, days: 30, marks: "live" })).accounts[0];

    expect(account.paperUnrealizedPnl).toBeCloseTo(300, 2); // live 130, not stored 100
    expect(account.unrealizedMarkBasis).toBe("live");
    expect(alpaca.enrich).toHaveBeenCalledTimes(1);
    expect(cascade.fn).not.toHaveBeenCalled();
  });

  it("falls back to the stored mark for a symbol the snapshot could not price", async () => {
    await seedStoredPrices({ UFBK: 110 });
    withAlpacaCredentials();
    alpaca.enrich.mockImplementation(snapshotFor({ UFBK: null }));
    const { accountId } = await seedAccount([{ symbol: "UFBK", side: "buy", quantity: 10, price: 100 }]);

    const account = (await build({ connectedAccountId: accountId, days: 30, marks: "live" })).accounts[0];

    expect(account.paperUnrealizedPnl).toBeCloseTo(100, 2);
    expect(account.unrealizedUnpricedSymbols).toEqual([]);
  });

  it("keeps the stored marks when the live fetch throws", async () => {
    await seedStoredPrices({ UERR: 110 });
    withAlpacaCredentials();
    alpaca.enrich.mockRejectedValue(new Error("snapshot provider down"));
    const { accountId } = await seedAccount([{ symbol: "UERR", side: "buy", quantity: 10, price: 100 }]);

    const account = (await build({ connectedAccountId: accountId, days: 30, marks: "live" })).accounts[0];

    expect(account.error).toBeUndefined();
    expect(account.paperUnrealizedPnl).toBeCloseTo(100, 2);
    expect(account.pricesUnavailable).toBe(false);
  });

  it("with no Alpaca market-data credentials it makes no live call and serves the stored marks", async () => {
    await seedStoredPrices({ UNOC: 110 });
    const { accountId } = await seedAccount([{ symbol: "UNOC", side: "buy", quantity: 10, price: 100 }]);

    const account = (await build({ connectedAccountId: accountId, days: 30, marks: "live" })).accounts[0];

    expect(alpaca.enrich).not.toHaveBeenCalled();
    expect(account.paperUnrealizedPnl).toBeCloseTo(100, 2);
  });

  it("ignores a non-positive live price instead of marking the position at zero", async () => {
    withAlpacaCredentials();
    alpaca.enrich.mockImplementation(snapshotFor({ UZER: 0 }));
    const { accountId } = await seedAccount([{ symbol: "UZER", side: "buy", quantity: 10, price: 100 }]);

    const account = (await build({ connectedAccountId: accountId, days: 30, marks: "live" })).accounts[0];

    expect(account.paperUnrealizedPnl).toBe(0);
    expect(account.unrealizedUnpricedSymbols).toEqual(["UZER"]);
  });

  it("a hung snapshot keeps the stored marks it already had instead of dropping everything", async () => {
    await seedStoredPrices({ UHNG: 110 });
    withAlpacaCredentials();
    alpaca.enrich.mockImplementation(() => new Promise(() => undefined)); // never settles
    const { accountId } = await seedAccount([{ symbol: "UHNG", side: "buy", quantity: 10, price: 100 }]);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const pending = build({ connectedAccountId: accountId, days: 30, marks: "live" });
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
    expect(account.error).toBeUndefined();
    // The original defect: the deadline used to discard every price, leaving the account unpriced.
    expect(account.paperUnrealizedPnl).toBeCloseTo(100, 2);
    expect(account.pricesUnavailable).toBe(false);
  });

  it("a ticker held in several accounts is fetched once per build", async () => {
    withAlpacaCredentials();
    alpaca.enrich.mockImplementation(snapshotFor({ USHR: 110 }));
    const userId = `unreal-shared-${randomUUID()}`;
    await seedAccount([{ symbol: "USHR", side: "buy", quantity: 10, price: 100 }], { userId, label: "One" });
    await seedAccount([{ symbol: "USHR", side: "buy", quantity: 20, price: 100 }], { userId, label: "Two" });

    const snapshot = await build({ days: 30, marks: "live" });
    const mine = snapshot.accounts.filter((a) => a.userId === userId);

    expect(mine).toHaveLength(2);
    expect(mine.map((a) => a.paperUnrealizedPnl).sort((a, b) => a - b)).toEqual([100, 200]);
    const askedForShr = alpaca.enrich.mock.calls.filter(([symbols]) => (symbols as string[]).includes("USHR"));
    expect(askedForShr).toHaveLength(1);
  });

  it("stops going live once the request-level budget is spent", async () => {
    // Four accounts that each hang: 8s + 8s + the 4s left of the 20s budget, then no live call.
    withAlpacaCredentials();
    alpaca.enrich.mockImplementation(() => new Promise(() => undefined));
    const userId = `unreal-budget-${randomUUID()}`;
    for (let i = 0; i < 4; i += 1) {
      await seedAccount([{ symbol: `UBUD${i}`, side: "buy", quantity: 1, price: 10 }], { userId, label: `Budget ${i}` });
    }

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const pending = build({ days: 30, marks: "live" });
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
    const budgetCalls = alpaca.enrich.mock.calls.filter(([symbols]) => (symbols as string[]).some((s) => s.startsWith("UBUD")));
    expect(budgetCalls).toHaveLength(3); // the fourth account never went live: the budget was gone
  });
});

describe("ops performance - route", () => {
  it("marks= reaches the builder as stored / live / off and keys the cache per mode", async () => {
    process.env.OPS_DIAGNOSTIC_TOKEN = "test-ops-token";
    await seedStoredPrices({ URTE: 150 });
    withAlpacaCredentials();
    alpaca.enrich.mockImplementation(snapshotFor({ URTE: 200 }));
    const { accountId } = await seedAccount([{ symbol: "URTE", side: "buy", quantity: 10, price: 100 }]);
    const { resetOpsPerformanceCacheForTests } = await import("../src/lib/ops-performance");
    resetOpsPerformanceCacheForTests();
    const { GET } = await import("../app/api/ops/performance/route");
    const call = (query: string) =>
      GET(new Request(`http://localhost/api/ops/performance?account=${accountId}${query}`, { headers: { "x-ops-token": "test-ops-token" } }));

    const off = await (await call("&marks=0")).json();
    expect(off.accounts[0].unrealizedMarkBasis).toBe("off");
    expect(off.accounts[0].paperUnrealizedPnl).toBe(0);
    expect(off.accounts[0].pricesUnavailable).toBe(true);

    // Same account and window, default marks: must NOT be served the cheap cached answer.
    const stored = await (await call("")).json();
    expect(stored.accounts[0].unrealizedMarkBasis).toBe("stored");
    expect(stored.accounts[0].paperUnrealizedPnl).toBeCloseTo(500, 2); // stored 150
    expect(alpaca.enrich).not.toHaveBeenCalled(); // the default never goes live

    const live = await (await call("&marks=live")).json();
    expect(live.accounts[0].unrealizedMarkBasis).toBe("live");
    expect(live.accounts[0].paperUnrealizedPnl).toBeCloseTo(1000, 2); // live 200
    expect(alpaca.enrich).toHaveBeenCalledTimes(1);
    expect(cascade.fn).not.toHaveBeenCalled();

    delete process.env.OPS_DIAGNOSTIC_TOKEN;
    resetOpsPerformanceCacheForTests();
  });
});
