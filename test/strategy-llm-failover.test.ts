import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";

// Item 4 (Chat A): ordered cross-provider failover for the Green Team (Bull) call. Default OFF. When
// policy.llmFallbackModels is set, a transient primary failure (429/5xx/timeout) transparently serves
// via the next model, recorded loudly (strategy_llm_failover audit + served model/provider on the step).

vi.mock("../src/lib/vector-db", () => ({
  managedVectorLedgerAuthority: vi.fn(),
  getCurrentVectorProviderAuthority: vi.fn(),
  findRelevantExperiences: async () => [],
  upsertExperiences: async () => {},
  retrieveContext: async () => [],
  retrieveContextDetailed: async () => [],
  defaultMinScore: () => 0.3,
  defaultRelevanceFloor: () => 0.3,
  defaultDedupeSimilarity: () => 0.6,
  formatChunkWithProvenance: (chunk: { text: string }) => chunk.text,
  storeContext: async () => {},
  storeContexts: async () => {}
}));

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-failover-${randomUUID()}.db`)}`;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// Which model a request actually asks for, read from the request's OWN `model` field.
//
// These mocks used to branch on `String(init.body).includes("gpt-")` / `.includes("claude")`.  That
// matched ANY occurrence of the model name anywhere in the serialized payload, which is fine right
// up until the payload legitimately mentions another model -- e.g. a proposal carrying a
// `greenServedByFallback.fromModel` receipt that names the primary which failed.  The Red Team call
// then matched the GREEN branch and returned a 429/400, parking a provider-cooldown lane that
// leaked into the next test in this file.  A real provider routes on the `model` field; so does
// this.
function requestedModel(init?: RequestInit): string {
  try {
    const parsed = JSON.parse(init?.body ? String(init.body) : "{}") as { model?: unknown };
    return typeof parsed.model === "string" ? parsed.model : "";
  } catch {
    return "";
  }
}

const PROPOSALS_JSON = JSON.stringify({
  proposals: [
    { symbol: "AAPL", side: "buy", type: "market", dollarAmount: 500, timeInForce: "gfd", marketHours: "regular_hours", rationale: "Bull thesis served via fallback provider.", tradeThesisTag: "Breakout", confidenceScore: 55 }
  ]
});

function nasdaqRow(): Response {
  return new Response(
    JSON.stringify({ data: { asof: "2026-06-15", table: { rows: [{ symbol: "AAPL", lastsale: "$200", pctchange: "1%", volume: "1000000", marketCap: "3000000000000", sector: "Technology", industry: "Consumer Electronics" }] } } }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

// Gemini uses an OpenAI-compatible (chat-completions / choices) response shape.
function geminiOk(): Response {
  return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: PROPOSALS_JSON } }] }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function geminiRedOk(): Response {
  return new Response(
    JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ verdict: "approve", reason: "Size is fine." }) } }]
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

async function setup(withFallback: boolean): Promise<void> {
  const { setPolicy, upsertConnectedAccount, setActiveConnectedAccount, upsertUserApiKey } = await import("../src/lib/db");
  upsertUserApiKey("local", "openrouter", "test-openai-key", "fixture");
  upsertUserApiKey("local", "gemini", "test-gemini-key", "fixture");
  const accountId = randomUUID();
  upsertConnectedAccount({ id: accountId, userId: "local", broker: "test", environment: "paper", accountNumber: "TEST", label: "Failover Test", isActive: true });
  setActiveConnectedAccount(accountId);
  setPolicy({
    ...DEFAULT_POLICY,
    systemState: "active",
    llmModel: "openrouter/openai/gpt-4.1-mini",
    includedIndices: [],
    additionalSymbols: ["AAPL"],
    strategyAuthority: "decide",
    // With fallback: the Bull fails over to gemini, and the Bear also uses gemini so it isn't hit by
    // the primary's 429. Without fallback: single primary endpoint (default behavior).
    ...(withFallback
      ? {
          llmFallbackModels: ["openrouter/google/gemini-2.5-flash"],
          redTeamLlmModel: "openrouter/google/gemini-2.5-flash"
        }
      : {})
  });
}

