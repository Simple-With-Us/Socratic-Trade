import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-db-jobs-${randomUUID()}.db`)}`;
});

describe("db-jobs — durable due-jobs substrate", () => {
  it("enqueueDueJob is idempotent on (job_type, dedupe_key)", async () => {
    const { enqueueDueJob, getDueJobStats } = await import("../src/lib/db");
    const jobType = `test_job_${randomUUID()}`;
    const first = enqueueDueJob({ jobType, dedupeKey: "dupe-1", dueAt: new Date().toISOString() });
    const second = enqueueDueJob({ jobType, dedupeKey: "dupe-1", dueAt: new Date().toISOString() });
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(getDueJobStats(jobType).pending).toBe(1);
  });

  it("claimDueJobs claims only due jobs (due_at <= now), leaving not-yet-due jobs pending", async () => {
    const { enqueueDueJob, claimDueJobs } = await import("../src/lib/db");
    const jobType = `test_job_${randomUUID()}`;
    const now = new Date("2026-07-05T12:00:00.000Z");
    enqueueDueJob({ jobType, dedupeKey: "due", dueAt: new Date(now.getTime() - 60_000).toISOString() });
    enqueueDueJob({ jobType, dedupeKey: "not-due-yet", dueAt: new Date(now.getTime() + 60_000).toISOString() });

    const claimed = claimDueJobs(jobType, { claimant: "worker-1", now });
    expect(claimed).toHaveLength(1);
    expect(claimed[0].dedupeKey).toBe("due");
    expect(claimed[0].status).toBe("claimed");
    expect(claimed[0].attempts).toBe(1);
  });

  it("a second claim of an already-claimed (live-lease) row returns empty — no double-claim race", async () => {
    const { enqueueDueJob, claimDueJobs } = await import("../src/lib/db");
    const jobType = `test_job_${randomUUID()}`;
    const now = new Date("2026-07-05T12:00:00.000Z");
    enqueueDueJob({ jobType, dedupeKey: "race", dueAt: new Date(now.getTime() - 1000).toISOString() });

    const firstClaim = claimDueJobs(jobType, { claimant: "worker-1", leaseMs: 5 * 60_000, now });
    expect(firstClaim).toHaveLength(1);

    // Immediately after — lease still live — a second claimant gets nothing for the same row.
    const secondClaim = claimDueJobs(jobType, { claimant: "worker-2", leaseMs: 5 * 60_000, now: new Date(now.getTime() + 1000) });
    expect(secondClaim).toHaveLength(0);
  });

  it("reclaims a job whose lease has expired (crashed worker never completed it)", async () => {
    const { enqueueDueJob, claimDueJobs } = await import("../src/lib/db");
    const jobType = `test_job_${randomUUID()}`;
    const now = new Date("2026-07-05T12:00:00.000Z");
    enqueueDueJob({ jobType, dedupeKey: "stale", dueAt: new Date(now.getTime() - 1000).toISOString() });

    const firstClaim = claimDueJobs(jobType, { claimant: "worker-1", leaseMs: 1000, now });
    expect(firstClaim).toHaveLength(1);
    expect(firstClaim[0].attempts).toBe(1);

    // worker-1 crashed without completing; lease expires 1000ms later. A drain pass 2 minutes
    // later reclaims it for a different claimant.
    const laterNow = new Date(now.getTime() + 2 * 60_000);
    const reclaimed = claimDueJobs(jobType, { claimant: "worker-2", leaseMs: 5 * 60_000, now: laterNow });
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0].claimedBy).toBe("worker-2");
    expect(reclaimed[0].attempts).toBe(2); // bumped again on the reclaim
  });

  it("failDueJob retries with pushed-out due_at back to 'pending' while attempts remain", async () => {
    const { enqueueDueJob, claimDueJobs, failDueJob, getDueJobStats } = await import("../src/lib/db");
    const jobType = `test_job_${randomUUID()}`;
    const now = new Date("2026-07-05T12:00:00.000Z");
    enqueueDueJob({ jobType, dedupeKey: "retry-me", dueAt: new Date(now.getTime() - 1000).toISOString() });
    const [job] = claimDueJobs(jobType, { claimant: "worker-1", now });

    const nextStatus = failDueJob(job.id, "worker-1", "quote fetch failed", { maxAttempts: 5, retryBackoffMs: 10 * 60_000, now });
    expect(nextStatus).toBe("pending");
    expect(getDueJobStats(jobType).pending).toBe(1);
    expect(getDueJobStats(jobType).claimed).toBe(0);

    // Re-claiming immediately (due_at pushed 10 minutes out) should find nothing yet.
    const tooSoon = claimDueJobs(jobType, { claimant: "worker-2", now: new Date(now.getTime() + 1000) });
    expect(tooSoon).toHaveLength(0);

    // But it IS claimable after the backoff window.
    const afterBackoff = claimDueJobs(jobType, { claimant: "worker-2", now: new Date(now.getTime() + 11 * 60_000) });
    expect(afterBackoff).toHaveLength(1);
    expect(afterBackoff[0].lastError).toBe("quote fetch failed");
  });

  it("failDueJob marks 'unresolvable' once attempts are exhausted", async () => {
    const { enqueueDueJob, claimDueJobs, failDueJob, getDueJobStats } = await import("../src/lib/db");
    const jobType = `test_job_${randomUUID()}`;
    const now = new Date("2026-07-05T12:00:00.000Z");
    enqueueDueJob({ jobType, dedupeKey: "exhaust-me", dueAt: new Date(now.getTime() - 1000).toISOString() });

    let job = claimDueJobs(jobType, { claimant: "worker-1", now })[0];
    // attempts is bumped on claim; drive it to the max via repeated claim+fail cycles.
    let status: string = "pending";
    for (let i = 0; i < 5; i += 1) {
      status = failDueJob(job.id, "worker-1", `attempt ${i} failed`, { maxAttempts: 5, retryBackoffMs: 1000, now });
      if (status === "unresolvable") break;
      const reclaimNow = new Date(now.getTime() + (i + 1) * 2000);
      const reclaimed = claimDueJobs(jobType, { claimant: "worker-1", now: reclaimNow });
      if (reclaimed.length === 0) break;
      job = reclaimed[0];
    }
    expect(status).toBe("unresolvable");
    expect(getDueJobStats(jobType).unresolvable).toBe(1);
  });

  it("failDueJob marks 'unresolvable' once past not_after, even with attempts remaining", async () => {
    const { enqueueDueJob, claimDueJobs, failDueJob } = await import("../src/lib/db");
    const jobType = `test_job_${randomUUID()}`;
    const now = new Date("2026-07-05T12:00:00.000Z");
    enqueueDueJob({
      jobType,
      dedupeKey: "deadline",
      dueAt: new Date(now.getTime() - 1000).toISOString(),
      notAfter: new Date(now.getTime() - 500).toISOString() // window already closed
    });
    const [job] = claimDueJobs(jobType, { claimant: "worker-1", now });

    const status = failDueJob(job.id, "worker-1", "window closed with no sample", { maxAttempts: 5, retryBackoffMs: 1000, now });
    expect(status).toBe("unresolvable");
  });

  it("completeDueJob marks a job done with an optional result payload", async () => {
    const { enqueueDueJob, claimDueJobs, completeDueJob, getDueJobStats } = await import("../src/lib/db");
    const jobType = `test_job_${randomUUID()}`;
    const now = new Date("2026-07-05T12:00:00.000Z");
    enqueueDueJob({ jobType, dedupeKey: "done-me", dueAt: new Date(now.getTime() - 1000).toISOString() });
    const [job] = claimDueJobs(jobType, { claimant: "worker-1", now });

    const wrote = completeDueJob(job.id, "worker-1", { resolution: "ok", returnPct: 1.23 });
    expect(wrote).toBe(true);
    expect(getDueJobStats(jobType).done).toBe(1);
  });

  it("markDueJobUnresolvable transitions a job directly to terminal 'unresolvable'", async () => {
    const { enqueueDueJob, claimDueJobs, markDueJobUnresolvable, getDueJobStats } = await import("../src/lib/db");
    const jobType = `test_job_${randomUUID()}`;
    const now = new Date("2026-07-05T12:00:00.000Z");
    enqueueDueJob({ jobType, dedupeKey: "malformed", dueAt: new Date(now.getTime() - 1000).toISOString() });
    const [job] = claimDueJobs(jobType, { claimant: "worker-1", now });

    const wrote = markDueJobUnresolvable(job.id, "worker-1", "malformed_payload");
    expect(wrote).toBe(true);
    expect(getDueJobStats(jobType).unresolvable).toBe(1);
  });

  it("a done job cannot be resurrected by a non-claimant calling failDueJob/completeDueJob/markDueJobUnresolvable", async () => {
    const {
      enqueueDueJob,
      claimDueJobs,
      completeDueJob,
      failDueJob,
      markDueJobUnresolvable,
      getDueJobStats
    } = await import("../src/lib/db");
    const jobType = `test_job_${randomUUID()}`;
    const now = new Date("2026-07-05T12:00:00.000Z");
    enqueueDueJob({ jobType, dedupeKey: "fenced", dueAt: new Date(now.getTime() - 1000).toISOString() });
    const [job] = claimDueJobs(jobType, { claimant: "worker-1", now });

    // worker-1 legitimately completes the job.
    const completedByOwner = completeDueJob(job.id, "worker-1", { resolution: "ok" }, now.toISOString());
    expect(completedByOwner).toBe(true);
    expect(getDueJobStats(jobType).done).toBe(1);

    // A stale/lease-expired claimant (or any non-owning caller) can no longer mutate the now-'done'
    // row through any of the three terminal-transition functions — each is fenced to
    // status='claimed' AND claimed_by=?, so a 'done' row (or one owned by someone else) never
    // matches and every call is a silent no-op (Finding 2: lost-update-by-stale-worker fix).
    const resurrectedByFail = failDueJob(job.id, "worker-1", "trying to resurrect", { now });
    expect(resurrectedByFail).toBe("done"); // reports the row's actual (unchanged) status
    expect(getDueJobStats(jobType).done).toBe(1);
    expect(getDueJobStats(jobType).pending).toBe(0);
    expect(getDueJobStats(jobType).unresolvable).toBe(0);

    const resurrectedByComplete = completeDueJob(job.id, "worker-2", { resolution: "different" }, now.toISOString());
    expect(resurrectedByComplete).toBe(false);
    expect(getDueJobStats(jobType).done).toBe(1);

    const resurrectedByUnresolvable = markDueJobUnresolvable(job.id, "worker-2", "trying to resurrect");
    expect(resurrectedByUnresolvable).toBe(false);
    expect(getDueJobStats(jobType).done).toBe(1);
    expect(getDueJobStats(jobType).unresolvable).toBe(0);
  });

  it("payload round-trips through JSON exactly, and carries user/account scoping", async () => {
    const { enqueueDueJob, claimDueJobs } = await import("../src/lib/db");
    const jobType = `test_job_${randomUUID()}`;
    const now = new Date("2026-07-05T12:00:00.000Z");
    enqueueDueJob({
      jobType,
      dedupeKey: "payload-check",
      dueAt: new Date(now.getTime() - 1000).toISOString(),
      payload: { symbol: "AAPL", horizon: "15m", basisPrice: 100.5 },
      userId: "user-42",
      connectedAccountId: "acct-1"
    });
    const [job] = claimDueJobs(jobType, { claimant: "worker-1", now });
    expect(job.payload).toEqual({ symbol: "AAPL", horizon: "15m", basisPrice: 100.5 });
    expect(job.userId).toBe("user-42");
    expect(job.connectedAccountId).toBe("acct-1");
  });
});
