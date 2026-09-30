/**
 * Durable boot / exit ledger + restart-loop detector (board a9676caf).
 *
 * Problem (2026-08-28, Aug 28 RTH ~15-minute loop): when the production container restarts, Coolify /
 * Docker replace it with a NEW container, so the previous container's `docker logs` -- including the
 * exit-guard receipts in src/lib/exit-guard.ts (exit code, signal, call-site stack) -- are gone before
 * anyone looks, and NOTHING alerts on the loop itself: each boot looks healthy in isolation.
 *
 * This module fixes both from inside the app, using the one thing that survives a container
 * replacement: the persistent `/app/data` volume (same directory as the SQLite DB and
 * litestream-runtime.log; see src/lib/runtime-health.ts defaultLitestreamRuntimeLogPath).
 *
 *  - Every boot appends one JSON line to `boot-ledger.jsonl` beside the DB.
 *  - Every orderly exit appends one JSON line (exit code, stop signal, and the process.exit call site
 *    captured by exit-guard).  An exit that never wrote one -- SIGKILL, OOM kill, host restart, a
 *    healthcheck kill -- shows up on the NEXT boot as `prevUnclean: true`, which is itself the receipt.
 *  - The pure `assessRestartLoop` counts boots in a trailing window; `reportRestartLoop` raises a
 *    Sentry message and an admin alert when the count crosses the threshold.
 *
 * Scope discipline: this is best-effort observability.  Nothing here may ever throw into boot, block
 * boot on I/O other than two tiny synchronous file operations, or change a trading decision.  It is
 * ACTIVE only in production (or with BOOT_LEDGER=on) so dev tooling and the test runner never write
 * files; BOOT_LEDGER=off is the kill switch.  It does not replace Coolify-side restart monitoring, it
 * makes the evidence durable and the loop loud from the app's own side.
 */

import { randomUUID } from "crypto";
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";

export const BOOT_LEDGER_FILENAME = "boot-ledger.jsonl";
/** Trailing window in which boots are counted as one loop. */
export const DEFAULT_RESTART_LOOP_WINDOW_MINUTES = 45;
/** Boots inside the window (including this one) at which we call it a loop. */
export const DEFAULT_RESTART_LOOP_BOOT_THRESHOLD = 3;
/** Ledger is trimmed to its newest KEEP lines once it exceeds MAX bytes. */
export const BOOT_LEDGER_MAX_BYTES = 256 * 1024;
export const BOOT_LEDGER_KEEP_LINES = 400;
/** Admin-alert cooldown is enforced by alertStorageWarning (12h per warning type). */
export const RESTART_LOOP_ALERT_TYPE = "restart_loop";

export interface BootEntry {
  v: 1;
  t: "boot";
  ts: string;
  bootId: string;
  pid: number;
  release?: string;
  node: string;
}

export interface ExitEntry {
  v: 1;
  t: "exit";
  ts: string;
  bootId: string;
  pid: number;
  code: number | null;
  uptimeSec: number;
  /** Stop signal exit-guard saw before the exit, when any. */
  signal?: string;
  /** process.exit() call-site stack captured by exit-guard, when the exit went through it. */
  callSite?: string;
  /** RSS in bytes at exit time, when captured (self-healing 2026-09-30). */
  rssBytes?: number;
}

export type BootLedgerEntry = BootEntry | ExitEntry;

export interface ExitReceiptDetail {
  code: number;
  signal?: string;
  callSite?: string;
  /** RSS in bytes at exit time, captured by noteExitReceipt (self-healing 2026-09-30:
   *  gives the boot ledger "RSS-at-death" for receipted exits, so a watchdog/OOM-adjacent
   *  exit can be distinguished from a lean one; SIGKILLs still leave no receipt at all). */
  rssBytes?: number;
}

export interface RestartLoopAssessment {
  /** Boots at or after now - windowMs, including the current one. */
  bootsInWindow: number;
  /** Of those, boots whose predecessor never wrote an exit receipt. */
  uncleanPredecessorsInWindow: number;
  windowMinutes: number;
  threshold: number;
  restartLoop: boolean;
  /** Most recent exit receipt before the current boot, when the ledger has one. */
  lastExit: ExitEntry | null;
  /** True when the boot immediately before this one has no matching exit receipt. */
  prevUnclean: boolean;
  firstBootInWindowTs: string | null;
}

