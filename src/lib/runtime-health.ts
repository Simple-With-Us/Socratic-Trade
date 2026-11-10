// Bare specifiers (not `node:`-prefixed): this module is reachable from
// litestream-remote-inventory -> scheduler -> background-worker-startup, which Next's
// webpack build traverses.  A `node:`-scheme request is handled by webpack's scheme
// plugin BEFORE resolve.alias, so `"node:fs": false` cannot neutralize it and the
// build dies with UnhandledSchemeError.  Bare specifiers go through resolve.fallback
// (next.config.mjs maps fs/path/http to false for client/edge).  Same pattern as
// src/lib/apns.ts and src/lib/kalshi.ts.
import { request } from "http";
import { closeSync, openSync, readSync, readdirSync, statSync } from "fs";
import { basename, dirname, join } from "path";
import { getGitSha } from "./git-sha";

export interface RuntimeReleaseIdentity {
  sha: string | null;
  processStartedAt: string;
  processUptimeSeconds: number;
}

export type LitestreamRuntimeHealth =
  | {
      state: "known";
      source: "ipc" | "file";
      status: string;
      lastSyncAt: string | null;
      ageSeconds: number | null;
      timestampState: "valid" | "missing" | "invalid";
    }
  | {
      state: "unknown";
      source: "none";
    };

export type LitestreamDegradationReason =
  | "unavailable"
  | "file-unverified"
  | "stale"
  | "stopped"
  | "never-synced"
  | "invalid-sync-time";

export interface LitestreamHealthAssessment {
  degraded: boolean;
  reasons: LitestreamDegradationReason[];
}

export const LITESTREAM_STARTUP_GRACE_SECONDS = 5 * 60;
export const LITESTREAM_STALE_AFTER_SECONDS = 60 * 60;
const LITESTREAM_IPC_MAX_RESPONSE_BYTES = 64 * 1024;
const LITESTREAM_FILE_SCAN_MAX_DEPTH = 8;
const LITESTREAM_CLOCK_SKEW_MS = 60_000;
/**
 * Per-directory `stat()` budget for the local scans below.
 *
 * The previous bound was a flat 256 entries across the whole scan, and hitting it made the
 * scan return `null` — i.e. report NOTHING rather than something imprecise. That was the
 * second of the two bugs that left this monitor at zero production coverage: `ltx/0` holds
 * ~1,000+ LTX files in normal operation (1,078 measured on the live container on 2026-08-12),
 * so level 0 — the one level that IS readable locally — silently degraded to "unknown" on
 * every single health check.
 *
 * Raising the cap to another magic number would only move the cliff. Instead the scan no
 * longer needs to touch every entry: Litestream 0.5.x names each file
 * `<minTXID>-<maxTXID>.ltx` with zero-padded hex transaction ids, so lexicographic filename
 * order IS write order (verified on the live replica: the lexicographically greatest name in
 * `ltx/0` also carried the newest mtime). Selecting the highest-named few entries in a single
 * O(n) pass and stat-ing only those costs one `readdir` plus <= 8 `stat` calls no matter how
 * large the directory grows. Sampling several rather than exactly one tolerates a small
 * name/time inversion (e.g. a slow write finishing out of order) at negligible cost.
 */
const LITESTREAM_DIR_STAT_SAMPLE = 8;
/** Recursion guard for the whole-tree diagnostic scan; bounds work without blinding the result. */
const LITESTREAM_FILE_SCAN_MAX_DIRECTORIES = 512;

const PROCESS_STARTED_AT_MS = Date.now() - Math.round(process.uptime() * 1000);
/** Public-safe release metadata. Only hexadecimal commit ids are exposed. */
export function runtimeReleaseIdentity(
  env: Readonly<Record<string, string | undefined>> = process.env,
  nowMs: number = Date.now()
): RuntimeReleaseIdentity {
  return {
    sha: getGitSha(env as Record<string, string | undefined>) ?? null,
    processStartedAt: new Date(PROCESS_STARTED_AT_MS).toISOString(),
    processUptimeSeconds: Math.max(0, Math.round((nowMs - PROCESS_STARTED_AT_MS) / 1000))
  };
}

function ageSeconds(iso: string, nowMs: number): number | null {
  const timestamp = new Date(iso).getTime();
  if (!Number.isFinite(timestamp) || timestamp > nowMs + LITESTREAM_CLOCK_SKEW_MS) return null;
  return Math.max(0, Math.round((nowMs - timestamp) / 1000));
}

export function isLitestreamReplicatingStatus(status: string): boolean {
  const normalized = status.trim().toLowerCase();
  // v0.5.12 documents `replicating`; the original v0.5.8 IPC example used `active`.
  return normalized === "replicating" || normalized === "active";
}

/** Litestream 0.5.x keeps metadata in a hidden sibling directory by default. */
export function defaultLitestreamStatePath(dbPath: string): string {
  return join(dirname(dbPath), `.${basename(dbPath)}-litestream`);
}

/**
 * Default Unix socket for Litestream's local IPC control plane (`GET /list`).
 * Colocate with the DB so the non-root app user can bind it in containers —
 * `/var/run/litestream.sock` is root-only and leaves production health stuck
 * on `storageDegraded: unavailable` despite healthy R2 replication.
 */
export function defaultLitestreamSocketPath(dbPath: string): string {
  return join(dirname(dbPath), "litestream.sock");
}

/**
 * Where scripts/coolify-prod-start.sh tees the combined stdout/stderr of the `litestream
 * replicate` process (see the `run_app litestream replicate ... > >(tee -a "$LITESTREAM_LOG"...)`
 * line there). This is the ONLY channel through which the app can ever see litestream's own
 * `compaction failed` / `validation error detected` log lines -- litestream owns the container's
 * real stdout (it wraps the app via `-exec`, not the other way around), so nothing short of a
 * shared file makes those lines readable from inside the app process. See
 * scanLitestreamRuntimeLogFile below for the reader.
 */
export function defaultLitestreamRuntimeLogPath(dbPath: string): string {
  return join(dirname(dbPath), "litestream-runtime.log");
}

/**
 * Decide whether the available signal proves the production R2 recovery path is healthy.
 * File mtimes are retained as diagnostics only; they do not prove a successful remote upload.
 */
export function assessLitestreamRuntimeHealth(
  health: LitestreamRuntimeHealth,
  options: {
    liveMode: boolean;
    processUptimeSeconds: number;
    latestLocalActivityAtMs?: number | null;
    startupGraceSeconds?: number;
    staleAfterSeconds?: number;
  }
): LitestreamHealthAssessment {
  const reasons: LitestreamDegradationReason[] = [];
  const startupGraceSeconds = options.startupGraceSeconds ?? LITESTREAM_STARTUP_GRACE_SECONDS;
  const staleAfterSeconds = options.staleAfterSeconds ?? LITESTREAM_STALE_AFTER_SECONDS;

  if (health.state === "unknown") {
    if (options.liveMode) reasons.push("unavailable");
    return { degraded: reasons.length > 0, reasons };
  }

  if (health.source === "file") {
    if (options.liveMode) reasons.push("file-unverified");
    return { degraded: reasons.length > 0, reasons };
  }

  if (health.timestampState === "invalid") {
    reasons.push("invalid-sync-time");
  } else if (!isLitestreamReplicatingStatus(health.status)) {
    reasons.push("stopped");
  } else if (
    options.liveMode
    && health.lastSyncAt === null
    && options.processUptimeSeconds >= startupGraceSeconds
  ) {
    reasons.push("never-synced");
  }

  const lastSyncAtMs = health.lastSyncAt ? Date.parse(health.lastSyncAt) : Number.NaN;
  const localActivityAtMs = options.latestLocalActivityAtMs ?? Number.NaN;
  if (
    health.ageSeconds !== null
    && health.ageSeconds > staleAfterSeconds
    && Number.isFinite(lastSyncAtMs)
    && Number.isFinite(localActivityAtMs)
    && localActivityAtMs > lastSyncAtMs
  ) {
    reasons.push("stale");
  }

  return { degraded: reasons.length > 0, reasons };
}

/** Parse Litestream 0.5.x IPC `GET /list` without trusting its JSON shape. */
export function parseLitestreamListPayload(
  payload: unknown,
  dbPath: string,
  nowMs: number = Date.now()
): LitestreamRuntimeHealth | null {
  if (!payload || typeof payload !== "object") return null;
  const databases = (payload as { databases?: unknown }).databases;
  if (!Array.isArray(databases)) return null;
  const database = databases.find((item) => {
    if (!item || typeof item !== "object") return false;
    return (item as { path?: unknown }).path === dbPath;
  });
  if (!database || typeof database !== "object") return null;

  const record = database as { status?: unknown; last_sync_at?: unknown; lastSyncAt?: unknown };
  const status = typeof record.status === "string" && record.status.trim() ? record.status.trim() : "unknown";
  const rawLastSyncAt = typeof record.last_sync_at === "string"
    ? record.last_sync_at
    : typeof record.lastSyncAt === "string"
      ? record.lastSyncAt
      : null;
  const parsedAgeSeconds = rawLastSyncAt ? ageSeconds(rawLastSyncAt, nowMs) : null;
  const timestampState = rawLastSyncAt === null
    ? "missing"
    : parsedAgeSeconds === null
      ? "invalid"
      : "valid";
  const lastSyncAt = timestampState === "valid" ? rawLastSyncAt : null;

  return {
    state: "known",
    source: "ipc",
    status,
    lastSyncAt,
    ageSeconds: parsedAgeSeconds,
    timestampState
  };
}

