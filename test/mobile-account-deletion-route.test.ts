import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const vectorMocks = vi.hoisted(() => ({
  purgePrivateVectorRecordsForUser: vi.fn()
}));

vi.mock("../src/lib/vector-db", () => ({
  managedVectorLedgerAuthority: vi.fn(),
  getCurrentVectorProviderAuthority: vi.fn(),
  purgePrivateVectorRecordsForUser: vectorMocks.purgePrivateVectorRecordsForUser
}));

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-mobile-delete-route-${randomUUID()}.db`)}`;
});

beforeEach(() => {
  vectorMocks.purgePrivateVectorRecordsForUser.mockReset();
  vectorMocks.purgePrivateVectorRecordsForUser.mockResolvedValue({
    ids: [],
    contentHashes: [],
    deleted: 0
  });
});

function request(
  path: string,
  email: string,
  init: RequestInit = {}
): Request {
  const headers = new Headers(init.headers);
  headers.set("x-authenticated-user-email", email);
  return new Request(`https://socratictrade.com${path}`, {
    ...init,
    headers
  });
}

async function seedActiveAccount(email: string) {
  const { userIdForEmail } = await import("../src/lib/auth/identity");
  const db = await import("../src/lib/db");
  const userId = userIdForEmail(email);
  const accountId = `mobile-delete-${randomUUID()}`;
  db.upsertConnectedAccount({
    id: accountId,
    userId,
    broker: "alpaca",
    environment: "paper",
    accountNumber: `PAPER-${randomUUID()}`,
    label: "Deletion route test",
    isActive: true
  });
  db.setPolicy(
    {
      ...db.getPolicy(userId, accountId),
      systemState: "active",
      additionalSymbols: ["AAPL"]
    },
    userId,
    accountId
  );
  return { ...db, userId, accountId };
}

describe("native account deletion routes", () => {
  it("keeps GET preview and legacy POST preview fully read-only", async () => {
    const email = `preview-${randomUUID()}@example.com`;
    const { getDb, getPolicy, userId, accountId } = await seedActiveAccount(email);
    const route = await import("../app/api/mobile/account-deletion/request/route");

    const response = await route.GET(
      request("/api/mobile/account-deletion/request", email)
    );
    const body = await response.json() as {
      deletionRequest: {
        requestId?: string;
        userId: string;
        requiredText: string;
      };
    };

    expect(response.status).toBe(200);
    expect(body.deletionRequest).toMatchObject({
      userId,
      requiredText: "DELETE MY ACCOUNT"
    });
    expect(body.deletionRequest.requestId).toBeUndefined();
    expect(getDb().prepare(
      "SELECT COUNT(*) AS count FROM account_deletion_requests WHERE user_id = ?"
    ).get(userId)).toEqual({ count: 0 });
    expect(getPolicy(userId, accountId).systemState).toBe("active");

    const stalePost = await route.POST();
    expect(stalePost.status).toBe(405);
    expect(stalePost.headers.get("allow")).toBe("GET");
    expect(getDb().prepare(
      "SELECT COUNT(*) AS count FROM account_deletion_requests WHERE user_id = ?"
    ).get(userId)).toEqual({ count: 0 });
    expect(getPolicy(userId, accountId).systemState).toBe("active");
  });

  it("does not prepare on invalid confirmation and prepares only inside valid final deletion", async () => {
    const email = `confirm-${randomUUID()}@example.com`;
    const { getDb, getPolicy, userId, accountId } = await seedActiveAccount(email);
    const route = await import("../app/api/mobile/account-deletion/confirm/route");

    const invalid = await route.POST(request(
      "/api/mobile/account-deletion/confirm",
      email,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          typedIdentity: "wrong@example.com",
          typedText: "DELETE MY ACCOUNT"
        })
      }
    ));
    expect(invalid.status).toBe(400);
    expect(getDb().prepare(
      "SELECT COUNT(*) AS count FROM account_deletion_requests WHERE user_id = ?"
    ).get(userId)).toEqual({ count: 0 });
    expect(getPolicy(userId, accountId).systemState).toBe("active");

    const invalidPhrase = await route.POST(request(
      "/api/mobile/account-deletion/confirm",
      email,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          typedIdentity: email,
          typedText: "DELETE EVERYTHING"
        })
      }
    ));
    expect(invalidPhrase.status).toBe(400);
    expect(getDb().prepare(
      "SELECT COUNT(*) AS count FROM account_deletion_requests WHERE user_id = ?"
    ).get(userId)).toEqual({ count: 0 });
    expect(getPolicy(userId, accountId).systemState).toBe("active");

    const confirmed = await route.POST(request(
      "/api/mobile/account-deletion/confirm",
      email,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          typedIdentity: email,
          typedText: "DELETE MY ACCOUNT"
        })
      }
    ));
    const receipt = await confirmed.json() as {
      ok: boolean;
      counts: Record<string, number>;
      logoutUrl: string;
    };

    expect(confirmed.status).toBe(200);
    expect(receipt.ok).toBe(true);
    expect(receipt.logoutUrl).toBe("/logout");
    expect(receipt.counts.connected_accounts).toBeGreaterThanOrEqual(1);
    expect(getDb().prepare(
      "SELECT COUNT(*) AS count FROM account_deletion_requests WHERE user_id = ?"
    ).get(userId)).toEqual({ count: 0 });
    expect(getDb().prepare(
      "SELECT COUNT(*) AS count FROM connected_accounts WHERE user_id = ?"
    ).get(userId)).toEqual({ count: 0 });
  });
});
