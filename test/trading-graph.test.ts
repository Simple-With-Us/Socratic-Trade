import { describe, expect, it, vi } from "vitest";
import {
  TradingGraph,
  type GraphContext,
  type GraphState,
  type GraphNode,
} from "../src/lib/orchestration/trading-graph";

function createMockContext(overrides?: Partial<GraphContext>): GraphContext {
  return {
    runId: "test-run-1",
    policy: {} as any,
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
              rationale: "Strong alternative & fundamental alignment",
            } as any,
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
    const metaTransitions = result.metadata.graphTransitions as any[];
    expect(metaTransitions).toHaveLength(5);
    expect(metaTransitions[0].from).toBe("INIT");
    expect(metaTransitions[1].to).toBe("FUNDAMENTAL_PROPOSING");
    expect(metaTransitions[0].durationMs).toBeGreaterThanOrEqual(0);
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
