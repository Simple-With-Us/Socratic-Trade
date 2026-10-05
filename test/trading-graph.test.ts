import { describe, expect, it } from "vitest";
import {
  TradingGraph,
  type GraphContext,
  type GraphState,
  type GraphNode,
  type GraphTransitionRecord,
} from "../src/lib/orchestration/trading-graph";
import { DEFAULT_POLICY, type TradingPolicy, type TradeProposal } from "../src/lib/types";
import { evaluateAlternativeDataAnalysis } from "../src/lib/strategy";

function isGraphTransitionRecordArray(value: unknown): value is GraphTransitionRecord[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        item !== null &&
        typeof item === "object" &&
        "from" in item &&
        "to" in item &&
        "timestamp" in item &&
        "durationMs" in item
    )
  );
}

function createMockContext(overrides?: Partial<GraphContext>): GraphContext {
  return {
    runId: "test-run-1",
    policy: { ...DEFAULT_POLICY },
    mode: "dry-run",
    userId: "test-user",
    connectedAccountId: "test-account",
    proposals: [],
    errors: [],
    metadata: {},
    ...overrides,
  };
}

describe("TradingGraph Orchestration Engine", () => {
  it("executes standard node flow from INIT through ALTERNATIVE_DATA_ANALYSIS to COMPLETED", async () => {
    const context = createMockContext();
    const transitions: Array<{ from: GraphState; to: GraphState }> = [];

    const graph = new TradingGraph(context, {
      onTransition: (rec) => {
        transitions.push({ from: rec.from, to: rec.to });
      },
    });

    graph.registerNode({
      name: "INIT",
      execute: async (ctx) => ({
        nextState: "ALTERNATIVE_DATA_ANALYSIS",
        context: ctx,
      }),
    });

    graph.registerNode({
      name: "ALTERNATIVE_DATA_ANALYSIS",
      execute: async (ctx) => ({
        nextState: "FUNDAMENTAL_PROPOSING",
        context: {
          ...ctx,
          metadata: {
            ...ctx.metadata,
            alternativeData: {
              congressVerdict: { pass: true, verdict: "PASS" },
              macroRegime: "RISK_ON",
            },
          },
        },
      }),
    });

    graph.registerNode({
      name: "FUNDAMENTAL_PROPOSING",
      execute: async (ctx) => ({
        nextState: "RED_TEAM_REVIEW",
        context: {
          ...ctx,
          proposals: [
            {
              symbol: "AAPL",
              side: "buy",
              type: "market",
              timeInForce: "day",
              marketHours: "regular_only",
              rationale: "Strong alternative & fundamental alignment",
            },
          ],
        },
      }),
    });

    graph.registerNode({
      name: "RED_TEAM_REVIEW",
      execute: async (ctx) => ({
        nextState: "EXECUTION",
        context: ctx,
      }),
    });

    graph.registerNode({
      name: "EXECUTION",
      execute: async (ctx) => ({
        nextState: "COMPLETED",
        context: ctx,
      }),
    });

    const result = await graph.run();

    expect(graph.getCurrentState()).toBe("COMPLETED");
    expect(result.errors).toHaveLength(0);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0].symbol).toBe("AAPL");

    // Telemetry & trajectory assertions
    expect(transitions).toEqual([
      { from: "INIT", to: "ALTERNATIVE_DATA_ANALYSIS" },
      { from: "ALTERNATIVE_DATA_ANALYSIS", to: "FUNDAMENTAL_PROPOSING" },
      { from: "FUNDAMENTAL_PROPOSING", to: "RED_TEAM_REVIEW" },
      { from: "RED_TEAM_REVIEW", to: "EXECUTION" },
      { from: "EXECUTION", to: "COMPLETED" },
    ]);

    expect(result.metadata.graphFinalState).toBe("COMPLETED");
    const metaTransitions: unknown = result.metadata.graphTransitions;
    expect(isGraphTransitionRecordArray(metaTransitions)).toBe(true);
    if (isGraphTransitionRecordArray(metaTransitions)) {
      expect(metaTransitions).toHaveLength(5);
      expect(metaTransitions[0].from).toBe("INIT");
      expect(metaTransitions[1].to).toBe("FUNDAMENTAL_PROPOSING");
      expect(metaTransitions[0].durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("handles node execution errors cleanly and transitions to FAILED", async () => {
    const context = createMockContext();
    const graph = new TradingGraph(context);

    graph.registerNode({
      name: "INIT",
      execute: async () => {
        throw new Error("Data provider connection timeout");
      },
    });

    const result = await graph.run();

    expect(graph.getCurrentState()).toBe("FAILED");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain("Data provider connection timeout");
    expect(result.metadata.graphFinalState).toBe("FAILED");
  });

  it("fails safely when transitioning to an unregistered node state", async () => {
    const context = createMockContext();
    const graph = new TradingGraph(context);

    graph.registerNode({
      name: "INIT",
      execute: async (ctx) => ({
        nextState: "ALTERNATIVE_DATA_ANALYSIS",
        context: ctx,
      }),
    });
    // Deliberately do not register ALTERNATIVE_DATA_ANALYSIS

    const result = await graph.run();

    expect(graph.getCurrentState()).toBe("FAILED");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain("Node not found for state: ALTERNATIVE_DATA_ANALYSIS");
  });

  it("supports dynamic Macro Regime-Gated Branching", async () => {
    const context = createMockContext();
    const graph = new TradingGraph(context);

    graph.registerNode({
      name: "INIT",
      execute: async (ctx) => ({
        nextState: "ALTERNATIVE_DATA_ANALYSIS",
        context: ctx,
      }),
    });

    graph.registerNode({
      name: "ALTERNATIVE_DATA_ANALYSIS",
      execute: async (ctx) => {
        const isHighVolatility = true;
        const regime = isHighVolatility ? "HIGH_VOLATILITY" : "NORMAL";
        return {
          // If high volatility, route directly to DEFENSIVE branch or gate proposals
          nextState: isHighVolatility ? "RED_TEAM_REVIEW" : "FUNDAMENTAL_PROPOSING",
          context: {
            ...ctx,
            metadata: { ...ctx.metadata, macroRegime: regime },
          },
        };
      },
    });

    graph.registerNode({
      name: "RED_TEAM_REVIEW",
      execute: async (ctx) => ({
        nextState: "COMPLETED",
        context: ctx,
      }),
    });

    const result = await graph.run();

    expect(graph.getCurrentState()).toBe("COMPLETED");
    expect(result.metadata.macroRegime).toBe("HIGH_VOLATILITY");
    const transitions = graph.getTransitions();
    expect(transitions).toHaveLength(3);
    expect(transitions[0].to).toBe("ALTERNATIVE_DATA_ANALYSIS");
    expect(transitions[1].to).toBe("RED_TEAM_REVIEW");
    expect(transitions[2].to).toBe("COMPLETED");
  });
});

describe("Production ALTERNATIVE_DATA_ANALYSIS Node Execution", () => {
  it("computes RISK_ON macro regime with valid congress verdict", () => {
    const ctx = createMockContext();
    const result = evaluateAlternativeDataAnalysis(ctx, {
      congressVerdict: { verdict: "PASS", pass: true, stale: false, computedAt: Date.now() },
      topCandidates: [{ score: 70 }, { score: 80 }],
    });

    expect(result.nextState).toBe("FUNDAMENTAL_PROPOSING");
    const altData = result.context.metadata.alternativeData as {
      macroRegime: string;
      candidateCount: number;
      congressVerdict: { verdict: string; pass: boolean } | null;
    };
    expect(altData.macroRegime).toBe("RISK_ON");
    expect(altData.candidateCount).toBe(2);
    expect(altData.congressVerdict?.verdict).toBe("PASS");
    expect(altData.congressVerdict?.pass).toBe(true);
  });

  it("computes DEFENSIVE macro regime when market candidate breadth is low", () => {
    const ctx = createMockContext();
    const result = evaluateAlternativeDataAnalysis(ctx, {
      congressVerdict: null,
      topCandidates: [{ score: 25 }, { score: 35 }],
    });

    expect(result.nextState).toBe("FUNDAMENTAL_PROPOSING");
    const altData = result.context.metadata.alternativeData as {
      macroRegime: string;
      candidateCount: number;
      congressVerdict: null;
    };
    expect(altData.macroRegime).toBe("DEFENSIVE");
    expect(altData.candidateCount).toBe(2);
    expect(altData.congressVerdict).toBeNull();
  });

  it("computes NEUTRAL macro regime for moderate scores", () => {
    const ctx = createMockContext();
    const result = evaluateAlternativeDataAnalysis(ctx, {
      congressVerdict: { verdict: "INSUFFICIENT", pass: true, stale: false, computedAt: Date.now() },
      topCandidates: [{ score: 50 }, { score: 55 }],
    });

    expect(result.nextState).toBe("FUNDAMENTAL_PROPOSING");
    const altData = result.context.metadata.alternativeData as {
      macroRegime: string;
      candidateCount: number;
      congressVerdict: { verdict: string };
    };
    expect(altData.macroRegime).toBe("NEUTRAL");
    expect(altData.candidateCount).toBe(2);
    expect(altData.congressVerdict?.verdict).toBe("INSUFFICIENT");
  });
});

