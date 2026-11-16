import type { TradingPolicy } from "./types";

export const STOPPED_PROPOSAL_ACTION_TITLE = "Start the system first.";
export const STOPPED_PROPOSAL_ACTION_DESCRIPTION =
  "Run once can create proposals while stopped, but accepting or rejecting a proposal requires the system to be running.";
export const STOPPED_PROPOSAL_ACTION_MESSAGE = `${STOPPED_PROPOSAL_ACTION_TITLE} ${STOPPED_PROPOSAL_ACTION_DESCRIPTION}`;

/** Honest annotation on an opening card while the account is Exit-only. */
export const EXIT_ONLY_OWNER_APPROVE_NOTE =
  "This account is Exit-only, so the agent will not open new risk on its own.  Approving this opening places it anyway.";

export function isProposalActionStopped(policy: Pick<TradingPolicy, "systemState">): boolean {
  return policy.systemState === "halted";
}
