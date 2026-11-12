/**
 * Scheduled inventory of the REMOTE Litestream replica, broken out per compaction level.
 *
 * WHY THIS EXISTS
 * ---------------
 * Litestream 0.5.12 keeps only level 0 in the local `ltx/0/` cache; levels 1, 2, 3 and 9 are
 * compacted straight into the remote replica (Backblaze B2) and never appear on local disk.
 * Verified on the live container 2026-08-12: `/app/data/.app.db-litestream/ltx/` contained
 * exactly one entry, `0`. Any monitor that grades higher levels from local files is therefore
 * structurally blind to them, which is precisely how a wedged level-2 compaction ran
 * unnoticed in production while every health signal stayed green.
 *
 * The IPC control socket cannot close the gap either. Litestream 0.5.12 serves exactly two
 * routes there — `/list` (path, status, last_sync_at) and `/info` (version, pid, uptime,
 * started_at, database_count); everything else 404s. Neither carries per-level data. Probed
 * against the live daemon on 2026-08-12.
 *
 * What DOES work is the pinned binary's own reader: `litestream ltx -level N -json <db>` lists
 * the remote LTX inventory for one level, including each file's txid range and timestamp. The
 * app process can run it because it is a CHILD of the litestream daemon
 * (`litestream replicate -exec "next start"` in scripts/coolify-prod-start.sh) and therefore
 * inherits the same AWS_* replica credentials.
 *
 * COST — WHY THIS IS SCHEDULED AND NEVER INLINE
 * ---------------------------------------------
 * Measured against the live replica on 2026-08-12:
 *   level 1  -> 8.3s, 5,635 files, 887 KB of JSON
 *   level 2  -> 0.9s,   171 files
 *   level 3  -> 0.7s,    15 files
 *   level 9  -> 0.7s,     8 files
 *   -level all -> 143s, 90,500 files, 14.1 MB    <- never used; level 0 dominates it
 * Roughly 11s and ~9 B2 LIST calls per refresh. At the 30-minute cadence below that is ~430
 * LIST calls/day, comfortably inside B2's free daily transaction allowance, and it keeps every
 * one of those seconds off the `/api/health` request path.
 *
 * Level 0 is deliberately NOT collected here: it is already readable locally, in real time,
 * for free, and it is the level that makes `-level all` unusable.
 */

// Bare specifiers (not `node:`-prefixed) and a runtime `require` for child_process: this
// module is reachable from src/lib/scheduler.ts, which Next's webpack build traverses, and
// webpack rejects `node:` URIs there. The eval-require for child_process follows the existing
// precedent in src/lib/data-providers.ts (runWebullUnofficialScript) for the same reason.
import { accessSync, constants } from "fs";
import { dirname, join } from "path";
import { deleteDurableStateValue, getDurableStateValue, setDurableStateValue } from "./db-durable-state";
import {
  compareLitestreamTxid,
  litestreamCatchUpSpanTxids,
  litestreamTxidSuccessor,
  normalizeLitestreamTxid,
  type LitestreamLtxFirstHole,
  type LitestreamRemoteInventorySnapshot,
  type LitestreamRemoteLevelSummary
} from "./runtime-health";

type ExecFileFn = (
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer: number; encoding: "utf8"; windowsHide: boolean },
  callback: (error: Error | null, stdout: string, stderr: string) => void
) => void;

function loadExecFile(): ExecFileFn {
  const requireFn = eval("require") as (id: string) => unknown;
  return (requireFn("child_process") as { execFile: ExecFileFn }).execFile;
}

/** Levels that exist only in the remote replica. Level 0 is read locally instead. */
export const LITESTREAM_REMOTE_LEVELS: readonly number[] = [1, 2, 3, 9];

