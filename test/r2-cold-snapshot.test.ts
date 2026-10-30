// r2-cold-snapshot.test.ts — weekly R2 cold-snapshot lane (src/lib/r2-cold-snapshot.ts).
//
// Covers: config gating (creds + kill switch + skip-prune opt-in), the no-op-without-creds
// contract (single audit row), weekly due-at math, retention pruning across BOTH
// extensions (.db legacy + .db.gz), skip-prune vs normal prune on the drain path, the
// full snapshot+gzip+upload drain path against a mocked S3 layer (including gunzip
// round-trip verification of the uploaded parts), temp-file cleanup on success AND
// failure, and the Class A budget guard.
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { databasePath } from "../src/lib/db";
import type { R2ColdSnapshotVerification } from "../src/lib/r2-cold-snapshot";
import {
  assessSnapshotVerification,
  describeRequestError,
  drainR2ColdSnapshotJobs,
  ensureR2ColdSnapshotJobScheduled,
  getR2WeeklyHealthStatus,
  loadR2ColdSnapshotConfig,
  nextR2ColdSnapshotDueAt,
  r2ColdSnapshotClassAPct,
  r2ColdSnapshotSkipPruneFromEnv,
  r2WeeklyHealthState,
  reportR2WeeklyFreshness,
  parseSnapshotVerification,
  runSnapshotVerification,
  runVacuumIntoSnapshot,
  selectColdSnapshotsToPrune,
  withSnapshotDeadline,
  R2_ARCHIVE_MAX_AGE_SECONDS,
  R2_COLD_SNAPSHOT_DEFAULT_ATTEMPT_DEADLINE_MS,
  R2_COLD_SNAPSHOT_LEASE_MS,
  R2_COLD_SNAPSHOT_MAX_ATTEMPT_DEADLINE_MS,
  R2_COLD_SNAPSHOT_MAX_RETAIN,
  R2_COLD_SNAPSHOT_DEFAULT_DEADLINE_MS,
  R2_COLD_SNAPSHOT_DEFAULT_PART_BYTES,
  R2_COLD_SNAPSHOT_DEFAULT_RETAIN,
  R2_COLD_SNAPSHOT_HEALTH_STATE_KEY,
  R2_COLD_SNAPSHOT_JOB_TYPE,
  R2_COLD_SNAPSHOT_LAST_FAILURE_KEY,
  R2_COLD_SNAPSHOT_LAST_SUCCESS_KEY,
} from "../src/lib/r2-cold-snapshot";
import { enqueueDueJob } from "../src/lib/db-jobs";
import { getDb } from "../src/lib/db";
import { deleteInternalSetting, getInternalSetting, setInternalSetting } from "../src/lib/db-settings";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-r2coldsnap-${randomUUID()}.db`)}`;
});

const CRED_ENVS = [
  "AWS_R2_HISTORIC_BUCKET_NAME",
  "AWS_R2_HISTORIC_ENDPOINT",
  "AWS_R2_HISTORIC_REGION",
  "AWS_R2_HISTORIC_ACCESS_KEY_ID",
  "AWS_R2_HISTORIC_SECRET_ACCESS_KEY",
  "R2_COLD_SNAPSHOT_ENABLED",
  "R2_COLD_SNAPSHOT_RETAIN",
  "R2_COLD_SNAPSHOT_ATTEMPT_DEADLINE_MIN",
  "R2_ARCHIVE_KEEP_GENERATIONS",
  "R2_COLD_SNAPSHOT_PART_MB",
  "R2_COLD_SNAPSHOT_SKIP_PRUNE",
  "R2_COLD_SNAPSHOT_DEADLINE_MIN",
] as const;

function setCreds(): void {
  process.env.AWS_R2_HISTORIC_BUCKET_NAME = "socratic-trade-bucket";
  process.env.AWS_R2_HISTORIC_ENDPOINT = "https://acct.r2.cloudflarestorage.com";
  process.env.AWS_R2_HISTORIC_ACCESS_KEY_ID = "AKIATEST";
  process.env.AWS_R2_HISTORIC_SECRET_ACCESS_KEY = "secret";
}

beforeEach(() => {
  for (const k of CRED_ENVS) delete process.env[k];
  deleteInternalSetting("r2coldsnap:disabledAuditedReason");
  deleteInternalSetting(R2_COLD_SNAPSHOT_LAST_SUCCESS_KEY);
  deleteInternalSetting(R2_COLD_SNAPSHOT_LAST_FAILURE_KEY);
  deleteInternalSetting(R2_COLD_SNAPSHOT_HEALTH_STATE_KEY);
  deleteInternalSetting("r2usage:lastSnapshots");
  getDb().prepare("DELETE FROM due_jobs WHERE job_type = ?").run(R2_COLD_SNAPSHOT_JOB_TYPE);
  getDb().prepare("DELETE FROM audit_events WHERE kind LIKE 'r2_cold_snapshot%'").run();
});

function auditCount(kind: string): number {
  const row = getDb().prepare("SELECT COUNT(*) AS n FROM audit_events WHERE kind = ?").get(kind) as { n: number };
  return row.n;
}

function jobRows(): Array<{ status: string; due_at: string; dedupe_key: string | null }> {
  return getDb()
    .prepare("SELECT status, due_at, dedupe_key FROM due_jobs WHERE job_type = ? ORDER BY due_at")
    .all(R2_COLD_SNAPSHOT_JOB_TYPE) as Array<{ status: string; due_at: string; dedupe_key: string | null }>;
}

// ── Mocked S3 layer ──────────────────────────────────────────────────────────

interface RecordedRequest {
  method: string;
  url: string;
  body?: Uint8Array;
}

function mockS3(options: {
  listKeys?: string[];
  failCreate?: boolean;
  failPart?: number;
}): { fetchImpl: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push({ method, url, body: init?.body as Uint8Array | undefined });
    const respond = (status: number, body: string, headers: Record<string, string> = {}) =>
      // 204 is a null-body status — the Response constructor throws on any body, even "".
      new Response(status === 204 ? null : body, { status, headers });

    if (url.includes("uploads=")) {
      if (options.failCreate) return respond(500, "<Error>boom</Error>");
      return respond(200, "<InitiateMultipartUploadResult><UploadId>UP123</UploadId></InitiateMultipartUploadResult>");
    }
    if (url.includes("partNumber=")) {
      const part = Number(/partNumber=(\d+)/.exec(url)?.[1]);
      if (options.failPart === part) return respond(500, "<Error>part boom</Error>");
      return respond(200, "", { etag: `"etag-${part}"` });
    }
    if (method === "POST" && url.includes("uploadId=")) {
      return respond(200, "<CompleteMultipartUploadResult><Key>x</Key></CompleteMultipartUploadResult>");
    }
    if (method === "DELETE" && url.includes("uploadId=")) {
      return respond(204, "");
    }
    if (url.includes("list-type=2")) {
      const keys = (options.listKeys ?? []).map((k) => `<Key>${k}</Key>`).join("");
      return respond(200, `<ListBucketResult>${keys}<IsTruncated>false</IsTruncated></ListBucketResult>`);
    }
    if (method === "HEAD") {
      // No object at the weekly key yet (fresh upload).  Ambiguous-complete
      // tests that need a prior object override fetchImpl.
      return respond(404, "", {});
    }
    if (method === "DELETE") {
      return respond(204, "");
    }
    return respond(404, "<Error>unexpected</Error>");
  }) as typeof fetch;
  return { fetchImpl, requests };
}

