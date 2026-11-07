import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/vector-db", () => ({
  managedVectorLedgerAuthority: vi.fn(),
  getCurrentVectorProviderAuthority: vi.fn(),
  purgePrivateVectorRecordsForUser: vi.fn(async () => ({ ids: [], contentHashes: [], deleted: 0 }))
}));

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-mobile-api-${randomUUID()}.db`)}`;
});

describe("mobile command gateway", () => {
  it("queues commands idempotently and executes through the durable worker", async () => {
    const { queueMobileCommand, processPendingMobileCommands, listMobileCommands } = await import("../src/lib/mobile-api");
    const { listWatchlist } = await import("../src/lib/watchlist");
    const userId = `mobile-user-${randomUUID()}`;

    const first = queueMobileCommand({
      userId,
      commandType: "watchlist.add",
      payload: { symbol: "aapl" },
      idempotencyKey: "watchlist-aapl-1",
      client: { platform: "ios", appVersion: "1.0", deviceId: "device-secret" }
    });
    const second = queueMobileCommand({
      userId,
      commandType: "watchlist.add",
      payload: { symbol: "AAPL" },
      idempotencyKey: "watchlist-aapl-1"
    });

    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(second.command.id).toBe(first.command.id);
    expect(second.command.client?.deviceIdHash).toMatch(/^[a-f0-9]{24}$/);

    await processPendingMobileCommands({ limit: 1 });

    const commands = listMobileCommands({ userId });
    expect(commands[0].status).toBe("succeeded");
    expect(listWatchlist(userId).map((item) => item.symbol)).toEqual(["AAPL"]);
  });

  it("redacts live approval text from public command payloads", async () => {
    const { queueMobileCommand } = await import("../src/lib/mobile-api");
    const userId = `mobile-redact-${randomUUID()}`;
    const queued = queueMobileCommand({
      userId,
      commandType: "proposal.approve",
      payload: {
        proposalId: "proposal-1",
        liveConfirmation: {
          proposalId: "proposal-1",
          accountNumber: "LIVE",
          executionMode: "broker/live",
          estimatedNotional: 12.34,
          typedText: "APPROVE LIVE AAPL"
        }
      }
    });

    expect(queued.command.payload).toEqual({ proposalId: "proposal-1", hasLiveConfirmation: true });
  });

  it("rejects forbidden policy ownership fields", async () => {
    const { queueMobileCommand, MobileCommandValidationError } = await import("../src/lib/mobile-api");
    const userId = `mobile-policy-${randomUUID()}`;

    expect(() =>
      queueMobileCommand({
        userId,
        commandType: "policy.patch",
        payload: { patch: { accountNumber: "SPOOFED" } }
      })
    ).toThrow(MobileCommandValidationError);
  });

  it("applies exclusive daily percent and dollar cap modes through mobile commands", async () => {
    const { processPendingMobileCommands, queueMobileCommand } = await import("../src/lib/mobile-api");
    const { getPolicy, setPolicy, upsertConnectedAccount } = await import("../src/lib/db");
    const userId = `mobile-cap-${randomUUID()}`;
    const accountId = `mobile-cap-account-${randomUUID()}`;
    upsertConnectedAccount({
      id: accountId,
      userId,
      broker: "alpaca",
      environment: "live",
      accountNumber: "MOBILE-CAP",
      label: "Mobile Cap",
      isActive: true
    });
    setPolicy(
      { ...getPolicy(userId, accountId), maxDailyNotional: 1_000, maxDailyPctOfNav: undefined },
      userId,
      accountId
    );

    queueMobileCommand({
      userId,
      commandType: "policy.patch",
      payload: { patch: { maxDailyPctOfNav: 20 } }
    });
    await processPendingMobileCommands({ limit: 10 });
    expect(getPolicy(userId, accountId)).toMatchObject({ maxDailyPctOfNav: 20 });
    expect(getPolicy(userId, accountId).maxDailyNotional).toBeUndefined();

    queueMobileCommand({
      userId,
      commandType: "policy.patch",
      payload: { patch: { maxDailyNotional: 250 } }
    });
    await processPendingMobileCommands({ limit: 10 });
    expect(getPolicy(userId, accountId)).toMatchObject({ maxDailyNotional: 250 });
    expect(getPolicy(userId, accountId).maxDailyPctOfNav).toBeUndefined();
  });

  it("builds a mobile control brief from current readiness and command state", async () => {
    const { buildMobileBrief, mobileReadiness, queueMobileCommand } = await import("../src/lib/mobile-api");
    const userId = `mobile-brief-${randomUUID()}`;

    queueMobileCommand({
      userId,
      commandType: "watchlist.add",
      payload: { symbol: "MSFT" }
    });

    const brief = buildMobileBrief({
      readiness: mobileReadiness(userId),
      portfolio: { totalMarketValue: 12345, buyingPower: 6789 },
      pendingProposals: [{ executionMode: "broker/live" }],
      positions: [{ symbol: "MSFT" }],
      alerts: [{ status: "active" }],
      recentCommands: [{ status: "failed" }],
      marketSession: { label: "Closed", isOpen: false },
      generatedAt: "2026-07-22T00:00:00.000Z"
    });

    expect(brief.headline).toContain("Setup needed");
    expect(brief.summary).toContain("Closed market");
    expect(brief.items.find((item) => item.label === "Queue")).toMatchObject({ value: "1 queued / 0 running", tone: "warn" });
    expect(brief.items.find((item) => item.label === "Recent failures")).toMatchObject({ value: "1", tone: "danger" });
    expect(brief.generatedAt).toBe("2026-07-22T00:00:00.000Z");
  });

  it("keeps command reads scoped to the authenticated user", async () => {
    const { queueMobileCommand, getMobileCommand, listMobileCommands } = await import("../src/lib/mobile-api");
    const owner = `owner-${randomUUID()}`;
    const other = `other-${randomUUID()}`;

    const queued = queueMobileCommand({
      userId: owner,
      commandType: "watchlist.add",
      payload: { symbol: "MSFT" }
    });

    expect(getMobileCommand(queued.command.id, owner)).toBeTruthy();
    expect(getMobileCommand(queued.command.id, other)).toBeUndefined();
    expect(listMobileCommands({ userId: other })).toHaveLength(0);
  });
});