export const LITESTREAM_REMOTE_INVENTORY_INTERVAL_MS = 30 * 60_000;
/** After a failed collection, retry sooner than the normal cadence without hammering B2. */
export const LITESTREAM_REMOTE_INVENTORY_RETRY_INTERVAL_MS = 10 * 60_000;
/** Level 1 measured 8.3s; 45s leaves headroom for a slow replica without hanging a lane. */
const PER_LEVEL_TIMEOUT_MS = 45_000;
/** Level 1's listing is ~887 KB today; 32 MB tolerates years of growth before truncating. */
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

export interface LitestreamRemoteInventoryConfig {
  binPath: string;
  configPath: string;
  dbPath: string;
  levels: readonly number[];
}

export type LitestreamRemoteInventoryResolution =
  | { ok: true; config: LitestreamRemoteInventoryConfig }
  | { ok: false; skippedReason: string };

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isReadable(path: string): boolean {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function isDisabled(env: Readonly<Record<string, string | undefined>>): boolean {
  const raw = String(env.LITESTREAM_REMOTE_INVENTORY ?? "").trim().toLowerCase();
  return raw === "off" || raw === "0" || raw === "false" || raw === "no";
}

/**
 * Decide whether a remote inventory can be collected here, WITHOUT reading any secret value.
 *
 * Credential checks are presence-only (`Boolean(env.X)`); this module never logs, returns, or
 * interpolates a credential, and the child process inherits them through `process.env` rather
 * than receiving them on a command line.
 */
export function resolveLitestreamRemoteInventoryConfig(options: {
  dbPath: string;
  env?: Readonly<Record<string, string | undefined>>;
}): LitestreamRemoteInventoryResolution {
  const env = options.env ?? process.env;
  if (isDisabled(env)) {
    return { ok: false, skippedReason: "disabled by LITESTREAM_REMOTE_INVENTORY" };
  }

  const binPath = env.LITESTREAM_BIN?.trim() || join(dirname(options.dbPath), ".bin", "litestream");
  if (!isExecutable(binPath)) {
    return { ok: false, skippedReason: "the litestream binary is not available in this environment" };
  }

  const configPath = env.LITESTREAM_CONFIG_PATH?.trim() || "/app/litestream.coolify.yml";
  if (!isReadable(configPath)) {
    return { ok: false, skippedReason: "the litestream config file is not readable in this environment" };
  }

  const missing = ["AWS_S3_BUCKET_NAME", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_S3_ENDPOINT"]
    .filter((name) => !String(env[name] ?? "").trim());
  if (missing.length > 0) {
    return { ok: false, skippedReason: `replica credentials are not present in this process (${missing.join(", ")})` };
  }

  return { ok: true, config: { binPath, configPath, dbPath: options.dbPath, levels: LITESTREAM_REMOTE_LEVELS } };
}

export interface LitestreamLtxContiguity {
  holeCount: number;
  twinCount: number;
  firstHole: LitestreamLtxFirstHole | null;
  suffixMinTxid: string | null;
  suffixFileCount: number;
}

interface LitestreamLtxRange {
  minTxid: string;
  maxTxid: string;
}

function emptyContiguity(): LitestreamLtxContiguity {
  return { holeCount: 0, twinCount: 0, firstHole: null, suffixMinTxid: null, suffixFileCount: 0 };
}

/**
 * Pure LTX-sequence shape analysis for one remote compaction level.
 *
 * Parses min_txid/max_txid, sorts by min, counts holes (next.min != prev.max+1) and twins
 * (same max, different min), and finds the newest contiguous suffix. Never intended for
 * level 0 (local-only); callers should not list level 0 here.
 */
export function analyzeLitestreamLtxContiguity(payload: unknown, level: number): LitestreamLtxContiguity {
  if (level === 0) return emptyContiguity();

  const entries = Array.isArray(payload) ? payload : [];
  const ranges: LitestreamLtxRange[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { level?: unknown; min_txid?: unknown; max_txid?: unknown };
    if (typeof record.level === "number" && record.level !== level) continue;
    if (typeof record.min_txid !== "string" || typeof record.max_txid !== "string") continue;
    ranges.push({
      minTxid: normalizeLitestreamTxid(record.min_txid),
      maxTxid: normalizeLitestreamTxid(record.max_txid)
    });
  }
  if (ranges.length === 0) return emptyContiguity();

  ranges.sort((a, b) => {
    const byMin = compareLitestreamTxid(a.minTxid, b.minTxid);
    if (byMin !== 0) return byMin;
    return compareLitestreamTxid(a.maxTxid, b.maxTxid);
  });

  // Collapse overlap peers into one effective range before gap detection. Litestream can
  // leave same-min (or otherwise contained/overlapping) compaction objects behind when a run
  // retried and kept the later range; range-wise successor comparison then reads the earlier
  // start as a hole even though the union remains contiguous. Twins (same max, different min)
  // are still counted separately because they mark dual-writer evidence without changing the
  // covered txid interval.
  const covered: LitestreamLtxRange[] = [];
  for (const range of ranges) {
    const prev = covered[covered.length - 1];
    if (prev && compareLitestreamTxid(range.minTxid, litestreamTxidSuccessor(prev.maxTxid)) <= 0) {
      if (compareLitestreamTxid(range.maxTxid, prev.maxTxid) > 0) prev.maxTxid = range.maxTxid;
      continue;
    }
    covered.push({ minTxid: range.minTxid, maxTxid: range.maxTxid });
  }

  let holeCount = 0;
  let twinCount = 0;
  let firstHole: LitestreamLtxFirstHole | null = null;
  for (let i = 1; i < ranges.length; i += 1) {
    const prev = ranges[i - 1]!;
    const cur = ranges[i]!;
    if (cur.maxTxid === prev.maxTxid && cur.minTxid !== prev.minTxid) {
      twinCount += 1;
    }
  }
  for (let i = 1; i < covered.length; i += 1) {
    const prev = covered[i - 1]!;
    const cur = covered[i]!;
    if (cur.minTxid !== litestreamTxidSuccessor(prev.maxTxid)) {
      holeCount += 1;
      if (!firstHole) {
        firstHole = { prevMaxTxid: prev.maxTxid, nextMinTxid: cur.minTxid };
      }
    }
  }

  // Newest contiguous suffix: walk backward from the tip over collapsed coverage, skipping
  // twin peers only when reporting the visible file count.
  let suffixStart = covered.length - 1;
  for (let i = covered.length - 1; i > 0; i -= 1) {
    const cur = covered[i]!;
    const prev = covered[i - 1]!;
    if (cur.minTxid === litestreamTxidSuccessor(prev.maxTxid)) {
      suffixStart = i - 1;
      continue;
    }
    break;
  }
  const suffix = covered.slice(suffixStart);
  const suffixMinTxid = suffix[0]?.minTxid ?? null;
  // File count still counts ORIGINAL files, not collapsed coverage: overlapping peers are
  // real objects in the replica (and real evidence) even though they cover one interval.
  const suffixFileCount = suffixMinTxid === null
    ? 0
    : ranges.filter((range) => compareLitestreamTxid(range.minTxid, suffixMinTxid) >= 0).length;

  return {
    holeCount,
    twinCount,
    firstHole,
    suffixMinTxid,
    suffixFileCount
  };
}

/**
 * Reduce one `litestream ltx -level N -json` payload to the newest file at that level.
 *
 * Pure and defensive: the JSON shape is Litestream's, not ours, so every field is re-validated
 * rather than trusted. Entries for other levels are ignored rather than silently merged.
 * Contiguity fields are additive (hole/twin/suffix); catchUpSpanTxids stays null here and is
 * attached on level 2 by collectLitestreamRemoteInventory when both tips are known.
 */
export function summarizeLitestreamLtxPayload(payload: unknown, level: number): LitestreamRemoteLevelSummary {
  const entries = Array.isArray(payload) ? payload : [];
  let newestAtMs = Number.NEGATIVE_INFINITY;
  let newestAt: string | null = null;
  let newestTxid: string | null = null;
  let fileCount = 0;

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { level?: unknown; max_txid?: unknown; timestamp?: unknown };
    if (typeof record.level === "number" && record.level !== level) continue;
    fileCount += 1;

    if (typeof record.timestamp === "string") {
      const parsed = Date.parse(record.timestamp);
      if (Number.isFinite(parsed) && parsed > newestAtMs) {
        newestAtMs = parsed;
        newestAt = new Date(parsed).toISOString();
        // Pair the txid with the newest timestamp rather than taking a global max, so the two
        // reported numbers always describe the same file.
        newestTxid = typeof record.max_txid === "string" ? record.max_txid.toLowerCase() : null;
      }
    }
  }

  const contiguity = analyzeLitestreamLtxContiguity(payload, level);

  // `fileCount` reports the entries actually counted, even when none carried a readable
  // timestamp. It used to be zeroed in that case (`newestAt ? fileCount : 0`), which let the
  // COLLECTOR manufacture the empty state out of a parse problem — and as of 2026-08-14
  // "successfully listed and empty" is a load-bearing measurement that
  // assessLitestreamTierFreshness draws a wedge verdict from. The count-without-timestamp shape
  // is now visible to it and classified as `remote-inventory-inconsistent`, not as emptiness.
  return {
    level,
    newestAt: newestAt ?? "",
    newestTxid,
    fileCount,
    holeCount: contiguity.holeCount,
    twinCount: contiguity.twinCount,
    firstHole: contiguity.firstHole,
    suffixMinTxid: contiguity.suffixMinTxid,
    catchUpSpanTxids: null
  };
}

function runLitestreamLtx(config: LitestreamRemoteInventoryConfig, level: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    // Every argument is a fixed literal or a resolved path — no caller-controlled input reaches
    // the argv, and `execFile` never invokes a shell.
    loadExecFile()(
      config.binPath,
      ["ltx", "-level", String(level), "-json", "-config", config.configPath, config.dbPath],
      { timeout: PER_LEVEL_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, encoding: "utf8", windowsHide: true },
      (error, stdout) => {
        if (error) {
          reject(new Error(error.message.split("\n")[0].slice(0, 200)));
          return;
        }
        const text = stdout.trim();
        if (!text) {
          resolve([]);
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch {
          reject(new Error("litestream ltx returned unparseable JSON"));
        }
      }
    );
  });
}

