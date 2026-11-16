// Durable per-user/day LLM budget: modifiable per-user POLICY config (env fallback) + enforcement at
// the spend primitives (withLlmGeneration for all LLM generations, retrieveContextDetailed for RAG).
// Real temp DB per run (no db mock) so getPolicy / setPolicy / the usage ledger are exercised for real.
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  // Reset the module cache so the db.ts singleton re-opens against THIS test's fresh temp file
  // (mirrors test/strategy-money-path-f-g.test.ts) — otherwise a stale connection leaks budget state.
  vi.resetModules();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-budget-enf-${randomUUID()}.db`)}`;
  delete process.env.TRIGGER_LLM_DAILY_TOKEN_BUDGET;
  delete process.env.TRIGGER_LLM_DAILY_COST_BUDGET_USD;
});
afterEach(() => {
  delete process.env.TRIGGER_LLM_DAILY_TOKEN_BUDGET;
  delete process.env.TRIGGER_LLM_DAILY_COST_BUDGET_USD;
  delete process.env.LLM_RUN_RESERVATION_TOKENS;
  delete process.env.LLM_RUN_RESERVATION_COST_USD;
  vi.doUnmock("../src/lib/llm-usage");
  vi.doUnmock("../src/lib/rag-metering");
});

async function seedUsage(userId: string, totalTokens: number, costUsd?: number): Promise<void> {
  const { getDb } = await import("../src/lib/db");
  getDb()
    .prepare(
      `INSERT INTO llm_usage (id, user_id, provider, model, context, key_source, key_ref, prompt_tokens, completion_tokens, total_tokens, cost_usd, created_at)
       VALUES (?, ?, 'openai', 'gpt-4o', 'strategy', 'user', NULL, 0, ?, ?, ?, ?)`
    )
    .run(randomUUID(), userId, totalTokens, totalTokens, costUsd ?? null, new Date().toISOString());
}
async function setTokenBudget(userId: string, tokenBudget: number): Promise<void> {
  const { getPolicy, setPolicy } = await import("../src/lib/db");
  const p = getPolicy(userId);
  setPolicy({ ...p, tuning: { ...p.tuning, llmDailyTokenBudget: tokenBudget } }, userId);
}
async function seedRag(userId: string, tokensIn: number): Promise<void> {
  const { recordRagUsage } = await import("../src/lib/rag-metering");
  recordRagUsage({ userId, operation: "embed", provider: "voyage", tokensIn });
}

describe("LLM budget config — per-user POLICY (modifiable) with env fallback", () => {
  it("enforces a per-user policy budget with no env set (this is what the Settings UI writes)", async () => {
    await setTokenBudget("local", 1000);
    await seedUsage("local", 1200);
    const { checkLlmDailyBudget, isOverLlmBudget } = await import("../src/lib/llm-budget");
    expect(checkLlmDailyBudget("local").ok).toBe(false);
    expect(checkLlmDailyBudget("local").reason).toBe("token_budget");
    expect(isOverLlmBudget("local")).toBe(true);
  });

  it("policy budget takes precedence over the env default", async () => {
    process.env.TRIGGER_LLM_DAILY_TOKEN_BUDGET = "100000"; // generous operator default
    await setTokenBudget("local", 1000); // stricter per-user override
    await seedUsage("local", 1200);
    const { isOverLlmBudget } = await import("../src/lib/llm-budget");
    expect(isOverLlmBudget("local")).toBe(true);
  });

  it("falls back to the env default when no policy budget is set", async () => {
    process.env.TRIGGER_LLM_DAILY_TOKEN_BUDGET = "1000";
    await seedUsage("local", 1200);
    const { isOverLlmBudget } = await import("../src/lib/llm-budget");
    expect(isOverLlmBudget("local")).toBe(true);
  });

  it("is OFF by default (no policy value, no env) — never blocks", async () => {
    await seedUsage("local", 10_000_000, 9_999);
    const { isOverLlmBudget } = await import("../src/lib/llm-budget");
    expect(isOverLlmBudget("local")).toBe(false);
  });

  it("an EXPLICIT policy budget of 0 opts OUT of an operator env default (0 = no limit, not 'block everything')", async () => {
    process.env.TRIGGER_LLM_DAILY_TOKEN_BUDGET = "1000"; // operator sets a default…
    await setTokenBudget("local", 0); // …account explicitly opts out with 0
    await seedUsage("local", 1_000_000);
    const { isOverLlmBudget } = await import("../src/lib/llm-budget");
    expect(isOverLlmBudget("local")).toBe(false); // never blocked despite far exceeding the env default
  });
});

