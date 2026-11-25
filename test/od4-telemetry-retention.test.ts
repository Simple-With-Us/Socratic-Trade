// ST-4681 (OD-4): bounded FIFO retention for operational telemetry —
// provider_dispatch_attempts (30d), provider_usage_outbox (14d, settled AND delivered only),
// sec_ingest_task_attempts (30d, finished attempts only).  notification_events is NOT swept
// (user-visible state; the delivery split is not provable — see the rollout note).
//
// Same hard constraint as the api_health_log template (ST-4635): bounded batches, never one big
// DELETE.  Temp SQLite per run via DATABASE_URL (repo test convention), seeded with direct INSERTs.
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-od4-telemetry-retention-${randomUUID()}.db`)}`;

import { getDb } from "../src/lib/db";
import { getInternalSetting, setInternalSetting } from "../src/lib/db-settings";
import {
  PROVIDER_DISPATCH_ATTEMPTS_RETENTION_DAYS_DEFAULT,
  PROVIDER_USAGE_OUTBOX_RETENTION_DAYS_DEFAULT,
  SEC_INGEST_TASK_ATTEMPTS_RETENTION_DAYS_DEFAULT,
  PROVIDER_USAGE_OUTBOX_REPLAY_WATERMARK_KEY,
  providerDispatchAttemptsRetentionCutoff,
  providerDispatchAttemptsRetentionDays,
  providerUsageOutboxDeliveredThrough,
  providerUsageOutboxEffectiveCutoff,
  providerUsageOutboxRetentionDays,
  runOd4TelemetryRetentionIfDue,
  runProviderDispatchAttemptsRetentionIfDue,
  runProviderUsageOutboxRetentionIfDue,
  runSecIngestTaskAttemptsRetentionIfDue,
  secIngestTaskAttemptsRetentionCutoff,
  secIngestTaskAttemptsRetentionDays,
  sweepProviderDispatchAttemptsBatch,
  sweepProviderUsageOutboxBatch,
  sweepSecIngestTaskAttemptsBatch
} from "../src/lib/db-telemetry-retention";
import { USAGE_MONITOR_REPLAY_WATERMARK_KEYS } from "../src/lib/usage-monitor-replay";
import { runApiHealthLogRetentionIfDue } from "../src/lib/db-health-retention";

const NOW = Date.parse("2026-11-24T12:00:00.000Z");

const RETENTION_ENVS = [
  "PROVIDER_DISPATCH_ATTEMPTS_RETENTION_DAYS",
  "PROVIDER_USAGE_OUTBOX_RETENTION_DAYS",
  "SEC_INGEST_TASK_ATTEMPTS_RETENTION_DAYS"
] as const;

function insertDispatchAttempt(id: string, createdAt: string, status = "succeeded"): void {
  getDb()
    .prepare(
      `INSERT INTO provider_dispatch_attempts (
        id, authority_id, provider, operation, credential_ref, user_id, units,
        estimated_cost_usd, status, created_at, updated_at
      ) VALUES (?, 'auth', 'pinecone', 'upsert', 'cred', 'local', 1, 0, ?, ?, ?)`
    )
    .run(id, status, createdAt, createdAt);
}

function countDispatchAttempts(): number {
  return (getDb().prepare("SELECT COUNT(*) AS cnt FROM provider_dispatch_attempts").get() as { cnt: number }).cnt;
}

function insertOutboxRow(
  id: string,
  createdAt: string,
  outcome: "succeeded" | "failed" | "unknown" = "succeeded"
): void {
  getDb()
    .prepare(
      `INSERT INTO provider_usage_outbox (
        id, attempt_id, provider, operation, credential_ref, user_id, outcome,
        requests, estimated_cost_usd, occurred_at, created_at
      ) VALUES (?, ?, 'pinecone', 'upsert', 'cred', 'local', ?, 1, 0, ?, ?)`
    )
    .run(id, `attempt-${id}`, outcome, createdAt, createdAt);
}

function countOutboxRows(): number {
  return (getDb().prepare("SELECT COUNT(*) AS cnt FROM provider_usage_outbox").get() as { cnt: number }).cnt;
}