/** Collect every remote level once. Levels are listed sequentially so a refresh never
 *  opens four concurrent B2 listings from a process that also serves requests. */
export async function collectLitestreamRemoteInventory(options: {
  dbPath: string;
  env?: Readonly<Record<string, string | undefined>>;
  nowMs?: number;
}): Promise<LitestreamRemoteInventorySnapshot> {
  const collectedAt = new Date(options.nowMs ?? Date.now()).toISOString();
  const resolution = resolveLitestreamRemoteInventoryConfig({ dbPath: options.dbPath, env: options.env });
  if (!resolution.ok) {
    return { collectedAt, status: "skipped", levels: {}, levelErrors: {}, skippedReason: resolution.skippedReason };
  }

  const levels: Record<string, LitestreamRemoteLevelSummary> = {};
  const levelErrors: Record<string, string> = {};

  for (const level of resolution.config.levels) {
    try {
      const payload = await runLitestreamLtx(resolution.config, level);
      levels[String(level)] = summarizeLitestreamLtxPayload(payload, level);
    } catch (error) {
      levelErrors[String(level)] = error instanceof Error ? error.message : String(error);
    }
  }

  const l1 = levels["1"];
  const l2 = levels["2"];
  if (l1?.newestTxid && l2?.newestTxid) {
    levels["2"] = {
      ...l2,
      catchUpSpanTxids: litestreamCatchUpSpanTxids(l1.newestTxid, l2.newestTxid)
    };
  }

  const failed = Object.keys(levelErrors).length;
  const status = failed === 0 ? "ok" : failed === resolution.config.levels.length ? "failed" : "partial";
  return { collectedAt, status, levels, levelErrors, skippedReason: null };
}