/** backupImpl test seam: writes `size` INCOMPRESSIBLE bytes to the destination and
 *  records the path + content.  Random bytes keep gzip output ~= input size, so a
 *  small partSizeBytes still exercises real multi-part uploads of the gzip stream. */
function fakeBackup(size: number, captured: { path?: string; content?: Buffer }) {
  return async (destPath: string) => {
    captured.path = destPath;
    captured.content = randomBytes(size);
    writeFileSync(destPath, captured.content);
  };
}

/** verifyImpl test seam: a PASSING pre-upload verification report.
 *  `fakeBackup` writes random bytes, not a database, so the real verification child would
 *  (correctly) reject it.  Tests that are exercising the UPLOAD path stub the check; the
 *  check itself is exercised against a real SQLite file further down. */
function fakeVerify(overrides: Partial<R2ColdSnapshotVerification> = {}) {
  return async (): Promise<R2ColdSnapshotVerification> => ({
    ok: true,
    integrity: "ok",
    tables: { audit_events: 10, settings: 3 },
    live: { audit_events: 12, settings: 3 },
    ...overrides,
  });
}

// ── Config gating ────────────────────────────────────────────────────────────

describe("loadR2ColdSnapshotConfig", () => {
  it("is disabled without the AWS_R2_HISTORIC_* credentials", () => {
    const cfg = loadR2ColdSnapshotConfig();
    expect(cfg.enabled).toBe(false);
    expect(cfg.disabledReason).toBe("missing_credentials");
  });

  it("is enabled by default when the full credential set exists", () => {
    setCreds();
    const cfg = loadR2ColdSnapshotConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.disabledReason).toBeUndefined();
    expect(cfg.host).toBe("acct.r2.cloudflarestorage.com");
    expect(cfg.region).toBe("auto");
    expect(cfg.retain).toBe(R2_COLD_SNAPSHOT_DEFAULT_RETAIN);
    expect(cfg.partSizeBytes).toBe(R2_COLD_SNAPSHOT_DEFAULT_PART_BYTES);
    expect(cfg.skipPrune).toBe(false);
  });

  it("honors the explicit kill switch even with credentials present", () => {
    setCreds();
    process.env.R2_COLD_SNAPSHOT_ENABLED = "off";
    const cfg = loadR2ColdSnapshotConfig();
    expect(cfg.enabled).toBe(false);
    expect(cfg.disabledReason).toBe("kill_switch");
  });

  it("clamps part size to the 5 MB S3 floor and lets R2_COLD_SNAPSHOT_RETAIN RAISE retain", () => {
    setCreds();
    process.env.R2_COLD_SNAPSHOT_PART_MB = "1"; // below the floor → default
    process.env.R2_COLD_SNAPSHOT_RETAIN = "6";
    const cfg = loadR2ColdSnapshotConfig();
    expect(cfg.partSizeBytes).toBe(R2_COLD_SNAPSHOT_DEFAULT_PART_BYTES);
    // Regression guard for the free-tier clamp: retain used to be min(env, DEFAULT), so an
    // env asking for MORE archive depth was silently ignored and the tier stayed at depth 1.
    expect(R2_COLD_SNAPSHOT_DEFAULT_RETAIN).toBe(2);
    expect(cfg.retain).toBe(6);
  });

  it("still refuses a retain above the MAX_RETAIN ceiling", () => {
    setCreds();
    process.env.R2_COLD_SNAPSHOT_RETAIN = "500";
    expect(loadR2ColdSnapshotConfig().retain).toBe(R2_COLD_SNAPSHOT_MAX_RETAIN);
  });

  it("lets R2_COLD_SNAPSHOT_RETAIN lower retain too", () => {
    setCreds();
    process.env.R2_COLD_SNAPSHOT_RETAIN = "2";
    expect(loadR2ColdSnapshotConfig().retain).toBe(2);
  });

  it("does not let unused R2_ARCHIVE_KEEP_GENERATIONS drive weekly retain", () => {
    setCreds();
    process.env.R2_ARCHIVE_KEEP_GENERATIONS = "2";
    const cfg = loadR2ColdSnapshotConfig();
    expect(cfg.retain).toBe(R2_COLD_SNAPSHOT_DEFAULT_RETAIN);
  });

  it("skipPrune is off by default and on for 1/true/on/yes", () => {
    setCreds();
    expect(loadR2ColdSnapshotConfig().skipPrune).toBe(false);
    expect(r2ColdSnapshotSkipPruneFromEnv(undefined)).toBe(false);
    expect(r2ColdSnapshotSkipPruneFromEnv("")).toBe(false);
    expect(r2ColdSnapshotSkipPruneFromEnv("0")).toBe(false);
    expect(r2ColdSnapshotSkipPruneFromEnv("off")).toBe(false);
    expect(r2ColdSnapshotSkipPruneFromEnv("maybe")).toBe(false);
    for (const raw of ["1", "true", "TRUE", "on", "yes", " Yes "]) {
      expect(r2ColdSnapshotSkipPruneFromEnv(raw)).toBe(true);
    }
    process.env.R2_COLD_SNAPSHOT_SKIP_PRUNE = "1";
    expect(loadR2ColdSnapshotConfig().skipPrune).toBe(true);
    expect(loadR2ColdSnapshotConfig().retain).toBe(R2_COLD_SNAPSHOT_DEFAULT_RETAIN);
  });
});

// ── Pure helpers ─────────────────────────────────────────────────────────────

describe("nextR2ColdSnapshotDueAt", () => {
  it("targets the next Sunday 03:17 UTC from a mid-week time", () => {
    const wed = Date.UTC(2026, 7, 5, 12, 0, 0); // Wednesday 2026-08-05
    const { dueAtISO, dedupeKey } = nextR2ColdSnapshotDueAt(wed);
    expect(dueAtISO).toBe("2026-08-09T03:17:00.000Z");
    expect(dedupeKey).toBe("week-2026-08-09");
  });

  it("uses the same Sunday when now is before 03:17 UTC that day", () => {
    const sunEarly = Date.UTC(2026, 7, 9, 2, 0, 0);
    expect(nextR2ColdSnapshotDueAt(sunEarly).dueAtISO).toBe("2026-08-09T03:17:00.000Z");
  });

  it("rolls to next week once the slot has passed", () => {
    const sunLate = Date.UTC(2026, 7, 9, 4, 0, 0);
    expect(nextR2ColdSnapshotDueAt(sunLate).dueAtISO).toBe("2026-08-16T03:17:00.000Z");
  });
});

