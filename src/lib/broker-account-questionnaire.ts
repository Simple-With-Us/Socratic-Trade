// broker-account-questionnaire.ts — classifies a Robinhood order-placement rejection that means
// "the account itself needs owner action" (a suitability/compliance questionnaire Robinhood wants
// answered) as a durable ACCOUNT-LEVEL state, instead of a per-order failure retried every run.
//
// Root cause (2026-09-25, board 687a5fb4, lane G3): production evidence on the live Robinhood
// "Agentic" account showed 3 `placing_failed` rejections carrying the message "We're required to
// have you answer some questions about y[our...]" — a `non_field_errors` entry from Robinhood's
// `place_equity_order`. This is NOT a per-order sizing problem (see broker-minimum-guard.ts for
// that): no resizing, retry, or bump fixes it, because Robinhood is refusing NEW positions on this
// account until the owner answers its questions on robinhood.com — a broker-side account gate this
// app cannot satisfy in code. Retrying it every run just repeats the same guaranteed rejection.
//
// This is a CORRECTNESS fix, not a paternalistic cap: it changes what the app does with an order
// the broker has ALREADY refused for an account-level reason, so exits and existing management are
// never touched — only NEW entries pause, and only for the account the broker actually flagged.
//
// SELF-CLEARING (audit of the merged change, 2026-09-29): the first version cleared the hold only
// when an OPENING order was accepted, yet the run loop refused every opening order while the hold
// was set — so nothing could ever be accepted and the hold could never clear by itself (the owner
// alert even promised it "will clear automatically").  The hold is now HALF-OPEN: it pauses entries
// for `ACCOUNT_ACTION_REQUIRED_PROBE_INTERVAL_MS` after each broker refusal, then lets ONE entry
// through as a probe.  A probe the broker accepts clears the hold (strategy run loop and the
// human-approval path both call `clearAccountActionRequired`); a probe it refuses again re-arms the
// hold for another full interval.  Cost of waiting on an unanswered questionnaire is at most one
// rejected order per interval, never a permanent silent pause.
import { getInternalSetting, setInternalSetting, deleteInternalSetting } from "./db";

const ACCOUNT_ACTION_REQUIRED_PREFIX = "robinhoodAccountActionRequired";

/** Robinhood's own wording for this class of rejection, matched tolerantly (broker copy can vary
 *  in punctuation/trailing text around this core phrase). Scoped to this one class deliberately —
 *  a generic "any 4xx pauses the account" gate would be far too broad and would swallow ordinary
 *  order-specific rejections that have nothing to do with account status. */
const ACCOUNT_QUESTIONNAIRE_PATTERN = /required to have you answer some questions/i;

export interface AccountActionRequiredState {
  reason: string;
  /** When the hold was FIRST set — preserved across re-marks so the owner sees how long it has stood. */
  since: string;
  /** When the broker last refused an order for this reason (each refused probe refreshes it).
   *  Absent on a state persisted by the first version of this module; `since` stands in for it. */
  lastAttemptAt?: string;
}

/** How long entries stay paused after a broker refusal before one probe entry is let through. */
export const ACCOUNT_ACTION_REQUIRED_PROBE_INTERVAL_MS = 6 * 60 * 60_000; // 6 hours

/** Returns a human-readable account-action-required reason when `message` (a broker placement
 *  error) is Robinhood's account-questionnaire rejection, else undefined. Never guesses at other
 *  4xx text — only this one documented, evidence-backed pattern. */
export function detectRobinhoodAccountQuestionnaireError(message: string): string | undefined {
  if (!ACCOUNT_QUESTIONNAIRE_PATTERN.test(message)) return undefined;
  const hours = ACCOUNT_ACTION_REQUIRED_PROBE_INTERVAL_MS / 3_600_000;
  return `Robinhood requires you to answer account questions before it will accept new orders on this account. Log in to Robinhood and complete the questionnaire.  New entries are paused; the app retries one entry every ${hours} hours and resumes on its own as soon as Robinhood accepts an order.`;
}

function accountActionRequiredKey(userId: string, accountNumber: string): string {
  return `${ACCOUNT_ACTION_REQUIRED_PREFIX}:${userId}:${accountNumber}`;
}

const ACCOUNT_ACTION_REQUIRED_ALERT_COOLDOWN_PREFIX = "accountActionRequiredAlertSent";

