import { deleteInternalSetting, getAutoResumeOnBoot, getInternalSetting, setInternalSetting } from "./db";
import { brokerPauseAccountScope, getBrokerPlacementPauseMarker } from "./broker-health";
import type { SystemState } from "./types";

// Why is this account halted, and will it start again by itself?  (Board 687a5fb4, lane h5.)
//
// Production 2026-09-25..29: Alpaca Paper was auto-halted by a broker-health probe timeout at
// 18:20Z, and stayed halted with no runs for four days until an operator re-armed it.  The deploy
// of #3752 (2026-09-26 00:35Z) and the weekend restarts ran the boot autonomy interlock, which,
// with the user's "Auto-resume on boot" off, hands a broker auto-pause to the owner (drops the
// auto-resume marker) exactly as it halts a Running account.  That is the owner's setting working
// as designed.  What was wrong is that nothing on the console, in the ops snapshot, or in the
// notification title said so: the account read as a plain "Stopped", and the boot notification
// said the auto-pause was "kept".
//
// This module records what the boot interlock did to each account (a receipt) and turns the
// durable state into one honest answer: paused by the app and resuming by itself, stopped by a
// restart, or stopped by a person.

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
      /** The app paused the account and lifts the pause itself on the first healthy broker check. */
      resumesOnItsOwn: true;
      since: string;
      reason: string;
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

/**
 * Owner-readable cause of a `halted` account, or null for any other state.  Precedence: a live
 * broker auto-pause marker (the app owns the halt and will lift it), then a boot receipt (a restart
 * stopped it and nothing will start it by itself), else a manual stop.  Summaries separate
 * sentences with two spaces (the console renders them with SENTENCE_GAP).
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
    return {
      kind: "broker_auto_pause",
      resumesOnItsOwn: true,
      since: marker.since,
      reason: marker.reason,
      summary:
        `Paused by the app since ${centralTime(marker.since)}: ${reason}.  ` +
        "It starts again by itself on the first healthy broker check.  Start Agent resumes it now."
    };
  }

  const receipt = getBootHaltReceipt(input.userId, scope);
  if (receipt) {
    const autoResumeOnBootNow = getAutoResumeOnBoot(input.userId) || process.env.AUTONOMY_RESUME_ON_BOOT === "1";
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

  return {
    kind: "stopped",
    resumesOnItsOwn: false,
    summary: "Stopped by a person, or before the app recorded why.  It stays stopped until someone starts it."
  };
}