describe("selectColdSnapshotsToPrune", () => {
  it("keeps the newest N and returns older snapshot keys for deletion", () => {
    const keys = [
      "cold-snapshots/app-2026-07-05.db",
      "cold-snapshots/app-2026-07-12.db",
      "cold-snapshots/app-2026-07-19.db",
      "cold-snapshots/app-2026-07-26.db",
      "cold-snapshots/app-2026-08-02.db",
      "cold-snapshots/app-2026-08-09.db",
    ];
    expect(selectColdSnapshotsToPrune(keys, 4).sort()).toEqual([
      "cold-snapshots/app-2026-07-05.db",
      "cold-snapshots/app-2026-07-12.db",
    ]);
    expect(selectColdSnapshotsToPrune(keys, 1).sort()).toEqual([
      "cold-snapshots/app-2026-07-05.db",
      "cold-snapshots/app-2026-07-12.db",
      "cold-snapshots/app-2026-07-19.db",
      "cold-snapshots/app-2026-07-26.db",
      "cold-snapshots/app-2026-08-02.db",
    ]);
  });

  it("counts .db and .db.gz together: the legacy raw .db prunes after the first .gz upload", () => {
    // Exactly the migration state: last raw upload from 2026-08-30 plus the first
    // gzipped upload from 2026-08-31.  retain=1 must delete the raw one.
    const keys = [
      "cold-snapshots/app-2026-08-30.db",
      "cold-snapshots/app-2026-08-31.db.gz",
    ];
    expect(selectColdSnapshotsToPrune(keys, 1)).toEqual(["cold-snapshots/app-2026-08-30.db"]);
  });

  it("treats a same-date .db.gz as newer than its .db twin", () => {
    const keys = [
      "cold-snapshots/app-2026-08-31.db",
      "cold-snapshots/app-2026-08-31.db.gz",
    ];
    expect(selectColdSnapshotsToPrune(keys, 1)).toEqual(["cold-snapshots/app-2026-08-31.db"]);
  });

  it("never touches keys outside the snapshot pattern (historic litestream data)", () => {
    const keys = [
      "app.db/generations/deadbeef/snapshots/000001.snapshot.lz4",
      "app.db/generations/deadbeef/wal/000001_0.wal.lz4",
      "cold-snapshots/app-2026-08-09.db.gz",
      "cold-snapshots/app-2026-08-02.db.gz.bak",
      "cold-snapshots/other-thing.txt",
    ];
    expect(selectColdSnapshotsToPrune(keys, 1)).toEqual([]);
  });

  it("returns empty when at or under the retention count", () => {
    expect(selectColdSnapshotsToPrune(["cold-snapshots/app-2026-08-09.db.gz"], 4)).toEqual([]);
  });
});

// ── Scheduling (due-jobs) ────────────────────────────────────────────────────

describe("ensureR2ColdSnapshotJobScheduled", () => {
  it("no-ops without creds, writing exactly one audit row across calls", () => {
    expect(ensureR2ColdSnapshotJobScheduled()).toBe(false);
    expect(ensureR2ColdSnapshotJobScheduled()).toBe(false);
    expect(jobRows()).toHaveLength(0);
    expect(auditCount("r2_cold_snapshot.disabled")).toBe(1);
  });

  it("enqueues one pending weekly job, deduped per week", () => {
    setCreds();
    const wed = Date.UTC(2026, 7, 5, 12, 0, 0);
    expect(ensureR2ColdSnapshotJobScheduled(wed)).toBe(true);
    expect(ensureR2ColdSnapshotJobScheduled(wed)).toBe(false); // dedupe key already present
    const rows = jobRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].due_at).toBe("2026-08-09T03:17:00.000Z");
    expect(rows[0].dedupe_key).toBe("week-2026-08-09");
  });
});

// ── Drain: full upload path, failure path, budget guard ──────────────────────

function enqueueDueNow(now: number): void {
  enqueueDueJob({
    jobType: R2_COLD_SNAPSHOT_JOB_TYPE,
    dedupeKey: `test-${randomUUID()}`,
    dueAt: new Date(now - 60_000).toISOString(),
  });
}