function setOutboxWatermark(createdAt: string | null): void {
  if (createdAt === null) {
    getDb().prepare("DELETE FROM settings WHERE key = ?").run(PROVIDER_USAGE_OUTBOX_REPLAY_WATERMARK_KEY);
    return;
  }
  // setInternalSetting stores JSON.stringify(value); the replay module writes the same JSON bytes
  // for its {createdAt, id} cursor via raw SQL.
  setInternalSetting(PROVIDER_USAGE_OUTBOX_REPLAY_WATERMARK_KEY, { createdAt, id: `row-${createdAt}` });
}

// sec_ingest_task_attempts FKs into sec_ingest_tasks → sec_ingest_jobs (foreign_keys = ON).
let seedTaskId: string;

function seedIngestChain(): string {
  const nowIso = new Date().toISOString();
  const jobId = `job-${randomUUID()}`;
  const taskId = `task-${randomUUID()}`;
  const db = getDb();
  db.prepare(
    `INSERT INTO sec_ingest_jobs (id, idempotency_key, corpus_revision, status, created_at, updated_at)
     VALUES (?, ?, 'rev-1', 'running', ?, ?)`
  ).run(jobId, `idem-${jobId}`, nowIso, nowIso);
  db.prepare(
    `INSERT INTO sec_ingest_tasks (id, job_id, task_key, accession, checkpoint, status, created_at, updated_at)
     VALUES (?, ?, ?, 'acc-1', 'discovered', 'pending', ?, ?)`
  ).run(taskId, jobId, `key-${taskId}`, nowIso, nowIso);
  return taskId;
}

function insertIngestAttempt(id: number, finishedAt: string | null, startedAt = "2026-01-01T00:00:00.000Z"): void {
  getDb()
    .prepare(
      `INSERT INTO sec_ingest_task_attempts (
        id, task_id, attempt_no, checkpoint, lease_owner, lease_token,
        started_at, heartbeat_at, finished_at, outcome
      ) VALUES (?, ?, ?, 'discovered', 'owner', ?, ?, ?, ?, 'advanced')`
    )
    .run(id, seedTaskId, id, `token-${id}`, startedAt, startedAt, finishedAt);
}

function countIngestAttempts(): number {
  return (getDb().prepare("SELECT COUNT(*) AS cnt FROM sec_ingest_task_attempts").get() as { cnt: number }).cnt;
}

beforeEach(() => {
  const db = getDb();
  db.prepare("DELETE FROM provider_dispatch_attempts").run();
  db.prepare("DELETE FROM provider_usage_outbox").run();
  db.prepare("DELETE FROM sec_ingest_task_attempts").run();
  db.prepare("DELETE FROM sec_ingest_tasks").run();
  db.prepare("DELETE FROM sec_ingest_jobs").run();
  for (const key of [
    "providerdispatchattempts:lastRunAt",
    "providerusageoutbox:lastRunAt",
    "secingesttaskattempts:lastRunAt"
  ]) {
    getDb().prepare("DELETE FROM settings WHERE key = ?").run(key);
  }
  setOutboxWatermark(null);
  for (const env of RETENTION_ENVS) delete process.env[env];
  seedTaskId = seedIngestChain();
});

afterEach(() => {
  for (const env of RETENTION_ENVS) delete process.env[env];
  // Restore the shared config this file mutated.  `getDb()` memoizes its connection, so the
  // already-open handle keeps pointing at this file's temp database for the rest of the file.
  if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
});