export interface BootLedgerOptions {
  /** Install regardless of NODE_ENV (tests). */
  force?: boolean;
  /** Override the process (tests). */
  proc?: NodeJS.Process;
  /** Override "now" (tests). */
  now?: () => number;
  /** Override the ledger file path (tests); defaults to <db dir>/boot-ledger.jsonl. */
  path?: string;
  /** Log sink; defaults to console.error so a loop is visible in container logs too. */
  log?: (line: string) => void;
}

function envInt(raw: string | undefined, fallback: number, min: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
}

export function bootLedgerActive(proc: NodeJS.Process = process, force = false): boolean {
  const env = proc.env;
  if (env.BOOT_LEDGER === "off") return false;
  return force || env.BOOT_LEDGER === "on" || env.NODE_ENV === "production";
}

/** Same resolution as db.ts databasePath(), duplicated so this module stays dependency-free. */
export function bootLedgerPath(env: Record<string, string | undefined> = process.env): string {
  const override = env.BOOT_LEDGER_PATH?.trim();
  if (override) return resolve(override);
  const dbPath = resolve((env.DATABASE_URL ?? "file:./data/app.db").replace(/^file:/, ""));
  return join(dirname(dbPath), BOOT_LEDGER_FILENAME);
}

/** Tolerant parser: a torn or foreign line is skipped, never fatal. */
export function parseBootLedger(text: string): BootLedgerEntry[] {
  const out: BootLedgerEntry[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<BootLedgerEntry>;
      if (
        parsed &&
        (parsed.t === "boot" || parsed.t === "exit") &&
        typeof parsed.ts === "string" &&
        typeof parsed.bootId === "string" &&
        Number.isFinite(Date.parse(parsed.ts))
      ) {
        out.push(parsed as BootLedgerEntry);
      }
    } catch {
      // torn write (process killed mid-append) -- skip
    }
  }
  return out;
}

/**
 * Pure.  `entries` is the ledger INCLUDING the current boot as its last boot entry.
 */
export function assessRestartLoop(
  entries: BootLedgerEntry[],
  nowMs: number,
  opts: { windowMinutes?: number; threshold?: number } = {}
): RestartLoopAssessment {
  const windowMinutes = opts.windowMinutes ?? DEFAULT_RESTART_LOOP_WINDOW_MINUTES;
  const threshold = opts.threshold ?? DEFAULT_RESTART_LOOP_BOOT_THRESHOLD;
  const windowStart = nowMs - windowMinutes * 60_000;

  const exitByBoot = new Map<string, ExitEntry>();
  for (const e of entries) if (e.t === "exit") exitByBoot.set(e.bootId, e);
  const boots = entries.filter((e): e is BootEntry => e.t === "boot");

  let uncleanPredecessorsInWindow = 0;
  const inWindow: BootEntry[] = [];
  for (let i = 0; i < boots.length; i++) {
    const ts = Date.parse(boots[i].ts);
    if (ts < windowStart) continue;
    inWindow.push(boots[i]);
    const predecessor = i > 0 ? boots[i - 1] : undefined;
    if (predecessor && !exitByBoot.has(predecessor.bootId)) uncleanPredecessorsInWindow++;
  }

  const current = boots[boots.length - 1];
  const predecessor = boots.length > 1 ? boots[boots.length - 2] : undefined;
  const lastExit = predecessor ? (exitByBoot.get(predecessor.bootId) ?? null) : null;
  return {
    bootsInWindow: inWindow.length,
    uncleanPredecessorsInWindow,
    windowMinutes,
    threshold,
    restartLoop: inWindow.length >= threshold,
    lastExit,
    prevUnclean: predecessor !== undefined && current !== undefined && !exitByBoot.has(predecessor.bootId),
    firstBootInWindowTs: inWindow[0]?.ts ?? null
  };
}

