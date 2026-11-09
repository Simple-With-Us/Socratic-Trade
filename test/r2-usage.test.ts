import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  appendSentFromFooter,
  assessR2Usage,
  buildR2UsageDigestMessage,
  buildR2UsageDigestMessageForAccount,
  classifyR2Action,
  fetchR2RawUsage,
  formatOwnBackupRegimenLine,
  formatR2MetricValue,
  getR2UsageSnapshots,
  isR2AccountDueThisRun,
  isR2AutoDisableArmed,
  isR2ReplicationDisabled,
  isLitestreamReplicaCloudflareR2,
  isR2UsageCheckDue,
  loadR2UsageAccounts,
  loadR2UsageMonitorConfig,
  r2AlertTransitions,
  resolveSubjectPushoverAppToken,
  r2MonthWindow,
  resumeR2Replication,
  runR2UsageCheck,
  R2_FREE_TIER,
  R2_PEER_CHECK_PHASE,
} from "../src/lib/r2-usage";
import { deleteInternalSetting } from "../src/lib/db-settings";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-r2usage-${randomUUID()}.db`)}`;
});

beforeEach(() => {
  deleteInternalSetting("r2usage:lastSnapshots");
  deleteInternalSetting("r2usage:alertState");
  deleteInternalSetting("r2usage:lastCheckAt");
  delete process.env.CLOUDFLARE_ST_API_TOKEN;
  delete process.env.CLOUDFLARE_ST_ACCOUNT_ID;
  delete process.env.CLOUDFLARE_CT_API_TOKEN;
  delete process.env.CLOUDFLARE_CT_ACCOUNT_ID;
  delete process.env.CLOUDFLARE_JAY_API_TOKEN;
  delete process.env.CLOUDFLARE_JAY_ACCOUNT_ID;
  delete process.env.R2_USAGE_MONITOR_INTERVAL_HOURS;
  delete process.env.R2_USAGE_ALERT_THRESHOLD_PCT;
  delete process.env.R2_USAGE_BUCKET_FILTER;
  delete process.env.R2_USAGE_DISABLE_MARKER;
  delete process.env.R2_USAGE_AUTO_DISABLE;
  delete process.env.DB_BOOTSTRAP;
  delete process.env.R2_USAGE_CHECK_ALL_ACCOUNTS;
  delete process.env.PUSHOVER_ST_API_TOKEN;
  delete process.env.PUSHOVER_CT_API_TOKEN;
  delete process.env.PUSHOVER_USAGE_API_TOKEN;
  delete process.env.PUSHOVER_APP_TOKEN;
  // Existing alert tests assert exact notification counts; daily-report tests opt in explicitly.
});

// 2026-07-16T00:00:00Z — exactly mid-month-ish for July (31 days): 15/31 elapsed.
const MID_JULY = Date.UTC(2026, 6, 16);

describe("classifyR2Action", () => {
  it("maps read operations to Class B", () => {
    expect(classifyR2Action("GetObject")).toBe("B");
    expect(classifyR2Action("HeadObject")).toBe("B");
    expect(classifyR2Action("HeadBucket")).toBe("B");
    expect(classifyR2Action("GetBucketNotificationConfiguration")).toBe("B");
    expect(classifyR2Action("GetBucketSippyConfiguration")).toBe("B");
  });
  it("maps writes/lists/deletes/multipart to Class A", () => {
    for (const a of [
      "PutObject", "CopyObject", "DeleteObject", "DeleteObjects",
      "ListBuckets", "ListObjectsV2", "ListMultipartUploads", "ListParts",
      "CreateMultipartUpload", "UploadPart", "UploadPartCopy",
      "CompleteMultipartUpload", "AbortMultipartUpload",
    ]) {
      expect(classifyR2Action(a)).toBe("A");
    }
  });
  it("falls unknown action types to Class A (conservative: tighter quota)", () => {
    expect(classifyR2Action("SomeFutureAction")).toBe("A");
  });
});

describe("r2MonthWindow", () => {
  it("computes UTC month bounds and elapsed fraction", () => {
    const w = r2MonthWindow(MID_JULY);
    expect(w.startISO).toBe("2026-07-01T00:00:00.000Z");
    expect(w.endISO).toBe("2026-08-01T00:00:00.000Z");
    // 15 of 31 days elapsed
    expect(w.elapsedFraction).toBeCloseTo(15 / 31, 3);
  });
  it("floors the elapsed fraction at ~1h so early-month projections can't explode", () => {
    const firstMinute = Date.UTC(2026, 6, 1, 0, 1);
    const w = r2MonthWindow(firstMinute);
    expect(w.elapsedFraction).toBeGreaterThan(0.001);
    expect(w.elapsedFraction).toBeLessThan(0.01);
  });
});