function accountActionRequiredAlertKey(userId: string, accountNumber: string): string {
  return `${ACCOUNT_ACTION_REQUIRED_ALERT_COOLDOWN_PREFIX}:${userId}:${accountNumber}`;
}

/** Persists the account-level hold.  Idempotent — a repeat detection while already marked keeps the
 *  ORIGINAL `since` and refreshes `reason` and `lastAttemptAt` (which re-arms the retry interval). */
export function markAccountActionRequired(userId: string, accountNumber: string, reason: string, nowMs: number = Date.now()): void {
  const existing = getAccountActionRequired(userId, accountNumber);
  const nowIso = new Date(nowMs).toISOString();
  setInternalSetting(accountActionRequiredKey(userId, accountNumber), {
    reason,
    since: existing?.since ?? nowIso,
    lastAttemptAt: nowIso
  } satisfies AccountActionRequiredState);
}

/** Reads the account-level hold, or undefined when the account is not currently held. */
export function getAccountActionRequired(userId: string, accountNumber: string): AccountActionRequiredState | undefined {
  return getInternalSetting<AccountActionRequiredState>(accountActionRequiredKey(userId, accountNumber));
}

/** Clears the hold — called once an OPENING order for this account is actually accepted by the
 *  broker (autonomous run loop OR a human-approved order), which is the only reliable signal (from
 *  inside this app) that the owner resolved the questionnaire on Robinhood's side.  Safe to call
 *  unconditionally when there is nothing to clear. */
export function clearAccountActionRequired(userId: string, accountNumber: string): void {
  deleteInternalSetting(accountActionRequiredKey(userId, accountNumber));
  // Also reset the owner-alert cooldown: if Robinhood asks again later that is a NEW event and must
  // alert, not be swallowed by the previous episode's 24h window.
  deleteInternalSetting(accountActionRequiredAlertKey(userId, accountNumber));
}

export type AccountActionRequiredGate =
  | { kind: "clear" }
  | { kind: "hold"; state: AccountActionRequiredState }
  | { kind: "probe"; state: AccountActionRequiredState };

/**
 * Decides what the run loop does with an OPENING proposal for this account:
 *  - "clear": nothing is held — proceed normally.
 *  - "hold": the broker refused an order for this reason less than one probe interval ago — pause.
 *  - "probe": the interval has elapsed — proceed as a probe.  The loop does not consume the probe
 *    here; it is spent only when an order actually reaches the broker (accepted -> clear, refused
 *    -> `markAccountActionRequired` re-arms the interval), so a candidate that is blocked by some
 *    other gate before placement does not waste it.
 * An unparseable timestamp probes rather than holding forever.
 */
export function evaluateAccountActionRequiredGate(
  userId: string,
  accountNumber: string,
  nowMs: number = Date.now()
): AccountActionRequiredGate {
  const state = getAccountActionRequired(userId, accountNumber);
  if (!state) return { kind: "clear" };
  const lastAttemptMs = Date.parse(state.lastAttemptAt ?? state.since);
  if (Number.isFinite(lastAttemptMs) && nowMs - lastAttemptMs < ACCOUNT_ACTION_REQUIRED_PROBE_INTERVAL_MS) {
    return { kind: "hold", state };
  }
  return { kind: "probe", state };
}

// This condition does not clear itself run to run (it is a standing broker-side account gate, not
// a transient outage), so re-notifying every run would just be noise until the owner acts — same
// rationale as SUB_MINIMUM_ALERT_COOLDOWN_MS in broker-minimum-guard.ts.
const ACCOUNT_ACTION_REQUIRED_ALERT_COOLDOWN_MS = 24 * 60 * 60_000; // 24 hours

/** Cooldown-gated: returns true (and marks the cooldown) at most once per (user, accountNumber)
 *  per `ACCOUNT_ACTION_REQUIRED_ALERT_COOLDOWN_MS` window. Callers must still skip placing new
 *  entries for this account regardless of this return value; it only gates whether an outward
 *  alert/notification fires this run. */
export function shouldAlertAccountActionRequired(userId: string, accountNumber: string): boolean {
  const key = accountActionRequiredAlertKey(userId, accountNumber);
  const last = getInternalSetting<string>(key);
  if (last && Date.now() - Date.parse(last) < ACCOUNT_ACTION_REQUIRED_ALERT_COOLDOWN_MS) return false;
  setInternalSetting(key, new Date().toISOString());
  return true;
}