describe("cross-provider Bull failover (Chat A item 4)", () => {
  it("flag ON: a 429 from the primary transparently serves via the fallback model and is recorded", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-openai-key");
    vi.stubEnv("GEMINI_API_KEY", "test-gemini-key");
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if ((href.includes("openrouter.ai") || href.includes("api.openai.com"))) {
        if (requestedModel(init).includes("gpt-")) return new Response("rate limited", { status: 429 });
        return geminiOk();
      }
      if (href.includes("nasdaq.com")) return nasdaqRow();
      return new Response("not found", { status: 404 });
    });
    await setup(true);
    const { runStrategyOnce } = await import("../src/lib/strategy");
    const { listAudit } = await import("../src/lib/db");

    const result = await runStrategyOnce();

    expect(result.status).toBe("completed");
    // The failover is loudly recorded in the run's decision/audit trail.
    const runKinds = listAudit(500)
      .filter((e) => (e.payload as { runId?: string })?.runId === result.runId)
      .map((e) => e.kind);
    expect(runKinds).toContain("strategy_llm_failover");
    // The Green Team step reflects the model/provider that actually SERVED the run.
    const bullStep = result.llmSteps?.find((s) => s.step === "bull");
    expect(bullStep?.provider).toBe("gemini");
    expect(bullStep?.reason ?? "").toMatch(/fallback|served|failed/i);
    // t3: each proposal is stamped with the FAILOVER-AWARE policy model — the fallback that
    // actually generated it, in the exact OpenRouter namespace the approval card compares
    // against `llmFallbackModels`.
    expect(result.proposals.length).toBeGreaterThan(0);
    for (const p of result.proposals) {
      expect(p.proposal.proposedByModel).toBe("openrouter/google/gemini-2.5-flash");
    }
  }, 30_000);

  it("flag ON: an HTTP-200 EMPTY body from the primary transparently fails over (provider glitch, not an HTTP error)", async () => {
    // Prod incident 2026-07-28..30: OpenRouter returned 200 with EMPTY content, which
    // isRetryableLlmError deliberately doesn't match, so the whole run failed even with a
    // healthy fallback configured. The empty body now fails over like any other transient
    // attempt failure, with an explicit reason on the failover audit row.
    vi.stubEnv("OPENROUTER_API_KEY", "test-openai-key");
    vi.stubEnv("GEMINI_API_KEY", "test-gemini-key");
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("openrouter.ai") || href.includes("api.openai.com")) {
        if (requestedModel(init).includes("claude")) {
          return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "" } }] }), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }
        return geminiOk();
      }
      if (href.includes("nasdaq.com")) return nasdaqRow();
      return new Response("not found", { status: 404 });
    });
    await setup(true);
    // Use a DISTINCT primary provider lane: the 429 test above legitimately parks the `openai`
    // lane in the provider-cooldown registry (llm_provider_cooldown_skip keys the underlying
    // provider from the model prefix), which would skip the primary attempt here entirely
    // instead of letting it return the empty body under test.
    const { setPolicy, getPolicy } = await import("../src/lib/db");
    setPolicy({ ...getPolicy("local"), llmModel: "openrouter/anthropic/claude-3-haiku" });
    const { runStrategyOnce } = await import("../src/lib/strategy");
    const { listAudit } = await import("../src/lib/db");

    const result = await runStrategyOnce();

    expect(result.status).toBe("completed");
    const failoverRows = listAudit(5000).filter(
      (e) => (e.payload as { runId?: string })?.runId === result.runId && e.kind === "strategy_llm_failover"
    );
    expect(failoverRows.length).toBeGreaterThan(0);
    const bullFailover = failoverRows.find(
      (e) => (e.payload as { step?: string })?.step === "bull"
    );
    expect((bullFailover?.payload as { reason?: string })?.reason).toBe("empty_response");
    expect((bullFailover?.payload as { toModel?: string })?.toModel).toBe("~google/gemini-flash-latest");
    const bullStep = result.llmSteps?.find((s) => s.step === "bull");
    expect(bullStep?.provider).toBe("gemini");
  }, 30_000);

  it("flag ON: a malformed HTTP-200 JSON body from the primary fails over (same class as empty content)", async () => {
    // Issue #2577: Red Team already continued on malformed HTTP-200 content; Green/Bull's
    // response.json() throw was not retryable, so the run died on the primary.
    vi.stubEnv("OPENROUTER_API_KEY", "test-openai-key");
    vi.stubEnv("GEMINI_API_KEY", "test-gemini-key");
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("openrouter.ai") || href.includes("api.openai.com")) {
        if (requestedModel(init).includes("claude")) {
          return new Response("{not-json", { status: 200, headers: { "content-type": "application/json" } });
        }
        return geminiOk();
      }
      if (href.includes("nasdaq.com")) return nasdaqRow();
      return new Response("not found", { status: 404 });
    });
    await setup(true);
    const { setPolicy, getPolicy } = await import("../src/lib/db");
    setPolicy({ ...getPolicy("local"), llmModel: "openrouter/anthropic/claude-3-haiku" });
    const { runStrategyOnce } = await import("../src/lib/strategy");
    const { listAudit } = await import("../src/lib/db");

    const result = await runStrategyOnce();

    expect(result.status).toBe("completed");
    const failoverRows = listAudit(5000).filter(
      (e) => (e.payload as { runId?: string })?.runId === result.runId && e.kind === "strategy_llm_failover"
    );
    expect(failoverRows.length).toBeGreaterThan(0);
    const bullFailover = failoverRows.find((e) => (e.payload as { step?: string })?.step === "bull");
    expect((bullFailover?.payload as { reason?: string })?.reason).toBe("malformed_response");
    expect((bullFailover?.payload as { toModel?: string })?.toModel).toBe("~google/gemini-flash-latest");
    const bullStep = result.llmSteps?.find((s) => s.step === "bull");
    expect(bullStep?.provider).toBe("gemini");
  }, 30_000);

  it("run_failed names OpenRouter credits exhausted when the cached check is below threshold", async () => {
    // Issue #2577 ask 2: empty-response deaths during a credits-low day should say so.
    vi.stubEnv("OPENROUTER_API_KEY", "test-openai-key");
    vi.stubEnv("OPENROUTER_LOW_CREDIT_USD", "3");
    const { __resetOpenRouterCreditCache } = await import("../src/lib/openrouter-credits");
    __resetOpenRouterCreditCache();
    vi.stubGlobal("fetch", async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes("/api/v1/credits") || href.endsWith("/credits")) {
        return new Response(JSON.stringify({ data: { total_credits: 10, total_usage: 9.88 } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (href.includes("openrouter.ai") || href.includes("api.openai.com")) {
        return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (href.includes("nasdaq.com")) return nasdaqRow();
      return new Response("not found", { status: 404 });
    });
    await setup(false);
    // Distinct provider lane so the 429 test above cannot park this primary in cooldown.
    const { setPolicy, getPolicy } = await import("../src/lib/db");
    setPolicy({ ...getPolicy("local"), llmModel: "openrouter/anthropic/claude-3-haiku" });
    const { runStrategyOnce } = await import("../src/lib/strategy");
    const { listNotificationEvents } = await import("../src/lib/db");

    const result = await runStrategyOnce();

    expect(result.status).toBe("failed");
    expect(result.summary).toMatch(/Empty response returned from LLM API/);
    expect(result.summary).toMatch(/OpenRouter credits look exhausted \(\$0\.12 remaining; alert floor \$3\.00\)/);
    const failed = listNotificationEvents("local").filter((e) => e.type === "run_failed");
    expect(failed.length).toBeGreaterThan(0);
    expect(String((failed[0]?.payload as { summary?: string })?.summary ?? "")).toMatch(/credits look exhausted/);
  }, 30_000);

  it("a 400 Provider returned error on Green fails over and records each stored call", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-openai-key");
    vi.stubEnv("GEMINI_API_KEY", "test-gemini-key");
    let greenCalls = 0;
    let redCalls = 0;
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("openrouter.ai") || href.includes("api.openai.com") || href.includes("generativelanguage.googleapis.com")) {
        const bodyStr = init?.body ? String(init.body) : "";
        if (bodyStr.includes("red_team_verdict")) {
          redCalls += 1;
          return geminiRedOk();
        }
        const greenModel = requestedModel(init);
        if (greenModel.includes("claude") || greenModel.includes("gpt-")) {
          greenCalls += 1;
          return new Response(JSON.stringify({ error: { message: "Provider returned error", code: 400 } }), {
            status: 400,
            headers: { "content-type": "application/json" }
          });
        }
        greenCalls += 1;
        return geminiOk();
      }
      if (href.includes("nasdaq.com")) return nasdaqRow();
      return new Response("not found", { status: 404 });
    });
    await setup(true);
    const { setPolicy, getPolicy } = await import("../src/lib/db");
    setPolicy({ ...getPolicy("local"), llmModel: "openrouter/anthropic/claude-3-haiku" });
    const { runStrategyOnce } = await import("../src/lib/strategy");
    const { listAudit } = await import("../src/lib/db");

    const result = await runStrategyOnce();

    expect(result.status).toBe("completed");
    const failoverRows = listAudit(5000).filter(
      (e) => (e.payload as { runId?: string })?.runId === result.runId && e.kind === "strategy_llm_failover"
    );
    expect(failoverRows.length).toBeGreaterThan(0);
    expect((failoverRows[0]?.payload as { httpStatus?: number })?.httpStatus).toBe(400);
    const bullLatency = listAudit(5000).filter(
      (e) =>
        (e.payload as { runId?: string; step?: string })?.runId === result.runId &&
        e.kind === "llm_call_latency" &&
        (e.payload as { step?: string }).step === "bull"
    );
    expect(bullLatency.length).toBeGreaterThanOrEqual(2);
    expect(bullLatency.map((e) => (e.payload as { status?: number }).status)).toContain(400);
    expect(result.proposals.length).toBeGreaterThan(0);
    for (const p of result.proposals) {
      expect(p.proposal.proposedByModel).toBe("openrouter/google/gemini-2.5-flash");
    }
    expect(redCalls).toBeGreaterThanOrEqual(1);
    expect(result.proposals.some((p) => p.proposal.redTeamVerdict?.available)).toBe(true);
    expect(greenCalls).toBeGreaterThanOrEqual(2);
  }, 30_000);

  it("flag OFF (default): a primary 429 is a hard failure — no failover, behavior unchanged", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-openai-key");
    vi.stubGlobal("fetch", async (url: string | URL | Request) => {
      const href = String(url);
      if ((href.includes("openrouter.ai") || href.includes("api.openai.com"))) return new Response("rate limited", { status: 429 });
      if (href.includes("nasdaq.com")) return nasdaqRow();
      return new Response("not found", { status: 404 });
    });
    await setup(false);
    const { runStrategyOnce } = await import("../src/lib/strategy");
    const { listAudit } = await import("../src/lib/db");

    const result = await runStrategyOnce();

    expect(result.status).toBe("failed");
    const runKinds = listAudit(500)
      .filter((e) => (e.payload as { runId?: string })?.runId === result.runId)
      .map((e) => e.kind);
    expect(runKinds).not.toContain("strategy_llm_failover");
  }, 30_000);
});

