import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import { LLM_OUTPUT_TOKEN_CAPS, LLM_REQUEST_DEFAULTS } from "../src/lib/llm-request";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-red-team-${randomUUID()}.db`)}`;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_URL;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_URL;
});

describe("debateProposal — T11 fail-open contract", () => {
  // A red-team failure must NEVER silently reject (drop) a trade — it fails OPEN to rejected:false.
  const buyProposal = (): any => ({
    symbol: "AAPL",
    side: "buy",
    type: "market",
    timeInForce: "gfd",
    marketHours: "regular_hours",
    rationale: "momentum",
    confidenceScore: 90,
    tradeThesisTag: "t",
    entryMarketRegime: "t"
  });

  it("fails open (does not reject) when OpenAI is not configured", async () => {
    const { setPolicy, setStrategyPrompt } = await import("../src/lib/db");
    const { debateProposal } = await import("../src/lib/red-team");
    delete process.env.OPENAI_API_KEY;
    setPolicy({ ...DEFAULT_POLICY, accountNumber: "RT_NOKEY" });
    setStrategyPrompt("BASE STRATEGY");

    const result = await debateProposal(buyProposal(), undefined, true);
    expect(result.rejected).toBe(false);
    expect(result.reason).toMatch(/not configured/i);
  });

  it("fails open when the LLM request throws", async () => {
    const { setPolicy, setStrategyPrompt } = await import("../src/lib/db");
    const { debateProposal } = await import("../src/lib/red-team");
    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
    setPolicy({ ...DEFAULT_POLICY, accountNumber: "RT_THROW" });
    setStrategyPrompt("BASE STRATEGY");
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });

    const result = await debateProposal(buyProposal(), undefined, true);
    expect(result.rejected).toBe(false); // errored out → trade is not dropped by the red team
  });
});

describe("debateProposal LLM request bounds", () => {
  it("adds chat-completions output caps and the adversary sampling temperature", async () => {
    const { setPolicy, setStrategyPrompt } = await import("../src/lib/db");
    const { debateProposal } = await import("../src/lib/red-team");

    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
    // Pin a classic (non-reasoning) model so this test verifies temperature + exact output caps.
    // Reasoning-model bounds (reasoning_effort, raised caps) are covered by test/llm-request.test.ts.
    setPolicy({ ...DEFAULT_POLICY, accountNumber: "RED-TEAM", llmModel: "gpt-4.1-mini" });
    setStrategyPrompt("BASE STRATEGY");

    const bodies: any[] = [];
    vi.stubGlobal("fetch", async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({ rejected: false, reason: "No fatal flaw found." })
              }
            }
          ]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const result = await debateProposal(
      {
        symbol: "AAPL",
        side: "buy",
        type: "market",
        dollarAmount: 25,
        timeInForce: "gfd",
        marketHours: "regular_hours",
        rationale: "High-quality setup.",
        tradeThesisTag: "Quality-Compounder",
        entryMarketRegime: "Neutral (Normal Volatility)",
        confidenceScore: 90
      },
      undefined,
      true
    );

    // w3-schema-dissent: the verdict is structured now — the legacy `{rejected:false}` mock payload
    // normalizes to verdict "approve" with empty risk/trigger lists and a null advisory change.
    expect(result).toMatchObject({
      rejected: false,
      available: true,
      reason: "No fatal flaw found.",
      model: "gpt-4.1-mini",
      verdict: "approve",
      keyRisks: [],
      invalidationTriggers: [],
      suggestedChange: null
    });
    expect(bodies).toHaveLength(1);
    expect(bodies[0].max_completion_tokens).toBe(LLM_OUTPUT_TOKEN_CAPS.redTeamDebate);
    // Per-role sampling (composite review B/medium/S): the adversary (Bear/debate) role now samples
    // at a non-zero temperature instead of the Bull's greedy temp-0 decode.
    expect(bodies[0].temperature).toBe(LLM_REQUEST_DEFAULTS.adversaryTemperature);
    expect(bodies[0].max_output_tokens).toBeUndefined();
    // Item 6: OpenAI-compatible providers request STRICT json_schema (not a bare json_object), so the
    // verdict is schema-enforced rather than regex/prose-parsed.
    expect(bodies[0].response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "red_team_verdict", strict: true, schema: expect.any(Object) }
    });
  });
});

describe("debateProposal — Claude Red Team (first-class anthropic routing)", () => {
  it("routes a claude-* redTeamLlmModel to Anthropic Messages with a forced verdict tool", async () => {
    const { setPolicy, setStrategyPrompt } = await import("../src/lib/db");
    const { debateProposal } = await import("../src/lib/red-team");

    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    setPolicy({ ...DEFAULT_POLICY, accountNumber: "RT_CLAUDE", llmModel: "gpt-5.4-mini", redTeamLlmModel: "claude-opus-4-8" });
    setStrategyPrompt("BASE STRATEGY");

    const calls: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: JSON.parse(String(init?.body ?? "{}"))
      });
      // Anthropic Messages tool_use response shape.
      return new Response(
        JSON.stringify({
          content: [{ type: "tool_use", name: "red_team_verdict", input: { rejected: true, reason: "Overbought into earnings." } }],
          usage: { input_tokens: 100, output_tokens: 20 }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const result = await debateProposal(
      {
        symbol: "AAPL",
        side: "buy",
        type: "market",
        dollarAmount: 25,
        timeInForce: "gfd",
        marketHours: "regular_hours",
        rationale: "High-quality setup.",
        tradeThesisTag: "Quality-Compounder",
        entryMarketRegime: "Neutral (Normal Volatility)",
        confidenceScore: 90
      } as any,
      undefined,
      true
    );

    expect(result).toMatchObject({
      rejected: true,
      available: true,
      reason: "Overbought into earnings.",
      model: "claude-opus-4-8",
      verdict: "reject",
      suggestedChange: null
    });
    // Token usage now rides along for the persisted debate transcript (w3-schema-dissent).
    expect(result.usage).toEqual({ promptTokens: 100, completionTokens: 20 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("api.anthropic.com");
    expect(calls[0].headers["x-api-key"]).toBe("sk-ant-test");
    expect(calls[0].headers["anthropic-version"]).toBe("2023-06-01");
    expect(calls[0].headers["anthropic-beta"]).toBe("prompt-caching-2024-07-31");
    expect(calls[0].headers.authorization).toBeUndefined();
    // Forced tool-use is how Claude returns guaranteed JSON. System is a single ephemeral cache
    // block now (Chat A item 3 prompt caching).
    expect(calls[0].body.system[0].text).toContain("Red Team");
    expect(calls[0].body.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(calls[0].body.tool_choice).toEqual({ type: "tool", name: "red_team_verdict" });
    expect(calls[0].body.max_tokens).toBeGreaterThan(0);
  });
});
