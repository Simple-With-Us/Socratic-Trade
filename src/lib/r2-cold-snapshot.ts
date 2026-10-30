// r2-cold-snapshot.ts — weekly cold snapshot of the production SQLite DB to Cloudflare R2.
//
// Owner directive (2026-08-08): with litestream's active replica moved to Backblaze B2
// (PR #2584), the R2 bucket sits idle — use it intelligently as SECOND-PROVIDER disaster
// recovery. Once a week (Sunday ~03:17 UTC, staggered off the top of the hour), take a
// consistent better-sqlite3 `backup()` of the live DB to a temp file, stream it through
// gzip, and multipart-upload the compressed stream to the historic R2 bucket under
// `cold-snapshots/app-<ISO-date>.db.gz`, then prune to the newest N (default 1) snapshots
// across BOTH extensions (`.db` legacy raw uploads and `.db.gz`).
//
// Gzip (2026-08-31, PR #3135): the raw DB reached ~9.7 GB, putting one uncompressed
// weekly copy at ~90% of the 10 GiB R2 free tier.  The upload now streams the backup
// file through node zlib createGzip into sequential multipart parts — memory stays
// bounded at roughly one part (default 100 MB) plus zlib buffers, never the whole file
// (the box has 16 GB of SHARED RAM).  Expected compressed size ~2.5-4 GB.  No
// compression knob — always gzip.  RESTORE now needs a gunzip step first: download the
// `.db.gz`, `gunzip` it, then treat the result exactly like the old raw `.db` snapshot
// (see docs/litestream.md).
//
// Skip-prune (opt-in only): `R2_COLD_SNAPSHOT_SKIP_PRUNE=1` bypasses the entire
// retention pass — leave it UNSET for normal Sunday jobs.  Default retain is 3
// (`R2_COLD_SNAPSHOT_DEFAULT_RETAIN`); the prune pass then keeps the newest N
// across `.db` + `.db.gz`.  Agents must never DeleteObject against this bucket
// outside the automated retention pass without Jay approval.
//
// Budget stance: stays reliably far under the R2 free tier. One weekly run costs roughly
// 30-45 Class A ops (create + ~25-40 compressed parts at 100 MB + complete + list + up to
// a couple deletes) ≈ 200/month vs the 1M free-tier allowance; storage is
// retain×compressed-size.  Default retain is 3 (ceiling `R2_COLD_SNAPSHOT_MAX_RETAIN`).
// The retention pass counts + prunes both `.db` and `.db.gz`.  Host-verified notes
// from 2026-08-18 (pre-gzip, retain=1) are historical.  `R2_ARCHIVE_KEEP_GENERATIONS`
// is unused leftover (empty `weekly/` prefix) and must not drive this lane.
// Do not delete live R2 objects from agents.  A budget guard refuses
// to run at all when the r2-usage monitor's latest ST snapshot shows month-to-date Class A
// ops above 50% of the free tier. The R2 free-tier kill-switch in r2-usage.ts is untouched
// (it is gated to litestream's endpoint being R2, which it no longer is).
//
// Scheduling: a durable weekly due-job (db-jobs.ts, job_type "r2_cold_snapshot") rather
// than an in-process interval — the snapshot survives process downtime: if the box is down
// over Sunday 03:17 UTC, the pending job is claimed on the next scheduler tick after boot.
// The scheduler tick both (a) ensures the next weekly job exists (idempotent via dedupe
// key) and (b) drains due jobs.
//
// Gating: silently a no-op (with ONE audit row per distinct reason) unless the
// AWS_R2_HISTORIC_* credentials + bucket + endpoint from PR #2584 are configured.
// R2_COLD_SNAPSHOT_ENABLED=0/off/false/no is the explicit kill switch.
// R2_COLD_SNAPSHOT_SKIP_PRUNE=1/true/on/yes is the opt-in freshen gate (default off).
//
// Snapshot mechanism (2026-09-08, CLAUDE): `VACUUM INTO` in a short-lived CHILD PROCESS,
// NOT better-sqlite3 `backup()`.  Root cause of the 9-day archive stall: SQLite's online
// backup API restarts from page 1 whenever the source DB is modified through a DIFFERENT
// connection (sqlite3_backup_step -> SQLITE_BUSY/restart).  app.db is written continuously
// by the live trading app AND checkpointed by litestream, so on a ~10.7 GB DB the copy can
// never outrun the writers.  Production evidence 2026-09-08: the temp backup file sat at
// exactly 5666406400 bytes across three samples 8 minutes apart while its mtime advanced
// every few seconds, and `week-2026-09-06` reached attempts=27 with `last_error` NULL and
// ZERO `r2_cold_snapshot.error`/`.success` audit rows — it hung, it never failed.  Locally
// reproduced on better-sqlite3 13.0.3 (the production version): 2698 restarts in 15s with
// remainingPages pinned at 10601/10701.  `VACUUM INTO` runs inside ONE read transaction, so
// concurrent writers cannot restart it; it also emits a COMPACTED copy (smaller upload).  It
// is synchronous and would block the event loop for minutes, so it runs in a child process
// spawned with a MINIMAL env (no secrets) and is killed at the deadline below.
//
// Deadline: every snapshot attempt is bounded by R2_COLD_SNAPSHOT_DEADLINE_MIN (default 45,
// well under the 2h job lease) so a stuck snapshot FAILS LOUDLY instead of hanging until the
// lease expires and the next drain silently restarts it.  Bounding the attempt below the
// lease also stops overlapping attempts from piling up inside one process lifetime (each
// attempt's start-of-run sweep unlinks the previous attempt's temp file while that attempt
// still holds the fd — invisible multi-GB disk usage).
//
// Failure: audited, surfaced once via the existing storage_warning notification path
// (db-health.ts alertStorageWarning — 12h per-warning-type cooldown) AND as a Sentry
// structured log, then retried with due-job backoff. Never throws into the scheduler tick.
//
// Freshness watchdog: `reportR2WeeklyFreshness()` (called from the scheduler lane) watches
// the SAME `checks.storage.r2Weekly` state the public health endpoint publishes and emits
// ONE Sentry event per state TRANSITION (ok <-> archive_stale/archive_not_run), persisted in
// an internal setting.  Before this, nothing watched that field: the archive went stale on
// 2026-09-06 and was still silent 9 days later.

