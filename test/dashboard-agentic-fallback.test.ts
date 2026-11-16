/**
 * connectedAccountAgenticFallback — derives agentic-allowed for a STORED connected account when the
 * live broker enumeration is unavailable (so the readiness badge resolves instead of false-warning).
 */
import { describe, expect, it } from "vitest";
import { accountReadinessForSnapshot, connectedAccountAgenticFallback } from "../src/lib/dashboard";
import { getAccountsTimeoutMessage } from "../src/lib/inflight-deadline";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import type { BrokerageAccount, ConnectedAccount, TradingPolicy } from "../src/lib/types";

function policy(patch: Partial<TradingPolicy> = {}): TradingPolicy {
  return {
    ...DEFAULT_POLICY,
    activeBroker: "alpaca",
    accountNumber: "A1",
    connectedAccountId: "acct-1",
    ...patch
  };
}

function connectedAccount(patch: Partial<ConnectedAccount> = {}): ConnectedAccount {
  return {
    id: "acct-1",
    userId: "local",
    broker: "alpaca",
    environment: "paper",
    accountNumber: "A1",
    label: "Alpaca Paper",
    isActive: true,
    createdAt: "2026-06-27T00:00:00.000Z",
    updatedAt: "2026-06-27T00:00:00.000Z",
    ...patch
  };
}

function brokerageAccount(patch: Partial<BrokerageAccount> = {}): BrokerageAccount {
  return {
    accountNumber: "A1",
    label: "Alpaca Paper",
    agenticAllowed: true,
    ...patch
  };
}

describe("connectedAccountAgenticFallback", () => {
  it("Robinhood: brokerage is allowed, IRA/Roth is not (mirrors the live gateway default)", () => {
    expect(connectedAccountAgenticFallback({ broker: "robinhood", capabilities: { accountType: "brokerage" } })).toBe(true);
    expect(connectedAccountAgenticFallback({ broker: "robinhood" })).toBe(true); // missing type → brokerage default
    expect(connectedAccountAgenticFallback({ broker: "robinhood", capabilities: { accountType: "roth_ira" } })).toBe(false);
    expect(connectedAccountAgenticFallback({ broker: "robinhood", capabilities: { accountType: "traditional_ira" } })).toBe(false);
  });

  it("Alpaca / Alpaca-MCP / Test: agentic-allowed for all their accounts", () => {
    expect(connectedAccountAgenticFallback({ broker: "alpaca", capabilities: { accountType: "roth_ira" } })).toBe(true);
    expect(connectedAccountAgenticFallback({ broker: "alpaca-mcp" })).toBe(true);
    expect(connectedAccountAgenticFallback({ broker: "test" })).toBe(true);
  });
});

describe("accountReadinessForSnapshot", () => {
  it("blocks Robinhood when OAuth health is missing", () => {
    const readiness = accountReadinessForSnapshot({
      policy: policy({ activeBroker: "robinhood" }),
      activeAccount: connectedAccount({ broker: "robinhood", environment: "live", label: "Agentic" }),
      liveAccounts: [brokerageAccount({ label: "Agentic" })],
      robinhoodMcpHealth: {
        adapter: "mcp",
        ok: false,
        configured: true,
        authenticated: false,
        protocolVersion: "2025-03-26",
        transport: "http+sse",
        tools: [],
        checkedAt: "2026-06-27T00:00:00.000Z",
        error: "No Robinhood MCP access token is stored or configured."
      }
    });

    expect(readiness.ok).toBe(false);
    expect(readiness.reason).toContain("Reconnect Robinhood OAuth");
    expect(readiness.detail).toContain("No Robinhood MCP access token");
  });

  it("still fail-closes Run once after the getAccounts retry budget is exhausted", () => {
    const readiness = accountReadinessForSnapshot({
      policy: policy(),
      activeAccount: connectedAccount(),
      liveAccounts: [],
      brokerAccountReadError: getAccountsTimeoutMessage()
    });

    expect(readiness.ok).toBe(false);
    expect(readiness.detail).toBe(getAccountsTimeoutMessage());
    expect(readiness.detail).not.toMatch(/after 6000ms\.$/);
  });

  it("blocks Alpaca when broker account enumeration fails", () => {
    const readiness = accountReadinessForSnapshot({
      policy: policy(),
      activeAccount: connectedAccount(),
      liveAccounts: [],
      brokerAccountReadError: "Alpaca credentials rejected"
    });

    expect(readiness.ok).toBe(false);
    expect(readiness.reason).toContain("Alpaca account check failed");
    expect(readiness.detail).toContain("Alpaca credentials rejected");
  });

  it("blocks Alpaca when the selected account is missing from live broker accounts", () => {
    const readiness = accountReadinessForSnapshot({
      policy: policy(),
      activeAccount: connectedAccount(),
      liveAccounts: [brokerageAccount({ accountNumber: "OTHER" })]
    });

    expect(readiness.ok).toBe(false);
    expect(readiness.reason).toContain("not available from the broker");
  });

  it("blocks broker accounts that are not agentic-allowed", () => {
    const readiness = accountReadinessForSnapshot({
      policy: policy(),
      activeAccount: connectedAccount(),
      liveAccounts: [brokerageAccount({ agenticAllowed: false })]
    });

    expect(readiness.ok).toBe(false);
    expect(readiness.reason).toContain("not approved for agentic execution");
  });

  it("blocks when the selected account portfolio data cannot be read", () => {
    const readiness = accountReadinessForSnapshot({
      policy: policy(),
      activeAccount: connectedAccount(),
      liveAccounts: [brokerageAccount()],
      portfolioReadError: "Alpaca balance endpoint rejected the request"
    });

    expect(readiness.ok).toBe(false);
    expect(readiness.reason).toContain("account data check failed");
    expect(readiness.detail).toContain("balance endpoint rejected");
  });

  it("allows the local Test-broker account when selected — an account is an account, same readiness path", () => {
    // TestBrokerGateway.getAccounts() always reports accountNumber "TEST"-shaped, agentic-allowed —
    // no special-cased bypass anymore, so liveAccounts must include the matching entry like any broker.
    const readiness = accountReadinessForSnapshot({
      policy: policy({ activeBroker: "test", accountNumber: "test-local", connectedAccountId: "test-1" }),
      activeAccount: connectedAccount({
        id: "test-1",
        broker: "test",
        accountNumber: "test-local",
        label: "Test"
      }),
      liveAccounts: [brokerageAccount({ accountNumber: "test-local", label: "Test" })]
    });

    expect(readiness.ok).toBe(true);
    expect(readiness.detail).toContain("Selected Test account");
  });

  it("blocks the local Test-broker account read error like any other broker (no special bypass)", () => {
    // portfolioReadError still blocks — a Test-broker connected account is no longer exempt from the
    // standard readiness checks that apply to every other broker.
    const readiness = accountReadinessForSnapshot({
      policy: policy({ activeBroker: "test", accountNumber: "TEST", connectedAccountId: "test-1" }),
      activeAccount: connectedAccount({
        id: "test-1",
        broker: "test",
        accountNumber: "TEST",
        label: "Test"
      }),
      liveAccounts: [brokerageAccount({ accountNumber: "TEST", label: "Test" })],
      portfolioReadError: "Real-time quote for symbol XYZ is unavailable."
    });

    expect(readiness.ok).toBe(false);
    expect(readiness.reason).toContain("account data check failed");
    expect(readiness.detail).toContain("Real-time quote for symbol XYZ is unavailable");
  });
});
