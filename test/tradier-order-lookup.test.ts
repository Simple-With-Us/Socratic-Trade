// Tradier adapter: per-order lookup and bracket-aware execution listing (board 687a5fb4 lane G1).
// global.fetch is stubbed with canned Tradier envelopes; no network.  Per-run temp SQLite DB.
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ACCT = "VA00012345";

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-tradier-lookup-${randomUUID()}.db`)}`;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function seedTradierSandbox(): Promise<void> {
  const { upsertConnectedAccount } = await import("../src/lib/db");
  upsertConnectedAccount({
    id: `trd-${randomUUID()}`,
    userId: "local",
    broker: "tradier",
    environment: "paper",
    accountNumber: ACCT,
    label: "Tradier Sandbox",
    apiKey: "tok-sandbox-test",
    apiSecret: undefined,
    isActive: true
  });
}

function stubFetch(handler: (url: string, method: string) => { status?: number; body: unknown } | undefined): string[] {
  const urls: string[] = [];
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    urls.push(u);
    const hit = handler(u, (init?.method ?? "GET").toUpperCase());
    if (!hit) return new Response("", { status: 404 });
    return new Response(typeof hit.body === "string" ? hit.body : JSON.stringify(hit.body), {
      status: hit.status ?? 200,
      headers: { "content-type": "application/json" }
    });
  });
  return urls;
}

describe("Tradier getEquityOrder", () => {
  it("reads a previous-session filled order by id with tags", async () => {
    await seedTradierSandbox();
    const urls = stubFetch((u) => u.includes(`/accounts/${ACCT}/orders/35740897`)
      ? { body: { order: {
          id: 35740897, type: "limit", symbol: "TTE", side: "buy", quantity: 20.0, status: "filled", duration: "day", price: 60.5,
          avg_fill_price: 60.41, exec_quantity: 20.0, remaining_quantity: 0.0, create_date: "2026-07-22T17:38:38.000Z",
          transaction_date: "2026-07-22T17:41:02.000Z", class: "equity", tag: "st-ref-1"
        } } }
      : undefined);
    const { getTradierGateway } = await import("../src/lib/tradier");
    const lookup = await getTradierGateway("local").getEquityOrder!(ACCT, "35740897");
    expect(urls[0]).toContain("/v1/accounts/VA00012345/orders/35740897");
    expect(urls[0]).toContain("includeTags=true");
    expect(lookup?.order).toMatchObject({ id: "35740897", symbol: "TTE", side: "buy", state: "filled", filledQuantity: 20, averagePrice: 60.41, clientOrderId: "st-ref-1" });
    expect(lookup?.exitLegs).toBeUndefined();
  });

  it("returns undefined on a definitive 404 and throws on a server error", async () => {
    await seedTradierSandbox();
    stubFetch((u) => u.includes("/orders/404404") ? { status: 404, body: "The requested resource was not found" } : u.includes("/orders/500500") ? { status: 502, body: "Bad Gateway" } : undefined);
    const { getTradierGateway } = await import("../src/lib/tradier");
    const gateway = getTradierGateway("local");
    await expect(gateway.getEquityOrder!(ACCT, "404404")).resolves.toBeUndefined();
    await expect(gateway.getEquityOrder!(ACCT, "500500")).rejects.toThrow(/502/);
  });

  it("returns undefined on Tradier's 422 errors-envelope order not-found and does not treat unrelated bodies as absence", async () => {
    await seedTradierSandbox();
    stubFetch((u) => {
      if (u.includes("/orders/422422")) {
        return { status: 200, body: { errors: { error: "order 422422 not found" } } };
      }
      if (u.includes("/orders/bare422")) {
        return { status: 200, body: { errors: { error: "not found" } } };
      }
      if (u.includes("/orders/502prose")) {
        return { status: 502, body: "upstream said order 502prose not found in cache" };
      }
      if (u.includes("/orders/400prose")) {
        return { status: 400, body: { errors: { error: "order 400prose not found in validation context" } } };
      }
      return undefined;
    });
    const { getTradierGateway } = await import("../src/lib/tradier");
    const gateway = getTradierGateway("local");
    await expect(gateway.getEquityOrder!(ACCT, "422422")).resolves.toBeUndefined();
    await expect(gateway.getEquityOrder!(ACCT, "bare422")).resolves.toBeUndefined();
    await expect(gateway.getEquityOrder!(ACCT, "502prose")).rejects.toThrow(/502/);
    await expect(gateway.getEquityOrder!(ACCT, "400prose")).rejects.toThrow(/400/);
  });

  // Post-merge audit of #3798 (lane h2): a definitive not-found is the broker ANSWERING, not a broker
  // failure.  Logged as a tradier-broker hard failure, five in a row (one budgeted backfill pass over
  // old sandbox receipts Tradier no longer serves) trip getLaneHealth's consecutive-failure streak and
  // mint a "tradier-broker connection failed" operator push + Sentry error while Tradier is healthy.
  it("records a definitive not-found as a healthy broker answer, never as a tradier-broker connection failure", async () => {
    await seedTradierSandbox();
    stubFetch((u) => u.includes("/orders/5005")
      ? { status: 502, body: "Bad Gateway" }
      : u.includes("/orders/")
        ? { status: 404, body: "The requested resource was not found" }
        : undefined);
    const { getTradierGateway } = await import("../src/lib/tradier");
    const { getDb } = await import("../src/lib/db");
    const { getLaneHealth } = await import("../src/lib/db-health");
    const gateway = getTradierGateway("local");
    for (const id of ["4001", "4002", "4003", "4004", "4005", "4006"]) {
      await expect(gateway.getEquityOrder!(ACCT, id)).resolves.toBeUndefined();
    }
    const health = () => getDb()
      .prepare("SELECT ok FROM api_health_log WHERE service = 'tradier-broker' ORDER BY rowid")
      .all() as Array<{ ok: number }>;
    expect(health()).toHaveLength(6);
    expect(health().every((row) => row.ok === 1)).toBe(true);
    expect(getLaneHealth("tradier-broker", "user", "local").stoppedWorking).toBe(false);
    // A real server failure still counts against the lane.
    await expect(gateway.getEquityOrder!(ACCT, "5005")).rejects.toThrow(/502/);
    expect(health().at(-1)?.ok).toBe(0);
  });

  it("never interpolates an unusable id into the request path", async () => {
    await seedTradierSandbox();
    const urls = stubFetch(() => undefined);
    const { getTradierGateway } = await import("../src/lib/tradier");
    await expect(getTradierGateway("local").getEquityOrder!(ACCT, "../../accounts")).resolves.toBeUndefined();
    await expect(getTradierGateway("local").getEquityOrder!(ACCT, "undefined")).resolves.toBeUndefined();
    expect(urls).toHaveLength(0);
  });
});

