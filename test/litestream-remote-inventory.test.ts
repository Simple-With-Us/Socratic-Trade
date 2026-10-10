import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  analyzeLitestreamLtxContiguity,
  collectLitestreamRemoteInventory,
  getLitestreamRemoteInventory,
  resolveLitestreamRemoteInventoryConfig,
  setLitestreamRemoteInventoryCache,
  summarizeLitestreamLtxPayload,
  LITESTREAM_REMOTE_LEVELS
} from "../src/lib/litestream-remote-inventory";
import {
  assessLitestreamTierFreshness,
  litestreamCatchUpSpanTxids,
  LITESTREAM_CATCH_UP_SPAN_HUGE_TXIDS
} from "../src/lib/runtime-health";

// Covers the collector that closes defect cause #1: Litestream 0.5.12 keeps only level 0 on
// local disk, so levels 1/2/3/9 can be observed ONLY by listing the remote replica. See
// docs/rollouts/2026-08-12-backup-tier-monitor-real-coverage.md.
//
// The "remote inventory cache" and "cross-module-instance durability" describe blocks below also
// cover defect cause #2, found 2026-08-13: the cache used to live in a bare module-level
// variable, so a scheduler-side write and an API-route-side read landed in two different
// instantiations of this module and the route never saw a single collected snapshot in
// production (932 successful collector runs/24h, 0 errors, `/api/health` reporting
// `remoteInventoryState: "missing"` the entire time). See
// docs/rollouts/2026-08-13-durable-inventory-cache.md.

beforeAll(() => {
  // getLitestreamRemoteInventory/setLitestreamRemoteInventoryCache now persist through
  // src/lib/db-durable-state.ts, so this file needs its own temp DB like every other test file
  // that touches durable state (see AGENTS.md's "Tests use a temp SQLite file per run").
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-litestream-inventory-${randomUUID()}.db`)}`;
});

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) rmSync(tempRoots.pop()!, { recursive: true, force: true });
  setLitestreamRemoteInventoryCache(null);
});

function makeRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

/** Credentials the collector only ever checks for PRESENCE — never reads or logs. */
const CREDENTIAL_ENV = {
  AWS_S3_BUCKET_NAME: "bucket",
  AWS_ACCESS_KEY_ID: "id",
  AWS_SECRET_ACCESS_KEY: "secret",
  AWS_S3_ENDPOINT: "https://s3.example.invalid"
};

/** Stand-in for the pinned litestream binary, so no test ever touches a real replica. */
function writeFakeLitestream(root: string, script: string): string {
  const binDir = join(root, ".bin");
  mkdirSync(binDir, { recursive: true });
  const binPath = join(binDir, "litestream");
  writeFileSync(binPath, `#!/bin/sh\n${script}\n`);
  chmodSync(binPath, 0o755);
  return binPath;
}

