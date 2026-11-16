import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import {
  assessLitestreamRuntimeHealth,
  assessLitestreamTierFreshness,
  compareLitestreamTxid,
  defaultLitestreamRuntimeLogPath,
  defaultLitestreamSocketPath,
  defaultLitestreamStatePath,
  getLitestreamRuntimeHealth,
  isLitestreamReplicatingStatus,
  LITESTREAM_PRODUCT_DISABLED_TIERS,
  LITESTREAM_TIER_LABELS,
  LITESTREAM_TIER_STALE_AFTER_SECONDS,
  maxTxidFromLtxFilename,
  parseLitestreamListPayload,
  runtimeReleaseIdentity,
  scanLitestreamRuntimeLogFile,
  scanLitestreamRuntimeLogText
} from "../src/lib/runtime-health";

import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";

const tempRoots: string[] = [];
const socketPaths: string[] = [];
const servers: Server[] = [];
const originalCwd = process.cwd();

function useShortSocketPath(root: string): string {
  // Darwin limits Unix-domain socket path strings to roughly 104 bytes. Vitest's
  // per-run TMPDIR is deliberately nested, so bind a short absolute name in /tmp
  // to avoid process.chdir global state issues and path length limits.
  const p = `/tmp/litestream-${randomUUID().slice(0, 8)}.sock`;
  socketPaths.push(p);
  return p;
}

async function safeListen(server: ReturnType<typeof createServer>, socketPath: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    server.once("listening", () => resolve(true));
    server.once("error", (e: any) => {
      if (e.code === "EPERM") resolve(false);
      else reject(e);
    });
    try {
      server.listen(socketPath);
    } catch (e: any) {
      if (e.code === "EPERM") resolve(false);
      else reject(e);
    }
  });
}

afterEach(async () => {
  vi.useRealTimers();
  process.chdir(originalCwd);
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const sock of socketPaths.splice(0)) {
    try { unlinkSync(sock); } catch (e) { /* ignore */ }
  }
});

describe("runtime release identity", () => {
  it("uses the first valid commit env and rejects arbitrary public strings", () => {
    const identity = runtimeReleaseIdentity({
      APP_RELEASE_SHA: "not-a-commit-or-secret",
      SOURCE_COMMIT: "ABCDEF1234567"
    }, Date.now());
    expect(identity.sha).toBe("abcdef1234567");
    expect(identity.processStartedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(identity.processUptimeSeconds).toBeGreaterThanOrEqual(0);
  });
});

describe("Litestream runtime health", () => {
  it("uses Litestream 0.5.x's hidden default metadata directory", () => {
    expect(defaultLitestreamStatePath("/app/data/app.db")).toBe("/app/data/.app.db-litestream");
  });

  it("defaults the IPC socket next to the DB (writable by non-root container users)", () => {
    expect(defaultLitestreamSocketPath("/app/data/app.db")).toBe("/app/data/litestream.sock");
    expect(defaultLitestreamSocketPath("/Users/jay/apps/trading-live/data/app.db")).toBe(
      "/Users/jay/apps/trading-live/data/litestream.sock"
    );
  });

  it("accepts both documented active-replication status spellings", () => {
    expect(isLitestreamReplicatingStatus("replicating")).toBe(true);
    expect(isLitestreamReplicatingStatus("active")).toBe(true);
    expect(isLitestreamReplicatingStatus("open")).toBe(false);
    expect(isLitestreamReplicatingStatus("stopped")).toBe(false);
  });

  it("parses the matching database and computes last-sync age", () => {
    const now = Date.parse("2026-07-11T05:00:00.000Z");
    expect(parseLitestreamListPayload({
      databases: [
        { path: "/other.db", status: "replicating", last_sync_at: "2026-07-11T04:59:59.000Z" },
        { path: "/app/data/app.db", status: "replicating", last_sync_at: "2026-07-11T04:59:30.000Z" }
      ]
    }, "/app/data/app.db", now)).toEqual({
      state: "known",
      source: "ipc",
      status: "replicating",
      lastSyncAt: "2026-07-11T04:59:30.000Z",
      ageSeconds: 30,
      timestampState: "valid"
    });
  });

  it("rejects materially future last-sync timestamps", () => {
    const now = Date.parse("2026-07-11T05:00:00.000Z");
    expect(parseLitestreamListPayload({
      databases: [{
        path: "/app/data/app.db",
        status: "replicating",
        last_sync_at: "2026-07-11T05:10:00.000Z"
      }]
    }, "/app/data/app.db", now)).toEqual({
      state: "known",
      source: "ipc",
      status: "replicating",
      lastSyncAt: null,
      ageSeconds: null,
      timestampState: "invalid"
    });
  });

  it("reads the real IPC /list shape over a Unix socket", async () => {
    const root = mkdtempSync(join(tmpdir(), "socratic-litestream-health-"));
    tempRoots.push(root);
    const socketPath = useShortSocketPath(root);
    const server = createServer((req, res) => {
      expect(req.url).toBe("/list");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        databases: [{
          path: "/app/data/app.db",
          status: "replicating",
          last_sync_at: "2026-07-11T04:59:50.000Z"
        }]
      }));
    });
    servers.push(server);
    if (!await safeListen(server, socketPath)) return;

    await expect(getLitestreamRuntimeHealth({
      dbPath: "/app/data/app.db",
      socketPath,
      timeoutMs: 500,
      nowMs: Date.parse("2026-07-11T05:00:00.000Z")
    })).resolves.toEqual({
      state: "known",
      source: "ipc",
      status: "replicating",
      lastSyncAt: "2026-07-11T04:59:50.000Z",
      ageSeconds: 10,
      timestampState: "valid"
    });
  });

  it("finds the control socket at the Litestream 0.5.x db-dir default when no path is configured", async () => {
    // Prod 2026-07-30..08-01: 0.5.12 ignores the config file's `socket.path` and listens at
    // <db-dir>/litestream.sock; the health probe only tried /var/run/litestream.sock and
    // reported litestreamState "unknown" for days while replication was healthy. The probe
    // must now discover the db-dir default on its own (no explicit socketPath, no env).
    vi.stubEnv("LITESTREAM_SOCKET_PATH", "");
    const root = mkdtempSync("/tmp/litestream-dbdir-");
    tempRoots.push(root);
    const dbPath = join(root, "app.db");
    const socketPath = join(root, "litestream.sock");
    socketPaths.push(socketPath);
    const server = createServer((req, res) => {
      expect(req.url).toBe("/list");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        databases: [{
          path: dbPath,
          status: "replicating",
          last_sync_at: "2026-07-11T04:59:50.000Z"
        }]
      }));
    });
    servers.push(server);
    if (!await safeListen(server, socketPath)) return;

    await expect(getLitestreamRuntimeHealth({
      dbPath,
      timeoutMs: 500,
      allowFileFallback: false,
      nowMs: Date.parse("2026-07-11T05:00:00.000Z")
    })).resolves.toEqual({
      state: "known",
      source: "ipc",
      status: "replicating",
      lastSyncAt: "2026-07-11T04:59:50.000Z",
      ageSeconds: 10,
      timestampState: "valid"
    });
  });

  it("enforces a wall-clock deadline even when the socket keeps trickling bytes", async () => {
    const root = mkdtempSync(join(tmpdir(), "socratic-litestream-deadline-"));
    tempRoots.push(root);
    const socketPath = useShortSocketPath(root);
    const server = createServer((_req, res) => {
      res.write("{");
      const interval = setInterval(() => res.write(" "), 5);
      res.on("close", () => clearInterval(interval));
    });
    servers.push(server);
    if (!await safeListen(server, socketPath)) return;

    let watchdog: NodeJS.Timeout | undefined;
    const result = await Promise.race([
      getLitestreamRuntimeHealth({
        dbPath: "/app/data/app.db",
        socketPath,
        timeoutMs: 30
      }),
      new Promise<never>((_resolve, reject) => {
        watchdog = setTimeout(() => reject(new Error("IPC wall-clock deadline did not fire")), 300);
      })
    ]).finally(() => {
      if (watchdog) clearTimeout(watchdog);
    });
    expect(result).toEqual({ state: "unknown", source: "none" });
  });

  it("caps IPC response bodies and falls back instead of buffering without limit", async () => {
    const root = mkdtempSync(join(tmpdir(), "socratic-litestream-cap-"));
    tempRoots.push(root);
    const socketPath = useShortSocketPath(root);
    const statePath = join(root, "last-activity");
    writeFileSync(statePath, "ok");
    const server = createServer((_req, res) => {
      res.end(JSON.stringify({
        databases: [{
          path: "/app/data/app.db",
          status: "replicating",
          last_sync_at: "2026-07-11T04:59:50.000Z",
          padding: "x".repeat(512)
        }]
      }));
    });
    servers.push(server);
    if (!await safeListen(server, socketPath)) return;

    const result = await getLitestreamRuntimeHealth({
      dbPath: "/app/data/app.db",
      socketPath,
      statePath,
      maxResponseBytes: 128,
      timeoutMs: 500
    });
    expect(result).toMatchObject({ state: "known", source: "file", status: "activity-observed" });
  });

  it("falls back promptly when the daemon aborts a partial response", async () => {
    const root = mkdtempSync(join(tmpdir(), "socratic-litestream-abort-"));
    tempRoots.push(root);
    const socketPath = useShortSocketPath(root);
    const server = createServer((_req, res) => {
      res.write('{"databases":[');
      res.socket?.destroy();
    });
    servers.push(server);
    if (!await safeListen(server, socketPath)) return;

    let watchdog: NodeJS.Timeout | undefined;
    const result = await Promise.race([
      getLitestreamRuntimeHealth({
        dbPath: "/app/data/app.db",
        socketPath,
        timeoutMs: 1_000
      }),
      new Promise<never>((_resolve, reject) => {
        watchdog = setTimeout(() => reject(new Error("aborted IPC response was not handled")), 300);
      })
    ]).finally(() => {
      if (watchdog) clearTimeout(watchdog);
    });
    expect(result).toEqual({ state: "unknown", source: "none" });
  });

  it("falls back to an explicitly tracked state file when IPC is unavailable", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T05:00:00.000Z"));
    const root = mkdtempSync(join(tmpdir(), "socratic-litestream-state-"));
    tempRoots.push(root);
    const statePath = join(root, "last-sync");
    writeFileSync(statePath, "ok");
    const now = new Date("2026-07-11T05:00:00.000Z");
    utimesSync(statePath, now, now);

    const result = await getLitestreamRuntimeHealth({
      dbPath: "/app/data/app.db",
      socketPath: join(root, "missing.sock"),
      statePath,
      timeoutMs: 25,
      nowMs: Date.now()
    });
    expect(result).toMatchObject({ state: "known", source: "file", status: "activity-observed" });
    expect(result.state === "known" ? result.ageSeconds : null).toBe(0);
  });

  it("skips file metadata entirely when live mode disables the diagnostic fallback", async () => {
    const root = mkdtempSync(join(tmpdir(), "socratic-litestream-live-skip-"));
    tempRoots.push(root);
    const statePath = join(root, "last-activity");
    writeFileSync(statePath, "recent but not proof of an R2 upload");

    await expect(getLitestreamRuntimeHealth({
      dbPath: "/app/data/app.db",
      socketPath: join(root, "missing.sock"),
      statePath,
      allowFileFallback: false,
      timeoutMs: 25
    })).resolves.toEqual({ state: "unknown", source: "none" });
  });

  // This test used to assert the OPPOSITE: that a directory over 256 entries made the scan
  // return `{ state: "unknown" }`. Bounding the work was right; answering "I saw nothing"
  // because the directory was big was not — that is defect cause #2 from the 2026-08-12
  // rollout, and it blinded the per-tier check on every production health probe, since
  // `ltx/0` normally holds 1,000+ files. The scan is still bounded (a fixed stat budget per
  // directory, plus depth and directory-count caps); it just no longer refuses to answer.
  it("stays bounded on a large metadata tree while still reporting the newest activity", async () => {
    const root = mkdtempSync(join(tmpdir(), "socratic-litestream-bounded-scan-"));
    tempRoots.push(root);
    const now = Date.now();
    const ltxDir = join(root, "ltx", "0");
    mkdirSync(ltxDir, { recursive: true });
    for (let index = 0; index < 1200; index += 1) {
      const hex = (0x37000 + index).toString(16).padStart(16, "0");
      const file = join(ltxDir, `${hex}-${hex}.ltx`);
      writeFileSync(file, "x");
      const mtime = new Date(now - (1200 - index) * 60_000);
      utimesSync(file, mtime, mtime);
    }

    const started = Date.now();
    const result = await getLitestreamRuntimeHealth({
      dbPath: "/app/data/app.db",
      socketPath: join(root, "missing.sock"),
      statePath: root,
      timeoutMs: 25
    });

    expect(result).toMatchObject({ state: "known", source: "file", status: "activity-observed" });
    // The newest of the 1,200 files, found without stat-ing all of them.
    expect(result.state === "known" && result.ageSeconds).toBeLessThanOrEqual(120);
    // Bounded work, not a full 1,200-entry stat sweep.
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("reports unknown without treating an absent daemon as healthy", async () => {
    const root = mkdtempSync(join(tmpdir(), "socratic-litestream-missing-"));
    tempRoots.push(root);
    await expect(getLitestreamRuntimeHealth({
      dbPath: "/app/data/app.db",
      socketPath: join(root, "missing.sock"),
      timeoutMs: 25
    })).resolves.toEqual({ state: "unknown", source: "none" });
  });
});

