import { describe, expect, it } from "vitest";

import type { DashboardSnapshot } from "../app/dashboard-types";
import { deriveReadinessChecklist } from "../app/console/lib/derive";
import type { ConnectedAccount, TradingPolicy } from "../src/lib/types";

function account(partial: Partial<ConnectedAccount> & Pick<ConnectedAccount, "id">): ConnectedAccount {
  return {
    userId: "u1",
    broker: "alpaca",
    environment: "paper",
    label: partial.label ?? "Paper",
    accountNumber: partial.accountNumber ?? "PA-1",
    isActive: partial.isActive ?? false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...partial
  } as ConnectedAccount;
}

function snapshotWith(input: {
  connectedAccounts?: ConnectedAccount[];
  policy?: Partial<TradingPolicy>;
  llmConfigured?: boolean;
  latestStrategyRun?: DashboardSnapshot["latestStrategyRun"];
  strategyRuns?: DashboardSnapshot["strategyRuns"];
  pendingProposals?: DashboardSnapshot["pendingProposals"];
  recentProposals?: DashboardSnapshot["recentProposals"];
}): DashboardSnapshot {
  return {
    positions: [],
    connectedAccounts: input.connectedAccounts ?? [],
    dailyStats: { orderCount: 0, openingOrderCount: 0, notional: 0 },
    llmConfigured: input.llmConfigured,
    latestStrategyRun: input.latestStrategyRun,
    strategyRuns: input.strategyRuns ?? [],
    pendingProposals: input.pendingProposals ?? [],
    recentProposals: input.recentProposals,
    policy: {
      systemState: "halted",
      strategyAuthority: "propose",
      includedIndices: [],
      additionalSymbols: [],
      maxDailyOrders: 6,
      ...input.policy
    } as TradingPolicy,
    accounts: [],
    orders: [],
    audit: [],
    auditFeed: [],
    unifiedFeed: [],
    strategyPrompt: "",
    notifications: [],
    symbolMetaBySymbol: {},
    profiles: [],
    notificationStatus: { configured: false, enabledEvents: [] },
    robinhoodMcpConnected: false,
    autoResumeOnBoot: false
  } as unknown as DashboardSnapshot;
}