// CORRECTION (2026-08-13): this used to claim "`next start` serves the scheduler and every API
// route from one process, so the reader and the writer are the same process" and kept the
// snapshot in a bare module-level variable on that basis. That assumption was false in
// production: Next's build gives the scheduler (reached via instrumentation.ts's register()) and
// the API route handlers SEPARATE instantiations of this module, each with its own
// `cachedInventory` binding, even though both run inside the same OS process. The writer's
// assignment and the reader's lookup were therefore never the same variable — proven by
// production `task_journal` evidence: the `litestream-remote-inventory` lane logged 932
// successful runs / 0 errors in 24h (the collector genuinely works), while `/api/health` reported
// `remoteInventoryState: "missing"` the entire time (the reader never saw any of them). See
// docs/rollouts/2026-08-13-durable-inventory-cache.md.
//
// Fix: `getLitestreamRemoteInventory` now reads the snapshot back from `durable_state`
// (src/lib/db-durable-state.ts) on every call, so any module instance / any process on the box
// sees the same row. `cachedInventory` remains as a same-process fallback for when the durable
// read itself fails (e.g. the DB is briefly unavailable) — it is NOT the source of truth.
//
// One consequence of moving to durable storage: the snapshot now survives a process restart
// (the app auto-deploys on every merge to main, so restarts are frequent) instead of resetting to
// "not collected yet". That is intentional, not a regression — a slightly-old-but-real snapshot
// beats manufacturing another few-minute "missing" window on every deploy, and it is never shown
// as fresher than it is: assessLitestreamTierFreshness (runtime-health.ts) ages any snapshot out
// past LITESTREAM_REMOTE_INVENTORY_MAX_AGE_SECONDS (90 minutes) into an explained
// "remote-inventory-stale", the same honest-state handling a slow collector already gets today.
//
// `lastAttemptAtMs` (the 30-minute collection gate) deliberately STAYS in-memory-only — see the
// comment on refreshLitestreamRemoteInventoryIfDue below for why that is safe.
const DURABLE_NAMESPACE = "litestream";
const DURABLE_INVENTORY_KEY = "remote-inventory";