// Bare "fs"/"os"/"path" (not the "node:" scheme) so Next.js webpack can externalize this
// module for server bundles — same trap as r2-usage.ts / egress-guard.
import { spawn } from "child_process";
import crypto from "crypto";
import { createReadStream, existsSync, readdirSync, statSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import { createGzip } from "zlib";
import { audit, databasePath } from "./db";
import { getInternalSetting, setInternalSetting } from "./db-settings";
import {
  claimDueJobs,
  completeDueJob,
  enqueueDueJob,
  failDueJob,
  getDueJobStats,
} from "./db-jobs";
import { getR2UsageSnapshots, R2_FREE_TIER } from "./r2-usage";
import { logError, logWarn } from "./sentry-metrics";

// ── Constants ────────────────────────────────────────────────────────────────

export const R2_COLD_SNAPSHOT_JOB_TYPE = "r2_cold_snapshot";
export const R2_COLD_SNAPSHOT_PREFIX = "cold-snapshots/";
/** Weekly slot: Sunday, 03:17 UTC (staggered off the top of the hour so it never
 *  stampedes with other fleet crons that fire at :00). */
export const R2_COLD_SNAPSHOT_UTC_DAY = 0; // Sunday
export const R2_COLD_SNAPSHOT_UTC_HOUR = 3;
export const R2_COLD_SNAPSHOT_UTC_MINUTE = 17;
/**
 * Weekly retain — how many cold-archive objects the prune pass keeps.
 *
 * Was 1 until 2026-09-09.  Depth ONE means the archive tier has no history at all:
 * a single object IS the entire second-provider archive, so any fault that reaches it
 * (a bad prune, a torn upload, an operator mistake, a corruption that only surfaces on
 * restore) takes cold coverage straight to zero with nothing behind it.  Verified live
 * 2026-09-09 via the Cloudflare R2 analytics API: `socratic-trade-bucket`
 * `objectCount=1`, `payloadSize=9679310848`, sole key `cold-snapshots/app-2026-08-30.db`.
 *
 * The 1 was a FREE-TIER cap and that constraint no longer applies: paid R2 is enabled on
 * the SocraticTrade.com account (`r2_paid`, state `Paid`).  Jay 2026-10-29: keep the
 * newest three gzipped weeklies (~3 GB each, ~9 GB) — three weeks of archive history,
 * matching the privacy-policy copy (`WEEKLY_BACKUP_RETENTION_WEEKS` in legal-notice.ts).
 */
export const R2_COLD_SNAPSHOT_DEFAULT_RETAIN = 3;
/**
 * Ceiling on `R2_COLD_SNAPSHOT_RETAIN`.  Before 2026-09-09 the clamp was
 * `min(env, DEFAULT_RETAIN)` — the env var could only ever LOWER retention and any
 * attempt to raise it was silently ignored, which is part of why depth stayed at 1 after
 * paid R2 landed.  A ceiling still guards a fat-fingered env from pinning hundreds of
 * multi-GB objects, but it no longer contradicts the knob it clamps.
 */
export const R2_COLD_SNAPSHOT_MAX_RETAIN = 12;
export const R2_COLD_SNAPSHOT_DEFAULT_PART_BYTES = 100 * 1024 * 1024; // 100 MB parts
/** S3 floor for every part except the last. */
export const R2_COLD_SNAPSHOT_MIN_PART_BYTES = 5 * 1024 * 1024;
/** Refuse to run when the ST account's month-to-date Class A ops exceed this share
 *  of the free tier (read from the r2-usage monitor's persisted snapshot). */
export const R2_COLD_SNAPSHOT_BUDGET_GUARD_PCT = 50;

/** Hard bound on the SNAPSHOT STEP (the step that hung for 9 days).  Must stay well
 *  under the 2h due-job lease so an attempt can never outlive its own claim. */
export const R2_COLD_SNAPSHOT_DEFAULT_DEADLINE_MS = 45 * 60_000;
/**
 * Hard bound on the WHOLE attempt — snapshot + gzip + multipart upload + prune.
 *
 * #3192 bounded only the snapshot step, on the evidence available at the time.  The very
 * first run under that fix (2026-09-08T15:36Z) proved the gap: the snapshot completed and
 * the run then died in the UPLOAD after 670 s with a bare `fetch failed`.  A hung upload
 * had (and, without this, still has) no bound at all short of the 2 h lease expiring —
 * which is the exact silent-restart shape #3192 set out to end.  Every phase is now
 * inside a deadline, and the deadline aborts in-flight S3 requests rather than merely
 * abandoning them.  Still under the 2 h lease.
 */
export const R2_COLD_SNAPSHOT_DEFAULT_ATTEMPT_DEADLINE_MS = 90 * 60_000;
/**
 * The due-job lease `drainR2ColdSnapshotJobs` claims with.  Exported so the attempt deadline
 * can be clamped against it rather than relying on a comment saying it "must stay" below.
 */
export const R2_COLD_SNAPSHOT_LEASE_MS = 120 * 60_000;
/**
 * Hard ceiling on the attempt deadline: the lease minus a margin.  An attempt allowed to run
 * to or past its own lease is the exact overlap the deadline exists to prevent — the next
 * drain reclaims the job, starts a second multi-GB snapshot, sweeps the first attempt's temp
 * file out from under its open fd, and races an upload to the same weekly key.  A config
 * value above this is clamped, not honoured (flagged in review of PR #3204).
 */
export const R2_COLD_SNAPSHOT_MAX_ATTEMPT_DEADLINE_MS = R2_COLD_SNAPSHOT_LEASE_MS - 15 * 60_000;
/** Bounded retries for a single S3 request before the attempt gives up.  One transient
 *  `fetch failed` on one 100 MB part used to discard the entire ~11-minute run. */
export const R2_COLD_SNAPSHOT_REQUEST_ATTEMPTS = 3;
/** How long the failure path waits for an in-flight CreateMultipartUpload to settle so it can
 *  abort the upload it minted.  Short on purpose — see the call site. */
export const R2_COLD_SNAPSHOT_CLEANUP_SETTLE_MS = 10_000;

/**
 * Tables the snapshot self-check asserts are non-empty before the artifact is uploaded.
 * Deliberately the money-and-state ones, not everything: audit history, proposed trades,
 * portfolio history, broker links, and configuration.  Row counts verified present in
 * production 2026-09-09 (audit_events 360059, trade_proposals 831, portfolio_snapshots
 * 1877, connected_accounts 7, settings 937, llm_usage 2989).
 */
export const R2_COLD_SNAPSHOT_VERIFY_TABLES = [
  "audit_events",
  "trade_proposals",
  "portfolio_snapshots",
  "connected_accounts",
  "settings",
  "llm_usage",
] as const;

/** What the snapshot child reports back about the copy it just made. */
export interface R2ColdSnapshotVerification {
  /** `PRAGMA integrity_check` said `ok` on the copy. */
  ok: boolean;
  /** Raw `PRAGMA integrity_check` first row, for the audit trail. */
  integrity: string | null;
  /** Row counts read from the COPY. */
  tables: Record<string, number | null>;
  /** Row counts read from the LIVE database moments before the copy was taken. */
  live: Record<string, number | null>;
}

const DISABLED_AUDIT_KEY = "r2coldsnap:disabledAuditedReason";
/** Last `checks.storage.r2Weekly` state reported to Sentry — transitions only, not ticks. */
export const R2_COLD_SNAPSHOT_HEALTH_STATE_KEY = "r2coldsnap:lastHealthState";
/** Persisted after every successful weekly upload — health reads this, never R2. */
export const R2_COLD_SNAPSHOT_LAST_SUCCESS_KEY = "r2coldsnap:lastSuccess";
/** Last failure (observability only; does not alone fail health). */
export const R2_COLD_SNAPSHOT_LAST_FAILURE_KEY = "r2coldsnap:lastFailure";
/**
 * Max age of the last successful cold snapshot for `checks.storage.r2Weekly.ok`.
 * Matches Usage Monitor `R2_ARCHIVE_MAX_AGE_SECONDS` (weekly job + one-day slack).
 */
export const R2_ARCHIVE_MAX_AGE_SECONDS = 8 * 24 * 3600;
/** Matches both the current gzipped uploads and legacy raw `.db` uploads so the
 *  retention pass counts + prunes across both extensions (retain=1 semantics). */
const KEY_PATTERN = /^cold-snapshots\/app-\d{4}-\d{2}-\d{2}\.db(\.gz)?$/;

export interface R2ColdSnapshotLastSuccess {
  key: string;
  completedAt: string;
  /** Uploaded object size (gzip-compressed as of 2026-08-31). */
  bytes: number;
  /** Uncompressed backup size (absent on receipts written before gzip landed). */
  rawBytes?: number;
  /** `PRAGMA integrity_check` result on the artifact before upload (2026-09-09 onward).
   *  Absent on receipts written before pre-upload verification landed. */
  verifiedIntegrity?: string | null;
  /** Key-table row counts in the uploaded copy, so "what was in that backup" is answerable
   *  without downloading 3 GB. */
  verifiedTables?: Record<string, number | null>;
}

export interface R2ColdSnapshotLastFailure {
  key: string | null;
  failedAt: string;
  reason: string;
}

/**
 * Public-safe shape for `checks.storage.r2Weekly` on GET /api/health.
 * No credentials, bucket names, or endpoints — object key + age only.
 */
export interface R2WeeklyHealthStatus {
  ok: boolean;
  ageSeconds: number | null;
  key: string | null;
  reason: "archive_stale" | "archive_not_run" | null;
}

/**
 * Cheap local reader for the weekly R2 cold-snapshot lane. Reads only the
 * internal setting written on success — never performs S3/R2 network I/O.
 * `ok` is true when the last success is within {@link R2_ARCHIVE_MAX_AGE_SECONDS}
 * (8 days). A failed week does not flip `ok` false while the prior success is
 * still inside that window (observability only; not folded into storageDegraded).
 */
export function getR2WeeklyHealthStatus(nowMs: number = Date.now()): R2WeeklyHealthStatus {
  try {
    const last = getInternalSetting<R2ColdSnapshotLastSuccess>(R2_COLD_SNAPSHOT_LAST_SUCCESS_KEY);
    if (!last || typeof last.key !== "string" || !last.key || typeof last.completedAt !== "string") {
      return { ok: false, ageSeconds: null, key: null, reason: "archive_not_run" };
    }
    const completedMs = Date.parse(last.completedAt);
    if (!Number.isFinite(completedMs)) {
      return { ok: false, ageSeconds: null, key: null, reason: "archive_not_run" };
    }
    const ageSeconds = Math.max(0, Math.floor((nowMs - completedMs) / 1000));
    if (ageSeconds > R2_ARCHIVE_MAX_AGE_SECONDS) {
      return { ok: false, ageSeconds, key: last.key, reason: "archive_stale" };
    }
    return { ok: true, ageSeconds, key: last.key, reason: null };
  } catch {
    return { ok: false, ageSeconds: null, key: null, reason: "archive_not_run" };
  }
}

// ── Config ───────────────────────────────────────────────────────────────────

export interface R2ColdSnapshotConfig {
  enabled: boolean;
  /** Why the lane is off (only when !enabled). */
  disabledReason?: "kill_switch" | "missing_credentials";
  bucket: string;
  /** Endpoint host, protocol stripped (e.g. <account>.r2.cloudflarestorage.com). */
  host: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  retain: number;
  partSizeBytes: number;
  /**
   * Opt-in: upload the new `.db.gz` but skip the entire retention pass.
   * Default false — leave unset so retain=N prune applies.  Do not set
   * `R2_COLD_SNAPSHOT_SKIP_PRUNE=1` for normal Sunday jobs.
   */
  skipPrune: boolean;
  /** Hard bound on the snapshot step, from `R2_COLD_SNAPSHOT_DEADLINE_MIN`. */
  snapshotDeadlineMs: number;
  /** Hard bound on the WHOLE attempt (snapshot + upload + prune), from
   *  `R2_COLD_SNAPSHOT_ATTEMPT_DEADLINE_MIN`. */
  attemptDeadlineMs: number;
}

/**
 * Env names follow PR #2584's convention: the R2 credentials preserved when litestream's
 * active replica moved to B2 live as AWS_R2_HISTORIC_* (Infisical + .env.example).
 * Default ON only when the full credential set exists; R2_COLD_SNAPSHOT_ENABLED is the
 * explicit kill switch (off/false/0/no).
 * Weekly retain reads only `R2_COLD_SNAPSHOT_RETAIN` (unset → default 3).
 * `R2_ARCHIVE_KEEP_GENERATIONS` is unused leftover and is not consulted.
 * `R2_COLD_SNAPSHOT_SKIP_PRUNE` is opt-in (1/true/on/yes); default is prune.
 */
export function r2ColdSnapshotSkipPruneFromEnv(
  raw: string | undefined = process.env.R2_COLD_SNAPSHOT_SKIP_PRUNE,
): boolean {
  const v = raw?.trim().toLowerCase() ?? "";
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export function loadR2ColdSnapshotConfig(): R2ColdSnapshotConfig {
  const bucket = process.env.AWS_R2_HISTORIC_BUCKET_NAME?.trim() ?? "";
  const endpoint = process.env.AWS_R2_HISTORIC_ENDPOINT?.trim() ?? "";
  const region = process.env.AWS_R2_HISTORIC_REGION?.trim() || "auto";
  const accessKeyId = process.env.AWS_R2_HISTORIC_ACCESS_KEY_ID?.trim() ?? "";
  const secretAccessKey = process.env.AWS_R2_HISTORIC_SECRET_ACCESS_KEY?.trim() ?? "";
  const retainRaw = Number(process.env.R2_COLD_SNAPSHOT_RETAIN ?? "");
  const requestedRetain =
    Number.isFinite(retainRaw) && retainRaw >= 1 ? Math.floor(retainRaw) : R2_COLD_SNAPSHOT_DEFAULT_RETAIN;
  // Ceiling, not a cap-to-default: the env may raise retention up to MAX_RETAIN as well as
  // lower it.  Clamping to DEFAULT_RETAIN made the env var write-only in the up direction.
  const retain = Math.min(requestedRetain, R2_COLD_SNAPSHOT_MAX_RETAIN);
  const partMbRaw = Number(process.env.R2_COLD_SNAPSHOT_PART_MB ?? "");
  const partSizeBytes =
    Number.isFinite(partMbRaw) && partMbRaw * 1024 * 1024 >= R2_COLD_SNAPSHOT_MIN_PART_BYTES
      ? Math.floor(partMbRaw * 1024 * 1024)
      : R2_COLD_SNAPSHOT_DEFAULT_PART_BYTES;

  const deadlineMinRaw = Number(process.env.R2_COLD_SNAPSHOT_DEADLINE_MIN ?? "");
  const snapshotDeadlineMsRaw =
    Number.isFinite(deadlineMinRaw) && deadlineMinRaw > 0
      ? Math.floor(deadlineMinRaw * 60_000)
      : R2_COLD_SNAPSHOT_DEFAULT_DEADLINE_MS;

  const attemptMinRaw = Number(process.env.R2_COLD_SNAPSHOT_ATTEMPT_DEADLINE_MIN ?? "");
  const attemptDeadlineMs = Math.min(
    Number.isFinite(attemptMinRaw) && attemptMinRaw > 0
      ? Math.floor(attemptMinRaw * 60_000)
      : R2_COLD_SNAPSHOT_DEFAULT_ATTEMPT_DEADLINE_MS,
    R2_COLD_SNAPSHOT_MAX_ATTEMPT_DEADLINE_MS,
  );

  const killRaw = process.env.R2_COLD_SNAPSHOT_ENABLED?.trim().toLowerCase();
  const killed = killRaw === "0" || killRaw === "off" || killRaw === "false" || killRaw === "no";
  const hasCreds = Boolean(bucket && endpoint && accessKeyId && secretAccessKey);
  const skipPrune = r2ColdSnapshotSkipPruneFromEnv();

  // A snapshot step allowed to outlive the whole attempt is a child that keeps running after
  // the parent has already given up on it.
  const snapshotDeadlineMs = Math.min(snapshotDeadlineMsRaw, attemptDeadlineMs);

  return {
    enabled: hasCreds && !killed,
    disabledReason: killed ? "kill_switch" : hasCreds ? undefined : "missing_credentials",
    bucket,
    host: endpoint.replace(/^https?:\/\//, "").replace(/\/+$/, ""),
    region,
    accessKeyId,
    secretAccessKey,
    retain,
    partSizeBytes,
    skipPrune,
    snapshotDeadlineMs,
    attemptDeadlineMs,
  };
}

// ── Pure helpers (exported for tests) ────────────────────────────────────────

/** Next Sunday 03:17 UTC strictly after `nowMs`, plus the per-week dedupe key. */
export function nextR2ColdSnapshotDueAt(nowMs: number): { dueAtISO: string; dedupeKey: string } {
  const now = new Date(nowMs);
  const candidate = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    R2_COLD_SNAPSHOT_UTC_HOUR,
    R2_COLD_SNAPSHOT_UTC_MINUTE,
    0,
    0,
  ));
  const daysUntilSunday = (R2_COLD_SNAPSHOT_UTC_DAY - candidate.getUTCDay() + 7) % 7;
  candidate.setUTCDate(candidate.getUTCDate() + daysUntilSunday);
  if (candidate.getTime() <= nowMs) candidate.setUTCDate(candidate.getUTCDate() + 7);
  const dueAtISO = candidate.toISOString();
  return { dueAtISO, dedupeKey: `week-${dueAtISO.slice(0, 10)}` };
}

/**
 * Retention: given a bucket listing, return the cold-snapshot keys to DELETE so only the
 * newest `retain` remain. Counts BOTH extensions: only keys matching our exact
 * `cold-snapshots/app-YYYY-MM-DD.db` or `...db.gz` pattern are ever candidates — historic
 * litestream objects (different prefix/shape) can never be pruned by this lane. Snapshot
 * keys embed the ISO date, so lexical sort == chronological sort (a same-date `.db.gz`
 * sorts after its `.db` twin, i.e. the gzipped upload is treated as newer). This is what
 * prunes the last legacy raw `.db` object after the first successful `.gz` upload. Pure.
 */
export function selectColdSnapshotsToPrune(keys: readonly string[], retain: number): string[] {
  const snapshots = keys.filter((k) => KEY_PATTERN.test(k)).sort().reverse();
  return snapshots.slice(Math.max(1, retain));
}

/** The r2-usage monitor's latest month-to-date Class A percentage for the Socratic
 *  Trade account, or null when the monitor has no snapshot (guard then defers). */
export function r2ColdSnapshotClassAPct(): number | null {
  try {
    const snaps = getR2UsageSnapshots();
    const st = snaps.find((s) => s.accountLabel === "Socratic Trade") ?? (snaps.length === 1 ? snaps[0] : undefined);
    const classA = st?.metrics.find((m) => m.id === "classA");
    return classA && Number.isFinite(classA.pctUsed) ? classA.pctUsed : null;
  } catch {
    return null;
  }
}

// ── Minimal S3 SigV4 (modeled on market-signals/massive-s3.ts, extended with
//    query strings + request bodies for multipart/list/delete) ────────────────

const sha256hex = (data: string | Buffer): string => crypto.createHash("sha256").update(data).digest("hex");
const hmac = (key: crypto.BinaryLike, s: string): Buffer => crypto.createHmac("sha256", key).update(s).digest();

export interface R2ColdSnapshotDeps {
  fetchImpl?: typeof fetch;
  /**
   * Test seam for the consistent-snapshot step.  Default: `VACUUM INTO` in a child
   * process (see {@link runVacuumIntoSnapshot}) — NOT better-sqlite3 `backup()`, which
   * cannot converge against a concurrently written DB.
   */
  backupImpl?: (destPath: string) => Promise<unknown>;
  /**
   * Test seam for the pre-upload artifact check.  In production this is unset: the default
   * VACUUM child reports its own verification, and anything that does NOT (a `backupImpl`
   * seam, or a future alternative copy mechanism) falls back to a real verification child.
   * "Reached the upload unverified" is deliberately not a reachable state.
   */
  verifyImpl?: (destPath: string) => Promise<R2ColdSnapshotVerification | null>;
  /** Test seam for the per-attempt snapshot deadline (production uses config). */
  snapshotDeadlineMs?: number;
  /** Test seam for the whole-attempt deadline (production uses config). */
  attemptDeadlineMs?: number;
  /** Test seam for the storage_warning advisory (db-health.alertStorageWarning). */
  alertImpl?: (warningType: string, message: string) => Promise<void>;
  /** Test seam for small multipart parts (production uses config partSizeBytes). */
  partSizeBytes?: number;
  /**
   * Set by `performR2ColdSnapshot` from the whole-attempt deadline and threaded into every
   * S3 request.  Once it fires, in-flight uploads ABORT rather than being abandoned to run
   * on past the deadline against a job whose lease has moved on.
   */
  abortSignal?: AbortSignal;
  /** Test seam: number of tries per S3 request (production uses the constant). */
  requestAttempts?: number;
  /** Test seam: delay between S3 request retries (production backs off; tests pass 0). */
  retryDelayMs?: number;
}

/**
 * Node's `fetch` collapses every transport failure — DNS, TLS, RST, socket timeout — into
 * the single opaque message `fetch failed`, and puts the real reason in `error.cause`.
 * Production 2026-09-08T15:47:24Z recorded exactly `"fetch failed"` and nothing else, so
 * the upload failure that killed the first post-#3192 run could not be classified at all.
 * Unwrap the cause chain so the audit row, the Sentry event, and `lastFailure` all carry
 * something an operator can act on.
 */
export function describeRequestError(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current; depth++) {
    const e = current as { message?: unknown; code?: unknown; name?: unknown; cause?: unknown };
    const label = typeof e.message === "string" && e.message ? e.message : String(e.name ?? "");
    const code = typeof e.code === "string" && e.code ? ` (${e.code})` : "";
    if (label) parts.push(`${label}${code}`);
    current = e.cause;
  }
  return parts.length > 0 ? parts.join(" <- ") : String(err);
}