describe("Litestream production health decisions", () => {
  const healthy = {
    state: "known" as const,
    source: "ipc" as const,
    status: "replicating",
    lastSyncAt: "2026-07-11T04:59:50.000Z",
    ageSeconds: 10,
    timestampState: "valid" as const
  };

  it("accepts a recent successful IPC sync in live mode", () => {
    expect(assessLitestreamRuntimeHealth(healthy, {
      liveMode: true,
      processUptimeSeconds: 600
    })).toEqual({ degraded: false, reasons: [] });
  });

  it("marks an unavailable live-mode signal degraded", () => {
    expect(assessLitestreamRuntimeHealth({ state: "unknown", source: "none" }, {
      liveMode: true,
      processUptimeSeconds: 10
    })).toEqual({ degraded: true, reasons: ["unavailable"] });
  });

  it("never treats a fresh file mtime as verified R2 health in live mode", () => {
    expect(assessLitestreamRuntimeHealth({
      state: "known",
      source: "file",
      status: "activity-observed",
      lastSyncAt: "2026-07-11T05:00:00.000Z",
      ageSeconds: 0,
      timestampState: "valid"
    }, {
      liveMode: true,
      processUptimeSeconds: 600
    })).toEqual({ degraded: true, reasons: ["file-unverified"] });
  });

  it("allows a missing first sync only during startup grace", () => {
    const neverSynced = { ...healthy, lastSyncAt: null, ageSeconds: null, timestampState: "missing" as const };
    expect(assessLitestreamRuntimeHealth(neverSynced, {
      liveMode: true,
      processUptimeSeconds: 299,
      startupGraceSeconds: 300
    })).toEqual({ degraded: false, reasons: [] });
    expect(assessLitestreamRuntimeHealth(neverSynced, {
      liveMode: true,
      processUptimeSeconds: 300,
      startupGraceSeconds: 300
    })).toEqual({ degraded: true, reasons: ["never-synced"] });
  });

  it("marks unsynced local activity stale but keeps an idle caught-up database healthy", () => {
    expect(assessLitestreamRuntimeHealth({ ...healthy, ageSeconds: 3_601 }, {
      liveMode: true,
      processUptimeSeconds: 600,
      staleAfterSeconds: 3_600,
      latestLocalActivityAtMs: Date.parse("2026-07-11T05:00:00.000Z")
    })).toEqual({ degraded: true, reasons: ["stale"] });
    expect(assessLitestreamRuntimeHealth({ ...healthy, ageSeconds: 3_601 }, {
      liveMode: true,
      processUptimeSeconds: 600,
      staleAfterSeconds: 3_600,
      latestLocalActivityAtMs: Date.parse("2026-07-11T04:00:00.000Z")
    })).toEqual({ degraded: false, reasons: [] });
  });

  it("marks stopped and invalid-timestamp IPC states degraded", () => {
    expect(assessLitestreamRuntimeHealth({ ...healthy, status: "stopped" }, {
      liveMode: true,
      processUptimeSeconds: 600
    })).toEqual({ degraded: true, reasons: ["stopped"] });
    expect(assessLitestreamRuntimeHealth({
      ...healthy,
      lastSyncAt: null,
      ageSeconds: null,
      timestampState: "invalid"
    }, {
      liveMode: true,
      processUptimeSeconds: 600
    })).toEqual({ degraded: true, reasons: ["invalid-sync-time"] });
  });

  it("keeps a file signal diagnostic-only without degrading non-live development", () => {
    expect(assessLitestreamRuntimeHealth({
      state: "known",
      source: "file",
      status: "activity-observed",
      lastSyncAt: "2026-07-11T05:00:00.000Z",
      ageSeconds: 0,
      timestampState: "valid"
    }, {
      liveMode: false,
      processUptimeSeconds: 600
    })).toEqual({ degraded: false, reasons: [] });
  });
});