describe("summarizeLitestreamLtxPayload", () => {
  // Verbatim shape of `litestream ltx -level 2 -json` from the live production replica on
  // 2026-08-12 — the exact payload the collector has to reduce.
  const PRODUCTION_LEVEL_2_SAMPLE = [
    { level: 2, min_txid: "0000000000005249", max_txid: "00000000000052a8", size: 1742565, timestamp: "2026-08-08T00:05:04Z" },
    { level: 2, min_txid: "00000000000052a9", max_txid: "000000000000532a", size: 1930243, timestamp: "2026-08-08T00:10:06Z" },
    { level: 2, min_txid: "000000000000532b", max_txid: "00000000000053ac", size: 1825393, timestamp: "2026-08-08T00:15:07Z" }
  ];

  it("reduces a real litestream payload to the newest file's timestamp and txid", () => {
    const summary = summarizeLitestreamLtxPayload(PRODUCTION_LEVEL_2_SAMPLE, 2);
    expect(summary).toMatchObject({
      level: 2,
      newestAt: "2026-08-08T00:15:07.000Z",
      newestTxid: "00000000000053ac",
      fileCount: 3
    });
    // Old fields still present; contiguity fields are additive.
    expect(summary.holeCount).toBe(0);
    expect(summary.twinCount).toBe(0);
    expect(summary.suffixMinTxid).toBe("0000000000005249");
    expect(summary.catchUpSpanTxids).toBeNull();
  });

  it("pairs the reported txid with the newest timestamp even when entries arrive out of order", () => {
    const summary = summarizeLitestreamLtxPayload(
      [
        { level: 2, max_txid: "00000000000053ac", timestamp: "2026-08-08T00:15:07Z" },
        { level: 2, max_txid: "0000000000005249", timestamp: "2026-08-07T00:00:00Z" }
      ],
      2
    );
    // The two numbers must describe the SAME file, or the wedge check would compare a fresh
    // timestamp against a txid from a different (older) file.
    expect(summary.newestAt).toBe("2026-08-08T00:15:07.000Z");
    expect(summary.newestTxid).toBe("00000000000053ac");
  });

  it("reports an empty level as zero files rather than inventing activity", () => {
    expect(summarizeLitestreamLtxPayload([], 3)).toMatchObject({
      level: 3,
      newestAt: "",
      newestTxid: null,
      fileCount: 0,
      holeCount: 0,
      twinCount: 0,
      firstHole: null,
      suffixMinTxid: null,
      catchUpSpanTxids: null
    });
  });

  it("tolerates a non-array, null, or junk-entry payload without throwing", () => {
    expect(summarizeLitestreamLtxPayload(null, 1).fileCount).toBe(0);
    expect(summarizeLitestreamLtxPayload({ unexpected: true }, 1).fileCount).toBe(0);
    expect(summarizeLitestreamLtxPayload([null, 42, "x"], 1).fileCount).toBe(0);
  });

  // The collector must never MANUFACTURE the empty state.  This used to return
  // `newestAt ? fileCount : 0`, so a listing of real objects none of which carried a
  // parseable timestamp collapsed to `fileCount: 0` — and since 2026-08-14 "successfully
  // listed and empty" is a measurement that assessLitestreamTierFreshness draws a wedge
  // verdict from.  The count now survives so the grader can see the shape is inconsistent
  // (count > 0 with no timestamp) and refuse a verdict instead of reading it as emptiness.
  it("keeps the file count when no entry carried a parseable timestamp", () => {
    const summary = summarizeLitestreamLtxPayload(
      [
        { level: 2, max_txid: "000000000000e5ad", timestamp: "not-a-date" },
        { level: 2, max_txid: "000000000000e5ae" }
      ],
      2
    );
    expect(summary).toMatchObject({ level: 2, newestAt: "", newestTxid: null, fileCount: 2 });
  });

  it("ignores entries belonging to a different compaction level", () => {
    const summary = summarizeLitestreamLtxPayload(
      [
        { level: 9, max_txid: "00000000000f0000", timestamp: "2026-08-12T00:00:00Z" },
        { level: 2, max_txid: "000000000000e5ad", timestamp: "2026-08-08T14:35:05Z" }
      ],
      2
    );
    expect(summary).toMatchObject({ level: 2, newestTxid: "000000000000e5ad", fileCount: 1 });
  });
});

