import { deleteInternalSetting, getAutoResumeOnBoot, getDb, getInternalSetting, setInternalSetting } from "./db";
import { brokerPauseAccountScope, getBrokerPlacementPauseMarker } from "./broker-health";
import type { SystemState } from "./types";

// Why is this account halted, and will it start again by itself?  (Board 687a5fb4, lane h5.)
//
// Production 2026-09-25..29: Alpaca Paper was auto-halted by a broker-health probe timeout at
// 18:20Z, and stayed halted with no runs for four days until an operator re-armed it.  Why its
// auto-pause never lifted is NOT established (see docs/rollouts/2026-09-30-st-w3-h5-restart-halt-visibility.md, Review
// round): the leading hypothesis is that pre-#3752 code dropped the auto-resume marker without
// resuming, when a caller holding a stale "active" snapshot got a healthy probe after the halt
// (#3752's durable re-read closed that path); the alternative is that the boot interlock ended the
// auto-pause at the #3752 deploy because "Auto-resume on boot" was off.  Either way nothing on the
// console, in the ops snapshot, or in the notification title said what was holding the account.
//
// This module records what the boot interlock did to each account (a receipt) and turns the
// durable state, plus the audit trail for halts that predate any receipt, into one honest answer:
// paused by the app and resuming by itself (with the last broker check), stopped by a restart,
// stopped by the drawdown breaker, paused by the app with its resume record gone, or no record.

/** What the boot interlock did to one account.  Cleared once the account leaves `halted`. */
export type BootHaltReceipt = {
  /** ISO time of the boot that halted the account. */
  at: string;
  /** "active": the boot reverted a Running account.  "broker_auto_pause": the account was already
   *  halted by a broker-health auto-pause, and the boot took away its auto-resume. */
  from: "active" | "broker_auto_pause";
  autoPauseReason?: string;
  autoPausedSince?: string;
};

export type AutonomyHaltCause =
  | {
      kind: "broker_auto_pause";
      /** The app paused the account and lifts the pause itself on the first healthy broker check
       *  (unless a restart with Auto-resume on boot off ends the pause first). */
      resumesOnItsOwn: true;
      since: string;
      reason: string;
      /** The user's "Auto-resume on boot" setting (or the env override) now.  When false, a restart
       *  or deploy before the broker recovers ends this auto-pause and leaves the account stopped. */
      autoResumeOnBootNow: boolean;
      /** The latest broker check that still failed while this pause held the account, if recorded. */
      lastProbeAt?: string;
      lastProbeReason?: string;
      summary: string;
    }
  | {
      kind: "restart";
      resumesOnItsOwn: false;
      at: string;
      from: BootHaltReceipt["from"];
      autoPauseReason?: string;
      /** The user's "Auto-resume on boot" setting as it is NOW (it was off when the restart halted it). */
      autoResumeOnBootNow: boolean;
      summary: string;
    }
  | {
      /** The drawdown circuit breaker (hard action "halted") stopped the account, and it has stayed
       *  halted since.  Read from the audit trail. */
      kind: "breaker";
      resumesOnItsOwn: false;
      at: string;
      reason: string;
      summary: string;
    }
  | {
      /** The run-failure watchdog (run-failure-watchdog.ts) auto-halted the account after a long
       *  streak of consecutive strategy-run failures, and it has stayed halted since.  The owner
       *  re-arms from the console; the watchdog never lifts it by itself. */
      kind: "run_failure_halt";
      resumesOnItsOwn: false;
      since: string;
      reason: string;
      consecutiveFailures: number;
      summary: string;
    }
  | {
      /** The audit trail says a broker auto-pause halted the account and nothing re-armed or took it
       *  over since, but the auto-resume marker is gone.  The 2026-09-25 incident shape; current code
       *  should never produce it, so seeing it means a marker was dropped without a record. */
      kind: "auto_pause_lost";
      resumesOnItsOwn: false;
      at: string;
      reason: string;
      summary: string;
    }
  | {
      kind: "stopped";
      resumesOnItsOwn: false;
      summary: string;
    };

const receiptKey = (userId: string, accountScope: string) => `autonomy:boot-halted:${userId}:${accountScope}`;

export function recordBootHaltReceipt(userId: string, accountScope: string, receipt: BootHaltReceipt): void {
  setInternalSetting(receiptKey(userId, accountScope), receipt);
}

export function getBootHaltReceipt(userId: string, accountScope: string): BootHaltReceipt | undefined {
  const raw = getInternalSetting<BootHaltReceipt>(receiptKey(userId, accountScope));
  if (!raw || typeof raw !== "object" || typeof raw.at !== "string") return undefined;
  if (raw.from !== "active" && raw.from !== "broker_auto_pause") return undefined;
  return raw;
}

export function clearBootHaltReceipt(userId: string, accountScope: string): void {
  deleteInternalSetting(receiptKey(userId, accountScope));
}

/**
 * Drop a receipt the account has outgrown: once it is no longer `halted`, someone re-armed it (or
 * set exit-only / wind-down) and the restart is history.  Read first so the scheduler's
 * every-tick call is a read, not a write, in the common case.  Returns true when one was removed.
 */