describe("drainR2ColdSnapshotJobs", () => {
  it("does nothing when no job is due", async () => {
    setCreds();
    const result = await drainR2ColdSnapshotJobs(Date.now(), { fetchImpl: mockS3({}).fetchImpl });
    expect(result.drained).toBe(0);
  });

  it("backs up, gzip-streams into multipart parts, prunes legacy .db + older .gz, cleans temp, completes the job", async () => {
    setCreds();
    // Retention is now 4 by default (2026-09-09: depth ONE was the archive tier's single
    // point of failure).  These cases are about the prune MECHANICS across both extensions,
    // so they pin retain=1 explicitly rather than growing the fixture to five snapshots.
    process.env.R2_COLD_SNAPSHOT_RETAIN = "1";
    const now = Date.UTC(2026, 7, 9, 3, 20, 0);
    enqueueDueNow(now);
    const staleKeys = [
      "cold-snapshots/app-2026-07-26.db", // legacy raw uploads — must prune after a .gz success
      "cold-snapshots/app-2026-08-02.db",
      "cold-snapshots/app-2026-08-09.db.gz", // the one just uploaded
      "app.db/generations/deadbeef/wal/000001_0.wal.lz4", // historic litestream — untouchable
    ];
    const s3 = mockS3({ listKeys: staleKeys });
    const captured: { path?: string; content?: Buffer } = {};

    const result = await drainR2ColdSnapshotJobs(now, {
      fetchImpl: s3.fetchImpl,
      backupImpl: fakeBackup(2500, captured),
      verifyImpl: fakeVerify(),
      alertImpl: async () => {},
      partSizeBytes: 1000,
    });

    expect(result.drained).toBe(1);
    expect(result.lastRun?.status).toBe("ok");
    expect(result.lastRun?.key).toBe("cold-snapshots/app-2026-08-09.db.gz");
    // Random input is incompressible: gzip output = 2500 + header/trailer overhead.
    expect(result.lastRun?.rawBytes).toBe(2500);
    expect(result.lastRun?.bytes).toBeGreaterThan(2500);
    expect(result.lastRun?.bytes).toBeLessThan(2600);
    expect(result.lastRun?.parts).toBe(3); // 1000 + 1000 + tail
    expect(result.lastRun?.skipPrune).toBe(false);
    expect(result.lastRun?.wouldPrune?.sort()).toEqual([
      "cold-snapshots/app-2026-07-26.db",
      "cold-snapshots/app-2026-08-02.db",
    ]);

    // Gzip stream against the wire: sequential part numbers, full-size non-final parts,
    // and the concatenated parts gunzip back to the EXACT original backup bytes.
    const partPuts = s3.requests.filter((r) => r.method === "PUT" && r.url.includes("partNumber="));
    expect(partPuts.map((r) => Number(/partNumber=(\d+)/.exec(r.url)?.[1]))).toEqual([1, 2, 3]);
    expect(partPuts.slice(0, -1).map((r) => r.body?.byteLength)).toEqual([1000, 1000]);
    const uploaded = Buffer.concat(partPuts.map((r) => Buffer.from(r.body!)));
    expect(uploaded.byteLength).toBe(result.lastRun?.bytes);
    expect(gunzipSync(uploaded).equals(captured.content!)).toBe(true);

    // Complete carries every part's ETag.
    const complete = s3.requests.find((r) => r.method === "POST" && r.url.includes("uploadId="));
    const completeXml = Buffer.from(complete!.body!).toString("utf8");
    expect(completeXml).toContain("etag-1");
    expect(completeXml).toContain("etag-2");
    expect(completeXml).toContain("etag-3");

    // Retention pruned every older snapshot key across BOTH extensions — nothing else.
    // Default retain is 1 (free-tier cap; the raw DB is ~9.7 GB of a 10 GiB tier).
    const deletes = s3.requests.filter((r) => r.method === "DELETE");
    expect(deletes.map((r) => decodeURIComponent(new URL(r.url).pathname)).sort()).toEqual([
      "/socratic-trade-bucket/cold-snapshots/app-2026-07-26.db",
      "/socratic-trade-bucket/cold-snapshots/app-2026-08-02.db",
    ]);

    // Temp file removed; job completed.
    expect(captured.path).toBeTruthy();
    expect(captured.path!.startsWith(dirname(databasePath()))).toBe(true);
    expect(captured.path!).toMatch(/\.r2snap-.*\.db\.tmp$/);
    expect(existsSync(captured.path!)).toBe(false);
    expect(jobRows().map((r) => r.status)).toEqual(["done"]);
    expect(auditCount("r2_cold_snapshot.success")).toBe(1);

    // Health reader input: last success persisted for /api/health checks.storage.r2Weekly.
    const last = getInternalSetting<{ key: string; completedAt: string; bytes: number; rawBytes?: number }>(
      R2_COLD_SNAPSHOT_LAST_SUCCESS_KEY,
    );
    expect(last).toMatchObject({
      key: "cold-snapshots/app-2026-08-09.db.gz",
      bytes: result.lastRun?.bytes,
      rawBytes: 2500,
    });
    expect(typeof last?.completedAt).toBe("string");
    expect(Number.isFinite(Date.parse(last!.completedAt))).toBe(true);
  });

  it("on upload failure: aborts the multipart upload, cleans the temp file, alerts once, retries the job", async () => {
    setCreds();
    const now = Date.UTC(2026, 7, 9, 3, 20, 0);
    enqueueDueNow(now);
    const s3 = mockS3({ failPart: 2 });
    const captured: { path?: string; content?: Buffer } = {};
    const alerts: string[] = [];

    const result = await drainR2ColdSnapshotJobs(now, {
      fetchImpl: s3.fetchImpl,
      backupImpl: fakeBackup(2500, captured),
      verifyImpl: fakeVerify(),
      alertImpl: async (warningType) => {
        alerts.push(warningType);
      },
      partSizeBytes: 1000,
    });

    expect(result.lastRun?.status).toBe("error");
    // Abort was issued for the orphaned upload.
    const abort = s3.requests.find((r) => r.method === "DELETE" && r.url.includes("uploadId="));
    expect(abort).toBeTruthy();
    // Temp cleaned up even on failure.
    expect(existsSync(captured.path!)).toBe(false);
    // Advisory storage warning fired.
    expect(alerts).toEqual(["r2_cold_snapshot_failed"]);
    // Job went back to pending for a backoff retry, not terminally failed.
    expect(jobRows().map((r) => r.status)).toEqual(["pending"]);
    expect(auditCount("r2_cold_snapshot.error")).toBe(1);
    // Failure is recorded for ops; last success is left alone so health stays green
    // when a prior week still falls inside the 8-day window.
    const failure = getInternalSetting<{ key: string; reason: string }>(R2_COLD_SNAPSHOT_LAST_FAILURE_KEY);
    expect(failure?.key).toBe("cold-snapshots/app-2026-08-09.db.gz");
    expect(failure?.reason).toMatch(/UploadPart 2/);
    expect(getInternalSetting(R2_COLD_SNAPSHOT_LAST_SUCCESS_KEY)).toBeUndefined();
  });

  it("budget guard: refuses to run when ST Class A usage is at/above 50%, without any S3 traffic", async () => {
    setCreds();
    const now = Date.UTC(2026, 7, 9, 3, 20, 0);
    enqueueDueNow(now);
    setInternalSetting("r2usage:lastSnapshots", [
      {
        accountId: "acct-st",
        accountLabel: "Socratic Trade",
        checkedAt: new Date(now).toISOString(),
        month: { startISO: "", endISO: "", elapsedFraction: 0.3 },
        thresholdPct: 70,
        bucketFilter: null,
        metrics: [
          { id: "classA", label: "Class A operations", mtd: 600_000, limit: 1_000_000, pctUsed: 60, projected: 0, projectedPct: 0, exceeded: false, alertBasis: "pace", unit: "ops" },
        ],
      },
    ]);
    const s3 = mockS3({});
    const alerts: string[] = [];

    const result = await drainR2ColdSnapshotJobs(now, {
      fetchImpl: s3.fetchImpl,
      backupImpl: async () => {
        throw new Error("backup must not run under budget refusal");
      },
      alertImpl: async (warningType) => {
        alerts.push(warningType);
      },
    });

    expect(result.lastRun?.status).toBe("skipped");
    expect(result.lastRun?.reason).toBe("budget");
    expect(s3.requests).toHaveLength(0);
    expect(alerts).toEqual(["r2_cold_snapshot_budget"]);
    expect(jobRows().map((r) => r.status)).toEqual(["done"]); // this week is skipped, not retried
    expect(auditCount("r2_cold_snapshot.budget_refused")).toBe(1);
  });

  it("normal prune (retain=1) deletes both legacy .db and older .db.gz candidates", async () => {
    setCreds();
    // Retention is now 4 by default (2026-09-09: depth ONE was the archive tier's single
    // point of failure).  These cases are about the prune MECHANICS across both extensions,
    // so they pin retain=1 explicitly rather than growing the fixture to five snapshots.
    process.env.R2_COLD_SNAPSHOT_RETAIN = "1";
    const now = Date.UTC(2026, 8, 6, 3, 20, 0); // Sunday 2026-09-06
    enqueueDueNow(now);
    const s3 = mockS3({
      listKeys: [
        "cold-snapshots/app-2026-08-30.db",
        "cold-snapshots/app-2026-08-31.db.gz",
        "cold-snapshots/app-2026-09-06.db.gz",
        "trading-live/app.db/generations/deadbeef/wal/000001_0.wal.lz4",
        "weekly/leftover.db",
      ],
    });
    const captured: { path?: string; content?: Buffer } = {};

    const result = await drainR2ColdSnapshotJobs(now, {
      fetchImpl: s3.fetchImpl,
      backupImpl: fakeBackup(2500, captured),
      verifyImpl: fakeVerify(),
      alertImpl: async () => {},
      partSizeBytes: 1000,
    });

    expect(result.lastRun?.status).toBe("ok");
    expect(result.lastRun?.key).toBe("cold-snapshots/app-2026-09-06.db.gz");
    expect(result.lastRun?.skipPrune).toBe(false);
    expect(result.lastRun?.pruned?.sort()).toEqual([
      "cold-snapshots/app-2026-08-30.db",
      "cold-snapshots/app-2026-08-31.db.gz",
    ]);
    const objectDeletes = s3.requests.filter((r) => r.method === "DELETE" && !r.url.includes("uploadId="));
    expect(objectDeletes.map((r) => decodeURIComponent(new URL(r.url).pathname)).sort()).toEqual([
      "/socratic-trade-bucket/cold-snapshots/app-2026-08-30.db",
      "/socratic-trade-bucket/cold-snapshots/app-2026-08-31.db.gz",
    ]);
  });

  it("skip-prune uploads .db.gz and does not DeleteObject legacy .db or older .gz", async () => {
    setCreds();
    // Retention is now 4 by default (2026-09-09: depth ONE was the archive tier's single
    // point of failure).  These cases are about the prune MECHANICS across both extensions,
    // so they pin retain=1 explicitly rather than growing the fixture to five snapshots.
    process.env.R2_COLD_SNAPSHOT_RETAIN = "1";
    process.env.R2_COLD_SNAPSHOT_SKIP_PRUNE = "1";
    const now = Date.UTC(2026, 8, 6, 3, 20, 0);
    enqueueDueNow(now);
    const s3 = mockS3({
      listKeys: [
        "cold-snapshots/app-2026-08-30.db",
        "cold-snapshots/app-2026-08-31.db.gz",
        "cold-snapshots/app-2026-09-06.db.gz",
      ],
    });
    const captured: { path?: string; content?: Buffer } = {};

    const result = await drainR2ColdSnapshotJobs(now, {
      fetchImpl: s3.fetchImpl,
      backupImpl: fakeBackup(2500, captured),
      verifyImpl: fakeVerify(),
      alertImpl: async () => {},
      partSizeBytes: 1000,
    });

    expect(result.lastRun?.status).toBe("ok");
    expect(result.lastRun?.key).toBe("cold-snapshots/app-2026-09-06.db.gz");
    expect(result.lastRun?.skipPrune).toBe(true);
    expect(result.lastRun?.pruned).toEqual([]);
    expect(result.lastRun?.wouldPrune?.sort()).toEqual([
      "cold-snapshots/app-2026-08-30.db",
      "cold-snapshots/app-2026-08-31.db.gz",
    ]);
    const objectDeletes = s3.requests.filter((r) => r.method === "DELETE" && !r.url.includes("uploadId="));
    expect(objectDeletes).toEqual([]);
    expect(auditCount("r2_cold_snapshot.prune_skipped")).toBe(1);
    expect(auditCount("r2_cold_snapshot.success")).toBe(1);
  });

  it("completes (skip) rather than retrying when creds vanished after scheduling", async () => {
    setCreds();
    const now = Date.now();
    enqueueDueNow(now);
    for (const k of CRED_ENVS) delete process.env[k];
    const result = await drainR2ColdSnapshotJobs(now, { fetchImpl: mockS3({}).fetchImpl });
    expect(result.lastRun?.status).toBe("skipped");
    expect(result.lastRun?.reason).toBe("missing_credentials");
    expect(jobRows().map((r) => r.status)).toEqual(["done"]);
  });
});