describe("LLM budget — durable spend-primitive enforcement", () => {
  it("assertWithinLlmBudget throws LlmBudgetExceededError when over budget, no-ops when under", async () => {
    await setTokenBudget("local", 1000);
    await seedUsage("local", 1200);
    const { assertWithinLlmBudget, LlmBudgetExceededError } = await import("../src/lib/llm-budget");
    expect(() => assertWithinLlmBudget("local")).toThrow(LlmBudgetExceededError);
    expect(() => assertWithinLlmBudget("someone-else")).not.toThrow(); // different user, unlimited
  });

  it("withLlmGeneration refuses the model call when over budget (covers EVERY generation site)", async () => {
    await setTokenBudget("local", 1000);
    await seedUsage("local", 1200);
    const { withLlmGeneration } = await import("../src/lib/observability");
    let ran = false;
    await expect(
      withLlmGeneration({ name: "test.generation", model: "openai/gpt-4o", userId: "local" }, async () => {
        ran = true;
        return "should-not-run";
      })
    ).rejects.toThrow(/budget ceiling/i);
    expect(ran).toBe(false);
  });

  it("withLlmGeneration runs normally when under budget", async () => {
    await setTokenBudget("local", 100000);
    await seedUsage("local", 10);
    const { withLlmGeneration } = await import("../src/lib/observability");
    const out = await withLlmGeneration({ name: "test.generation", model: "openai/gpt-4o", userId: "local" }, async () => "ok");
    expect(out).toBe("ok");
  });

  it("retrieveContextDetailed skips RAG retrieval (returns []) when over budget — no Voyage/Pinecone spend", async () => {
    await setTokenBudget("local", 1000);
    await seedUsage("local", 1200);
    // Over budget returns BEFORE any client/embedding work, so this needs no Voyage/Pinecone mock.
    const { retrieveContextDetailed } = await import("../src/lib/vector-db");
    const chunks = await retrieveContextDetailed("AAPL catalysts", "AAPL", 3, "local");
    expect(chunks).toEqual([]);
  });

  it("RAG (Voyage/Pinecone) spend counts toward the ceiling too — not just llm_usage", async () => {
    await setTokenBudget("local", 1000);
    // No llm_usage rows at all — the ceiling must trip on rag_usage alone, else RAG spend never counts.
    await seedRag("local", 1500);
    const { checkLlmDailyBudget, isOverLlmBudget } = await import("../src/lib/llm-budget");
    expect(isOverLlmBudget("local")).toBe(true);
    const decision = checkLlmDailyBudget("local");
    expect(decision.ok).toBe(false);
    expect(decision.reason).toBe("token_budget");
    expect(decision.tokensToday).toBeGreaterThanOrEqual(1500);
  });
});

