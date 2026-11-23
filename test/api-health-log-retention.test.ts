// ST-4644 (audit F2): bounded FIFO retention for api_health_log.
//
// The hard constraint from the ST-4635 incident: the sweep must NEVER run one big DELETE on
// the event loop.  It deletes in bounded batches and yields the event loop between them.
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-api-health-retention-${randomUUID()}.db`)}`;

import { getDb } from "../src/lib/db";
import {
  API_HEALTH_LOG_RETENTION_DAYS_DEFAULT,
  API_HEALTH_LOG_SWEEP_BATCH_LIMIT,
  apiHealthLogRetentionCutoff,
  apiHealthLogRetentionDays,
  isApiHealthLogRetentionDue,
  runApiHealthLogRetentionIfDue,
  sweepApiHealthLogBatch,
  sweepApiHealthLogRetention
} from "../src/lib/db-health-retention";

const NOW = Date.parse("2026-11-23T12:00:00.000Z");

function insertHealthRow(id: string, ts: string): void {
  getDb()
    .prepare(
      "INSERT INTO api_health_log (id, service, ts, ok, latency_ms, error_text, key_source, user_id) VALUES (?, 'svc', ?, 1, 5, NULL, NULL, 'local')"
    )
    .run(id, ts);
}

function countRows(): number {
  return (getDb().prepare("SELECT COUNT(*) AS cnt FROM api_health_log").get() as { cnt: number }).cnt;
}

function oldestTs(): string | undefined {
  const row = getDb().prepare("SELECT ts FROM api_health_log ORDER BY ts ASC LIMIT 1").get() as
    | { ts: string }
    | undefined;
  return row?.ts;
}

beforeEach(() => {
  getDb().prepare("DELETE FROM api_health_log").run();
  delete process.env.API_HEALTH_LOG_RETENTION_DAYS;
});

afterEach(() => {
  delete process.env.API_HEALTH_LOG_RETENTION_DAYS;
});

describe("api_health_log FIFO retention (ST-4644 / audit F2)", () => {
  it("defaults to a 30-day window and reads the env override", () => {
    expect(API_HEALTH_LOG_RETENTION_DAYS_DEFAULT).toBe(30);
    expect(apiHealthLogRetentionDays()).toBe(30);
    process.env.API_HEALTH_LOG_RETENTION_DAYS = "7";
    expect(apiHealthLogRetentionDays()).toBe(7);
    process.env.API_HEALTH_LOG_RETENTION_DAYS = "not-a-number";
    expect(apiHealthLogRetentionDays()).toBe(30);
  });

  it("treats 0 as 'retention disabled'", async () => {
    process.env.API_HEALTH_LOG_RETENTION_DAYS = "0";
    insertHealthRow("old", "2020-01-01T00:00:00.000Z");
    expect(await sweepApiHealthLogRetention(NOW)).toBe(0);
    expect(countRows()).toBe(1);
  });

  it("deletes only rows older than the cutoff, oldest first", async () => {
    insertHealthRow("ancient", "2026-01-01T00:00:00.000Z");
    insertHealthRow("old", "2026-10-01T00:00:00.000Z");
    insertHealthRow("recent", "2026-11-20T00:00:00.000Z");
    insertHealthRow("fresh", "2026-11-23T11:00:00.000Z");

    const cutoff = apiHealthLogRetentionCutoff(NOW, 30); // 2026-10-24
    const deleted = await sweepApiHealthLogRetention(NOW);
    expect(deleted).toBe(2);
    expect(countRows()).toBe(2);
    expect(oldestTs()).toBe("2026-11-20T00:00:00.000Z");
    expect(cutoff).toBe("2026-10-24T12:00:00.000Z");
  });

  it("never deletes a row inside the retention window", async () => {
    insertHealthRow("recent", "2026-11-20T00:00:00.000Z");
    insertHealthRow("fresh", "2026-11-23T11:00:00.000Z");
    expect(await sweepApiHealthLogRetention(NOW)).toBe(0);
    expect(countRows()).toBe(2);
  });

  it("deletes in BOUNDED batches and leaves the rest for the next pass", () => {
    for (let i = 0; i < 25; i++) {
      insertHealthRow(`old-${i}`, `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`);
    }
    insertHealthRow("fresh", "2026-11-23T11:00:00.000Z");

    const deleted = sweepApiHealthLogBatch("2026-06-01T00:00:00.000Z", 10);
    expect(deleted).toBe(10);
    expect(countRows()).toBe(16); // 25 - 10 deleted, 1 fresh row kept
    // The oldest rows go first.
    expect(oldestTs()).toBe("2026-01-11T00:00:00.000Z");
  });

  it("deletes in BOUNDED batches — never one unbounded DELETE", async () => {
    const total = API_HEALTH_LOG_SWEEP_BATCH_LIMIT + 500;
    const insertMany = getDb().transaction(() => {
      for (let i = 0; i < total; i++) {
        insertHealthRow(`old-${i}`, new Date(Date.parse("2026-01-01T00:00:00.000Z") + i * 1000).toISOString());
      }
    });
    insertMany();

    const cutoff = apiHealthLogRetentionCutoff(NOW);
    // ONE batch deletes at most API_HEALTH_LOG_SWEEP_BATCH_LIMIT rows.
    expect(sweepApiHealthLogBatch(cutoff)).toBe(API_HEALTH_LOG_SWEEP_BATCH_LIMIT);
    expect(countRows()).toBe(500);
    // The next pass drains the remainder.
    expect(await sweepApiHealthLogRetention(NOW)).toBe(500);
    expect(countRows()).toBe(0);
  });

  it("serves the oldest-N subquery from the ts index (no table scan)", () => {
    const indexes = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'api_health_log'")
      .all() as Array<{ name: string }>;
    expect(indexes.map((i) => i.name)).toContain("idx_api_health_log_ts");

    const plan = getDb()
      .prepare(
        `EXPLAIN QUERY PLAN DELETE FROM api_health_log WHERE rowid IN (
           SELECT rowid FROM api_health_log WHERE ts < ? ORDER BY ts ASC LIMIT ?
         )`
      )
      .all("2026-06-01T00:00:00.000Z", 100) as Array<{ detail: string }>;
    const detail = plan.map((row) => row.detail).join(" | ");
    expect(detail).toContain("idx_api_health_log_ts");
    expect(detail).not.toContain("SCAN api_health_log");
  });

  it("is cadence-gated: a second run right after the first is not due", async () => {
    insertHealthRow("old", "2026-01-01T00:00:00.000Z");
    const first = await runApiHealthLogRetentionIfDue(NOW);
    expect(first).toBe(1);
    expect(countRows()).toBe(0);
    expect(isApiHealthLogRetentionDue(NOW)).toBe(false);
    expect(await runApiHealthLogRetentionIfDue(NOW)).toBeNull();
  });
});
