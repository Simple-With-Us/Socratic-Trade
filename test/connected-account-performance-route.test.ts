import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

// Same per-run temp DB isolation convention as connected-accounts-route.test.ts /
// route-ownership.test.ts — never the dev data/app.db.
beforeEach(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `connected-account-performance-route-${randomUUID()}.db`)}`;
});

describe("GET /api/connected-accounts/[id]/performance", () => {
  it("404s when the account id does not exist", async () => {
    const { GET } = await import("../app/api/connected-accounts/[id]/performance/route");
    const res = await GET(new Request("http://localhost/api/connected-accounts/nope/performance"), {
      params: Promise.resolve({ id: "nope" })
    });
    expect(res.status).toBe(404);
  });

  it("404s for another user's account — ownership is scoped server-side, not by a client-supplied id alone", async () => {
    const { upsertConnectedAccount } = await import("../src/lib/db");
    const strangerId = randomUUID();
    const ownerId = `owner-${randomUUID()}`;
    upsertConnectedAccount({
      id: strangerId,
      userId: ownerId,
      broker: "alpaca",
      environment: "paper",
      accountNumber: "PA-OWNER-1",
      label: "Owner's Paper Account",
      isActive: false
    });

    // No x-authenticated-user-email header -> resolves to the dev-fallback user ("local"),
    // a stranger to `ownerId` — must not see the owner's account or its performance.
    const { GET } = await import("../app/api/connected-accounts/[id]/performance/route");
    const res = await GET(new Request(`http://localhost/api/connected-accounts/${strangerId}/performance`), {
      params: Promise.resolve({ id: strangerId })
    });
    expect(res.status).toBe(404);
  });

  it("resolves accountNumber from the server-side row (never a client-supplied one) and returns that account's own paper/live bucket", async () => {
    const { upsertConnectedAccount, insertFillEvent } = await import("../src/lib/db");
    const { DEV_USER_ID } = await import("../src/lib/auth/identity");

    const accountId = randomUUID();
    upsertConnectedAccount({
      id: accountId,
      userId: DEV_USER_ID,
      broker: "alpaca",
      environment: "paper",
      accountNumber: "PA-COMPARE-1",
      label: "Compare Paper Account",
      isActive: false
    });

    insertFillEvent({
      accountNumber: "PA-COMPARE-1",
      source: "paper",
      symbol: "AAPL",
      side: "buy",
      quantity: 10,
      price: 100,
      notional: 1000,
      status: "filled",
      userId: DEV_USER_ID
    });
    insertFillEvent({
      accountNumber: "PA-COMPARE-1",
      source: "paper",
      symbol: "AAPL",
      side: "sell",
      quantity: 10,
      price: 120,
      notional: 1200,
      status: "filled",
      userId: DEV_USER_ID
    });

    const { GET } = await import("../app/api/connected-accounts/[id]/performance/route");
    const res = await GET(new Request(`http://localhost/api/connected-accounts/${accountId}/performance`), {
      params: Promise.resolve({ id: accountId })
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.account).toMatchObject({
      id: accountId,
      label: "Compare Paper Account",
      broker: "alpaca",
      environment: "paper"
    });
    // The projected account never carries secrets.
    expect(json.account.apiKey).toBeUndefined();
    expect(json.account.apiSecret).toBeUndefined();
    expect(json.performance.paperRealizedPnl).toBeGreaterThan(0);
    expect(json.performance.liveRealizedPnl).toBe(0);
    // Realized P&L is real (it never depended on live quotes), but this endpoint never
    // fetches currentPrices, so unrealized figures are NOT real data -- the route must say
    // so explicitly rather than let the client mistake a synthetic $0 for a real one.
    expect(json.pricesUnavailable).toBe(true);
  });

  it("flags unrealized P&L as unavailable (pricesUnavailable) even when an open position would otherwise carry a nonzero unrealized figure", async () => {
    const { upsertConnectedAccount, insertFillEvent } = await import("../src/lib/db");
    const { DEV_USER_ID } = await import("../src/lib/auth/identity");

    const accountId = randomUUID();
    upsertConnectedAccount({
      id: accountId,
      userId: DEV_USER_ID,
      broker: "alpaca",
      environment: "paper",
      accountNumber: "PA-COMPARE-OPEN-1",
      label: "Compare Paper Account (open position)",
      isActive: false
    });

    // An open (unclosed) buy — if this route fetched live quotes, this symbol would carry
    // a real nonzero unrealized P&L. It never does, so unrealized must read as unavailable,
    // not as a fabricated $0.
    insertFillEvent({
      accountNumber: "PA-COMPARE-OPEN-1",
      source: "paper",
      symbol: "AAPL",
      side: "buy",
      quantity: 10,
      price: 100,
      notional: 1000,
      status: "filled",
      userId: DEV_USER_ID
    });

    const { GET } = await import("../app/api/connected-accounts/[id]/performance/route");
    const res = await GET(new Request(`http://localhost/api/connected-accounts/${accountId}/performance`), {
      params: Promise.resolve({ id: accountId })
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.pricesUnavailable).toBe(true);
    // The underlying summary still computes to 0 (no currentPrices were supplied) --
    // it's the pricesUnavailable flag, not this raw number, that the client must key off
    // of to avoid rendering a fabricated $0.00.
    expect(json.performance.paperUnrealizedPnl).toBe(0);
  });

  it("returns performance: null when the account has no accountNumber yet", async () => {
    const { upsertConnectedAccount } = await import("../src/lib/db");
    const { DEV_USER_ID } = await import("../src/lib/auth/identity");

    const accountId = randomUUID();
    upsertConnectedAccount({
      id: accountId,
      userId: DEV_USER_ID,
      broker: "robinhood",
      environment: "live",
      label: "Not yet synced",
      isActive: false
    });

    const { GET } = await import("../app/api/connected-accounts/[id]/performance/route");
    const res = await GET(new Request(`http://localhost/api/connected-accounts/${accountId}/performance`), {
      params: Promise.resolve({ id: accountId })
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.performance).toBeNull();
    // Nothing to mark unavailable when there's no performance summary at all.
    expect(json.pricesUnavailable).toBe(false);
  });
});
