import { describe, expect, it } from "vitest";
import {
  EXIT_ONLY_OWNER_APPROVE_NOTE,
  STOPPED_PROPOSAL_ACTION_DESCRIPTION,
  STOPPED_PROPOSAL_ACTION_MESSAGE,
  STOPPED_PROPOSAL_ACTION_TITLE,
  isProposalActionStopped
} from "../src/lib/proposal-actions";

describe("proposal action run-state gate", () => {
  it("blocks proposal actions only when the system is stopped", () => {
    expect(isProposalActionStopped({ systemState: "halted" })).toBe(true);
    expect(isProposalActionStopped({ systemState: "active" })).toBe(false);
    expect(isProposalActionStopped({ systemState: "close_only" })).toBe(false);
  });

  it("uses clear start-system wording for UI toasts and API responses", () => {
    expect(STOPPED_PROPOSAL_ACTION_TITLE).toBe("Start the system first.");
    expect(STOPPED_PROPOSAL_ACTION_DESCRIPTION).toContain("accepting or rejecting a proposal");
    expect(STOPPED_PROPOSAL_ACTION_MESSAGE).toContain("Start the system first");
  });

  it("names owner Approve as the Exit-only override on an opening card", () => {
    expect(EXIT_ONLY_OWNER_APPROVE_NOTE).toContain("agent will not open new risk on its own");
    expect(EXIT_ONLY_OWNER_APPROVE_NOTE).toContain("Approving this opening places it anyway");
  });
});