/**
 * Newest mtime among a directory's own files, using a bounded `stat()` budget.
 *
 * Small directories are stat-ed exhaustively (exact). Larger ones fall back to the
 * highest-named LITESTREAM_DIR_STAT_SAMPLE entries — see that constant for why filename order
 * is a sound proxy for write order in Litestream's LTX directories, which are the only
 * directories in this tree that ever grow large.
 */
function newestMtimeAmong(dir: string, names: readonly string[]): number | null {
  if (names.length === 0) return null;

  let candidates: readonly string[];
  if (names.length <= LITESTREAM_DIR_STAT_SAMPLE) {
    candidates = names;
  } else {
    // Single O(n) pass keeping the highest-named LITESTREAM_DIR_STAT_SAMPLE names. `top` is
    // kept sorted ascending, so `top[0]` is always the weakest candidate held.
    const top: string[] = [];
    for (const name of names) {
      if (top.length < LITESTREAM_DIR_STAT_SAMPLE) {
        top.push(name);
        if (top.length === LITESTREAM_DIR_STAT_SAMPLE) top.sort();
        continue;
      }
      if (name > top[0]) {
        top[0] = name;
        top.sort();
      }
    }
    candidates = top;
  }

  let newestMs = 0;
  for (const name of candidates) {
    try {
      const stat = statSync(join(dir, name));
      if (stat.isFile()) newestMs = Math.max(newestMs, stat.mtimeMs);
    } catch {
      // Raced deletion (retention prune) — the remaining candidates still answer the question.
    }
  }
  return newestMs > 0 ? newestMs : null;
}

/** `<minTXID>-<maxTXID>.ltx` with zero-padded hex ids (Litestream 0.5.x). */
export function maxTxidFromLtxFilename(name: string): string | null {
  const match = /^([0-9a-f]+)-([0-9a-f]+)\.ltx$/i.exec(name);
  return match ? match[2].toLowerCase() : null;
}

/** Numeric ordering for zero-padded hex transaction ids of possibly differing widths. */
export function compareLitestreamTxid(a: string, b: string): number {
  const left = a.replace(/^0+/, "") || "0";
  const right = b.replace(/^0+/, "") || "0";
  if (left.length !== right.length) return left.length - right.length;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Normalize a hex txid to lowercase 16-char zero-padded form when possible. */
export function normalizeLitestreamTxid(raw: string): string {
  const hex = raw.trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]+$/.test(hex)) return raw.trim().toLowerCase();
  return hex.padStart(16, "0");
}

/** max_txid + 1 as a 16-char hex txid (for contiguity checks). */
export function litestreamTxidSuccessor(txid: string): string {
  const n = BigInt(`0x${normalizeLitestreamTxid(txid).replace(/^0+/, "") || "0"}`) + 1n;
  return n.toString(16).padStart(16, "0");
}

/**
 * L1 tip minus L2 tip in transaction count when both are parseable hex txids.
 * Used to flag mega-file L2 catch-up risk (multi-day L1 backlog compacted as one object).
 */
