/**
 * account-write-guards — a disconnected (draining) account must not be reactivated as the live target.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-set-active-draining-${randomUUID()}.db`)}`;
});

describe("setActiveConnectedAccount draining guard", () => {
  it("throws when the account is disconnected and being wound down", async () => {
    const { upsertConnectedAccount, deleteConnectedAccount, setActiveConnectedAccount, getConnectedAccount } =
      await import("../src/lib/db");
    const userId = `u-${randomUUID()}`;
    const accountId = `acct-${randomUUID()}`;

    upsertConnectedAccount({
      id: accountId,
      userId,
      broker: "alpaca",
      environment: "paper",
      accountNumber: "PA-DRAIN",
      label: "Draining",
      isActive: true
    });

    expect(deleteConnectedAccount(accountId, userId)).toBe(true);
    expect(getConnectedAccount(accountId, userId)?.isDraining).toBe(true);

    expect(() => setActiveConnectedAccount(accountId, userId)).toThrow(
      /disconnected and being wound down/i
    );
  });
});