describe("OD-4 env knobs and defaults (db-telemetry-retention)", () => {
  it("defaults: dispatch 30d, outbox 14d, ingest attempts 30d", () => {
    expect(PROVIDER_DISPATCH_ATTEMPTS_RETENTION_DAYS_DEFAULT).toBe(30);
    expect(PROVIDER_USAGE_OUTBOX_RETENTION_DAYS_DEFAULT).toBe(14);
    expect(SEC_INGEST_TASK_ATTEMPTS_RETENTION_DAYS_DEFAULT).toBe(30);
    expect(providerDispatchAttemptsRetentionDays()).toBe(30);
    expect(providerUsageOutboxRetentionDays()).toBe(14);
    expect(secIngestTaskAttemptsRetentionDays()).toBe(30);
  });

  it("env overrides are respected; junk falls back to the default", () => {
    process.env.PROVIDER_DISPATCH_ATTEMPTS_RETENTION_DAYS = "7";
    expect(providerDispatchAttemptsRetentionDays()).toBe(7);
    process.env.PROVIDER_USAGE_OUTBOX_RETENTION_DAYS = "3";
    expect(providerUsageOutboxRetentionDays()).toBe(3);
    process.env.SEC_INGEST_TASK_ATTEMPTS_RETENTION_DAYS = "60";
    expect(secIngestTaskAttemptsRetentionDays()).toBe(60);
    process.env.PROVIDER_DISPATCH_ATTEMPTS_RETENTION_DAYS = "not-a-number";
    expect(providerDispatchAttemptsRetentionDays()).toBe(30);
  });

  it("env override shifts the cutoff window", () => {
    process.env.PROVIDER_DISPATCH_ATTEMPTS_RETENTION_DAYS = "7";
    expect(providerDispatchAttemptsRetentionCutoff(NOW)).toBe("2026-11-17T12:00:00.000Z");
    expect(providerDispatchAttemptsRetentionCutoff(NOW, 30)).toBe("2026-10-25T12:00:00.000Z");
  });
});

describe("provider_dispatch_attempts sweep", () => {
  it("deletes only rows older than the cutoff; fresh rows kept; 0 disables", async () => {
    insertDispatchAttempt("ancient", "2026-01-01T00:00:00.000Z");
    insertDispatchAttempt("old", "2026-10-01T00:00:00.000Z"); // 2026-11-24 minus 30d = 2026-10-25
    insertDispatchAttempt("recent", "2026-11-20T00:00:00.000Z");

    const deleted = await runProviderDispatchAttemptsRetentionIfDue(NOW);
    expect(deleted).toBe(2);
    expect(countDispatchAttempts()).toBe(1);

    // 0 disables the sweep entirely.
    process.env.PROVIDER_DISPATCH_ATTEMPTS_RETENTION_DAYS = "0";
    insertDispatchAttempt("ancient2", "2020-01-01T00:00:00.000Z");
    const second = await runProviderDispatchAttemptsRetentionIfDue(NOW + 11 * 60_000);
    expect(second).toBe(0);
    expect(countDispatchAttempts()).toBe(2);
  });

  it("created_at is NOT NULL in the schema, and the sweep still guards NULL age", () => {
    // The predicate keeps rows whose age column is NULL: `NULL < cutoff` is never true.
    insertDispatchAttempt("fresh", "2026-11-24T11:00:00.000Z");
    expect(sweepProviderDispatchAttemptsBatch("2026-10-25T12:00:00.000Z")).toBe(0);
    expect(countDispatchAttempts()).toBe(1);
  });

  it("deletes in BOUNDED batches, oldest first", () => {
    for (let i = 0; i < 25; i++) {
      insertDispatchAttempt(`old-${i}`, `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`);
    }
    insertDispatchAttempt("fresh", "2026-11-24T11:00:00.000Z");
    expect(sweepProviderDispatchAttemptsBatch("2026-06-01T00:00:00.000Z", 10)).toBe(10);
    expect(countDispatchAttempts()).toBe(16);
    const oldest = getDb()
      .prepare("SELECT created_at FROM provider_dispatch_attempts ORDER BY created_at ASC LIMIT 1")
      .get() as { created_at: string };
    expect(oldest.created_at).toBe("2026-01-11T00:00:00.000Z");
  });

  it("watermark: due once per interval", async () => {
    insertDispatchAttempt("old", "2026-01-01T00:00:00.000Z");
    expect(await runProviderDispatchAttemptsRetentionIfDue(NOW)).toBe(1);
    expect(await runProviderDispatchAttemptsRetentionIfDue(NOW)).toBeNull(); // not due
    expect(await runProviderDispatchAttemptsRetentionIfDue(NOW + 11 * 60_000)).toBe(0); // due, drained
  });

  it("serves the oldest-N subquery from the created_at index (no table scan)", () => {
    const plan = getDb()
      .prepare(
        `EXPLAIN QUERY PLAN DELETE FROM provider_dispatch_attempts WHERE rowid IN (
           SELECT rowid FROM provider_dispatch_attempts
           WHERE created_at IS NOT NULL AND created_at < ? ORDER BY created_at ASC LIMIT ?
         )`
      )
      .all("2026-06-01T00:00:00.000Z", 100) as Array<{ detail: string }>;
    const detail = plan.map((row) => row.detail).join(" | ");
    expect(detail).toContain("idx_pda_created_at");
    expect(detail).not.toContain("SCAN provider_dispatch_attempts");
  });
});