describe("assessR2Usage", () => {
  it("flags a metric when projected month-end exceeds the threshold", () => {
    // 40% of Class A used by mid-month → projected ~80% > 70 threshold.
    const metrics = assessR2Usage({
      storageBytes: 0,
      classAOps: 400_000,
      classBOps: 0,
      thresholdPct: 70,
      now: MID_JULY,
    });
    const classA = metrics.find((m) => m.id === "classA")!;
    expect(classA.pctUsed).toBeCloseTo(40, 1);
    expect(classA.projectedPct).toBeGreaterThan(70);
    expect(classA.exceeded).toBe(true);
  });
  it("does not flag usage pacing under the threshold", () => {
    const metrics = assessR2Usage({
      storageBytes: 1 * 1024 ** 3, // 1 GiB mid-month → ~2 GiB projected = 20%
      classAOps: 100_000, // → ~200k projected = 20%
      classBOps: 1_000_000, // → ~2M projected = 20%
      thresholdPct: 70,
      now: MID_JULY,
    });
    expect(metrics.every((m) => !m.exceeded)).toBe(true);
  });
  it("uses the correct free-tier limits", () => {
    expect(R2_FREE_TIER.storageBytes).toBe(10 * 1024 ** 3);
    expect(R2_FREE_TIER.classAOps).toBe(1_000_000);
    expect(R2_FREE_TIER.classBOps).toBe(10_000_000);
  });

  it("storage alerts on ABSOLUTE usage only — pace never fires for bytes", () => {
    // 5.5 GiB at 1% of the month elapsed: raw pace would be ~550 GiB (5500%),
    // but storage is a stock metric — absolute 54% < 70 threshold → no alert.
    const early = Date.UTC(2026, 6, 1, 8); // ~8h into July
    const metrics = assessR2Usage({
      storageBytes: 5.5 * 1024 ** 3,
      classAOps: 0,
      classBOps: 0,
      thresholdPct: 70,
      now: early,
    });
    const storage = metrics.find((m) => m.id === "storage")!;
    expect(storage.alertBasis).toBe("absolute");
    expect(storage.pctUsed).toBeCloseTo(55, 0);
    expect(storage.exceeded).toBe(false);
    // Absolute crossing still alerts regardless of pace semantics.
    const hot = assessR2Usage({ storageBytes: 8 * 1024 ** 3, classAOps: 0, classBOps: 0, thresholdPct: 70, now: early });
    expect(hot.find((m) => m.id === "storage")!.exceeded).toBe(true);
  });

  it("ops pace uses the 0.2 elapsed floor — month-start bursts don't false-fire", () => {
    // ~7.4h into the month (elapsedFraction ≈ 0.01): 100k Class A ops.
    // Raw projection would be ~10M (1000% — absurd); floored: 100k/0.2 = 500k = 50% < 70.
    const early = Date.UTC(2026, 6, 1, 7, 26);
    const metrics = assessR2Usage({
      storageBytes: 0,
      classAOps: 100_000,
      classBOps: 0,
      thresholdPct: 70,
      now: early,
    });
    const classA = metrics.find((m) => m.id === "classA")!;
    expect(classA.alertBasis).toBe("pace");
    expect(classA.projectedPct).toBeCloseTo(50, 0);
    expect(classA.exceeded).toBe(false);
    // A genuinely hot month-start still fires: 200k ops → floored 1M = 100% > 70.
    const hot = assessR2Usage({ storageBytes: 0, classAOps: 200_000, classBOps: 0, thresholdPct: 70, now: early });
    expect(hot.find((m) => m.id === "classA")!.exceeded).toBe(true);
  });
});

