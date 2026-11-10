// Run-scoped account resolution.
//
// A strategy run is handed exactly ONE account-scoped policy: `getPolicy(userId, connectedAccountId)`
// stamps `policy.connectedAccountId` with the account whose live state it read, and every derived
// clone the run builds (gatePolicy, runPolicy) carries it forward.  Anything the run then derives —
// venue capabilities, execution state, the account's strategy prompt — must come from THAT account.
//
// Re-asking "which account is active in the console right now?" from inside a run is the bug this
// module exists to make hard.  With two accounts connected, the console pointer is simply not the
// run's account; worse, the owner can move that pointer while a run is in flight, so the answer can
// change underneath a single run.  A second, independent resolution also lets one piece of the same
// review read account A's venue while another reads account B's prompt.
//
// Resolve ONCE via `resolveRunAccountScope`, then read the account AND its prompt off the returned
// scope.  Both parameters are required and the run branch has no active-account fallback — there is
// deliberately no "just use whatever is active" default to reach for.

import { getActiveConnectedAccount, getConnectedAccount } from "./db-api-keys";
import { getStrategyPrompt } from "./db-profiles";
import type { ConnectedAccount, TradingPolicy } from "./types";

export interface RunAccountScope {
  /** The one account this work is scoped to.  Undefined only when nothing resolves at all. */
  account: ConnectedAccount | undefined;
  /** `account?.id`, hoisted for audit/telemetry call sites that only need the id. */
  connectedAccountId: string | undefined;
  /**
   * The strategy prompt belonging to `account` — resolved from the same account, so a review can
   * never reason from one account's custom prompt while judging another account's venue.
   */
  strategyPrompt: string;
  /**
   * How the account was resolved.  `"run"` = named by the policy (the normal in-run case);
   * `"active"` = no run scope, so the console's active account applies (pure console callers);
   * `"none"` = nothing resolved, including a run whose account no longer exists.
   */
  source: "run" | "active" | "none";
}

/**
 * Resolve the account a piece of run-scoped work belongs to, plus that account's strategy prompt.
 *
 * When `policy.connectedAccountId` is set the run has named its account: resolve exactly that one.
 * If it no longer exists (deleted or reassigned mid-run) the scope resolves to "no account" rather
 * than silently substituting whichever account the console happens to point at — a substituted
 * account is precisely the failure this guards against, and a fail-closed "no account" is the
 * honest answer.
 *
 * Only when there is genuinely no run scope (no `connectedAccountId` on the policy at all — an
 * ad-hoc console or single-context caller) does this fall back to the active account, which
 * reproduces today's behavior byte-for-byte for those callers.
 */
export function resolveRunAccountScope(
  userId: string,
  policy: Pick<TradingPolicy, "connectedAccountId">
): RunAccountScope {
  if (policy.connectedAccountId) {
    const account = getConnectedAccount(policy.connectedAccountId, userId);
    return {
      account,
      connectedAccountId: account?.id,
      strategyPrompt: getStrategyPrompt(userId, policy.connectedAccountId),
      source: account ? "run" : "none"
    };
  }

  const account = getActiveConnectedAccount(userId);
  return {
    account,
    connectedAccountId: account?.id,
    strategyPrompt: getStrategyPrompt(userId, account?.id),
    source: account ? "active" : "none"
  };
}