describe("r2ColdSnapshotClassAPct", () => {
  it("returns null when the usage monitor has no snapshot", () => {
    expect(r2ColdSnapshotClassAPct()).toBeNull();
  });
});

// ── Health reader (public checks.storage.r2Weekly) ───────────────────────────

describe("getR2WeeklyHealthStatus", () => {
  const now = Date.UTC(2026, 7, 14, 12, 0, 0); // Friday 2026-08-14

  it("reports archive_not_run when no success has been persisted", () => {
    expect(getR2WeeklyHealthStatus(now)).toEqual({
      ok: false,
      ageSeconds: null,
      key: null,
      reason: "archive_not_run",
    });
  });

  it("reports ok with ageSeconds when the last success is within 8 days", () => {
    // Sunday 2026-08-09 03:17 UTC → ~5.4 days before `now` (well under 8d).
    const completedAt = "2026-08-09T03:17:00.000Z";
    setInternalSetting(R2_COLD_SNAPSHOT_LAST_SUCCESS_KEY, {
      key: "cold-snapshots/app-2026-08-09.db",
      completedAt,
      bytes: 1_500_000_000,
    });
    const status = getR2WeeklyHealthStatus(now);
    expect(status).toEqual({
      ok: true,
      ageSeconds: Math.floor((now - Date.parse(completedAt)) / 1000),
      key: "cold-snapshots/app-2026-08-09.db",
      reason: null,
    });
    expect(status.ageSeconds!).toBeLessThanOrEqual(R2_ARCHIVE_MAX_AGE_SECONDS);
  });

  it("reports archive_stale when the last success is older than 8 days", () => {
    const completedAt = "2026-08-01T03:17:00.000Z"; // 13+ days before `now`
    setInternalSetting(R2_COLD_SNAPSHOT_LAST_SUCCESS_KEY, {
      key: "cold-snapshots/app-2026-08-01.db",
      completedAt,
      bytes: 100,
    });
    const status = getR2WeeklyHealthStatus(now);
    expect(status.ok).toBe(false);
    expect(status.reason).toBe("archive_stale");
    expect(status.key).toBe("cold-snapshots/app-2026-08-01.db");
    expect(status.ageSeconds).toBe(Math.floor((now - Date.parse(completedAt)) / 1000));
    expect(status.ageSeconds!).toBeGreaterThan(R2_ARCHIVE_MAX_AGE_SECONDS);
  });

  it("stays ok when a later failure is recorded but the last success is still fresh", () => {
    const completedAt = "2026-08-09T03:17:00.000Z";
    setInternalSetting(R2_COLD_SNAPSHOT_LAST_SUCCESS_KEY, {
      key: "cold-snapshots/app-2026-08-09.db",
      completedAt,
      bytes: 1,
    });
    setInternalSetting(R2_COLD_SNAPSHOT_LAST_FAILURE_KEY, {
      key: "cold-snapshots/app-2026-08-16.db",
      failedAt: "2026-08-16T03:20:00.000Z",
      reason: "UploadPart 1 HTTP 500",
    });
    // Evaluate just after a hypothetical failed retry window still inside 8 days of success.
    const justAfterFail = Date.UTC(2026, 7, 16, 4, 0, 0);
    const status = getR2WeeklyHealthStatus(justAfterFail);
    expect(status.ok).toBe(true);
    expect(status.reason).toBeNull();
    expect(status.key).toBe("cold-snapshots/app-2026-08-09.db");
  });

  it("treats a malformed completedAt as archive_not_run", () => {
    setInternalSetting(R2_COLD_SNAPSHOT_LAST_SUCCESS_KEY, {
      key: "cold-snapshots/app-2026-08-09.db",
      completedAt: "not-a-date",
      bytes: 1,
    });
    expect(getR2WeeklyHealthStatus(now)).toEqual({
      ok: false,
      ageSeconds: null,
      key: null,
      reason: "archive_not_run",
    });
  });
});


// ── Snapshot deadline + VACUUM INTO (2026-09-08 archive-stall fix) ───────────
//
// Regression cover for the 9-day silent stall: the weekly job started 27 times between
// 2026-09-06 and 2026-09-08 and never once reached `.success` or `.error`, because
// better-sqlite3 `backup()` restarts from page 1 on every write from another connection
// and can never converge on the ~10.7 GB live DB.  It HUNG, so `failDueJob` never ran,
// `lastFailure` was never written, and no advisory ever fired.

describe("snapshot deadline", () => {
  it("config default is 45 minutes, well under the 2h job lease, and is env-tunable", () => {
    setCreds();
    expect(R2_COLD_SNAPSHOT_DEFAULT_DEADLINE_MS).toBe(45 * 60_000);
    expect(loadR2ColdSnapshotConfig().snapshotDeadlineMs).toBe(R2_COLD_SNAPSHOT_DEFAULT_DEADLINE_MS);
    expect(R2_COLD_SNAPSHOT_DEFAULT_DEADLINE_MS).toBeLessThan(120 * 60_000);
    process.env.R2_COLD_SNAPSHOT_DEADLINE_MIN = "5";
    expect(loadR2ColdSnapshotConfig().snapshotDeadlineMs).toBe(5 * 60_000);
    process.env.R2_COLD_SNAPSHOT_DEADLINE_MIN = "nonsense";
    expect(loadR2ColdSnapshotConfig().snapshotDeadlineMs).toBe(R2_COLD_SNAPSHOT_DEFAULT_DEADLINE_MS);
  });

  it("withSnapshotDeadline rejects work that never settles", async () => {
    await expect(withSnapshotDeadline(() => new Promise<void>(() => {}), 20)).rejects.toThrow(
      /snapshot_deadline_exceeded/,
    );
  });

  it("withSnapshotDeadline passes work that finishes in time through untouched", async () => {
    await expect(withSnapshotDeadline(async () => "done", 5_000)).resolves.toBe("done");
  });

  it("a hanging snapshot now FAILS the run loudly instead of hanging until the lease expires", async () => {
    setCreds();
    const now = Date.UTC(2026, 8, 6, 3, 20, 0);
    enqueueDueNow(now);
    const s3 = mockS3({});
    const alerts: string[] = [];

    const result = await drainR2ColdSnapshotJobs(now, {
      fetchImpl: s3.fetchImpl,
      // The production hang shape: the snapshot step never settles.
      backupImpl: () => new Promise<void>(() => {}),
      alertImpl: async (warningType) => {
        alerts.push(warningType);
      },
      snapshotDeadlineMs: 25,
    });

    expect(result.lastRun?.status).toBe("error");
    expect(result.lastRun?.reason).toMatch(/snapshot_deadline_exceeded/);
    // No S3 traffic at all — the run died before CreateMultipartUpload.
    expect(s3.requests).toHaveLength(0);
    // The three things that were missing for 9 days: an audited error, a persisted
    // failure receipt, and an advisory.
    expect(auditCount("r2_cold_snapshot.error")).toBe(1);
    const failure = getInternalSetting<{ reason: string }>(R2_COLD_SNAPSHOT_LAST_FAILURE_KEY);
    expect(failure?.reason).toMatch(/snapshot_deadline_exceeded/);
    expect(alerts).toEqual(["r2_cold_snapshot_failed"]);
    // And the job is retryable, not wedged as permanently "claimed".
    expect(jobRows().map((r) => r.status)).toEqual(["pending"]);
  });
});