describe("analyzeLitestreamLtxContiguity", () => {
  it("reports holeCount=0 for a contiguous sample", () => {
    const contiguous = [
      { level: 1, min_txid: "0000000000004a86", max_txid: "0000000000004aa5" },
      { level: 1, min_txid: "0000000000004aa6", max_txid: "0000000000004ac5" },
      { level: 1, min_txid: "0000000000004ac6", max_txid: "0000000000004ae5" }
    ];
    const result = analyzeLitestreamLtxContiguity(contiguous, 1);
    expect(result.holeCount).toBe(0);
    expect(result.twinCount).toBe(0);
    expect(result.firstHole).toBeNull();
    expect(result.suffixMinTxid).toBe("0000000000004a86");
    expect(result.suffixFileCount).toBe(3);
  });

  it("detects the classic hole (431e5-43206)->(43225-43247)", () => {
    const classicHole = [
      { level: 1, min_txid: "00000000000431e5", max_txid: "0000000000043206" },
      { level: 1, min_txid: "0000000000043225", max_txid: "0000000000043247" }
    ];
    const result = analyzeLitestreamLtxContiguity(classicHole, 1);
    expect(result.holeCount).toBe(1);
    expect(result.firstHole).toEqual({
      prevMaxTxid: "0000000000043206",
      nextMinTxid: "0000000000043225"
    });
    // Newest contiguous suffix is only the tip file after the hole.
    expect(result.suffixMinTxid).toBe("0000000000043225");
    expect(result.suffixFileCount).toBe(1);
  });

  it("treats same-min overlapping ranges as one covered interval, not a hole", () => {
    const withOverlap = [
      { level: 1, min_txid: "0000000000293a1e", max_txid: "0000000000293a35" },
      { level: 1, min_txid: "0000000000293a1e", max_txid: "0000000000293a57" },
      { level: 1, min_txid: "0000000000293a58", max_txid: "0000000000293a70" }
    ];
    const result = analyzeLitestreamLtxContiguity(withOverlap, 1);
    expect(result.holeCount).toBe(0);
    expect(result.firstHole).toBeNull();
    expect(result.twinCount).toBe(0);
    expect(result.suffixMinTxid).toBe("0000000000293a1e");
    // Both overlap peers and the continuation are real files inside the covered suffix.
    expect(result.suffixFileCount).toBe(3);
  });

  it("still detects a real gap after collapsing overlaps", () => {
    const withGap = [
      { level: 1, min_txid: "0000000000000100", max_txid: "00000000000001ff" },
      { level: 1, min_txid: "0000000000000100", max_txid: "0000000000000200" },
      { level: 1, min_txid: "0000000000000202", max_txid: "00000000000002ff" }
    ];
    const result = analyzeLitestreamLtxContiguity(withGap, 1);
    expect(result.holeCount).toBe(1);
    expect(result.firstHole).toEqual({
      prevMaxTxid: "0000000000000200",
      nextMinTxid: "0000000000000202"
    });
    expect(result.suffixFileCount).toBe(1);
  });

  it("counts twins (same max_txid, different min_txid) without treating them as holes", () => {
    const withTwins = [
      { level: 1, min_txid: "0000000000000100", max_txid: "00000000000001ff" },
      { level: 1, min_txid: "0000000000000150", max_txid: "00000000000001ff" },
      { level: 1, min_txid: "0000000000000200", max_txid: "00000000000002ff" }
    ];
    const result = analyzeLitestreamLtxContiguity(withTwins, 1);
    expect(result.twinCount).toBe(1);
    expect(result.holeCount).toBe(0);
    expect(result.suffixFileCount).toBe(3);
  });

  it("never analyzes level 0 (returns empty contiguity)", () => {
    const payload = [
      { level: 0, min_txid: "0000000000000001", max_txid: "0000000000000002" },
      { level: 0, min_txid: "0000000000000010", max_txid: "0000000000000011" }
    ];
    expect(analyzeLitestreamLtxContiguity(payload, 0)).toEqual({
      holeCount: 0,
      twinCount: 0,
      firstHole: null,
      suffixMinTxid: null,
      suffixFileCount: 0
    });
  });
});

describe("litestreamCatchUpSpanTxids", () => {
  it("computes L1 tip minus L2 tip and flags the huge mega-file threshold", () => {
    // Live-shaped: L2 last at 8323f, L1 far ahead.
    const l2Tip = "000000000008323f";
    expect(litestreamCatchUpSpanTxids(l2Tip, l2Tip)).toBe(0);

    const l1Ahead = "0000000000085a40"; // 0x85a40 - 0x8323f = 10241 decimal
    const span = litestreamCatchUpSpanTxids(l1Ahead, l2Tip);
    expect(span).toBe(0x85a40 - 0x8323f);
    expect(span).toBeGreaterThan(LITESTREAM_CATCH_UP_SPAN_HUGE_TXIDS);
  });
});

