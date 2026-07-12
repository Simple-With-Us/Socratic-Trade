import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import { deriveExecutionState, fillSourceForExecutionMode, llmExecutionMode, llmFillSource, llmModeClarification, type ExecutionAccount } from "../src/lib/execution-mode";

const alpacaPaperAccount: ExecutionAccount = {
  id: "alpaca-paper",
  broker: "alpaca",
  environment: "paper",
  accountNumber: "APCA-PAPER",
  label: "Alpaca Paper"
};

const alpacaLiveAccount: ExecutionAccount = {
  ...alpacaPaperAccount,
  id: "alpaca-live",
  environment: "live",
  accountNumber: "APCA-LIVE",
  label: "Alpaca Live"
};

describe("deriveExecutionState", () => {
  it("derives Paper from a connected broker paper account — an account is an account", () => {
    const state = deriveExecutionState(DEFAULT_POLICY, alpacaPaperAccount);

    expect(state.mode).toBe("broker/paper");
    expect(state.label).toBe("Paper");
    expect(state.broker).toBe("alpaca");
    expect(state.environment).toBe("paper");
    expect(state.submitsBrokerOrders).toBe(true);
    expect(state.clarification).toContain("Alpaca Paper");
    expect(state.clarification).toContain("real capital is not at risk");
    expect(fillSourceForExecutionMode(state)).toBe("paper");
    expect(llmFillSource("paper", state)).toBe("broker/paper");
    expect(llmExecutionMode(state)).toBe("broker/paper");
  });

  it("derives Brokerage from a connected broker live account", () => {
    const state = deriveExecutionState(DEFAULT_POLICY, alpacaLiveAccount);

    expect(state.mode).toBe("broker/live");
    expect(state.label).toBe("Brokerage");
    expect(state.environment).toBe("live");
    expect(state.submitsBrokerOrders).toBe(true);
    expect(state.clarification).toContain("real capital");
    expect(fillSourceForExecutionMode(state)).toBe("live");
    expect(llmFillSource("live", state)).toBe("broker/live");
  });

  it("returns a 'No account' state with no local-simulation fallback when no account is connected", () => {
    const state = deriveExecutionState({ ...DEFAULT_POLICY, activeBroker: "alpaca" }, undefined);

    expect(state.mode).toBeUndefined();
    expect(state.label).toBe("No account");
    expect(state.submitsBrokerOrders).toBe(false);
    expect(fillSourceForExecutionMode(state)).toBe("paper");
    expect(llmExecutionMode(state)).toBeUndefined();
    expect(llmModeClarification(state)).toContain("Connect a broker account");
  });
});