/** Non-2xx HTTP that S3/R2 will never answer differently on a retry. */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Retry one S3 request a bounded number of times.  Before this, a single transient
 * `fetch failed` on any one of ~30 parts discarded the whole attempt — including the
 * ~11 minutes of `VACUUM INTO` that produced the artifact — and burned a due-job attempt.
 * Aborts immediately (no retry) once the whole-attempt deadline has fired.
 */
async function withS3Retry(
  label: string,
  deps: R2ColdSnapshotDeps,
  run: () => Promise<S3Response>,
): Promise<S3Response> {
  const tries = Math.max(1, deps.requestAttempts ?? R2_COLD_SNAPSHOT_REQUEST_ATTEMPTS);
  const baseDelay = deps.retryDelayMs ?? 2_000;
  let lastError: unknown;
  for (let attempt = 1; attempt <= tries; attempt++) {
    if (deps.abortSignal?.aborted) {
      throw new Error(`${label}: attempt deadline exceeded before request`);
    }
    try {
      const res = await run();
      if (res.ok || !isRetryableStatus(res.status)) return res;
      lastError = new Error(`${label} HTTP ${res.status}`);
      if (attempt === tries) return res;
    } catch (err) {
      lastError = err;
      // A deadline abort is terminal: retrying cannot help and would outlive the lease.
      if (deps.abortSignal?.aborted || attempt === tries) {
        throw new Error(`${label} failed after ${attempt} attempt(s): ${describeRequestError(err)}`);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, baseDelay * attempt));
  }
  throw new Error(`${label} failed: ${describeRequestError(lastError)}`);
}