describe("assessLitestreamTierFreshness contiguity reasons", () => {
  it("degrades when L1 holeCount>0 even if ages look fine", () => {
    const now = Date.parse("2026-08-22T12:00:00.000Z");
    const report = assessLitestreamTierFreshness(undefined, {
      nowMs: now,
      remoteInventory: {
        collectedAt: new Date(now - 60_000).toISOString(),
        status: "ok",
        levels: {
          "1": {
            level: 1,
            newestAt: new Date(now - 120_000).toISOString(),
            newestTxid: "0000000000043247",
            fileCount: 2,
            holeCount: 1,
            twinCount: 0,
            firstHole: { prevMaxTxid: "0000000000043206", nextMinTxid: "0000000000043225" },
            suffixMinTxid: "0000000000043225",
            catchUpSpanTxids: null
          },
          "2": {
            level: 2,
            newestAt: new Date(now - 120_000).toISOString(),
            newestTxid: "0000000000043206",
            fileCount: 1,
            holeCount: 0,
            twinCount: 0,
            firstHole: null,
            suffixMinTxid: "00000000000431e5",
            catchUpSpanTxids: 0x43247 - 0x43206
          },
          "3": {
            level: 3,
            newestAt: new Date(now - 120_000).toISOString(),
            newestTxid: "0000000000043206",
            fileCount: 1
          },
          "9": {
            level: 9,
            newestAt: new Date(now - 120_000).toISOString(),
            newestTxid: "0000000000043206",
            fileCount: 1
          }
        },
        levelErrors: {},
        skippedReason: null
      }
    });
    expect(report.degraded).toBe(true);
    expect(report.degradedReasons.some((r) => r.includes("hole") && r.includes("Level 1"))).toBe(true);
  });

  it("mentions mega-file catch-up when L2 is stale and the L1-L2 span is huge", () => {
    const now = Date.parse("2026-08-22T12:00:00.000Z");
    const l2Tip = "000000000008323f";
    const l1Tip = "0000000000085a40";
    const span = litestreamCatchUpSpanTxids(l1Tip, l2Tip)!;
    expect(span).toBeGreaterThan(LITESTREAM_CATCH_UP_SPAN_HUGE_TXIDS);

    const report = assessLitestreamTierFreshness(undefined, {
      nowMs: now,
      remoteInventory: {
        collectedAt: new Date(now - 60_000).toISOString(),
        status: "ok",
        levels: {
          "1": {
            level: 1,
            newestAt: new Date(now - 60_000).toISOString(),
            newestTxid: l1Tip,
            fileCount: 13000,
            holeCount: 0,
            twinCount: 0,
            firstHole: null,
            suffixMinTxid: "0000000000080000",
            catchUpSpanTxids: null
          },
          "2": {
            level: 2,
            // Older than the 2h L2 threshold while L1 is fresh.
            newestAt: new Date(now - 3 * 3600_000).toISOString(),
            newestTxid: l2Tip,
            fileCount: 10,
            holeCount: 0,
            twinCount: 0,
            firstHole: null,
            suffixMinTxid: "0000000000080000",
            catchUpSpanTxids: span
          },
          "3": {
            level: 3,
            newestAt: new Date(now - 60_000).toISOString(),
            newestTxid: l2Tip,
            fileCount: 1
          },
          "9": {
            level: 9,
            newestAt: new Date(now - 60_000).toISOString(),
            newestTxid: l1Tip,
            fileCount: 1
          }
        },
        levelErrors: {},
        skippedReason: null
      }
    });
    expect(report.degraded).toBe(true);
    expect(report.degradedReasons.some((r) => r.toLowerCase().includes("mega-file"))).toBe(true);
  });
});

