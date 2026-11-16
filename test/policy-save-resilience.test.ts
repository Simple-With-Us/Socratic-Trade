import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getAccounts = vi.fn();

vi.mock("../src/lib/broker", () => ({
  getBrokerGateway: vi.fn(() => ({ getAccounts }))
}));

beforeEach(() => {
  vi.resetModules();
  getAccounts.mockReset();
  getAccounts.mockRejectedValue(new Error("Robinhood MCP unavailable"));
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-policy-save-resilience-${randomUUID()}.db`)}`;
});

function policyRequest(email: string, body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/policy", {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "x-authenticated-user-email": email
    },
    body: JSON.stringify(body)
  });
}

describe("/api/policy broker verification scoping", () => {
  it("saves an unchanged active Robinhood account's cap when account listing is temporarily unavailable", async () => {
    const db = await import("../src/lib/db");
    const { resolveRequestUserFromEmail } = await import("../src/lib/request-user");
    const { PUT } = await import("../app/api/policy/route");
    const email = `policy-robinhood-${randomUUID()}@example.com`;
    const userId = resolveRequestUserFromEmail(email).userId;
    const accountId = `robinhood-${randomUUID()}`;

    db.upsertConnectedAccount({
      id: accountId,
      userId,
      broker: "robinhood",
      environment: "live",
      accountNumber: "RH-1",
      label: "Robinhood",
      isActive: true
    });
    db.setPolicy({ ...db.getPolicy(userId, accountId), systemState: "active" }, userId, accountId);

    const response = await PUT(policyRequest(email, {
      targetConnectedAccountId: accountId,
      maxDailyNotional: null,
      maxDailyPctOfNav: 20
    }));

    expect(response.status).toBe(200);
    expect((await response.json()).maxDailyPctOfNav).toBe(20);
    expect(getAccounts).not.toHaveBeenCalled();
  });

  it("still verifies when a save enables autonomy", async () => {
    const db = await import("../src/lib/db");
    const { resolveRequestUserFromEmail } = await import("../src/lib/request-user");
    const { PUT } = await import("../app/api/policy/route");
    const email = `policy-robinhood-enable-${randomUUID()}@example.com`;
    const userId = resolveRequestUserFromEmail(email).userId;
    const accountId = `robinhood-enable-${randomUUID()}`;

    db.upsertConnectedAccount({
      id: accountId,
      userId,
      broker: "robinhood",
      environment: "live",
      accountNumber: "RH-2",
      label: "Robinhood",
      isActive: true
    });

    const response = await PUT(policyRequest(email, {
      targetConnectedAccountId: accountId,
      systemState: "active"
    }));

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Could not verify the selected account right now");
    expect(getAccounts).toHaveBeenCalledTimes(1);
  });
});