describe("tradierOrderLookupFromRow / executionsFromTradierRow", () => {
  it("leg-entry OTOCO: the container id carries the entry leg's execution; exits come back as legs", async () => {
    const { tradierOrderLookupFromRow } = await import("../src/lib/tradier");
    const lookup = tradierOrderLookupFromRow({
      id: 900, class: "otoco", type: "otoco", status: "open", tag: "st-ref-otoco", create_date: "2026-08-05T14:02:11.000Z",
      leg: [
        { id: 901, class: "equity", type: "limit", symbol: "SLB", side: "buy", quantity: 69, status: "filled", avg_fill_price: 43.02, exec_quantity: 69 },
        { id: 902, class: "equity", type: "limit", symbol: "SLB", side: "sell", quantity: 69, status: "open", price: 47.4 },
        { id: 903, class: "equity", type: "stop", symbol: "SLB", side: "sell", quantity: 69, status: "open", stop_price: 40.1 }
      ]
    });
    expect(lookup.order).toMatchObject({ id: "900", symbol: "SLB", side: "buy", state: "filled", filledQuantity: 69, averagePrice: 43.02, clientOrderId: "st-ref-otoco" });
    expect(lookup.entryLegId).toBe("901");
    expect(lookup.exitLegs?.map((leg) => [leg.id, leg.side, leg.type])).toEqual([["902", "sell", "limit"], ["903", "sell", "stop_market"]]);
    expect(lookup.exitLegs?.every((leg) => leg.clientOrderId === undefined)).toBe(true);
  });

  it("container-entry OTOCO (exit-only legs): the container is the entry", async () => {
    const { tradierOrderLookupFromRow } = await import("../src/lib/tradier");
    const lookup = tradierOrderLookupFromRow({
      id: 500, symbol: "AAPL", side: "buy", type: "limit", class: "otoco", status: "filled", avg_fill_price: 190.1, exec_quantity: 10, tag: "bracket",
      leg: [
        { id: 501, symbol: "AAPL", side: "sell", type: "limit", status: "open", quantity: 10, price: 210, class: "equity" },
        { id: 502, side: "sell", type: "stop", quantity: 10, stop_price: 180, class: "equity" }
      ]
    });
    expect(lookup.order).toMatchObject({ id: "500", state: "filled", filledQuantity: 10, averagePrice: 190.1 });
    expect(lookup.entryLegId).toBeUndefined();
    expect(lookup.exitLegs?.map((leg) => leg.id)).toEqual(["501", "502"]);
    // A leg that omits its symbol inherits the container's; it carries no execution of its own.
    expect(lookup.exitLegs?.[1]).toMatchObject({ symbol: "AAPL", stopPrice: 180 });
    expect(lookup.exitLegs?.[1]?.filledQuantity).toBeUndefined();
  });

  // Post-merge audit of #3798 (lane h2): a leg array that carries the class's full leg count already
  // holds the entry, so the container is never itself an execution.  The side heuristic sent an
  // owner's sell-first OTOCO (and an equity-plus-option OTO) to the container-entry shape, which booked
  // the container's mirrored execution AND leg 0's own execution — the same shares twice.
  it("full-count leg arrays are leg-entry whatever the sides: the container is never booked beside its legs", async () => {
    const { executionsFromTradierRow, tradierOrderLookupFromRow } = await import("../src/lib/tradier");
    const { isFinalPricedExecution } = await import("../src/lib/fill-reconciliation");
    const sellFirst: Record<string, unknown> = {
      id: 700, class: "otoco", symbol: "SHEL", side: "sell", type: "limit", status: "filled", quantity: 50,
      exec_quantity: 50, avg_fill_price: 70.1, create_date: "2026-09-29T14:00:00.000Z", transaction_date: "2026-09-29T15:00:00.000Z",
      leg: [
        { id: 701, class: "equity", symbol: "SHEL", side: "sell", type: "limit", quantity: 50, status: "filled", exec_quantity: 50, avg_fill_price: 70.1 },
        { id: 702, class: "equity", symbol: "SHEL", side: "buy", type: "limit", quantity: 50, status: "canceled", exec_quantity: 0, avg_fill_price: 0 },
        { id: 703, class: "equity", symbol: "SHEL", side: "buy", type: "stop", quantity: 50, status: "filled", exec_quantity: 50, avg_fill_price: 72 }
      ]
    };
    const executions = executionsFromTradierRow(sellFirst);
    expect(executions.map((e) => [e.order.id, e.role])).toEqual([["701", "entry"], ["702", "exit"], ["703", "exit"]]);
    expect(executions.filter((e) => isFinalPricedExecution(e.order)).map((e) => e.order.id)).toEqual(["701", "703"]);
    const lookup = tradierOrderLookupFromRow(sellFirst);
    expect(lookup.order).toMatchObject({ id: "700", side: "sell", state: "filled", filledQuantity: 50, averagePrice: 70.1 });
    expect(lookup.entryLegId).toBe("701");
    expect(lookup.exitLegs?.map((leg) => leg.id)).toEqual(["702", "703"]);

    // Buy stock, which triggers a covered-call sale: two legs, one of them an option.
    const buyWrite: Record<string, unknown> = {
      id: 800, class: "oto", symbol: "C", side: "buy", type: "limit", status: "filled", quantity: 100,
      exec_quantity: 100, avg_fill_price: 72.4, transaction_date: "2026-09-29T15:00:00.000Z",
      leg: [
        { id: 801, class: "equity", symbol: "C", side: "buy", type: "limit", quantity: 100, status: "filled", exec_quantity: 100, avg_fill_price: 72.4 },
        { id: 802, class: "option", symbol: "C", option_symbol: "C261016C00075000", side: "sell_to_open", type: "limit", quantity: 1, status: "open" }
      ]
    };
    expect(executionsFromTradierRow(buyWrite).map((e) => [e.order.id, e.role])).toEqual([["801", "entry"]]);
  });

  it("drops a bracket exit leg without a recognized side instead of booking it as a default buy", async () => {
    const { tradierOrderLookupFromRow } = await import("../src/lib/tradier");
    const lookup = tradierOrderLookupFromRow({
      id: 600, symbol: "VZ", side: "buy", type: "limit", class: "oto", status: "filled", exec_quantity: 98, avg_fill_price: 40, tag: "st-ref-vz",
      leg: [{ id: 601, class: "equity", type: "stop", status: "filled", quantity: 98, exec_quantity: 98, avg_fill_price: 38.2 }]
    });
    expect(lookup.order).toMatchObject({ id: "600", state: "filled", filledQuantity: 98 });
    expect(lookup.exitLegs ?? []).toEqual([]);
  });

  it("listRecentExecutions keeps bracket roles and drops rows with an unrecognized side", async () => {
    await seedTradierSandbox();
    stubFetch((u) => {
      if (!u.includes(`/accounts/${ACCT}/orders`)) return undefined;
      const page = new URL(u).searchParams.get("page");
      if (page !== "1") return { body: { orders: "null" } };
      return { body: { orders: { order: [
        { id: 1, class: "equity", symbol: "C", side: "sell", type: "market", status: "filled", exec_quantity: 47, avg_fill_price: 72.4 },
        { id: 2, class: "equity", symbol: "C", side: "mystery", type: "market", status: "filled", exec_quantity: 1, avg_fill_price: 72.4 },
        { id: 10, class: "oto", status: "open", tag: "st-ref", leg: [
          { id: 11, class: "equity", symbol: "VZ", side: "buy", type: "limit", status: "filled", exec_quantity: 98, avg_fill_price: 40 },
          { id: 12, class: "equity", symbol: "VZ", side: "sell", type: "stop", status: "open" }
        ] },
        { id: 20, class: "oco", symbol: "MFC", status: "open", leg: [
          { id: 21, class: "equity", side: "sell", type: "limit", status: "open" },
          { id: 22, class: "equity", side: "sell", type: "stop", status: "open" }
        ] },
        { id: 30, class: "option", symbol: "SPY", side: "buy_to_open", status: "filled" }
      ] } } };
    });
    const { getTradierGateway } = await import("../src/lib/tradier");
    const executions = await getTradierGateway("local").listRecentExecutions!(ACCT);
    expect(executions.map((e) => [e.order.id, e.role, e.parentOrderId ?? null, e.parentClientOrderId ?? null])).toEqual([
      ["1", "single", null, null],
      ["11", "entry", "10", "st-ref"],
      ["12", "exit", "10", "st-ref"],
      ["21", "exit", "20", null],
      ["22", "exit", "20", null]
    ]);
    expect(executions.find((e) => e.order.id === "21")?.order.symbol).toBe("MFC");
  });

  it("getEquityOrders is unchanged by the raw page-walk refactor", async () => {
    await seedTradierSandbox();
    stubFetch((u) => {
      if (!u.includes(`/accounts/${ACCT}/orders`)) return undefined;
      const page = new URL(u).searchParams.get("page");
      if (page === "1") return { body: { orders: { order: [
        { id: 1, class: "equity", symbol: "C", side: "sell", type: "limit", status: "open", create_date: "2026-09-25T14:00:00.000Z" },
        { id: 2, class: "option", symbol: "SPY", side: "buy_to_open", status: "open" }
      ] } } };
      if (page === "2") return { body: { orders: { order: { id: 3, class: "equity", symbol: "VZ", side: "buy", type: "stop", status: "open", create_date: "2026-09-25T14:00:00.000Z" } } } };
      return { body: { orders: "null" } };
    });
    const { getTradierGateway } = await import("../src/lib/tradier");
    const orders = await getTradierGateway("local").getEquityOrders(ACCT);
    expect(orders.map((o) => o.id)).toEqual(["1", "3"]);
  });
});