describe("resolveLitestreamRemoteInventoryConfig", () => {
  it("skips with an explicit reason when the litestream binary is absent", () => {
    const root = makeRoot("ls-inv-nobin-");
    const result = resolveLitestreamRemoteInventoryConfig({
      dbPath: join(root, "app.db"),
      env: { ...CREDENTIAL_ENV }
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.skippedReason).toContain("litestream binary");
  });

  it("skips with an explicit reason when replica credentials are not in this process", () => {
    const root = makeRoot("ls-inv-nocreds-");
    writeFakeLitestream(root, "exit 0");
    const configPath = join(root, "litestream.yml");
    writeFileSync(configPath, "dbs: []\n");

    const result = resolveLitestreamRemoteInventoryConfig({
      dbPath: join(root, "app.db"),
      env: { LITESTREAM_CONFIG_PATH: configPath, AWS_S3_BUCKET_NAME: "bucket" }
    });
    expect(result.ok).toBe(false);
    // Names the MISSING variables so an operator can act, and never echoes a value.
    expect(result.ok === false && result.skippedReason).toContain("AWS_ACCESS_KEY_ID");
  });

  it("can be switched off entirely without removing credentials", () => {
    const root = makeRoot("ls-inv-off-");
    writeFakeLitestream(root, "exit 0");
    const result = resolveLitestreamRemoteInventoryConfig({
      dbPath: join(root, "app.db"),
      env: { ...CREDENTIAL_ENV, LITESTREAM_REMOTE_INVENTORY: "off" }
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.skippedReason).toContain("disabled");
  });

  it("resolves the binary next to the database, matching the production layout", () => {
    const root = makeRoot("ls-inv-ok-");
    const binPath = writeFakeLitestream(root, "exit 0");
    const configPath = join(root, "litestream.yml");
    writeFileSync(configPath, "dbs: []\n");

    const result = resolveLitestreamRemoteInventoryConfig({
      dbPath: join(root, "app.db"),
      env: { ...CREDENTIAL_ENV, LITESTREAM_CONFIG_PATH: configPath }
    });
    expect(result.ok).toBe(true);
    // /app/data/.bin/litestream beside /app/data/app.db on the production container.
    expect(result.ok === true && result.config.binPath).toBe(binPath);
    expect(result.ok === true && result.config.levels).toEqual(LITESTREAM_REMOTE_LEVELS);
  });

  it("collects only the levels that are absent locally — never level 0", () => {
    // `-level all` measured 143s / 14.1 MB against the live replica because level 0 dominates
    // it, and level 0 is already readable locally for free. Collecting it here would make the
    // refresh an order of magnitude more expensive for no new information.
    expect(LITESTREAM_REMOTE_LEVELS).toEqual([1, 2, 3, 9]);
    expect(LITESTREAM_REMOTE_LEVELS).not.toContain(0);
  });
});

describe("collectLitestreamRemoteInventory", () => {
  it("returns a skipped snapshot, not a throw, where litestream is not installed", async () => {
    const root = makeRoot("ls-inv-skip-");
    const snapshot = await collectLitestreamRemoteInventory({
      dbPath: join(root, "app.db"),
      env: { ...CREDENTIAL_ENV }
    });
    expect(snapshot.status).toBe("skipped");
    expect(snapshot.skippedReason).toBeTruthy();
    expect(snapshot.levels).toEqual({});
    expect(Number.isFinite(Date.parse(snapshot.collectedAt))).toBe(true);
  });

  it("summarizes every remote level from the binary's JSON output", async () => {
    const root = makeRoot("ls-inv-run-");
    // Emits a one-entry listing whose txid/timestamp encode the requested level, so the test
    // proves each level was queried separately and mapped to the right key.
    writeFakeLitestream(
      root,
      [
        'level=""',
        'while [ $# -gt 0 ]; do if [ "$1" = "-level" ]; then level="$2"; fi; shift; done',
        'printf \'[{"level":%s,"min_txid":"0000000000000001","max_txid":"000000000000000%s","size":1,"timestamp":"2026-08-1%sT00:00:00Z"}]\' "$level" "$level" "$level"'
      ].join("\n")
    );
    const configPath = join(root, "litestream.yml");
    writeFileSync(configPath, "dbs: []\n");

    const snapshot = await collectLitestreamRemoteInventory({
      dbPath: join(root, "app.db"),
      env: { ...CREDENTIAL_ENV, LITESTREAM_CONFIG_PATH: configPath }
    });

    expect(snapshot.status).toBe("ok");
    expect(Object.keys(snapshot.levels).sort()).toEqual(["1", "2", "3", "9"]);
    expect(snapshot.levels["2"]).toMatchObject({ level: 2, newestTxid: "0000000000000002", fileCount: 1 });
    expect(snapshot.levels["9"]).toMatchObject({ level: 9, newestTxid: "0000000000000009" });
    expect(snapshot.levelErrors).toEqual({});
  });

  it("records a per-level error and reports 'partial' when only some levels list successfully", async () => {
    const root = makeRoot("ls-inv-partial-");
    writeFakeLitestream(
      root,
      [
        'level=""',
        'while [ $# -gt 0 ]; do if [ "$1" = "-level" ]; then level="$2"; fi; shift; done',
        'if [ "$level" = "2" ]; then echo "Error: bucket required for s3 replica" >&2; exit 1; fi',
        'printf \'[{"level":%s,"max_txid":"0000000000000001","timestamp":"2026-08-12T00:00:00Z"}]\' "$level"'
      ].join("\n")
    );
    const configPath = join(root, "litestream.yml");
    writeFileSync(configPath, "dbs: []\n");

    const snapshot = await collectLitestreamRemoteInventory({
      dbPath: join(root, "app.db"),
      env: { ...CREDENTIAL_ENV, LITESTREAM_CONFIG_PATH: configPath }
    });

    // A single failing level must not discard the three that worked — partial coverage that
    // says which level is missing beats no coverage at all.
    expect(snapshot.status).toBe("partial");
    expect(Object.keys(snapshot.levelErrors)).toEqual(["2"]);
    expect(snapshot.levels["1"]).toBeDefined();
    expect(snapshot.levels["9"]).toBeDefined();
  });

  it("reports 'failed' when every level errors, without throwing", async () => {
    const root = makeRoot("ls-inv-failed-");
    writeFakeLitestream(root, 'echo "Error: dial tcp: connection refused" >&2\nexit 1');
    const configPath = join(root, "litestream.yml");
    writeFileSync(configPath, "dbs: []\n");

    const snapshot = await collectLitestreamRemoteInventory({
      dbPath: join(root, "app.db"),
      env: { ...CREDENTIAL_ENV, LITESTREAM_CONFIG_PATH: configPath }
    });
    expect(snapshot.status).toBe("failed");
    expect(Object.keys(snapshot.levelErrors).sort()).toEqual(["1", "2", "3", "9"]);
  });

  it("treats unparseable output as a level error rather than fabricating a summary", async () => {
    const root = makeRoot("ls-inv-junk-");
    writeFakeLitestream(root, 'echo "not json at all"');
    const configPath = join(root, "litestream.yml");
    writeFileSync(configPath, "dbs: []\n");

    const snapshot = await collectLitestreamRemoteInventory({
      dbPath: join(root, "app.db"),
      env: { ...CREDENTIAL_ENV, LITESTREAM_CONFIG_PATH: configPath }
    });
    expect(snapshot.status).toBe("failed");
    expect(snapshot.levelErrors["1"]).toContain("unparseable");
  });
});

describe("remote inventory cache", () => {
  it("starts empty so a fresh process reports 'not collected yet' instead of stale numbers", () => {
    expect(getLitestreamRemoteInventory()).toBeNull();
  });

  it("round-trips a primed snapshot for the health and admin routes to read", () => {
    const snapshot = {
      collectedAt: "2026-08-12T23:20:00.000Z",
      status: "ok" as const,
      levels: { "2": { level: 2, newestAt: "2026-08-08T14:35:05.000Z", newestTxid: "000000000000e5ad", fileCount: 171 } },
      levelErrors: {},
      skippedReason: null
    };
    setLitestreamRemoteInventoryCache(snapshot);
    expect(getLitestreamRemoteInventory()).toEqual(snapshot);
  });
});

// Reproduces the actual 2026-08-12/13 production defect: the scheduler (writer) and the API
// route handlers (reader) get SEPARATE instantiations of this module even inside one OS process,
// so a bare module-level `cachedInventory` variable written by one instance is invisible to the
// other. `vi.resetModules()` + a fresh `await import(...)` is the standard way to force a
// genuinely independent module instance in Vitest — see test/trigger-durability.test.ts for the
// same technique used against a different durable-state consumer. Every assertion in this block
// FAILS against the pre-fix module-level-variable implementation, because a freshly imported
// instance's `cachedInventory` starts `null` and nothing here would ever repopulate it.
describe("cross-module-instance durability (the production bug)", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("a snapshot written by one module instance is visible to a completely separate module instance", async () => {
    const writer = await import("../src/lib/litestream-remote-inventory");
    const snapshot = {
      collectedAt: "2026-08-13T12:00:00.000Z",
      status: "ok" as const,
      levels: { "1": { level: 1, newestAt: "2026-08-13T11:58:00.000Z", newestTxid: "000000000002324c", fileCount: 5635 } },
      levelErrors: {},
      skippedReason: null
    };
    writer.setLitestreamRemoteInventoryCache(snapshot);

    // Force a brand-new instantiation of the module (and everything it imports, including
    // src/lib/db-durable-state.ts and src/lib/db.ts) — its own `cachedInventory` binding starts
    // at `null`, exactly like the scheduler and an API route bundle really do in production.
    vi.resetModules();
    const reader = await import("../src/lib/litestream-remote-inventory");
    expect(reader).not.toBe(writer);
    expect(reader.getLitestreamRemoteInventory()).toEqual(snapshot);

    // Clean up through whichever instance — both point at the same durable_state row.
    reader.setLitestreamRemoteInventoryCache(null);
  });

  it("a real scheduler collection persisted by the writer makes remoteInventoryState 'ok' (not 'missing') for a fresh reader instance", async () => {
    const root = makeRoot("ls-inv-cross-instance-");
    writeFakeLitestream(
      root,
      [
        'level=""',
        'while [ $# -gt 0 ]; do if [ "$1" = "-level" ]; then level="$2"; fi; shift; done',
        'printf \'[{"level":%s,"min_txid":"0000000000000001","max_txid":"000000000000000%s","size":1,"timestamp":"2026-08-1%sT00:00:00Z"}]\' "$level" "$level" "$level"'
      ].join("\n")
    );
    const configPath = join(root, "litestream.yml");
    writeFileSync(configPath, "dbs: []\n");

    const writer = await import("../src/lib/litestream-remote-inventory");
    const result = await writer.refreshLitestreamRemoteInventoryIfDue({
      dbPath: join(root, "app.db"),
      env: { ...CREDENTIAL_ENV, LITESTREAM_CONFIG_PATH: configPath },
      nowMs: Date.parse("2026-08-13T12:00:00.000Z")
    });
    expect(result).toEqual({ ran: true, status: "ok" });

    vi.resetModules();
    const reader = await import("../src/lib/litestream-remote-inventory");
    const inventory = reader.getLitestreamRemoteInventory();
    expect(inventory?.status).toBe("ok");

    const report = assessLitestreamTierFreshness(undefined, {
      remoteInventory: inventory,
      nowMs: Date.parse("2026-08-13T12:05:00.000Z")
    });
    expect(report.remoteInventoryState).toBe("ok");
    expect(report.remoteInventoryState).not.toBe("missing");
    // Levels 1/2/3/9 exist only in the remote replica; with a real 'ok' inventory in hand they
    // must grade as known, not "not-observable" — the exact symptom PR #2665 shipped to fix and
    // the durable-state bug silently defeated.
    for (const tier of report.tiers) {
      if (tier.tier === "0") continue;
      expect(tier.state).toBe("known");
    }

    reader.setLitestreamRemoteInventoryCache(null);
  });
});
