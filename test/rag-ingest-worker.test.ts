import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-sec-ingest-${randomUUID()}.db`)}`;
});

async function createJob(suffix: string) {
  const {
    buildSecIngestJobKey,
    createSecIngestJob,
    transitionSecIngestJob
  } = await import("../src/lib/db");
  const idempotencyKey = buildSecIngestJobKey({
    corpusRevision: "sec-v2",
    universeSnapshotId: "universe-2026-07-13",
    scope: { suffix }
  });
  const job = createSecIngestJob({
    idempotencyKey,
    corpusRevision: "sec-v2",
    universeSnapshotId: "universe-2026-07-13",
    config: { wave: "fixture", suffix }
  });
  expect(transitionSecIngestJob(job.id, "running", { expected: "pending" })).toBe(true);
  return job;
}

describe("SEC/RAG durable ingest worker state", () => {
  it("uses canonical deterministic replay keys and never duplicates or resurrects a task", async () => {
    const {
      buildSecIngestJobKey,
      buildSecIngestTaskKey,
      createSecIngestJob,
      enqueueSecIngestTask,
      getDb,
      transitionSecIngestJob
    } = await import("../src/lib/db");
    const firstKey = buildSecIngestJobKey({
      corpusRevision: "sec-v2",
      scope: { z: 3, a: { y: 2, x: 1 } }
    });
    const reorderedKey = buildSecIngestJobKey({
      scope: { a: { x: 1, y: 2 }, z: 3 },
      corpusRevision: "sec-v2"
    });
    expect(firstKey).toBe(reorderedKey);

    const first = createSecIngestJob({
      idempotencyKey: firstKey,
      corpusRevision: "sec-v2",
      config: { b: 2, a: 1 }
    });
    const replay = createSecIngestJob({
      idempotencyKey: reorderedKey,
      corpusRevision: "sec-v2",
      config: { a: 1, b: 2 }
    });
    expect(replay.id).toBe(first.id);
    expect(() =>
      createSecIngestJob({
        idempotencyKey: firstKey,
        corpusRevision: "sec-v3",
        config: { a: 1, b: 2 }
      })
    ).toThrow("replay conflict");
    expect(transitionSecIngestJob(first.id, "running")).toBe(true);

    const taskKey = buildSecIngestTaskKey({
      accession: "0000320193-26-000001",
      sequence: 1,
      documentName: "aapl-20260926.htm",
      parserRevision: "dom-v1",
      embedRevision: "1"
    });
    const inserted = enqueueSecIngestTask({
      jobId: first.id,
      taskKey,
      accession: "0000320193-26-000001",
      cik: "0000320193",
      symbol: "AAPL",
      sequence: 1,
      documentName: "aapl-20260926.htm",
      payload: { b: 2, a: 1 },
      parserRevision: "dom-v1",
      embedRevision: "1"
    });
    const taskReplay = enqueueSecIngestTask({
      jobId: first.id,
      taskKey,
      accession: "0000320193-26-000001",
      cik: "0000320193",
      symbol: "AAPL",
      sequence: 1,
      documentName: "aapl-20260926.htm",
      payload: { a: 1, b: 2 },
      parserRevision: "dom-v1",
      embedRevision: "1"
    });
    expect(inserted.inserted).toBe(true);
    expect(taskReplay.inserted).toBe(false);
    expect(taskReplay.task.id).toBe(inserted.task.id);
    expect(() =>
      enqueueSecIngestTask({
        jobId: first.id,
        taskKey,
        accession: "different-accession",
        payload: { a: 1, b: 2 }
      })
    ).toThrow("replay conflict");
    expect(() =>
      enqueueSecIngestTask({
        jobId: first.id,
        taskKey,
        accession: "0000320193-26-000001",
        cik: "0000320193",
        symbol: "AAPL",
        sequence: 1,
        documentName: "aapl-20260926.htm",
        payload: { a: 1, b: 2 },
        parserRevision: "dom-v2",
        embedRevision: "1"
      })
    ).toThrow("replay conflict");
    const counts = getDb()
      .prepare("SELECT COUNT(*) AS jobs, (SELECT COUNT(*) FROM sec_ingest_tasks WHERE job_id = ?) AS tasks FROM sec_ingest_jobs WHERE id = ?")
      .get(first.id, first.id) as { jobs: number; tasks: number };
    expect(counts).toEqual({ jobs: 1, tasks: 1 });
  });

  it("does not hide caller-supplied primary-key collisions behind idempotent replay", async () => {
    const { createSecIngestJob, enqueueSecIngestTask, transitionSecIngestJob } = await import("../src/lib/db");
    const sharedJobId = randomUUID();
    const first = createSecIngestJob({
      id: sharedJobId,
      idempotencyKey: `job-key-${randomUUID()}`,
      corpusRevision: "sec-v2"
    });
    expect(() =>
      createSecIngestJob({
        id: sharedJobId,
        idempotencyKey: `different-job-key-${randomUUID()}`,
        corpusRevision: "sec-v2"
      })
    ).toThrow("UNIQUE constraint failed");
    expect(transitionSecIngestJob(first.id, "running")).toBe(true);
    const sharedTaskId = randomUUID();
    enqueueSecIngestTask({ id: sharedTaskId, jobId: first.id, taskKey: "task-a", accession: "accession-a" });
    expect(() =>
      enqueueSecIngestTask({ id: sharedTaskId, jobId: first.id, taskKey: "task-b", accession: "accession-b" })
    ).toThrow("UNIQUE constraint failed");
  });

  it("allows an omitted expected count to replay after discovered intake is sealed", async () => {
    const { createSecIngestJob, enqueueSecIngestTask, sealSecIngestJobIntake, transitionSecIngestJob } = await import("../src/lib/db");
    const idempotencyKey = `sealed-replay-${randomUUID()}`;
    const first = createSecIngestJob({ idempotencyKey, corpusRevision: "sec-v2" });
    expect(transitionSecIngestJob(first.id, "running")).toBe(true);
    enqueueSecIngestTask({ jobId: first.id, accession: "sealed-replay-accession" });
    expect(sealSecIngestJobIntake(first.id)).toBe(true);

    expect(createSecIngestJob({ idempotencyKey, corpusRevision: "sec-v2" })).toMatchObject({
      id: first.id,
      expectedTasks: 1
    });
    expect(() => createSecIngestJob({ idempotencyKey, corpusRevision: "sec-v2", expectedTasks: 2 })).toThrow(
      "replay conflict"
    );
  });

  it("atomically reclaims an expired lease and fences the stale worker's heartbeat and transition", async () => {
    const {
      advanceSecIngestTask,
      claimSecIngestTasks,
      enqueueSecIngestTask,
      getDb,
      heartbeatSecIngestTask
    } = await import("../src/lib/db");
    const job = await createJob(`lease-${randomUUID()}`);
    const task = enqueueSecIngestTask({ jobId: job.id, accession: "lease-accession" }).task;
    const start = new Date("2026-07-13T12:00:00.000Z");
    const [first] = claimSecIngestTasks(job.id, { owner: "worker-1", leaseMs: 1_000, now: start });
    expect(first.id).toBe(task.id);
    expect(claimSecIngestTasks(job.id, { owner: "worker-2", leaseMs: 1_000, now: new Date(start.getTime() + 999) })).toEqual([]);

    const [takeover] = claimSecIngestTasks(job.id, {
      owner: "worker-2",
      leaseMs: 1_000,
      now: new Date(start.getTime() + 1_000)
    });
    expect(takeover.id).toBe(task.id);
    expect(takeover.leaseToken).not.toBe(first.leaseToken);
    expect(
      heartbeatSecIngestTask({
        taskId: task.id,
        owner: "worker-1",
        leaseToken: first.leaseToken!,
        leaseMs: 1_000,
        now: new Date(start.getTime() + 1_100)
      })
    ).toBe(false);
    expect(
      advanceSecIngestTask({
        taskId: task.id,
        owner: "worker-1",
        leaseToken: first.leaseToken!,
        expectedCheckpoint: "discovered",
        nextCheckpoint: "fetched",
        now: new Date(start.getTime() + 1_100)
      })
    ).toBe(false);
    expect(
      heartbeatSecIngestTask({
        taskId: task.id,
        owner: "worker-2",
        leaseToken: takeover.leaseToken!,
        leaseMs: 1_000,
        now: new Date(start.getTime() + 1_100)
      })
    ).toBe(true);
    expect(
      advanceSecIngestTask({
        taskId: task.id,
        owner: "worker-2",
        leaseToken: takeover.leaseToken!,
        expectedCheckpoint: "discovered",
        nextCheckpoint: "fetched",
        now: new Date(start.getTime() + 1_200)
      })
    ).toBe(true);
    const outcomes = getDb()
      .prepare("SELECT outcome FROM sec_ingest_task_attempts WHERE task_id = ? ORDER BY attempt_no")
      .all(task.id) as Array<{ outcome: string }>;
    expect(outcomes.map((row) => row.outcome)).toEqual(["lease_expired", "advanced"]);
  });

  it("falls back to a finite default for malformed claim and heartbeat lease durations", async () => {
    const { claimSecIngestTasks, enqueueSecIngestTask, getSecIngestTask, heartbeatSecIngestTask } = await import("../src/lib/db");
    const job = await createJob(`lease-config-${randomUUID()}`);
    const task = enqueueSecIngestTask({ jobId: job.id, accession: "lease-config-accession" }).task;
    const start = new Date("2026-07-13T12:30:00.000Z");
    const [claim] = claimSecIngestTasks(job.id, {
      owner: "worker",
      leaseMs: Number.NaN,
      now: start
    });
    expect(claim.leaseExpiresAt).toBe("2026-07-13T12:35:00.000Z");
    expect(heartbeatSecIngestTask({
      taskId: task.id,
      owner: "worker",
      leaseToken: claim.leaseToken!,
      leaseMs: Number.POSITIVE_INFINITY,
      now: new Date("2026-07-13T12:31:00.000Z")
    })).toBe(true);
    expect(getSecIngestTask(task.id)?.leaseExpiresAt).toBe("2026-07-13T12:36:00.000Z");
  });

  it("permits only direct checkpoint transitions and accounts a successful stage exactly once", async () => {
    const { advanceSecIngestTask, claimSecIngestTasks, enqueueSecIngestTask, getSecIngestTask } = await import("../src/lib/db");
    const job = await createJob(`transition-${randomUUID()}`);
    const task = enqueueSecIngestTask({ jobId: job.id, accession: "transition-accession" }).task;
    const now = new Date("2026-07-13T13:00:00.000Z");
    const [claim] = claimSecIngestTasks(job.id, { owner: "worker", now });
    const base = {
      taskId: task.id,
      owner: "worker",
      leaseToken: claim.leaseToken!,
      expectedCheckpoint: "discovered" as const,
      now
    };
    expect(advanceSecIngestTask({ ...base, nextCheckpoint: "parsed" })).toBe(false);
    expect(
      advanceSecIngestTask({
        ...base,
        nextCheckpoint: "fetched",
        rawSha256: "a".repeat(64),
        observations: { bytes: 100, tokens: 25, costUsd: 0.01 },
        receipt: { source: "fixture" }
      })
    ).toBe(true);
    expect(advanceSecIngestTask({ ...base, nextCheckpoint: "fetched" })).toBe(false);
    const stored = getSecIngestTask(task.id)!;
    expect(stored).toMatchObject({
      checkpoint: "fetched",
      status: "pending",
      rawSha256: "a".repeat(64),
      observedBytes: 100,
      observedTokens: 25,
      observedCostUsd: 0.01,
      stageAttempts: 0
    });
  });

  it("preserves task-key revisions and keeps the actual checkpoint authoritative in receipts", async () => {
    const { advanceSecIngestTask, claimSecIngestTasks, enqueueSecIngestTask, getDb, getSecIngestTask } = await import("../src/lib/db");
    const job = await createJob(`identity-${randomUUID()}`);
    const task = enqueueSecIngestTask({
      jobId: job.id,
      accession: "identity-accession",
      parserRevision: "dom-v1",
      chunkerRevision: "chunks-v1",
      embedModel: "voyage-finance-2",
      embedRevision: "1"
    }).task;
    const now = new Date("2026-07-13T13:15:00.000Z");
    const [claim] = claimSecIngestTasks(job.id, { owner: "worker", now });
    const base = {
      taskId: task.id,
      owner: "worker",
      leaseToken: claim.leaseToken!,
      expectedCheckpoint: "discovered" as const,
      nextCheckpoint: "fetched" as const,
      now
    };

    expect(advanceSecIngestTask({ ...base, parserRevision: "dom-v2" })).toBe(false);
    expect(getSecIngestTask(task.id)).toMatchObject({ status: "leased", parserRevision: "dom-v1" });
    expect(
      advanceSecIngestTask({
        ...base,
        parserRevision: "dom-v1",
        chunkerRevision: "chunks-v1",
        embedModel: "voyage-finance-2",
        embedRevision: "1",
        receipt: { checkpoint: "spoofed", source: "fixture" }
      })
    ).toBe(true);
    expect(getSecIngestTask(task.id)).toMatchObject({
      parserRevision: "dom-v1",
      chunkerRevision: "chunks-v1",
      embedModel: "voyage-finance-2",
      embedRevision: "1"
    });
    const attempt = getDb()
      .prepare("SELECT receipt_json FROM sec_ingest_task_attempts WHERE task_id = ?")
      .get(task.id) as { receipt_json: string };
    expect(JSON.parse(attempt.receipt_json)).toEqual({ checkpoint: "fetched", source: "fixture" });
  });

  it("rejects malformed artifact checksums before advancing durable ingest state", async () => {
    const { advanceSecIngestTask, claimSecIngestTasks, enqueueSecIngestTask, getSecIngestTask } = await import("../src/lib/db");
    const job = await createJob(`hash-validation-${randomUUID()}`);
    const task = enqueueSecIngestTask({ jobId: job.id, accession: "hash-validation-accession" }).task;
    const now = new Date("2026-07-13T13:30:00.000Z");
    const [claim] = claimSecIngestTasks(job.id, { owner: "worker", now });
    const base = {
      taskId: task.id,
      owner: "worker",
      leaseToken: claim.leaseToken!,
      expectedCheckpoint: "discovered" as const,
      nextCheckpoint: "fetched" as const,
      now
    };

    expect(() => advanceSecIngestTask({ ...base, rawSha256: "abc123" })).toThrow("rawSha256");
    expect(() => advanceSecIngestTask({ ...base, normalizedSha256: "A".repeat(64) })).toThrow("normalizedSha256");
    expect(getSecIngestTask(task.id)).toMatchObject({ checkpoint: "discovered", status: "leased" });
    expect(advanceSecIngestTask({ ...base, rawSha256: "a".repeat(64) })).toBe(true);
  });

  it("preserves the first accepted raw and normalized artifact checksums across later checkpoints", async () => {
    const { advanceSecIngestTask, claimSecIngestTasks, enqueueSecIngestTask, getSecIngestTask } = await import("../src/lib/db");
    const job = await createJob(`hash-identity-${randomUUID()}`);
    const task = enqueueSecIngestTask({ jobId: job.id, accession: "hash-identity-accession" }).task;
    const start = new Date("2026-07-13T13:40:00.000Z");
    const [fetchClaim] = claimSecIngestTasks(job.id, { owner: "worker", now: start });
    expect(advanceSecIngestTask({
      taskId: task.id,
      owner: "worker",
      leaseToken: fetchClaim.leaseToken!,
      expectedCheckpoint: "discovered",
      nextCheckpoint: "fetched",
      rawSha256: "a".repeat(64),
      now: start
    })).toBe(true);

    const [validateClaim] = claimSecIngestTasks(job.id, { owner: "worker", now: new Date(start.getTime() + 1_000) });
    const validateBase = {
      taskId: task.id,
      owner: "worker",
      leaseToken: validateClaim.leaseToken!,
      expectedCheckpoint: "fetched" as const,
      nextCheckpoint: "validated" as const,
      now: new Date(start.getTime() + 1_000)
    };
    expect(advanceSecIngestTask({ ...validateBase, rawSha256: "b".repeat(64) })).toBe(false);
    expect(advanceSecIngestTask({
      ...validateBase,
      rawSha256: "a".repeat(64),
      normalizedSha256: "c".repeat(64)
    })).toBe(true);

    const [parseClaim] = claimSecIngestTasks(job.id, { owner: "worker", now: new Date(start.getTime() + 2_000) });
    const parseBase = {
      taskId: task.id,
      owner: "worker",
      leaseToken: parseClaim.leaseToken!,
      expectedCheckpoint: "validated" as const,
      nextCheckpoint: "parsed" as const,
      now: new Date(start.getTime() + 2_000)
    };
    expect(advanceSecIngestTask({ ...parseBase, normalizedSha256: "d".repeat(64) })).toBe(false);
    expect(advanceSecIngestTask({ ...parseBase, normalizedSha256: "c".repeat(64) })).toBe(true);
    expect(getSecIngestTask(task.id)).toMatchObject({
      rawSha256: "a".repeat(64),
      normalizedSha256: "c".repeat(64),
      checkpoint: "parsed"
    });
  });

  it("schedules bounded retry backoff, then dead-letters when the stage budget is exhausted", async () => {
    const { claimSecIngestTasks, enqueueSecIngestTask, failSecIngestTask, getDb, getSecIngestTask } = await import("../src/lib/db");
    const job = await createJob(`retry-${randomUUID()}`);
    const task = enqueueSecIngestTask({
      jobId: job.id,
      accession: "retry-accession",
      maxStageAttempts: 2
    }).task;
    const start = new Date("2026-07-13T14:00:00.000Z");
    const [first] = claimSecIngestTasks(job.id, { owner: "worker-1", now: start });
    const retry = failSecIngestTask({
      taskId: task.id,
      owner: "worker-1",
      leaseToken: first.leaseToken!,
      retryable: true,
      errorType: "sec_503",
      error: "upstream unavailable",
      baseBackoffMs: 1_000,
      maxBackoffMs: 1_000,
      retryAfterMs: 5_000,
      jitterRatio: 0,
      now: start
    });
    expect(retry).toEqual({
      applied: true,
      status: "retry_wait",
      nextRetryAt: "2026-07-13T14:00:05.000Z"
    });
    expect(claimSecIngestTasks(job.id, { owner: "worker-2", now: new Date(start.getTime() + 4_999) })).toEqual([]);
    const [second] = claimSecIngestTasks(job.id, { owner: "worker-2", now: new Date(start.getTime() + 5_000) });
    const exhausted = failSecIngestTask({
      taskId: task.id,
      owner: "worker-2",
      leaseToken: second.leaseToken!,
      retryable: true,
      errorType: "sec_503",
      error: "still unavailable",
      now: new Date(start.getTime() + 5_001)
    });
    expect(exhausted).toEqual({ applied: true, status: "dead_letter", nextRetryAt: undefined });
    expect(getSecIngestTask(task.id)).toMatchObject({
      checkpoint: "discovered",
      status: "dead_letter",
      totalAttempts: 2,
      stageAttempts: 2,
      lastErrorType: "sec_503"
    });
    const outcomes = getDb()
      .prepare("SELECT outcome FROM sec_ingest_task_attempts WHERE task_id = ? ORDER BY attempt_no")
      .all(task.id) as Array<{ outcome: string }>;
    expect(outcomes.map((row) => row.outcome)).toEqual(["retry_wait", "dead_letter"]);
  });

  it("rejects blank failure reasons and persists trimmed auditable errors", async () => {
    const { claimSecIngestTasks, enqueueSecIngestTask, failSecIngestTask, getDb, getSecIngestTask } = await import("../src/lib/db");
    const job = await createJob(`failure-reason-${randomUUID()}`);
    const task = enqueueSecIngestTask({ jobId: job.id, accession: "failure-reason-accession" }).task;
    const now = new Date("2026-07-13T14:30:00.000Z");
    const [claim] = claimSecIngestTasks(job.id, { owner: "worker", now });
    const base = {
      taskId: task.id,
      owner: "worker",
      leaseToken: claim.leaseToken!,
      retryable: false,
      now
    };
    expect(() => failSecIngestTask({ ...base, errorType: " ", error: "missing type" })).toThrow("errorType");
    expect(() => failSecIngestTask({ ...base, errorType: "provider_error", error: "\t" })).toThrow("error");
    expect(getSecIngestTask(task.id)?.status).toBe("leased");
    expect(failSecIngestTask({
      ...base,
      errorType: " provider_error ",
      error: " upstream rejected artifact "
    })).toMatchObject({ applied: true, status: "dead_letter" });
    expect(getSecIngestTask(task.id)).toMatchObject({
      lastErrorType: "provider_error",
      lastError: "upstream rejected artifact"
    });
    expect(getDb().prepare(
      "SELECT error_type, error FROM sec_ingest_task_attempts WHERE task_id = ?"
    ).get(task.id)).toEqual({ error_type: "provider_error", error: "upstream rejected artifact" });
  });

  it("sanitizes non-finite and extreme retry settings into a finite date-safe delay", async () => {
    const { computeSecIngestRetryDelayMs } = await import("../src/lib/db");
    const fallback = computeSecIngestRetryDelayMs(Number.NaN, {
      baseBackoffMs: Number.NaN,
      maxBackoffMs: Number.POSITIVE_INFINITY,
      jitterRatio: Number.NaN,
      random: () => Number.NaN
    });
    expect(fallback).toBe(30_000);
    expect(Number.isFinite(fallback)).toBe(true);

    const capped = computeSecIngestRetryDelayMs(Number.POSITIVE_INFINITY, {
      baseBackoffMs: Number.MAX_VALUE,
      maxBackoffMs: Number.MAX_VALUE,
      retryAfterMs: Number.MAX_VALUE,
      jitterRatio: 0
    });
    expect(capped).toBe(30 * 24 * 60 * 60_000);
    expect(() => new Date(Date.now() + capped).toISOString()).not.toThrow();
  });

  it("dead-letters repeated worker crashes when an expired lease exhausts the stage budget", async () => {
    const {
      claimSecIngestTasks,
      enqueueSecIngestTask,
      getDb,
      getSecIngestTask,
      reconcileSecIngestJob,
      sealSecIngestJobIntake
    } = await import("../src/lib/db");
    const job = await createJob(`lease-budget-${randomUUID()}`);
    const task = enqueueSecIngestTask({
      jobId: job.id,
      accession: "crashing-worker-accession",
      maxStageAttempts: 2
    }).task;
    expect(sealSecIngestJobIntake(job.id, 1)).toBe(true);
    const start = new Date("2026-07-13T15:00:00.000Z");
    const [first] = claimSecIngestTasks(job.id, { owner: "worker-1", leaseMs: 1_000, now: start });
    expect(first.stageAttempts).toBe(1);
    const [second] = claimSecIngestTasks(job.id, {
      owner: "worker-2",
      leaseMs: 1_000,
      now: new Date(start.getTime() + 1_000)
    });
    expect(second.stageAttempts).toBe(2);
    expect(
      claimSecIngestTasks(job.id, {
        owner: "worker-3",
        leaseMs: 1_000,
        now: new Date(start.getTime() + 2_000)
      })
    ).toEqual([]);
    expect(getSecIngestTask(task.id)).toMatchObject({
      status: "dead_letter",
      checkpoint: "discovered",
      totalAttempts: 2,
      stageAttempts: 2,
      lastErrorType: "lease_attempts_exhausted"
    });
    const outcomes = getDb()
      .prepare("SELECT outcome FROM sec_ingest_task_attempts WHERE task_id = ? ORDER BY attempt_no")
      .all(task.id) as Array<{ outcome: string }>;
    expect(outcomes.map((row) => row.outcome)).toEqual(["lease_expired", "dead_letter"]);
    expect(reconcileSecIngestJob(job.id)).toBe("complete_with_errors");
  });

  it("requires sealed intake before reconciling and completes with errors without blocking other tasks", async () => {
    const {
      claimSecIngestTasks,
      enqueueSecIngestTask,
      getSecIngestJob,
      reconcileSecIngestJob,
      sealSecIngestJobIntake,
      terminalizeSecIngestTask
    } = await import("../src/lib/db");
    const job = await createJob(`reconcile-${randomUUID()}`);
    enqueueSecIngestTask({ jobId: job.id, accession: "quarantine-accession", ordinal: 1 });
    enqueueSecIngestTask({ jobId: job.id, accession: "superseded-accession", ordinal: 2 });
    expect(reconcileSecIngestJob(job.id)).toBe("running");
    expect(sealSecIngestJobIntake(job.id, 3)).toBe(false);
    expect(sealSecIngestJobIntake(job.id, 2)).toBe(true);
    expect(() => enqueueSecIngestTask({ jobId: job.id, accession: "too-late" })).toThrow("intake is closed");
    const claimed = claimSecIngestTasks(job.id, { owner: "worker", limit: 2 });
    expect(claimed).toHaveLength(2);
    expect(
      terminalizeSecIngestTask({
        taskId: claimed[0].id,
        owner: "worker",
        leaseToken: claimed[0].leaseToken!,
        status: "quarantined",
        reasonType: "parse_shape",
        reason: "malformed iXBRL fixture"
      })
    ).toBe(true);
    expect(
      terminalizeSecIngestTask({
        taskId: claimed[1].id,
        owner: "worker",
        leaseToken: claimed[1].leaseToken!,
        status: "superseded",
        reasonType: "amendment",
        reason: "superseded by amendment"
      })
    ).toBe(true);
    expect(reconcileSecIngestJob(job.id)).toBe("complete_with_errors");
    expect(getSecIngestJob(job.id)).toMatchObject({ status: "complete_with_errors" });
  });

  it("rejects blank terminal reasons before changing the leased task", async () => {
    const { claimSecIngestTasks, enqueueSecIngestTask, getSecIngestTask, terminalizeSecIngestTask } = await import("../src/lib/db");
    const job = await createJob(`terminal-reason-${randomUUID()}`);
    const task = enqueueSecIngestTask({ jobId: job.id, accession: "terminal-reason-accession" }).task;
    const [claim] = claimSecIngestTasks(job.id, { owner: "worker" });
    const base = {
      taskId: task.id,
      owner: "worker",
      leaseToken: claim.leaseToken!,
      status: "quarantined" as const
    };

    expect(() => terminalizeSecIngestTask({ ...base, reasonType: " ", reason: "missing type" })).toThrow("reasonType");
    expect(() => terminalizeSecIngestTask({ ...base, reasonType: "parse_shape", reason: "\t" })).toThrow("reason");
    expect(getSecIngestTask(task.id)).toMatchObject({ status: "leased", checkpoint: "discovered" });
    expect(terminalizeSecIngestTask({ ...base, reasonType: " parse_shape ", reason: " malformed fixture " })).toBe(true);
    expect(getSecIngestTask(task.id)).toMatchObject({
      status: "quarantined",
      lastErrorType: "parse_shape",
      lastError: "malformed fixture"
    });
  });

  it("never lets sealing rewrite a predeclared expected-task contract", async () => {
    const {
      createSecIngestJob,
      enqueueSecIngestTask,
      getSecIngestJob,
      sealSecIngestJobIntake,
      transitionSecIngestJob
    } = await import("../src/lib/db");
    const job = createSecIngestJob({
      idempotencyKey: `fixed-count-${randomUUID()}`,
      corpusRevision: "sec-v2",
      expectedTasks: 2
    });
    expect(transitionSecIngestJob(job.id, "running", { expected: "pending" })).toBe(true);
    enqueueSecIngestTask({ jobId: job.id, accession: "fixed-count-a" });

    expect(sealSecIngestJobIntake(job.id, 1)).toBe(false);
    expect(getSecIngestJob(job.id)).toMatchObject({ expectedTasks: 2, intakeClosedAt: undefined });

    enqueueSecIngestTask({ jobId: job.id, accession: "fixed-count-b" });
    expect(sealSecIngestJobIntake(job.id, 2)).toBe(true);
    expect(getSecIngestJob(job.id)).toMatchObject({ expectedTasks: 2 });
  });

  it("enforces job transition and row-level CHECK constraints even for direct SQL callers", async () => {
    const { enqueueSecIngestTask, getDb, transitionSecIngestJob } = await import("../src/lib/db");
    const job = await createJob(`checks-${randomUUID()}`);
    expect(transitionSecIngestJob(job.id, "pending")).toBe(false);
    expect(transitionSecIngestJob(job.id, "complete")).toBe(false);
    expect(transitionSecIngestJob(job.id, "complete_with_errors")).toBe(false);
    const task = enqueueSecIngestTask({ jobId: job.id, accession: "check-accession" }).task;
    expect(() =>
      getDb().prepare("UPDATE sec_ingest_tasks SET status = 'complete' WHERE id = ?").run(task.id)
    ).toThrow();
    expect(() =>
      getDb()
        .prepare("UPDATE sec_ingest_tasks SET status = 'leased', lease_owner = NULL, lease_token = NULL WHERE id = ?")
        .run(task.id)
    ).toThrow();
    expect(() =>
      getDb()
        .prepare("UPDATE sec_ingest_tasks SET checkpoint = 'complete', status = 'complete' WHERE id = ?")
        .run(task.id)
    ).toThrow();
  });

  it("fences every live-task mutation when the parent job is no longer running", async () => {
    const {
      advanceSecIngestTask,
      claimSecIngestTasks,
      enqueueSecIngestTask,
      failSecIngestTask,
      getSecIngestTask,
      heartbeatSecIngestTask,
      terminalizeSecIngestTask,
      transitionSecIngestJob
    } = await import("../src/lib/db");
    const job = await createJob(`parent-fence-${randomUUID()}`);
    const task = enqueueSecIngestTask({ jobId: job.id, accession: "parent-fence-accession" }).task;
    const now = new Date("2026-07-13T16:00:00.000Z");
    const [claim] = claimSecIngestTasks(job.id, { owner: "worker", now });
    expect(transitionSecIngestJob(job.id, "paused", { expected: "running", now: now.toISOString() })).toBe(true);
    const lease = { taskId: task.id, owner: "worker", leaseToken: claim.leaseToken! };
    expect(heartbeatSecIngestTask({ ...lease, now: new Date(now.getTime() + 1) })).toBe(false);
    expect(
      advanceSecIngestTask({
        ...lease,
        expectedCheckpoint: "discovered",
        nextCheckpoint: "fetched",
        now: new Date(now.getTime() + 1)
      })
    ).toBe(false);
    expect(
      failSecIngestTask({
        ...lease,
        retryable: true,
        errorType: "should_not_write",
        error: "parent paused",
        now: new Date(now.getTime() + 1)
      })
    ).toEqual({ applied: false });
    expect(
      terminalizeSecIngestTask({
        ...lease,
        status: "quarantined",
        reasonType: "should_not_write",
        reason: "parent paused",
        now: new Date(now.getTime() + 1)
      })
    ).toBe(false);
    expect(getSecIngestTask(task.id)).toMatchObject({ status: "leased", checkpoint: "discovered" });
  });

  it("requires a durable verification receipt before the API can complete a task", async () => {
    const { advanceSecIngestTask, claimSecIngestTasks, enqueueSecIngestTask, getDb, getSecIngestTask } = await import("../src/lib/db");
    const job = await createJob(`verification-${randomUUID()}`);
    const task = enqueueSecIngestTask({ jobId: job.id, accession: "verification-accession" }).task;
    getDb().prepare("UPDATE sec_ingest_tasks SET checkpoint = 'verified' WHERE id = ?").run(task.id);
    const now = new Date("2026-07-13T17:00:00.000Z");
    const [claim] = claimSecIngestTasks(job.id, { owner: "worker", now });
    const completion = {
      taskId: task.id,
      owner: "worker",
      leaseToken: claim.leaseToken!,
      expectedCheckpoint: "verified" as const,
      nextCheckpoint: "complete" as const,
      now
    };
    expect(advanceSecIngestTask(completion)).toBe(false);
    expect(advanceSecIngestTask({ ...completion, verification: { vectorsPresent: 12, manifestParity: true } })).toBe(true);
    expect(getSecIngestTask(task.id)).toMatchObject({
      status: "complete",
      checkpoint: "complete",
      verification: { vectorsPresent: 12, manifestParity: true }
    });
  });

  it("rejects invalid claim limits and negative task ordinals before touching durable state", async () => {
    const { claimSecIngestTasks, enqueueSecIngestTask } = await import("../src/lib/db");
    const job = await createJob(`validation-${randomUUID()}`);
    expect(() => enqueueSecIngestTask({ jobId: job.id, accession: "bad-ordinal", ordinal: -1 })).toThrow(
      "non-negative finite integer"
    );
    for (const limit of [0, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => claimSecIngestTasks(job.id, { owner: "worker", limit })).toThrow("positive finite integer");
    }
  });

  it("surfaces a fatal claim receipt write error and atomically rolls back the partial claim", async () => {
    const { claimSecIngestTasks, enqueueSecIngestTask, getDb, getSecIngestTask } = await import("../src/lib/db");
    const job = await createJob(`claim-error-${randomUUID()}`);
    const task = enqueueSecIngestTask({ jobId: job.id, accession: "claim-error-accession" }).task;
    const now = "2026-07-13T18:00:00.000Z";
    getDb()
      .prepare(
        `INSERT INTO sec_ingest_task_attempts (
          task_id, attempt_no, checkpoint, lease_owner, lease_token,
          started_at, heartbeat_at, outcome
        ) VALUES (?, 1, 'discovered', 'fixture', 'fixture-token', ?, ?, 'claimed')`
      )
      .run(task.id, now, now);
    expect(() => claimSecIngestTasks(job.id, { owner: "worker", now: new Date(now) })).toThrow("UNIQUE constraint failed");
    expect(getSecIngestTask(task.id)).toMatchObject({ status: "pending", totalAttempts: 0, stageAttempts: 0 });
  });
});