// ---------------------------------------------------------------------------------------
// Per-compaction-level backup freshness.
//
// The 2026-08-11/12 implementation of this feature had ZERO production coverage: it graded
// every level from local `ltx/<level>/` mtimes, but (1) Litestream 0.5.12 keeps only level 0
// on local disk, so levels 1/2/3/9 had no directory to read, and (2) the shared scan bailed
// out to `null` past 256 entries while `ltx/0` legitimately holds 1,000+ files. Every tier
// reported "unknown" on every health check while appearing to cover all five.
//
// These tests pin down the replacement: a real signal per level where one exists, an explicit
// and explained "not-observable" where one does not, and detection of the actual wedge.
// ---------------------------------------------------------------------------------------
describe("Litestream per-tier compaction freshness", () => {
  function writeLtxFile(statePath: string, tier: string, name: string, mtime: Date) {
    const dir = join(statePath, "ltx", tier);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, name);
    writeFileSync(file, "ltx");
    utimesSync(file, mtime, mtime);
  }

  /** Litestream's real filename shape: `<minTXID>-<maxTXID>.ltx`, zero-padded hex. */
  function ltxName(txid: number): string {
    const hex = txid.toString(16).padStart(16, "0");
    return `${hex}-${hex}.ltx`;
  }

  function remoteLevel(level: number, newestAt: string, newestTxid: string | null, fileCount = 1) {
    return { level, newestAt, newestTxid, fileCount };
  }

  function byTier(report: { tiers: Array<{ tier: string }> }) {
    return Object.fromEntries(report.tiers.map((t) => [t.tier, t])) as Record<string, any>;
  }

  it("parses Litestream's LTX filename txid range and orders ids of differing widths numerically", () => {
    expect(maxTxidFromLtxFilename("0000000000005249-00000000000052a8.ltx")).toBe("00000000000052a8");
    expect(maxTxidFromLtxFilename("not-an-ltx-file.txt")).toBeNull();
    // 0x37ce0 (level 0, live) is far ahead of 0xe5ad (level 2, wedged) despite equal padding.
    expect(compareLitestreamTxid("0000000000037ce0", "000000000000e5ad")).toBeGreaterThan(0);
    // Differing widths must still compare numerically, not lexicographically.
    expect(compareLitestreamTxid("ff", "0000000000000100")).toBeLessThan(0);
    expect(compareLitestreamTxid("00000000000052a8", "52a8")).toBe(0);
  });

  // REGRESSION for defect cause #2. `ltx/0` held 1,078 files on the live container on
  // 2026-08-12; the old flat 256-entry bound made the scan return null, so the ONE level that
  // is genuinely readable locally still reported "unknown" on every single health check. The
  // replacement stats only the highest-named few entries, so directory size is irrelevant.
  it("measures level 0 from a directory holding far more files than the old 256-entry bound", () => {
    const root = mkdtempSync(join(tmpdir(), "socratic-ltx-large-l0-"));
    tempRoots.push(root);
    const now = Date.parse("2026-08-12T23:30:00.000Z");

    // 1,200 files, mirroring production scale. Older txids get older mtimes, so the newest
    // filename is also the newest write — the property the sampling strategy relies on.
    for (let index = 0; index < 1200; index += 1) {
      writeLtxFile(root, "0", ltxName(0x37000 + index), new Date(now - (1200 - index) * 60_000));
    }

    const report = assessLitestreamTierFreshness(root, { nowMs: now });
    const tier0 = byTier(report)["0"];
    expect(tier0.state).toBe("known");
    expect(tier0.source).toBe("local-ltx");
    expect(tier0.ageSeconds).toBe(60); // the newest of the 1,200 files, not a bailout
    expect(tier0.newestTxid).toBe((0x37000 + 1199).toString(16).padStart(16, "0"));
    expect(tier0.degraded).toBe(false);
  });

  // REGRESSION for defect cause #1. Levels 1/2/3/9 have no local directory in production, and
  // the old code called that "unknown" — indistinguishable from "we looked and all is quiet".
  it("reports levels that exist only in the remote replica as not-observable, with a reason, when no inventory has been collected", () => {
    const root = mkdtempSync(join(tmpdir(), "socratic-ltx-remote-only-"));
    tempRoots.push(root);
    const now = Date.parse("2026-08-12T23:30:00.000Z");
    writeLtxFile(root, "0", ltxName(0x37ce0), new Date(now - 60_000));

    const report = assessLitestreamTierFreshness(root, { nowMs: now, remoteInventory: null });
    const tiers = byTier(report);

    expect(tiers["0"].state).toBe("known");
    for (const tier of ["1", "2", "3", "9"]) {
      expect(tiers[tier].state).toBe("not-observable");
      expect(tiers[tier].reason).toBe("remote-inventory-missing");
      expect(tiers[tier].detail).toContain("remote replica");
      // Crucially NOT a verdict: no age, no degraded flag to misread as health.
      expect(tiers[tier]).not.toHaveProperty("ageSeconds");
      expect(tiers[tier]).not.toHaveProperty("degraded");
    }
    // The report says out loud how much it actually covers.
    expect(report.observedTiers).toBe(1);
    expect(report.notObservableTiers).toBe(4);
    expect(report.remoteInventoryState).toBe("missing");
    // "Cannot see it" must never be reported as "it is broken".
    expect(report.degraded).toBe(false);
  });

  it("reports every tier not-observable, never crashing, when no state path is configured at all", () => {
    const report = assessLitestreamTierFreshness(undefined);
    expect(report.tiers).toHaveLength(5);
    expect(report.tiers.every((t) => t.state === "not-observable")).toBe(true);
    expect(report.tiers.every((t) => "reason" in t && t.reason === "no-state-path")).toBe(true);
    expect(report.observedTiers).toBe(0);
    expect(report.degraded).toBe(false);
    // Labels stay present so the UI always has all five cards to render.
    expect(report.tiers.map((t) => t.label)).toEqual([
      LITESTREAM_TIER_LABELS["0"],
      LITESTREAM_TIER_LABELS["1"],
      LITESTREAM_TIER_LABELS["2"],
      LITESTREAM_TIER_LABELS["3"],
      LITESTREAM_TIER_LABELS["9"]
    ]);
  });

  // ===================================================================================
  // THE INCIDENT. Every number below was read off the live production replica at
  // 2026-08-12T23:30Z, while `/api/health` reported all five tiers "unknown" and the
  // container log was emitting `compaction failed ... level=2 ... non-contiguous
  // transaction ids` roughly every 30 minutes.
  // ===================================================================================
  it("flags the wedged level-2 compaction from the real 2026-08-12 production replica state", () => {
    const root = mkdtempSync(join(tmpdir(), "socratic-ltx-incident-"));
    tempRoots.push(root);
    const now = Date.parse("2026-08-12T23:30:00.000Z");

    // Level 0 is healthy and ADVANCING — this is what made the wedge invisible to every
    // pre-existing signal, all of which track level 0's last sync.
    writeLtxFile(root, "0", ltxName(0x37cde), new Date(now - 252_000));
    writeLtxFile(root, "0", ltxName(0x37ce0), new Date(now - 238_000));

    const report = assessLitestreamTierFreshness(root, {
      nowMs: now,
      remoteInventory: {
        collectedAt: "2026-08-12T23:20:00.000Z",
        status: "ok",
        levels: {
          "1": remoteLevel(1, "2026-08-10T14:54:39.000Z", "000000000002324c", 5635),
          "2": remoteLevel(2, "2026-08-08T14:35:05.000Z", "000000000000e5ad", 171),
          "3": remoteLevel(3, "2026-08-08T15:00:22.000Z", "000000000000e5ad", 15),
          "9": remoteLevel(9, "2026-08-12T00:01:18.000Z", "0000000000030586", 8)
        },
        levelErrors: {},
        skippedReason: null
      }
    });
    const tiers = byTier(report);

    // Level 0: fresh, and the reason the higher levels are provably behind rather than idle.
    expect(tiers["0"]).toMatchObject({ state: "known", source: "local-ltx", degraded: false });

    // Level 2: THE WEDGE. Frozen since 2026-08-08 at txid 0xe5ad while level 0 reached
    // 0x37ce0. This is the failure the whole monitor exists to catch and previously could not.
    expect(tiers["2"]).toMatchObject({
      state: "known",
      source: "remote-inventory",
      newestTxid: "000000000000e5ad",
      degraded: true
    });
    expect(tiers["2"].ageSeconds).toBeGreaterThan(4 * 24 * 3600);

    // Levels 1 and 3 were also stalled behind level 0 at the same moment.
    expect(tiers["1"]).toMatchObject({ state: "known", degraded: true });
    expect(tiers["3"]).toMatchObject({ state: "known", degraded: true });

    // Level 9 (daily snapshot) was genuinely healthy ~23.5h old, inside its 30h threshold —
    // proving the check discriminates rather than blanket-failing everything remote.
    expect(tiers["9"]).toMatchObject({ state: "known", degraded: false });
    expect(tiers["9"].ageSeconds).toBeLessThan(30 * 3600);

    expect(report.degraded).toBe(true);
    expect(report.observedTiers).toBe(5);
    expect(report.notObservableTiers).toBe(0);
  });

  // The counterpart guard: without it, every quiet period on an idle database would light up
  // all four higher levels. A level that has caught up with level 0 has nothing left to do.
  it("does not flag a quiet higher level that has already caught up with level 0", () => {
    const root = mkdtempSync(join(tmpdir(), "socratic-ltx-idle-"));
    tempRoots.push(root);
    const now = Date.parse("2026-08-12T23:30:00.000Z");

    // Database idle for 3 days: level 0's newest file is old, and level 2 compacted right up
    // to it before everything went quiet.
    writeLtxFile(root, "0", ltxName(0xe5ad), new Date(now - 3 * 24 * 3_600_000));

    const report = assessLitestreamTierFreshness(root, {
      nowMs: now,
      remoteInventory: {
        collectedAt: "2026-08-12T23:20:00.000Z",
        status: "ok",
        levels: {
          "1": remoteLevel(1, "2026-08-09T23:30:00.000Z", "000000000000e5ad"),
          "2": remoteLevel(2, "2026-08-09T23:30:00.000Z", "000000000000e5ad"),
          "3": remoteLevel(3, "2026-08-09T23:30:00.000Z", "000000000000e5ad"),
          "9": remoteLevel(9, "2026-08-09T23:30:00.000Z", "000000000000e5ad")
        },
        levelErrors: {},
        skippedReason: null
      }
    });
    const tiers = byTier(report);

    for (const tier of ["1", "2", "3", "9"]) {
      expect(tiers[tier].state).toBe("known");
      expect(tiers[tier].ageSeconds).toBeGreaterThan(tiers[tier].thresholdSeconds);
      expect(tiers[tier].degraded).toBe(false); // caught up with level 0 — nothing to compact
    }
    // Level 0 itself IS graded on age alone, and 3 days idle is past its 10-minute threshold.
    expect(tiers["0"].degraded).toBe(true);
  });

  it("refuses to grade remote levels from an inventory older than the max age, and says why", () => {
    const root = mkdtempSync(join(tmpdir(), "socratic-ltx-stale-inv-"));
    tempRoots.push(root);
    const now = Date.parse("2026-08-12T23:30:00.000Z");
    writeLtxFile(root, "0", ltxName(0x37ce0), new Date(now - 60_000));

    const report = assessLitestreamTierFreshness(root, {
      nowMs: now,
      // Collected 4 hours ago — well past LITESTREAM_REMOTE_INVENTORY_MAX_AGE_SECONDS (90 min).
      remoteInventory: {
        collectedAt: new Date(now - 4 * 3_600_000).toISOString(),
        status: "ok",
        levels: { "2": remoteLevel(2, "2026-08-08T14:35:05.000Z", "000000000000e5ad", 171) },
        levelErrors: {},
        skippedReason: null
      }
    });
    const tiers = byTier(report);

    // A dead collector must not be reported as a wedged backup: frozen numbers would age out
    // on their own and manufacture an incident that is not happening.
    expect(tiers["2"]).toMatchObject({ state: "not-observable", reason: "remote-inventory-stale" });
    expect(report.remoteInventoryState).toBe("stale");
    expect(report.degraded).toBe(false);
  });

  // UPDATED 2026-08-14. This test previously asserted that level 3 — listed successfully with
  // zero files — reported `not-observable` / `no-activity-recorded`. That expectation encoded
  // the bug: a successful listing returning zero is a MEASUREMENT, and calling it "cannot
  // observe" (with the detail "This is normal...") is what hid the deep-compaction outage. The
  // three cases this test distinguishes are unchanged; the third one now lands in `empty`.
  it("distinguishes a failed level listing, an un-collected level, and a level measured as empty", () => {
    const root = mkdtempSync(join(tmpdir(), "socratic-ltx-mixed-"));
    tempRoots.push(root);
    const now = Date.parse("2026-08-12T23:30:00.000Z");
    writeLtxFile(root, "0", ltxName(0x37ce0), new Date(now - 60_000));

    const report = assessLitestreamTierFreshness(root, {
      nowMs: now,
      remoteInventory: {
        collectedAt: "2026-08-12T23:20:00.000Z",
        status: "partial",
        // 4 files at level 2 spans only floor(3/2) x 300s = 5 minutes of compaction
        // boundaries, far inside level 3's 6h threshold — so level 3's emptiness is reported
        // as measured-but-not-yet-a-verdict rather than a wedge.
        levels: {
          "2": remoteLevel(2, "2026-08-12T23:00:00.000Z", "000000000002324c", 4),
          "3": remoteLevel(3, "", null, 0)
        },
        levelErrors: { "1": "dial tcp: connection refused" },
        skippedReason: null
      }
    });
    const tiers = byTier(report);

    expect(tiers["1"]).toMatchObject({ state: "not-observable", reason: "remote-inventory-failed" });
    expect(tiers["1"].detail).toContain("connection refused");
    expect(tiers["2"].state).toBe("known");
    expect(tiers["3"]).toMatchObject({ state: "empty", verdict: "expected", reason: "within-threshold", degraded: false });
    expect(tiers["9"]).toMatchObject({ state: "not-observable", reason: "remote-inventory-missing" });
    // An empty level we listed successfully counts as OBSERVED — we measured it.
    expect(report.observedTiers).toBe(3);
    expect(report.notObservableTiers).toBe(2);
    expect(report.degraded).toBe(false);
  });

  it("uses the documented default thresholds and accepts a caller-supplied override per tier", () => {
    expect(LITESTREAM_TIER_STALE_AFTER_SECONDS).toEqual({
      "0": 10 * 60,
      "1": 4 * 60 * 60,
      "2": 2 * 60 * 60,
      "3": 6 * 60 * 60,
      "9": 30 * 60 * 60
    });

    const root = mkdtempSync(join(tmpdir(), "socratic-ltx-override-"));
    tempRoots.push(root);
    const now = Date.parse("2026-08-11T12:00:00.000Z");
    writeLtxFile(root, "0", ltxName(0x1000), new Date(now - 5 * 60_000)); // 5 minutes old

    // Below the default 10-minute threshold: healthy.
    expect(assessLitestreamTierFreshness(root, { nowMs: now }).tiers[0]).toMatchObject({ degraded: false });
    // A tighter caller-supplied threshold (1 minute) flips the same data to degraded, proving
    // the threshold is actually load-bearing and not hardcoded past the options parameter.
    expect(
      assessLitestreamTierFreshness(root, { nowMs: now, thresholdsSeconds: { "0": 60 } }).tiers[0]
    ).toMatchObject({ degraded: true, thresholdSeconds: 60 });
  });

  it("ignores non-LTX files and an empty local level directory without inventing activity", () => {
    const root = mkdtempSync(join(tmpdir(), "socratic-ltx-noise-"));
    tempRoots.push(root);
    mkdirSync(join(root, "ltx", "0"), { recursive: true });
    writeFileSync(join(root, "ltx", "0", "README.txt"), "not an ltx file");

    const report = assessLitestreamTierFreshness(root, { nowMs: Date.now() });
    expect(byTier(report)["0"]).toMatchObject({ state: "not-observable" });
    expect(report.degraded).toBe(false);
  });
});

