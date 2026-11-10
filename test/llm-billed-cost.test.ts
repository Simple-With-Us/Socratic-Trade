import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { existsSync, mkdirSync, unlinkSync } from "fs";
import path from "path";
import os from "os";

// Money correctness for the LLM ledger, two defects in one file:
//
//   1. OpenRouter reports what it actually CHARGED for a generation on every response
//      (`usage.cost`, in USD).  The ledger ignored it and priced every call from a
//      hand-maintained table instead, so displayed spend could drift from real spend without
//      limit.  A cost from the transport must beat the estimate, and the ledger must remember
//      WHICH it stored so the Usage page can label an estimate as an estimate.
//   2. A reply that arrives after the soft timeout is billed in full by the provider, but was
//      only ever written to an audit — never metered.  The failover call that answered was
//      metered on top, so the run paid twice and the ledger saw one of them.
//
// Isolated temp SQLite so migration 86 (`llm_usage.cost_source`) actually runs.
const tmpDir = path.join(os.tmpdir(), `trading-test-llm-billed-cost-${Date.now()}`);
const tmpDbPath = path.join(tmpDir, "test.db");
if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
process.env.DATABASE_URL = `file:${tmpDbPath}`;

const { getDb } = await import("../src/lib/db");
const { recordLlmUsage, getLlmUsageSummary, extractLlmUsage, estimateLlmCostUsd } = await import("../src/lib/llm-usage");
const { recordLlmCallOutcome } = await import("../src/lib/llm-late-usage");

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${tmpDbPath}${suffix}`);
    } catch {
      /* best-effort */
    }
  }
});

/** Read the raw ledger row for a context tag — the aggregate view hides `cost_source`. */
function rawRow(context: string): { cost_usd: number | null; cost_source: string | null } | undefined {
  return getDb()
    .prepare("SELECT cost_usd, cost_source FROM llm_usage WHERE context = ?")
    .get(context) as { cost_usd: number | null; cost_source: string | null } | undefined;
}

describe("extractLlmUsage — OpenRouter billed cost", () => {
  it("surfaces usage.cost as billedCostUsd", () => {
    const usage = extractLlmUsage({
      usage: { prompt_tokens: 12_000, completion_tokens: 3_000, total_tokens: 15_000, cost: 0.4213 }
    });
    expect(usage.billedCostUsd).toBe(0.4213);
    expect(usage.promptTokens).toBe(12_000);
  });

  it("treats a billed 0 as a real answer (free / promotional model), not as missing", () => {
    const usage = extractLlmUsage({ usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0 } });
    expect(usage.billedCostUsd).toBe(0);
  });

  it("drops a negative cost rather than letting it reduce a running total", () => {
    const usage = extractLlmUsage({ usage: { prompt_tokens: 100, completion_tokens: 10, cost: -1 } });
    expect(usage.billedCostUsd).toBeUndefined();
  });

  it("leaves billedCostUsd undefined when the response reports no cost", () => {
    const usage = extractLlmUsage({ usage: { prompt_tokens: 100, completion_tokens: 10 } });
    expect(usage.billedCostUsd).toBeUndefined();
  });
});

describe("recordLlmUsage — billed cost beats the price table", () => {
  beforeAll(() => {
    // A model the price table prices generously, so an estimate and the billed figure cannot be
    // confused for one another.
    recordLlmUsage({
      userId: "local",
      provider: "openrouter",
      model: "anthropic/claude-opus-5",
      context: "test-billed",
      keySource: "user",
      promptTokens: 100_000,
      completionTokens: 20_000,
      billedCostUsd: 0.25
    });
    recordLlmUsage({
      userId: "local",
      provider: "openrouter",
      model: "anthropic/claude-opus-5",
      context: "test-estimated",
      keySource: "user",
      promptTokens: 100_000,
      completionTokens: 20_000
    });
    // A non-OpenRouter provider that happens to echo a `cost` field must NOT be trusted as money.
    recordLlmUsage({
      userId: "local",
      provider: "anthropic",
      model: "claude-opus-5",
      context: "test-untrusted-cost",
      keySource: "user",
      promptTokens: 100_000,
      completionTokens: 20_000,
      billedCostUsd: 0.25
    });
  });

  it("stores the transport's charged amount, not the estimate, and stamps it 'billed'", () => {
    const row = rawRow("test-billed");
    expect(row?.cost_usd).toBe(0.25);
    expect(row?.cost_source).toBe("billed");
  });

  it("falls back to the price-table estimate and stamps it 'estimated'", () => {
    const expected = estimateLlmCostUsd("claude-opus-5", 100_000, 20_000);
    const row = rawRow("test-estimated");
    expect(row?.cost_source).toBe("estimated");
    expect(row?.cost_usd).toBeCloseTo(expected as number, 10);
    // The estimate for this model is far above the billed figure — that gap is exactly the
    // drift this fix exists to close.
    expect(row?.cost_usd as number).toBeGreaterThan(0.25);
  });

  it("ignores a cost field from a provider that is not the OpenRouter transport", () => {
    const row = rawRow("test-untrusted-cost");
    expect(row?.cost_source).toBe("estimated");
    expect(row?.cost_usd as number).toBeGreaterThan(0.25);
  });

  it("getLlmUsageSummary splits billed from estimated instead of merging them into one figure", () => {
    const billed = getLlmUsageSummary().find((r) => r.context === "test-billed");
    expect(billed?.billedCostUsd).toBeCloseTo(0.25, 10);
    expect(billed?.estimatedCostUsd).toBe(0);
    expect(billed?.billedCalls).toBe(1);
    expect(billed?.estimatedCalls).toBe(0);

    const estimated = getLlmUsageSummary().find((r) => r.context === "test-estimated");
    expect(estimated?.billedCostUsd).toBe(0);
    expect(estimated?.estimatedCostUsd).toBeGreaterThan(0.25);
    expect(estimated?.billedCalls).toBe(0);
    expect(estimated?.estimatedCalls).toBe(1);
  });
});

describe("late (post-soft-timeout) responses reach the ledger", () => {
  it("meters a late Green reply under 'strategy-late' with the transport's billed cost", async () => {
    await recordLlmCallOutcome(
      {
        durationMs: 210_000,
        late: true,
        ok: true,
        status: 200,
        response: new Response(
          JSON.stringify({
            id: "gen-late-green",
            choices: [{ message: { content: "{}" } }],
            usage: { prompt_tokens: 90_000, completion_tokens: 8_000, cost: 1.37 }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      },
      {
        userId: "local",
        step: "bull",
        provider: "openrouter",
        model: "anthropic/claude-opus-5",
        softTimeoutMs: 150_000,
        keySource: "user",
        usageContext: "strategy-late"
      }
    );

    const row = rawRow("strategy-late");
    expect(row, "a late reply the provider billed must produce a ledger row").toBeTruthy();
    expect(row?.cost_usd).toBe(1.37);
    expect(row?.cost_source).toBe("billed");
  });

  it("meters a late Red Team reply under 'red-team-late'", async () => {
    await recordLlmCallOutcome(
      {
        durationMs: 190_000,
        late: true,
        ok: true,
        status: 200,
        response: new Response(
          JSON.stringify({
            id: "gen-late-red",
            choices: [{ message: { content: "{}" } }],
            usage: { prompt_tokens: 40_000, completion_tokens: 2_000, cost: 0.61 }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      },
      {
        userId: "local",
        step: "red",
        provider: "openrouter",
        model: "anthropic/claude-opus-5",
        softTimeoutMs: 150_000,
        keySource: "user",
        usageContext: "red-team-late"
      }
    );

    const row = rawRow("red-team-late");
    expect(row, "Red Team late replies had no onOutcome at all — they must be metered now").toBeTruthy();
    expect(row?.cost_usd).toBe(0.61);
    expect(row?.cost_source).toBe("billed");
  });

  it("does NOT read the body (or meter) on the FAST path — the run owns that response", async () => {
    const response = new Response(
      JSON.stringify({ id: "gen-fast", choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: 10, completion_tokens: 1, cost: 9.99 } }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
    await recordLlmCallOutcome(
      { durationMs: 900, late: false, ok: true, status: 200, response },
      {
        userId: "local",
        step: "bull",
        provider: "openrouter",
        model: "anthropic/claude-opus-5",
        softTimeoutMs: 150_000,
        keySource: "user",
        usageContext: "strategy-fastpath-should-not-appear"
      }
    );
    expect(rawRow("strategy-fastpath-should-not-appear")).toBeUndefined();
    expect(response.bodyUsed, "the fast-path body must be left for the run to read").toBe(false);
  });
});