let cachedInventory: LitestreamRemoteInventorySnapshot | null = null;
let lastAttemptAtMs = 0;

/** Writes through to durable storage (source of truth) and updates the same-process fallback. */
function persistLitestreamRemoteInventory(snapshot: LitestreamRemoteInventorySnapshot | null): void {
  cachedInventory = snapshot;
  try {
    if (snapshot === null) {
      deleteDurableStateValue(DURABLE_NAMESPACE, DURABLE_INVENTORY_KEY);
    } else {
      setDurableStateValue(DURABLE_NAMESPACE, DURABLE_INVENTORY_KEY, snapshot);
    }
  } catch (error) {
    // Best-effort: a durable-state write failing must not crash the collector or the caller.
    // The in-memory fallback above still has the latest value for THIS process, even if other
    // processes/module instances won't see it until the write succeeds.
    console.error("[litestream-remote-inventory] durable persist failed:", error instanceof Error ? error.message : error);
  }
}

export function getLitestreamRemoteInventory(): LitestreamRemoteInventorySnapshot | null {
  try {
    const persisted = getDurableStateValue<LitestreamRemoteInventorySnapshot>(DURABLE_NAMESPACE, DURABLE_INVENTORY_KEY);
    if (persisted !== undefined) return persisted;
  } catch (error) {
    console.error("[litestream-remote-inventory] durable read failed, falling back to in-process cache:", error instanceof Error ? error.message : error);
  }
  // Reached only when the durable row is genuinely absent (nothing collected yet anywhere) or
  // the read itself failed — in both cases the in-process value (real if THIS process is the
  // one that collected it, null otherwise) is the best available answer.
  return cachedInventory;
}