// =====================================================================================
// EMPTY-LEVEL WEDGE DETECTION (2026-08-14).
//
// The terminal stage of a compaction wedge is not a frozen level — it is an EMPTY one.
// Litestream's retention (`snapshot.retention: 168h`) keeps pruning a wedged level's
// pre-wedge objects while the wedge produces no replacements, so level 2 in production
// went 171 objects (2026-08-12, frozen) -> 0 objects (2026-08-14, empty).  Until this
// change, `fileCount <= 0` was classified `not-observable` / `no-activity-recorded` with
// the detail "This is normal for a level Litestream has not needed to produce", so the
// MOST advanced stage of the failure was also its most reassuring-looking one.
//
// The rule: a level whose remote listing SUCCEEDED and returned zero objects is graded
// against its immediate feeder.  Litestream v0.5.12's `Store.CompactDB` has no volume or
// accumulation threshold — it skips only when it already ran this boundary or when
// `srcInfo.MaxTXID <= dstInfo.MinTXID`, and an EMPTY destination has `MinTXID == 0`, so
// that test can never hold while the feeder has files.  An empty level with a non-empty
// feeder has therefore been offered work on every interval tick and produced nothing.
// Duration comes from the feeder's file count: `CompactDB` permits at most one file per
// level per interval boundary, so K retained files occupy >= K-1 boundaries.
// =====================================================================================
describe("Litestream empty-level wedge detection", () => {
  function writeLtxFile(statePath: string, tier: string, name: string, mtime: Date) {
    const dir = join(statePath, "ltx", tier);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, name);
    writeFileSync(file, "ltx");
    utimesSync(file, mtime, mtime);
  }

  function ltxName(txid: number): string {
    const hex = txid.toString(16).padStart(16, "0");
    return `${hex}-${hex}.ltx`;
  }

  function remoteLevel(level: number, newestAt: string, newestTxid: string | null, fileCount = 1) {
    return { level, newestAt, newestTxid, fileCount };
  }

  function byTier(report: { tiers: Array<{ tier: string }> }) {
    return Object.fromEntries(report.tiers.map((t) => [t.tier, t])) as Record<string, any>;
  }

  const tempRoots: string[] = [];
  afterEach(() => {
    for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  // ===================================================================================
  // THE INCIDENT, read off the persisted remote-inventory snapshot in production
  // (durable_state, namespace "litestream") at 2026-08-14T03:46Z:
  //
  //   status: "ok",  levelErrors: {},  skippedReason: null
  //   level 1: fileCount 2032, newest 2026-08-14T03:46:05Z, txid 00000000000468d8
  //   level 2: fileCount 0,    newest "",  txid null
  //   level 3: fileCount 0,    newest "",  txid null
  //   level 9: fileCount 2,    newest 2026-08-14T00:00:06Z, txid 0000000000043200
  //
  // The listing SUCCEEDED — this is not a visibility failure.  Deep compaction has
  // produced nothing since ~2026-08-08 and `/api/health` reported no degraded reason for
  // six days.  ROOT CAUSE (owner's to fix, out of scope here): every Coolify rolling
  // deploy briefly runs two litestream writers against the same B2 prefix, and 0.5.12 has
  // no fencing, so level-1 objects land with different MinTXID and identical MaxTXID;
  // `ltx.IsContiguous` requires max > prevMax, so the 1 -> 2 promotion fails permanently.
  // This test only asserts the monitor stops calling that state normal.
  // ===================================================================================
  it("calls the 2026-08-14 production shape a wedge instead of normal", () => {
    const root = mkdtempSync(join(tmpdir(), "socratic-ltx-empty-wedge-"));
    tempRoots.push(root);
    const now = Date.parse("2026-08-14T03:50:00.000Z");
    // Level 0 healthy and advancing — exactly what kept every pre-existing signal green.
    writeLtxFile(root, "0", ltxName(0x468d8), new Date(now - 30_000));

    const report = assessLitestreamTierFreshness(root, {
      nowMs: now,
      remoteInventory: {
        collectedAt: "2026-08-14T03:46:10.000Z",
        status: "ok",
        levels: {
          "1": remoteLevel(1, "2026-08-14T03:46:05.000Z", "00000000000468d8", 2032),
          "2": remoteLevel(2, "", null, 0),
          "3": remoteLevel(3, "", null, 0),
          "9": remoteLevel(9, "2026-08-14T00:00:06.000Z", "0000000000043200", 2)
        },
        levelErrors: {},
        skippedReason: null
      }
    });
    const tiers = byTier(report);

    // Level 2 is THE wedge: its feeder holds 2,032 files spanning at least
    // floor(2031/2) x 30s = 30,450s = 8h27m of compaction boundaries (the /2 absorbs the
    // rolling-deploy double writer), against level 2's 2h threshold.
    expect(tiers["2"]).toMatchObject({
      state: "empty",
      verdict: "wedged",
      reason: "backlog-past-threshold",
      degraded: true,
      feederTier: "1",
      feederFileCount: 2032,
      backlogSpanSeconds: 30_450
    });
    // The alarm ships with arithmetic a reader can check, not an adjective.
    expect(tiers["2"].detail).toContain("2032 file(s)");
    expect(tiers["2"].detail).toContain("8h27m");

    // Level 3 is empty only BECAUSE level 2 is (`srcLevel = dstLevel - 1` is literal in
    // litestream's Compactor.Compact).  It is still a real gap in the replica, so it
    // degrades — but its copy names level 2 as the thing to fix rather than presenting a
    // second, independent fault.
    expect(tiers["3"]).toMatchObject({
      state: "empty",
      verdict: "upstream-wedged",
      reason: "upstream-wedged",
      degraded: true,
      feederTier: "2"
    });
    expect(tiers["3"].detail).toContain("Fixing level 2");

    // Regression guard: the levels that ARE healthy must stay healthy and stay "known".
    expect(tiers["0"]).toMatchObject({ state: "known", source: "local-ltx", degraded: false });
    expect(tiers["1"]).toMatchObject({ state: "known", source: "remote-inventory", degraded: false });
    expect(tiers["1"].newestTxid).toBe("00000000000468d8");
    expect(tiers["9"]).toMatchObject({ state: "known", source: "remote-inventory", degraded: false });
    expect(tiers["9"].ageSeconds).toBeLessThan(30 * 3600);

    // What /api/health actually publishes: a degraded storage tier with a stated reason.
    // Before this change both were absent — degraded false, reasons [].
    expect(report.degraded).toBe(true);
    expect(report.degradedReasons.length).toBeGreaterThan(0);
    expect(report.degradedReasons.some((r) => r.includes("no objects at level 2"))).toBe(true);
    // Five levels listed, five levels observed: emptiness is a measurement, not a blind spot.
    expect(report.observedTiers).toBe(5);
    expect(report.notObservableTiers).toBe(0);
  });

  // The one path that can SILENCE the alarm above, pinned so it cannot come back.  Level 9 is
  // a whole-DB snapshot — `Store.CompactDB` shortcuts it straight to `db.Snapshot` — so its
  // txid tracks the live database, not level 3, and it carries zero information about whether
  // level 2 compacted.  In the window right after each daily snapshot, level 9's txid is
  // NORMALLY at or past level 1's.  Treating that as proof of promotion turned the wedge below
  // into `expected/superseded degraded=false` and printed a factually false sentence.
  it("does not let the daily snapshot level explain away an empty compaction level", () => {
    const root = mkdtempSync(join(tmpdir(), "socratic-ltx-snapshot-superseded-"));
    tempRoots.push(root);
    const now = Date.parse("2026-08-14T03:50:00.000Z");
    writeLtxFile(root, "0", ltxName(0x468d8), new Date(now - 30_000));

    const report = assessLitestreamTierFreshness(root, {
      nowMs: now,
      remoteInventory: {
        collectedAt: "2026-08-14T03:46:10.000Z",
        status: "ok",
        levels: {
          "1": remoteLevel(1, "2026-08-14T03:46:05.000Z", "00000000000468d8", 2032),
          "2": remoteLevel(2, "", null, 0),
          "3": remoteLevel(3, "", null, 0),
          // The ONLY change from the production shape above: the snapshot has just run, so
          // level 9's txid has caught up with level 1's.
          "9": remoteLevel(9, "2026-08-14T03:40:00.000Z", "00000000000468d8", 2)
        },
        levelErrors: {},
        skippedReason: null
      }
    });
    const tiers = byTier(report);

    expect(tiers["2"]).toMatchObject({
      state: "empty",
      verdict: "wedged",
      reason: "backlog-past-threshold",
      degraded: true
    });
    expect(tiers["2"].detail).not.toContain("promoted rather than lost");
    expect(tiers["3"]).toMatchObject({ state: "empty", verdict: "upstream-wedged", degraded: true });
    expect(report.degraded).toBe(true);
    expect(report.degradedReasons.some((r) => r.includes("no objects at level 2"))).toBe(true);
  });

  // The `superseded` verdict still has to WORK where it is true: a level that really was
  // drained upward by the level that consumes it.  Level 2 holds nothing, but level 3 — which
  // is fed by level 2 — has already advanced past what level 1 holds, so level 2's objects
  // were promoted, not lost.
  it("still calls an empty level superseded when the level that consumes it has advanced", () => {
    const root = mkdtempSync(join(tmpdir(), "socratic-ltx-real-superseded-"));
    tempRoots.push(root);
    const now = Date.parse("2026-08-14T03:50:00.000Z");
    writeLtxFile(root, "0", ltxName(0x468d8), new Date(now - 30_000));

    const report = assessLitestreamTierFreshness(root, {
      nowMs: now,
      remoteInventory: {
        collectedAt: "2026-08-14T03:46:10.000Z",
        status: "ok",
        levels: {
          "1": remoteLevel(1, "2026-08-14T03:46:05.000Z", "00000000000468d8", 2032),
          "2": remoteLevel(2, "", null, 0),
          "3": remoteLevel(3, "2026-08-14T03:30:00.000Z", "00000000000468d8", 4),
          "9": remoteLevel(9, "2026-08-14T00:00:06.000Z", "0000000000043200", 2)
        },
        levelErrors: {},
        skippedReason: null
      }
    });
    const tiers = byTier(report);

    expect(tiers["2"]).toMatchObject({
      state: "empty",
      verdict: "expected",
      reason: "superseded",
      degraded: false
    });
    expect(tiers["2"].detail).toContain("Level 3 has already advanced");
    expect(report.degraded).toBe(false);
  });

  // THE FALSE-ALARM GUARD, and it matters as much as the test above.  A monitor that cries
  // wolf gets ignored, and "empty" is the NORMAL state of a young replica.
  it("does not alarm on a brand-new replica whose higher levels have not been produced yet", () => {
    const root = mkdtempSync(join(tmpdir(), "socratic-ltx-fresh-replica-"));
    tempRoots.push(root);
    const now = Date.parse("2026-08-14T03:50:00.000Z");
    writeLtxFile(root, "0", ltxName(0x100), new Date(now - 30_000));

    const report = assessLitestreamTierFreshness(root, {
      nowMs: now,
      remoteInventory: {
        collectedAt: "2026-08-14T03:49:30.000Z",
        status: "ok",
        levels: {
          // Six minutes of level-1 output: span = floor(5/2) x 30s = 60s, nowhere near
          // level 2's 2h threshold.  Clearing that gate needs 481 level-1 files, which at
          // one file per 30s boundary cannot happen inside ~4 hours of wall clock no matter
          // how the compactor behaves.
          "1": remoteLevel(1, "2026-08-14T03:49:00.000Z", "0000000000000100", 6),
          "2": remoteLevel(2, "", null, 0),
          "3": remoteLevel(3, "", null, 0),
          "9": remoteLevel(9, "", null, 0)
        },
        levelErrors: {},
        skippedReason: null
      }
    });
    const tiers = byTier(report);

    expect(tiers["2"]).toMatchObject({ state: "empty", verdict: "expected", reason: "within-threshold", degraded: false });
    expect(tiers["3"]).toMatchObject({ state: "empty", verdict: "expected", reason: "upstream-empty", degraded: false });
    expect(tiers["9"]).toMatchObject({ state: "empty", verdict: "expected", degraded: false });
    // Nothing is hidden — every empty level still says out loud that it is empty.
    expect(tiers["2"].detail).toContain("no objects at level 2");
    expect(report.degraded).toBe(false);
    expect(report.degradedReasons).toEqual([]);
  });

  it("does not alarm on an idle database whose feeder has gone quiet", () => {
    const root = mkdtempSync(join(tmpdir(), "socratic-ltx-idle-empty-"));
    tempRoots.push(root);
    const now = Date.parse("2026-08-14T03:50:00.000Z");
    // Quiet for three days: level 0 stopped, so level 1 stopped, so there is nothing for
    // levels 2 and 3 to promote.  Level 1 keeps its 2,032 retained files the whole time,
    // which is exactly why a file-count-only rule would false-alarm here.
    writeLtxFile(root, "0", ltxName(0x468d8), new Date(now - 3 * 24 * 3_600_000));

    const report = assessLitestreamTierFreshness(root, {
      nowMs: now,
      remoteInventory: {
        collectedAt: "2026-08-14T03:45:00.000Z",
        status: "ok",
        levels: {
          // Newest level-1 object is 6 hours old, past level 1's own 4h threshold.
          "1": remoteLevel(1, "2026-08-13T21:45:00.000Z", "00000000000468d8", 2032),
          "2": remoteLevel(2, "", null, 0),
          "3": remoteLevel(3, "", null, 0),
          "9": remoteLevel(9, "2026-08-14T00:00:06.000Z", "00000000000468d8", 2)
        },
        levelErrors: {},
        skippedReason: null
      }
    });
    const tiers = byTier(report);

    expect(tiers["2"]).toMatchObject({ state: "empty", verdict: "expected", reason: "input-idle", degraded: false });
    expect(tiers["2"].detail).toContain("idle rather than stuck");
    expect(tiers["3"]).toMatchObject({ state: "empty", verdict: "expected", reason: "upstream-empty", degraded: false });
    // Neither empty level contributes an alarm.  (Level 0 itself IS graded on age alone and
    // three days of silence is past its 10-minute threshold — pre-existing, documented
    // behaviour, and not what this rule is responsible for.)
    expect(report.degradedReasons.some((r) => r.includes("level 2") || r.includes("level 3"))).toBe(false);
  });

  // A successful listing that returns nothing at EVERY remote level is a prefix, bucket, or
  // credential mismatch — not four simultaneous independent wedges.
  it("treats an entirely empty remote listing as a coverage problem, not four wedges", () => {
    const root = mkdtempSync(join(tmpdir(), "socratic-ltx-empty-prefix-"));
    tempRoots.push(root);
    const now = Date.parse("2026-08-14T03:50:00.000Z");
    writeLtxFile(root, "0", ltxName(0x468d8), new Date(now - 30_000));

    const report = assessLitestreamTierFreshness(root, {
      nowMs: now,
      remoteInventory: {
        collectedAt: "2026-08-14T03:45:00.000Z",
        status: "ok",
        levels: {
          "1": remoteLevel(1, "", null, 0),
          "2": remoteLevel(2, "", null, 0),
          "3": remoteLevel(3, "", null, 0),
          "9": remoteLevel(9, "", null, 0)
        },
        levelErrors: {},
        skippedReason: null
      }
    });
    const tiers = byTier(report);

    for (const tier of ["1", "2", "3", "9"]) {
      expect(tiers[tier]).toMatchObject({ state: "not-observable", reason: "remote-inventory-empty" });
    }
    expect(report.degraded).toBe(false);
  });

  // "I cannot see it" and "it is wedged" must stay distinct.  Both shapes below carry the
  // exact production numbers that DO produce a wedge when the inventory is trustworthy.
  it("keeps a stale inventory honest instead of converting it into a wedge", () => {
    const root = mkdtempSync(join(tmpdir(), "socratic-ltx-empty-stale-"));
    tempRoots.push(root);
    const now = Date.parse("2026-08-14T03:50:00.000Z");
    writeLtxFile(root, "0", ltxName(0x468d8), new Date(now - 30_000));

    const report = assessLitestreamTierFreshness(root, {
      nowMs: now,
      remoteInventory: {
        // Four hours old — past LITESTREAM_REMOTE_INVENTORY_MAX_AGE_SECONDS (90 min).
        collectedAt: new Date(now - 4 * 3_600_000).toISOString(),
        status: "ok",
        levels: {
          "1": remoteLevel(1, "2026-08-14T03:46:05.000Z", "00000000000468d8", 2032),
          "2": remoteLevel(2, "", null, 0),
          "3": remoteLevel(3, "", null, 0),
          "9": remoteLevel(9, "2026-08-14T00:00:06.000Z", "0000000000043200", 2)
        },
        levelErrors: {},
        skippedReason: null
      }
    });
    const tiers = byTier(report);

    for (const tier of ["1", "2", "3", "9"]) {
      expect(tiers[tier]).toMatchObject({ state: "not-observable", reason: "remote-inventory-stale" });
    }
    expect(report.remoteInventoryState).toBe("stale");
    expect(report.degraded).toBe(false);
    expect(report.degradedReasons).toEqual([]);
  });

  it("keeps a failed level listing honest instead of converting it into a wedge", () => {
    const root = mkdtempSync(join(tmpdir(), "socratic-ltx-empty-failed-"));
    tempRoots.push(root);
    const now = Date.parse("2026-08-14T03:50:00.000Z");
    writeLtxFile(root, "0", ltxName(0x468d8), new Date(now - 30_000));

    const report = assessLitestreamTierFreshness(root, {
      nowMs: now,
      remoteInventory: {
        collectedAt: "2026-08-14T03:46:10.000Z",
        status: "partial",
        levels: {
          "1": remoteLevel(1, "2026-08-14T03:46:05.000Z", "00000000000468d8", 2032),
          "3": remoteLevel(3, "", null, 0),
          "9": remoteLevel(9, "2026-08-14T00:00:06.000Z", "0000000000043200", 2)
        },
        // Level 2's own listing failed.  We do not know whether it is empty.
        levelErrors: { "2": "SignatureDoesNotMatch: request signature mismatch" },
        skippedReason: null
      }
    });
    const tiers = byTier(report);

    expect(tiers["2"]).toMatchObject({ state: "not-observable", reason: "remote-inventory-failed" });
    expect(tiers["2"].detail).toContain("SignatureDoesNotMatch");
    // Level 3 is empty and its feeder cannot be seen — so no verdict is drawn about it
    // either, rather than borrowing level 1's numbers to guess one.
    expect(tiers["3"]).toMatchObject({ state: "not-observable", reason: "feeder-unobservable" });
    expect(report.degraded).toBe(false);
    expect(report.degradedReasons).toEqual([]);
  });

  // The collector could previously MANUFACTURE the empty state: summarizeLitestreamLtxPayload
  // returned `fileCount: newestAt ? fileCount : 0`, so a listing of real objects none of which
  // carried a parseable timestamp collapsed to zero.  With the wedge rule now drawing verdicts
  // from emptiness, a parse problem must never be able to masquerade as one.
  it("refuses to draw a verdict from an internally inconsistent level listing", () => {
    const now = Date.parse("2026-08-14T03:50:00.000Z");
    const report = assessLitestreamTierFreshness(undefined, {
      nowMs: now,
      remoteInventory: {
        collectedAt: "2026-08-14T03:46:10.000Z",
        status: "ok",
        levels: {
          "1": remoteLevel(1, "2026-08-14T03:46:05.000Z", "00000000000468d8", 2032),
          // Files counted, no readable timestamp on any of them.
          "2": remoteLevel(2, "", null, 12),
          // Zero files, yet a timestamp came back.
          "3": remoteLevel(3, "2026-08-14T03:00:00.000Z", null, 0),
          "9": remoteLevel(9, "2026-08-14T00:00:06.000Z", "0000000000043200", 2)
        },
        levelErrors: {},
        skippedReason: null
      }
    });
    const tiers = byTier(report);

    expect(tiers["2"]).toMatchObject({ state: "not-observable", reason: "remote-inventory-inconsistent" });
    expect(tiers["3"]).toMatchObject({ state: "not-observable", reason: "remote-inventory-inconsistent" });
    expect(report.degraded).toBe(false);
  });
});

describe("Litestream product-disabled L2/L3 (2026-09-01 structural)", () => {
  function writeLtxFile(statePath: string, tier: string, name: string, mtime: Date) {
    const dir = join(statePath, "ltx", tier);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, name);
    writeFileSync(file, "ltx");
    utimesSync(file, mtime, mtime);
  }

  function ltxName(txid: number): string {
    const hex = txid.toString(16).padStart(16, "0");
    return `${hex}-${hex}.ltx`;
  }

  function remoteLevel(level: number, newestAt: string, newestTxid: string | null, fileCount = 1) {
    return { level, newestAt, newestTxid, fileCount };
  }

  function byTier(report: { tiers: Array<{ tier: string }> }) {
    return Object.fromEntries(report.tiers.map((t) => [t.tier, t])) as Record<string, any>;
  }

  const tempRoots: string[] = [];
  afterEach(() => {
    for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("does not page leftover stale L2/L3 objects when those levels are product-disabled", () => {
    const root = mkdtempSync(join(tmpdir(), "socratic-ltx-disabled-stale-"));
    tempRoots.push(root);
    const now = Date.parse("2026-09-02T04:00:00.000Z");
    writeLtxFile(root, "0", ltxName(0x14853d), new Date(now - 5_000));

    const report = assessLitestreamTierFreshness(root, {
      nowMs: now,
      disabledTiers: LITESTREAM_PRODUCT_DISABLED_TIERS,
      remoteInventory: {
        collectedAt: "2026-09-02T03:50:00.000Z",
        status: "ok",
        levels: {
          "1": remoteLevel(1, "2026-09-02T03:45:00.000Z", "00000000001483ce", 80),
          "2": remoteLevel(2, "2026-08-18T06:25:07.000Z", "000000000008323f", 1),
          "3": remoteLevel(3, "2026-08-18T07:00:11.000Z", "000000000008323f", 1),
          "9": remoteLevel(9, "2026-09-02T00:03:08.000Z", "00000000001463c6", 2)
        },
        levelErrors: {},
        skippedReason: null
      }
    });
    const tiers = byTier(report);
    expect(tiers["0"]).toMatchObject({ state: "known", degraded: false });
    expect(tiers["1"]).toMatchObject({ state: "known", degraded: false });
    expect(tiers["2"]).toMatchObject({ state: "known", degraded: false });
    expect(tiers["3"]).toMatchObject({ state: "known", degraded: false });
    expect(tiers["9"]).toMatchObject({ state: "known", degraded: false });
    expect(report.degraded).toBe(false);
  });

  it("calls empty L2/L3 expected/product-disabled instead of a wedge", () => {
    const root = mkdtempSync(join(tmpdir(), "socratic-ltx-disabled-empty-"));
    tempRoots.push(root);
    const now = Date.parse("2026-09-02T04:00:00.000Z");
    writeLtxFile(root, "0", ltxName(0x14853d), new Date(now - 5_000));

    const report = assessLitestreamTierFreshness(root, {
      nowMs: now,
      disabledTiers: LITESTREAM_PRODUCT_DISABLED_TIERS,
      remoteInventory: {
        collectedAt: "2026-09-02T03:50:00.000Z",
        status: "ok",
        levels: {
          "1": remoteLevel(1, "2026-09-02T03:45:00.000Z", "00000000001483ce", 2032),
          "2": remoteLevel(2, "", null, 0),
          "3": remoteLevel(3, "", null, 0),
          "9": remoteLevel(9, "2026-09-02T00:03:08.000Z", "00000000001463c6", 2)
        },
        levelErrors: {},
        skippedReason: null
      }
    });
    const tiers = byTier(report);
    expect(tiers["2"]).toMatchObject({
      state: "empty",
      verdict: "expected",
      reason: "product-disabled",
      degraded: false
    });
    expect(tiers["3"]).toMatchObject({
      state: "empty",
      verdict: "expected",
      reason: "product-disabled",
      degraded: false
    });
    expect(tiers["1"]).toMatchObject({ state: "known", degraded: false });
    expect(report.degraded).toBe(false);
    expect(report.degradedReasons).toEqual([]);
  });

  it("still pages a stale L9 snapshot while L0 age is 0", () => {
    const root = mkdtempSync(join(tmpdir(), "socratic-ltx-stale-snapshot-"));
    tempRoots.push(root);
    const now = Date.parse("2026-09-02T12:00:00.000Z");
    writeLtxFile(root, "0", ltxName(0x200000), new Date(now - 1_000));

    const report = assessLitestreamTierFreshness(root, {
      nowMs: now,
      disabledTiers: LITESTREAM_PRODUCT_DISABLED_TIERS,
      remoteInventory: {
        collectedAt: "2026-09-02T11:50:00.000Z",
        status: "ok",
        levels: {
          "1": remoteLevel(1, "2026-09-02T11:45:00.000Z", "00000000001ffff0", 40),
          "2": remoteLevel(2, "", null, 0),
          "3": remoteLevel(3, "", null, 0),
          "9": remoteLevel(9, "2026-08-31T00:00:00.000Z", "0000000000100000", 1)
        },
        levelErrors: {},
        skippedReason: null
      }
    });
    const tiers = byTier(report);
    expect(tiers["0"]).toMatchObject({ state: "known", degraded: false, ageSeconds: 1 });
    expect(tiers["9"]).toMatchObject({ state: "known", degraded: true });
    expect(tiers["9"].ageSeconds).toBeGreaterThan(30 * 3600);
    expect(report.degraded).toBe(true);
    expect(report.degradedReasons.some((r) => r.includes('Level 9'))).toBe(true);
  });

  it("still pages an empty L1 wedge when L0 is advancing", () => {
    const root = mkdtempSync(join(tmpdir(), "socratic-ltx-empty-l1-"));
    tempRoots.push(root);
    const now = Date.parse("2026-09-02T12:00:00.000Z");
    // L0 interval is 300s; L1 threshold is 4h.  span = floor((n-1)/2)*300 must
    // exceed 14400s, so n >= 98.  120 files => floor(119/2)*300 = 17700s.
    for (let i = 0; i < 120; i++) {
      writeLtxFile(root, "0", ltxName(0x200000 + i), new Date(now - 5_000));
    }

    const report = assessLitestreamTierFreshness(root, {
      nowMs: now,
      disabledTiers: LITESTREAM_PRODUCT_DISABLED_TIERS,
      remoteInventory: {
        collectedAt: "2026-09-02T11:50:00.000Z",
        status: "ok",
        levels: {
          "1": remoteLevel(1, "", null, 0),
          "2": remoteLevel(2, "", null, 0),
          "3": remoteLevel(3, "", null, 0),
          "9": remoteLevel(9, "2026-09-02T00:03:08.000Z", "00000000001463c6", 2)
        },
        levelErrors: {},
        skippedReason: null
      }
    });
    const tiers = byTier(report);
    expect(tiers["1"]).toMatchObject({
      state: "empty",
      verdict: "wedged",
      reason: "backlog-past-threshold",
      degraded: true
    });
    expect(tiers["2"]).toMatchObject({ reason: "product-disabled", degraded: false });
    expect(report.degraded).toBe(true);
  });
});

// Third, independent signal (2026-08-13): litestream's own log lines, teed by
// scripts/coolify-prod-start.sh into a local file (litestream wraps the app via `-exec` and owns
// the container's real stdout, so a shared file is the only way the app can ever read what
// litestream itself reported). This needs no S3/B2 credentials and does not depend on the remote
// LTX inventory that assessLitestreamTierFreshness above relies on for levels 1/2/3/9 — a
// deliberately independent check so a wedge is still visible even while that other pipeline is
// broken (see the known litestream-remote-inventory scheduler bug referenced in
// app/api/health/route.ts).
describe("defaultLitestreamRuntimeLogPath", () => {
  it("places the log file next to the database, matching the other litestream default paths", () => {
    expect(defaultLitestreamRuntimeLogPath("/app/data/app.db")).toBe("/app/data/litestream-runtime.log");
  });
});

describe("scanLitestreamRuntimeLogText (pure)", () => {
  it("finds a real litestream compaction-failure line and reports it, trimmed", () => {
    const text = [
      'time=2026-08-08T14:35:12.123Z level=INFO msg="starting compaction monitor" level=2 interval=5m0s',
      'time=2026-08-08T14:40:12.456Z level=ERROR msg="compaction failed" level=2 error="write ltx file: extract timestamp from LTX header: non-contiguous transaction ids"'
    ].join("\n");

    const findings = scanLitestreamRuntimeLogText(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].marker).toBe("compaction failed");
    expect(findings[0].line).toContain("compaction failed");
    expect(findings[0].line).toContain("non-contiguous transaction ids");
  });

  it("still counts mega-L2 B2 failure substrings as compaction failed and classifies them", () => {
    const cases = [
      {
        error: "Storage class not supported",
        classification: "storage-class-unsupported" as const
      },
      {
        error: "extract timestamp from LTX header: EOF",
        classification: "ltx-header-eof" as const
      },
      {
        error: "connection reset by peer",
        classification: "connection-reset" as const
      }
    ];
    for (const c of cases) {
      const text =
        `time=2026-08-22T12:00:00.000Z level=ERROR msg="compaction failed" level=2 error="${c.error}"`;
      const findings = scanLitestreamRuntimeLogText(text);
      expect(findings).toHaveLength(1);
      expect(findings[0].marker).toBe("compaction failed");
      expect(findings[0].classification).toBe(c.classification);
      expect(findings[0].line).toContain(`[${c.classification}]`);
      expect(findings[0].line).toContain("compaction failed");
    }
  });

  it("finds a validation-monitor failure line independently of a compaction-failure line", () => {
    const text = 'time=2026-08-13T01:00:00.000Z level=WARN msg="validation error detected" level=1 type=gap message="ltx sequence gap"';
    const findings = scanLitestreamRuntimeLogText(text);
    expect(findings).toEqual([
      {
        marker: "validation error detected",
        line: expect.stringContaining("validation error detected"),
        level: "1"
      }
    ]);
  });

  it("reports nothing for routine, healthy litestream log lines", () => {
    const text = [
      'time=2026-08-13T01:00:00.000Z level=INFO msg="starting compaction monitor" level=1 interval=30s',
      'time=2026-08-13T01:00:30.000Z level=INFO msg="compaction complete" level=1 txid=00000000000123ab size=4096',
      'time=2026-08-13T02:00:00.000Z level=INFO msg="snapshot complete" txid=00000000000123ab size=1048576'
    ].join("\n");
    expect(scanLitestreamRuntimeLogText(text)).toEqual([]);
  });

  it("does not page a compaction failure that a later successful compaction already healed", () => {
    const text = [
      'time=2026-08-16T14:40:12.456Z level=ERROR msg="compaction failed" level=2 error="non-contiguous transaction ids"',
      'time=2026-08-17T21:10:07.000Z level=INFO msg="compaction complete" level=2 txid=000000000007e109 size=4096'
    ].join("\n");
    expect(scanLitestreamRuntimeLogText(text)).toEqual([]);
  });

  it("still pages a compaction failure that is newer than the last successful compaction", () => {
    const text = [
      'time=2026-08-17T21:10:07.000Z level=INFO msg="compaction complete" level=2 txid=000000000007e109 size=4096',
      'time=2026-08-17T21:15:12.456Z level=ERROR msg="compaction failed" level=2 error="non-contiguous transaction ids"'
    ].join("\n");
    const findings = scanLitestreamRuntimeLogText(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].marker).toBe("compaction failed");
    expect(findings[0].level).toBe("2");
  });

  it("does not treat a later L1 complete as recovery for an L2 compaction failure", () => {
    // 2026-08-31 incident: nullish fallback to any-level complete zeroed the
    // public failure count while L2 kept mega-retrying.
    const text = [
      'time=2026-08-31T06:00:00.000Z level=ERROR msg="compaction failed" level=2 error="read upload data failed: unexpected EOF"',
      'time=2026-08-31T06:00:30.000Z level=INFO msg="compaction complete" level=1 txid=00000000001483ce size=4096'
    ].join("\n");
    const findings = scanLitestreamRuntimeLogText(text);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ marker: "compaction failed", level: "2" });
    expect(findings[0].line).toContain("unexpected EOF");
  });

  it("does not treat any-level complete as recovery when the failure line has no compaction level", () => {
    const text = [
      'time=2026-08-31T06:00:00.000Z level=ERROR msg="compaction failed" error="cannot determine L2 max ltx file"',
      'time=2026-08-31T06:00:30.000Z level=INFO msg="compaction complete" level=1 txid=00000000001483ce size=4096'
    ].join("\n");
    const findings = scanLitestreamRuntimeLogText(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].level).toBeNull();
  });

  it("still recovers an L2 failure when a later L2 complete lands", () => {
    const text = [
      'time=2026-08-31T06:00:00.000Z level=ERROR msg="compaction failed" level=2 error="unexpected EOF"',
      'time=2026-08-31T06:05:00.000Z level=INFO msg="compaction complete" level=2 txid=000000000014836e size=4096'
    ].join("\n");
    expect(scanLitestreamRuntimeLogText(text)).toEqual([]);
  });

  it("caps the number of findings and the length of each reported line", () => {
    const longSuffix = "x".repeat(1000);
    const lines = Array.from(
      { length: 20 },
      (_, i) => `time=2026-08-13T00:00:${String(i).padStart(2, "0")}Z level=ERROR msg="compaction failed" level=2 detail="${longSuffix}"`
    );
    const findings = scanLitestreamRuntimeLogText(lines.join("\n"));
    expect(findings.length).toBeLessThanOrEqual(5);
    for (const f of findings) {
      expect(f.line.length).toBeLessThanOrEqual(501); // 500 chars + the truncation ellipsis
    }
  });

  it("ignores blank lines and does not blow up on empty input", () => {
    expect(scanLitestreamRuntimeLogText("")).toEqual([]);
    expect(scanLitestreamRuntimeLogText("\n\n   \n")).toEqual([]);
  });
});