export function clearBootHaltReceiptIfNotHalted(userId: string, accountScope: string, systemState: SystemState): boolean {
  if (systemState === "halted") return false;
  if (!getBootHaltReceipt(userId, accountScope)) return false;
  clearBootHaltReceipt(userId, accountScope);
  return true;
}

function centralTime(iso: string | undefined): string {
  if (!iso) return "an unknown time";
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "an unknown time";
  const text = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
  return `${text} CT`;
}

function trimReason(reason: string | undefined): string {
  const text = String(reason ?? "").trim().replace(/[.\s]+$/, "");
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}

/** The user's "Auto-resume on boot" setting, or the AUTONOMY_RESUME_ON_BOOT=1 global override,
 *  exactly as the boot interlock (scheduler.reconcileAutonomyOnBoot) reads them. */
export function effectiveAutoResumeOnBoot(userId: string): boolean {
  return process.env.AUTONOMY_RESUME_ON_BOOT === "1" || getAutoResumeOnBoot(userId);
}

type AppHaltFromAudit = { kind: "breaker" | "auto_pause_lost"; at: string; reason: string };

/** Read one JSON field from an audit payload without letting a malformed payload throw
 *  (json_extract raises on invalid JSON; CASE evaluates only the chosen branch). */
const jsonField = (path: string) => `CASE WHEN json_valid(payload) THEN json_extract(payload, '${path}') END`;

/**
 * For a halted account with no live marker and no boot receipt: did the APP halt it, and has it
 * stayed halted since?  Looks at the latest app-initiated halt in the audit trail (the drawdown
 * breaker with hard action "halted", or a broker-health auto-halt), then for anything after it that
 * re-armed the account or handed the halt to someone else.  Any such later row means the app can no
 * longer say who holds the halt, so this returns undefined.  ">=" plus the id check keeps a row
 * written in the same millisecond as the halt from being missed.  Display-only; never throws.
 */