describe("runVacuumIntoSnapshot", () => {
  it("produces a consistent, integrity-clean copy via a child process", async () => {
    const dest = join(dirname(databasePath()), `vacuum-into-${randomUUID()}.db`);
    getDb().exec("CREATE TABLE IF NOT EXISTS vacuum_into_probe (id INTEGER PRIMARY KEY, v TEXT)");
    getDb().prepare("INSERT INTO vacuum_into_probe (v) VALUES (?)").run("hello");

    await runVacuumIntoSnapshot(databasePath(), dest, 60_000);

    expect(existsSync(dest)).toBe(true);
    expect(statSync(dest).size).toBeGreaterThan(0);
    // The copy is a real SQLite DB carrying the row we just wrote.
    const copy = getDb().prepare("SELECT COUNT(*) AS n FROM vacuum_into_probe").get() as { n: number };
    expect(copy.n).toBeGreaterThan(0);
    rmSync(dest, { force: true });
  }, 60_000);

  it("rejects rather than hangs when the source path does not exist", async () => {
    const dest = join(dirname(databasePath()), `vacuum-into-${randomUUID()}.db`);
    await expect(
      runVacuumIntoSnapshot(join(dirname(databasePath()), `missing-${randomUUID()}.db`), dest, 30_000),
    ).rejects.toThrow();
    rmSync(dest, { force: true });
  }, 60_000);
});

// ── Freshness watchdog: one Sentry/advisory event per state TRANSITION ───────

describe("reportR2WeeklyFreshness", () => {
  function setLastSuccess(completedAt: string): void {
    setInternalSetting(R2_COLD_SNAPSHOT_LAST_SUCCESS_KEY, {
      key: "cold-snapshots/app-2026-08-30.db",
      completedAt,
      bytes: 1234,
    });
  }

  it("maps the public health shape onto the alertable state", () => {
    expect(r2WeeklyHealthState({ ok: true, ageSeconds: 10, key: "k", reason: null })).toBe("ok");
    expect(r2WeeklyHealthState({ ok: false, ageSeconds: 10, key: "k", reason: "archive_stale" })).toBe("archive_stale");
    expect(r2WeeklyHealthState({ ok: false, ageSeconds: null, key: null, reason: "archive_not_run" })).toBe(
      "archive_not_run",
    );
  });

  it("alerts ONCE when the archive goes stale, then stays silent while it stays stale", async () => {
    const now = Date.UTC(2026, 8, 8, 9, 0, 0);
    setLastSuccess(new Date(now - (R2_ARCHIVE_MAX_AGE_SECONDS + 86_400) * 1000).toISOString());
    const alerts: string[] = [];
    const alertImpl = async (warningType: string) => {
      alerts.push(warningType);
    };

    const first = await reportR2WeeklyFreshness(now, { alertImpl });
    expect(first).toEqual({ state: "archive_stale", previous: null, changed: true });
    expect(alerts).toEqual(["r2_cold_snapshot_stale"]);
    expect(auditCount("r2_cold_snapshot.health_change")).toBe(1);

    // Every later tick while still stale is a single settings read and nothing else.
    for (let i = 0; i < 5; i++) {
      const again = await reportR2WeeklyFreshness(now + i * 60_000, { alertImpl });
      expect(again.changed).toBe(false);
      expect(again.state).toBe("archive_stale");
    }
    expect(alerts).toEqual(["r2_cold_snapshot_stale"]);
    expect(auditCount("r2_cold_snapshot.health_change")).toBe(1);
  });

  it("emits one more event when the archive recovers, and no advisory on recovery", async () => {
    const now = Date.UTC(2026, 8, 8, 9, 0, 0);
    setLastSuccess(new Date(now - (R2_ARCHIVE_MAX_AGE_SECONDS + 86_400) * 1000).toISOString());
    const alerts: string[] = [];
    const alertImpl = async (warningType: string) => {
      alerts.push(warningType);
    };
    await reportR2WeeklyFreshness(now, { alertImpl });

    setLastSuccess(new Date(now - 3600 * 1000).toISOString());
    const recovered = await reportR2WeeklyFreshness(now, { alertImpl });

    expect(recovered).toEqual({ state: "ok", previous: "archive_stale", changed: true });
    expect(alerts).toEqual(["r2_cold_snapshot_stale"]);
    expect(auditCount("r2_cold_snapshot.health_change")).toBe(2);
    expect(getInternalSetting<string>(R2_COLD_SNAPSHOT_HEALTH_STATE_KEY)).toBe("ok");
  });

  it("does not lose the transition when the advisory throws — event first, state last", async () => {
    const now = Date.UTC(2026, 8, 8, 9, 0, 0);
    setLastSuccess(new Date(now - (R2_ARCHIVE_MAX_AGE_SECONDS + 86_400) * 1000).toISOString());

    const first = await reportR2WeeklyFreshness(now, {
      alertImpl: async () => {
        throw new Error("notification path down");
      },
    });

    // The advisory failing is not allowed to abort the transition or the state write.
    expect(first).toEqual({ state: "archive_stale", previous: null, changed: true });
    expect(auditCount("r2_cold_snapshot.health_change")).toBe(1);
    expect(getInternalSetting<string>(R2_COLD_SNAPSHOT_HEALTH_STATE_KEY)).toBe("archive_stale");

    // And it is not re-emitted on the next tick.
    const second = await reportR2WeeklyFreshness(now, { alertImpl: async () => {} });
    expect(second.changed).toBe(false);
  });

  it("treats a never-run archive as an alertable state", async () => {
    const alerts: string[] = [];
    const report = await reportR2WeeklyFreshness(Date.UTC(2026, 8, 8, 9, 0, 0), {
      alertImpl: async (warningType) => {
        alerts.push(warningType);
      },
    });
    expect(report).toEqual({ state: "archive_not_run", previous: null, changed: true });
    expect(alerts).toEqual(["r2_cold_snapshot_stale"]);
  });
});

// ── Pre-upload verification: an unverified snapshot is a hypothesis, not a backup ────