describe("scanLitestreamRuntimeLogFile (I/O)", () => {
  const logPaths: string[] = [];

  afterEach(() => {
    for (const p of logPaths.splice(0)) {
      try {
        unlinkSync(p);
      } catch {
        // already gone
      }
    }
  });

  function tempLogPath(): string {
    const p = join(tmpdir(), `litestream-runtime-${randomUUID()}.log`);
    logPaths.push(p);
    return p;
  }

  it("returns no findings when the file does not exist at all (litestream not running yet)", () => {
    expect(scanLitestreamRuntimeLogFile(join(tmpdir(), `does-not-exist-${randomUUID()}.log`))).toEqual([]);
  });

  it("reads a real 'compaction failed' line off disk end-to-end", () => {
    const p = tempLogPath();
    writeFileSync(
      p,
      'time=2026-08-08T14:40:12Z level=ERROR msg="compaction failed" level=2 error="non-contiguous transaction ids"\n'
    );
    const findings = scanLitestreamRuntimeLogFile(p);
    expect(findings).toHaveLength(1);
    expect(findings[0].marker).toBe("compaction failed");
  });

  it("returns no findings for an empty file", () => {
    const p = tempLogPath();
    writeFileSync(p, "");
    expect(scanLitestreamRuntimeLogFile(p)).toEqual([]);
  });

  it("only scans the tail: an old failure line pushed past the byte cap by fresh healthy lines is not reported", () => {
    const p = tempLogPath();
    const failureLine = 'time=2026-08-01T00:00:00Z level=ERROR msg="compaction failed" level=2 error="stale"\n';
    const paddingLine = `time=2026-08-13T00:00:00Z level=INFO msg="padding" data="${"p".repeat(200)}"\n`;
    // Write the failure first, then enough padding to push it out of a small tail window.
    writeFileSync(p, failureLine + paddingLine.repeat(50));
    // A generous tail (bigger than the whole file) still finds it...
    expect(scanLitestreamRuntimeLogFile(p, 1024 * 1024)).toHaveLength(1);
    // ...but a tail window smaller than the padding alone reads only recent bytes and correctly
    // reports nothing, proving the read is bounded rather than always scanning the whole file.
    expect(scanLitestreamRuntimeLogFile(p, 500)).toEqual([]);
  });

  it("finds a recent failure within a small tail window when it actually is recent", () => {
    const p = tempLogPath();
    const paddingLine = `time=2026-08-13T00:00:00Z level=INFO msg="padding" data="${"p".repeat(200)}"\n`;
    const failureLine = 'time=2026-08-13T05:00:00Z level=ERROR msg="compaction failed" level=2 error="non-contiguous"\n';
    writeFileSync(p, paddingLine.repeat(50) + failureLine);
    expect(scanLitestreamRuntimeLogFile(p, 500)).toHaveLength(1);
  });
});
