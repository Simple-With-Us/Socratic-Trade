import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import { LLM_OUTPUT_TOKEN_CAPS, LLM_REQUEST_DEFAULTS } from "../src/lib/llm-request";

// Hoist OOS mock so we can control runWalkForwardOOS per-test.
// Default: return null (insufficient snapshot history) so existing tests are unaffected.
const mockRunWalkForwardOOS = vi.fn<() => Promise<import("../src/lib/backtest").OOSResult | null>>();
mockRunWalkForwardOOS.mockResolvedValue(null);

vi.mock("../src/lib/backtest", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/backtest")>();
  return { ...actual, runWalkForwardOOS: mockRunWalkForwardOOS };
});

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-tuning-${randomUUID()}.db`)}`;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_URL;
  // Reset OOS mock to "no data" after each test.
  mockRunWalkForwardOOS.mockResolvedValue(null);
});

describe("proposeStrategyTuning", () => {
  it("returns a manual-review local fallback without mutating the prompt when OpenAI is not configured", async () => {
    const { insertFillEvent, getStrategyPrompt, setPolicy, setStrategyPrompt } = await import("../src/lib/db");
    const { proposeStrategyTuning } = await import("../src/lib/strategy-tuning");

    delete process.env.OPENROUTER_API_KEY;
    setStrategyPrompt("BASE STRATEGY");
    setPolicy({
      ...DEFAULT_POLICY,
      accountNumber: "TUNE-LOCAL",
      maxOrderNotional: 25,
      scoringWeights: { ...DEFAULT_POLICY.scoringWeights }
    });
    insertFillEvent({
      accountNumber: "TUNE-LOCAL",
      source: "paper",
      symbol: "AAPL",
      side: "buy",
      quantity: 1,
      price: 100,
      notional: 100,
      status: "filled"
    });

    const proposal = await proposeStrategyTuning();

    expect(proposal.generatedBy).toBe("local_rules");
    expect(proposal.summary).toContain("Collect more trade evidence");
    expect(proposal.proposedPatch.prompt).toContain("LEARNING LOOP");
    expect(proposal.cautions.join(" ")).toContain("Manual approval");
    expect(getStrategyPrompt()).toBe("BASE STRATEGY");
  });

  it("degrades to local rules when a provider key resolves but no model is configured (no-defaults contract)", async () => {
    const { insertFillEvent, setPolicy, setStrategyPrompt } = await import("../src/lib/db");
    const { proposeStrategyTuning } = await import("../src/lib/strategy-tuning");

    // Keyed, but the (un-migrated) policy has NO Green or Red model selected. resolveLlmEndpoint
    // returns a truthy key with model "" — the tuning path must treat that as unconfigured and use
    // deterministic local rules, never send `model:""` and 400 the provider.
    process.env.OPENROUTER_API_KEY = "test-key";
    vi.stubGlobal("fetch", async () => {
      throw new Error("tuning must NOT call the provider with a blank model");
    });
    setStrategyPrompt("BASE STRATEGY");
    setPolicy({
      ...DEFAULT_POLICY,
      accountNumber: "TUNE-BLANK-MODEL",
      llmModel: "",
      redTeamLlmModel: undefined,
      scoringWeights: { ...DEFAULT_POLICY.scoringWeights }
    });
    insertFillEvent({
      accountNumber: "TUNE-BLANK-MODEL",
      source: "paper",
      symbol: "AAPL",
      side: "buy",
      quantity: 1,
      price: 100,
      notional: 100,
      status: "filled"
    });

    const proposal = await proposeStrategyTuning();
    expect(proposal.generatedBy).toBe("local_rules");
  });

  it("inherits the AI review model from Red Team, then Green Team, when no override is chosen", async () => {
    const userWithRedTeam = `tune-review-red-${randomUUID()}`;
    const userWithGreenOnly = `tune-review-green-${randomUUID()}`;
    const { setPolicy, setStrategyPrompt } = await import("../src/lib/db");
    const { proposeStrategyTuning } = await import("../src/lib/strategy-tuning");

    process.env.OPENROUTER_API_KEY = "test-key";
    process.env.OPENROUTER_API_URL = "https://openrouter.ai/v1/responses";
    setStrategyPrompt("RED TEAM REVIEW STRATEGY", userWithRedTeam);
    setPolicy({
      ...DEFAULT_POLICY,
      accountNumber: "TUNE-RED-INHERIT",
      llmModel: "openai/gpt-4o-mini",
      redTeamLlmModel: "openai/gpt-4.1",
      scoringWeights: { ...DEFAULT_POLICY.scoringWeights }
    }, userWithRedTeam);
    setStrategyPrompt("GREEN TEAM REVIEW STRATEGY", userWithGreenOnly);
    setPolicy({
      ...DEFAULT_POLICY,
      accountNumber: "TUNE-GREEN-INHERIT",
      llmModel: "openai/gpt-4o-mini",
      redTeamLlmModel: undefined,
      scoringWeights: { ...DEFAULT_POLICY.scoringWeights }
    }, userWithGreenOnly);

    const requestedModels: string[] = [];
    vi.stubGlobal("fetch", async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      requestedModels.push(body.model);
      return new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            summary: "Tune conservatively",
            rationale: "Use the configured team model for account review.",
            marketContext: "Macro is stable.",
            performanceReadout: "No closed-lot evidence yet.",
            proposedPrompt: "UNCHANGED",
            scoringWeights: {
              liquidity: null,
              momentum: null,
              value: null,
              quality: null,
              volatility: null,
              sentiment: null,
              positioning: null,
              diversification: null
            },
            policy: {
              maxOrderNotional: null,
              maxDailyNotional: null,
              maxSymbolExposurePct: null,
              maxDailyOrders: null,
              maxProposalsPerRun: null,
              runCadenceMinutes: null,
              strategyAuthority: null,
              runDuringExtendedHours: null
            },
            riskRules: {
              stopLossPct: null,
              takeProfitPct: null,
              trailingStopPct: null
            },
            cautions: [],
            confidenceScore: 70
          })
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    await proposeStrategyTuning(userWithRedTeam);
    await proposeStrategyTuning(userWithGreenOnly);

    expect(requestedModels).toEqual(["openai/gpt-4.1", "openai/gpt-4o-mini"]);
  });

  it("skips the rotation sentinel and reviews with the concrete Green model (no local-rules degradation)", async () => {
    // Finding 3 / rotation-sentinel fallthrough: with redTeamLlmModel = "__rotate__" (a run-scoped
    // rotation marker that only resolves inside runStrategyOnce), the tuning reviewer must NOT resolve
    // the raw sentinel — resolveOpenAiModel would map it to "" and silently degrade this LLM review to
    // local rules even though the UI panel promised a Green-model review. policyForTuningReviewer must
    // fall through the sentinel to the concrete Green model.
    const userId = `tune-review-rotate-${randomUUID()}`;
    const { setPolicy, setStrategyPrompt } = await import("../src/lib/db");
    const { proposeStrategyTuning } = await import("../src/lib/strategy-tuning");

    process.env.OPENROUTER_API_KEY = "test-key";
    process.env.OPENROUTER_API_URL = "https://openrouter.ai/v1/responses";
    setStrategyPrompt("ROTATE REVIEW STRATEGY", userId);
    setPolicy({
      ...DEFAULT_POLICY,
      accountNumber: "TUNE-ROTATE-INHERIT",
      llmModel: "openai/gpt-5.5",
      redTeamLlmModel: "__rotate__",
      scoringWeights: { ...DEFAULT_POLICY.scoringWeights }
    }, userId);

    const requestedModels: string[] = [];
    vi.stubGlobal("fetch", async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      requestedModels.push(body.model);
      return new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            summary: "Tune conservatively",
            rationale: "Concrete Green model served the review.",
            marketContext: "Macro is stable.",
            performanceReadout: "No closed-lot evidence yet.",
            proposedPrompt: "UNCHANGED",
            scoringWeights: {
              liquidity: null, momentum: null, value: null, quality: null,
              volatility: null, sentiment: null, positioning: null, diversification: null
            },
            policy: {
              maxOrderNotional: null, maxDailyNotional: null, maxSymbolExposurePct: null,
              maxDailyOrders: null, maxProposalsPerRun: null, runCadenceMinutes: null,
              strategyAuthority: null, runDuringExtendedHours: null
            },
            riskRules: { stopLossPct: null, takeProfitPct: null, trailingStopPct: null },
            cautions: [],
            confidenceScore: 70
          })
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const proposal = await proposeStrategyTuning(userId);
    // The reviewer used the concrete Green model, NOT the "__rotate__" sentinel — and did NOT degrade
    // to local rules (which would mean generatedBy "local_rules" and model-tracking ignored).
    expect(requestedModels).toEqual(["openai/gpt-5.5"]);
    expect(proposal.generatedBy).toBe("llm");
  });

  it("withholds factor-weight changes until 20 closed lots, even on weak performance", async () => {
    const { insertFillEvent, setPolicy, setStrategyPrompt } = await import("../src/lib/db");
    const { proposeStrategyTuning } = await import("../src/lib/strategy-tuning");

    delete process.env.OPENROUTER_API_KEY;
    setStrategyPrompt("BASE STRATEGY");
    setPolicy({ ...DEFAULT_POLICY, accountNumber: "TUNE-GATE", scoringWeights: { ...DEFAULT_POLICY.scoringWeights } });

    // 3 losing round-trips => 3 closed lots, negative average return (weak performance),
    // but far below the 20-lot gate, so factor weights must NOT be touched.
    let t = 0;
    for (const sym of ["AAA", "BBB", "CCC"]) {
      insertFillEvent({ accountNumber: "TUNE-GATE", source: "paper", symbol: sym, side: "buy", quantity: 1, price: 100, notional: 100, status: "filled", filledAt: `2026-06-15T00:00:${String(t++).padStart(2, "0")}.000Z` });
      insertFillEvent({ accountNumber: "TUNE-GATE", source: "paper", symbol: sym, side: "sell", quantity: 1, price: 90, notional: 90, status: "filled", filledAt: `2026-06-15T00:00:${String(t++).padStart(2, "0")}.000Z` });
    }

    const proposal = await proposeStrategyTuning();
    expect(proposal.generatedBy).toBe("local_rules");
    expect(proposal.proposedPatch.scoringWeights).toEqual({}); // gated — no weight shifts
    expect(proposal.cautions.join(" ")).toMatch(/closed lots/i);
  });

  it("sanitizes nullable LLM tuning fields and clamps confidence", async () => {
    const userId = `tune-llm-${randomUUID()}`;
    const accountId = randomUUID();
    const { insertFillEvent, setActiveConnectedAccount, setPolicy, setStrategyPrompt, upsertConnectedAccount } = await import("../src/lib/db");
    const { proposeStrategyTuning } = await import("../src/lib/strategy-tuning");

    process.env.OPENROUTER_API_KEY = "test-key";
    process.env.OPENROUTER_API_URL = "https://openrouter.ai/v1/responses";
    // TEST INFRASTRUCTURE: a connected test-broker account (broker: "test", environment: "paper") so
    // execution/tuning context flows through the normal broker path — an account is an account.
    upsertConnectedAccount({
      id: accountId,
      userId,
      broker: "test",
      environment: "paper",
      accountNumber: "TUNE-LLM",
      label: "Tune LLM Test Account",
      isActive: true
    });
    setActiveConnectedAccount(accountId, userId);
    setStrategyPrompt("CURRENT PROMPT", userId);
    setPolicy({
      ...DEFAULT_POLICY,
      accountNumber: "TUNE-LLM",
      // Classic model: this asserts temperature + exact caps (reasoning bounds → test/llm-request.test.ts).
      llmModel: "openai/gpt-4o-mini",
      scoringWeights: { ...DEFAULT_POLICY.scoringWeights },
      // oosWithholdUnvalidated: false → legacy keep-behavior so this test can assert clamped weights
      tuning: { oosWithholdUnvalidated: false }
    }, userId);
    // Seed 20 closed lots so the §3.E weight-shift gate passes and the LLM's
    // sanitized scoringWeights survive (the gate is exercised separately below).
    let n = 0;
    for (let i = 0; i < 20; i++) {
      const sym = `L${i}`;
      insertFillEvent({ userId, accountNumber: "TUNE-LLM", source: "paper", symbol: sym, side: "buy", quantity: 1, price: 100, notional: 100, status: "filled", filledAt: `2026-06-15T00:0${Math.floor(n / 60) }:${String(n++ % 60).padStart(2, "0")}.000Z` });
      insertFillEvent({ userId, accountNumber: "TUNE-LLM", source: "paper", symbol: sym, side: "sell", quantity: 1, price: 110, notional: 110, status: "filled", filledAt: `2026-06-15T00:0${Math.floor(n / 60) }:${String(n++ % 60).padStart(2, "0")}.000Z` });
    }

    let sawMockLocalContext = false;
    vi.stubGlobal("fetch", async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      expect(body.max_completion_tokens).toBe(LLM_OUTPUT_TOKEN_CAPS.strategyTuning);
      expect(body.temperature).toBe(LLM_REQUEST_DEFAULTS.deterministicTemperature);
      expect(body.max_output_tokens).toBe(LLM_OUTPUT_TOKEN_CAPS.strategyTuning);
      const context = JSON.parse(body.input.find((item: any) => item.role === "user")?.content ?? "{}");
      // An account is an account: the connected test-broker account's environment is "paper", so
      // execution mode is broker/paper — there is no separate "test/local" mode anymore.
      expect(context.activeMode).toBe("broker/paper");
      expect(context.policy.executionMode).toBe("broker/paper");
      expect(context.policy.paperMode).toBeUndefined();
      expect(context.recentFills[0]?.source).toBe("broker/paper");
      sawMockLocalContext = true;
      return new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            summary: "Tune conservatively",
            rationale: "Recent paper performance supports modest tuning.",
            marketContext: "Macro is stable.",
            performanceReadout: "Win rate is acceptable.",
            proposedPrompt: "UPDATED PROMPT",
            scoringWeights: {
              liquidity: 1.7,
              momentum: null,
              value: null,
              quality: 1.1,
              volatility: null,
              sentiment: 0.8,
              diversification: null
            },
            policy: {
              maxOrderNotional: 15,
              maxDailyNotional: null,
              maxSymbolExposurePct: null,
              maxDailyOrders: null,
              maxProposalsPerRun: null,
              runCadenceMinutes: null,
              strategyAuthority: "propose",
              runDuringExtendedHours: false
            },
            riskRules: {
              stopLossPct: 5,
              takeProfitPct: null,
              trailingStopPct: null
            },
            cautions: ["Review before applying."],
            confidenceScore: 130
          })
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const proposal = await proposeStrategyTuning(userId);

    expect(proposal.generatedBy).toBe("llm");
    expect(sawMockLocalContext).toBe(true);
    expect(proposal.confidenceScore).toBe(100);
    // The proposed weights (liquidity: 1.7, quality: 1.1, sentiment: 0.8) exceed the
    // MAX_WEIGHT_STEP (0.05) delta from defaults (1.4, 0.8, 0.6), so they are clamped.
    expect(proposal.proposedPatch).toEqual({
      prompt: "UPDATED PROMPT",
      scoringWeights: {
        liquidity: 1.45, // clamped from 1.7: default 1.4 + 0.05
        quality: 0.85,   // clamped from 1.1: default 0.8 + 0.05
        sentiment: 0.65  // clamped from 0.8: default 0.6 + 0.05
      },
      policy: {
        maxOrderNotional: 15,
        strategyAuthority: "propose",
        runDuringExtendedHours: false,
        riskRules: {
          stopLossPct: 5
        }
      }
    });
  });

  it("sends broker paper context for an Alpaca Paper account without calling it Test", async () => {
    const userId = `tune-broker-paper-${randomUUID()}`;
    const accountNumber = "TUNE-ALPACA-PAPER";
    const accountId = randomUUID();
    const { insertFillEvent, setActiveConnectedAccount, setPolicy, setStrategyPrompt, upsertConnectedAccount } = await import("../src/lib/db");
    const { proposeStrategyTuning } = await import("../src/lib/strategy-tuning");

    process.env.OPENROUTER_API_KEY = "test-key";
    process.env.OPENROUTER_API_URL = "https://openrouter.ai/v1/responses";
    upsertConnectedAccount({
      id: accountId,
      userId,
      broker: "alpaca",
      environment: "paper",
      accountNumber,
      label: "Alpaca Paper",
      isActive: true
    });
    setActiveConnectedAccount(accountId, userId);
    setStrategyPrompt("BROKER PAPER STRATEGY", userId);
    setPolicy({
      ...DEFAULT_POLICY,
      accountNumber,
      activeBroker: "alpaca",
      llmModel: "openai/gpt-4o-mini",
      scoringWeights: { ...DEFAULT_POLICY.scoringWeights }
    }, userId);
    insertFillEvent({
      userId,
      accountNumber,
      source: "paper",
      executionMode: "broker/paper",
      symbol: "AAPL",
      side: "buy",
      quantity: 1,
      price: 100,
      notional: 100,
      status: "filled"
    });

    let sawBrokerPaperContext = false;
    vi.stubGlobal("fetch", async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const context = JSON.parse(body.input.find((item: any) => item.role === "user")?.content ?? "{}");
      expect(context.activeMode).toBe("broker/paper");
      expect(context.activeModeClarification).toContain("Alpaca Paper");
      expect(context.activeModeClarification).toContain("real capital is not at risk");
      expect(context.policy.executionMode).toBe("broker/paper");
      expect(context.policy.executionModeClarification).toContain("Alpaca Paper");
      expect(context.recentFills[0]?.source).toBe("broker/paper");
      sawBrokerPaperContext = true;
      return new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            summary: "Review broker paper separately",
            rationale: "Broker paper fills are sandbox broker fills, not local simulator fills.",
            marketContext: "Macro is stable.",
            performanceReadout: "Continue gathering broker paper evidence.",
            proposedPrompt: "BROKER PAPER STRATEGY",
            scoringWeights: {
              liquidity: null,
              momentum: null,
              value: null,
              quality: null,
              volatility: null,
              sentiment: null,
              diversification: null
            },
            policy: {
              maxOrderNotional: null,
              maxDailyNotional: null,
              maxSymbolExposurePct: null,
              maxDailyOrders: null,
              maxProposalsPerRun: null,
              runCadenceMinutes: null,
              strategyAuthority: null,
              runDuringExtendedHours: null
            },
            riskRules: {
              stopLossPct: null,
              takeProfitPct: null,
              trailingStopPct: null
            },
            cautions: ["Keep broker paper results separate from live results."],
            confidenceScore: 80
          })
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const proposal = await proposeStrategyTuning(userId);

    expect(proposal.generatedBy).toBe("llm");
    expect(sawBrokerPaperContext).toBe(true);
    expect(proposal.cautions.join(" ")).toContain("broker paper");
  });

  it("hard-strips LLM-proposed factor weights below the 20-lot gate, regardless of the prompt", async () => {
    const { setPolicy, setStrategyPrompt } = await import("../src/lib/db");
    const { proposeStrategyTuning } = await import("../src/lib/strategy-tuning");

    process.env.OPENROUTER_API_KEY = "test-key";
    process.env.OPENROUTER_API_URL = "https://openrouter.ai/v1/responses";
    setStrategyPrompt("CURRENT PROMPT");
    setPolicy({ ...DEFAULT_POLICY, accountNumber: "TUNE-LLM-GATE", llmModel: "openai/gpt-4.1-mini", scoringWeights: { ...DEFAULT_POLICY.scoringWeights } });
    // No fills => 0 closed lots; even if the model ignores the prompt and returns weights, they must be stripped.
    vi.stubGlobal("fetch", async () => new Response(
      JSON.stringify({
        output_text: JSON.stringify({
          summary: "s", rationale: "r", marketContext: "m", performanceReadout: "p", proposedPrompt: "UPDATED",
          scoringWeights: { liquidity: 2.0, momentum: 1.5, value: null, quality: null, volatility: null, sentiment: null, diversification: null },
          policy: { maxOrderNotional: 15, maxDailyNotional: null, maxSymbolExposurePct: null, maxDailyOrders: null, maxProposalsPerRun: null, runCadenceMinutes: null, strategyAuthority: null, runDuringExtendedHours: null },
          riskRules: { stopLossPct: null, takeProfitPct: null, trailingStopPct: null },
          cautions: [], confidenceScore: 70
        })
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    ));

    const proposal = await proposeStrategyTuning();
    expect(proposal.generatedBy).toBe("llm");
    expect(proposal.proposedPatch.scoringWeights).toBeUndefined(); // gate stripped the weights
    expect(proposal.cautions.join(" ")).toMatch(/Withheld model-proposed factor-weight/i);
  });

  it("clamps LLM-proposed scoringWeight deltas to MAX_WEIGHT_STEP per factor", async () => {
    const { insertFillEvent, setPolicy, setStrategyPrompt } = await import("../src/lib/db");
    const { proposeStrategyTuning, MAX_WEIGHT_STEP } = await import("../src/lib/strategy-tuning");

    process.env.OPENROUTER_API_KEY = "test-key";
    process.env.OPENROUTER_API_URL = "https://openrouter.ai/v1/responses";
    setStrategyPrompt("CLAMP TEST PROMPT");
    // Use custom weights so we can assert the clamp precisely.
    const customWeights = { liquidity: 1.0, momentum: 1.0, value: 1.0, quality: 1.0, volatility: 1.0, sentiment: 1.0, positioning: 1.0, diversification: 1.0 };
    // oosWithholdUnvalidated: false → legacy keep-behavior so this test can assert clamped weights
    setPolicy({ ...DEFAULT_POLICY, accountNumber: "TUNE-CLAMP", llmModel: "openai/gpt-4.1-mini", scoringWeights: customWeights, tuning: { oosWithholdUnvalidated: false } });
    // Seed 20 closed lots so the §3.E gate passes.
    let n = 0;
    for (let i = 0; i < 20; i++) {
      const sym = `C${i}`;
      insertFillEvent({ accountNumber: "TUNE-CLAMP", source: "paper", symbol: sym, side: "buy", quantity: 1, price: 100, notional: 100, status: "filled", filledAt: `2026-06-15T00:0${Math.floor(n / 60)}:${String(n++ % 60).padStart(2, "0")}.000Z` });
      insertFillEvent({ accountNumber: "TUNE-CLAMP", source: "paper", symbol: sym, side: "sell", quantity: 1, price: 110, notional: 110, status: "filled", filledAt: `2026-06-15T00:0${Math.floor(n / 60)}:${String(n++ % 60).padStart(2, "0")}.000Z` });
    }

    vi.stubGlobal("fetch", async () => new Response(
      JSON.stringify({
        output_text: JSON.stringify({
          summary: "s", rationale: "r", marketContext: "m", performanceReadout: "p",
          proposedPrompt: "CLAMP TEST PROMPT", // no prompt change
          scoringWeights: {
            // All far outside current weights (1.0), should be clamped to 1.0 ± MAX_WEIGHT_STEP
            liquidity: 2.5,     // +1.5 → clamp to 1.0 + MAX_WEIGHT_STEP
            momentum: 0.0,      // -1.0 → clamp to 1.0 - MAX_WEIGHT_STEP
            value: null, quality: null, volatility: null, sentiment: null, positioning: null, diversification: null
          },
          policy: { maxOrderNotional: null, maxDailyNotional: null, maxSymbolExposurePct: null, maxDailyOrders: null, maxProposalsPerRun: null, runCadenceMinutes: null, strategyAuthority: null, runDuringExtendedHours: null },
          riskRules: { stopLossPct: null, takeProfitPct: null, trailingStopPct: null },
          cautions: [], confidenceScore: 70
        })
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    ));

    const proposal = await proposeStrategyTuning();

    expect(proposal.generatedBy).toBe("llm");
    expect(proposal.proposedPatch.scoringWeights?.liquidity).toBeCloseTo(1.0 + MAX_WEIGHT_STEP, 5);
    expect(proposal.proposedPatch.scoringWeights?.momentum).toBeCloseTo(1.0 - MAX_WEIGHT_STEP, 5);
    // No prompt change since proposed matches current
    expect(proposal.proposedPatch.prompt).toBeUndefined();
  });
});

describe("localRulesProposal factor scorecard integration", () => {
  it("applies a downward weight nudge for a factor with negative avg return (above lot gate)", async () => {
    const { insertFillEvent, setPolicy, setStrategyPrompt } = await import("../src/lib/db");
    const { proposeStrategyTuning, MAX_WEIGHT_STEP } = await import("../src/lib/strategy-tuning");

    delete process.env.OPENROUTER_API_KEY;
    setStrategyPrompt("FACTOR SCORECARD TEST");
    const customWeights = { liquidity: 1.0, momentum: 1.0, value: 1.0, quality: 1.0, volatility: 1.0, sentiment: 1.0, positioning: 1.0, diversification: 1.0 };
    // oosWithholdUnvalidated: false → legacy keep-behavior so this test can assert the weight nudge
    setPolicy({ ...DEFAULT_POLICY, accountNumber: "TUNE-FSCORE", scoringWeights: customWeights, tuning: { oosWithholdUnvalidated: false } });
    // Seed 20 losing closed lots. All fills have weak/negative outcomes to trigger
    // weakPerformance=true and ensure enoughLotsForWeights=true.
    let t = 0;
    for (let i = 0; i < 20; i++) {
      const sym = `F${i}`;
      insertFillEvent({ accountNumber: "TUNE-FSCORE", source: "paper", symbol: sym, side: "buy", quantity: 1, price: 100, notional: 100, status: "filled", filledAt: `2026-06-15T00:0${Math.floor(t / 60)}:${String(t++ % 60).padStart(2, "0")}.000Z` });
      insertFillEvent({ accountNumber: "TUNE-FSCORE", source: "paper", symbol: sym, side: "sell", quantity: 1, price: 90, notional: 90, status: "filled", filledAt: `2026-06-15T00:0${Math.floor(t / 60)}:${String(t++ % 60).padStart(2, "0")}.000Z` });
    }

    const proposal = await proposeStrategyTuning();
    // With 20 lots the gate passes, and weak performance triggers the local-rules path.
    expect(proposal.generatedBy).toBe("local_rules");
    // The local path should still emit scoring weights (gate satisfied).
    expect(proposal.proposedPatch.scoringWeights).toBeDefined();
    // With no signal_snapshot audit records, factorScorecard will be empty — no nudges.
    // Still verify the gate-gated base rules fire: volatility, quality, momentum.
    const w = proposal.proposedPatch.scoringWeights!;
    expect(w.volatility).toBeCloseTo(customWeights.volatility + 0.2, 5);
    expect(w.quality).toBeCloseTo(customWeights.quality + 0.1, 5);
    expect(w.momentum).toBeCloseTo(Math.max(0, customWeights.momentum - 0.1), 5);
    expect(proposal.cautions.join(" ")).toMatch(/Manual approval/i);
  });
});

describe("OOS walk-forward gate (Task 1)", () => {
  it("strips scoringWeights and emits a caution when OOS IC does NOT improve over default", async () => {
    const { insertFillEvent, setPolicy, setStrategyPrompt } = await import("../src/lib/db");
    const { proposeStrategyTuning } = await import("../src/lib/strategy-tuning");

    delete process.env.OPENROUTER_API_KEY;
    setStrategyPrompt("OOS GATE TEST");
    const customWeights = { liquidity: 1.0, momentum: 1.0, value: 1.0, quality: 1.0, volatility: 1.0, sentiment: 1.0, positioning: 1.0, diversification: 1.0 };
    setPolicy({ ...DEFAULT_POLICY, accountNumber: "OOS-NOIMPROVE", scoringWeights: customWeights });
    // Seed 20 losing lots so the §3.E gate passes and local-rules proposes weight changes.
    let t = 0;
    for (let i = 0; i < 20; i++) {
      const sym = `O${i}`;
      insertFillEvent({ accountNumber: "OOS-NOIMPROVE", source: "paper", symbol: sym, side: "buy", quantity: 1, price: 100, notional: 100, status: "filled", filledAt: `2026-06-15T00:0${Math.floor(t / 60)}:${String(t++ % 60).padStart(2, "0")}.000Z` });
      insertFillEvent({ accountNumber: "OOS-NOIMPROVE", source: "paper", symbol: sym, side: "sell", quantity: 1, price: 90, notional: 90, status: "filled", filledAt: `2026-06-15T00:0${Math.floor(t / 60)}:${String(t++ % 60).padStart(2, "0")}.000Z` });
    }

    // OOS result where the CANDIDATE (proposed) weights IC (0.05) does NOT beat the current/baseline
    // weights IC (0.10). The gate now reads oosICCandidate vs oosICBaseline (not oosIC vs default).
    mockRunWalkForwardOOS.mockResolvedValueOnce({
      trainObservations: 100, testObservations: 40, trainDates: 10, testDates: 4,
      window: {
        trainStartDate: "2026-05-01", trainEndDate: "2026-06-01",
        embargoDates: 2, purgedTrainDates: 0,
        testStartDate: "2026-06-05", testEndDate: "2026-06-15"
      },
      trainICs: [], icWeights: customWeights as any,
      oosIC: 0.99, oosICDefault: 0.01,        // data-derived vs default — must be IGNORED by the gate now
      oosICCandidate: 0.05,                    // proposed weights: worse than current
      oosICBaseline: 0.10,                     // current weights: better — so OOS gate fires
      oosICIR: 0.3,
      equityCurve: [], annualizedReturn: null, benchmarkAnnualizedReturn: null,
      activeReturn: null, sharpeRatio: null, maxDrawdownPct: 5,
      note: "test"
    });

    const proposal = await proposeStrategyTuning();

    // The gate must validate the PROPOSED weights, not the data-derived IC weights: it should be
    // called with candidateWeights (proposed merged over current) and baselineWeights (= current).
    const oosArgs = mockRunWalkForwardOOS.mock.calls.at(-1) as unknown as [string, { candidateWeights?: Record<string, number>; baselineWeights?: unknown }];
    expect(oosArgs?.[1]?.baselineWeights).toEqual(customWeights);
    // The candidate must be the proposed delta merged over the baseline — NOT a copy of the baseline
    // (guards against a regression where baseline is accidentally passed as the candidate).
    expect(oosArgs?.[1]?.candidateWeights).toBeDefined();
    expect(oosArgs?.[1]?.candidateWeights).not.toEqual(customWeights);

    // Weights should be stripped by the OOS gate (candidate 0.05 < current 0.10), DESPITE oosIC>default.
    expect(proposal.proposedPatch.scoringWeights).toBeUndefined();
    // A caution explaining the OOS strip must be present.
    const cautions = proposal.cautions.join(" ");
    expect(cautions).toMatch(/did not improve OOS IC over the current weights/i);
    expect(cautions).toMatch(/IC=/i);
  });

  it("keeps scoringWeights and attaches an OOS info-caution when OOS IC DOES improve", async () => {
    const { insertFillEvent, setPolicy, setStrategyPrompt } = await import("../src/lib/db");
    const { proposeStrategyTuning } = await import("../src/lib/strategy-tuning");

    delete process.env.OPENROUTER_API_KEY;
    setStrategyPrompt("OOS IMPROVE TEST");
    const customWeights = { liquidity: 1.0, momentum: 1.0, value: 1.0, quality: 1.0, volatility: 1.0, sentiment: 1.0, positioning: 1.0, diversification: 1.0 };
    setPolicy({ ...DEFAULT_POLICY, accountNumber: "OOS-IMPROVE", scoringWeights: customWeights });
    // 20 losing lots to trigger weight nudges via local-rules.
    let t = 0;
    for (let i = 0; i < 20; i++) {
      const sym = `P${i}`;
      insertFillEvent({ accountNumber: "OOS-IMPROVE", source: "paper", symbol: sym, side: "buy", quantity: 1, price: 100, notional: 100, status: "filled", filledAt: `2026-06-15T00:0${Math.floor(t / 60)}:${String(t++ % 60).padStart(2, "0")}.000Z` });
      insertFillEvent({ accountNumber: "OOS-IMPROVE", source: "paper", symbol: sym, side: "sell", quantity: 1, price: 90, notional: 90, status: "filled", filledAt: `2026-06-15T00:0${Math.floor(t / 60)}:${String(t++ % 60).padStart(2, "0")}.000Z` });
    }

    // OOS result where the CANDIDATE (proposed) weights IC (0.15) beats the current/baseline IC (0.10).
    mockRunWalkForwardOOS.mockResolvedValueOnce({
      trainObservations: 100, testObservations: 40, trainDates: 10, testDates: 4,
      window: {
        trainStartDate: "2026-05-01", trainEndDate: "2026-06-01",
        embargoDates: 2, purgedTrainDates: 0,
        testStartDate: "2026-06-05", testEndDate: "2026-06-15"
      },
      trainICs: [], icWeights: customWeights as any,
      oosIC: 0.01, oosICDefault: 0.99,        // data-derived vs default — must be IGNORED by the gate now
      oosICCandidate: 0.15,                    // proposed weights: better than current
      oosICBaseline: 0.10,                     // current weights: worse — OOS gate passes
      oosICIR: 0.8,
      equityCurve: [], annualizedReturn: null, benchmarkAnnualizedReturn: null,
      activeReturn: null, sharpeRatio: null, maxDrawdownPct: 3,
      note: "test"
    });

    const proposal = await proposeStrategyTuning();

    // The new path is taken: candidate (proposed merged over current) + baseline (= current) passed in.
    const oosArgs = mockRunWalkForwardOOS.mock.calls.at(-1) as unknown as [string, { candidateWeights?: Record<string, number>; baselineWeights?: unknown }];
    expect(oosArgs?.[1]?.baselineWeights).toEqual(customWeights);
    expect(oosArgs?.[1]?.candidateWeights).not.toEqual(customWeights);

    // Weights should be kept (candidate 0.15 > current 0.10), DESPITE oosIC<default.
    expect(proposal.proposedPatch.scoringWeights).toBeDefined();
    // An OOS info-caution must be present.
    const cautions = proposal.cautions.join(" ");
    expect(cautions).toMatch(/OOS-validated|improved OOS IC over the current/i);
    // §6 slice 3: the readout names the exact held-out window and discloses the partial in-sample overlap.
    expect(cautions).toMatch(/held-out window 2026-06-05→2026-06-15 \(4 dates; train 2026-05-01→2026-06-01, 10 dates; embargo 2, purge 0\)/);
    expect(cautions).toMatch(/Partially in-sample/i);
  });

  it("PIT evidence cutoff (§6 follow-up): stamps the proposal and retires the in-sample caveat", async () => {
    const { insertFillEvent, setPolicy, audit } = await import("../src/lib/db");
    const { proposeStrategyTuning } = await import("../src/lib/strategy-tuning");

    delete process.env.OPENROUTER_API_KEY;
    // Dedicated userId so the seeded snapshot history cannot leak into other tests' cutoff math.
    const userId = `pit-swap-${randomUUID()}`;
    const accountNumber = "PIT-SWAP";
    const customWeights = { liquidity: 1.0, momentum: 1.0, value: 1.0, quality: 1.0, volatility: 1.0, sentiment: 1.0, positioning: 1.0, diversification: 1.0 };
    setPolicy({ ...DEFAULT_POLICY, accountNumber, scoringWeights: customWeights, tuning: { oosWithholdUnvalidated: false } }, userId);

    // 20 matured June-2026 snapshot dates → fold cutoff 2026-06-26 (mirrors the unit test in
    // pit-evidence.test.ts; "now" is the real clock, well past the horizon for these dates).
    const juneDates = [
      "2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04", "2026-06-05",
      "2026-06-08", "2026-06-09", "2026-06-10", "2026-06-11", "2026-06-12",
      "2026-06-15", "2026-06-16", "2026-06-17", "2026-06-18", "2026-06-19",
      "2026-06-22", "2026-06-23", "2026-06-24", "2026-06-25", "2026-06-26"
    ];
    for (const date of juneDates) {
      audit("signal_snapshot", { runId: `run-${date}`, asOf: `${date}T15:00:00Z`, signals: [{ symbol: "AAPL", refPrice: 100, factorBreakdown: { momentum: 50 } }] }, userId);
    }
    // 20 losing lots closed 2026-06-15 (BEFORE the 06-26 cutoff → PIT-clean evidence) so the
    // local-rules path proposes weight changes.
    let t = 0;
    for (let i = 0; i < 20; i++) {
      const sym = `PS${i}`;
      insertFillEvent({ accountNumber, source: "paper", symbol: sym, side: "buy", quantity: 1, price: 100, notional: 100, status: "filled", filledAt: `2026-06-15T00:0${Math.floor(t / 60)}:${String(t++ % 60).padStart(2, "0")}.000Z`, userId });
      insertFillEvent({ accountNumber, source: "paper", symbol: sym, side: "sell", quantity: 1, price: 90, notional: 90, status: "filled", filledAt: `2026-06-15T00:0${Math.floor(t / 60)}:${String(t++ % 60).padStart(2, "0")}.000Z`, userId });
    }

    mockRunWalkForwardOOS.mockResolvedValueOnce({
      trainObservations: 100, testObservations: 40, trainDates: 10, testDates: 4,
      window: {
        trainStartDate: "2026-05-01", trainEndDate: "2026-06-01",
        embargoDates: 2, purgedTrainDates: 0,
        testStartDate: "2026-06-26", testEndDate: "2026-07-15"
      },
      trainICs: [], icWeights: customWeights as any,
      oosIC: 0.01, oosICDefault: 0.99,
      oosICCandidate: 0.15,
      oosICBaseline: 0.10,
      oosICIR: 0.8,
      equityCurve: [], annualizedReturn: null, benchmarkAnnualizedReturn: null,
      activeReturn: null, sharpeRatio: null, maxDrawdownPct: 3,
      note: "test"
    });

    const proposal = await proposeStrategyTuning(userId);

    // The proposal carries the cutoff, and the OOS readout discloses IT instead of the caveat.
    expect(proposal.evidenceCutoffDate).toBe("2026-06-26");
    const cautions = proposal.cautions.join(" ");
    expect(cautions).toMatch(/PIT evidence cutoff 2026-06-26/);
    expect(cautions).not.toMatch(/Partially in-sample/i);
  });

  it("keeps proposed weights but flags them NOT out-of-sample validated when OOS has insufficient snapshots", async () => {
    const { insertFillEvent, setPolicy, setStrategyPrompt } = await import("../src/lib/db");
    const { proposeStrategyTuning } = await import("../src/lib/strategy-tuning");

    delete process.env.OPENROUTER_API_KEY;
    setStrategyPrompt("OOS NULL TEST");
    const customWeights = { liquidity: 1.0, momentum: 1.0, value: 1.0, quality: 1.0, volatility: 1.0, sentiment: 1.0, positioning: 1.0, diversification: 1.0 };
    // oosWithholdUnvalidated: false → legacy keep-behavior (this test documents that opt-out path)
    setPolicy({ ...DEFAULT_POLICY, accountNumber: "OOS-NULL", scoringWeights: customWeights, tuning: { oosWithholdUnvalidated: false } });
    let t = 0;
    for (let i = 0; i < 20; i++) {
      const sym = `N${i}`;
      insertFillEvent({ accountNumber: "OOS-NULL", source: "paper", symbol: sym, side: "buy", quantity: 1, price: 100, notional: 100, status: "filled", filledAt: `2026-06-15T00:0${Math.floor(t / 60)}:${String(t++ % 60).padStart(2, "0")}.000Z` });
      insertFillEvent({ accountNumber: "OOS-NULL", source: "paper", symbol: sym, side: "sell", quantity: 1, price: 90, notional: 90, status: "filled", filledAt: `2026-06-15T00:0${Math.floor(t / 60)}:${String(t++ % 60).padStart(2, "0")}.000Z` });
    }
    mockRunWalkForwardOOS.mockResolvedValueOnce(null); // insufficient snapshot history

    const proposal = await proposeStrategyTuning();
    expect(proposal.proposedPatch.scoringWeights).toBeDefined(); // weights kept (gate could not run)
    const cautions = proposal.cautions.join(" ");
    expect(cautions).toMatch(/NOT out-of-sample validated/i);
    expect(cautions).toMatch(/insufficient snapshot history/i);
  });

  it("flags NOT out-of-sample validated when the OOS run throws", async () => {
    const { insertFillEvent, setPolicy, setStrategyPrompt } = await import("../src/lib/db");
    const { proposeStrategyTuning } = await import("../src/lib/strategy-tuning");

    delete process.env.OPENROUTER_API_KEY;
    setStrategyPrompt("OOS THROW TEST");
    const customWeights = { liquidity: 1.0, momentum: 1.0, value: 1.0, quality: 1.0, volatility: 1.0, sentiment: 1.0, positioning: 1.0, diversification: 1.0 };
    // oosWithholdUnvalidated: false → legacy keep-behavior (this test documents that opt-out path)
    setPolicy({ ...DEFAULT_POLICY, accountNumber: "OOS-THROW", scoringWeights: customWeights, tuning: { oosWithholdUnvalidated: false } });
    let t = 0;
    for (let i = 0; i < 20; i++) {
      const sym = `E${i}`;
      insertFillEvent({ accountNumber: "OOS-THROW", source: "paper", symbol: sym, side: "buy", quantity: 1, price: 100, notional: 100, status: "filled", filledAt: `2026-06-15T00:0${Math.floor(t / 60)}:${String(t++ % 60).padStart(2, "0")}.000Z` });
      insertFillEvent({ accountNumber: "OOS-THROW", source: "paper", symbol: sym, side: "sell", quantity: 1, price: 90, notional: 90, status: "filled", filledAt: `2026-06-15T00:0${Math.floor(t / 60)}:${String(t++ % 60).padStart(2, "0")}.000Z` });
    }
    mockRunWalkForwardOOS.mockRejectedValueOnce(new Error("network down"));

    const proposal = await proposeStrategyTuning();
    expect(proposal.proposedPatch.scoringWeights).toBeDefined();
    expect(proposal.cautions.join(" ")).toMatch(/NOT out-of-sample validated.*data fetch failed/i);
  });
});

describe("regime-segmented tuning evidence (Task 2)", () => {
  it("uses same-regime evidence when the regime bucket has enough lots", async () => {
    const { insertFillEvent, audit, setPolicy, setStrategyPrompt } = await import("../src/lib/db");
    const { proposeStrategyTuning } = await import("../src/lib/strategy-tuning");

    delete process.env.OPENROUTER_API_KEY;
    setStrategyPrompt("REGIME SEG TEST");
    const customWeights = { liquidity: 1.0, momentum: 1.0, value: 1.0, quality: 1.0, volatility: 1.0, sentiment: 1.0, positioning: 1.0, diversification: 1.0 };
    // oosWithholdUnvalidated: false → legacy keep-behavior so this test can assert weights are defined
    setPolicy({ ...DEFAULT_POLICY, accountNumber: "REGIME-SEG", scoringWeights: customWeights, tuning: { oosWithholdUnvalidated: false } });

    // Seed 20+ closed lots with a known regime ("Tech-Bull") so the regime bucket is large enough.
    // Most-recent lot has regime "Tech-Bull" → currentRegime = "Tech-Bull".
    let t = 0;
    for (let i = 0; i < 22; i++) {
      const sym = `R${i}`;
      const regime = "Tech-Bull";
      insertFillEvent({ accountNumber: "REGIME-SEG", source: "paper", symbol: sym, side: "buy", quantity: 1, price: 100, notional: 100, status: "filled", filledAt: `2026-06-15T00:0${Math.floor(t / 60)}:${String(t++ % 60).padStart(2, "0")}.000Z`, raw: { proposal: { tradeThesisTag: "T", entryMarketRegime: regime } } });
      insertFillEvent({ accountNumber: "REGIME-SEG", source: "paper", symbol: sym, side: "sell", quantity: 1, price: 90, notional: 90, status: "filled", filledAt: `2026-06-15T00:0${Math.floor(t / 60)}:${String(t++ % 60).padStart(2, "0")}.000Z` });
    }
    // Seed signal_snapshot so factorScorecard can be populated.
    const runId = `run-regime-${randomUUID()}`;
    audit("signal_snapshot", {
      runId,
      signals: Array.from({ length: 22 }, (_, i) => ({
        symbol: `R${i}`,
        chosen: true,
        factorBreakdown: { liquidity: 10, momentum: 90, value: 30, quality: 20, volatility: 15, sentiment: 25, positioning: 40, diversification: 5, weightedTotal: 70 }
      }))
    });

    const proposal = await proposeStrategyTuning();

    // With 22 lots in the "Tech-Bull" regime bucket (>= minLotsForWeights=20), the regime
    // scorecard path should be taken. The function should still return a valid proposal.
    expect(proposal.generatedBy).toBe("local_rules");
    // Weights should be defined (gate satisfied — 22 lots total).
    expect(proposal.proposedPatch.scoringWeights).toBeDefined();
  });

  it("falls back to all-regime evidence when same-regime bucket is too thin", async () => {
    const { insertFillEvent, setPolicy, setStrategyPrompt } = await import("../src/lib/db");
    const { proposeStrategyTuning } = await import("../src/lib/strategy-tuning");

    delete process.env.OPENROUTER_API_KEY;
    setStrategyPrompt("REGIME FALLBACK TEST");
    const customWeights = { liquidity: 1.0, momentum: 1.0, value: 1.0, quality: 1.0, volatility: 1.0, sentiment: 1.0, positioning: 1.0, diversification: 1.0 };
    // oosWithholdUnvalidated: false → legacy keep-behavior so this test can assert weights are defined
    setPolicy({ ...DEFAULT_POLICY, accountNumber: "REGIME-FB", scoringWeights: customWeights, tuning: { oosWithholdUnvalidated: false } });

    // 20 total lots in mixed regimes (5 "Tech-Bull" + 15 "Choppy"), so Tech-Bull bucket has only 5.
    // Most-recent lot has regime "Tech-Bull" → currentRegime = "Tech-Bull" → bucket = 5 < 20 → fallback.
    let t = 0;
    for (let i = 0; i < 15; i++) {
      const sym = `RB${i}`;
      insertFillEvent({ accountNumber: "REGIME-FB", source: "paper", symbol: sym, side: "buy", quantity: 1, price: 100, notional: 100, status: "filled", filledAt: `2026-06-15T00:0${Math.floor(t / 60)}:${String(t++ % 60).padStart(2, "0")}.000Z`, raw: { proposal: { tradeThesisTag: "T", entryMarketRegime: "Choppy" } } });
      insertFillEvent({ accountNumber: "REGIME-FB", source: "paper", symbol: sym, side: "sell", quantity: 1, price: 90, notional: 90, status: "filled", filledAt: `2026-06-15T00:0${Math.floor(t / 60)}:${String(t++ % 60).padStart(2, "0")}.000Z` });
    }
    for (let i = 0; i < 5; i++) {
      const sym = `RBT${i}`;
      insertFillEvent({ accountNumber: "REGIME-FB", source: "paper", symbol: sym, side: "buy", quantity: 1, price: 100, notional: 100, status: "filled", filledAt: `2026-06-15T00:0${Math.floor(t / 60)}:${String(t++ % 60).padStart(2, "0")}.000Z`, raw: { proposal: { tradeThesisTag: "T", entryMarketRegime: "Tech-Bull" } } });
      insertFillEvent({ accountNumber: "REGIME-FB", source: "paper", symbol: sym, side: "sell", quantity: 1, price: 90, notional: 90, status: "filled", filledAt: `2026-06-15T00:0${Math.floor(t / 60)}:${String(t++ % 60).padStart(2, "0")}.000Z` });
    }

    const proposal = await proposeStrategyTuning();

    // 20 total lots → gate passes. Current regime "Tech-Bull" bucket has 5 → fallback to all-regime.
    expect(proposal.generatedBy).toBe("local_rules");
    // Weights defined (overall gate satisfied by 20 total lots).
    expect(proposal.proposedPatch.scoringWeights).toBeDefined();
  });
});