describe("LLM budget reservation — concurrency admission control (TOCTOU fix)", () => {
  it("returns ok with NO reservation id when no ceiling is configured (default OFF)", async () => {
    const { reserveLlmBudget } = await import("../src/lib/llm-budget");
    const r = reserveLlmBudget("local", 50_000, 5);
    expect(r.ok).toBe(true);
    expect(r.reservationId).toBeUndefined();
  });

  it("a live reservation holds headroom so a CONCURRENT same-user reserve is refused", async () => {
    await setTokenBudget("local", 10_000);
    const { reserveLlmBudget, reservedLlmSpend } = await import("../src/lib/llm-budget");
    const first = reserveLlmBudget("local", 8_000, 0);
    expect(first.ok).toBe(true);
    expect(first.reservationId).toBeTruthy();
    expect(reservedLlmSpend("local").tokens).toBe(8_000);
    // Second concurrent run: 0 ledger + 8_000 reserved + 8_000 est ≥ 10_000 → refused.
    const second = reserveLlmBudget("local", 8_000, 0);
    expect(second.ok).toBe(false);
    expect(second.reason).toBe("token_budget");
  });

  it("releasing a reservation frees the headroom for the next run", async () => {
    await setTokenBudget("local", 10_000);
    const { reserveLlmBudget, releaseLlmReservation, reservedLlmSpend } = await import("../src/lib/llm-budget");
    const first = reserveLlmBudget("local", 8_000, 0);
    expect(first.ok).toBe(true);
    expect(reserveLlmBudget("local", 8_000, 0).ok).toBe(false); // no headroom while held
    releaseLlmReservation("local", first.reservationId!);
    expect(reservedLlmSpend("local").tokens).toBe(0);
    expect(reserveLlmBudget("local", 8_000, 0).ok).toBe(true); // reclaimed
  });

  it("admits the FIRST run even when its estimate exceeds remaining headroom, but refuses a concurrent second", async () => {
    await setTokenBudget("local", 10_000);
    await seedUsage("local", 5_000);
    const { reserveLlmBudget } = await import("../src/lib/llm-budget");
    // First run: committed ledger 5_000 < 10_000 → admitted even though its 6_000 estimate exceeds the
    // 5_000 remaining headroom (its own estimate must never refuse it — per-spend guard caps real spend).
    const first = reserveLlmBudget("local", 6_000, 0);
    expect(first.ok).toBe(true);
    // Concurrent SECOND run: 5_000 ledger + 6_000 held + 4_000 est ≥ 10_000 → refused (serialization).
    expect(reserveLlmBudget("local", 4_000, 0).ok).toBe(false);
  });

  it("admits a run whose estimate exceeds a SMALL budget (regression: modest budgets aren't skipped all day)", async () => {
    await setTokenBudget("local", 5_000); // smaller than the default 80k per-run estimate
    const { reserveLlmRunBudget } = await import("../src/lib/llm-budget");
    // Zero committed usage → the single run MUST be admitted despite the 80k estimate > 5k budget.
    expect(reserveLlmRunBudget("local").ok).toBe(true);
  });

  it("the cost dimension serializes concurrent runs on the cost ceiling", async () => {
    process.env.TRIGGER_LLM_DAILY_COST_BUDGET_USD = "5";
    const { reserveLlmBudget } = await import("../src/lib/llm-budget");
    const first = reserveLlmBudget("local", 0, 3); // first run admitted (ledger $0 < $5)
    expect(first.ok).toBe(true);
    // Concurrent second: $0 ledger + $3 held + $3 est ≥ $5 → refused on cost.
    const second = reserveLlmBudget("local", 0, 3);
    expect(second.ok).toBe(false);
    expect(second.reason).toBe("cost_budget");
  });

  it("expired reservations no longer count (TTL reclaim frees a crashed run's hold)", async () => {
    await setTokenBudget("local", 10_000);
    const { reserveLlmBudget, reservedLlmSpend } = await import("../src/lib/llm-budget");
    const t0 = new Date("2026-07-01T12:00:00.000Z");
    expect(reserveLlmBudget("local", 8_000, 0, t0).ok).toBe(true);
    const later = new Date(t0.getTime() + 16 * 60_000); // > 15-min default TTL
    expect(reservedLlmSpend("local", later).tokens).toBe(0);
    // The expired hold is dropped, so a fresh run can reserve again.
    expect(reserveLlmBudget("local", 8_000, 0, later).ok).toBe(true);
  });

  it("releaseLlmReservation is a no-op for an unknown id and never throws", async () => {
    await setTokenBudget("local", 10_000);
    const { reserveLlmBudget, releaseLlmReservation, reservedLlmSpend } = await import("../src/lib/llm-budget");
    const first = reserveLlmBudget("local", 5_000, 0);
    expect(() => releaseLlmReservation("local", "does-not-exist")).not.toThrow();
    expect(reservedLlmSpend("local").tokens).toBe(5_000); // real reservation untouched
    releaseLlmReservation("local", first.reservationId!);
  });

  it("reserveLlmRunBudget uses the env-tunable per-run estimate", async () => {
    await setTokenBudget("local", 10_000);
    process.env.LLM_RUN_RESERVATION_TOKENS = "3000";
    const { reserveLlmRunBudget, reservedLlmSpend } = await import("../src/lib/llm-budget");
    const r = reserveLlmRunBudget("local");
    expect(r.ok).toBe(true);
    expect(reservedLlmSpend("local").tokens).toBe(3_000);
  });
});