describe("deriveReadinessChecklist", () => {
  it("reports not ready with every step incomplete on a greenfield snapshot", () => {
    const checklist = deriveReadinessChecklist(snapshotWith({ llmConfigured: false }));

    expect(checklist.ready).toBe(false);
    expect(checklist.completedCount).toBe(0);
    expect(checklist.totalCount).toBe(5);
    expect(checklist.flags).toEqual({
      hasBroker: false,
      hasActiveAccount: false,
      hasUniverse: false,
      hasLlmKey: false,
      hasGreenModel: false,
      hasRunOnce: false
    });
    expect(checklist.steps.map((s) => s.id)).toEqual([
      "connect-broker",
      "active-account",
      "universe",
      "llm",
      "run-once"
    ]);
    expect(checklist.steps.every((s) => !s.complete)).toBe(true);
    expect(checklist.steps.find((s) => s.id === "connect-broker")?.href).toBe(
      "/console/connections#brokers"
    );
    expect(checklist.steps.find((s) => s.id === "llm")?.href).toBe("/console/connections#api-keys");
  });

  it("never marks ready when broker is missing even if other fields look complete", () => {
    const checklist = deriveReadinessChecklist(
      snapshotWith({
        llmConfigured: true,
        policy: {
          includedIndices: ["sp500"],
          llmModel: "openrouter/anthropic/claude-sonnet-4",
          accountNumber: "PA-1"
        },
        strategyRuns: [{ id: "r1" } as DashboardSnapshot["strategyRuns"][number]]
      })
    );

    expect(checklist.flags.hasBroker).toBe(false);
    expect(checklist.flags.hasUniverse).toBe(true);
    expect(checklist.flags.hasLlmKey).toBe(true);
    expect(checklist.flags.hasGreenModel).toBe(true);
    expect(checklist.flags.hasRunOnce).toBe(true);
    expect(checklist.ready).toBe(false);
  });

  it("requires an active or policy-selected account, not merely any connected row", () => {
    const connected = [
      account({ id: "a1", isActive: false, accountNumber: "PA-1" }),
      account({ id: "a2", isActive: false, accountNumber: "PA-2" })
    ];
    const noneActive = deriveReadinessChecklist(snapshotWith({ connectedAccounts: connected }));
    expect(noneActive.flags.hasBroker).toBe(true);
    expect(noneActive.flags.hasActiveAccount).toBe(false);
    expect(noneActive.steps.find((s) => s.id === "active-account")?.href).toBe(
      "/console/connections#brokers"
    );

    const viaIsActive = deriveReadinessChecklist(
      snapshotWith({
        connectedAccounts: [account({ id: "a1", isActive: true })]
      })
    );
    expect(viaIsActive.flags.hasActiveAccount).toBe(true);

    const viaPolicyId = deriveReadinessChecklist(
      snapshotWith({
        connectedAccounts: connected,
        policy: { connectedAccountId: "a2" }
      })
    );
    expect(viaPolicyId.flags.hasActiveAccount).toBe(true);
  });

  it("treats includedIndices or additionalSymbols as universe configured", () => {
    expect(
      deriveReadinessChecklist(
        snapshotWith({ policy: { includedIndices: ["sp500"], additionalSymbols: [] } })
      ).flags.hasUniverse
    ).toBe(true);
    expect(
      deriveReadinessChecklist(
        snapshotWith({ policy: { includedIndices: [], additionalSymbols: ["AAPL"] } })
      ).flags.hasUniverse
    ).toBe(true);
    expect(
      deriveReadinessChecklist(
        snapshotWith({ policy: { includedIndices: [], additionalSymbols: [] } })
      ).flags.hasUniverse
    ).toBe(false);
    expect(
      deriveReadinessChecklist(
        snapshotWith({ policy: { includedIndices: [], additionalSymbols: [] } })
      ).steps.find((s) => s.id === "universe")?.href
    ).toBe("/console/guardrails");
  });

  it("requires both LLM key and Green model — no false ready on key-only or model-only", () => {
    const keyOnly = deriveReadinessChecklist(
      snapshotWith({ llmConfigured: true, policy: { llmModel: "" } })
    );
    expect(keyOnly.flags.hasLlmKey).toBe(true);
    expect(keyOnly.flags.hasGreenModel).toBe(false);
    expect(keyOnly.steps.find((s) => s.id === "llm")?.complete).toBe(false);
    expect(keyOnly.steps.find((s) => s.id === "llm")?.href).toBe("/console/strategy#models");

    const modelOnly = deriveReadinessChecklist(
      snapshotWith({
        llmConfigured: false,
        policy: { llmModel: "openrouter/openai/gpt-4o" }
      })
    );
    expect(modelOnly.flags.hasLlmKey).toBe(false);
    expect(modelOnly.flags.hasGreenModel).toBe(true);
    expect(modelOnly.steps.find((s) => s.id === "llm")?.complete).toBe(false);
    expect(modelOnly.steps.find((s) => s.id === "llm")?.href).toBe("/console/connections#api-keys");

    // Older payloads omit llmConfigured — do not treat as missing key.
    const legacyKey = deriveReadinessChecklist(
      snapshotWith({ policy: { llmModel: "openrouter/openai/gpt-4o" } })
    );
    expect(legacyKey.flags.hasLlmKey).toBe(true);
    expect(legacyKey.steps.find((s) => s.id === "llm")?.complete).toBe(true);
  });

  it("marks run-once from strategyRuns, latestStrategyRun, pending, or recent proposals", () => {
    expect(deriveReadinessChecklist(snapshotWith({})).flags.hasRunOnce).toBe(false);
    expect(
      deriveReadinessChecklist(
        snapshotWith({ strategyRuns: [{ id: "r1" } as DashboardSnapshot["strategyRuns"][number]] })
      ).flags.hasRunOnce
    ).toBe(true);
    expect(
      deriveReadinessChecklist(
        snapshotWith({
          latestStrategyRun: { runId: "r", status: "completed", summary: "ok", proposals: [] }
        })
      ).flags.hasRunOnce
    ).toBe(true);
    expect(
      deriveReadinessChecklist(
        snapshotWith({
          pendingProposals: [{ id: "p1" } as DashboardSnapshot["pendingProposals"][number]]
        })
      ).flags.hasRunOnce
    ).toBe(true);
    expect(
      deriveReadinessChecklist(
        snapshotWith({
          recentProposals: [{ id: "rp1" } as NonNullable<DashboardSnapshot["recentProposals"]>[number]]
        })
      ).flags.hasRunOnce
    ).toBe(true);
    expect(
      deriveReadinessChecklist(
        snapshotWith({
          strategyRuns: [{ id: "r1" } as DashboardSnapshot["strategyRuns"][number]]
        })
      ).steps.find((s) => s.id === "run-once")?.href
    ).toBeUndefined();
    // Incomplete run-once step points at chrome (no href) — not empty Proposals.
    const incompleteRunOnce = deriveReadinessChecklist(snapshotWith({})).steps.find(
      (s) => s.id === "run-once"
    );
    expect(incompleteRunOnce?.href).toBeUndefined();
    expect(incompleteRunOnce?.ctaLabel).toMatch(/top bar/i);
  });

  it("is ready only when all five flags are true", () => {
    const checklist = deriveReadinessChecklist(
      snapshotWith({
        connectedAccounts: [account({ id: "a1", isActive: true, label: "Alpaca paper" })],
        llmConfigured: true,
        policy: {
          includedIndices: ["sp500"],
          additionalSymbols: [],
          llmModel: "openrouter/anthropic/claude-sonnet-4",
          connectedAccountId: "a1",
          accountNumber: "PA-1"
        },
        strategyRuns: [{ id: "r1" } as DashboardSnapshot["strategyRuns"][number]]
      })
    );

    expect(checklist.ready).toBe(true);
    expect(checklist.completedCount).toBe(5);
    expect(checklist.steps.every((s) => s.complete && !s.href)).toBe(true);
    expect(checklist.flags).toEqual({
      hasBroker: true,
      hasActiveAccount: true,
      hasUniverse: true,
      hasLlmKey: true,
      hasGreenModel: true,
      hasRunOnce: true
    });
  });
});
