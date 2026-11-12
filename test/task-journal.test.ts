import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-task-journal-${randomUUID()}.db`)}`;
});

describe("task brain / cron journal", () => {
  it("recordTaskStart + recordTaskEnd round-trips an ok row with derived duration", async () => {
    const { recordTaskStart, recordTaskEnd, listTaskJournal } = await import("../src/lib/db");
    const taskName = `lane_${randomUUID()}`;
    const startedAt = new Date(Date.now() - 1_500).toISOString();
    const id = recordTaskStart({ taskName, userId: "u1", connectedAccountId: "a1", now: startedAt });
    expect(id).toBeTruthy();
    recordTaskEnd(id, { status: "ok", summary: "did work" });

    const rows = listTaskJournal({ taskName });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("ok");
    expect(rows[0].summary).toBe("did work");
    expect(rows[0].userId).toBe("u1");
    expect(rows[0].connectedAccountId).toBe("a1");
    expect(rows[0].durationMs).toBeGreaterThanOrEqual(1_000);
    expect(rows[0].finishedAt).toBeTruthy();
  });

  it("journalLane returns the lane value and journals ok", async () => {
    const { journalLane } = await import("../src/lib/task-journal");
    const { listTaskJournal } = await import("../src/lib/db");
    const taskName = `lane_${randomUUID()}`;
    const value = await journalLane(taskName, {}, () => 42);
    expect(value).toBe(42);
    expect(listTaskJournal({ taskName })[0].status).toBe("ok");
  });

  it("journalLane maps an explicit outcome envelope (status + summary + value)", async () => {
    const { journalLane } = await import("../src/lib/task-journal");
    const { listTaskJournal } = await import("../src/lib/db");
    const taskName = `lane_${randomUUID()}`;
    const value = await journalLane(taskName, {}, () => ({
      status: "skipped" as const,
      summary: "nothing due",
      value: "lane-result"
    }));
    expect(value).toBe("lane-result");
    const row = listTaskJournal({ taskName })[0];
    expect(row.status).toBe("skipped");
    expect(row.summary).toBe("nothing due");
  });

  it("journalLane preserves a skipped envelope that has no value", async () => {
    const { journalLane } = await import("../src/lib/task-journal");
    const { listTaskJournal } = await import("../src/lib/db");
    const taskName = `lane_${randomUUID()}`;
    const value = await journalLane(taskName, {}, () => ({
      status: "skipped" as const,
      summary: "account mutation lease busy"
    }));
    expect(value).toEqual({ status: "skipped", summary: "account mutation lease busy" });
    const row = listTaskJournal({ taskName })[0];
    expect(row.status).toBe("skipped");
    expect(row.summary).toBe("account mutation lease busy");
  });

  it("journalLane does NOT mistake a lane's own { status: 'success' } result for an outcome envelope", async () => {
    const { journalLane } = await import("../src/lib/task-journal");
    const { listTaskJournal } = await import("../src/lib/db");
    const taskName = `lane_${randomUUID()}`;
    const laneResult = { status: "success", detail: 1 };
    const value = await journalLane(taskName, {}, () => laneResult);
    // Bare value passes through untouched (not unwrapped via .value)
    expect(value).toBe(laneResult);
    expect(listTaskJournal({ taskName })[0].status).toBe("ok");
  });

  it("journalLane journals status 'error' and re-throws to the caller", async () => {
    const { journalLane } = await import("../src/lib/task-journal");
    const { listTaskJournal } = await import("../src/lib/db");
    const taskName = `lane_${randomUUID()}`;
    await expect(
      journalLane(taskName, {}, () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    const row = listTaskJournal({ taskName })[0];
    expect(row.status).toBe("error");
    expect(row.error).toContain("boom");
  });

  it("listTaskJournal filters by status and respects limit", async () => {
    const { recordTaskStart, recordTaskEnd, listTaskJournal } = await import("../src/lib/db");
    const taskName = `lane_${randomUUID()}`;
    for (let i = 0; i < 5; i++) {
      const id = recordTaskStart({ taskName });
      recordTaskEnd(id, { status: i < 2 ? "error" : "ok", error: i < 2 ? "x" : undefined });
    }
    expect(listTaskJournal({ taskName, status: "error" })).toHaveLength(2);
    expect(listTaskJournal({ taskName, limit: 3 })).toHaveLength(3);
  });

  it("getTaskJournalSummary aggregates per lane", async () => {
    const { recordTaskStart, recordTaskEnd, getTaskJournalSummary } = await import("../src/lib/db");
    const taskName = `lane_${randomUUID()}`;
    const id1 = recordTaskStart({ taskName });
    recordTaskEnd(id1, { status: "ok" });
    const id2 = recordTaskStart({ taskName });
    recordTaskEnd(id2, { status: "error", error: "bad" });
    const summary = getTaskJournalSummary(new Date(Date.now() - 60_000).toISOString());
    const lane = summary.find((s) => s.taskName === taskName);
    expect(lane).toBeTruthy();
    expect(lane!.fires).toBe(2);
    expect(lane!.errors).toBe(1);
    expect(lane!.lastStatus).toBe("error");
  });

  it("pruneTaskJournal keeps all rows (forever retention)", async () => {
    const { recordTaskStart, recordTaskEnd, listTaskJournal, pruneTaskJournal } = await import("../src/lib/db");
    const taskName = `lane_${randomUUID()}`;
    const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1_000);

    const skippedOld = recordTaskStart({ taskName, now: thirtyOneDaysAgo.toISOString() });
    recordTaskEnd(skippedOld, { status: "skipped" }, thirtyOneDaysAgo);
    const okOld = recordTaskStart({ taskName, now: thirtyOneDaysAgo.toISOString() });
    recordTaskEnd(okOld, { status: "ok" }, thirtyOneDaysAgo);

    expect(pruneTaskJournal()).toBe(0);
    expect(listTaskJournal({ taskName })).toHaveLength(2);
  });

  it("journaling never throws: null id and unknown id are silent no-ops", async () => {
    const { recordTaskEnd } = await import("../src/lib/db");
    expect(() => recordTaskEnd(null, { status: "ok" })).not.toThrow();
    expect(() => recordTaskEnd("no-such-row", { status: "ok" })).not.toThrow();
  });
});