interface S3Response {
  status: number;
  ok: boolean;
  etag: string | null;
  contentLength: number | null;
  body: string;
}

async function s3Request(
  cfg: R2ColdSnapshotConfig,
  method: string,
  key: string | null,
  query: Record<string, string>,
  body: Buffer | null,
  deps: R2ColdSnapshotDeps,
  timeoutMs: number,
): Promise<S3Response> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ""); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);
  const segments = key === null ? [cfg.bucket] : [cfg.bucket, ...key.split("/")];
  const canonicalUri = "/" + segments.map(encodeURIComponent).join("/");
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`)
    .join("&");
  const payloadHash = sha256hex(body ?? "");
  const canonicalHeaders = `host:${cfg.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = `${method}\n${canonicalUri}\n${canonicalQuery}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const scope = `${dateStamp}/${cfg.region}/s3/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256hex(canonicalRequest)}`;
  const signingKey = hmac(hmac(hmac(hmac("AWS4" + cfg.secretAccessKey, dateStamp), cfg.region), "s3"), "aws4_request");
  const signature = crypto.createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const url = `https://${cfg.host}${canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ""}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  // Per-request timeout OR the whole-attempt deadline, whichever fires first.  Without the
  // second one an upload that outlived the attempt deadline kept running against a job whose
  // lease had already been handed to the next drain.
  const signal = deps.abortSignal
    ? AbortSignal.any([controller.signal, deps.abortSignal])
    : controller.signal;
  try {
    const res = await fetchImpl(url, {
      method,
      cache: "no-store",
      signal,
      headers: {
        Authorization: authorization,
        "x-amz-content-sha256": payloadHash,
        "x-amz-date": amzDate,
      },
      // Uint8Array view keeps undici happy across Node Buffer/BodyInit typings.
      body: body ? new Uint8Array(body) : undefined,
    });
    const text = await res.text();
    const cl = res.headers.get("content-length");
    const contentLength = cl != null && cl !== "" && Number.isFinite(Number(cl)) ? Number(cl) : null;
    return { status: res.status, ok: res.ok, etag: res.headers.get("etag"), contentLength, body: text };
  } finally {
    clearTimeout(timeout);
  }
}

const CONTROL_TIMEOUT_MS = 60_000;
const PART_TIMEOUT_MS = 15 * 60_000; // 100 MB per part on a modest uplink

async function createMultipartUpload(cfg: R2ColdSnapshotConfig, key: string, deps: R2ColdSnapshotDeps): Promise<string> {
  const res = await withS3Retry("CreateMultipartUpload", deps, () =>
    s3Request(cfg, "POST", key, { uploads: "" }, null, deps, CONTROL_TIMEOUT_MS),
  );
  if (!res.ok) throw new Error(`CreateMultipartUpload HTTP ${res.status}: ${res.body.slice(0, 200)}`);
  const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(res.body)?.[1];
  if (!uploadId) throw new Error("CreateMultipartUpload: no UploadId in response");
  return uploadId;
}

async function uploadPart(
  cfg: R2ColdSnapshotConfig,
  key: string,
  uploadId: string,
  partNumber: number,
  body: Buffer,
  deps: R2ColdSnapshotDeps,
): Promise<string> {
  // The part body is buffered in memory for the duration of the attempt, so a retry
  // re-sends the SAME bytes — the gzip stream is never rewound and part numbering never
  // shifts.  That is what makes retrying a part safe here.
  const res = await withS3Retry(`UploadPart ${partNumber}`, deps, () =>
    s3Request(
      cfg,
      "PUT",
      key,
      { partNumber: String(partNumber), uploadId },
      body,
      deps,
      PART_TIMEOUT_MS,
    ),
  );
  if (!res.ok) throw new Error(`UploadPart ${partNumber} HTTP ${res.status}: ${res.body.slice(0, 200)}`);
  const etag = res.etag;
  if (!etag) throw new Error(`UploadPart ${partNumber}: no ETag in response`);
  return etag;
}

function normalizeS3Etag(etag: string | null | undefined): string | null {
  if (!etag) return null;
  return etag.trim().replaceAll('"', "").toLowerCase();
}

/** S3/R2 multipart ETag: MD5 of the concatenated part MD5s, then `"{hex}-{partCount}"`. */
function expectedMultipartEtag(parts: Array<{ etag: string }>): string | null {
  const digests: Buffer[] = [];
  for (const p of parts) {
    const hex = normalizeS3Etag(p.etag);
    if (!hex || !/^[0-9a-f]{32}$/.test(hex)) return null;
    digests.push(Buffer.from(hex, "hex"));
  }
  if (digests.length === 0) return null;
  const md5 = crypto.createHash("md5").update(Buffer.concat(digests)).digest("hex");
  return `"${md5}-${digests.length}"`;
}

type ColdSnapshotHead = {
  exists: boolean;
  etag: string | null;
  contentLength: number | null;
};

async function headColdSnapshotObject(
  cfg: R2ColdSnapshotConfig,
  key: string,
  deps: R2ColdSnapshotDeps,
): Promise<ColdSnapshotHead> {
  try {
    const res = await s3Request(cfg, "HEAD", key, {}, null, deps, CONTROL_TIMEOUT_MS);
    if (!(res.ok || res.status === 200)) {
      return { exists: false, etag: null, contentLength: null };
    }
    return { exists: true, etag: res.etag, contentLength: res.contentLength };
  } catch {
    return { exists: false, etag: null, contentLength: null };
  }
}

/**
 * After an ambiguous CompleteMultipartUpload, prove THIS attempt's object landed.
 * Key existence alone is not enough: a prior attempt may already own the weekly
 * key (e.g. upload ok, prune failed) while this retry's multipart is still open.
 */
function coldSnapshotHeadProvesComplete(
  head: ColdSnapshotHead,
  opts: {
    preEtag: string | null;
    expectedBytes: number;
    expectedEtag: string | null;
    noSuchUpload: boolean;
  },
): boolean {
  if (!head.exists) return false;
  if (head.contentLength != null && head.contentLength !== opts.expectedBytes) return false;
  if (opts.expectedEtag) {
    const got = normalizeS3Etag(head.etag);
    const want = normalizeS3Etag(opts.expectedEtag);
    if (!got || !want || got !== want) return false;
  }
  const pre = normalizeS3Etag(opts.preEtag);
  const now = normalizeS3Etag(head.etag);
  const unchangedFromPre = pre != null && now != null && pre === now;
  if (unchangedFromPre) {
    // Same object we saw before this Complete: only trust NoSuchUpload (upload id
    // consumed → complete likely committed). A bare transport error with an
    // unchanged key is the prune-retry false-success Codex flagged.
    return opts.noSuchUpload;
  }
  return true;
}