describe("assessSnapshotVerification", () => {
  const pass = (over: Partial<R2ColdSnapshotVerification> = {}): R2ColdSnapshotVerification => ({
    ok: true,
    integrity: "ok",
    tables: { audit_events: 10, settings: 3 },
    live: { audit_events: 12, settings: 3 },
    ...over,
  });

  it("passes when integrity_check is ok and every populated key table survived the copy", () => {
    expect(assessSnapshotVerification(pass())).toEqual({ ok: true });
  });

  it("treats a MISSING report as unverified, never as a pass", () => {
    // Silence is the failure mode this whole lane was built around: the 2026-09-06 run
    // hung instead of failing, so nothing was written and nothing alerted.
    expect(assessSnapshotVerification(null).ok).toBe(false);
    expect(assessSnapshotVerification(null).reason).toBe("snapshot_verification_missing");
  });

  it("fails when PRAGMA integrity_check did not say ok", () => {
    const verdict = assessSnapshotVerification(pass({ integrity: "*** in database main ***" }));
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("snapshot_integrity_check");
  });

  it("fails a structurally perfect but EMPTY copy of a populated table", () => {
    // integrity_check answers "is this a well-formed SQLite file", not "does it still hold
    // the trading state".  An empty database passes the first question and is worthless.
    const verdict = assessSnapshotVerification(pass({ tables: { audit_events: 0, settings: 3 } }));
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("snapshot_key_tables_empty=audit_events");
  });

  it("does not require exact row equality — the live DB is written continuously", () => {
    expect(
      assessSnapshotVerification(pass({ tables: { audit_events: 10, settings: 3 }, live: { audit_events: 99999, settings: 3 } })),
    ).toEqual({ ok: true });
  });

  it("fails closed when a live COUNT(*) could not be read", () => {
    // null is the child's catch-all for lock/schema/"no such table" -- not "absent".
    expect(
      assessSnapshotVerification(pass({ tables: { llm_usage: null }, live: { llm_usage: null } })),
    ).toEqual({ ok: false, reason: "snapshot_live_count_unreadable=llm_usage" });
  });

  it("asserts nothing about a table that is empty in the LIVE database", () => {
    expect(
      assessSnapshotVerification(pass({ tables: { llm_usage: 0 }, live: { llm_usage: 0 } })),
    ).toEqual({ ok: true });
  });
});

describe("parseSnapshotVerification", () => {
  it("returns null for empty or unparseable child output", () => {
    expect(parseSnapshotVerification("")).toBeNull();
    expect(parseSnapshotVerification("   ")).toBeNull();
    expect(parseSnapshotVerification("not json at all")).toBeNull();
  });

  it("parses a well-formed report and defaults ok to false unless explicitly true", () => {
    expect(parseSnapshotVerification('{"integrity":"ok","tables":{},"live":{}}')?.ok).toBe(false);
    expect(parseSnapshotVerification('{"ok":true,"integrity":"ok","tables":{},"live":{}}')?.ok).toBe(true);
  });
});

describe("snapshot verification against a real SQLite file", () => {
  it("the VACUUM child reports integrity ok plus row counts from the copy AND the live source", async () => {
    const dest = join(dirname(databasePath()), `verify-${randomUUID()}.db`);
    getDb().exec("CREATE TABLE IF NOT EXISTS verify_probe (id INTEGER PRIMARY KEY, v TEXT)");
    getDb().prepare("INSERT INTO verify_probe (v) VALUES (?)").run("row");

    const report = await runVacuumIntoSnapshot(databasePath(), dest, 60_000, ["verify_probe"]);

    expect(report?.integrity).toBe("ok");
    expect(report?.ok).toBe(true);
    expect(report?.tables.verify_probe).toBeGreaterThan(0);
    expect(report?.live.verify_probe).toBeGreaterThan(0);
    expect(assessSnapshotVerification(report)).toEqual({ ok: true });
    rmSync(dest, { force: true });
  }, 60_000);

  it("the standalone verifier rejects a file that is not a database", async () => {
    const bogus = join(dirname(databasePath()), `bogus-${randomUUID()}.db`);
    writeFileSync(bogus, randomBytes(4096));
    await expect(runSnapshotVerification(bogus, databasePath(), 30_000, ["verify_probe"])).rejects.toThrow();
    rmSync(bogus, { force: true });
  }, 60_000);
});

describe("describeRequestError", () => {
  it("unwraps the cause chain that Node's fetch hides behind 'fetch failed'", () => {
    // Production 2026-09-08T15:47:24Z recorded exactly "fetch failed" and nothing else,
    // which is why the upload failure that killed the first post-#3192 run could not be
    // classified at all.
    const cause = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    const err = Object.assign(new Error("fetch failed"), { cause });
    const described = describeRequestError(err);
    expect(described).toContain("fetch failed");
    expect(described).toContain("read ECONNRESET");
    expect(described).toContain("ECONNRESET");
  });

  it("degrades gracefully on a non-Error throw", () => {
    expect(describeRequestError("plain string")).toBe("plain string");
  });
});

// ── Drain path: verification gate, bounded request retry, whole-attempt deadline ─────