function trimLedgerIfLarge(path: string): void {
  try {
    if (statSync(path).size <= BOOT_LEDGER_MAX_BYTES) return;
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    writeFileSync(path, lines.slice(-BOOT_LEDGER_KEEP_LINES).join("\n") + "\n");
  } catch {
    // best effort
  }
}

interface LedgerState {
  path: string;
  bootId: string;
  startedAtMs: number;
  pendingReceipt?: ExitReceiptDetail;
  exitWritten: boolean;
}

let state: LedgerState | null = null;

/** Called by exit-guard right before it performs the real exit, so the ledger keeps the call site. */
export function noteExitReceipt(detail: ExitReceiptDetail): void {
  if (state) {
    // Capture RSS-at-death here (not at the call site): the receipt lands a
    // moment before the real exit, so this is the freshest possible reading.
    // Best-effort — a broken memoryUsage() must never block an exit.
    if (detail.rssBytes === undefined) {
      try {
        detail = { ...detail, rssBytes: process.memoryUsage().rss };
      } catch {
        /* keep the receipt without RSS */
      }
    }
    state.pendingReceipt = detail;
  }
}

/** Test helper. */
export function resetBootLedgerForTests(): void {
  state = null;
}

function appendLine(path: string, entry: BootLedgerEntry): void {
  appendFileSync(path, JSON.stringify(entry) + "\n");
}

/**
 * Record this boot and arm the exit receipt.  Synchronous, never throws.  Returns the restart-loop
 * assessment (including this boot), or null when inactive or when the ledger could not be used.
 */
export function recordBoot(options: BootLedgerOptions = {}): RestartLoopAssessment | null {
  const proc = options.proc ?? process;
  if (!bootLedgerActive(proc, options.force === true)) return null;
  if (state) return null; // idempotent per process
  try {
    const now = options.now ?? Date.now;
    const path = options.path ?? bootLedgerPath(proc.env);
    mkdirSync(dirname(path), { recursive: true });
    const bootId = randomUUID();
    const startedAtMs = now();
    const entry: BootEntry = {
      v: 1,
      t: "boot",
      ts: new Date(startedAtMs).toISOString(),
      bootId,
      pid: proc.pid,
      node: proc.version,
      ...((proc.env.SOURCE_COMMIT || proc.env.GIT_SHA || proc.env.COOLIFY_GIT_COMMIT_SHA)
        ? { release: String(proc.env.SOURCE_COMMIT || proc.env.GIT_SHA || proc.env.COOLIFY_GIT_COMMIT_SHA).slice(0, 12) }
        : {})
    };

    let previous: BootLedgerEntry[] = [];
    try {
      previous = parseBootLedger(readFileSync(path, "utf8"));
    } catch {
      // first boot on this volume
    }
    appendLine(path, entry);
    trimLedgerIfLarge(path);

    state = { path, bootId, startedAtMs, exitWritten: false };
    const local = state;
    proc.on("exit", (code: number) => {
      if (local.exitWritten) return;
      local.exitWritten = true;
      try {
        const receipt = local.pendingReceipt;
        const exitEntry: ExitEntry = {
          v: 1,
          t: "exit",
          ts: new Date(now()).toISOString(),
          bootId,
          pid: proc.pid,
          code: typeof code === "number" ? code : (receipt?.code ?? null),
          uptimeSec: Math.max(0, Math.round((now() - startedAtMs) / 1000)),
          ...(receipt?.signal ? { signal: receipt.signal } : {}),
          ...(receipt?.callSite ? { callSite: receipt.callSite } : {}),
          ...(typeof receipt?.rssBytes === "number" ? { rssBytes: receipt.rssBytes } : {})
        };
        appendLine(path, exitEntry);
      } catch {
        // an exit receipt must never disturb shutdown
      }
    });

    return assessRestartLoop(
      [...previous, entry],
      startedAtMs,
      {
        windowMinutes: envInt(proc.env.RESTART_LOOP_WINDOW_MINUTES, DEFAULT_RESTART_LOOP_WINDOW_MINUTES, 1),
        threshold: envInt(proc.env.RESTART_LOOP_BOOT_THRESHOLD, DEFAULT_RESTART_LOOP_BOOT_THRESHOLD, 2)
      }
    );
  } catch {
    return null;
  }
}

