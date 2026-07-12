import type { ConnectedAccount, ExecutionMode, FillSource, TradingPolicy } from "./types";

export type LlmExecutionMode = ExecutionMode;

// taxationType is included so the strategy prompt builder can classify an IRA buyer with the same
// source-of-truth precedence as the wash-sale gate (isIraTaxRegime). The runtime value passed here
// is the full ConnectedAccount row, so this only widens the compile-time view — no call site change.
export type ExecutionAccount = Pick<ConnectedAccount, "id" | "broker" | "environment" | "accountNumber" | "label" | "capabilities" | "taxationType">;

export interface ExecutionState {
  /**
   * Undefined only when there is no connected account. An account is an account: a broker paper
   * account (e.g. Alpaca paper) is `"broker/paper"`, a live account is `"broker/live"` — purely a
   * function of `activeAccount.environment`. There is no local-simulation fallback: with no
   * connected account the app cannot place orders, and callers that execute orders MUST check
   * `mode` and refuse to run rather than synthesize a fake fill.
   */
  mode?: ExecutionMode;
  label: "Paper" | "Brokerage" | "No account";
  broker?: ExecutionAccount["broker"];
  environment?: ExecutionAccount["environment"];
  accountId?: string;
  accountNumber?: string;
  accountLabel?: string;
  /** True once a real (paper or live) broker connection is in play — false only for "No account". */
  submitsBrokerOrders: boolean;
  clarification: string;
}

type ExecutionPolicy = Pick<TradingPolicy, "accountNumber" | "connectedAccountId" | "activeBroker">;

/**
 * An account is an account: this derives execution state purely from the connected account's
 * `environment` (paper vs live). With no connected account, it returns a "No account" state
 * (`mode: undefined`, `submitsBrokerOrders: false`) — callers that place orders must check `mode`
 * and refuse to run rather than fall back to any local/simulated fill.
 */
export function deriveExecutionState(policy: ExecutionPolicy, activeAccount?: ExecutionAccount): ExecutionState {
  if (!activeAccount) {
    return {
      mode: undefined,
      label: "No account",
      accountId: policy.connectedAccountId,
      accountNumber: policy.accountNumber,
      submitsBrokerOrders: false,
      clarification:
        "No connected broker account. Connect a broker account (paper or live) before the app can place orders."
    };
  }

  if (activeAccount.environment === "paper") {
    const isTestAccount = activeAccount.broker === "test";
    return {
      mode: "broker/paper",
      label: "Paper",
      broker: activeAccount.broker,
      environment: activeAccount.environment,
      accountId: activeAccount.id,
      accountNumber: activeAccount.accountNumber ?? policy.accountNumber,
      accountLabel: activeAccount.label,
      submitsBrokerOrders: true,
      clarification:
        isTestAccount
          ? "Test Account - Local Mock Paper Account uses local simulated fills. It is not a broker account and cannot reach real money."
          : `${brokerLabel(activeAccount.broker)} Paper is a broker-hosted sandbox account; real capital is not at risk.`
    };
  }

  return {
    mode: "broker/live",
    label: "Brokerage",
    broker: activeAccount.broker,
    environment: activeAccount.environment,
    accountId: activeAccount.id,
    accountNumber: activeAccount.accountNumber ?? policy.accountNumber,
    accountLabel: activeAccount.label,
    submitsBrokerOrders: true,
    clarification:
      `${brokerLabel(activeAccount.broker)} Brokerage is a broker production account. Broker orders can reach real capital only when policy, approval, and risk gates allow them.`
  };
}

export function llmExecutionMode(state: ExecutionState): LlmExecutionMode | undefined {
  return state.mode;
}

export function llmModeClarification(state: ExecutionState): string {
  return state.clarification;
}

export function llmFillSource(source: FillSource, executionState?: ExecutionState): LlmExecutionMode | undefined {
  if (executionState) return executionState.mode;
  return source === "paper" ? "broker/paper" : "broker/live";
}

export function fillSourceForExecutionMode(stateOrMode: ExecutionState | ExecutionMode | undefined): FillSource {
  const mode = typeof stateOrMode === "string" ? stateOrMode : stateOrMode?.mode;
  return mode === "broker/live" ? "live" : "paper";
}

function brokerLabel(broker: ExecutionAccount["broker"]): string {
  return (broker === "alpaca" || broker === "alpaca-mcp") ? "Alpaca" : broker === "test" ? "Test" : "Robinhood";
}