describe("drainR2ColdSnapshotJobs — verification gate and upload resilience", () => {
  it("refuses to upload an artifact that fails verification", async () => {
    setCreds();
    const now = Date.UTC(2026, 8, 6, 3, 20, 0);
    enqueueDueNow(now);
    const s3 = mockS3({});
    const captured: { path?: string; content?: Buffer } = {};

    const result = await drainR2ColdSnapshotJobs(now, {
      fetchImpl: s3.fetchImpl,
      backupImpl: fakeBackup(2500, captured),
      verifyImpl: async () => ({
        ok: false,
        integrity: "*** in database main *** row 3 missing from index",
        tables: { audit_events: 10 },
        live: { audit_events: 10 },
      }),
      alertImpl: async () => {},
      partSizeBytes: 1000,
    });

    expect(result.lastRun?.status).toBe("error");
    expect(result.lastRun?.reason).toContain("snapshot_verification_failed");
    // The decisive assertion: no bytes reached R2.  A corrupt copy replacing a good
    // archive object is strictly worse than a stale archive object.
    expect(s3.requests.some((r) => r.url.includes("partNumber="))).toBe(false);
    expect(s3.requests.some((r) => r.url.includes("uploads="))).toBe(false);
    // And the temp artifact is not left behind on the DB volume.
    expect(existsSync(captured.path!)).toBe(false);
  });

  it("treats a snapshot step that reports NOTHING as unverified when no verifier is available", async () => {
    setCreds();
    const now = Date.UTC(2026, 8, 6, 3, 20, 0);
    enqueueDueNow(now);
    const s3 = mockS3({});
    const captured: { path?: string; content?: Buffer } = {};

    const result = await drainR2ColdSnapshotJobs(now, {
      fetchImpl: s3.fetchImpl,
      backupImpl: fakeBackup(2500, captured),
      verifyImpl: async () => null,
      alertImpl: async () => {},
      partSizeBytes: 1000,
    });

    expect(result.lastRun?.status).toBe("error");
    expect(result.lastRun?.reason).toContain("snapshot_verification_missing");
    expect(s3.requests.some((r) => r.url.includes("partNumber="))).toBe(false);
  });

  it("retries a transient part failure instead of discarding the whole attempt", async () => {
    setCreds();
    const now = Date.UTC(2026, 8, 6, 3, 20, 0);
    enqueueDueNow(now);
    // Part 1 fails with a 500 on its FIRST try only — the shape of the single transient
    // `fetch failed` that discarded ~11 minutes of VACUUM work on 2026-09-08.
    let part1Calls = 0;
    const inner = mockS3({});
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("partNumber=1")) {
        part1Calls += 1;
        if (part1Calls === 1) return new Response("<Error>transient</Error>", { status: 503 });
      }
      return inner.fetchImpl(input as RequestInfo, init);
    }) as typeof fetch;

    const captured: { path?: string; content?: Buffer } = {};
    const result = await drainR2ColdSnapshotJobs(now, {
      fetchImpl,
      backupImpl: fakeBackup(2500, captured),
      verifyImpl: fakeVerify(),
      alertImpl: async () => {},
      partSizeBytes: 1000,
      retryDelayMs: 0,
    });

    expect(part1Calls).toBeGreaterThan(1);
    expect(result.lastRun?.status).toBe("ok");
  });

  it("retries a 200 OK CompleteMultipartUpload that embeds an <Error> body", async () => {
    setCreds();
    const now = Date.UTC(2026, 8, 6, 3, 20, 0);
    enqueueDueNow(now);
    let completeCalls = 0;
    const inner = mockS3({});
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "POST" && url.includes("uploadId=") && !url.includes("uploads=")) {
        completeCalls += 1;
        if (completeCalls === 1) {
          return new Response("<Error><Code>InternalError</Code></Error>", { status: 200 });
        }
      }
      return inner.fetchImpl(input as RequestInfo, init);
    }) as typeof fetch;

    const captured: { path?: string; content?: Buffer } = {};
    const result = await drainR2ColdSnapshotJobs(now, {
      fetchImpl,
      backupImpl: fakeBackup(2500, captured),
      verifyImpl: fakeVerify(),
      alertImpl: async () => {},
      partSizeBytes: 1000,
      retryDelayMs: 0,
    });

    expect(completeCalls).toBeGreaterThan(1);
    expect(result.lastRun?.status).toBe("ok");
  });

  it("gives up after the bounded number of request attempts rather than retrying forever", async () => {
    setCreds();
    const now = Date.UTC(2026, 8, 6, 3, 20, 0);
    enqueueDueNow(now);
    let part1Calls = 0;
    const inner = mockS3({});
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("partNumber=1")) {
        part1Calls += 1;
        return new Response("<Error>always</Error>", { status: 503 });
      }
      return inner.fetchImpl(input as RequestInfo, init);
    }) as typeof fetch;

    const captured: { path?: string; content?: Buffer } = {};
    const result = await drainR2ColdSnapshotJobs(now, {
      fetchImpl,
      backupImpl: fakeBackup(2500, captured),
      verifyImpl: fakeVerify(),
      alertImpl: async () => {},
      partSizeBytes: 1000,
      requestAttempts: 2,
      retryDelayMs: 0,
    });

    expect(part1Calls).toBe(2);
    expect(result.lastRun?.status).toBe("error");
  });

  it("fails inside its own lease when the UPLOAD hangs, not only when the snapshot does", async () => {
    setCreds();
    const now = Date.UTC(2026, 8, 6, 3, 20, 0);
    enqueueDueNow(now);
    // #3192 bounded only the snapshot step.  This is the gap its first production run
    // exposed: the snapshot finished and the run then died in the upload after 670 s.
    const fetchImpl = (async (input: unknown) => {
      if (String(input).includes("uploads=")) return await new Promise<Response>(() => {});
      return new Response("", { status: 200 });
    }) as typeof fetch;

    const captured: { path?: string; content?: Buffer } = {};
    const result = await drainR2ColdSnapshotJobs(now, {
      fetchImpl,
      backupImpl: fakeBackup(2500, captured),
      verifyImpl: fakeVerify(),
      alertImpl: async () => {},
      partSizeBytes: 1000,
      attemptDeadlineMs: 150,
    });

    expect(result.lastRun?.status).toBe("error");
    expect(result.lastRun?.reason).toContain("attempt_deadline_exceeded");
    expect(existsSync(captured.path!)).toBe(false);
  }, 20_000);
});

// ── Deadline clamps: an attempt must never be allowed to outlive its own lease ───────

describe("attempt deadline clamping", () => {
  it("clamps R2_COLD_SNAPSHOT_ATTEMPT_DEADLINE_MIN below the 2h job lease", () => {
    setCreds();
    // The lease `drainR2ColdSnapshotJobs` claims with is 120 min.  An attempt allowed to run
    // to or past it is the exact overlap the deadline exists to prevent: the next drain
    // reclaims the job, starts a second multi-GB snapshot, sweeps the first attempt's temp
    // file out from under its open fd, and races an upload to the same weekly key.
    process.env.R2_COLD_SNAPSHOT_ATTEMPT_DEADLINE_MIN = "180";
    expect(loadR2ColdSnapshotConfig().attemptDeadlineMs).toBe(R2_COLD_SNAPSHOT_MAX_ATTEMPT_DEADLINE_MS);
    expect(R2_COLD_SNAPSHOT_MAX_ATTEMPT_DEADLINE_MS).toBeLessThan(R2_COLD_SNAPSHOT_LEASE_MS);
  });

  it("honours an attempt deadline that is already under the ceiling", () => {
    setCreds();
    process.env.R2_COLD_SNAPSHOT_ATTEMPT_DEADLINE_MIN = "30";
    expect(loadR2ColdSnapshotConfig().attemptDeadlineMs).toBe(30 * 60_000);
  });

  it("never lets the snapshot-step deadline exceed the whole-attempt deadline", () => {
    setCreds();
    // A child handed a longer budget than its parent keeps running after the parent has
    // already reported failure.
    process.env.R2_COLD_SNAPSHOT_ATTEMPT_DEADLINE_MIN = "20";
    process.env.R2_COLD_SNAPSHOT_DEADLINE_MIN = "45";
    const cfg = loadR2ColdSnapshotConfig();
    expect(cfg.attemptDeadlineMs).toBe(20 * 60_000);
    expect(cfg.snapshotDeadlineMs).toBe(20 * 60_000);
  });

  it("defaults stay inside the ceiling", () => {
    setCreds();
    const cfg = loadR2ColdSnapshotConfig();
    expect(cfg.attemptDeadlineMs).toBe(R2_COLD_SNAPSHOT_DEFAULT_ATTEMPT_DEADLINE_MS);
    expect(cfg.attemptDeadlineMs).toBeLessThanOrEqual(R2_COLD_SNAPSHOT_MAX_ATTEMPT_DEADLINE_MS);
    expect(cfg.snapshotDeadlineMs).toBeLessThanOrEqual(cfg.attemptDeadlineMs);
  });
});

describe("multipart cleanup race", () => {
  it("aborts an upload whose id was minted but not yet assigned when the deadline fired", async () => {
    setCreds();
    const now = Date.UTC(2026, 8, 6, 3, 20, 0);
    enqueueDueNow(now);
    // CreateMultipartUpload resolves AFTER the attempt deadline has already fired, so the
    // catch block sees `uploadId === undefined` — the exact shape that used to orphan a
    // multipart upload in R2 forever.
    const aborted: string[] = [];
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("uploads=")) {
        await new Promise((r) => setTimeout(r, 400));
        return new Response(
          "<InitiateMultipartUploadResult><UploadId>LATE123</UploadId></InitiateMultipartUploadResult>",
          { status: 200 },
        );
      }
      if ((init?.method ?? "GET") === "DELETE" && url.includes("uploadId=")) {
        aborted.push(/uploadId=([^&]+)/.exec(url)?.[1] ?? "");
        return new Response(null, { status: 204 });
      }
      return new Response("", { status: 200 });
    }) as typeof fetch;

    const captured: { path?: string; content?: Buffer } = {};
    const result = await drainR2ColdSnapshotJobs(now, {
      fetchImpl,
      backupImpl: fakeBackup(2500, captured),
      verifyImpl: fakeVerify(),
      alertImpl: async () => {},
      partSizeBytes: 1000,
      attemptDeadlineMs: 150,
    });

    expect(result.lastRun?.status).toBe("error");
    expect(aborted).toEqual(["LATE123"]);
  }, 20_000);
});