export function describeRestartLoop(a: RestartLoopAssessment): string {
  const exit = a.lastExit;
  const previous = a.prevUnclean
    ? "the previous boot left NO exit receipt (SIGKILL / OOM kill / host or healthcheck kill)"
    : exit
      ? `the previous boot exited ${exit.code}${exit.signal ? ` after ${exit.signal}` : ""} after ${exit.uptimeSec}s`
      : "no previous exit receipt is available";
  return (
    `Restart loop: ${a.bootsInWindow} boots in the last ${a.windowMinutes} minutes ` +
    `(threshold ${a.threshold}); ${previous}. ` +
    `Full history: ${BOOT_LEDGER_FILENAME} on the data volume (one JSON line per boot/exit, with the ` +
    `process.exit call site).`
  );
}

/**
 * Raise the loop: container log line, Sentry message (fingerprinted so repeats group), and the admin
 * alert path (12h cooldown).  Never throws, safe to fire-and-forget after the DB is available.
 */
export async function reportRestartLoop(
  assessment: RestartLoopAssessment | null,
  options: { log?: (line: string) => void } = {}
): Promise<void> {
  if (!assessment?.restartLoop) return;
  const log = options.log ?? ((line: string) => console.error(line));
  const message = describeRestartLoop(assessment);
  log(`[boot-ledger] ${message}`);

  if (process.env.SENTRY_DSN) {
    try {
      const Sentry = await import("@sentry/nextjs");
      Sentry.withScope((scope) => {
        scope.setLevel("fatal");
        scope.setTag("component", "boot-ledger");
        scope.setFingerprint(["boot-ledger", "restart-loop"]);
        scope.setContext("restart-loop", {
          bootsInWindow: assessment.bootsInWindow,
          uncleanPredecessorsInWindow: assessment.uncleanPredecessorsInWindow,
          windowMinutes: assessment.windowMinutes,
          threshold: assessment.threshold,
          prevUnclean: assessment.prevUnclean,
          lastExitCode: assessment.lastExit?.code ?? null,
          lastExitUptimeSec: assessment.lastExit?.uptimeSec ?? null,
          lastExitCallSite: assessment.lastExit?.callSite?.split("\n")[0] ?? null,
          firstBootInWindow: assessment.firstBootInWindowTs
        });
        Sentry.captureMessage(message);
      });
    } catch {
      // observability must not affect boot
    }
  }

  try {
    const { alertStorageWarning } = await import("./db-health");
    await alertStorageWarning(RESTART_LOOP_ALERT_TYPE, message);
  } catch {
    // alerting must not affect boot
  }
}

export const LIVENESS_WATCHDOG_LOG_FILENAME = "liveness-watchdog.log";
const WATCHDOG_KILL_RECENCY_MS = 60 * 60 * 1000;

/**
 * Best-effort attribution for container restarts triggered by the liveness
 * watchdog in scripts/coolify-prod-start.sh (2026-09-30 self-healing).  The
 * watchdog appends one line per kill to liveness-watchdog.log on the data
 * volume; the exit-guard receipt for the same restart just shows SIGTERM, so
 * without this the next boot cannot tell a watchdog kill from a deploy stop.
 * Returns the last log line when the file was written recently, else null.
 * Never throws.
 */
export function readRecentWatchdogKill(
  env: Record<string, string | undefined> = process.env,
  nowMs: number = Date.now()
): string | null {
  try {
    const logPath = join(dirname(bootLedgerPath(env)), LIVENESS_WATCHDOG_LOG_FILENAME);
    let stat;
    try {
      stat = statSync(logPath);
    } catch {
      return null;
    }
    if (nowMs - stat.mtimeMs > WATCHDOG_KILL_RECENCY_MS) return null;
    const lines = readFileSync(logPath, "utf8").trim().split("\n").filter((l) => l.trim());
    return lines.length > 0 ? lines[lines.length - 1] : null;
  } catch {
    return null;
  }
}