describe("LLM budget — user_settings (not Infisical) + fail-closed ledger", () => {
  it("enforces a user_settings cap with no policy and no env", async () => {
    const { setUserLlmDailyBudget, checkLlmDailyBudget, isOverLlmBudget } = await import("../src/lib/llm-budget");
    setUserLlmDailyBudget("local", { tokenBudget: 500 });
    await seedUsage("local", 600);
    const decision = checkLlmDailyBudget("local");
    expect(decision.ok).toBe(false);
    expect(decision.reason).toBe("token_budget");
    expect(isOverLlmBudget("local")).toBe(true);
  });

  it("user_settings wins over legacy policy and retired env default", async () => {
    process.env.TRIGGER_LLM_DAILY_TOKEN_BUDGET = "100000";
    await setTokenBudget("local", 80000);
    const { setUserLlmDailyBudget, isOverLlmBudget } = await import("../src/lib/llm-budget");
    setUserLlmDailyBudget("local", { tokenBudget: 100 });
    await seedUsage("local", 200);
    expect(isOverLlmBudget("local")).toBe(true);
  });

  it("explicit user 0 opts out of env and legacy policy", async () => {
    process.env.TRIGGER_LLM_DAILY_TOKEN_BUDGET = "1000";
    await setTokenBudget("local", 1000);
    const { setUserLlmDailyBudget, isOverLlmBudget } = await import("../src/lib/llm-budget");
    setUserLlmDailyBudget("local", { tokenBudget: 0 });
    await seedUsage("local", 50_000);
    expect(isOverLlmBudget("local")).toBe(false);
  });

  it("fail-closes when a cap is set and the usage ledger cannot be read", async () => {
    const { setUserLlmDailyBudget } = await import("../src/lib/llm-budget");
    setUserLlmDailyBudget("local", { costBudgetUsd: 2 });
    vi.resetModules();
    vi.doMock("../src/lib/llm-usage", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../src/lib/llm-usage")>();
      return {
        ...actual,
        getLlmUsageSummary: () => {
          throw new Error("ledger down");
        }
      };
    });
    vi.doMock("../src/lib/rag-metering", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../src/lib/rag-metering")>();
      return {
        ...actual,
        getRagUsageSummary: () => {
          throw new Error("ledger down");
        }
      };
    });
    const { checkLlmDailyBudget, isOverLlmBudget, assertWithinLlmBudget, LlmBudgetExceededError } =
      await import("../src/lib/llm-budget");
    const decision = checkLlmDailyBudget("local");
    expect(decision.ok).toBe(false);
    expect(decision.reason).toBe("ledger_unavailable");
    expect(isOverLlmBudget("local")).toBe(true);
    expect(() => assertWithinLlmBudget("local")).toThrow(LlmBudgetExceededError);
  });

  it("does not fail-close when no cap is set, even if the ledger would throw", async () => {
    const { checkLlmDailyBudget } = await import("../src/lib/llm-budget");
    expect(checkLlmDailyBudget("local").ok).toBe(true);
  });
});