describe("mobile account deletion", () => {
  it("requires a current request, exact identity, and exact phrase before deleting user data", async () => {
    const { ACCOUNT_DELETE_PHRASE, confirmAndDeleteAccount, prepareAccountDeletion } = await import("../src/lib/account-deletion");
    const { userIdForEmail } = await import("../src/lib/auth/identity");
    const { getDb, setUserSetting, upsertConnectedAccount } = await import("../src/lib/db");
    const { addToWatchlist, listWatchlist } = await import("../src/lib/watchlist");
    const email = "delete@example.com";
    const user = { userId: userIdForEmail(email), email };
    const acknowledgements = {
      deleteAppData: true,
      deleteBrokerConnections: true,
      understandBrokerPositionsRemain: true,
      understandProviderRevocation: true,
      understandCanSignInAgain: true
    };

    setUserSetting(user.userId, "example", { ok: true });
    upsertConnectedAccount({
      id: randomUUID(),
      userId: user.userId,
      broker: "test",
      environment: "paper",
      accountNumber: "TEST",
      label: "Test",
      isActive: true
    });
    addToWatchlist(user.userId, "AAPL");

    await expect(
      confirmAndDeleteAccount({
        userId: user.userId,
        email: user.email,
        body: {
          typedEmail: user.email,
          typedPhrase: ACCOUNT_DELETE_PHRASE,
          ...acknowledgements
        }
      })
    ).rejects.toThrow("Prepare account deletion first.");

    prepareAccountDeletion(user);
    await expect(
      confirmAndDeleteAccount({
        userId: user.userId,
        email: user.email,
        body: {
          typedEmail: "wrong@example.com",
          typedPhrase: ACCOUNT_DELETE_PHRASE,
          ...acknowledgements
        }
      })
    ).rejects.toThrow("Typed email does not match the signed-in account.");

    const result = await confirmAndDeleteAccount({
      userId: user.userId,
      email: user.email,
      body: {
        typedEmail: user.email,
        typedPhrase: ACCOUNT_DELETE_PHRASE,
        ...acknowledgements
      }
    });

    expect(result.ok).toBe(true);
    expect(result.logoutUrl).toBe("/logout");
    expect(listWatchlist(user.userId)).toEqual([]);
    expect(result.counts.connected_accounts).toBeGreaterThanOrEqual(1);
    expect(result.counts.user_settings).toBeGreaterThanOrEqual(1);
    const requestRow = getDb()
      .prepare("SELECT id FROM account_deletion_requests WHERE user_id = ?")
      .get(user.userId);
    expect(requestRow).toBeUndefined();
  });
});

describe("serializeMobileNotifications", () => {
  it("strips payload and webhook URL from Activity rows", async () => {
    const { serializeMobileNotifications } = await import("../src/lib/mobile-api");
    const rows = serializeMobileNotifications([
      {
        id: "n-1",
        createdAt: "2026-08-20T00:00:00.000Z",
        type: "run_failed",
        title: "Strategy run failed",
        status: "sent",
        webhookUrl: "https://hooks.example/secret",
        payload: { runId: "run-1", reason: "llm" },
        connectedAccountId: "acct-1"
      }
    ]);
    expect(rows).toEqual([
      {
        id: "n-1",
        type: "run_failed",
        title: "Strategy run failed",
        createdAt: "2026-08-20T00:00:00.000Z",
        status: "sent",
        acknowledgedAt: null,
        connectedAccountId: "acct-1"
      }
    ]);
    expect(rows[0]).not.toHaveProperty("payload");
    expect(rows[0]).not.toHaveProperty("webhookUrl");
  });
});