/** Test/refresh seam — lets route tests prime a snapshot (and clear it) without spawning
 *  anything. Also the single write path production code uses; see
 *  refreshLitestreamRemoteInventoryIfDue below. */
export function setLitestreamRemoteInventoryCache(snapshot: LitestreamRemoteInventorySnapshot | null): void {
  persistLitestreamRemoteInventory(snapshot);
}

export function resetLitestreamRemoteInventoryCadence(): void {
  lastAttemptAtMs = 0;
}

export interface LitestreamRemoteInventoryRunResult {
  ran: boolean;
  status: LitestreamRemoteInventorySnapshot["status"] | "not-due";
}

/**
 * Scheduler entry point. Cadence-gated, self-guarded, and never throws into the tick.
 *
 * Deliberately NOT leader-gated: there is one production container, so there is only ever one
 * scheduler tick loop to begin with — nothing to elect a leader among.
 *
 * `lastAttemptAtMs` (and the `cachedInventory`-derived ok-vs-retry interval above) deliberately
 * STAY in-memory-only rather than moving to durable_state alongside the snapshot itself. That is
 * safe, not an oversight: this function is only ever called from src/lib/scheduler.ts's `tick()`,
 * which itself only ever runs from the ONE `setInterval` callback `startScheduler()` registers —
 * the same closure, over the same module instance's `lastAttemptAtMs`/`cachedInventory`
 * bindings, for the entire life of the process. There is no second writer instance for this
 * cadence gate to lose track of, unlike the snapshot itself, which genuinely does need to cross
 * module instances to reach the API routes. Production evidence backs this: the
 * `litestream-remote-inventory` lane fired on every ~63s scheduler tick (932 runs/24h) but only
 * ran the real (multi-second, B2-listing) collection 32 times — matching the 30-minute cadence
 * exactly, which is only possible if `lastAttemptAtMs` held its value correctly across all 932
 * ticks. Making this durable would add a DB round trip to every tick for no correctness gain,
 * and risks the opposite failure this file's cost comment warns about: a debounced durable write
 * that hasn't landed yet by the next ~60s tick could make the gate re-fire far more often than
 * every 30 minutes, turning ~430 B2 LIST calls/day into tens of thousands.
 */
export async function refreshLitestreamRemoteInventoryIfDue(options: {
  dbPath?: string;
  env?: Readonly<Record<string, string | undefined>>;
  nowMs?: number;
} = {}): Promise<LitestreamRemoteInventoryRunResult> {
  const nowMs = options.nowMs ?? Date.now();
  const intervalMs = cachedInventory && cachedInventory.status === "ok"
    ? LITESTREAM_REMOTE_INVENTORY_INTERVAL_MS
    : LITESTREAM_REMOTE_INVENTORY_RETRY_INTERVAL_MS;
  if (lastAttemptAtMs !== 0 && nowMs - lastAttemptAtMs < intervalMs) {
    return { ran: false, status: "not-due" };
  }
  lastAttemptAtMs = nowMs;

  let dbPath = options.dbPath;
  if (!dbPath) {
    const { databasePath } = await import("./db");
    dbPath = databasePath();
  }

  try {
    const snapshot = await collectLitestreamRemoteInventory({ dbPath, env: options.env, nowMs });
    // Persists durably (source of truth for every reader) and updates the same-process fallback.
    persistLitestreamRemoteInventory(snapshot);
    return { ran: true, status: snapshot.status };
  } catch (error) {
    // A total failure must not wipe the previous snapshot: stale-but-labelled data is more
    // useful than none, and assessLitestreamTierFreshness ages it out on its own. Not calling
    // persistLitestreamRemoteInventory here is exactly what preserves that — neither the
    // in-memory fallback nor the durable row are touched.
    console.error("[litestream-remote-inventory] collection failed:", error);
    return { ran: true, status: "failed" };
  }
}