describe("r2AlertTransitions", () => {
  const mk = (id: "storage" | "classA" | "classB", exceeded: boolean) => ({
    id, label: id, mtd: 0, limit: 1, pctUsed: 0, projected: 0, projectedPct: exceeded ? 99 : 1, exceeded,
    alertBasis: (id === "storage" ? "absolute" : "pace") as "absolute" | "pace", unit: "ops" as const,
  });
  it("emits crossed only on ok → exceeded", () => {
    const t = r2AlertTransitions({}, [mk("storage", true)]);
    expect(t).toHaveLength(1);
    expect(t[0].direction).toBe("crossed");
  });
  it("stays silent while steady-exceeded (no alert spam)", () => {
    const t = r2AlertTransitions({ storage: "exceeded" }, [mk("storage", true)]);
    expect(t).toHaveLength(0);
  });
  it("emits recovered on exceeded → ok", () => {
    const t = r2AlertTransitions({ storage: "exceeded" }, [mk("storage", false)]);
    expect(t).toHaveLength(1);
    expect(t[0].direction).toBe("recovered");
  });
});

function graphqlStorageAndOps(payloadSize: number, classA: number, classB: number) {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const query = String(init?.body ?? "");
    if (query.includes("r2StorageAdaptiveGroups")) {
      return new Response(JSON.stringify({
        data: { viewer: { accounts: [{ r2StorageAdaptiveGroups: [
          { max: { objectCount: 7, payloadSize }, dimensions: { bucketName: "socratic-trade-bucket", datetime: "2026-07-16T00:00:00Z" } },
        ] }] } },
        errors: null,
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      data: { viewer: { accounts: [{ r2OperationsAdaptiveGroups: [
        { sum: { requests: classA }, dimensions: { actionType: "PutObject", bucketName: "b" } },
        { sum: { requests: classB }, dimensions: { actionType: "GetObject", bucketName: "b" } },
      ] }] } },
      errors: null,
    }), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("fetchR2RawUsage", () => {
  it("sums storage per bucket and splits operations by billing class", async () => {
    const w = r2MonthWindow(MID_JULY);
    const raw = await fetchR2RawUsage("acct", "token", w, null, { fetchImpl: graphqlStorageAndOps(1234, 500, 900) });
    expect(raw.storageBytes).toBe(1234);
    expect(raw.objectCount).toBe(7);
    expect(raw.classAOps).toBe(500);
    expect(raw.classBOps).toBe(900);
    expect(raw.buckets[0].name).toBe("socratic-trade-bucket");
  });
  it("throws on graphql errors", async () => {
    const bad = (async () => new Response(JSON.stringify({ data: null, errors: [{ message: "bad filter" }] }), { status: 200 })) as unknown as typeof fetch;
    await expect(fetchR2RawUsage("acct", "token", r2MonthWindow(MID_JULY), null, { fetchImpl: bad })).rejects.toThrow("bad filter");
  });
});

describe("runR2UsageCheck", () => {
  it("skips silently when credentials are not configured", async () => {
    const res = await runR2UsageCheck(MID_JULY);
    expect(res.status).toBe("skipped");
    expect(res.reason).toBe("not_configured");
  });

  it("persists a snapshot and alerts once when a metric crosses the threshold", async () => {
    process.env.CLOUDFLARE_ST_API_TOKEN = "t";
    process.env.CLOUDFLARE_ST_ACCOUNT_ID = "acct";
    const notifyCalls: Array<{ title: string; body: string }> = [];
    const notifyImpl = (async (_u: string, msg: { title: string; body: string }) => {
      notifyCalls.push(msg);
      return [];
    }) as never;
    const deps = { fetchImpl: graphqlStorageAndOps(8 * 1024 ** 3, 100, 100), notifyImpl };

    // 8 GiB by mid-month → projected ~16.5 GiB = 165% → crossed.
    const first = await runR2UsageCheck(MID_JULY, deps);
    expect(first.status).toBe("ok");
    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0].title).toContain("Storage");
    expect(notifyCalls[0].title).toContain("⚠️");
    // Home free tier under ST logo — no sent-from footer.
    expect(notifyCalls[0].body).not.toContain("(sent from Socratic Trade)");

    const snap = getR2UsageSnapshots()[0]!;
    expect(snap.accountId).toBe("acct");
    expect(snap.metrics.find((m) => m.id === "storage")!.exceeded).toBe(true);

    // Second identical run: steady-exceeded → no repeat alert.
    const second = await runR2UsageCheck(MID_JULY + 3600_000, deps);
    expect(second.status).toBe("ok");
    expect(notifyCalls).toHaveLength(1);
  });

  it("sends a recovery notice when pace drops back under the threshold", async () => {
    process.env.CLOUDFLARE_ST_API_TOKEN = "t";
    process.env.CLOUDFLARE_ST_ACCOUNT_ID = "acct";
    const notifyCalls: Array<{ title: string; body: string }> = [];
    const notifyImpl = (async (_u: string, msg: { title: string; body: string }) => {
      notifyCalls.push(msg);
      return [];
    }) as never;

    await runR2UsageCheck(MID_JULY, {
      fetchImpl: graphqlStorageAndOps(8 * 1024 ** 3, 100, 100),
      notifyImpl,
    });
    // Usage shrinks (bucket cleaned) → recovery.
    await runR2UsageCheck(MID_JULY + 3600_000, {
      fetchImpl: graphqlStorageAndOps(1 * 1024 ** 3, 100, 100),
      notifyImpl,
    });
    expect(notifyCalls).toHaveLength(2);
    expect(notifyCalls[1].title).toContain("✅");
  });

  it("isR2UsageCheckDue gates on credentials and interval", async () => {
    expect(isR2UsageCheckDue(MID_JULY)).toBe(false); // no creds
    process.env.CLOUDFLARE_ST_API_TOKEN = "t";
    process.env.CLOUDFLARE_ST_ACCOUNT_ID = "acct";
    expect(isR2UsageCheckDue(MID_JULY)).toBe(true); // never ran
    await runR2UsageCheck(MID_JULY, { fetchImpl: graphqlStorageAndOps(0, 0, 0), notifyImpl: (async () => []) as never });
    // runR2UsageCheck doesn't set the cadence watermark (runR2UsageCheckIfDue does),
    // so it remains due — guard against accidental coupling.
    expect(isR2UsageCheckDue(MID_JULY + 1000)).toBe(true);
  });

  it("isLitestreamReplicaCloudflareR2 detects R2 endpoints only", () => {
    expect(isLitestreamReplicaCloudflareR2("https://abc.r2.cloudflarestorage.com")).toBe(true);
    expect(isLitestreamReplicaCloudflareR2("https://s3.eu-central-003.backblazeb2.com")).toBe(false);
    expect(isLitestreamReplicaCloudflareR2("")).toBe(false);
  });

  it("auto-disable (armed, live boot) writes the kill-switch marker, notifies, and exits — once", async () => {
    process.env.CLOUDFLARE_ST_API_TOKEN = "t";
    process.env.CLOUDFLARE_ST_ACCOUNT_ID = "acct";
    process.env.DB_BOOTSTRAP = "live";
    // Kill-switch only arms while litestream still targets Cloudflare R2.
    process.env.AWS_S3_ENDPOINT = "https://deadbeef.r2.cloudflarestorage.com";
    const marker = join(tmpdir(), `r2-disable-${randomUUID()}`);
    process.env.R2_USAGE_DISABLE_MARKER = marker;
    const notifyCalls: Array<{ title: string; body: string }> = [];
    const notifyImpl = (async (_u: string, msg: { title: string; body: string }) => {
      notifyCalls.push(msg);
      return [];
    }) as never;
    const exitCodes: number[] = [];
    const deps = {
      fetchImpl: graphqlStorageAndOps(8 * 1024 ** 3, 100, 100), // projected ~165% → exceeded
      notifyImpl,
      exitImpl: (code: number) => { exitCodes.push(code); },
    };

    await runR2UsageCheck(MID_JULY, deps);

    expect(exitCodes).toEqual([41]); // container restart requested
    expect(existsSync(marker)).toBe(true);
    const markerPayload = JSON.parse(readFileSync(marker, "utf8"));
    expect(markerPayload.reason).toContain("70%");
    expect(markerPayload.exceeded.map((e: { id: string }) => e.id)).toEqual(["storage"]);
    expect(notifyCalls.some((n) => n.title.includes("auto-disabled"))).toBe(true);
    expect(isR2ReplicationDisabled()).toBe(true);

    // Already disabled: a subsequent check must NOT write/notify/exit again.
    notifyCalls.length = 0;
    await runR2UsageCheck(MID_JULY + 3600_000, deps);
    expect(exitCodes).toEqual([41]);
    expect(notifyCalls.some((n) => n.title.includes("auto-disabled"))).toBe(false);

    // Resume removes the marker and restarts the container (exit 42).
    const resumeExits: number[] = [];
    const resumed = await resumeR2Replication({ exitImpl: (c) => resumeExits.push(c) });
    expect(resumed.resumed).toBe(true);
    expect(existsSync(marker)).toBe(false);
    expect(resumeExits).toEqual([42]);
    // Second resume is a no-op.
    const again = await resumeR2Replication({ exitImpl: (c) => resumeExits.push(c) });
    expect(again).toEqual({ resumed: false, reason: "not_disabled" });
    expect(resumeExits).toEqual([42]);
  });

  it("auto-disable does NOT fire when active litestream replica is Backblaze B2", async () => {
    process.env.CLOUDFLARE_ST_API_TOKEN = "t";
    process.env.CLOUDFLARE_ST_ACCOUNT_ID = "acct";
    process.env.DB_BOOTSTRAP = "live";
    process.env.AWS_S3_ENDPOINT = "https://s3.eu-central-003.backblazeb2.com";
    process.env.AWS_S3_BUCKET_NAME = "jays-socratic-trade-eu";
    const marker = join(tmpdir(), `r2-disable-b2-${randomUUID()}`);
    process.env.R2_USAGE_DISABLE_MARKER = marker;
    const exitCodes: number[] = [];
    await runR2UsageCheck(MID_JULY, {
      fetchImpl: graphqlStorageAndOps(8 * 1024 ** 3, 100, 100),
      notifyImpl: (async () => []) as never,
      exitImpl: (code: number) => {
        exitCodes.push(code);
      },
    });
    expect(exitCodes).toEqual([]);
    expect(existsSync(marker)).toBe(false);
    expect(isLitestreamReplicaCloudflareR2()).toBe(false);
  });

  it("auto-disable does NOT arm outside the live prod boot (no marker, no exit)", async () => {
    process.env.CLOUDFLARE_ST_API_TOKEN = "t";
    process.env.CLOUDFLARE_ST_ACCOUNT_ID = "acct";
    // DB_BOOTSTRAP unset (dev/test) — exceeded metrics must only alert, never kill.
    process.env.AWS_S3_ENDPOINT = "https://deadbeef.r2.cloudflarestorage.com";
    const marker = join(tmpdir(), `r2-disable-${randomUUID()}`);
    process.env.R2_USAGE_DISABLE_MARKER = marker;
    const exitCodes: number[] = [];
    await runR2UsageCheck(MID_JULY, {
      fetchImpl: graphqlStorageAndOps(8 * 1024 ** 3, 100, 100),
      notifyImpl: (async () => []) as never,
      exitImpl: (code: number) => { exitCodes.push(code); },
    });
    expect(exitCodes).toEqual([]);
    expect(existsSync(marker)).toBe(false);
    expect(isR2AutoDisableArmed(loadR2UsageMonitorConfig())).toBe(false);
  });

  it("kill-switch is st-scoped: another Cloudflare account over threshold never disables OUR litestream", async () => {
    process.env.CLOUDFLARE_ST_API_TOKEN = "t-st";
    process.env.CLOUDFLARE_ST_ACCOUNT_ID = "acct-st";
    process.env.CLOUDFLARE_CT_API_TOKEN = "t-ct";
    process.env.CLOUDFLARE_CT_ACCOUNT_ID = "acct-ct";
    process.env.DB_BOOTSTRAP = "live";
    const marker = join(tmpdir(), `r2-disable-${randomUUID()}`);
    process.env.R2_USAGE_DISABLE_MARKER = marker;
    const exitCodes: number[] = [];
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      const query = String(init?.body ?? "");
      const isSt = query.includes("acct-st");
      const payloadSize = isSt ? 1 * 1024 ** 3 : 9 * 1024 ** 3; // ct massively over (90% absolute), st fine (10%)
      if (query.includes("r2StorageAdaptiveGroups")) {
        return new Response(JSON.stringify({
          data: { viewer: { accounts: [{ r2StorageAdaptiveGroups: [
            { max: { objectCount: 7, payloadSize }, dimensions: { bucketName: "b", datetime: "2026-07-16T00:00:00Z" } },
          ] }] } },
          errors: null,
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        data: { viewer: { accounts: [{ r2OperationsAdaptiveGroups: [] }] } },
        errors: null,
      }), { status: 200 });
    }) as unknown as typeof fetch;

    await runR2UsageCheck(MID_JULY, {
      fetchImpl,
      notifyImpl: (async () => []) as never,
      exitImpl: (code: number) => { exitCodes.push(code); },
    });

    expect(exitCodes).toEqual([]); // st is under threshold — ct's overage must NOT stop our litestream
    expect(existsSync(marker)).toBe(false);
    expect(isR2ReplicationDisabled()).toBe(false);
  });
});