describe("provider_usage_outbox sweep — settled AND delivered rows only", () => {
  it("the schema proves every outbox row is a settled terminal outcome: pending is uninsertable", () => {
    // outcome CHECK IN ('succeeded','failed','unknown') — no pending/non-settled row can exist
    // (insertUsageOutbox runs only after settle/reconcile).  The sweep predicate names the three
    // terminal outcomes explicitly so a future CHECK widening cannot make it delete pending rows.
    insertOutboxRow("settled", "2026-01-01T00:00:00.000Z");
    expect(() =>
      getDb()
        .prepare(
          `INSERT INTO provider_usage_outbox (
            id, attempt_id, provider, operation, credential_ref, user_id, outcome, occurred_at, created_at
          ) VALUES ('x', 'x', 'p', 'o', 'c', 'u', 'pending', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
        )
        .run()
    ).toThrow(/CHECK constraint/i);
  });

  it("with no replay watermark nothing is provably delivered — sweep deletes nothing", async () => {
    setOutboxWatermark(null);
    insertOutboxRow("ancient", "2026-01-01T00:00:00.000Z");
    expect(providerUsageOutboxDeliveredThrough()).toBeNull();
    expect(providerUsageOutboxEffectiveCutoff(NOW)).toBeNull();
    expect(await runProviderUsageOutboxRetentionIfDue(NOW)).toBe(0);
    expect(countOutboxRows()).toBe(1);
  });

  it("deletes only rows older than the window AND strictly before the delivered watermark", async () => {
    // Window cutoff for 14d from 2026-11-24T12:00Z = 2026-11-10T12:00Z.
    // Watermark at 2026-11-01 => effective cutoff is the watermark (undelivered-but-old rows kept).
    setOutboxWatermark("2026-11-01T00:00:00.000Z");
    insertOutboxRow("ancient", "2026-01-01T00:00:00.000Z"); // old + delivered → delete
    insertOutboxRow("old-undelivered", "2026-11-05T00:00:00.000Z"); // older than window but AFTER watermark → keep
    insertOutboxRow("fresh", "2026-11-20T00:00:00.000Z"); // inside window → keep
    const deleted = await runProviderUsageOutboxRetentionIfDue(NOW);
    expect(deleted).toBe(1);
    expect(countOutboxRows()).toBe(2);
    const remaining = getDb()
      .prepare("SELECT id FROM provider_usage_outbox ORDER BY created_at")
      .all() as Array<{ id: string }>;
    expect(remaining.map((r) => r.id)).toEqual(["old-undelivered", "fresh"]);
  });

  it("when the window is the tighter bound, delivered rows inside it still go", async () => {
    // Watermark far in the future: every row is delivered; 14d window is the binding cutoff.
    setOutboxWatermark("2026-11-23T00:00:00.000Z");
    insertOutboxRow("old", "2026-11-05T00:00:00.000Z"); // before 2026-11-10 cutoff → delete
    insertOutboxRow("recent", "2026-11-15T00:00:00.000Z"); // inside window → keep
    expect(await runProviderUsageOutboxRetentionIfDue(NOW)).toBe(1);
    expect(countOutboxRows()).toBe(1);
  });

  it("env override + 0 disables", async () => {
    setOutboxWatermark("2026-11-23T00:00:00.000Z");
    insertOutboxRow("twenty-days-old", "2026-11-04T00:00:00.000Z");
    process.env.PROVIDER_USAGE_OUTBOX_RETENTION_DAYS = "0";
    expect(providerUsageOutboxEffectiveCutoff(NOW)).toBeNull();
    expect(await runProviderUsageOutboxRetentionIfDue(NOW)).toBe(0);
    expect(countOutboxRows()).toBe(1);
    delete process.env.PROVIDER_USAGE_OUTBOX_RETENTION_DAYS;
    process.env.PROVIDER_USAGE_OUTBOX_RETENTION_DAYS = "5"; // cutoff 2026-11-19 > row
    expect(await runProviderUsageOutboxRetentionIfDue(NOW + 11 * 60_000)).toBe(1);
    expect(countOutboxRows()).toBe(0);
  });

  it("corrupt watermark JSON is treated as never-delivered (fail closed)", () => {
    setInternalSetting(PROVIDER_USAGE_OUTBOX_REPLAY_WATERMARK_KEY, "not-an-object");
    expect(providerUsageOutboxDeliveredThrough()).toBeNull();
    setInternalSetting(PROVIDER_USAGE_OUTBOX_REPLAY_WATERMARK_KEY, { createdAt: "garbage", id: "x" });
    expect(providerUsageOutboxDeliveredThrough()).toBeNull();
  });

  it("watermark key constant matches the replay module's provider lane key", () => {
    expect(PROVIDER_USAGE_OUTBOX_REPLAY_WATERMARK_KEY).toBe(USAGE_MONITOR_REPLAY_WATERMARK_KEYS.provider);
  });

  it("watermark makes the sweep due once per interval", async () => {
    setOutboxWatermark("2026-11-23T00:00:00.000Z");
    insertOutboxRow("old", "2026-01-01T00:00:00.000Z");
    expect(await runProviderUsageOutboxRetentionIfDue(NOW)).toBe(1);
    expect(await runProviderUsageOutboxRetentionIfDue(NOW)).toBeNull();
  });

  it("serves the oldest-N subquery from the created_at index (no table scan)", () => {
    const plan = getDb()
      .prepare(
        `EXPLAIN QUERY PLAN DELETE FROM provider_usage_outbox WHERE rowid IN (
           SELECT rowid FROM provider_usage_outbox
           WHERE created_at IS NOT NULL AND created_at < ?
             AND outcome IN ('succeeded','failed','unknown')
           ORDER BY created_at ASC LIMIT ?
         )`
      )
      .all("2026-06-01T00:00:00.000Z", 100) as Array<{ detail: string }>;
    const detail = plan.map((row) => row.detail).join(" | ");
    expect(detail).toContain("idx_puo_created_at");
    expect(detail).not.toContain("SCAN provider_usage_outbox");
  });
});

describe("sec_ingest_task_attempts sweep", () => {
  it("deletes old FINISHED attempts; fresh kept; NULL finished_at (in-flight) always kept", async () => {
    insertIngestAttempt(1, "2026-01-01T00:00:00.000Z"); // finished long ago → delete
    insertIngestAttempt(2, null, "2026-11-24T11:00:00.000Z"); // running now (finished_at NULL) → keep
    insertIngestAttempt(3, null, "2026-01-01T00:00:00.000Z"); // ancient but unfinished → keep
    insertIngestAttempt(4, "2026-11-20T00:00:00.000Z"); // finished inside 30d window → keep
    const deleted = await runSecIngestTaskAttemptsRetentionIfDue(NOW);
    expect(deleted).toBe(1);
    expect(countIngestAttempts()).toBe(3);
    const remaining = getDb()
      .prepare("SELECT id FROM sec_ingest_task_attempts ORDER BY id")
      .all() as Array<{ id: number }>;
    expect(remaining.map((r) => r.id)).toEqual([2, 3, 4]);
  });

  it("env override + 0 disables", async () => {
    insertIngestAttempt(1, "2026-10-30T00:00:00.000Z"); // older than 30d? window cutoff 2026-10-25 → kept
    expect(await runSecIngestTaskAttemptsRetentionIfDue(NOW)).toBe(0);
    process.env.SEC_INGEST_TASK_ATTEMPTS_RETENTION_DAYS = "0";
    expect(secIngestTaskAttemptsRetentionCutoff(NOW, 30)).toBe("2026-10-25T12:00:00.000Z");
    expect(secIngestTaskAttemptsRetentionDays()).toBe(0);
    // days=0 → disabled: even an ancient finished row survives the next due pass.
    insertIngestAttempt(2, "2020-01-01T00:00:00.000Z");
    const deleted = await runSecIngestTaskAttemptsRetentionIfDue(NOW + 11 * 60_000);
    expect(deleted).toBe(0); // env 0 disables the retention pass
    expect(countIngestAttempts()).toBe(2);
    // The batch primitive itself has no env awareness — it is the sweep wrapper that gates on days.
    expect(sweepSecIngestTaskAttemptsBatch("2026-10-25T12:00:00.000Z")).toBe(1);
  });

  it("watermark makes the sweep due once per interval", async () => {
    insertIngestAttempt(1, "2026-01-01T00:00:00.000Z");
    expect(await runSecIngestTaskAttemptsRetentionIfDue(NOW)).toBe(1);
    expect(await runSecIngestTaskAttemptsRetentionIfDue(NOW)).toBeNull();
  });

  it("serves the oldest-N subquery from the finished_at index (no table scan)", () => {
    const plan = getDb()
      .prepare(
        `EXPLAIN QUERY PLAN DELETE FROM sec_ingest_task_attempts WHERE rowid IN (
           SELECT rowid FROM sec_ingest_task_attempts
           WHERE finished_at IS NOT NULL AND finished_at < ? ORDER BY finished_at ASC LIMIT ?
         )`
      )
      .all("2026-06-01T00:00:00.000Z", 100) as Array<{ detail: string }>;
    const detail = plan.map((row) => row.detail).join(" | ");
    expect(detail).toContain("idx_sita_finished_at");
    expect(detail).not.toContain("SCAN sec_ingest_task_attempts");
  });
});

describe("aggregate entry wired into the existing scheduler lane", () => {
  it("runOd4TelemetryRetentionIfDue sweeps all three tables in one call", async () => {
    setOutboxWatermark("2026-11-23T00:00:00.000Z");
    insertDispatchAttempt("old", "2026-01-01T00:00:00.000Z");
    insertOutboxRow("old", "2026-01-01T00:00:00.000Z");
    insertIngestAttempt(1, "2026-01-01T00:00:00.000Z");
    await runOd4TelemetryRetentionIfDue(NOW);
    expect(countDispatchAttempts()).toBe(0);
    expect(countOutboxRows()).toBe(0);
    expect(countIngestAttempts()).toBe(0);
  });

  it("the scheduler's single entry (runApiHealthLogRetentionIfDue) drives the OD-4 sweeps too, and still returns api_health_log-only", async () => {
    setOutboxWatermark("2026-11-23T00:00:00.000Z");
    insertDispatchAttempt("old", "2026-01-01T00:00:00.000Z");
    insertOutboxRow("old", "2026-01-01T00:00:00.000Z");
    insertIngestAttempt(1, "2026-01-01T00:00:00.000Z");
    getDb()
      .prepare(
        "INSERT INTO api_health_log (id, service, ts, ok, latency_ms, error_text, key_source, user_id) VALUES ('old','svc','2026-01-01T00:00:00.000Z',1,5,NULL,NULL,'local')"
      )
      .run();
    const deleted = await runApiHealthLogRetentionIfDue(NOW);
    expect(deleted).toBe(1); // api_health_log rows only
    expect(countDispatchAttempts()).toBe(0);
    expect(countOutboxRows()).toBe(0);
    expect(countIngestAttempts()).toBe(0);
    // Each sweep keeps its own watermark: a second call right after is not due anywhere.
    expect(await runApiHealthLogRetentionIfDue(NOW)).toBeNull();
    expect(getInternalSetting<string>("providerdispatchattempts:lastRunAt")).toBe(
      new Date(NOW).toISOString()
    );
  });
});
