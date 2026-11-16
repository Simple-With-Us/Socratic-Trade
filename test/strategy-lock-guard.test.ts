import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let guardModule: typeof import("../src/lib/strategy-lock-guard");
let lockDb: Pick<
  typeof import("../src/lib/db"),
  "acquireStrategyLock" | "getDb" | "releaseStrategyLock" | "renewStrategyLock"
>;

beforeAll(async () => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-strategy-lock-guard-${randomUUID()}.db`)}`;
  guardModule = await import("../src/lib/strategy-lock-guard");
  const db = await import("../src/lib/db");
  lockDb = {
    acquireStrategyLock: db.acquireStrategyLock,
    getDb: db.getDb,
    releaseStrategyLock: db.releaseStrategyLock,
    renewStrategyLock: db.renewStrategyLock
  };
});

beforeEach(() => {
  vi.useRealTimers();
  lockDb.getDb().prepare("DELETE FROM settings WHERE key LIKE 'strategy_run_lock:%'").run();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("strategy lock ownership", () => {
  it("mints a unique approval owner per same-proposal invocation, so the loser cannot release the winner", () => {
    const proposalId = randomUUID();
    const userId = `owner-${randomUUID()}`;
    const accountId = `account-${randomUUID()}`;
    const ownerA = guardModule.createExecuteProposalLockOwner(proposalId);
    const ownerB = guardModule.createExecuteProposalLockOwner(proposalId);

    expect(ownerA).not.toBe(ownerB);
    expect(ownerA).toMatch(new RegExp(`^execute-${proposalId}-`));
    expect(lockDb.acquireStrategyLock(ownerA, userId, accountId)).toBe(true);
    expect(lockDb.acquireStrategyLock(ownerB, userId, accountId)).toBe(false);

    lockDb.releaseStrategyLock(ownerB, userId, accountId);
    expect(lockDb.renewStrategyLock(ownerA, userId, accountId)).toBe(true);
    expect(lockDb.acquireStrategyLock(ownerB, userId, accountId)).toBe(false);

    lockDb.releaseStrategyLock(ownerA, userId, accountId);
    expect(lockDb.acquireStrategyLock(ownerB, userId, accountId)).toBe(true);
    lockDb.releaseStrategyLock(ownerB, userId, accountId);
  });

  it("renews only the current owner and extends its expiry", () => {
    const userId = `renew-${randomUUID()}`;
    const accountId = `account-${randomUUID()}`;
    const owner = randomUUID();
    const t0 = new Date("2026-07-11T12:00:00.000Z");
    const t1 = new Date(t0.getTime() + 500);

    expect(lockDb.acquireStrategyLock(owner, userId, accountId, 1_000, t0)).toBe(true);
    expect(lockDb.renewStrategyLock("not-owner", userId, accountId, 5_000, t1)).toBe(false);
    expect(lockDb.renewStrategyLock(owner, userId, accountId, 5_000, t1)).toBe(true);

    const row = lockDb.getDb()
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(`strategy_run_lock:${userId}:${accountId}`) as { value: string };
    expect(JSON.parse(row.value)).toMatchObject({
      owner,
      expiresAt: new Date(t1.getTime() + 5_000).toISOString()
    });

    lockDb.releaseStrategyLock(owner, userId, accountId);
  });
});

describe("strategy lock heartbeat guard", () => {
  it("handles a refused interval renewal without throwing from the timer and then fails closed", () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const renew = vi.fn(() => false);
    const guard = guardModule.startStrategyLockGuard(
      { owner: "owner", userId: "user", heartbeatMs: 25 },
      { renew }
    );

    expect(() => vi.advanceTimersByTime(25)).not.toThrow();
    expect(() => guard.assertOwned()).toThrow(guardModule.StrategyLockOwnershipLostError);
    expect(renew).toHaveBeenCalledTimes(1);
    guard.stop();
  });

  it("handles a thrown interval renewal without an uncaught timer error and then fails closed", () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const renew = vi.fn(() => {
      throw new Error("database unavailable");
    });
    const guard = guardModule.startStrategyLockGuard(
      { owner: "owner", userId: "user", heartbeatMs: 25 },
      { renew }
    );

    expect(() => vi.advanceTimersByTime(25)).not.toThrow();
    expect(() => guard.assertOwned()).toThrow(guardModule.StrategyLockOwnershipLostError);
    expect(renew).toHaveBeenCalledTimes(1);
    guard.stop();
  });

  it("re-proves ownership on demand before a money-path step", () => {
    vi.useFakeTimers();
    const renew = vi.fn(() => true);
    const guard = guardModule.startStrategyLockGuard(
      { owner: "owner", userId: "user", heartbeatMs: 25 },
      { renew }
    );

    expect(() => guard.assertOwned()).not.toThrow();
    expect(renew).toHaveBeenCalledTimes(1);
    guard.stop();
  });
});

describe("strategy run setup failure", () => {
  it("stops heartbeat ownership and releases the lease when the run receipt insert throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const db = await import("../src/lib/db");
    const insertSpy = vi.spyOn(db, "insertStrategyRun").mockImplementationOnce(() => {
      throw new Error("strategy run receipt unavailable");
    });
    const { runStrategyOnce } = await import("../src/lib/strategy");
    const userId = `setup-failure-${randomUUID()}`;
    const accountId = `account-${randomUUID()}`;

    const result = await runStrategyOnce(userId, { connectedAccountId: accountId });

    expect(insertSpy).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: "failed",
      summary: "strategy run receipt unavailable"
    });
    expect(db.acquireStrategyLock("replacement-owner", userId, accountId)).toBe(true);
    db.releaseStrategyLock("replacement-owner", userId, accountId);
  });
});