describe("formatR2MetricValue", () => {
  it("formats bytes as GiB and ops with separators", () => {
    const bytesM = assessR2Usage({ storageBytes: 2 * 1024 ** 3, classAOps: 0, classBOps: 0, thresholdPct: 70, now: MID_JULY })[0];
    expect(formatR2MetricValue(bytesM)).toBe("2.00 GiB");
    const opsM = assessR2Usage({ storageBytes: 0, classAOps: 123_456, classBOps: 0, thresholdPct: 70, now: MID_JULY })[1];
    expect(formatR2MetricValue(opsM)).toBe("123,456");
  });
});

describe("daily digest", () => {
  beforeEach(() => {
    deleteInternalSetting("r2usage:lastDigestAt");
    delete process.env.R2_USAGE_DAILY_DIGEST;
    delete process.env.R2_USAGE_DIGEST_INTERVAL_HOURS;
    // Tests use MID_JULY 00:00Z; disable fleet UTC-hour gate (-1 = any hour).
    process.env.R2_USAGE_DIGEST_UTC_HOUR = "-1";
  });

  it("buildR2UsageDigestMessage renders per-account sections with flags", async () => {
    const snapshot = {
      accountId: "acct-st",
      accountLabel: "Socratic Trade",
      checkedAt: "2026-07-16T12:00:00.000Z",
      month: { startISO: "2026-07-01T00:00:00.000Z", endISO: "2026-08-01T00:00:00.000Z", elapsedFraction: 0.5 },
      thresholdPct: 70,
      bucketFilter: null,
      metrics: assessR2Usage({
        storageBytes: 8 * 1024 ** 3, // 80% absolute — over threshold
        classAOps: 100_000,
        classBOps: 1_000_000,
        thresholdPct: 70,
        now: MID_JULY,
      }),
    };
    const ct = {
      ...snapshot,
      accountId: "acct-ct",
      accountLabel: "Congress.Trade",
      metrics: assessR2Usage({ storageBytes: 1 * 1024 ** 3, classAOps: 5_000, classBOps: 2_000, thresholdPct: 70, now: MID_JULY }),
    };
    const { title, body } = buildR2UsageDigestMessage([snapshot, ct]);
    expect(title).toContain("2026-07-16");
    expect(title).toContain("⚠️"); // ST storage over threshold
    expect(body).toContain("Socratic Trade");
    expect(body).toContain("Congress.Trade");
    expect(body).toContain("Storage: 8.00 GiB MTD (80.0%)");
    expect(body).toContain("Class A operations: 100,000 MTD (10.0%)");
    expect(body).toContain("⚠️"); // flagged line
    expect(body).toContain("✓"); // clean lines
    expect(body).toContain("Free tier per account");
  });

  it("is due by default when configured; respects the off flag and interval", async () => {
    const { isR2UsageDigestDue } = await import("../src/lib/r2-usage");
    expect(isR2UsageDigestDue(MID_JULY)).toBe(false); // no creds
    process.env.CLOUDFLARE_ST_API_TOKEN = "t";
    process.env.CLOUDFLARE_ST_ACCOUNT_ID = "acct";
    expect(isR2UsageDigestDue(MID_JULY)).toBe(true);
    process.env.R2_USAGE_DAILY_DIGEST = "off";
    expect(isR2UsageDigestDue(MID_JULY)).toBe(false);
  });

  it("sends a fresh summary via notify and watermarks the day", async () => {
    const { runR2UsageDailyDigestIfDue, isR2UsageDigestDue } = await import("../src/lib/r2-usage");
    process.env.CLOUDFLARE_ST_API_TOKEN = "t";
    process.env.CLOUDFLARE_ST_ACCOUNT_ID = "acct";
    const notifyCalls: Array<{ title: string; body: string; kind?: string }> = [];
    const notifyImpl = (async (_u: string, msg: { title: string; body: string; kind?: string }) => {
      notifyCalls.push(msg);
      return [];
    }) as never;
    const res = await runR2UsageDailyDigestIfDue(MID_JULY, {
      fetchImpl: graphqlStorageAndOps(1 * 1024 ** 3, 500, 900),
      notifyImpl,
    });
    expect(res.status).toBe("sent");
    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0].kind).toBe("r2-usage-digest");
    expect(notifyCalls[0].body).toContain("Storage: 1.00 GiB MTD");
    expect(notifyCalls[0].body).toContain("Class A operations: 500 MTD");
    expect(notifyCalls[0].body).toContain("Class B operations: 900 MTD");
    // Watermarked: not due again within the interval.
    expect(isR2UsageDigestDue(MID_JULY + 3600_000)).toBe(false);
    expect(isR2UsageDigestDue(MID_JULY + 25 * 3600_000)).toBe(true);
  });

  it("skips silently when the monitor is unconfigured", async () => {
    const { runR2UsageDailyDigestIfDue } = await import("../src/lib/r2-usage");
    const res = await runR2UsageDailyDigestIfDue(MID_JULY);
    expect(res.status).toBe("skipped");
  });
});