async function completeMultipartUpload(
  cfg: R2ColdSnapshotConfig,
  key: string,
  uploadId: string,
  parts: Array<{ partNumber: number; etag: string }>,
  deps: R2ColdSnapshotDeps,
  opts: { expectedBytes: number; preEtag: string | null },
): Promise<void> {
  const xml =
    `<CompleteMultipartUpload>` +
    parts.map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${p.etag}</ETag></Part>`).join("") +
    `</CompleteMultipartUpload>`;
  const expectedEtag = expectedMultipartEtag(parts);
  const proves = async (noSuchUpload: boolean): Promise<boolean> => {
    const head = await headColdSnapshotObject(cfg, key, deps);
    return coldSnapshotHeadProvesComplete(head, {
      preEtag: opts.preEtag,
      expectedBytes: opts.expectedBytes,
      expectedEtag,
      noSuchUpload,
    });
  };
  try {
    const res = await withS3Retry("CompleteMultipartUpload", deps, async () => {
      const r = await s3Request(cfg, "POST", key, { uploadId }, Buffer.from(xml, "utf8"), deps, CONTROL_TIMEOUT_MS);
      // S3 can return 200 OK with an <Error> body on complete.  Classify that
      // INSIDE the retry callback so a transient embedded error is retried
      // instead of discarding the whole multi-gigabyte attempt.
      if (r.body.includes("<Error>")) {
        // NoSuchUpload after a lost successful complete means the upload id is
        // already consumed — succeed only if HEAD proves THIS attempt's object.
        if (/NoSuchUpload/i.test(r.body)) {
          if (await proves(true)) {
            return { status: 200, ok: true, etag: null, contentLength: null, body: "" };
          }
          throw new Error(`CompleteMultipartUpload NoSuchUpload HTTP ${r.status}`);
        }
        throw new Error(`CompleteMultipartUpload embedded error HTTP ${r.status}: ${r.body.slice(0, 200)}`);
      }
      return r;
    });
    if (!res.ok) {
      throw new Error(`CompleteMultipartUpload HTTP ${res.status}: ${res.body.slice(0, 200)}`);
    }
  } catch (err) {
    // Ambiguous transport: accept only when HEAD proves this complete landed
    // (new/changed object matching size/etag) — not a stale prior weekly key.
    const msg = err instanceof Error ? err.message : String(err);
    const noSuchUpload = /NoSuchUpload/i.test(msg);
    if (await proves(noSuchUpload)) {
      return;
    }
    throw err;
  }
}

async function abortMultipartUpload(cfg: R2ColdSnapshotConfig, key: string, uploadId: string, deps: R2ColdSnapshotDeps): Promise<void> {
  try {
    await s3Request(cfg, "DELETE", key, { uploadId }, null, deps, CONTROL_TIMEOUT_MS);
  } catch {
    // best-effort — an orphaned multipart upload is invisible storage; R2 reaps them.
  }
}

/**
 * Stream the temp backup file through gzip into sequential multipart parts.
 * Memory stays bounded at roughly ONE part (default 100 MB) plus zlib buffers —
 * the ~10 GB raw backup is never buffered in full, and awaiting each part upload
 * pauses the gzip stream (async-iterator backpressure) so compressed output can
 * never pile up faster than it is shipped.
 */
async function uploadGzippedParts(
  cfg: R2ColdSnapshotConfig,
  key: string,
  uploadId: string,
  srcPath: string,
  partSizeBytes: number,
  deps: R2ColdSnapshotDeps,
): Promise<{ completedParts: Array<{ partNumber: number; etag: string }>; compressedBytes: number }> {
  const completedParts: Array<{ partNumber: number; etag: string }> = [];
  let compressedBytes = 0;
  let partNumber = 1;
  let pending: Buffer[] = [];
  let pendingBytes = 0;

  const flush = async (body: Buffer): Promise<void> => {
    const etag = await uploadPart(cfg, key, uploadId, partNumber, body, deps);
    completedParts.push({ partNumber, etag });
    partNumber += 1;
  };

  const gzip = createGzip();
  const source = createReadStream(srcPath, { highWaterMark: 4 * 1024 * 1024 });
  // pipe() does not forward source errors to its destination — destroy the gzip
  // stream ourselves so the for-await below rejects instead of hanging forever.
  source.on("error", (err) => gzip.destroy(err));
  source.pipe(gzip);

  // Whole-attempt abort must reach the gzip pipeline, not only in-flight S3
  // fetches — otherwise a deadline leaves createReadStream/createGzip chewing
  // CPU/disk while the due-job retries.
  const destroyPipeline = (reason: Error): void => {
    source.destroy(reason);
    gzip.destroy(reason);
  };
  const onAttemptAbort = (): void => {
    destroyPipeline(new Error("attempt_deadline_exceeded"));
  };
  if (deps.abortSignal) {
    if (deps.abortSignal.aborted) onAttemptAbort();
    else deps.abortSignal.addEventListener("abort", onAttemptAbort, { once: true });
  }

  try {
    for await (const chunk of gzip as AsyncIterable<Buffer>) {
      pending.push(chunk);
      pendingBytes += chunk.length;
      compressedBytes += chunk.length;
      while (pendingBytes >= partSizeBytes) {
        const joined = pending.length === 1 ? pending[0] : Buffer.concat(pending);
        await flush(joined.subarray(0, partSizeBytes));
        const rest = joined.subarray(partSizeBytes);
        pending = rest.length > 0 ? [rest] : [];
        pendingBytes = rest.length;
      }
    }
    // Final (possibly short — S3 allows any size for the LAST part) flush.  gzip
    // output is never zero bytes for any input, but keep the single-empty-part
    // fallback so a pathological case still completes rather than erroring.
    if (pendingBytes > 0 || completedParts.length === 0) {
      await flush(pending.length === 1 ? pending[0] : Buffer.concat(pending));
    }
    return { completedParts, compressedBytes };
  } finally {
    // A thrown flush() exits the for-await early — destroy both streams so the
    // backup file's fd cannot leak while the failed run is being cleaned up.
    if (deps.abortSignal) deps.abortSignal.removeEventListener("abort", onAttemptAbort);
    source.destroy();
    gzip.destroy();
  }
}

async function listColdSnapshotKeys(cfg: R2ColdSnapshotConfig, deps: R2ColdSnapshotDeps): Promise<string[]> {
  const keys: string[] = [];
  let continuation: string | undefined;
  for (let page = 0; page < 8; page++) {
    const query: Record<string, string> = { "list-type": "2", prefix: R2_COLD_SNAPSHOT_PREFIX };
    if (continuation) query["continuation-token"] = continuation;
    const res = await withS3Retry("ListObjectsV2", deps, () =>
      s3Request(cfg, "GET", null, query, null, deps, CONTROL_TIMEOUT_MS),
    );
    if (!res.ok) throw new Error(`ListObjectsV2 HTTP ${res.status}: ${res.body.slice(0, 200)}`);
    for (const m of res.body.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(m[1]);
    if (!/<IsTruncated>true<\/IsTruncated>/.test(res.body)) break;
    continuation = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(res.body)?.[1];
    if (!continuation) break;
  }
  return keys;
}

async function deleteObject(cfg: R2ColdSnapshotConfig, key: string, deps: R2ColdSnapshotDeps): Promise<void> {
  const res = await s3Request(cfg, "DELETE", key, {}, null, deps, CONTROL_TIMEOUT_MS);
  if (!res.ok && res.status !== 404) throw new Error(`DeleteObject ${key} HTTP ${res.status}`);
}

// ── Consistent snapshot: VACUUM INTO in a child process ──────────────────────

/**
 * Child-process source for the snapshot step.  Runs standalone under `node -e`, so it
 * must not close over anything here and must resolve better-sqlite3 itself.
 *
 * Why a child process: `VACUUM INTO` is a single synchronous statement that takes
 * minutes on a ~10 GB DB.  In-process it would block the event loop, stall
 * `GET /api/health`, and risk a Coolify healthcheck restart mid-snapshot.  A child also
 * gives a real kill switch for the deadline — an in-process hang cannot be cancelled,
 * which is exactly how this lane stayed stuck for 9 days.
 *
 * The source connection is READ-ONLY, so the child can never mutate live trading state.
 * It is spawned with a MINIMAL env: no Infisical secrets are handed to it.
 */
const VACUUM_INTO_CHILD_SOURCE = `
const { createRequire } = require("module");
const src = process.env.R2SNAP_SRC;
const dest = process.env.R2SNAP_DEST;
const base = process.env.R2SNAP_REQUIRE_BASE;
const tables = (process.env.R2SNAP_VERIFY_TABLES || "").split(",").map((t) => t.trim()).filter(Boolean);
if (!src || !dest) { console.error("R2SNAP_SRC/R2SNAP_DEST required"); process.exit(2); }
let Database;
try { Database = createRequire(base)("better-sqlite3"); }
catch { Database = require("better-sqlite3"); }
const db = new Database(src, { readonly: true, fileMustExist: true });
const live = {};
try {
  db.pragma("busy_timeout = 60000");
  for (const t of tables) {
    try { live[t] = db.prepare("SELECT COUNT(*) AS c FROM \\"" + t.replace(/"/g, '""') + "\\"").get().c; }
    catch { live[t] = null; }
  }
  // VACUUM INTO runs inside ONE read transaction: concurrent writers cannot restart it
  // (unlike sqlite3_backup_step), and the output is a compacted, consistent copy.
  db.prepare("VACUUM INTO ?").run(dest);
} finally {
  try { db.close(); } catch {}
}

// ── Verify the artifact we just produced, in the same child, before anyone uploads it ──
// An unverified snapshot is a hypothesis.  Opening the copy and asking SQLite itself
// whether it is a coherent database — and whether the tables that hold trading state are
// still populated — is the cheapest honest answer available, and it happens while the file
// is still local and still cheap to throw away.
const copy = new Database(dest, { readonly: true, fileMustExist: true });
const verification = { integrity: null, tables: {}, live: live, ok: false };
try {
  const rows = copy.pragma("integrity_check");
  verification.integrity = Array.isArray(rows) && rows.length > 0
    ? String(rows[0].integrity_check ?? rows[0])
    : "unknown";
  for (const t of tables) {
    try { verification.tables[t] = copy.prepare("SELECT COUNT(*) AS c FROM \\"" + t.replace(/"/g, '""') + "\\"").get().c; }
    catch (e) { verification.tables[t] = null; }
  }
} finally {
  try { copy.close(); } catch {}
}
verification.ok = verification.integrity === "ok";
process.stdout.write(JSON.stringify(verification));
`;

/**
 * Standalone verification child: same checks as the tail of {@link VACUUM_INTO_CHILD_SOURCE},
 * against a snapshot file that already exists.  Kept as its own source (rather than a mode flag)
 * so neither path can accidentally VACUUM when it meant to verify.
 */
const VERIFY_SNAPSHOT_CHILD_SOURCE = `
const { createRequire } = require("module");
const src = process.env.R2SNAP_SRC;
const dest = process.env.R2SNAP_DEST;
const base = process.env.R2SNAP_REQUIRE_BASE;
const tables = (process.env.R2SNAP_VERIFY_TABLES || "").split(",").map((t) => t.trim()).filter(Boolean);
if (!dest) { console.error("R2SNAP_DEST required"); process.exit(2); }
let Database;
try { Database = createRequire(base)("better-sqlite3"); }
catch { Database = require("better-sqlite3"); }
const quote = (t) => '"' + String(t).replace(/"/g, '""') + '"';
const counts = (db) => {
  const out = {};
  for (const t of tables) {
    try { out[t] = db.prepare("SELECT COUNT(*) AS c FROM " + quote(t)).get().c; }
    catch { out[t] = null; }
  }
  return out;
};
const verification = { integrity: null, tables: {}, live: {}, ok: false };
if (src) {
  try {
    const liveDb = new Database(src, { readonly: true, fileMustExist: true });
    try { verification.live = counts(liveDb); } finally { try { liveDb.close(); } catch {} }
  } catch { verification.live = {}; }
}
const copy = new Database(dest, { readonly: true, fileMustExist: true });
try {
  const rows = copy.pragma("integrity_check");
  verification.integrity = Array.isArray(rows) && rows.length > 0
    ? String(rows[0].integrity_check ?? rows[0])
    : "unknown";
  verification.tables = counts(copy);
} finally {
  try { copy.close(); } catch {}
}
verification.ok = verification.integrity === "ok";
process.stdout.write(JSON.stringify(verification));
`;

/**
 * Take a consistent, compacted copy of the live DB at `destPath` using `VACUUM INTO`
 * inside a child process, killed at `deadlineMs`.  Rejects (never hangs) on child
 * failure, non-zero exit, or deadline.
 */
export async function runVacuumIntoSnapshot(
  srcPath: string,
  destPath: string,
  deadlineMs: number = R2_COLD_SNAPSHOT_DEFAULT_DEADLINE_MS,
  verifyTables: readonly string[] = R2_COLD_SNAPSHOT_VERIFY_TABLES,
): Promise<R2ColdSnapshotVerification | null> {
  const stdout = await runSnapshotChild(
    VACUUM_INTO_CHILD_SOURCE,
    {
      R2SNAP_SRC: srcPath,
      R2SNAP_DEST: destPath,
      R2SNAP_VERIFY_TABLES: verifyTables.join(","),
    },
    deadlineMs,
    "VACUUM INTO",
    "snapshot_deadline_exceeded",
  );
  return parseSnapshotVerification(stdout);
}

/**
 * Verify an already-written snapshot file: `PRAGMA integrity_check` on the copy plus key-table
 * row counts on BOTH the copy and the live source.  Used when the snapshot step did not report
 * its own verification (a `deps.backupImpl` seam, or any future alternative copy mechanism), so
 * that "an artifact reached the upload unverified" is not a reachable state.
 */
export async function runSnapshotVerification(
  destPath: string,
  srcPath: string,
  deadlineMs: number = R2_COLD_SNAPSHOT_DEFAULT_DEADLINE_MS,
  verifyTables: readonly string[] = R2_COLD_SNAPSHOT_VERIFY_TABLES,
): Promise<R2ColdSnapshotVerification | null> {
  const stdout = await runSnapshotChild(
    VERIFY_SNAPSHOT_CHILD_SOURCE,
    {
      R2SNAP_SRC: srcPath,
      R2SNAP_DEST: destPath,
      R2SNAP_VERIFY_TABLES: verifyTables.join(","),
    },
    deadlineMs,
    "snapshot verification",
    "verification_deadline_exceeded",
  );
  return parseSnapshotVerification(stdout);
}

/**
 * Run one short-lived child with a MINIMAL env (no application secrets), a real SIGKILL at
 * `deadlineMs`, and its stdout captured.  Shared by the VACUUM and verification children so both
 * get the same cancellation guarantee — an in-process hang cannot be cancelled, which is exactly
 * how this lane stayed stuck for 9 days.
 */
async function runSnapshotChild(
  source: string,
  env: Record<string, string>,
  deadlineMs: number,
  label: string,
  deadlineReason: string,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    const child = spawn(process.execPath, ["-e", source], {
      env: {
        NODE_ENV: process.env.NODE_ENV,
        PATH: process.env.PATH ?? "",
        R2SNAP_REQUIRE_BASE: `${process.cwd()}/`,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"] as const,
    });
    let stderr = "";
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      if (stdout.length < 20_000) stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      if (stderr.length < 2000) stderr += String(chunk);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }, deadlineMs);
    const finish = (err?: Error, value?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve(value ?? "");
    };
    child.on("error", (err: unknown) => finish(err instanceof Error ? err : new Error(String(err))));
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (timedOut) {
        finish(new Error(`${deadlineReason} after ${Math.round(deadlineMs / 1000)}s (${label} killed)`));
        return;
      }
      if (code === 0) { finish(undefined, stdout); return; }
      finish(new Error(`${label} child exited code=${code} signal=${signal ?? "none"}: ${stderr.trim().slice(0, 300)}`));
    });
  });
}

/** Narrow an arbitrary snapshot-step return value to a verification report. */
export function isSnapshotVerification(value: unknown): value is R2ColdSnapshotVerification {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<R2ColdSnapshotVerification>;
  return typeof v.ok === "boolean" && ("integrity" in v) && typeof v.tables === "object";
}

/** Parse the child's verification JSON.  A child that produced no parseable report is
 *  treated as UNVERIFIED (null) rather than as a pass — silence is never a green check. */
export function parseSnapshotVerification(raw: string): R2ColdSnapshotVerification | null {
  const text = raw.trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text.slice(text.indexOf("{"))) as Partial<R2ColdSnapshotVerification>;
    if (typeof parsed !== "object" || parsed === null) return null;
    return {
      ok: parsed.ok === true,
      integrity: typeof parsed.integrity === "string" ? parsed.integrity : null,
      tables: (parsed.tables ?? {}) as Record<string, number | null>,
      live: (parsed.live ?? {}) as Record<string, number | null>,
    };
  } catch {
    return null;
  }
}

/**
 * Decide whether a verification report is good enough to upload.
 *
 * Two independent assertions, both required:
 *  1. SQLite's own `PRAGMA integrity_check` on the copy says `ok`.
 *  2. Every key table whose live COUNT(*) was readable and > 0 still has rows in
 *     the copy.  An unreadable live count (null) fails closed -- it is not a skip.
 *
 * (2) matters because integrity_check answers "is this a well-formed SQLite file", not
 * "does it still contain the trading state".  A structurally perfect empty database
 * passes (1) and is worthless as a backup.  Comparing against the live counts read in the
 * same child, moments earlier, is what turns the copy from plausible into checked.
 * Exact equality is deliberately NOT required: the live DB is written continuously, so
 * the copy is expected to trail it.
 */
export function assessSnapshotVerification(
  verification: R2ColdSnapshotVerification | null,
): { ok: boolean; reason?: string } {
  if (!verification) return { ok: false, reason: "snapshot_verification_missing" };
  if (verification.integrity !== "ok") {
    return { ok: false, reason: `snapshot_integrity_check=${verification.integrity ?? "unknown"}` };
  }
  const unreadable: string[] = [];
  const empty: string[] = [];
  for (const [table, liveCount] of Object.entries(verification.live ?? {})) {
    // null means the child's COUNT(*) threw (lock, missing table, schema error).
    // That is not "absent/empty live => nothing to assert" — fail closed.
    if (typeof liveCount !== "number") {
      unreadable.push(table);
      continue;
    }
    if (liveCount <= 0) continue; // empty live => nothing to assert
    const copied = verification.tables?.[table];
    if (typeof copied !== "number" || copied <= 0) empty.push(table);
  }
  if (unreadable.length > 0) {
    return { ok: false, reason: `snapshot_live_count_unreadable=${unreadable.join(",")}` };
  }
  if (empty.length > 0) {
    return { ok: false, reason: `snapshot_key_tables_empty=${empty.join(",")}` };
  }
  return { ok: true };
}

/**
 * Bound ANY snapshot implementation by the deadline.  The child-process default is
 * genuinely cancelled; a `deps.backupImpl` seam that ignores cancellation at least stops
 * blocking the run, so the attempt fails loudly inside its own lease instead of hanging.
 */
export async function withSnapshotDeadline<T>(
  work: () => Promise<T>,
  deadlineMs: number,
  label: string = "snapshot_deadline_exceeded",
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} after ${Math.round(deadlineMs / 1000)}s`)),
          deadlineMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── The snapshot itself ──────────────────────────────────────────────────────

export interface R2ColdSnapshotRunResult {
  status: "ok" | "skipped" | "error";
  reason?: string;
  key?: string;
  /** Uploaded (gzip-compressed) object size. */
  bytes?: number;
  /** Uncompressed backup size. */
  rawBytes?: number;
  parts?: number;
  /** Keys actually DeleteObject'd.  Empty when skipPrune is on. */
  pruned?: string[];
  /** Keys retain=1 would delete.  Recorded even when skipPrune leaves them in place. */
  wouldPrune?: string[];
  skipPrune?: boolean;
  /** Pre-upload proof: `PRAGMA integrity_check` + key-table row counts on the artifact. */
  verification?: R2ColdSnapshotVerification | null;
  durationMs?: number;
}

/** One audit row per distinct disabled-reason (not one per tick) — the "silent
 *  no-op with one audit row" contract. */
function recordDisabledOnce(reason: string): void {
  try {
    if (getInternalSetting<string>(DISABLED_AUDIT_KEY) === reason) return;
    setInternalSetting(DISABLED_AUDIT_KEY, reason);
    audit("r2_cold_snapshot.disabled", { reason });
  } catch {
    // never throw into the scheduler tick
  }
}

async function defaultAlert(warningType: string, message: string): Promise<void> {
  const { alertStorageWarning } = await import("./db-health");
  await alertStorageWarning(warningType, message);
}

/**
 * Take the snapshot and upload it. Never throws — every failure path returns
 * `{ status: "error" }` after auditing + a (12h-deduped) storage_warning advisory.
 */
export async function performR2ColdSnapshot(
  now: number = Date.now(),
  deps: R2ColdSnapshotDeps = {},
): Promise<R2ColdSnapshotRunResult> {
  const cfg = loadR2ColdSnapshotConfig();
  if (!cfg.enabled) {
    recordDisabledOnce(cfg.disabledReason ?? "missing_credentials");
    return { status: "skipped", reason: cfg.disabledReason ?? "missing_credentials" };
  }

  const alert = deps.alertImpl ?? defaultAlert;

  // Budget guard: the weekly upload is ~30-45 Class A ops, but if the month's Class A count
  // is already past 50% of the free tier something ELSE is burning ops — do not add to it.
  const classAPct = r2ColdSnapshotClassAPct();
  if (classAPct !== null && classAPct >= R2_COLD_SNAPSHOT_BUDGET_GUARD_PCT) {
    audit("r2_cold_snapshot.budget_refused", {
      classAPct: Number(classAPct.toFixed(2)),
      guardPct: R2_COLD_SNAPSHOT_BUDGET_GUARD_PCT,
      freeTierClassA: R2_FREE_TIER.classAOps,
    });
    try {
      await alert(
        "r2_cold_snapshot_budget",
        `Weekly R2 cold snapshot skipped: Class A operations are at ${classAPct.toFixed(1)}% ` +
          `of the free tier this month (guard: ${R2_COLD_SNAPSHOT_BUDGET_GUARD_PCT}%). ` +
          `It will retry next week; investigate what is burning R2 Class A ops.`,
      );
    } catch {
      /* advisory only */
    }
    return { status: "skipped", reason: "budget", durationMs: 0 };
  }

  const startedAt = Date.now();
  const isoDate = new Date(now).toISOString().slice(0, 10);
  const key = `${R2_COLD_SNAPSHOT_PREFIX}app-${isoDate}.db.gz`;
  const dbDir = dirname(databasePath());

  // Proactive cleanup: sweep any stale temp snapshot files from crashed or aborted prior runs
  try {
    for (const file of readdirSync(dbDir)) {
      if (file.startsWith(".r2snap-") && (file.endsWith(".tmp") || file.endsWith(".tmp-journal") || file.endsWith(".tmp-wal"))) {
        try { unlinkSync(join(dbDir, file)); } catch { /* ignore */ }
      }
    }
  } catch {
    /* non-fatal; continue with snapshot */
  }

  // Snapshot lands beside the live DB on the persistent volume (same filesystem —
  // no cross-device copy, guaranteed writable) rather than the OS temp dir: the
  // edge-flavored instrumentation webpack pass cannot resolve the "os" builtin.
  const tempPath = join(dbDir, `.r2snap-${crypto.randomUUID()}.db.tmp`);
  const partSizeBytes = deps.partSizeBytes ?? cfg.partSizeBytes;
  // Whole-attempt bound.  The signal is threaded into every S3 request so an over-deadline
  // upload is genuinely ABORTED, not merely abandoned to keep running against a job whose
  // lease the next drain has already taken.
  const attemptDeadlineMs = deps.attemptDeadlineMs ?? cfg.attemptDeadlineMs;
  const attemptController = new AbortController();
  const attemptTimer = setTimeout(() => attemptController.abort(), attemptDeadlineMs);
  const runDeps: R2ColdSnapshotDeps = {
    ...deps,
    abortSignal: deps.abortSignal ?? attemptController.signal,
  };
  let uploadId: string | undefined;
  // Held so the failure path can still recover an upload id that was created but not yet
  // ASSIGNED when the attempt deadline fired.  Without it, a deadline landing while
  // CreateMultipartUpload is in flight leaves `uploadId` undefined, the cleanup skips the
  // abort, and the create can still land server-side — an orphaned multipart upload nobody
  // will ever complete (flagged in review of PR #3204).
  let createPromise: Promise<string> | undefined;

  try {
    return await withSnapshotDeadline(async (): Promise<R2ColdSnapshotRunResult> => {
    audit("r2_cold_snapshot.start", { key, tempPath, partSizeBytes, attemptDeadlineMs });

    // Consistent snapshot — NEVER a raw copy of the live WAL-mode file, and NEVER
    // better-sqlite3 `backup()`: the online-backup API restarts from page 1 on every
    // write from another connection, so on this ~10.7 GB continuously-written DB it
    // never converges (see the header note; production hung 27 attempts this way).
    // `VACUUM INTO` in a child process takes ONE read snapshot and cannot be restarted.
    const snapshotDeadlineMs = deps.snapshotDeadlineMs ?? cfg.snapshotDeadlineMs;
    // Child deadlines draw down the SHARED attempt budget rather than each starting a fresh
    // full-size timer.  A child handed 45 minutes when only 3 remain outlives the parent that
    // is already reporting failure, and keeps a multi-GB VACUUM running against a job whose
    // lease has moved on (flagged in review of PR #3204).
    const remainingAttemptMs = (): number =>
      Math.max(1_000, attemptDeadlineMs - (Date.now() - startedAt));
    const childDeadlineMs = (): number => Math.min(snapshotDeadlineMs, remainingAttemptMs());
    const snapshotStartedAt = Date.now();
    const backupImpl =
      deps.backupImpl ?? ((dest: string) => runVacuumIntoSnapshot(databasePath(), dest, childDeadlineMs()));
    const backupOutput = await withSnapshotDeadline(
      () => Promise.resolve(backupImpl(tempPath)),
      snapshotDeadlineMs,
    );
    const snapshotMs = Date.now() - snapshotStartedAt;
    const rawBytes = statSync(tempPath).size;

    // Prove the artifact before shipping it.  Uploading an unchecked file and calling the
    // result a backup is how an archive tier ends up green for months and useless once.
    // The check runs while the file is still local, so a bad snapshot costs one wasted
    // VACUUM rather than a wasted week of archive coverage.
    const reported = isSnapshotVerification(backupOutput) ? backupOutput : null;
    const verification =
      reported ??
      (await (deps.verifyImpl ??
        ((dest: string) =>
          runSnapshotVerification(dest, databasePath(), childDeadlineMs())))(tempPath));
    const verdict = assessSnapshotVerification(verification);
    if (!verdict.ok) {
      throw new Error(`snapshot_verification_failed: ${verdict.reason ?? "unknown"}`);
    }
    audit("r2_cold_snapshot.verified", {
      key,
      integrity: verification?.integrity ?? null,
      tables: verification?.tables ?? {},
      live: verification?.live ?? {},
      rawBytes,
      snapshotMs,
    });

    const preHead = await headColdSnapshotObject(cfg, key, runDeps);
    createPromise = createMultipartUpload(cfg, key, runDeps);
    uploadId = await createPromise;
    const { completedParts, compressedBytes } = await uploadGzippedParts(
      cfg,
      key,
      uploadId,
      tempPath,
      partSizeBytes,
      runDeps,
    );
    await completeMultipartUpload(cfg, key, uploadId, completedParts, runDeps, {
      expectedBytes: compressedBytes,
      preEtag: preHead.etag,
    });
    uploadId = undefined; // completed — nothing to abort from here on

    // Retention: keep the newest `retain` snapshots, delete the rest — unless
    // skipPrune is on (first gzip land: do not delete the legacy 9 GiB `.db`
    // until Jay approves).  A prune failure does not fail the run — the snapshot
    // IS uploaded; next week's prune catches up.
    let pruned: string[] = [];
    let wouldPrune: string[] = [];
    try {
      const keys = await listColdSnapshotKeys(cfg, runDeps);
      wouldPrune = selectColdSnapshotsToPrune(keys, cfg.retain);
      if (cfg.skipPrune) {
        audit("r2_cold_snapshot.prune_skipped", {
          key,
          wouldPrune,
          reason: "R2_COLD_SNAPSHOT_SKIP_PRUNE",
        });
      } else {
        pruned = wouldPrune;
        for (const k of pruned) await deleteObject(cfg, k, runDeps);
      }
    } catch (err) {
      // Attempt-deadline aborts during list/delete are terminal — do not paint
      // the run as a successful upload with a soft prune_error.
      if (runDeps.abortSignal?.aborted) throw err;
      audit("r2_cold_snapshot.prune_error", { key, error: err instanceof Error ? err.message : String(err) });
      pruned = [];
      wouldPrune = [];
    }

    const durationMs = Date.now() - startedAt;
    const completedAt = new Date().toISOString();
    try {
      setInternalSetting(R2_COLD_SNAPSHOT_LAST_SUCCESS_KEY, {
        key,
        completedAt,
        bytes: compressedBytes,
        rawBytes,
        verifiedIntegrity: verification?.integrity ?? null,
        verifiedTables: verification?.tables ?? undefined,
      } satisfies R2ColdSnapshotLastSuccess);
    } catch {
      /* health may lag until next success; never throw into the scheduler tick */
    }
    audit("r2_cold_snapshot.success", {
      key,
      bytes: compressedBytes,
      rawBytes,
      snapshotMs,
      parts: completedParts.length,
      pruned,
      wouldPrune,
      skipPrune: cfg.skipPrune,
      retain: cfg.retain,
      verifiedIntegrity: verification?.integrity ?? null,
      durationMs,
    });
    return {
      status: "ok",
      key,
      bytes: compressedBytes,
      rawBytes,
      parts: completedParts.length,
      pruned,
      wouldPrune,
      skipPrune: cfg.skipPrune,
      verification,
      durationMs,
    };
    }, attemptDeadlineMs, "attempt_deadline_exceeded");
  } catch (err) {
    // describeRequestError, not err.message: Node's fetch reports every transport failure
    // as the bare string "fetch failed" and hides the real reason in `cause`.  That is
    // literally all production got for the run that died on 2026-09-08T15:47:24Z.
    const message = describeRequestError(err);
    // Cleanup must NOT inherit the attempt's abort signal — if the deadline is what fired,
    // an aborted signal would cancel the very request that releases the orphaned parts.
    const cleanupDeps: R2ColdSnapshotDeps = { ...deps, abortSignal: undefined };
    // Settle the create first: the deadline can fire between R2 minting an upload id and this
    // scope assigning it, and an id we never learned is an id we can never abort.  BOUNDED,
    // because the reason we are in this catch may be that the create never settles at all —
    // an unbounded wait here would hang the cleanup for exactly as long as the hang we just
    // escaped, inside the scheduler tick.  If it does not settle in time we lose the id and
    // R2 reaps the orphan on its own; that is the acceptable end of this trade.
    if (!uploadId && createPromise) {
      uploadId = await Promise.race([
        createPromise.catch(() => undefined),
        new Promise<undefined>((resolve) =>
          setTimeout(() => resolve(undefined), R2_COLD_SNAPSHOT_CLEANUP_SETTLE_MS),
        ),
      ]);
    }
    if (uploadId) await abortMultipartUpload(cfg, key, uploadId, cleanupDeps);
    try {
      setInternalSetting(R2_COLD_SNAPSHOT_LAST_FAILURE_KEY, {
        key,
        failedAt: new Date().toISOString(),
        reason: message.slice(0, 500),
      } satisfies R2ColdSnapshotLastFailure);
    } catch {
      /* never throw */
    }
    try {
      audit("r2_cold_snapshot.error", { key, error: message, durationMs: Date.now() - startedAt });
    } catch {
      /* never throw */
    }
    // Sentry: a failed run is visible immediately, not only once the 8-day staleness
    // window trips.  Bounded by the due-job backoff (max 5 attempts/week), so cheap.
    logError("r2 cold snapshot run failed", { key, reason: message.slice(0, 300) });
    try {
      await alert(
        "r2_cold_snapshot_failed",
        `Weekly R2 cold snapshot failed for ${key}: ${message}. ` +
          `The due-job retries with backoff; B2 litestream replication is unaffected.`,
      );
    } catch {
      /* advisory only */
    }
    return { status: "error", reason: message, durationMs: Date.now() - startedAt };
  } finally {
    clearTimeout(attemptTimer);
    try {
      if (existsSync(tempPath)) unlinkSync(tempPath);
      const journal = `${tempPath}-journal`;
      if (existsSync(journal)) unlinkSync(journal);
      const wal = `${tempPath}-wal`;
      if (existsSync(wal)) unlinkSync(wal);
    } catch {
      /* temp-dir janitor sweeps agentic-* leftovers as the backstop */
    }
  }
}

// ── Due-job scheduling + drain (scheduler wiring) ────────────────────────────

/**
 * Idempotently make sure the next weekly job exists. One row per week via the
 * `week-YYYY-MM-DD` dedupe key (INSERT OR IGNORE in enqueueDueJob). Silent no-op
 * (single audit row) when the lane is not configured. Returns true only when a
 * new row was inserted.
 */
export function ensureR2ColdSnapshotJobScheduled(now: number = Date.now()): boolean {
  try {
    const cfg = loadR2ColdSnapshotConfig();
    if (!cfg.enabled) {
      recordDisabledOnce(cfg.disabledReason ?? "missing_credentials");
      return false;
    }
    const { dueAtISO, dedupeKey } = nextR2ColdSnapshotDueAt(now);
    return enqueueDueJob({ jobType: R2_COLD_SNAPSHOT_JOB_TYPE, dedupeKey, dueAt: dueAtISO });
  } catch (err) {
    console.error("[r2-cold-snapshot] schedule error:", err);
    return false;
  }
}

export interface R2ColdSnapshotDrainResult {
  drained: number;
  lastRun?: R2ColdSnapshotRunResult;
}

/**
 * Claim and run due cold-snapshot jobs (limit 1 — there is never more than one
 * meaningful snapshot per drain). Success/skip completes the job; an error fails it
 * back to pending with backoff (db-jobs default: 10 min, max 5 attempts, then
 * terminally unresolvable — next week's job arrives regardless). Never throws.
 */
export async function drainR2ColdSnapshotJobs(
  now: number = Date.now(),
  deps: R2ColdSnapshotDeps = {},
): Promise<R2ColdSnapshotDrainResult> {
  // Unique claimant PER INVOCATION (not just per PID): completeDueJob/failDueJob
  // fence on `claimed_by = claimant`, so if a lease ever expires mid-upload and a
  // later drain reclaims the job, the stale worker's completion is fenced out
  // (returns false) instead of clobbering the reclaimer's job state.
  const claimant = `r2-cold-snapshot:${process.pid}:${crypto.randomUUID().slice(0, 8)}`;
  // 2h lease: gzip-streaming a ~10 GB backup into sequential multipart parts is
  // normally minutes, but a degraded uplink must not let a second drain start a
  // concurrent ~10 GB backup + racing upload of the same key.
  const jobs = claimDueJobs(R2_COLD_SNAPSHOT_JOB_TYPE, {
    limit: 1,
    leaseMs: R2_COLD_SNAPSHOT_LEASE_MS,
    claimant,
    now: new Date(now),
  });
  if (jobs.length === 0) return { drained: 0 };

  let lastRun: R2ColdSnapshotRunResult | undefined;
  for (const job of jobs) {
    try {
      const result = await performR2ColdSnapshot(now, deps);
      lastRun = result;
      if (result.status === "error") {
        failDueJob(job.id, claimant, result.reason ?? "snapshot_failed");
      } else {
        completeDueJob(job.id, claimant, {
          status: result.status,
          reason: result.reason,
          key: result.key,
          bytes: result.bytes,
          rawBytes: result.rawBytes,
          parts: result.parts,
          prunedCount: result.pruned?.length ?? 0,
          skipPrune: result.skipPrune ?? false,
        });
      }
    } catch (err) {
      // performR2ColdSnapshot never throws; this is a belt-and-suspenders fence.
      failDueJob(job.id, claimant, err instanceof Error ? err.message : String(err));
    }
  }

  audit("r2_cold_snapshot.drain", {
    drained: jobs.length,
    lastStatus: lastRun?.status,
    stats: getDueJobStats(R2_COLD_SNAPSHOT_JOB_TYPE),
  });
  return { drained: jobs.length, lastRun };
}

// ── Freshness watchdog (watches what /api/health publishes) ──────────────────

export type R2WeeklyHealthState = "ok" | "archive_stale" | "archive_not_run";

/** Collapse the public health shape to the single state we alert transitions on. Pure. */
export function r2WeeklyHealthState(status: R2WeeklyHealthStatus): R2WeeklyHealthState {
  if (status.ok) return "ok";
  return status.reason === "archive_stale" ? "archive_stale" : "archive_not_run";
}

export interface R2WeeklyFreshnessReport {
  state: R2WeeklyHealthState;
  previous: R2WeeklyHealthState | null;
  changed: boolean;
}

/**
 * Watch `checks.storage.r2Weekly` — the field the public health endpoint already
 * publishes and which nothing was watching — and emit ONE Sentry event per state
 * TRANSITION plus the usual storage_warning advisory on degrade.  Cheap by construction:
 * a single internal-setting read on a tick where nothing changed.  Never throws.
 */
export async function reportR2WeeklyFreshness(
  now: number = Date.now(),
  deps: Pick<R2ColdSnapshotDeps, "alertImpl"> = {},
): Promise<R2WeeklyFreshnessReport> {
  try {
    const status = getR2WeeklyHealthStatus(now);
    const state = r2WeeklyHealthState(status);
    const previous = getInternalSetting<R2WeeklyHealthState>(R2_COLD_SNAPSHOT_HEALTH_STATE_KEY) ?? null;
    if (previous === state) return { state, previous, changed: false };

    // Emit FIRST, persist LAST.  The stored state is what suppresses the next tick, so
    // writing it before the event has been emitted would lose the transition forever if
    // anything in between threw: the next tick would see the new state as `previous` and
    // conclude nothing changed.  Persisting last means a mid-flight failure at worst
    // repeats the event next tick, which for an archive-staleness watchdog is strictly
    // the right way to be wrong.  logWarn/logError are fire-and-forget and cannot throw;
    // the audit row and the advisory are each guarded so neither can skip the write.
    const ageDays = status.ageSeconds === null ? null : Number((status.ageSeconds / 86400).toFixed(2));
    if (state === "ok") {
      logWarn("r2 cold snapshot archive recovered", {
        previous,
        ageSeconds: status.ageSeconds,
        key: status.key,
      });
    } else {
      logError("r2 cold snapshot archive stale", {
        state,
        previous,
        ageSeconds: status.ageSeconds,
        ageDays,
        maxAgeSeconds: R2_ARCHIVE_MAX_AGE_SECONDS,
        key: status.key,
      });
    }

    try {
      audit("r2_cold_snapshot.health_change", {
        from: previous,
        to: state,
        ageSeconds: status.ageSeconds,
        key: status.key,
        maxAgeSeconds: R2_ARCHIVE_MAX_AGE_SECONDS,
      });
    } catch {
      /* observability only — must not cost us the state write below */
    }

    if (state !== "ok") {
      const alert = deps.alertImpl ?? defaultAlert;
      try {
        await alert(
          "r2_cold_snapshot_stale",
          state === "archive_not_run"
            ? `Weekly R2 cold snapshot has never completed — the independent archive tier is EMPTY. ` +
                `Litestream/B2 continuous replication is unaffected.`
            : `Weekly R2 cold snapshot is ${ageDays ?? "?"} days old (limit ` +
                `${R2_ARCHIVE_MAX_AGE_SECONDS / 86400} days); newest archive object is ${status.key}. ` +
                `The independent archive tier is not advancing. Litestream/B2 continuous ` +
                `replication is unaffected.`,
        );
      } catch {
        /* advisory only */
      }
    }

    setInternalSetting(R2_COLD_SNAPSHOT_HEALTH_STATE_KEY, state);
    return { state, previous, changed: true };
  } catch {
    // Watchdogs must never throw into the scheduler tick.
    return { state: "archive_not_run", previous: null, changed: false };
  }
}
