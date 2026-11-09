import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OPERATION_LEASE_GROUPS,
  resetOperationLeaseForTest,
  runWithOperationLease,
  type OperationLeaseGroup
} from "../src/lib/operation-lease";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-operation-lease-${randomUUID()}.db`)}`;
});

beforeEach(() => {
  resetOperationLeaseForTest();
});

afterEach(() => {
  vi.useRealTimers();
  resetOperationLeaseForTest();
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function startHolder(group: OperationLeaseGroup, operation: string, options: { ttlMs?: number; heartbeatMs?: number } = {}) {
  const entered = deferred();
  const release = deferred();
  const result = runWithOperationLease(
    { group, operation, ...options },
    async () => {
      entered.resolve();
      await release.promise;
      return operation;
    }
  );
  await entered.promise;
  return { result, release };
}

describe("durable provider operation lease", () => {
  it("excludes a competing owner, reports the active operation, then admits work after release", async () => {
    const group = OPERATION_LEASE_GROUPS.RAG_REINDEX;
    const holder = await startHolder(group, "scheduled-filing-ingest");

    const blocked = await runWithOperationLease(
      { group, operation: "reindex-8k" },
      async () => "must-not-run"
    );
    expect(blocked).toMatchObject({
      acquired: false,
      busy: {
        status: "busy",
        group,
        operation: "reindex-8k",
        activeOperation: "scheduled-filing-ingest",
        retryAfterSeconds: expect.any(Number)
      }
    });

    holder.release.resolve();
    await expect(holder.result).resolves.toMatchObject({ acquired: true, value: "scheduled-filing-ingest" });
    await expect(runWithOperationLease(
      { group, operation: "reindex-8k" },
      async () => "accepted"
    )).resolves.toEqual({ acquired: true, value: "accepted" });
  });

  it("heartbeats a live long-running owner so its TTL cannot be stolen", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T12:00:00.000Z"));
    const group = OPERATION_LEASE_GROUPS.CONGRESS_SHARE;
    const holder = await startHolder(group, "nightly-congress-share", { ttlMs: 90, heartbeatMs: 20 });

    await vi.advanceTimersByTimeAsync(240);
    const blocked = await runWithOperationLease(
      { group, operation: "congress-share", ttlMs: 90, heartbeatMs: 20 },
      async () => "must-not-run"
    );
    expect(blocked).toMatchObject({ acquired: false, busy: { activeOperation: "nightly-congress-share" } });

    holder.release.resolve();
    await holder.result;
  });

  it("rejects a timer-starved stale owner without releasing its successor claim", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T12:00:00.000Z"));
    const group = OPERATION_LEASE_GROUPS.CONGRESS_WEB_SOURCE;
    const old = await startHolder(group, "old-refresh", { ttlMs: 100, heartbeatMs: 10_000 });

    await vi.advanceTimersByTimeAsync(101);
    const successor = await startHolder(group, "successor-refresh", { ttlMs: 1_000, heartbeatMs: 100 });

    // The old callback resumes before its deliberately delayed heartbeat. Its final persisted
    // ownership proof must reject stale success even though the AbortSignal has not fired yet.
    old.release.resolve();
    await expect(old.result).rejects.toThrow("no longer owns group");
    const third = await runWithOperationLease(
      { group, operation: "third-refresh" },
      async () => "must-not-run"
    );
    expect(third).toMatchObject({ acquired: false, busy: { activeOperation: "successor-refresh" } });

    successor.release.resolve();
    await successor.result;
  });

  it("reuses an opaque claim for the matching nested core boundary", async () => {
    const group = OPERATION_LEASE_GROUPS.SEC8K_WEB_SOURCE;
    const outer = await runWithOperationLease(
      { group, operation: "refresh-websource" },
      async (claim) => runWithOperationLease(
        { group, operation: "refresh-websource:sec8k", claim },
        async () => "nested-complete"
      )
    );
    expect(outer).toEqual({
      acquired: true,
      value: { acquired: true, value: "nested-complete" }
    });
  });

  it("aborts and rejects a live callback when its heartbeat can no longer prove ownership", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T12:00:00.000Z"));
    const group = OPERATION_LEASE_GROUPS.CONGRESS_SHARE;
    const entered = deferred();
    const finish = deferred();
    const run = runWithOperationLease(
      { group, operation: "holder", ttlMs: 100, heartbeatMs: 20 },
      async (_claim, signal) => {
        entered.resolve();
        await finish.promise;
        expect(signal.aborted).toBe(true);
        return "must-not-succeed";
      }
    );
    await entered.promise;

    resetOperationLeaseForTest(group);
    await vi.advanceTimersByTimeAsync(20);
    finish.resolve();
    await expect(run).rejects.toThrow("heartbeat could not prove ownership");
  });

  it("rejects a claim presented to a different operation group", async () => {
    await expect(runWithOperationLease(
      { group: OPERATION_LEASE_GROUPS.CONGRESS_WEB_SOURCE, operation: "outer" },
      async (claim) => runWithOperationLease(
        { group: OPERATION_LEASE_GROUPS.SEC8K_WEB_SOURCE, operation: "wrong", claim },
        async () => "must-not-run"
      )
    )).rejects.toThrow("does not authorize group");
  });

  it("rejects a once-valid nested claim after its expired lease has been stolen", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T12:00:00.000Z"));
    const group = OPERATION_LEASE_GROUPS.RAG_REINDEX;
    const successorRelease = deferred();

    const outer = runWithOperationLease(
      { group, operation: "old-admin-guard", ttlMs: 100, heartbeatMs: 10_000 },
      async (claim) => {
        await vi.advanceTimersByTimeAsync(101);
        const successorEntered = deferred();
        const successor = runWithOperationLease(
          { group, operation: "successor", ttlMs: 1_000, heartbeatMs: 100 },
          async () => {
            successorEntered.resolve();
            await successorRelease.promise;
          }
        );
        await successorEntered.promise;

        await expect(runWithOperationLease(
          { group, operation: "stale-nested-core", claim },
          async () => "must-not-run"
        )).rejects.toThrow("no longer owns group");

        successorRelease.resolve();
        await successor;
      }
    );

    await expect(outer).rejects.toThrow("no longer owns group");
  });
});