function lastAppHaltFromAudit(userId: string, connectedAccountId: string | undefined): AppHaltFromAudit | undefined {
  try {
    const db = getDb();
    const account = connectedAccountId ?? null;
    const halt = db
      .prepare(
        `SELECT id, kind, created_at, payload FROM audit_events
         WHERE user_id = ? AND connected_account_id IS ?
           AND (kind = 'broker_placement_auto_halted'
                OR (kind = 'policy_violation_drawdown' AND ${jsonField("$.revertedTo")} = 'halted'))
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(userId, account) as { id: string; kind: string; created_at: string; payload: string } | undefined;
    if (!halt) return undefined;
    const handedOver = db
      .prepare(
        `SELECT 1 FROM audit_events
         WHERE user_id = ? AND connected_account_id IS ? AND created_at >= ? AND id <> ?
           AND (kind IN ('broker_placement_auto_resumed', 'broker_placement_pause_owner_override', 'autonomy_halted_on_boot')
                OR (kind = 'ops_account_control' AND ${jsonField("$.action")} = 'set_system_state' AND ${jsonField("$.dryRun")} = 0)
                OR (kind = 'policy_change' AND ${jsonField("$.value.systemState")} <> 'halted'))
         LIMIT 1`
      )
      .get(userId, account, halt.created_at, halt.id);
    if (handedOver) return undefined;
    let reason = "";
    try {
      const payload = JSON.parse(halt.payload) as { reason?: unknown };
      if (typeof payload.reason === "string") reason = payload.reason;
    } catch {
      /* reason stays empty */
    }
    return { kind: halt.kind === "policy_violation_drawdown" ? "breaker" : "auto_pause_lost", at: halt.created_at, reason };
  } catch {
    return undefined;
  }
}

/**
 * The run-failure watchdog's halt marker, read without importing
 * run-failure-watchdog.ts (which pulls in db-health's `server-only`; the key
 * is duplicated as a literal for the same reason broker-health.ts documents).
 * Key format mirrors runFailureHaltMarkerKey() there.
 */
interface RunFailureHaltMarkerRead {
  since: string;
  reason?: string;
  consecutiveFailures?: number;
}

function getRunFailureHaltMarkerRead(
  userId: string,
  connectedAccountId: string | undefined
): RunFailureHaltMarkerRead | null {
  if (!connectedAccountId) return null;
  try {
    const raw = getInternalSetting<RunFailureHaltMarkerRead>(
      `runFailureHaltMarker:${userId}:${connectedAccountId}`
    );
    if (!raw || typeof raw !== "object" || typeof raw.since !== "string") return null;
    return raw;
  } catch {
    return null;
  }
}

/**
 * Owner-readable cause of a `halted` account, or null for any other state.  Precedence: a live
 * broker auto-pause marker (the app owns the halt and will lift it), then a boot receipt (a restart
 * stopped it and nothing will start it by itself), then an app halt read from the audit trail (the
 * drawdown breaker, or an auto-pause whose resume record is gone), else "no record".  Summaries
 * separate sentences with two spaces (the console renders them with SENTENCE_GAP).
 */
export function describeAutonomyHaltCause(input: {
  userId: string;
  connectedAccountId?: string;
  accountNumber?: string;
  systemState: SystemState;
}): AutonomyHaltCause | null {
  if (input.systemState !== "halted") return null;
  const scope = brokerPauseAccountScope(input.connectedAccountId, input.accountNumber);

  const marker = getBrokerPlacementPauseMarker(input.userId, scope);
  if (marker) {
    const reason = trimReason(marker.reason) || "the broker could not take orders";
    const autoResumeOnBootNow = effectiveAutoResumeOnBoot(input.userId);
    const lastCheck = marker.lastProbeAt
      ? `Last broker check ${centralTime(marker.lastProbeAt)} still failed: ${trimReason(marker.lastProbeReason) || "no reason given"}.  `
      : "No failed broker check recorded since the pause.  ";
    const restartCaveat = autoResumeOnBootNow
      ? ""
      : "Auto-resume on boot is off, so a restart or deploy before the broker recovers ends this auto-pause and leaves the account stopped.  ";
    return {
      kind: "broker_auto_pause",
      resumesOnItsOwn: true,
      since: marker.since,
      reason: marker.reason,
      autoResumeOnBootNow,
      ...(marker.lastProbeAt ? { lastProbeAt: marker.lastProbeAt } : {}),
      ...(marker.lastProbeReason ? { lastProbeReason: marker.lastProbeReason } : {}),
      summary:
        `Paused by the app since ${centralTime(marker.since)}: ${reason}.  ` +
        "It starts again by itself on the first healthy broker check.  " +
        lastCheck +
        restartCaveat +
        "Start Agent resumes it now."
    };
  }

  // Self-healing 2026-09-30: the run-failure watchdog auto-halted this account
  // after a long streak of consecutive strategy-run failures.  Unlike a broker
  // auto-pause it never lifts by itself — the owner re-arms from the console.
  const runFailureMarker = getRunFailureHaltMarkerRead(input.userId, input.connectedAccountId);
  if (runFailureMarker) {
    const reason =
      trimReason(runFailureMarker.reason) ||
      "its strategy runs kept failing";
    const failures = runFailureMarker.consecutiveFailures;
    return {
      kind: "run_failure_halt",
      resumesOnItsOwn: false,
      since: runFailureMarker.since,
      reason: runFailureMarker.reason ?? reason,
      consecutiveFailures: typeof failures === "number" ? failures : 0,
      summary:
        `Auto-halted by the app since ${centralTime(runFailureMarker.since)}: ${reason}.  ` +
        "It will not start by itself.  Start Agent resumes it when the underlying failure is fixed."
    };
  }

  const receipt = getBootHaltReceipt(input.userId, scope);
  if (receipt) {
    const autoResumeOnBootNow = effectiveAutoResumeOnBoot(input.userId);
    const setting = autoResumeOnBootNow
      ? "Auto-resume on boot is on now, so later restarts keep running accounts running."
      : "Auto-resume on boot is off, so every restart or deploy stops running accounts.  Turn it on in Settings (After a restart) to keep them running through restarts.";
    const lead =
      receipt.from === "broker_auto_pause"
        ? `The app had paused this account for a broker problem (${trimReason(receipt.autoPauseReason) || "broker check failed"}).  ` +
          `The restart at ${centralTime(receipt.at)} ended that auto-pause, so it will not start by itself when the broker recovers.`
        : `Stopped by the restart at ${centralTime(receipt.at)}.  It will not start by itself.`;
    return {
      kind: "restart",
      resumesOnItsOwn: false,
      at: receipt.at,
      from: receipt.from,
      ...(receipt.autoPauseReason ? { autoPauseReason: receipt.autoPauseReason } : {}),
      autoResumeOnBootNow,
      summary: `${lead}  Start Agent re-arms it.  ${setting}`
    };
  }

  const appHalt = lastAppHaltFromAudit(input.userId, input.connectedAccountId);
  if (appHalt?.kind === "breaker") {
    return {
      kind: "breaker",
      resumesOnItsOwn: false,
      at: appHalt.at,
      reason: appHalt.reason,
      summary:
        `The drawdown circuit breaker stopped this account at ${centralTime(appHalt.at)}: ${trimReason(appHalt.reason) || "loss limit breached"}.  ` +
        "It will not start by itself.  Start Agent re-arms it."
    };
  }
  if (appHalt?.kind === "auto_pause_lost") {
    return {
      kind: "auto_pause_lost",
      resumesOnItsOwn: false,
      at: appHalt.at,
      reason: appHalt.reason,
      summary:
        `The app paused this account for a broker problem at ${centralTime(appHalt.at)} (${trimReason(appHalt.reason) || "broker check failed"}), ` +
        "but the record that lets it start again by itself is gone.  It will not start by itself.  Start Agent re-arms it."
    };
  }

  return {
    kind: "stopped",
    resumesOnItsOwn: false,
    summary:
      "No automatic pause is holding this account, and the app did not record who or what stopped it.  " +
      "It stays stopped until someone starts it."
  };
}
