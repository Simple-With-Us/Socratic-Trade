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
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_URL;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_URL;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_URL;
});

// The single Red Team reviewer (post-consolidation): reviews are risk-adding OPENINGS only, the
// verdict is the three-way {verdict, reason} shape, the model comes ONLY from redTeamLlmModel
// (no green fallback, no env override, no default), and every failure mode is fail-CLOSED at the
// function-contract level as {rejected:false, available:false, failureKind} — the CALLER routes
// unavailable openings to human review.

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

/** Policy with an EXPLICIT Red model (no-defaults world: blank Red = not_configured before any fetch). */
const policyWithRed = (accountNumber: string, redModel = "openai/gpt-4.1-mini") => ({
  ...DEFAULT_POLICY,
  accountNumber,
  llmModel: "openai/gpt-4.1-mini",
  redTeamLlmModel: redModel
});

async function setupOpenAi(accountNumber: string, redModel?: string) {
  const { setPolicy, setStrategyPrompt } = await import("../src/lib/db");
  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_API_URL = "https://openrouter.ai/v1/chat/completions";
  process.env.OPENROUTER_API_KEY = "test-key";
  process.env.OPENROUTER_API_URL = "https://openrouter.ai/v1/chat/completions";
  setPolicy(policyWithRed(accountNumber, redModel));
  setStrategyPrompt("BASE STRATEGY");
}

function stubOpenAiJsonBody(payload: unknown) {
  vi.stubGlobal("fetch", async () => {
    return new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  });
}

describe("debateProposal — function-contract fail direction", () => {
  // A red-team failure must NEVER silently reject (drop) a trade at the FUNCTION level — it
  // reports {rejected:false, available:false}; the fail-closed hold is the caller's job.
  it("reports not_configured when NO Red model is chosen (no fallback to Green, no default)", async () => {
    const { setPolicy, setStrategyPrompt } = await import("../src/lib/db");
    const { debateProposal } = await import("../src/lib/red-team");
    process.env.OPENROUTER_API_KEY = "test-key";
    setPolicy({ ...DEFAULT_POLICY, accountNumber: "RT_NOMODEL", llmModel: "openai/gpt-4.1-mini" });
    setStrategyPrompt("BASE STRATEGY");
    let fetched = false;
    vi.stubGlobal("fetch", async () => {
      fetched = true;
      return new Response("{}", { status: 200 });
    });

    const result = await debateProposal(buyProposal(), undefined);
    expect(result.rejected).toBe(false);
    expect(result.available).toBe(false);
    expect(result.failureKind).toBe("not_configured");
    expect(result.reason).toMatch(/not chosen/i);
    expect(fetched).toBe(false); // never sends an empty-model request
  });

  it("reports not_configured when the Red model's provider has no key", async () => {
    const { setPolicy, setStrategyPrompt } = await import("../src/lib/db");
    const { debateProposal } = await import("../src/lib/red-team");
    delete process.env.OPENROUTER_API_KEY;
    setPolicy(policyWithRed("RT_NOKEY"));
    setStrategyPrompt("BASE STRATEGY");

    const result = await debateProposal(buyProposal(), undefined);
    expect(result.rejected).toBe(false);
    expect(result.available).toBe(false);
    expect(result.failureKind).toBe("not_configured");
  });

  it("refuses to review an exit (sell) — §3.5 structural guard", async () => {
    const { debateProposal } = await import("../src/lib/red-team");
    await setupOpenAi("RT_EXIT");
    let fetched = false;
    vi.stubGlobal("fetch", async () => {
      fetched = true;
      return new Response("{}", { status: 200 });
    });

    const result = await debateProposal({ ...buyProposal(), side: "sell" }, undefined);
    expect(result.available).toBe(false);
    expect(result.rejected).toBe(false);
    expect(result.reason).toMatch(/exits are exempt/i);
    expect(fetched).toBe(false);
  });

  it("does not reject when the LLM request throws", async () => {
    const { debateProposal } = await import("../src/lib/red-team");
    await setupOpenAi("RT_THROW");
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });

    const result = await debateProposal(buyProposal(), undefined);
    expect(result.rejected).toBe(false); // errored out → trade is not dropped by the red team
    expect(result.available).toBe(false);
  });
});