describe("multi-account", () => {
  it("loadR2UsageAccounts returns one entry per configured env pair", () => {
    expect(loadR2UsageAccounts()).toHaveLength(0);
    process.env.CLOUDFLARE_ST_API_TOKEN = "t1";
    process.env.CLOUDFLARE_ST_ACCOUNT_ID = "a1";
    process.env.CLOUDFLARE_JAY_API_TOKEN = "t3";
    process.env.CLOUDFLARE_JAY_ACCOUNT_ID = "a3";
    const accounts = loadR2UsageAccounts();
    expect(accounts.map((a) => a.id)).toEqual(["st", "um"]);
    expect(accounts[0].label).toBe("Socratic Trade");
    expect(accounts[1].label).toBe("Usage Monitor");
  });

  it("checks every configured account; one failing account doesn't block the others", async () => {
    process.env.R2_USAGE_CHECK_ALL_ACCOUNTS = "1";
    process.env.CLOUDFLARE_ST_API_TOKEN = "t1";
    process.env.CLOUDFLARE_ST_ACCOUNT_ID = "a1";
    process.env.CLOUDFLARE_CT_API_TOKEN = "t2";
    process.env.CLOUDFLARE_CT_ACCOUNT_ID = "a2";
    const okFetch = graphqlStorageAndOps(1 * 1024 ** 3, 100, 200);
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = String(init?.body ?? "");
      if (body.includes("a2")) return new Response(JSON.stringify({ data: null, errors: [{ message: "ct down" }] }), { status: 200 });
      return okFetch(url, init);
    }) as unknown as typeof fetch;
    const res = await runR2UsageCheck(MID_JULY, { fetchImpl, notifyImpl: (async () => []) as never });
    expect(res.status).toBe("partial");
    expect(res.results).toHaveLength(2);
    expect(res.results.find((r) => r.accountId === "a1")!.status).toBe("ok");
    expect(res.results.find((r) => r.accountId === "a2")!.status).toBe("error");
    // The healthy account's snapshot still persists.
    expect(getR2UsageSnapshots()).toHaveLength(1);
    expect(getR2UsageSnapshots()[0].accountId).toBe("a1");
  });

  it("alert state tracks accounts independently", async () => {
    process.env.R2_USAGE_CHECK_ALL_ACCOUNTS = "1";
    process.env.CLOUDFLARE_ST_API_TOKEN = "t1";
    process.env.CLOUDFLARE_ST_ACCOUNT_ID = "a1";
    process.env.CLOUDFLARE_CT_API_TOKEN = "t2";
    process.env.CLOUDFLARE_CT_ACCOUNT_ID = "a2";
    const notifyCalls: Array<{ title: string; body: string }> = [];
    const notifyImpl = (async (_u: string, msg: { title: string; body: string }) => { notifyCalls.push(msg); return []; }) as never;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = String(init?.body ?? "");
      // ST hot (8 GiB), CT quiet (1 GiB) — only ST should alert.
      const hot = body.includes("a1");
      return graphqlStorageAndOps(hot ? 8 * 1024 ** 3 : 1 * 1024 ** 3, 100, 100)(url, init);
    }) as unknown as typeof fetch;
    await runR2UsageCheck(MID_JULY, { fetchImpl, notifyImpl });
    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0].title).toContain("Socratic Trade");
    // ST subject + ST runner → no footer.
    expect(notifyCalls[0].body).not.toContain("(sent from");
  });

  it("peer-subject alerts append sent-from footer; home does not", async () => {
    process.env.R2_USAGE_CHECK_ALL_ACCOUNTS = "1";
    process.env.CLOUDFLARE_ST_API_TOKEN = "t1";
    process.env.CLOUDFLARE_ST_ACCOUNT_ID = "a1";
    process.env.CLOUDFLARE_CT_API_TOKEN = "t2";
    process.env.CLOUDFLARE_CT_ACCOUNT_ID = "a2";
    const notifyCalls: Array<{ title: string; body: string }> = [];
    const notifyImpl = (async (_u: string, msg: { title: string; body: string }) => {
      notifyCalls.push(msg);
      return [];
    }) as never;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = String(init?.body ?? "");
      // CT hot, ST quiet — peer subject under CT logo needs sent-from.
      const hot = body.includes("a2");
      return graphqlStorageAndOps(hot ? 8 * 1024 ** 3 : 1 * 1024 ** 3, 100, 100)(url, init);
    }) as unknown as typeof fetch;
    await runR2UsageCheck(MID_JULY, { fetchImpl, notifyImpl });
    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0].title).toContain("Congress.Trade");
    expect(notifyCalls[0].body).toContain("(sent from Socratic Trade)");
  });

  it("staggers peer checks by UTC hour phase (home always due)", () => {
    // MID_JULY is 00:00Z → hour 0; ST peer phase is 2.
    expect(isR2AccountDueThisRun("st", MID_JULY)).toBe(true);
    expect(isR2AccountDueThisRun("ct", MID_JULY)).toBe(false);
    expect(isR2AccountDueThisRun("um", MID_JULY)).toBe(false);
    const peerHour = Date.UTC(2026, 6, 16, R2_PEER_CHECK_PHASE.st);
    expect(isR2AccountDueThisRun("ct", peerHour)).toBe(true);
    expect(isR2AccountDueThisRun("um", peerHour)).toBe(true);
    process.env.R2_USAGE_CHECK_ALL_ACCOUNTS = "1";
    expect(isR2AccountDueThisRun("ct", MID_JULY)).toBe(true);
  });

  it("resolveSubjectPushoverAppToken maps account → product token", () => {
    process.env.PUSHOVER_ST_API_TOKEN = "st-tok";
    process.env.PUSHOVER_CT_API_TOKEN = "ct-tok";
    process.env.PUSHOVER_USAGE_API_TOKEN = "um-tok";
    expect(resolveSubjectPushoverAppToken("st")).toBe("st-tok");
    expect(resolveSubjectPushoverAppToken("ct")).toBe("ct-tok");
    expect(resolveSubjectPushoverAppToken("um")).toBe("um-tok");
  });

  it("appendSentFromFooter only when subject ≠ sender", () => {
    expect(appendSentFromFooter("hi", "st")).toBe("hi");
    expect(appendSentFromFooter("hi", "ct")).toBe("hi\n(sent from Socratic Trade)");
    expect(appendSentFromFooter("hi\n(sent from Socratic Trade)", "um")).toBe(
      "hi\n(sent from Socratic Trade)",
    );
  });

  it("formatOwnBackupRegimenLine references Hetzner 24h floor", () => {
    expect(formatOwnBackupRegimenLine({ killEngaged: true })).toContain("Hetzner");
    expect(formatOwnBackupRegimenLine({ killEngaged: false, litestreamState: "active" })).toContain("litestream active");
    expect(formatOwnBackupRegimenLine({ killEngaged: false, lastReplicaAgeMs: 30 * 3600_000 })).toContain("⚠️");
  });

  it("buildR2UsageDigestMessageForAccount is single-subject", () => {
    const snapshot = {
      accountId: "acct-ct",
      accountLabel: "Congress.Trade",
      checkedAt: "2026-07-16T12:00:00.000Z",
      month: { startISO: "2026-07-01T00:00:00.000Z", endISO: "2026-08-01T00:00:00.000Z", elapsedFraction: 0.5 },
      thresholdPct: 70,
      bucketFilter: null,
      metrics: assessR2Usage({
        storageBytes: 1 * 1024 ** 3,
        classAOps: 5_000,
        classBOps: 2_000,
        thresholdPct: 70,
        now: MID_JULY,
      }),
      buckets: [],
    };
    const { title, body } = buildR2UsageDigestMessageForAccount(snapshot);
    expect(title).toContain("2026-07-16");
    expect(body).toContain("Congress.Trade");
    expect(body).not.toContain("Socratic Trade\n");
  });
});
