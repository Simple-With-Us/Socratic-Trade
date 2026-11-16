import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-policy-account-target-${randomUUID()}.db`)}`;
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

describe("/api/policy account-target binding", () => {
  it("persists a delayed Account A patch to A even after B becomes active", async () => {
    const db = await import("../src/lib/db");
    const { resolveRequestUserFromEmail } = await import("../src/lib/request-user");
    const { PUT } = await import("../app/api/policy/route");
    const email = `policy-target-${randomUUID()}@example.com`;
    const userId = resolveRequestUserFromEmail(email).userId;
    const accountA = `account-a-${randomUUID()}`;
    const accountB = `account-b-${randomUUID()}`;

    db.upsertConnectedAccount({
      id: accountA,
      userId,
      broker: "alpaca",
      environment: "paper",
      accountNumber: "TARGET-A",
      label: "Account A",
      isActive: true
    });
    db.upsertConnectedAccount({
      id: accountB,
      userId,
      broker: "alpaca",
      environment: "paper",
      accountNumber: "TARGET-B",
      label: "Account B",
      isActive: false
    });
    db.setPolicy({ ...db.getPolicy(userId, accountA), maxProposalsPerRun: 2 }, userId, accountA);
    db.setStrategyPrompt("Prompt A", userId, accountA);
    db.setPolicy({ ...db.getPolicy(userId, accountB), maxProposalsPerRun: 3 }, userId, accountB);
    db.setStrategyPrompt("Prompt B", userId, accountB);

    // Model the UI race: the edit originated from A, then another request switched the active pointer
    // to B before this policy PUT reached the route.
    db.setActiveConnectedAccount(accountB, userId);
    const response = await PUT(
      policyRequest(email, {
        targetConnectedAccountId: accountA,
        maxProposalsPerRun: 4,
        strategyPrompt: "Updated prompt A"
      })
    );

    expect(response.status).toBe(200);
    expect(db.getActiveConnectedAccount(userId)?.id).toBe(accountB);
    expect(db.getPolicy(userId, accountA).maxProposalsPerRun).toBe(4);
    expect(db.getStrategyPrompt(userId, accountA)).toBe("Updated prompt A");
    expect(db.getPolicy(userId, accountB).maxProposalsPerRun).toBe(3);
    expect(db.getStrategyPrompt(userId, accountB)).toBe("Prompt B");
  });

  it("rejects a target not owned by the request user without changing either account", async () => {
    const db = await import("../src/lib/db");
    const { resolveRequestUserFromEmail } = await import("../src/lib/request-user");
    const { PUT } = await import("../app/api/policy/route");
    const ownerEmail = `policy-owner-${randomUUID()}@example.com`;
    const attackerEmail = `policy-other-${randomUUID()}@example.com`;
    const ownerId = resolveRequestUserFromEmail(ownerEmail).userId;
    const attackerId = resolveRequestUserFromEmail(attackerEmail).userId;
    const ownerAccount = `owned-${randomUUID()}`;
    const attackerAccount = `other-${randomUUID()}`;

    db.upsertConnectedAccount({
      id: ownerAccount,
      userId: ownerId,
      broker: "alpaca",
      environment: "paper",
      accountNumber: "OWNED",
      label: "Owned",
      isActive: true
    });
    db.upsertConnectedAccount({
      id: attackerAccount,
      userId: attackerId,
      broker: "alpaca",
      environment: "paper",
      accountNumber: "OTHER",
      label: "Other",
      isActive: true
    });
    db.setPolicy({ ...db.getPolicy(ownerId, ownerAccount), maxProposalsPerRun: 2 }, ownerId, ownerAccount);
    db.setPolicy({ ...db.getPolicy(attackerId, attackerAccount), maxProposalsPerRun: 3 }, attackerId, attackerAccount);

    const response = await PUT(
      policyRequest(ownerEmail, {
        targetConnectedAccountId: attackerAccount,
        maxProposalsPerRun: 8
      })
    );

    expect(response.status).toBe(404);
    expect(db.getPolicy(ownerId, ownerAccount).maxProposalsPerRun).toBe(2);
    expect(db.getPolicy(attackerId, attackerAccount).maxProposalsPerRun).toBe(3);
  });

  it("does not partially persist strategyPrompt when companion policy validation fails", async () => {
    const db = await import("../src/lib/db");
    const { resolveRequestUserFromEmail } = await import("../src/lib/request-user");
    const { PUT } = await import("../app/api/policy/route");
    const email = `policy-atomic-${randomUUID()}@example.com`;
    const userId = resolveRequestUserFromEmail(email).userId;
    const accountId = `atomic-${randomUUID()}`;

    db.upsertConnectedAccount({
      id: accountId,
      userId,
      broker: "alpaca",
      environment: "paper",
      accountNumber: "ATOMIC",
      label: "Atomic",
      isActive: true
    });
    db.setPolicy(db.getPolicy(userId, accountId), userId, accountId);
    db.setStrategyPrompt("Original prompt", userId, accountId);

    const response = await PUT(
      policyRequest(email, {
        targetConnectedAccountId: accountId,
        strategyPrompt: "Must not leak through",
        learningReviewModel: null
      })
    );

    expect(response.status).toBe(400);
    expect(db.getStrategyPrompt(userId, accountId)).toBe("Original prompt");
  });

  it("switches the targeted account daily cap between percent and dollars exclusively", async () => {
    const db = await import("../src/lib/db");
    const { resolveRequestUserFromEmail } = await import("../src/lib/request-user");
    const { PUT } = await import("../app/api/policy/route");
    const email = `policy-cap-${randomUUID()}@example.com`;
    const userId = resolveRequestUserFromEmail(email).userId;
    const accountA = `cap-a-${randomUUID()}`;
    const accountB = `cap-b-${randomUUID()}`;

    for (const [id, number, active] of [[accountA, "CAP-A", true], [accountB, "CAP-B", false]] as const) {
      db.upsertConnectedAccount({
        id,
        userId,
        broker: "alpaca",
        environment: "live",
        accountNumber: number,
        label: number,
        isActive: active
      });
    }
    db.setPolicy(
      { ...db.getPolicy(userId, accountA), maxDailyNotional: 1_000, maxDailyPctOfNav: undefined },
      userId,
      accountA
    );
    db.setPolicy(
      { ...db.getPolicy(userId, accountB), maxDailyNotional: 600, maxDailyPctOfNav: undefined },
      userId,
      accountB
    );

    const percentResponse = await PUT(
      policyRequest(email, {
        targetConnectedAccountId: accountA,
        maxDailyNotional: null,
        maxDailyPctOfNav: 20
      })
    );
    expect(percentResponse.status).toBe(200);
    expect(db.getPolicy(userId, accountA)).toMatchObject({ maxDailyPctOfNav: 20 });
    expect(db.getPolicy(userId, accountA).maxDailyNotional).toBeUndefined();
    expect(db.getPolicy(userId, accountB)).toMatchObject({ maxDailyNotional: 600 });

    const dollarResponse = await PUT(
      policyRequest(email, {
        targetConnectedAccountId: accountA,
        maxDailyNotional: 250,
        maxDailyPctOfNav: null
      })
    );
    expect(dollarResponse.status).toBe(200);
    expect(db.getPolicy(userId, accountA)).toMatchObject({ maxDailyNotional: 250 });
    expect(db.getPolicy(userId, accountA).maxDailyPctOfNav).toBeUndefined();
    expect(db.getPolicy(userId, accountB)).toMatchObject({ maxDailyNotional: 600 });
  });
});