describe("debateProposal — three-way verdict + shape-violation fail-closed (§4.4)", () => {
  it.each([
    ["empty object", {}],
    ["legacy {rejected} shape", { rejected: false, reason: "ok" }],
    ["unknown verdict value", { verdict: "approve_with_caution", reason: "hedge" }],
    ["non-string verdict", { verdict: true, reason: "x" }],
    ["unrelated shape", { foo: 1 }]
  ])("fails closed (available:false, malformed_response) on a parseable-but-wrong-shape verdict: %s", async (_label, payload) => {
    const { debateProposal } = await import("../src/lib/red-team");
    await setupOpenAi("RT_SHAPE");
    stubOpenAiJsonBody(payload);

    const result = await debateProposal(buyProposal(), undefined);
    expect(result.available).toBe(false);
    expect(result.rejected).toBe(false);
    expect(result.verdict).toBeUndefined();
    expect(result.failureKind).toBe("malformed_response");
    expect(result.reason).toMatch(/malformed verdict/i);
  });

  it.each([
    ["approve", false],
    ["approve-at-half", false],
    ["reject", true]
  ] as const)("a valid {verdict: %s} is available:true with rejected=%s and no failureKind", async (verdict, rejected) => {
    const { debateProposal } = await import("../src/lib/red-team");
    await setupOpenAi(`RT_V_${verdict}`);
    stubOpenAiJsonBody({ verdict, reason: "Because." });

    const result = await debateProposal(buyProposal(), undefined);
    expect(result.available).toBe(true);
    expect(result.verdict).toBe(verdict);
    expect(result.rejected).toBe(rejected);
    expect(result.failureKind).toBeUndefined();
  });

  it("tolerates a markdown-fenced verdict (§4.1 — the gemini-3.5-flash failure)", async () => {
    const { debateProposal } = await import("../src/lib/red-team");
    await setupOpenAi("RT_FENCED");
    vi.stubGlobal("fetch", async () => {
      const fenced = "```json\n" + JSON.stringify({ verdict: "reject", reason: "Overbought." }) + "\n```";
      return new Response(
        JSON.stringify({ choices: [{ message: { content: fenced } }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const result = await debateProposal(buyProposal(), undefined);
    expect(result.available).toBe(true);
    expect(result.verdict).toBe("reject");
    expect(result.rejected).toBe(true);
  });

  // #1091: DeepSeek v4 Flash and other json_object-mode providers sometimes wrap a correct
  // verdict object in a bare array ([{verdict,reason}]). The parse unwraps the first element
  // instead of failing the whole review as malformed. This regression guard must survive the
  // single-adversary rewrite (the unwrap lives in debateProposal, before shape validation).
  it("recovers a valid verdict wrapped in a bare array (#1091 json_object-mode recovery)", async () => {
    const { debateProposal } = await import("../src/lib/red-team");
    await setupOpenAi("RT_ARRAY");
    stubOpenAiJsonBody([{ verdict: "reject", reason: "Array-wrapped verdict." }]);

    const result = await debateProposal(buyProposal(), undefined);
    expect(result.available).toBe(true);
    expect(result.verdict).toBe("reject");
    expect(result.rejected).toBe(true);
    expect(result.reason).toBe("Array-wrapped verdict.");
  });

  it("fails closed when a bare-array element is not a valid verdict object (#1091 guard)", async () => {
    const { debateProposal } = await import("../src/lib/red-team");
    await setupOpenAi("RT_ARRAY_BAD");
    stubOpenAiJsonBody([123, "not an object"]);

    const result = await debateProposal(buyProposal(), undefined);
    expect(result.available).toBe(false);
    expect(result.failureKind).toBe("malformed_response");
  });

  // Codex P1 (PR #1696): jsonrepair must never resurrect a TRUNCATED approval. A reply cut off
  // mid-object is repairable into `{"verdict":"approve"}` syntactically — but this gate is
  // fail-closed, so the parse stays strict and the review is unavailable.
  it("fails closed (unavailable) on a truncated approval — repair is never applied here", async () => {
    const { debateProposal } = await import("../src/lib/red-team");
    await setupOpenAi("RT_TRUNCATED");
    vi.stubGlobal("fetch", async () => new Response(
      JSON.stringify({ choices: [{ message: { content: '{"verdict":"approve","reason":"looks fi' } }] }),
      { status: 200, headers: { "content-type": "application/json" } }
    ));

    const result = await debateProposal(buyProposal(), undefined);
    expect(result.available).toBe(false);
    expect(result.rejected).toBe(false);
    expect(result.verdict).toBeUndefined();
    expect(result.failureKind).toBe("malformed_response");
  });

  // Codex P1 (PR #1696): a reply carrying TWO verdict blocks must not resolve to whichever block
  // is extracted first — ambiguous reviewer output is unavailable, whatever each block says.
  it.each([
    ["well-formed double block", '{"verdict":"approve","reason":"ok"} {"verdict":"reject","reason":"bad"}'],
    ["single-quoted double block", "{'verdict':'approve','reason':'ok'} {'verdict':'reject','reason':'bad'}"],
    ["multi-element conflicting array", '[{"verdict":"approve","reason":"ok"},{"verdict":"reject","reason":"bad"}]'],
    // JSON \uXXXX escape in the second block's key — parses as "verdict" but evades a literal
    // regex (Codex P1, round 3); the guard decodes escapes before counting.
    ["escaped-key second block", '{"verdict":"approve","reason":"ok"} {"\\u0076erdict":"reject","reason":"bad"}'],
    // Unquoted JSON5 key in the trailing block (Codex round 10) — must count as a verdict too.
    ["unquoted-key second block", '{"verdict":"approve","reason":"ok"} {verdict: "reject", reason: "bad"}']
  ])("fails closed on multiple verdict blocks (%s)", async (_label, content) => {
    const { debateProposal } = await import("../src/lib/red-team");
    await setupOpenAi("RT_AMBIGUOUS");
    vi.stubGlobal("fetch", async () => new Response(
      JSON.stringify({ choices: [{ message: { content } }] }),
      { status: 200, headers: { "content-type": "application/json" } }
    ));

    const result = await debateProposal(buyProposal(), undefined);
    expect(result.available).toBe(false);
    expect(result.rejected).toBe(false);
    expect(result.verdict).toBeUndefined();
    expect(result.failureKind).toBe("malformed_response");
    expect(result.reason).toMatch(/ambiguous|multiple/i);
  });

  it("classifies a 429 as rate_limited (without bounded retry)", async () => {
    const { debateProposal } = await import("../src/lib/red-team");
    await setupOpenAi("RT_429");
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls += 1;
      return new Response("Too Many Requests", { status: 429 });
    });

    const result = await debateProposal(buyProposal(), undefined);
    expect(result.available).toBe(false);
    expect(result.rejected).toBe(false);
    expect(result.failureKind).toBe("rate_limited");
    expect(calls).toBe(1); // §4.3: exactly one attempt, no bounded retry, then declare unavailable
  });

  it("classifies a 500 response as provider_error", async () => {
    const { debateProposal } = await import("../src/lib/red-team");
    await setupOpenAi("RT_500");
    vi.stubGlobal("fetch", async () => new Response("Internal Server Error", { status: 500 }));

    const result = await debateProposal(buyProposal(), undefined);
    expect(result.available).toBe(false);
    expect(result.rejected).toBe(false);
    expect(result.failureKind).toBe("provider_error");
  });

  it("classifies an AbortError (timeout) distinctly from other thrown errors", async () => {
    const { debateProposal } = await import("../src/lib/red-team");
    await setupOpenAi("RT_TIMEOUT");
    vi.stubGlobal("fetch", async () => {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    });

    const result = await debateProposal(buyProposal(), undefined);
    expect(result.available).toBe(false);
    expect(result.rejected).toBe(false);
    expect(result.failureKind).toBe("timeout");
  });

  it("classifies a generic thrown transport error as provider_error (not timeout)", async () => {
    const { debateProposal } = await import("../src/lib/red-team");
    await setupOpenAi("RT_TRANSPORT");
    vi.stubGlobal("fetch", async () => {
      throw new Error("boom: unexpected");
    });

    const result = await debateProposal(buyProposal(), undefined);
    expect(result.available).toBe(false);
    expect(result.rejected).toBe(false);
    expect(result.failureKind).toBe("provider_error");
  });
});

describe("debateProposal LLM request bounds", () => {
  it("adds chat-completions output caps and the adversary sampling temperature", async () => {
    const { debateProposal } = await import("../src/lib/red-team");
    await setupOpenAi("RED-TEAM");

    const bodies: any[] = [];
    vi.stubGlobal("fetch", async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ verdict: "approve", reason: "No fatal flaw found." }) } }]
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
      "local",
      undefined,
      { sizing: { estimatedNotional: 25, sizeBasis: "notional" } }
    );

    expect(result).toEqual({
      verdict: "approve",
      rejected: false,
      available: true,
      reason: "No fatal flaw found.",
      model: "gpt-mini-latest"
    });
    expect(bodies).toHaveLength(1);
    expect(bodies[0].max_completion_tokens).toBe(LLM_OUTPUT_TOKEN_CAPS.adversaryReview);
    // Per-role sampling: the adversary samples at a non-zero temperature (vs the Bull's greedy 0).
    expect(bodies[0].temperature).toBe(LLM_REQUEST_DEFAULTS.adversaryTemperature);
    expect(bodies[0].max_output_tokens).toBe(LLM_OUTPUT_TOKEN_CAPS.adversaryReview);
    // OpenAI-compatible providers request STRICT json_schema (not a bare json_object), so the
    // verdict is schema-enforced rather than regex/prose-parsed.
    expect(bodies[0].response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "red_team_verdict", strict: true, schema: expect.any(Object) }
    });
    // §3.4 — the finalized size is stated to the model upfront, alongside the proposal itself.
    const userMsg = JSON.parse(bodies[0].messages[1].content);
    expect(userMsg.finalizedSizing).toEqual({ estimatedNotional: 25, sizeBasis: "notional" });
    expect(userMsg.proposal.symbol).toBe("AAPL");
  });
});