it("Code CLI primary never advances to a configured paid API fallback", async () => {
  vi.stubEnv("PRIMARY_USER_EMAIL", "owner@example.com");
  vi.stubEnv("CODE_CLI_ENABLED", "true");vi.stubEnv("CODE_CLI_OWNER_EMAIL","owner@example.com");
  vi.stubEnv("CODE_CLI_OWNER_USER_ID","local");vi.stubEnv("CODE_CLI_BROKER_URL","https://broker.internal/generate");
  vi.stubEnv("CODE_CLI_BROKER_TOKEN","test-broker-token");
  await setup(true);
  const {getPolicy,setPolicy,setUserSetting}=await import("../src/lib/db");
  setUserSetting("local","llm_route_minimax","code-cli");
  setPolicy({...getPolicy(),llmModel:"minimax-m3",llmFallbackModels:["openrouter/google/gemini-2.5-flash"]});
  const paidCalls: string[]=[];let brokerCalls=0;
  vi.stubGlobal("fetch",async(url:string|URL|Request)=>{
    const href=String(url);
    if(href==="https://broker.internal/generate"){brokerCalls++;return new Response("unavailable",{status:503});}
    if(href.includes("openrouter.ai") || href.includes("api.openai.com") || href.includes("api.minimax.io")){paidCalls.push(href);return geminiOk();}
    if(href.includes("nasdaq.com"))return nasdaqRow();
    return new Response("not found",{status:404});
  });
  try {
    const {runStrategyOnce}=await import("../src/lib/strategy");const result=await runStrategyOnce();
    expect(brokerCalls).toBeGreaterThan(0);expect(paidCalls).toEqual([]);
    expect(result.proposals).toHaveLength(0);
  } finally { setUserSetting("local","llm_route_minimax","openrouter"); }
},30000);