export function litestreamCatchUpSpanTxids(l1NewestTxid: string, l2NewestTxid: string): number | null {
  try {
    const a = BigInt(`0x${normalizeLitestreamTxid(l1NewestTxid).replace(/^0+/, "") || "0"}`);
    const b = BigInt(`0x${normalizeLitestreamTxid(l2NewestTxid).replace(/^0+/, "") || "0"}`);
    const delta = a - b;
    if (delta < 0n) return null;
    if (delta > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER;
    return Number(delta);
  } catch {
    return null;
  }
}

/**
 * How many txids behind L2 may lag L1 before health copy calls out mega-file catch-up.
 * Live incident: L2 stuck at ~8323f while L1 kept advancing across days.
 */
export const LITESTREAM_CATCH_UP_SPAN_HUGE_TXIDS = 10_000;

interface LocalLtxObservation {
  newestMs: number;
  newestTxid: string | null;
  fileCount: number;
}

/** Read one `ltx/<level>/` directory. Returns null when the directory holds no LTX files. */
function readLocalLtxDirectory(dir: string): LocalLtxObservation | null {
  const names = readdirSync(dir).filter((name) => name.endsWith(".ltx"));
  if (names.length === 0) return null;
  const newestMs = newestMtimeAmong(dir, names);
  if (newestMs === null) return null;

  let newestTxid: string | null = null;
  for (const name of names) {
    const txid = maxTxidFromLtxFilename(name);
    if (txid && (newestTxid === null || compareLitestreamTxid(txid, newestTxid) > 0)) newestTxid = txid;
  }
  return { newestMs, newestTxid, fileCount: names.length };
}

/**
 * Newest mtime anywhere under `target`, for the whole-tree diagnostic fallback.
 *
 * Bounded by directory count and depth rather than by total entries, and — unlike the version
 * this replaced — a directory that exceeds the per-directory `stat()` budget is SAMPLED rather
 * than turned into a `null` result. Refusing to answer was how the old bound blinded both this
 * fallback and the per-tier check in production.
 */
function newestFileMtimeMs(target: string): number | null {
  let newestMs = 0;
  let directories = 0;
  const pending: Array<{ path: string; depth: number }> = [{ path: target, depth: 0 }];

  while (pending.length > 0 && directories <= LITESTREAM_FILE_SCAN_MAX_DIRECTORIES) {
    const current = pending.pop()!;
    let dirents;
    try {
      dirents = readdirSync(current.path, { withFileTypes: true });
    } catch {
      // Not a directory (the scan root may be a plain file), or unreadable.
      try {
        const stat = statSync(current.path);
        if (stat.isFile()) newestMs = Math.max(newestMs, stat.mtimeMs);
      } catch {
        // Unreadable — nothing to contribute.
      }
      continue;
    }

    directories += 1;
    const fileNames: string[] = [];
    for (const entry of dirents) {
      if (entry.isDirectory()) {
        if (current.depth < LITESTREAM_FILE_SCAN_MAX_DEPTH) {
          pending.push({ path: join(current.path, entry.name), depth: current.depth + 1 });
        }
      } else {
        fileNames.push(entry.name);
      }
    }
    const newestHere = newestMtimeAmong(current.path, fileNames);
    if (newestHere !== null) newestMs = Math.max(newestMs, newestHere);
  }

  return newestMs > 0 ? newestMs : null;
}

/**
 * Litestream 0.5.x compaction levels this app's config actually exercises.  The original
 * 2026-08-11 version of this monitor watched only 0/1/9 on the assumption that "levels 2-8
 * are unused here" — disproven within a day: litestream's own boot log starts compaction
 * monitors for levels 1 (30s), 2 (5m), 3 (1h), and 9 (24h), and the 2026-08-12 production
 * wedge was at LEVEL 2 ("non-contiguous transaction ids", byte-identical retry every 5
 * minutes) — a failure the 0/1/9 monitor was structurally blind to.  All active levels are
 * watched now.
 *
 * Widening the list to 0/1/2/3/9 was necessary but nowhere near sufficient: the 2026-08-11/12
 * implementation graded every level from local `ltx/<level>/` mtimes, and levels 1/2/3/9 have
 * no local directory at all, so all five levels reported "unknown" in production — zero
 * coverage while appearing to cover everything.  See assessLitestreamTierFreshness below for
 * the two-source design that replaced it.
 */
export type LitestreamCompactionTier = "0" | "1" | "2" | "3" | "9";

export const LITESTREAM_COMPACTION_TIERS: readonly LitestreamCompactionTier[] = ["0", "1", "2", "3", "9"];

/**
 * Compaction levels this app actually runs.  litestream.coolify.yml `levels:` has
 * one entry (L1 at 30s).  Litestream 0.5.12 has no other off switch for L2/L3.
 * Health still *lists* 2/3 so leftover replica objects are visible, but must not
 * treat them as a wedge (see disabledTiers on assessLitestreamTierFreshness).
 */
export const LITESTREAM_PRODUCT_ENABLED_TIERS: readonly LitestreamCompactionTier[] = ["0", "1", "9"];
export const LITESTREAM_PRODUCT_DISABLED_TIERS: readonly LitestreamCompactionTier[] = ["2", "3"];

export function isLitestreamProductDisabledTier(tier: string): boolean {
  return (LITESTREAM_PRODUCT_DISABLED_TIERS as readonly string[]).includes(tier);
}

/** Plain-English names for the admin UI and alert text. */
export const LITESTREAM_TIER_LABELS: Record<LitestreamCompactionTier, string> = {
  "0": "Continuous Sync",
  "1": "Compaction",
  "2": "Deep Compaction",
  "3": "Hourly Rollup",
  "9": "Daily Snapshot"
};

/**
 * Per-tier staleness thresholds (seconds) — a finer-grained COMPLEMENT to
 * LITESTREAM_STALE_AFTER_SECONDS above, not a replacement. That constant, and the IPC
 * `/list` signal it grades, only describe the database's overall last-sync time, which
 * tracks level 0 and keeps reporting fresh even when a higher compaction level is wedged.
 * That gap is exactly what let a stuck level-1 B2 compaction anchor run silently for 27+
 * hours in production on 2026-08-11 (level 0 kept succeeding every ~60s the entire time —
 * see docs/rollouts/2026-08-09-event-loop-stall-instrumentation.md) before anyone noticed.
 * Reasoning per tier:
 *   - level 0: litestream.coolify.yml `sync-interval: 300s`. 10 minutes is 2x that
 *     cadence, generous headroom for one missed tick while still catching a genuinely
 *     stuck sync in minutes rather than hours.
 *   - level 1: product compaction interval is 30s (`levels: [{interval: 30s}]`). 4
 *     hours tolerates ordinary gaps while catching a stuck L1 compactor in a few
 *     hours instead of the 27+ hours the 2026-08-11 incident took.
 *   - level 2 / 3: DISABLED as a product (omitted from `levels:`). Thresholds remain
 *     for historical unit tests that pass `disabledTiers: []`. Production health
 *     passes LITESTREAM_PRODUCT_DISABLED_TIERS so leftover L2/L3 objects never page.
 *   - level 9: `snapshot.interval: 24h`. 30 hours (24h + 6h buffer) rides out one
 *     delayed/retried run without false-alarming on ordinary scheduling jitter.
 *     Graded independently of level 0 age — a fresh L0 must not hide a stale snapshot.
 *
 * Every threshold above 10 minutes is graded from the remote replica inventory, which
 * refreshes every 30 minutes and is discarded once it exceeds
 * LITESTREAM_REMOTE_INVENTORY_MAX_AGE_SECONDS (90 min).  Both are far below the tightest
 * remote threshold (level 2 at 2h), so collection cadence never drives a verdict.
 */
export const LITESTREAM_TIER_STALE_AFTER_SECONDS: Record<LitestreamCompactionTier, number> = {
  "0": 10 * 60,
  "1": 4 * 60 * 60,
  "2": 2 * 60 * 60,
  "3": 6 * 60 * 60,
  "9": 30 * 60 * 60
};

/**
 * How often litestream OFFERS each level a compaction opportunity, in seconds.
 *
 * Transcribed, not chosen, from litestream.coolify.yml:
 *   L0 300s = replica `sync-interval: 300s`
 *   L1 30s  = the single `levels:` entry (product compaction)
 *   L2 300s / L3 3600s = litestream v0.5.12 DefaultCompactionLevels, kept for
 *     historical unit tests that re-enable those levels via `disabledTiers: []`
 *   L9 86400s = `snapshot.interval: 24h`
 *
 * LOCKSTEP TRAP: this map, LITESTREAM_FEEDER_TIER, LITESTREAM_COMPACTION_TIERS,
 * LITESTREAM_PRODUCT_DISABLED_TIERS, and litestream.coolify.yml `levels:` must
 * stay in sync.  A level that is configured OFF would otherwise look permanently
 * wedged to the empty-level rule below (the 2026-08-14 detector).  test/litestream-coolify-config.test.ts
 * asserts the yaml side of that lockstep.
 */
export const LITESTREAM_LEVEL_PRODUCTION_INTERVAL_SECONDS: Record<LitestreamCompactionTier, number> = {
  "0": 300,
  "1": 30,
  "2": 300,
  "3": 3600,
  "9": 86400
};

/**
 * The level each compaction level actually reads FROM.
 *
 * `Compactor.Compact` in litestream v0.5.12 uses `srcLevel = dstLevel - 1` literally, so the
 * feeder is always the IMMEDIATELY lower configured level — never "the nearest non-empty one".
 * A level whose direct feeder is empty genuinely has nothing to promote, which is what keeps
 * one root cause from firing an alarm at every level above it.
 *
 * Level 0 has no feeder (it is the pacemaker) and neither does level 9: `Store.CompactDB`
 * shortcuts the snapshot level straight to `db.Snapshot`, i.e. it is fed by the database, not
 * by level 3. Level 9 is handled separately below with level 1 used purely as a replica-AGE
 * proxy, never as a feeder claim.
 */
export const LITESTREAM_FEEDER_TIER: Record<LitestreamCompactionTier, LitestreamCompactionTier | null> = {
  "0": null,
  "1": "0",
  "2": "1",
  "3": "2",
  "9": null
};

/**
 * Divides the file-count-derived backlog span before it is compared against a threshold.
 *
 * The span bound (see `backlogSpanSeconds` below) rests on litestream's one-file-per-level-per
 * -interval-boundary guarantee — `Store.CompactDB` skips when
 * `dstInfo.CreatedAt.After(prevCompactionAt)`. The ONE known way that guarantee breaks is the
 * root cause of the 2026-08-08 wedge itself: a Coolify rolling deploy briefly runs two
 * litestream writers against the same B2 prefix, and two writers can emit two level-1 objects
 * for the same boundary. Two writers is the observed worst case, so halving restores the
 * guarantee. The cost is halved sensitivity, which is the right direction of error here.
 */
export const LITESTREAM_BACKLOG_SPAN_SAFETY_DIVISOR = 2;

/**
 * Level 9 has no feeder, so an empty snapshot level cannot be graded by the backlog rule. This
 * level's file count is borrowed ONLY as a lower bound on how long the replica has been alive
 * and writing — an age proxy, explicitly labelled as such in the detail text.
 */
const LITESTREAM_SNAPSHOT_AGE_PROXY_TIER: LitestreamCompactionTier = "1";

/** Where a tier's freshness signal actually came from. */
export type LitestreamTierSource = "local-ltx" | "remote-inventory";

/**
 * Why a tier could not be graded. Every non-"known" tier carries one of these plus a
 * human-readable `detail`, because a bare "unknown" reads as "we checked and found nothing"
 * when the truth is usually "we structurally cannot see this from here" — the exact
 * misreading that let five all-"unknown" tiers look like coverage for a day in production.
 *
 * REMOVED 2026-08-14: `"no-activity-recorded"`. It was applied to a level whose remote listing
 * SUCCEEDED and returned zero objects, with the detail "This is normal for a level Litestream
 * has not needed to produce" — an unconditional claim that is false in exactly the case that
 * matters, and one this code never checked. A successful listing returning zero is a
 * MEASUREMENT, not a coverage gap, so it now gets its own `state: "empty"` variant below with
 * an auditable verdict. The member is deleted rather than left unused so nothing reaches for it
 * again.
 */
export type LitestreamTierUnobservableReason =
  | "no-state-path"
  | "local-scan-failed"
  | "remote-inventory-missing"
  | "remote-inventory-stale"
  | "remote-inventory-failed"
  | "remote-inventory-empty"
  | "remote-inventory-inconsistent"
  | "feeder-unobservable";

/**
 * The verdict on a level that was successfully listed and holds nothing.
 *
 *  - `wedged`          — its feeder is advancing and holds a backlog spanning more wall clock
 *                        than this level's threshold, so this level has been offered work on
 *                        every interval tick across that span and produced nothing.
 *  - `upstream-wedged` — this level is empty BECAUSE its feeder is empty and wedged. Reported
 *                        as degraded (an empty rollup level is a real gap in the replica) but
 *                        the detail names the feeder as the thing to fix, so one root cause
 *                        never reads as two independent faults.
 *  - `expected`        — measured empty with a benign, stated explanation: the feeder is idle,
 *                        the feeder is itself empty-but-not-wedged, a higher level already
 *                        promoted past this one, or the backlog is still inside the threshold.
 */
export type LitestreamTierEmptyVerdict = "wedged" | "upstream-wedged" | "expected";

export type LitestreamTierEmptyReason =
  | "backlog-past-threshold"
  | "upstream-wedged"
  | "upstream-empty"
  | "input-idle"
  | "superseded"
  | "within-threshold"
  | "product-disabled";

export type LitestreamTierFreshness =
  | {
      tier: LitestreamCompactionTier;
      label: string;
      state: "known";
      source: LitestreamTierSource;
      newestActivityAt: string;
      newestTxid: string | null;
      ageSeconds: number;
      thresholdSeconds: number;
      degraded: boolean;
    }
  | {
      // A level we DID see, which holds nothing. `newestActivityAt`/`newestTxid`/`ageSeconds`
      // are absent rather than null: there is no artifact, so there is no field, and no
      // consumer can accidentally format one. The feeder fields ARE the evidence for the
      // verdict, so the alarm ships with arithmetic a reader can check.
      tier: LitestreamCompactionTier;
      label: string;
      state: "empty";
      source: LitestreamTierSource;
      fileCount: 0;
      thresholdSeconds: number;
      verdict: LitestreamTierEmptyVerdict;
      reason: LitestreamTierEmptyReason;
      feederTier: LitestreamCompactionTier | null;
      feederFileCount: number | null;
      feederNewestActivityAt: string | null;
      backlogSpanSeconds: number | null;
      degraded: boolean;
      detail: string;
    }
  | {
      tier: LitestreamCompactionTier;
      label: string;
      state: "not-observable";
      thresholdSeconds: number;
      reason: LitestreamTierUnobservableReason;
      detail: string;
    };

/** A tier carrying a verdict (measured with data, or measured as empty) rather than a blind spot. */
export function isLitestreamTierDegraded(tier: LitestreamTierFreshness): boolean {
  return (tier.state === "known" || tier.state === "empty") && tier.degraded;
}

/** Overall provenance of the remote half of the report, for the admin panel's banner. */
export type LitestreamRemoteInventoryState = "ok" | "partial" | "failed" | "skipped" | "missing" | "stale";

export interface LitestreamTierFreshnessReport {
  tiers: LitestreamTierFreshness[];
  degraded: boolean;
  /**
   * One plain sentence per degraded tier, stating the measurement that produced the verdict.
   * Published so an operator (or an external monitor) sees WHY without re-deriving it.
   */
  degradedReasons: string[];
  /** Count of tiers carrying a real signal — the honest "how much do we actually cover?" number. */
  observedTiers: number;
  notObservableTiers: number;
  remoteInventoryState: LitestreamRemoteInventoryState;
  remoteInventoryCollectedAt: string | null;
}

/**
 * One compaction level's newest LTX file in the REMOTE replica, as collected out-of-band by
 * src/lib/litestream-remote-inventory.ts. Declared here (rather than imported) so this module
 * stays dependency-light and unit-testable without a database or a child process.
 */
/** First LTX sequence gap found after sorting by min_txid (exclusive of twin overlaps). */
export interface LitestreamLtxFirstHole {
  prevMaxTxid: string;
  nextMinTxid: string;
}

/**
 * One compaction level's newest LTX file in the REMOTE replica, plus additive LTX-sequence
 * shape fields used to spot mega-file catch-up / hole wedges before age alone fires.
 */
export interface LitestreamRemoteLevelSummary {
  level: number;
  newestAt: string;
  newestTxid: string | null;
  fileCount: number;
  /** Gaps where next.min_txid != prev.max_txid + 1 (twins excluded). */
  holeCount?: number;
  /** Surplus files sharing a max_txid with a different min_txid (dual-writer overlaps). */
  twinCount?: number;
  firstHole?: LitestreamLtxFirstHole | null;
  /** min_txid at the start of the newest contiguous suffix ending at the tip. */
  suffixMinTxid?: string | null;
  /**
   * L1 newest max_txid minus L2 newest max_txid when both tips are known (tx count).
   * Attached on level 2 by the collector; null on other levels / when either tip is missing.
   */
  catchUpSpanTxids?: number | null;
}

export interface LitestreamRemoteInventorySnapshot {
  collectedAt: string;
  status: "ok" | "partial" | "failed" | "skipped";
  /** Keyed by level as a decimal string. Absent levels were not collected. */
  levels: Record<string, LitestreamRemoteLevelSummary>;
  /** Keyed by level; present when that level's listing failed. */
  levelErrors: Record<string, string>;
  skippedReason: string | null;
}

/**
 * How old a collected inventory may be before its levels stop counting as observed.
 *
 * Without this bound a refresher that died would freeze `newestAt` while wall-clock time kept
 * moving, so every remote tier would eventually "age out" and report a wedge that is really
 * just a dead collector. 90 minutes is 3x the 30-minute refresh cadence: it rides out two
 * missed refreshes, and is far inside the tightest remote threshold (level 2 at 2 hours).
 */
export const LITESTREAM_REMOTE_INVENTORY_MAX_AGE_SECONDS = 90 * 60;

interface TierObservation {
  source: LitestreamTierSource;
  newestMs: number;
  newestTxid: string | null;
  /**
   * How many LTX objects the level holds right now. Plumbed through (rather than discarded, as
   * it was until 2026-08-14) because it is the only duration evidence an EMPTY level above it
   * can be graded against — see the backlog-span reasoning in assessLitestreamTierFreshness.
   */
  fileCount: number;
}

/**
 * Read one level's LOCAL `ltx/<level>/` directory.
 *
 * Only level 0 is ever populated locally by Litestream 0.5.12 — verified on the live
 * container 2026-08-12, where `/app/data/.app.db-litestream/ltx/` contained exactly one
 * entry, `0`. Higher levels are compacted straight into the remote replica. This function is
 * still tried for every level (it is one cheap `readdir` and costs nothing when the directory
 * is absent) so that a future Litestream release which does cache higher levels locally would
 * be picked up automatically, and so tests can exercise any level from the filesystem.
 */
function observeTierLocally(statePath: string, tier: LitestreamCompactionTier): TierObservation | "missing" | "failed" {
  const dir = join(statePath, "ltx", tier);
  let observation: LocalLtxObservation | null;
  try {
    observation = readLocalLtxDirectory(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    // A missing directory is the normal case for every level but 0 — not a scan failure.
    return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "failed";
  }
  if (!observation) return "missing";
  return {
    source: "local-ltx",
    newestMs: observation.newestMs,
    newestTxid: observation.newestTxid,
    fileCount: observation.fileCount
  };
}

function remoteInventoryState(
  inventory: LitestreamRemoteInventorySnapshot | null | undefined,
  nowMs: number,
  maxAgeSeconds: number
): LitestreamRemoteInventoryState {
  if (!inventory) return "missing";
  const collectedAtMs = Date.parse(inventory.collectedAt);
  if (!Number.isFinite(collectedAtMs)) return "stale";
  if ((nowMs - collectedAtMs) / 1000 > maxAgeSeconds) return "stale";
  return inventory.status;
}

/**
 * Per-compaction-level backup freshness, from the two sources that genuinely exist.
 *
 * WHAT THIS CAN AND CANNOT SEE (the whole point of the 2026-08-12 rewrite — the previous
 * version claimed to cover levels 0/1/2/3/9 and in production covered NONE of them):
 *
 *  - **Level 0** is read from the local `ltx/0/` directory. Real-time, free, always available
 *    wherever Litestream runs beside the app.
 *  - **Levels 1/2/3/9** exist ONLY in the remote replica. They are read from an out-of-band
 *    inventory collected on a schedule by src/lib/litestream-remote-inventory.ts (which shells
 *    out to the pinned `litestream ltx -level N -json` binary). That listing costs real
 *    Backblaze B2 requests and up to ~8s for level 1, so it must never run inline in a health
 *    request — this function only ever READS an already-collected snapshot.
 *  - **Litestream's own `compaction failed` log lines** — the most direct evidence of the
 *    2026-08-12 wedge — are NOT obtainable. They go to the container's stdout pipe, which is
 *    owned by the Docker log collector; the app can only reach it by draining the same pipe
 *    and stealing lines from `docker logs`. Not viable, so this monitor infers the wedge from
 *    a level that stops advancing instead.
 *
 * A level with no usable signal reports `state: "not-observable"` with a specific reason,
 * never a bare "unknown".
 *
 * THREE states, not two (2026-08-14). A level whose listing SUCCEEDED and returned zero objects
 * reports `state: "empty"` with a `verdict`, because that is a MEASUREMENT and belongs nowhere
 * near "we cannot see this". Until 2026-08-14 it was filed under `not-observable` with the
 * reason `no-activity-recorded` and the detail "This is normal for a level Litestream has not
 * needed to produce" — which is exactly backwards for the failure that was live in production
 * at the time: level 2 held zero objects while level 1 held 2,032 and was still advancing, i.e.
 * the level litestream most certainly DID need to produce. `/api/health` reported no degraded
 * reason and the deep-compaction outage stayed invisible for six days. See
 * docs/rollouts/2026-08-14-empty-tier-wedge-detection.md.
 *
 * Never throws: a missing state directory, an unreadable path, or an absent inventory all
 * degrade to an explained `not-observable`, so this stays safe to call from any environment
 * (tests, local dev) where Litestream is not running at all.
 */
export function assessLitestreamTierFreshness(
  statePath: string | undefined,
  options: {
    nowMs?: number;
    thresholdsSeconds?: Partial<Record<LitestreamCompactionTier, number>>;
    remoteInventory?: LitestreamRemoteInventorySnapshot | null;
    remoteInventoryMaxAgeSeconds?: number;
    /**
     * Compaction levels that are configured OFF.  Production passes
     * LITESTREAM_PRODUCT_DISABLED_TIERS so leftover L2/L3 objects (or empty
     * listings after they age out) never page.  Unit tests that document the
     * 2026-08-14 empty-L2 detector omit this and keep the historical algorithm.
     */
    disabledTiers?: readonly LitestreamCompactionTier[];
  } = {}
): LitestreamTierFreshnessReport {
  const nowMs = options.nowMs ?? Date.now();
  const disabled = new Set(options.disabledTiers ?? []);
  const inventory = options.remoteInventory ?? null;
  const inventoryState = remoteInventoryState(
    inventory,
    nowMs,
    options.remoteInventoryMaxAgeSeconds ?? LITESTREAM_REMOTE_INVENTORY_MAX_AGE_SECONDS
  );
  const inventoryUsable = inventoryState === "ok" || inventoryState === "partial";

  const observations = new Map<LitestreamCompactionTier, TierObservation>();
  const blocked = new Map<LitestreamCompactionTier, { reason: LitestreamTierUnobservableReason; detail: string }>();
  /** Levels whose listing SUCCEEDED and returned zero objects. A measurement, not a blind spot. */
  const measuredEmpty = new Map<LitestreamCompactionTier, LitestreamTierSource>();

  for (const tier of LITESTREAM_COMPACTION_TIERS) {
    const local = statePath ? observeTierLocally(statePath, tier) : "missing";
    if (typeof local === "object") {
      observations.set(tier, local);
      continue;
    }
    if (local === "failed") {
      blocked.set(tier, {
        reason: "local-scan-failed",
        detail: `The local ltx/${tier}/ directory exists but could not be read.  Backup freshness for this level is unknown until that path is readable again.`
      });
      continue;
    }

    // Not present locally: this level lives only in the remote replica.
    if (!inventoryUsable) {
      if (inventoryState === "stale") {
        blocked.set(tier, {
          reason: "remote-inventory-stale",
          detail: `Level ${tier} is stored only in the remote replica, and the scheduled replica inventory is older than ${Math.round((options.remoteInventoryMaxAgeSeconds ?? LITESTREAM_REMOTE_INVENTORY_MAX_AGE_SECONDS) / 60)} minutes.  Its numbers are too old to grade this level, so nothing is claimed about it.`
        });
      } else if (inventoryState === "failed" || inventoryState === "skipped") {
        const why = inventory?.skippedReason?.trim();
        blocked.set(tier, {
          reason: "remote-inventory-failed",
          detail: `Level ${tier} is stored only in the remote replica, and the scheduled replica inventory did not produce data.${why ? `  Reason: ${why}.` : ""}`
        });
      } else {
        blocked.set(tier, {
          reason: !statePath ? "no-state-path" : "remote-inventory-missing",
          detail: !statePath
            ? `No Litestream state directory is configured here, and no replica inventory has been collected, so level ${tier} cannot be observed at all.`
            : `Level ${tier} is stored only in the remote replica (Litestream 0.5.12 keeps no local ltx/${tier}/ directory).  The scheduled replica inventory has not reported yet in this process.`
        });
      }
      continue;
    }

    const remoteError = inventory?.levelErrors?.[tier];
    if (remoteError) {
      blocked.set(tier, {
        reason: "remote-inventory-failed",
        detail: `Listing level ${tier} in the remote replica failed: ${remoteError}.`
      });
      continue;
    }

    const summary = inventory?.levels?.[tier];
    if (!summary) {
      blocked.set(tier, {
        reason: "remote-inventory-missing",
        detail: `Level ${tier} is stored only in the remote replica, and the last inventory did not cover it.`
      });
      continue;
    }

    // Split the two conditions the pre-2026-08-14 code collapsed into one "no activity" bucket.
    // "Zero objects" and "objects we could not read a timestamp off" are different facts, and
    // only the first one is a measurement we are entitled to draw a verdict from.
    const newestMs = Date.parse(summary.newestAt);
    const hasTimestamp = summary.newestAt.trim() !== "" && Number.isFinite(newestMs);
    const isEmpty = summary.fileCount <= 0;
    if (isEmpty !== !hasTimestamp) {
      blocked.set(tier, {
        reason: "remote-inventory-inconsistent",
        detail: isEmpty
          ? `The replica listing for level ${tier} reported no files but still carried a timestamp, so it is internally inconsistent and nothing is claimed about this level.`
          : `The replica listing for level ${tier} reported ${summary.fileCount} file(s) but no readable timestamp on any of them, so its freshness cannot be graded.`
      });
      continue;
    }
    if (isEmpty) {
      // MEASURED EMPTY. The listing succeeded and the answer is zero. Graded below, never
      // filed under "not observable" — that variant means "we structurally cannot see this",
      // and we can see this perfectly well.
      measuredEmpty.set(tier, "remote-inventory");
      continue;
    }
    observations.set(tier, {
      source: "remote-inventory",
      newestMs,
      newestTxid: summary.newestTxid,
      fileCount: summary.fileCount
    });
  }

  // WHOLE-PREFIX GUARD. A successful listing that returns nothing at EVERY remote level is a
  // wrong bucket / wrong path / brand-new prefix, not four simultaneous independent wedges.
  const remoteTiers = LITESTREAM_COMPACTION_TIERS.filter((tier) => tier !== "0");
  if (remoteTiers.every((tier) => measuredEmpty.has(tier))) {
    for (const tier of remoteTiers) {
      measuredEmpty.delete(tier);
      blocked.set(tier, {
        reason: "remote-inventory-empty",
        detail: `Every remote compaction level listed empty, including level ${tier}.  A replica with no objects anywhere is a prefix, bucket, or credential mismatch — or a brand-new replica — rather than four independent wedges, so no verdict is drawn.`
      });
    }
  }

  // Level 0 is the pacemaker: every higher level only has work to do because level 0 produced
  // new transactions. Using its newest txid as the reference means an IDLE database (level 0
  // quiet, so nothing to compact) cannot false-alarm every higher level — while a level whose
  // txid has fallen behind a still-advancing level 0, past its threshold, is a real wedge.
  const referenceTxid = observations.get("0")?.newestTxid ?? null;

  // Clock for grading a REMOTE feeder's freshness. Deliberately the snapshot's own
  // `collectedAt`, not `nowMs`: the snapshot may legitimately be up to
  // LITESTREAM_REMOTE_INVENTORY_MAX_AGE_SECONDS old, and grading its contents against request
  // time would silently downgrade a real wedge to "expected" purely as the snapshot ages —
  // a miss manufactured by collector lag. Snapshot staleness is policed separately, above.
  const collectedAtMs = inventory ? Date.parse(inventory.collectedAt) : Number.NaN;
  const inventoryClockMs = Number.isFinite(collectedAtMs) ? collectedAtMs : nowMs;
  const referenceMsFor = (observation: TierObservation): number =>
    observation.source === "local-ltx" ? nowMs : inventoryClockMs;

  const thresholdFor = (tier: LitestreamCompactionTier): number =>
    options.thresholdsSeconds?.[tier] ?? LITESTREAM_TIER_STALE_AFTER_SECONDS[tier];

  /**
   * Lower bound, in seconds, on how long a level has been offered work it did not do.
   *
   * `Store.CompactDB` permits at most ONE file per level per interval boundary (it skips when
   * `dstInfo.CreatedAt.After(prevCompactionAt)`), so K files retained at the feeder occupy at
   * least K-1 distinct boundaries — i.e. the oldest still-present feeder file is at least
   * (K-1) x interval old, and all K are in the listing right now, so they existed continuously
   * across that span while the level above ticked with a non-empty source.
   *
   * A raw file-count threshold would NOT work here and the temptation should be named: the
   * healthy replica measured 5,635 level-1 files on 2026-08-12 and the wedged one measured
   * 2,032 on 2026-08-14 — the count went DOWN, because retention prunes every level regardless
   * of health. Converting the count to wall clock is the part that is actually invariant.
   */
  const backlogSpanSeconds = (feeder: LitestreamCompactionTier, fileCount: number): number =>
    Math.max(
      0,
      Math.floor((fileCount - 1) / LITESTREAM_BACKLOG_SPAN_SAFETY_DIVISOR)
        * LITESTREAM_LEVEL_PRODUCTION_INTERVAL_SECONDS[feeder]
    );

  /** True when some higher level that actually CONSUMES this level has already promoted past
   *  what the feeder holds — this level's objects were moved up rather than lost, so an empty
   *  level here is expected.
   *
   *  The `LITESTREAM_FEEDER_TIER[candidate] !== null` filter is load-bearing and NOT a
   *  micro-optimisation: it excludes level 9, whose txid is not evidence about anything below
   *  it. `Store.CompactDB` shortcuts the snapshot level straight to `db.Snapshot`, so level 9
   *  tracks the LIVE DATABASE, not level 3 — and in the window right after each daily snapshot
   *  its txid is normally at or past level 1's. Scanning it here made the 2026-08-14 level-2
   *  wedge read `expected/superseded degraded=false` once a day and printed the false sentence
   *  "level 9 has already advanced ... so this level's objects were promoted rather than lost".
   *  This is the one code path that can silence the empty-level alarm, so it may only consult
   *  levels that genuinely compact FROM a lower level. */
  const supersededBy = (tier: LitestreamCompactionTier, feederTxid: string | null): LitestreamCompactionTier | null => {
    if (!feederTxid) return null;
    for (const candidate of LITESTREAM_COMPACTION_TIERS) {
      if (candidate <= tier) continue;
      if (LITESTREAM_FEEDER_TIER[candidate] === null) continue;
      const higher = observations.get(candidate);
      if (!higher || higher.fileCount <= 0 || !higher.newestTxid) continue;
      if (compareLitestreamTxid(higher.newestTxid, feederTxid) >= 0) return candidate;
    }
    return null;
  };

  // Ascending order matters: an empty level consults the verdict already computed for the level
  // below it, so `upstream-wedged` can name a real, already-decided fault rather than re-deriving.
  const decided = new Map<LitestreamCompactionTier, LitestreamTierFreshness>();

  for (const tier of LITESTREAM_COMPACTION_TIERS) {
    const thresholdSeconds = thresholdFor(tier);
    const label = LITESTREAM_TIER_LABELS[tier];
    const observation = observations.get(tier);

    if (observation) {
      const ageSeconds = Math.max(0, Math.round((nowMs - observation.newestMs) / 1000));
      const overThreshold = ageSeconds > thresholdSeconds;
      // Level 0 is graded on age alone — it IS the pacemaker, so there is nothing to lag behind.
      const caughtUpWithLevel0 =
        tier !== "0"
        && observation.newestTxid !== null
        && referenceTxid !== null
        && compareLitestreamTxid(observation.newestTxid, referenceTxid) >= 0;

      decided.set(tier, {
        tier,
        label,
        state: "known",
        source: observation.source,
        newestActivityAt: new Date(observation.newestMs).toISOString(),
        newestTxid: observation.newestTxid,
        ageSeconds,
        thresholdSeconds,
        // A disabled level may still list leftover replica objects.  Those must not
        // page: the product no longer compacts them, so they will only get older.
        degraded: disabled.has(tier) ? false : overThreshold && !caughtUpWithLevel0
      });
      continue;
    }

    const emptySource = measuredEmpty.get(tier);
    if (emptySource) {
      if (disabled.has(tier)) {
        decided.set(tier, {
          tier,
          label,
          state: "empty",
          source: emptySource,
          fileCount: 0,
          thresholdSeconds,
          verdict: "expected",
          reason: "product-disabled",
          feederTier: null,
          feederFileCount: null,
          feederNewestActivityAt: null,
          backlogSpanSeconds: null,
          degraded: false,
          detail:
            `Level ${tier} is disabled in the product compaction set (litestream.coolify.yml ` +
            "levels: is L1 only; Litestream 0.5.12 has no other off switch).  " +
            "Emptiness at this level is expected, not a wedge."
        });
        continue;
      }
      decided.set(tier, classifyEmptyTier(tier));
      continue;
    }

    const block = blocked.get(tier) ?? {
      reason: "remote-inventory-missing" as const,
      detail: `No freshness signal is available for level ${tier}.`
    };
    decided.set(tier, { tier, label, state: "not-observable", thresholdSeconds, reason: block.reason, detail: block.detail });
  }

  /**
   * Grade a level we successfully listed and found empty.
   *
   * Mechanism this rests on, read from litestream v0.5.12 rather than assumed:
   * `Store.monitorCompactionLevel` fires on every interval boundary, and `Store.CompactDB` has
   * NO volume or accumulation threshold — it skips only when it already ran this boundary or
   * when `srcInfo.MaxTXID <= dstInfo.MinTXID`. An EMPTY destination has `dstInfo.MinTXID == 0`,
   * so that second test can never be true while the feeder holds anything. An empty level whose
   * feeder is non-empty is therefore NOT "waiting for enough input"; it is a level that has been
   * offered work on every tick and produced nothing.
   */
  function classifyEmptyTier(tier: LitestreamCompactionTier): LitestreamTierFreshness {
    const thresholdSeconds = thresholdFor(tier);
    const label = LITESTREAM_TIER_LABELS[tier];
    const source = measuredEmpty.get(tier) ?? "remote-inventory";
    const base = {
      tier,
      label,
      state: "empty" as const,
      source,
      fileCount: 0 as const,
      thresholdSeconds
    };
    const expected = (
      reason: LitestreamTierEmptyReason,
      detail: string,
      extra: Partial<{
        feederTier: LitestreamCompactionTier | null;
        feederFileCount: number | null;
        feederNewestActivityAt: string | null;
        backlogSpanSeconds: number | null;
      }> = {}
    ): LitestreamTierFreshness => ({
      ...base,
      verdict: "expected",
      reason,
      feederTier: extra.feederTier ?? null,
      feederFileCount: extra.feederFileCount ?? null,
      feederNewestActivityAt: extra.feederNewestActivityAt ?? null,
      backlogSpanSeconds: extra.backlogSpanSeconds ?? null,
      degraded: false,
      detail
    });

    // Level 9 has no feeder: `CompactDB` shortcuts the snapshot level straight to `db.Snapshot`.
    // Level 1 is borrowed ONLY as a lower bound on replica age, and the copy says so.
    const isSnapshotLevel = LITESTREAM_FEEDER_TIER[tier] === null;
    const evidenceTier = isSnapshotLevel ? LITESTREAM_SNAPSHOT_AGE_PROXY_TIER : LITESTREAM_FEEDER_TIER[tier]!;
    const relation = isSnapshotLevel ? "age proxy" : "feeder";

    if (isSnapshotLevel && tier === "0") {
      // Level 0 is the pacemaker and is read locally; an empty ltx/0 is handled upstream as
      // "not observable" and never reaches here. Guard anyway rather than invent a verdict.
      return expected(
        "input-idle",
        `Level ${tier} holds no files and has no lower level to compare against, so no verdict is drawn.`
      );
    }

    const evidence = observations.get(evidenceTier);
    if (!evidence) {
      const evidenceEmpty = measuredEmpty.has(evidenceTier);
      if (!evidenceEmpty) {
        return {
          tier,
          label,
          state: "not-observable",
          thresholdSeconds,
          reason: "feeder-unobservable",
          detail: `Level ${tier} holds no files, and level ${evidenceTier} — the ${relation} this verdict would rest on — cannot be observed right now, so no verdict is drawn.`
        };
      }
      const upstream = decided.get(evidenceTier);
      const upstreamWedged =
        upstream?.state === "empty" && (upstream.verdict === "wedged" || upstream.verdict === "upstream-wedged");
      if (upstreamWedged) {
        return {
          ...base,
          verdict: "upstream-wedged",
          reason: "upstream-wedged",
          feederTier: evidenceTier,
          feederFileCount: 0,
          feederNewestActivityAt: null,
          backlogSpanSeconds: null,
          degraded: true,
          detail: `The replica holds no objects at level ${tier}.  Level ${evidenceTier} is also empty and is itself wedged, so this level has had nothing to promote.  Fixing level ${evidenceTier} is what restores this one; it is not a second, independent fault.`
        };
      }
      return expected(
        "upstream-empty",
        `The replica holds no objects at level ${tier}.  Level ${evidenceTier} is empty too, without a wedge verdict of its own, so there has been nothing to promote.`,
        { feederTier: evidenceTier, feederFileCount: 0 }
      );
    }

    const evidenceNewestAt = new Date(evidence.newestMs).toISOString();
    const evidenceAgeSeconds = Math.max(0, Math.round((referenceMsFor(evidence) - evidence.newestMs) / 1000));
    if (evidenceAgeSeconds > thresholdFor(evidenceTier)) {
      return expected(
        "input-idle",
        `The replica holds no objects at level ${tier}.  Level ${evidenceTier} has not produced anything for ${describeDuration(evidenceAgeSeconds)} either, so the compaction cascade is idle rather than stuck.`,
        { feederTier: isSnapshotLevel ? null : evidenceTier, feederFileCount: evidence.fileCount, feederNewestActivityAt: evidenceNewestAt }
      );
    }

    const superseded = isSnapshotLevel ? null : supersededBy(tier, evidence.newestTxid);
    if (superseded) {
      return expected(
        "superseded",
        `The replica holds no objects at level ${tier}.  Level ${superseded} has already advanced to transaction ${observations.get(superseded)!.newestTxid}, so this level's objects were promoted rather than lost.`,
        { feederTier: evidenceTier, feederFileCount: evidence.fileCount, feederNewestActivityAt: evidenceNewestAt }
      );
    }

    const span = backlogSpanSeconds(evidenceTier, evidence.fileCount);
    const shared = {
      feederTier: isSnapshotLevel ? null : evidenceTier,
      feederFileCount: evidence.fileCount,
      feederNewestActivityAt: evidenceNewestAt,
      backlogSpanSeconds: span
    };
    if (span <= thresholdSeconds) {
      return expected(
        "within-threshold",
        `The replica holds no objects at level ${tier}.  Level ${evidenceTier} holds ${evidence.fileCount} file(s), spanning at least ${describeDuration(span)} — inside this level's ${describeDuration(thresholdSeconds)} threshold — so no verdict is drawn yet.`,
        shared
      );
    }

    const intervalText = describeDuration(LITESTREAM_LEVEL_PRODUCTION_INTERVAL_SECONDS[tier]);
    return {
      ...base,
      ...shared,
      verdict: "wedged",
      reason: "backlog-past-threshold",
      degraded: true,
      detail: isSnapshotLevel
        ? `The replica holds no objects at level ${tier}.  Level ${evidenceTier} holds ${evidence.fileCount} file(s) and last produced ${describeDuration(evidenceAgeSeconds)} ago, which puts the replica's own age at a minimum of ${describeDuration(span)} — past this level's ${describeDuration(thresholdSeconds)} threshold.  Level ${evidenceTier} is used here only as an age lower bound, not as a source this level compacts from.`
        : `The replica holds no objects at level ${tier}.  Level ${evidenceTier} holds ${evidence.fileCount} file(s) spanning at least ${describeDuration(span)} of compaction boundaries and last produced ${describeDuration(evidenceAgeSeconds)} ago, so this level has had input available throughout.  Level ${tier} compaction is offered this work every ${intervalText} and has produced nothing, past its ${describeDuration(thresholdSeconds)} threshold.`
    };
  }

  const tiers = LITESTREAM_COMPACTION_TIERS.map((tier) => decided.get(tier)!);
  const degradedReasons = tiers.filter(isLitestreamTierDegraded).map((tier) =>
    tier.state === "empty"
      ? tier.detail
      : `Level ${tier.tier} ("${tier.label}") last produced ${describeDuration((tier as Extract<LitestreamTierFreshness, { state: "known" }>).ageSeconds)} ago, past its ${describeDuration(tier.thresholdSeconds)} threshold, while level 0 kept advancing.`
  );

  // Contiguity / mega-file catch-up signals from the remote inventory (additive to age grading).
  const l1Summary = inventoryUsable ? inventory?.levels?.["1"] : undefined;
  const l2Summary = inventoryUsable ? inventory?.levels?.["2"] : undefined;
  const catchUpSpan =
    l2Summary?.catchUpSpanTxids
    ?? (
      l1Summary?.newestTxid && l2Summary?.newestTxid
        ? litestreamCatchUpSpanTxids(l1Summary.newestTxid, l2Summary.newestTxid)
        : null
    );
  const l2Degraded = tiers.some((tier) => tier.tier === "2" && isLitestreamTierDegraded(tier));
  if (l2Degraded && catchUpSpan != null && catchUpSpan > LITESTREAM_CATCH_UP_SPAN_HUGE_TXIDS) {
    degradedReasons.push(
      `Level 2 is stale while level 1 is ahead by ${catchUpSpan.toLocaleString("en-US")} transactions — Compact is attempting a mega-file L1-to-L2 catch-up that tends to fail on B2 with connection reset / LTX header EOF, not merely an empty L2.`
    );
  } else if (l2Degraded && l2Summary && l2Summary.fileCount <= 0 && (l1Summary?.fileCount ?? 0) > 0) {
    // Empty L2 with live L1 input: name the mega-file failure mode even without a numeric span.
    degradedReasons.push(
      `Level 2 holds no objects while level 1 still has ${l1Summary!.fileCount} file(s) — Compact may be stuck on a mega-file L1-to-L2 catch-up (B2 connection reset / LTX header EOF), not only "L2 empty".`
    );
  }
  const l1HoleCount = l1Summary?.holeCount ?? 0;
  if (l1Summary && l1HoleCount > 0) {
    const holeHint = l1Summary.firstHole
      ? ` First hole after ${l1Summary.firstHole.prevMaxTxid} before ${l1Summary.firstHole.nextMinTxid}.`
      : "";
    degradedReasons.push(
      `Level 1 LTX sequence has ${l1HoleCount} hole(s); Compact cannot walk a non-contiguous L1 prefix into L2.${holeHint}`
    );
  }

  const degraded =
    tiers.some(isLitestreamTierDegraded)
    || l1HoleCount > 0;

  return {
    tiers,
    degraded,
    degradedReasons,
    // A level we successfully listed IS covered, whether or not it had contents. Counting an
    // empty level as "not observable" would understate coverage in exactly the direction that
    // made the two earlier versions of this monitor look sighted while they were blind.
    observedTiers: tiers.filter((t) => t.state === "known" || t.state === "empty").length,
    notObservableTiers: tiers.filter((t) => t.state === "not-observable").length,
    remoteInventoryState: inventoryState,
    remoteInventoryCollectedAt: inventory?.collectedAt ?? null
  };
}

/** Compact, human-readable duration for alert and panel copy ("45m", "8h27m", "2d3h"). */
export function describeDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total}s`;
  if (total < 3600) return `${Math.floor(total / 60)}m`;
  if (total < 86400) {
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
  }
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  return hours > 0 ? `${days}d${hours}h` : `${days}d`;
}

function fileFallback(statePath: string | undefined, nowMs: number): LitestreamRuntimeHealth | null {
  if (!statePath) return null;
  try {
    const newestMs = newestFileMtimeMs(statePath);
    if (newestMs === null || !(newestMs > 0)) return null;
    return {
      state: "known",
      source: "file",
      // A fresh state artifact proves recent activity, not the daemon's current state.
      status: "activity-observed",
      lastSyncAt: new Date(newestMs).toISOString(),
      ageSeconds: Math.max(0, Math.round((nowMs - newestMs) / 1000)),
      timestampState: "valid"
    };
  } catch {
    return null;
  }
}

function readUnixSocketJson(socketPath: string, timeoutMs: number, maxResponseBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const succeed = (value: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    const req = request({ socketPath, path: "/list", method: "GET" }, (res) => {
      const chunks: Buffer[] = [];
      let responseBytes = 0;
      let ended = false;
      res.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        responseBytes += buffer.length;
        if (responseBytes > maxResponseBytes) {
          const error = new Error(`Litestream IPC response exceeded ${maxResponseBytes} bytes`);
          fail(error);
          res.destroy(error);
          req.destroy(error);
          return;
        }
        chunks.push(buffer);
      });
      res.on("aborted", () => fail(new Error("Litestream IPC response aborted")));
      res.on("error", fail);
      res.on("end", () => {
        ended = true;
        const statusCode = res.statusCode ?? 500;
        if (statusCode < 200 || statusCode >= 300) {
          fail(new Error(`Litestream IPC HTTP ${statusCode}`));
          return;
        }
        try {
          succeed(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (error) {
          fail(error);
        }
      });
      res.on("close", () => {
        if (!ended && !res.complete) fail(new Error("Litestream IPC response closed before completion"));
      });
    });
    // A wall-clock deadline is required here. ClientRequest#setTimeout() is only an
    // inactivity timer, so a trickling daemon response could otherwise hold /api/health open.
    const timer = setTimeout(
      () => req.destroy(new Error("Litestream IPC deadline exceeded")),
      Math.max(1, timeoutMs)
    );
    req.on("error", fail);
    req.end();
  });
}

/**
 * Read the running Litestream 0.5.x daemon over its local Unix socket. No network or
 * replica mutation occurs. The legacy mtime source remains a fallback for dev/older setups.
 */
export async function getLitestreamRuntimeHealth(options: {
  dbPath: string;
  socketPath?: string;
  statePath?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  allowFileFallback?: boolean;
  nowMs?: number;
}): Promise<LitestreamRuntimeHealth> {
  const nowMs = options.nowMs ?? Date.now();
  // Candidate control-socket paths, most-explicit first. The last entry is the
  // Litestream 0.5.x DEFAULT control-socket location (<db-dir>/litestream.sock):
  // 0.5.12 ignores the config file's `socket.path` and listens there instead —
  // prod 2026-07-30..08-01 reported litestreamState "unknown" for days while
  // replication was perfectly healthy, purely because the probe only tried the
  // configured /var/run path. Trying both makes the health check correct
  // regardless of which location the running version picked.
  const socketCandidates = [
    options.socketPath?.trim(),
    process.env.LITESTREAM_SOCKET_PATH?.trim(),
    "/var/run/litestream.sock",
    defaultLitestreamSocketPath(options.dbPath),
  ].filter((p): p is string => Boolean(p));
  const seen = new Set<string>();
  for (const socketPath of socketCandidates) {
    if (seen.has(socketPath)) continue;
    seen.add(socketPath);
    try {
      const payload = await readUnixSocketJson(
        socketPath,
        options.timeoutMs ?? 500,
        options.maxResponseBytes ?? LITESTREAM_IPC_MAX_RESPONSE_BYTES
      );
      const parsed = parseLitestreamListPayload(payload, options.dbPath, nowMs);
      if (parsed) return parsed;
    } catch {
      // Try the next candidate, then fall through to the file source.
    }
  }

  const fallback = options.allowFileFallback === false ? null : fileFallback(options.statePath, nowMs);
  return fallback ?? { state: "unknown", source: "none" };
}

/**
 * Litestream's own log lines that mean a compaction level (store.go `compactDB`) or the periodic
 * validation monitor (store.go `monitorValidation`) hit a real, unrecovered failure -- as opposed
 * to the routine "no compaction" / "db not ready" DEBUG-level chatter, which never appears at the
 * default INFO log level and is therefore never in the file this scans. Exact wording verified
 * against the pinned v0.5.12 source:
 *   - `db.Logger.Error("compaction failed", "level", lvl.Level, "error", err)` (store.go)
 *   - `s.Logger.Warn("validation error detected", "level", ..., "type", ..., "message", ...)`
 *     (store.go monitorValidation, requires the `validation:` config block above)
 * A version bump could reword these; if a future litestream release does, this list is the one
 * place to update it.
 */
export const LITESTREAM_RUNTIME_LOG_FAILURE_MARKERS = ["compaction failed", "validation error detected"] as const;
export type LitestreamRuntimeLogMarker = (typeof LITESTREAM_RUNTIME_LOG_FAILURE_MARKERS)[number];

/** Optional subclass of a `compaction failed` line for the mega-L2 / B2 failure modes. */
export type LitestreamRuntimeLogClassification =
  | "storage-class-unsupported"
  | "ltx-header-eof"
  | "connection-reset"
  | null;

export interface LitestreamRuntimeLogFinding {
  marker: LitestreamRuntimeLogMarker;
  /** Trimmed, length-capped log line for a human-readable alert -- never the raw unbounded text. */
  line: string;
  /**
   * Numeric compaction level parsed from the line (`level=2`), not log severity
   * (`level=ERROR`).  Null when the line has no compaction-level field.
   */
  level: string | null;
  /** Set when a compaction-failed line matches a known B2/mega-L2 failure substring. */
  classification?: LitestreamRuntimeLogClassification;
}

function classifyLitestreamCompactionFailure(line: string): LitestreamRuntimeLogClassification {
  if (line.includes("Storage class not supported")) return "storage-class-unsupported";
  if (line.includes("extract timestamp from LTX header: EOF")) return "ltx-header-eof";
  if (line.includes("connection reset by peer")) return "connection-reset";
  return null;
}

const LITESTREAM_RUNTIME_LOG_MAX_LINE_CHARS = 500;
const LITESTREAM_RUNTIME_LOG_MAX_FINDINGS = 5;
/**
 * Upper bound on how much of the log file a single health check will ever read, taken from the
 * END of the file (the tail). A wedge is evidenced by RECENT failures, not by the file's entire
 * history, and this keeps the read cost fixed no matter how long the container has been up --
 * the same "bound the work, never refuse to answer" principle as LITESTREAM_DIR_STAT_SAMPLE
 * above. At litestream's INFO log level, routine operation produces close to nothing here (see
 * scripts/coolify-prod-start.sh's comment on what actually gets teed in) so this ceiling is only
 * ever exercised during a genuine, sustained incident.
 */
const LITESTREAM_RUNTIME_LOG_TAIL_MAX_BYTES = 256 * 1024;

function parseLitestreamLogTimeMs(line: string): number | null {
  const match = line.match(/time=(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)/);
  if (!match) return null;
  const ms = Date.parse(match[1]);
  return Number.isFinite(ms) ? ms : null;
}

/** Numeric compaction level (`level=2`), not the log severity (`level=ERROR`). */
export function parseLitestreamCompactionLevel(line: string): string | null {
  const matches = [...line.matchAll(/\blevel=(\d+)\b/g)];
  return matches.length > 0 ? matches[matches.length - 1]![1]! : null;
}

/**
 * Pure: scan already-read text for litestream's own failure lines. Unit-testable without I/O.
 *
 * Recovery is PER LEVEL.  A later `compaction complete` for level 1 must not clear a
 * still-open level-2 `compaction failed` (the 2026-08-31 incident: nullish fallback to
 * any-level complete kept `litestreamCompactionLogFailureCount` at 0 through the wedge).
 * A failure whose compaction level cannot be parsed is never treated as recovered.
 */
export function scanLitestreamRuntimeLogText(text: string): LitestreamRuntimeLogFinding[] {
  const lastCompleteByLevel = new Map<string, number>();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line.includes("compaction complete")) continue;
    const at = parseLitestreamLogTimeMs(line);
    if (at == null) continue;
    const lvl = parseLitestreamCompactionLevel(line);
    if (!lvl) continue;
    lastCompleteByLevel.set(lvl, Math.max(lastCompleteByLevel.get(lvl) ?? 0, at));
  }

  const findings: LitestreamRuntimeLogFinding[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const marker = LITESTREAM_RUNTIME_LOG_FAILURE_MARKERS.find((candidate) => line.includes(candidate));
    if (!marker) continue;
    const at = parseLitestreamLogTimeMs(line);
    const lvl = parseLitestreamCompactionLevel(line);
    const recoveredAt = lvl ? lastCompleteByLevel.get(lvl) : undefined;
    // A later successful compaction for THAT level means the hole was healed.
    // Do not fall back to any-level completes — L1 ticking does not unwedge L2.
    if (at != null && recoveredAt != null && recoveredAt > at) continue;
    const classification =
      marker === "compaction failed" ? classifyLitestreamCompactionFailure(line) : null;
    const capped =
      line.length > LITESTREAM_RUNTIME_LOG_MAX_LINE_CHARS
        ? `${line.slice(0, LITESTREAM_RUNTIME_LOG_MAX_LINE_CHARS)}…`
        : line;
    // Keep counting as failure via the existing "compaction failed" marker; optionally label
    // the known mega-L2 / B2 substrings in the finding line for operators.
    const annotated =
      classification != null ? `[${classification}] ${capped}` : capped;
    findings.push(
      classification != null
        ? { marker, line: annotated, level: lvl, classification }
        : { marker, line: annotated, level: lvl }
    );
    if (findings.length >= LITESTREAM_RUNTIME_LOG_MAX_FINDINGS) break;
  }
  return findings;
}

/**
 * Read the tail of scripts/coolify-prod-start.sh's teed litestream runtime log and scan it for
 * litestream's own compaction/validation failure lines.
 *
 * This is a genuinely INDEPENDENT signal from assessLitestreamTierFreshness above: it needs no
 * S3/B2 credentials, does not depend on the remote LTX inventory
 * (src/lib/litestream-remote-inventory.ts, whose scheduler wiring has a separate known bug in
 * flight elsewhere), and works even when every compaction tier above is "not-observable". It is
 * also strictly narrower: it can only ever prove a failure happened recently (a real alarm,
 * folded into storageDegraded by the caller), never that everything is fine -- an empty result
 * here means "no evidence of failure in the tail we read", not "confirmed healthy", so callers
 * must not treat it as a positive health signal on its own.
 *
 * Never throws. A missing file (litestream not running this boot, or not yet past its first
 * `-exec`) reports no findings rather than an error -- the same "not-observable, not fabricated"
 * posture the rest of this module uses, just expressed as "nothing found" because there is no
 * separate not-observable state to report for what is fundamentally a best-effort grep.
 *
 * Known, accepted imprecision: the tail read can start mid-line, so a marker string that
 * straddles exactly that byte boundary could be missed on one check. A sustained wedge repeats
 * the same failure every compaction-monitor interval (30s-1h depending on level), so the next
 * health check's shifted tail window overwhelmingly does not land on the same boundary twice --
 * this is a retried, best-effort signal, not a one-shot guarantee.
 */
export function scanLitestreamRuntimeLogFile(
  logPath: string,
  maxTailBytes: number = LITESTREAM_RUNTIME_LOG_TAIL_MAX_BYTES
): LitestreamRuntimeLogFinding[] {
  let fd: number | undefined;
  try {
    const stat = statSync(logPath);
    if (!stat.isFile() || stat.size <= 0) return [];
    const readBytes = Math.min(stat.size, Math.max(1, maxTailBytes));
    const start = stat.size - readBytes;
    fd = openSync(logPath, "r");
    const buffer = Buffer.alloc(readBytes);
    readSync(fd, buffer, 0, readBytes, start);
    return scanLitestreamRuntimeLogText(buffer.toString("utf8"));
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // best-effort close
      }
    }
  }
}