describe("debateProposal — Claude Red Team (via OpenRouter)", () => {
  it("routes a claude-* redTeamLlmModel via OpenRouter chat completions", async () => {
    const { setPolicy, setStrategyPrompt, upsertUserApiKey } = await import("../src/lib/db");
    const { debateProposal } = await import("../src/lib/red-team");

    upsertUserApiKey("local", "openrouter", "sk-ant-test", "test");
    process.env.OPENROUTER_API_KEY = "sk-ant-test";
    setPolicy({ ...DEFAULT_POLICY, accountNumber: "RT_CLAUDE", llmModel: "gpt-5.4-mini", redTeamLlmModel: "anthropic/claude-opus-4-8" });
    setStrategyPrompt("BASE STRATEGY");

    const calls: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: JSON.parse(String(init?.body ?? "{}"))
      });
      // OpenAI-compatible chat completion response shape.
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ verdict: "reject", reason: "Overbought into earnings." }) } }]
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
      undefined
    );

    expect(result).toEqual({
      verdict: "reject",
      rejected: true,
      available: true,
      reason: "Overbought into earnings.",
      model: "claude-opus-latest"
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("openrouter.ai");
    expect(calls[0].headers.authorization).toBe("Bearer sk-ant-test");
    // System is sent as a message in OpenAI format
    expect(calls[0].body.messages[0].role).toBe("system");
    expect(calls[0].body.messages[0].content).toContain("Red Team");
    
    // In chat-completions, max_completion_tokens (and max_output_tokens due to polyfill) is used
    expect(calls[0].body.max_output_tokens).toBeGreaterThan(0);
    expect(calls[0].body.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "red_team_verdict", strict: true, schema: expect.any(Object) }
    });
  });
});
