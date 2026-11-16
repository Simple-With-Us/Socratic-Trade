import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import { LLM_OUTPUT_TOKEN_CAPS, LLM_REQUEST_DEFAULTS } from "../src/lib/llm-request";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-post-mortem-${randomUUID()}.db`)}`;
  // The first test bears the full better-sqlite3 migration cost and can blow vitest's default
  // timeout under machine load; a timed-out reflection then bleeds its still-pending fetch into
  // the next test's stub. Same flake class as the approval-lock tests (fixed 2026-06-21 with a
  // 20s per-test timeout).
  vi.setConfig({ testTimeout: 20_000 });
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_URL;
  delete process.env.TRIGGER_LLM_DAILY_TOKEN_BUDGET;
});

describe("generateReflectionSummary", () => {
  it("bounds the reflection request and sends broker paper execution context", async () => {
    const userId = `post-mortem-${randomUUID()}`;
    const accountNumber = "APCA-PAPER-REFLECT";
    const accountId = randomUUID();
    const { getUserSetting, insertFillEvent, setActiveConnectedAccount, setPolicy, upsertConnectedAccount } = await import("../src/lib/db");
    const { generateReflectionSummary } = await import("../src/lib/post-mortem");

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
    // Classic model so this asserts temperature + exact caps (reasoning bounds: test/llm-request.test.ts).
    setPolicy({ ...DEFAULT_POLICY, accountNumber, activeBroker: "alpaca", llmModel: "openai/gpt-4.1-mini" }, userId);
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

    let requestBody: any;
    vi.stubGlobal("fetch", async (_url: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body ?? "{}"));
      return new Response(JSON.stringify({ output_text: "Keep broker paper results separate from local simulation." }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });

    await generateReflectionSummary(accountNumber, userId);

    expect(requestBody.max_output_tokens ?? requestBody.max_completion_tokens ?? requestBody.max_tokens).toBe(LLM_OUTPUT_TOKEN_CAPS.postMortemReflection);
    expect(requestBody.temperature).toBe(LLM_REQUEST_DEFAULTS.deterministicTemperature);
    
    const context = JSON.parse(requestBody.input.find((item: any) => item.role === "user")?.content ?? "{}");
    expect(context.executionMode).toBe("broker/paper");
    expect(context.executionModeClarification).toContain("Alpaca Paper");
    expect(context.recentTrades[0]?.symbol).toBe("AAPL");
    // Summary is stored under the ACCOUNT-scoped key, not the legacy shared per-user key.
    expect(getUserSetting(userId, `reflection_summary:${accountNumber}`, "")).toContain("broker paper");
    expect(getUserSetting(userId, "reflection_summary", "")).toBe("");
  });

  it("keeps per-account signatures independent and writes per-account summaries", async () => {
    const userId = `post-mortem-multi-${randomUUID()}`;
    const accountA = "APCA-PAPER-A";
    const accountB = "APCA-LIVE-B";
    const accountId = randomUUID();
    const { getUserSetting, insertFillEvent, setActiveConnectedAccount, setPolicy, upsertConnectedAccount } = await import("../src/lib/db");
    const { generateReflectionSummary, getReflectionSummary } = await import("../src/lib/post-mortem");

    process.env.OPENROUTER_API_KEY = "test-key";
    process.env.OPENROUTER_API_URL = "https://openrouter.ai/v1/responses";

    upsertConnectedAccount({ id: accountId, userId, broker: "alpaca", environment: "paper", accountNumber: accountA, label: "Alpaca Paper", isActive: true });
    setActiveConnectedAccount(accountId, userId);
    setPolicy({ ...DEFAULT_POLICY, accountNumber: accountA, activeBroker: "alpaca", llmModel: "openai/gpt-4.1-mini" }, userId);
    // IDENTICAL fill count + filled_at across the two accounts: under the old per-user
    // signature key this made account B's run dedupe away against account A's signature.
    const filledAt = new Date().toISOString();
    insertFillEvent({ userId, accountNumber: accountA, source: "paper", executionMode: "broker/paper", symbol: "AAPL", side: "buy", quantity: 1, price: 100, notional: 100, status: "filled", filledAt });
    insertFillEvent({ userId, accountNumber: accountB, source: "live", executionMode: "broker/live", symbol: "MSFT", side: "buy", quantity: 1, price: 200, notional: 200, status: "filled", filledAt });

    let llmCalls = 0;
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      llmCalls += 1;
      return new Response(JSON.stringify({ output_text: `reflection ${llmCalls}` }), { status: 200, headers: { "content-type": "application/json" } });
    });

    console.log("Before generateReflectionSummary");
    await generateReflectionSummary(accountA, userId);
    console.log("After generateReflectionSummary", llmCalls);
    expect(llmCalls).toBe(1);
    // Same account, unchanged history: the scoped signature dedupe still holds.
    await generateReflectionSummary(accountA, userId);
    expect(llmCalls).toBe(1);
    // DIFFERENT account: must not be deduped away by account A's signature.
    // wait, account B needs its policy to be active or resolved? 
    setPolicy({ ...DEFAULT_POLICY, accountNumber: accountB, activeBroker: "alpaca", llmModel: "openai/gpt-4.1-mini" }, userId);
    await generateReflectionSummary(accountB, userId);
    expect(llmCalls).toBe(2);

    expect(getUserSetting(userId, `reflection_summary:${accountA}`, "")).toBe("reflection 1");
    expect(getUserSetting(userId, `reflection_summary:${accountB}`, "")).toBe("reflection 2");
    // The prompt-side reader resolves each account to ITS OWN summary.
    expect(getReflectionSummary(userId, accountA)).toBe("reflection 1");
    expect(getReflectionSummary(userId, accountB)).toBe("reflection 2");
  });

  it("recovers thesis tags from legacy proposals (NULL columns, tags only in JSON) into the reflection prompt", async () => {
    const userId = `post-mortem-coalesce-${randomUUID()}`;
    const accountNumber = "APCA-PAPER-COALESCE";
    const accountId = randomUUID();
    const { getDb, insertFillEvent, setActiveConnectedAccount, setPolicy, upsertConnectedAccount } = await import("../src/lib/db");
    const { generateReflectionSummary } = await import("../src/lib/post-mortem");

    process.env.OPENROUTER_API_KEY = "test-key";
    process.env.OPENROUTER_API_URL = "https://openrouter.ai/v1/responses";

    upsertConnectedAccount({ id: accountId, userId, broker: "alpaca", environment: "paper", accountNumber, label: "Alpaca Paper", isActive: true });
    setActiveConnectedAccount(accountId, userId);
    setPolicy({ ...DEFAULT_POLICY, accountNumber, activeBroker: "alpaca", llmModel: "openai/gpt-4.1-mini" }, userId);

    // Legacy-shaped proposal row: dedicated columns NULL, tags only inside the proposal JSON —
    // inserted via raw SQL because insertProposal now auto-fills the columns.
    const proposalId = `legacy-coalesce-${randomUUID()}`;
    getDb().prepare(
      "INSERT INTO trade_proposals (id, user_id, run_id, account_number, created_at, proposal, decision, status, trade_thesis_tag, entry_market_regime) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)"
    ).run(
      proposalId,
      userId,
      `run-${randomUUID()}`,
      accountNumber,
      new Date().toISOString(),
      JSON.stringify({ symbol: "AAPL", side: "buy", tradeThesisTag: "Momentum-Breakout", entryMarketRegime: "Risk-On", rationale: "legacy row" }),
      JSON.stringify({ approved: true, reasons: [] }),
      "filled"
    );
    insertFillEvent({ userId, accountNumber, proposalId, source: "paper", executionMode: "broker/paper", symbol: "AAPL", side: "buy", quantity: 1, price: 100, notional: 100, status: "filled" });

    let requestBody: any;
    vi.stubGlobal("fetch", async (_url: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body ?? "{}"));
      return new Response(JSON.stringify({ output_text: "legacy tags recovered" }), { status: 200, headers: { "content-type": "application/json" } });
    });

    await generateReflectionSummary(accountNumber, userId);

    const context = JSON.parse(requestBody.input.find((item: any) => item.role === "user")?.content ?? "{}");
    // The SELECT's COALESCE recovers the tags from the proposal JSON even though the dedicated
    // columns are NULL — this was the split-brain that told the LLM "thesisTag: null" for every
    // trade while the same prompt's scorecards showed per-thesis rows.
    expect(context.recentTrades[0]?.thesisTag).toBe("Momentum-Breakout");
    expect(context.recentTrades[0]?.regime).toBe("Risk-On");
  });

  it("legacy shared summary: feeds reads only until the first scoped write retires it", async () => {
    const userId = `post-mortem-legacy-${randomUUID()}`;
    const accountNumber = "APCA-PAPER-LEGACY";
    const fillLessSibling = "APCA-LIVE-EMPTY";
    const accountId = randomUUID();
    const { getUserSetting, setUserSetting, insertFillEvent, setActiveConnectedAccount, setPolicy, upsertConnectedAccount } = await import("../src/lib/db");
    const { generateReflectionSummary, getReflectionSummary } = await import("../src/lib/post-mortem");

    process.env.OPENROUTER_API_KEY = "test-key";
    process.env.OPENROUTER_API_URL = "https://openrouter.ai/v1/responses";

    upsertConnectedAccount({ id: accountId, userId, broker: "alpaca", environment: "paper", accountNumber, label: "Alpaca Paper", isActive: true });
    setActiveConnectedAccount(accountId, userId);
    setPolicy({ ...DEFAULT_POLICY, accountNumber, activeBroker: "alpaca", llmModel: "openai/gpt-4.1-mini" }, userId);
    insertFillEvent({ userId, accountNumber, source: "paper", executionMode: "broker/paper", symbol: "AAPL", side: "buy", quantity: 1, price: 100, notional: 100, status: "filled" });

    // Pre-scoping install state: one shared per-user summary row.
    setUserSetting(userId, "reflection_summary", "legacy shared lessons");
    // Before any scoped write exists, every account (even the one with no scoped row) falls
    // back to the legacy shared row — existing prompts keep flowing across the transition.
    expect(getReflectionSummary(userId, accountNumber)).toBe("legacy shared lessons");
    expect(getReflectionSummary(userId, fillLessSibling)).toBe("legacy shared lessons");

    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ output_text: "scoped lessons" }), { status: 200, headers: { "content-type": "application/json" } })
    );
    await generateReflectionSummary(accountNumber, userId);

    // The first scoped write retires the legacy row entirely: the writer reads its own scoped
    // summary, and a fill-less sibling degrades to the honest "no reflection yet" state instead
    // of another account's lessons.
    expect(getUserSetting(userId, "reflection_summary", "")).toBe("");
    expect(getReflectionSummary(userId, accountNumber)).toBe("scoped lessons");
    expect(getReflectionSummary(userId, fillLessSibling)).toBe("");
  });

  it("reflection write skips the policy_change audit but carries account attribution; normal setUserSetting still audits", async () => {
    const userId = `post-mortem-audit-${randomUUID()}`;
    const accountNumber = "APCA-PAPER-AUDIT";
    const accountId = randomUUID();
    const { getDb, setUserSetting, insertFillEvent, setActiveConnectedAccount, setPolicy, upsertConnectedAccount } = await import("../src/lib/db");
    const { generateReflectionSummary } = await import("../src/lib/post-mortem");

    process.env.OPENROUTER_API_KEY = "test-key";
    process.env.OPENROUTER_API_URL = "https://openrouter.ai/v1/responses";

    upsertConnectedAccount({ id: accountId, userId, broker: "alpaca", environment: "paper", accountNumber, label: "Alpaca Paper", isActive: true });
    setActiveConnectedAccount(accountId, userId);
    setPolicy({ ...DEFAULT_POLICY, accountNumber, activeBroker: "alpaca", connectedAccountId: accountId, llmModel: "openai/gpt-4.1-mini" }, userId);
    insertFillEvent({ userId, accountNumber, source: "paper", executionMode: "broker/paper", symbol: "AAPL", side: "buy", quantity: 1, price: 100, notional: 100, status: "filled" });

    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ output_text: "audited lessons" }), { status: 200, headers: { "content-type": "application/json" } })
    );
    await generateReflectionSummary(accountNumber, userId);

    const policyChanges = getDb()
      .prepare("SELECT payload FROM audit_events WHERE user_id = ? AND kind = 'policy_change'")
      .all(userId) as Array<{ payload: string }>;
    // The hourly reflection write must not masquerade as a user policy change in the feed.
    expect(policyChanges.filter((row) => row.payload.includes("reflection_summary"))).toEqual([]);

    // Its dedicated audit event exists and is attributed to the connected account.
    const reflections = getDb()
      .prepare("SELECT payload, connected_account_id FROM audit_events WHERE user_id = ? AND kind = 'post_mortem_reflection'")
      .all(userId) as Array<{ payload: string; connected_account_id: string | null }>;
    expect(reflections).toHaveLength(1);
    expect(reflections[0].connected_account_id).toBe(accountId);
    const reflectionPayload = JSON.parse(reflections[0].payload);
    expect(reflectionPayload.accountNumber).toBe(accountNumber);
    // Model attribution "on every decision surface incl. failure states" (#1076) — the reflection
    // is an LLM decision too, so its Journal entry must be able to show which model produced it.
    expect(reflectionPayload.model).toBe("openai/gpt-4.1-mini");
    expect(reflectionPayload.provider).toBe("openrouter");

    // Opt-out is reflection-only: an ordinary user-setting write still emits policy_change.
    setUserSetting(userId, "some_user_pref", "on");
    const afterNormalWrite = getDb()
      .prepare("SELECT payload FROM audit_events WHERE user_id = ? AND kind = 'policy_change'")
      .all(userId) as Array<{ payload: string }>;
    expect(afterNormalWrite.some((row) => row.payload.includes("some_user_pref"))).toBe(true);
  });

  it("a failed reflection LLM call still audits a model-attributed failure record (incl. failure states)", async () => {
    const userId = `post-mortem-failed-${randomUUID()}`;
    const accountNumber = "APCA-PAPER-FAILED";
    const accountId = randomUUID();
    const { getDb, insertFillEvent, setActiveConnectedAccount, setPolicy, upsertConnectedAccount } = await import("../src/lib/db");
    const { generateReflectionSummary } = await import("../src/lib/post-mortem");

    process.env.OPENROUTER_API_KEY = "test-key";
    process.env.OPENROUTER_API_URL = "https://openrouter.ai/v1/responses";

    upsertConnectedAccount({ id: accountId, userId, broker: "alpaca", environment: "paper", accountNumber, label: "Alpaca Paper", isActive: true });
    setActiveConnectedAccount(accountId, userId);
    setPolicy({ ...DEFAULT_POLICY, accountNumber, activeBroker: "alpaca", connectedAccountId: accountId, llmModel: "openai/gpt-4.1-mini" }, userId);
    insertFillEvent({ userId, accountNumber, source: "paper", executionMode: "broker/paper", symbol: "AAPL", side: "buy", quantity: 1, price: 100, notional: 100, status: "filled" });

    vi.stubGlobal("fetch", async () => new Response("rate limited", { status: 429, headers: { "content-type": "text/plain" } }));

    // Before this fix, a failed call produced console.warn only — no audit at all, so the Journal
    // never showed anything happened. Must complete cleanly, not throw.
    await expect(generateReflectionSummary(accountNumber, userId)).resolves.toBeUndefined();

    const reflections = getDb()
      .prepare("SELECT payload, connected_account_id FROM audit_events WHERE user_id = ? AND kind = 'post_mortem_reflection'")
      .all(userId) as Array<{ payload: string; connected_account_id: string | null }>;
    expect(reflections).toHaveLength(1);
    expect(reflections[0].connected_account_id).toBe(accountId);
    const failurePayload = JSON.parse(reflections[0].payload);
    expect(failurePayload.status).toBe("failed");
    expect(failurePayload.model).toBe("openai/gpt-4.1-mini");
    expect(failurePayload.provider).toBe("openrouter");
    expect(typeof failurePayload.reason).toBe("string");
  });

  it("over the daily LLM budget: skips the reflection LLM call, does not throw (non-LLM excursion path still runs)", async () => {
    const userId = `post-mortem-budget-${randomUUID()}`;
    const accountNumber = "APCA-PAPER-BUDGET";
    const accountId = randomUUID();
    const { getUserSetting, insertFillEvent, setActiveConnectedAccount, setPolicy, upsertConnectedAccount } = await import("../src/lib/db");
    const { recordLlmUsage } = await import("../src/lib/llm-usage");
    const { generateReflectionSummary } = await import("../src/lib/post-mortem");

    process.env.OPENROUTER_API_KEY = "test-key";
    process.env.OPENROUTER_API_URL = "https://openrouter.ai/v1/responses";
    process.env.TRIGGER_LLM_DAILY_TOKEN_BUDGET = "1"; // 1-token ceiling → immediately over budget

    upsertConnectedAccount({ id: accountId, userId, broker: "alpaca", environment: "paper", accountNumber, label: "Alpaca Paper", isActive: true });
    setActiveConnectedAccount(accountId, userId);
    setPolicy({ ...DEFAULT_POLICY, accountNumber, activeBroker: "alpaca" }, userId);
    insertFillEvent({ userId, accountNumber, source: "paper", executionMode: "broker/paper", symbol: "AAPL", side: "buy", quantity: 1, price: 100, notional: 100, status: "filled" });
    // Seed usage above the 1-token ceiling for THIS user so the budget is exceeded.
    recordLlmUsage({ userId, provider: "openai", model: "openai/gpt-4o", context: "strategy", keySource: "user", promptTokens: 10, completionTokens: 0 });

    let openaiCalled = false;
    vi.stubGlobal("fetch", async (url: string | URL | Request) => {
      if (String(url).includes("openrouter.ai")) openaiCalled = true; // the reflection LLM endpoint
      return new Response(JSON.stringify({ output_text: "should not be produced" }), { status: 200, headers: { "content-type": "application/json" } });
    });

    // Must complete cleanly (no LlmBudgetExceededError bubbling) — over-budget is a graceful skip, not a failure.
    await expect(generateReflectionSummary(accountNumber, userId)).resolves.toBeUndefined();
    expect(openaiCalled).toBe(false); // reflection LLM call suppressed by the budget
    expect(getUserSetting(userId, "reflection_summary", "")).toBe(""); // no summary written
  });
});
