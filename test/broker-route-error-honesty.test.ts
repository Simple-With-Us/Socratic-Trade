/**
 * ST-2797 — broker-backed GET routes return JSON 502/504 envelopes; JSON POST routes return 400 invalid_json.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { brokerReadError, isBrokerGatewayError, jsonError, parseRequestJson } from "../src/lib/api-error";
import { AUTHENTICATED_EMAIL_HEADER, resolveRequestUserFromEmail } from "../src/lib/request-user";

const brokerStub = vi.hoisted(() => ({
  getAccounts: vi.fn(),
  getEquityPositions: vi.fn(),
  getEquityOrders: vi.fn(),
  getPortfolio: vi.fn()
}));

vi.mock("../src/lib/broker", () => ({
  getBrokerGateway: () => brokerStub
}));

beforeEach(() => {
  vi.resetModules();
  brokerStub.getAccounts.mockReset();
  brokerStub.getEquityPositions.mockReset();
  brokerStub.getEquityOrders.mockReset();
  brokerStub.getPortfolio.mockReset();
  vi.stubEnv("DATABASE_URL", `file:${join(tmpdir(), `agentic-broker-route-err-${randomUUID()}.db`)}`);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function seedRobinhoodAccount(email: string, accountNumber = "RH-ERR-TEST") {
  const { upsertConnectedAccount, setPolicy } = await import("../src/lib/db");
  const { DEFAULT_POLICY } = await import("../src/lib/defaults");
  const { userId } = resolveRequestUserFromEmail(email);
  const accountId = randomUUID();
  upsertConnectedAccount({
    id: accountId,
    userId,
    broker: "robinhood",
    environment: "paper",
    accountNumber,
    isActive: true,
    label: "Broker error test"
  });
  setPolicy(
    { ...DEFAULT_POLICY, activeBroker: "robinhood", accountNumber, connectedAccountId: accountId },
    userId
  );
  return { userId, accountNumber };
}

describe("src/lib/api-error", () => {
  it("jsonError uses the shared envelope", async () => {
    const res = jsonError(400, "invalid_json", "bad");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ ok: false, error: "invalid_json", message: "bad" });
  });

  it("brokerReadError maps broker 401 to broker_auth_failed", async () => {
    const res = brokerReadError(new Error("Tradier HTTP 401: invalid token sk-live-secret"));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe("broker_auth_failed");
    expect(body.message).not.toMatch(/sk-live/);
  });

  it("brokerReadError maps timeouts to 504", async () => {
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    const res = brokerReadError(err);
    expect(res.status).toBe(504);
    const body = await res.json();
    expect(body.error).toBe("broker_timeout");
  });

  it("brokerReadError maps Public.com bare status throws to HTTP 502", async () => {
    const res = brokerReadError(new Error("Public cancel 500"));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, error: "broker_unavailable", message: "Broker returned HTTP 500." });
  });

  it("brokerReadError maps Robinhood session expiry to broker_auth_failed", async () => {
    const res = brokerReadError(new Error("Robinhood session expired — reconnect your account in Connections"));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, error: "broker_auth_failed" });
  });

  it("parseRequestJson rethrows non-syntax body errors", async () => {
    const request = { json: async () => { throw new TypeError("Body is unusable"); } } as unknown as Request;
    await expect(parseRequestJson(request)).rejects.toThrow(TypeError);
  });
});

describe("broker-backed GET routes", () => {
  const email = "broker-err@test.local";

  it("GET /api/positions returns 502 JSON when the broker throws", async () => {
    await seedRobinhoodAccount(email);
    brokerStub.getEquityPositions.mockRejectedValue(new Error("Tradier HTTP 503: gateway timeout"));
    const { GET } = await import("../app/api/positions/route");
    const res = await GET(new Request("http://localhost/api/positions", { headers: { [AUTHENTICATED_EMAIL_HEADER]: email } }));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, error: "broker_unavailable" });
    expect(body.message).toMatch(/503/);
  });

  it("GET /api/positions success shape unchanged", async () => {
    await seedRobinhoodAccount(email);
    const positions = [{ symbol: "AAPL", quantity: 1, marketValue: 100, averagePrice: 100, side: "long" as const }];
    brokerStub.getEquityPositions.mockResolvedValue(positions);
    const { GET } = await import("../app/api/positions/route");
    const res = await GET(new Request("http://localhost/api/positions", { headers: { [AUTHENTICATED_EMAIL_HEADER]: email } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(positions);
  });

  it("GET /api/positions rethrows non-broker adapter defects", async () => {
    await seedRobinhoodAccount(email);
    brokerStub.getEquityPositions.mockRejectedValue(new TypeError("Cannot read properties of null"));
    const { GET } = await import("../app/api/positions/route");
    await expect(
      GET(new Request("http://localhost/api/positions", { headers: { [AUTHENTICATED_EMAIL_HEADER]: email } }))
    ).rejects.toThrow(TypeError);
    expect(brokerStub.getEquityPositions).toHaveBeenCalledOnce();
  });

  it("GET /api/orders returns 504 on broker timeout", async () => {
    await seedRobinhoodAccount(email);
    const err = new Error("aborted");
    err.name = "AbortError";
    brokerStub.getEquityOrders.mockRejectedValue(err);
    const { GET } = await import("../app/api/orders/route");
    const res = await GET(new Request("http://localhost/api/orders", { headers: { [AUTHENTICATED_EMAIL_HEADER]: email } }));
    expect(res.status).toBe(504);
    const body = await res.json();
    expect(body.error).toBe("broker_timeout");
  });

  it("GET /api/orders success shape unchanged", async () => {
    await seedRobinhoodAccount(email);
    const orders = [
      { id: "ord-1", symbol: "AAPL", side: "buy", type: "market", state: "filled", createdAt: "2026-11-11T00:00:00.000Z" }
    ];
    brokerStub.getEquityOrders.mockResolvedValue(orders);
    const { GET } = await import("../app/api/orders/route");
    const res = await GET(new Request("http://localhost/api/orders", { headers: { [AUTHENTICATED_EMAIL_HEADER]: email } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(orders);
  });

  it("GET /api/orders returns 502 when the broker payload is not an order list", async () => {
    await seedRobinhoodAccount(email);
    brokerStub.getEquityOrders.mockResolvedValue({ unexpected: true });
    const { GET } = await import("../app/api/orders/route");
    const res = await GET(new Request("http://localhost/api/orders", { headers: { [AUTHENTICATED_EMAIL_HEADER]: email } }));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, error: "broker_unavailable" });
    expect(brokerStub.getEquityOrders).toHaveBeenCalledOnce();
  });

  it("GET /api/portfolio returns 502 JSON when the broker throws", async () => {
    await seedRobinhoodAccount(email);
    brokerStub.getPortfolio.mockRejectedValue(new Error("HTTP 502"));
    const { GET } = await import("../app/api/portfolio/route");
    const res = await GET(new Request("http://localhost/api/portfolio", { headers: { [AUTHENTICATED_EMAIL_HEADER]: email } }));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, error: "broker_unavailable" });
    expect(brokerStub.getPortfolio).toHaveBeenCalledOnce();
  });

  it("GET /api/accounts returns 502 on broker auth failure", async () => {
    await seedRobinhoodAccount(email);
    brokerStub.getAccounts.mockRejectedValue(new Error("Alpaca HTTP 403: forbidden"));
    const { GET } = await import("../app/api/accounts/route");
    const res = await GET(new Request("http://localhost/api/accounts", { headers: { [AUTHENTICATED_EMAIL_HEADER]: email } }));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, error: "broker_auth_failed" });
  });
});

describe("malformed JSON on broker-adjacent routes", () => {
  it("PUT /api/policy returns 400 invalid_json", async () => {
    const { PUT } = await import("../app/api/policy/route");
    const res = await PUT(
      new Request("http://localhost/api/policy", {
        method: "PUT",
        headers: { "content-type": "application/json", [AUTHENTICATED_EMAIL_HEADER]: "policy-json@test.local" },
        body: "{not-json"
      })
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "invalid_json" });
  });

  it("POST /api/orders/cancel returns 400 invalid_json", async () => {
    const { POST } = await import("../app/api/orders/cancel/route");
    const res = await POST(
      new Request("http://localhost/api/orders/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "bad-json{"
      })
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "invalid_json" });
  });

  it("POST /api/keys returns 400 invalid_json", async () => {
    const { POST } = await import("../app/api/keys/route");
    const res = await POST(
      new Request("http://localhost/api/keys", {
        method: "POST",
        headers: { "content-type": "application/json", [AUTHENTICATED_EMAIL_HEADER]: "keys-json@test.local" },
        body: "}{"
      }) as import("next/server").NextRequest
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "invalid_json" });
  });
});

describe("isBrokerGatewayError (ST-2797 cancel bookkeeping)", () => {
  it("treats timeouts, transport failures, HTTP statuses and missing accounts as broker errors", () => {
    expect(isBrokerGatewayError(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBe(true);
    expect(isBrokerGatewayError(Object.assign(new Error("upstream"), { status: 503 }))).toBe(true);
    expect(isBrokerGatewayError(new Error("Broker HTTP 500 Internal"))).toBe(true);
    expect(isBrokerGatewayError(new Error("No connected broker account"))).toBe(true);
    expect(isBrokerGatewayError(new TypeError("fetch failed"))).toBe(true);
  });

  it("recognises Public.com and Robinhood adapter error shapes without an HTTP prefix", () => {
    expect(isBrokerGatewayError(new Error("Public cancel 500"))).toBe(true);
    expect(isBrokerGatewayError(new Error("Public portfolio 401"))).toBe(true);
    expect(isBrokerGatewayError(new Error("Public token mint failed (401)"))).toBe(true);
    expect(isBrokerGatewayError(new Error("Robinhood not connected — reconnect your account in Connections"))).toBe(true);
    expect(isBrokerGatewayError(new Error("Robinhood session expired — reconnect your account in Connections"))).toBe(true);
    expect(isBrokerGatewayError(new Error("Robinhood MCP tool reported an error: rate limited"))).toBe(true);
    expect(isBrokerGatewayError(new Error("Timed out waiting for alpaca.getOrders after 2000+2000ms."))).toBe(true);
  });

  it("leaves local bookkeeping faults (DB, notifications) as non-broker errors", () => {
    expect(isBrokerGatewayError(new Error("SQLITE_BUSY: database is locked"))).toBe(false);
    expect(isBrokerGatewayError(new Error("notification dispatch failed"))).toBe(false);
    expect(isBrokerGatewayError(new TypeError("Cannot read properties of null"))).toBe(false);
  });
});
