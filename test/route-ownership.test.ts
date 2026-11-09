/**
 * Cross-tenant ownership isolation tests (route-ownership spec).
 *
 * Exercises the DB/strategy layer directly (no HTTP) to verify that a
 * resource created as user-A cannot be read or mutated by user-B.
 * Mirrors the account-scope.test.ts pattern: temp SQLite file per run,
 * never touches data/app.db.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `route-ownership-${randomUUID()}.db`)}`;
});

describe("route ownership isolation", () => {
  it("proposal approve: getProposal returns undefined for a foreign userId (executeProposal would throw 'Proposal not found.')", async () => {
    const { insertProposal, getProposal } = await import("../src/lib/db");

    const userA = `owner-${randomUUID()}`;
    const userB = `stranger-${randomUUID()}`;
    const proposalId = randomUUID();

    insertProposal({
      id: proposalId,
      runId: "r",
      accountNumber: "ACCT-A",
      proposal: {
        symbol: "AAPL",
        side: "buy",
        dollarAmount: 100,
        tradeThesisTag: "Momentum-Breakout",
        entryMarketRegime: "bull"
      },
      decision: { approved: true, reasons: [] },
      status: "proposed",
      estimatedNotional: 100,
      userId: userA
    });

    // user-B cannot see user-A's proposal via getProposal (which executeProposal relies on)
    expect(getProposal(proposalId, userB)).toBeUndefined();
    // user-A can see their own proposal
    expect(getProposal(proposalId, userA)).toBeDefined();
  });

  it("proposal reject: getProposal returns undefined for a foreign userId (rejectProposal silently no-ops)", async () => {
    const { insertProposal, getProposal } = await import("../src/lib/db");

    const userA = `owner-${randomUUID()}`;
    const userB = `stranger-${randomUUID()}`;
    const proposalId = randomUUID();

    insertProposal({
      id: proposalId,
      runId: "r",
      accountNumber: "ACCT-A",
      proposal: {
        symbol: "TSLA",
        side: "buy",
        dollarAmount: 50,
        tradeThesisTag: "Value-Quality",
        entryMarketRegime: "neutral"
      },
      decision: { approved: true, reasons: [] },
      status: "proposed",
      estimatedNotional: 50,
      userId: userA
    });

    // user-B cannot see user-A's proposal (the route pre-checks this and returns 404)
    expect(getProposal(proposalId, userB)).toBeUndefined();
    // user-A can still see their own proposal
    expect(getProposal(proposalId, userA)).toBeDefined();
  });

  it("proposal reject: rejectProposal does not mutate a foreign proposal's status", async () => {
    const { insertProposal, getProposal } = await import("../src/lib/db");
    const { rejectProposal } = await import("../src/lib/strategy");

    const userA = `owner-${randomUUID()}`;
    const userB = `stranger-${randomUUID()}`;
    const proposalId = randomUUID();

    insertProposal({
      id: proposalId,
      runId: "r",
      accountNumber: "ACCT-A",
      proposal: {
        symbol: "MSFT",
        side: "buy",
        dollarAmount: 200,
        tradeThesisTag: "Momentum-Breakout",
        entryMarketRegime: "bull"
      },
      decision: { approved: true, reasons: [] },
      status: "proposed",
      estimatedNotional: 200,
      userId: userA
    });

    // user-B calls rejectProposal — the WHERE user_id clause means it's a no-op
    rejectProposal(proposalId, userB);
    // user-A's proposal is still "proposed"
    expect(getProposal(proposalId, userA)?.status).toBe("proposed");
  });

  it("connected-account delete: deleteConnectedAccount returns false for a foreign userId", async () => {
    const { upsertConnectedAccount, deleteConnectedAccount } = await import("../src/lib/db");

    const userA = `owner-${randomUUID()}`;
    const userB = `stranger-${randomUUID()}`;
    const accountId = randomUUID();

    upsertConnectedAccount({
      id: accountId,
      userId: userA,
      broker: "alpaca",
      environment: "paper",
      accountNumber: "ALPACA-TEST",
      label: "Test",
      isActive: false
    });

    // user-B cannot delete user-A's connected account
    expect(deleteConnectedAccount(accountId, userB)).toBe(false);
    // user-A can delete their own account
    expect(deleteConnectedAccount(accountId, userA)).toBe(true);
  });

  it("profile GET: getStrategyProfile returns undefined for a foreign userId", async () => {
    const { createStrategyProfile, getStrategyProfile } = await import("../src/lib/db");

    const userA = `owner-${randomUUID()}`;
    const userB = `stranger-${randomUUID()}`;

    const profile = createStrategyProfile({ name: "My Strategy" }, userA);

    expect(getStrategyProfile(profile.id, userB)).toBeUndefined();
    expect(getStrategyProfile(profile.id, userA)).toBeDefined();
  });

  it("profile PUT: updateStrategyProfile throws 'Strategy profile not found.' for a foreign userId", async () => {
    const { createStrategyProfile, updateStrategyProfile } = await import("../src/lib/db");

    const userA = `owner-${randomUUID()}`;
    const userB = `stranger-${randomUUID()}`;

    const profile = createStrategyProfile({ name: "Protected Strategy" }, userA);

    expect(() =>
      updateStrategyProfile(profile.id, { name: "Hacked Name" }, userB)
    ).toThrow("Strategy profile not found.");
  });
});
