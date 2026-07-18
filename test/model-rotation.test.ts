/**
 * Model rotation ("__rotate__" testing option) — the sentinel that round-robins the Proposer
 * (green) and/or Reviewer (red) model through every eligible curated model, one per strategy run,
 * so comparative live history accrues across models (proposals stamp `proposedByModel`).
 *
 * Covers: pure round-robin pointer logic (wrap advances the red pointer one extra step so
 * green/red combinations vary; the same-model skip keeps the two seats on DIFFERENT models within
 * a run), the curated-pool exclusions, the credential-missing skip (rotation never picks a model
 * whose provider key doesn't resolve), pointer persistence via internal settings + pick auditing,
 * the resolveOpenAiModel safety net, and that the sentinel passes /api/policy validation.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { resetDbForTesting } from "../src/lib/db";

beforeAll(() => {
  resetDbForTesting();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-model-rotation-${randomUUID()}.db`)}`;
});

afterEach(() => {
  resetDbForTesting();
  vi.resetModules();
  vi.unstubAllEnvs();
});

const LLM_ENV = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "XAI_API_KEY", "GEMINI_API_KEY", "MISTRAL_API_KEY", "DEEPSEEK_API_KEY", "OPENROUTER_API_KEY"];

function noEnvKeys() {
  vi.stubEnv("LLM_OPERATOR_FALLBACK", "off");
  for (const k of LLM_ENV) vi.stubEnv(k, "");
}

describe("advanceRotationPointers (pure round-robin)", () => {
  const pool = ["m0", "m1", "m2"];

  it("cycles the green seat through the pool in order and wraps", async () => {
    const { advanceRotationPointers } = await import("../src/lib/model-rotation");
    const picks: string[] = [];
    let counter = 0;
    for (let i = 0; i < 7; i++) {
      const out = advanceRotationPointers({ pool, rotateGreen: true, rotateRed: false, greenCounter: counter, redCounter: 0 });
      picks.push(out.green!.model);
      counter = out.green!.nextPointer;
    }
    expect(picks).toEqual(["m0", "m1", "m2", "m0", "m1", "m2", "m0"]);
  });

  it("advances the red pointer ONE EXTRA step when the green pointer wraps (combinations shift phase)", async () => {
    const { advanceRotationPointers } = await import("../src/lib/model-rotation");
    // Green consuming the LAST slot of the cycle = wrap. Red on a DIFFERENT slot (no same-model
    // skip in play) isolates the wrap-extra behavior.
    const wrapped = advanceRotationPointers({ pool, rotateGreen: true, rotateRed: true, greenCounter: 2, redCounter: 0 });
    expect(wrapped.green).toMatchObject({ model: "m2", wrapped: true, nextPointer: 3 });
    expect(wrapped.red).toMatchObject({ model: "m0", pointer: 0, nextPointer: 2 }); // extra step
    // Mid-cycle: no extra step.
    const mid = advanceRotationPointers({ pool, rotateGreen: true, rotateRed: true, greenCounter: 0, redCounter: 1 });
    expect(mid.green!.wrapped).toBe(false);
    expect(mid.red).toMatchObject({ model: "m1", pointer: 1, nextPointer: 2 });
  });

  it("skips red one slot when both seats rotate onto the SAME model (both counters at 0 → adjacent picks)", async () => {
    const { advanceRotationPointers } = await import("../src/lib/model-rotation");
    // Both counters start at 0 on a fresh account: without the skip, green AND red served m0 —
    // the same model debating itself — every run of the entire first cycle.
    const out = advanceRotationPointers({ pool, rotateGreen: true, rotateRed: true, greenCounter: 0, redCounter: 0 });
    expect(out.green).toMatchObject({ model: "m0", pointer: 0, nextPointer: 1 });
    // Red consumed the NEXT slot; its counter continues past the consumed slot.
    expect(out.red).toMatchObject({ model: "m1", pointer: 1, nextPointer: 2 });
  });

  it("stacks the same-model skip with the green-wrap extra advance (skip wraps to slot 0, wrap adds +1)", async () => {
    const { advanceRotationPointers } = await import("../src/lib/model-rotation");
    // Green consumes the last slot (m2, wraps); red's slot 2 would ALSO be m2 → skip wraps red to
    // slot 0 (m0), and the green-wrap extra advance still applies on top: nextPointer = 0 + 1 + 1.
    const out = advanceRotationPointers({ pool, rotateGreen: true, rotateRed: true, greenCounter: 2, redCounter: 2 });
    expect(out.green).toMatchObject({ model: "m2", wrapped: true, nextPointer: 3 });
    expect(out.red).toMatchObject({ model: "m0", pointer: 0, nextPointer: 2, wrapped: false });
  });

  it("cannot skip on a single-model pool (degenerate case: both seats serve the only model)", async () => {
    const { advanceRotationPointers } = await import("../src/lib/model-rotation");
    const out = advanceRotationPointers({ pool: ["only"], rotateGreen: true, rotateRed: true, greenCounter: 0, redCounter: 0 });
    expect(out.green!.model).toBe("only");
    expect(out.red!.model).toBe("only");
  });

  it("phase-shifts the green/red pairing across full cycles and NEVER pairs a model with itself", async () => {
    const { advanceRotationPointers } = await import("../src/lib/model-rotation");
    const pairs = new Set<string>();
    let green = 0;
    let red = 0;
    for (let i = 0; i < pool.length * pool.length; i++) {
      const out = advanceRotationPointers({ pool, rotateGreen: true, rotateRed: true, greenCounter: green, redCounter: red });
      expect(out.red!.model).not.toBe(out.green!.model); // same-model skip: never the same model in one run
      pairs.add(`${out.green!.model}+${out.red!.model}`);
      green = out.green!.nextPointer;
      red = out.red!.nextPointer;
    }
    // Fixed phase would yield exactly |pool| distinct pairs; the wrap-advance must reach every
    // DISTINCT-model ordered pair — |pool| * (|pool| - 1), since same-model pairs are skipped.
    expect(pairs.size).toBe(pool.length * (pool.length - 1));
  });

  it("red-only rotation advances by exactly one per run (no green wrap possible)", async () => {
    const { advanceRotationPointers } = await import("../src/lib/model-rotation");
    const out = advanceRotationPointers({ pool, rotateGreen: false, rotateRed: true, greenCounter: 2, redCounter: 2 });
    expect(out.green).toBeUndefined();
    expect(out.red!.nextPointer).toBe(out.red!.pointer + 1);
  });

  it("normalizes garbage counters and returns {} on an empty pool", async () => {
    const { advanceRotationPointers } = await import("../src/lib/model-rotation");
    expect(advanceRotationPointers({ pool: [], rotateGreen: true, rotateRed: true, greenCounter: 0, redCounter: 0 })).toEqual({});
    const out = advanceRotationPointers({ pool, rotateGreen: true, rotateRed: false, greenCounter: Number.NaN, redCounter: -7 });
    expect(out.green!.model).toBe("m0");
  });
});

describe("MODEL_ROTATION_POOL (curated catalog minus exclusions)", () => {
  it("excludes only the unsuitable models and nothing else from the curated catalog", async () => {
    const { MODEL_ROTATION_POOL } = await import("../src/lib/model-rotation");
    const { CURATED_LLM_MODEL_IDS } = await import("../app/ui/llm-model-catalog");
    // mistral-small-2603 / mistral-medium-3-5 were re-added 2026-07-10 (owner directive, after
    // the keyed re-benchmark proved both complete real calls) — only grok-build-0.1 (coding
    // specialist, soft-timeouts as a Green strategist) stays excluded.
    const excluded = ["grok-build-0.1"];
    for (const model of excluded) expect(MODEL_ROTATION_POOL).not.toContain(model);
    // Keep-in-sync check: the pool is exactly the curated catalog minus the exclusions.
    expect(new Set(MODEL_ROTATION_POOL)).toEqual(new Set(CURATED_LLM_MODEL_IDS.filter((id) => !excluded.includes(id))));
    expect(MODEL_ROTATION_POOL).toContain("gpt-5.4-mini");
    expect(MODEL_ROTATION_POOL).toContain("claude-fable-5");
    expect(MODEL_ROTATION_POOL).toContain("grok-4.3");
    expect(MODEL_ROTATION_POOL).toContain("mistral-small-2603");
    expect(MODEL_ROTATION_POOL).toContain("mistral-medium-3-5");
  });
});

describe("eligibleRotationPool (credential-missing skip)", () => {
  it("keeps only models whose provider credential resolves", async () => {
    noEnvKeys();
    const userId = `rot-cred-${randomUUID()}`;
    const { upsertUserApiKey } = await import("../src/lib/db");
    const { eligibleRotationPool } = await import("../src/lib/model-rotation");
    upsertUserApiKey(userId, "openai", "sk-test-openai", "test");
    upsertUserApiKey(userId, "anthropic", "sk-test-anthropic", "test");
    const { pool, skipped } = eligibleRotationPool(userId);
    expect(pool.length).toBeGreaterThan(0);
    
    // GPT and Claude models should be kept (in pool) since openai/anthropic keys are active
    expect(pool).toContain("gpt-5.4-mini");
    expect(pool).toContain("claude-opus-4-8");
    expect(pool).toContain("openrouter/openai/gpt-4o");
    expect(pool).toContain("openrouter/anthropic/claude-3.5-sonnet");
    
    // Gemini and DeepSeek models should be skipped since gemini/deepseek keys are missing
    expect(skipped).toContain("gemini-3.5-flash");
    expect(skipped).toContain("deepseek-v4-pro");
    expect(skipped).toContain("openrouter/google/gemini-2.5-pro");
    expect(skipped).toContain("openrouter/deepseek/deepseek-r1");
  });
});

describe("resolveModelRotationForRun", () => {
  it("returns no override (only a no-op commit) when neither seat holds the sentinel", async () => {
    noEnvKeys();
    const { resolveModelRotationForRun } = await import("../src/lib/model-rotation");
    const { commit, ...override } = resolveModelRotationForRun({
      userId: `rot-none-${randomUUID()}`,
      accountId: "acct-1",
      runId: randomUUID(),
      policy: { llmModel: "gpt-5.4-mini", redTeamLlmModel: "claude-haiku-4-5" }
    });
    expect(override).toEqual({});
    expect(typeof commit).toBe("function");
    expect(() => commit()).not.toThrow(); // no-op — nothing to persist
  });

  it("rotates the green seat per run with a persisted pointer, never returning the sentinel", async () => {
    noEnvKeys();
    const userId = `rot-green-${randomUUID()}`;
    const accountId = "acct-green";
    const { upsertUserApiKey } = await import("../src/lib/db");
    const { resolveModelRotationForRun, eligibleRotationPool, LLM_MODEL_ROTATION_SENTINEL } = await import("../src/lib/model-rotation");
    upsertUserApiKey(userId, "openai", "sk-test", "test");
    upsertUserApiKey(userId, "anthropic", "sk-test", "test");
    const { pool } = eligibleRotationPool(userId);
    const served: string[] = [];
    for (let i = 0; i < pool.length; i++) {
      const out = resolveModelRotationForRun({
        userId,
        accountId,
        runId: randomUUID(),
        policy: { llmModel: LLM_MODEL_ROTATION_SENTINEL }
      });
      expect(out.llmModel).toBeTruthy();
      expect(out.llmModel).not.toBe(LLM_MODEL_ROTATION_SENTINEL);
      expect(out.redTeamLlmModel).toBeUndefined(); // red seat not rotating
      expect(out.redTeamReasoningEffort).toBeUndefined(); // ...so its effort is untouched too
      // Per-team reasoning (2026-07-10): a rotating seat auto-sets the served model's curated
      // recommended effort on the run-scoped override.
      expect(out.llmReasoningEffort).toBeTruthy();
      served.push(out.llmModel!);
      out.commit(); // commit-late: the pointer only advances once the run serves the LLM
    }
    // One full cycle of COMMITTED runs serves every eligible model exactly once, in pool order.
    expect(served).toEqual(pool);
  });

  it("rotates both seats independently, audits every pick, and scopes pointers per account", async () => {
    noEnvKeys();
    const userId = `rot-both-${randomUUID()}`;
    const { upsertUserApiKey, getDb } = await import("../src/lib/db");
    const { resolveModelRotationForRun, LLM_MODEL_ROTATION_SENTINEL } = await import("../src/lib/model-rotation");
    upsertUserApiKey(userId, "openai", "sk-test", "test");
    const runId = randomUUID();
    const out = resolveModelRotationForRun({
      userId,
      accountId: "acct-A",
      runId,
      policy: { llmModel: LLM_MODEL_ROTATION_SENTINEL, redTeamLlmModel: LLM_MODEL_ROTATION_SENTINEL }
    });
    expect(out.llmModel).toMatch(/^gpt-/);
    expect(out.redTeamLlmModel).toMatch(/^gpt-/);
    // Same-model skip end-to-end: both pointers start at 0, but the run never serves the same
    // model to both seats (red consumes the adjacent slot).
    expect(out.redTeamLlmModel).not.toBe(out.llmModel);
    // Per-team reasoning (2026-07-10): each rotated seat carries ITS served model's curated
    // recommended effort (unknown -> medium) on the run-scoped override.
    const { recommendedReasoningEffortForModel } = await import("../src/lib/model-reasoning-recommendations");
    expect(out.llmReasoningEffort).toBe(recommendedReasoningEffortForModel(out.llmModel));
    expect(out.redTeamReasoningEffort).toBe(recommendedReasoningEffortForModel(out.redTeamLlmModel, "red"));
    out.commit(); // pick audits + pointer advance are only written on commit (Finding 3: commit-late)
    const audits = getDb()
      .prepare("SELECT payload FROM audit_events WHERE kind = 'model_rotation_pick' AND user_id = ?")
      .all(userId) as Array<{ payload: string }>;
    const parsed = audits.map(
      (row) => JSON.parse(row.payload) as { runId: string; seat: string; model: string; pointer: number; reasoningEffort?: string }
    );
    expect(parsed.filter((p) => p.runId === runId).map((p) => p.seat).sort()).toEqual(["green", "red"]);
    for (const pick of parsed) {
      expect(typeof pick.pointer).toBe("number");
      expect(pick.model).not.toBe(LLM_MODEL_ROTATION_SENTINEL);
      // The served effort is part of the pick's audit trail.
      expect(pick.reasoningEffort).toBe(
        recommendedReasoningEffortForModel(pick.model, pick.seat === "red" ? "red" : "green")
      );
    }
    // A different account starts at its own pointer (slot 0), independent of acct-A's advance.
    const other = resolveModelRotationForRun({
      userId,
      accountId: "acct-B",
      runId: randomUUID(),
      policy: { llmModel: LLM_MODEL_ROTATION_SENTINEL }
    });
    expect(other.llmModel).toBe(out.llmModel); // acct-A consumed slot 0; acct-B starts fresh at slot 0
  });

  it("fails the rotating seats closed (empty override models, not the sentinel) when no credential resolves at all", async () => {
    noEnvKeys();
    const { resolveModelRotationForRun, LLM_MODEL_ROTATION_SENTINEL } = await import("../src/lib/model-rotation");
    const { commit, ...override } = resolveModelRotationForRun({
      userId: `rot-nokeys-${randomUUID()}`,
      accountId: "acct-1",
      runId: randomUUID(),
      policy: { llmModel: LLM_MODEL_ROTATION_SENTINEL, redTeamLlmModel: LLM_MODEL_ROTATION_SENTINEL }
    });
    // No-defaults (owner 2026-07-07): an empty pool resolves the rotating seats to "" — the normal
    // unconfigured/fail-closed state — never the raw "__rotate__" sentinel nor a removed default.
    expect(override).toEqual({ llmModel: "", redTeamLlmModel: "" });
    expect(typeof commit).toBe("function");
    expect(() => commit()).not.toThrow(); // no-op — no pointer to advance on an empty pool
  });

  it("defers the pointer advance and pick audit until commit() is called (commit-late)", async () => {
    noEnvKeys();
    const userId = `rot-commit-${randomUUID()}`;
    const accountId = "acct-commit";
    const { upsertUserApiKey, getDb, getInternalSetting } = await import("../src/lib/db");
    const { resolveModelRotationForRun, LLM_MODEL_ROTATION_SENTINEL } = await import("../src/lib/model-rotation");
    upsertUserApiKey(userId, "openai", "sk-test", "test");
    const pointerKey = `model_rotation:${userId}:${accountId}:green`;
    const auditCount = () =>
      (getDb()
        .prepare("SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'model_rotation_pick' AND user_id = ?")
        .get(userId) as { n: number }).n;
    const out = resolveModelRotationForRun({
      userId,
      accountId,
      runId: randomUUID(),
      policy: { llmModel: LLM_MODEL_ROTATION_SENTINEL }
    });
    expect(out.llmModel).toBeTruthy();
    // Resolve alone must NOT persist the pointer or write the pick audit.
    expect(getInternalSetting<number>(pointerKey)).toBeUndefined();
    expect(auditCount()).toBe(0);
    // commit() (the run reached the LLM) persists both.
    out.commit();
    expect(getInternalSetting<number>(pointerKey)).toBe(1);
    expect(auditCount()).toBe(1);
  });

  it("holds the pointer when a run aborts before commit — no rotation slot burned (Finding 3)", async () => {
    noEnvKeys();
    const userId = `rot-abort-${randomUUID()}`;
    const accountId = "acct-abort";
    const { upsertUserApiKey, getInternalSetting } = await import("../src/lib/db");
    const { resolveModelRotationForRun, LLM_MODEL_ROTATION_SENTINEL } = await import("../src/lib/model-rotation");
    upsertUserApiKey(userId, "openai", "sk-test", "test");
    const pointerKey = `model_rotation:${userId}:${accountId}:green`;
    // Run 1 resolves a pick but ABORTS before commit (e.g. account unavailable / over budget) — never commits.
    const first = resolveModelRotationForRun({ userId, accountId, runId: randomUUID(), policy: { llmModel: LLM_MODEL_ROTATION_SENTINEL } });
    // Run 2 resolves next: because run 1 never committed, the pointer is still at slot 0, so it serves the SAME model.
    const second = resolveModelRotationForRun({ userId, accountId, runId: randomUUID(), policy: { llmModel: LLM_MODEL_ROTATION_SENTINEL } });
    expect(second.llmModel).toBe(first.llmModel);
    expect(getInternalSetting<number>(pointerKey)).toBeUndefined(); // no slot consumed by the aborted runs
    // Run 2 now actually serves the LLM and commits → the pointer finally advances, so run 3 gets a different model.
    second.commit();
    const third = resolveModelRotationForRun({ userId, accountId, runId: randomUUID(), policy: { llmModel: LLM_MODEL_ROTATION_SENTINEL } });
    expect(third.llmModel).not.toBe(first.llmModel);
  });
});

describe("recommendedReasoningEffortForModel (curated rotation efforts)", () => {
  it("uses role-aware GPT-5.6 efforts while preserving provider-safe defaults", async () => {
    const { recommendedReasoningEffortForModel, reasoningAdviceForModel } = await import("../src/lib/model-reasoning-recommendations");
    expect(recommendedReasoningEffortForModel("deepseek-v4-flash")).toBe("none");
    expect(recommendedReasoningEffortForModel("deepseek-v4-pro")).toBe("none");
    expect(recommendedReasoningEffortForModel("openai/gpt-5.5")).toBe("medium");
    expect(recommendedReasoningEffortForModel("gpt-5.6-luna", "chat")).toBe("low");
    expect(recommendedReasoningEffortForModel("gpt-5.6-luna", "green")).toBe("medium");
    expect(recommendedReasoningEffortForModel("gpt-5.6-terra", "green")).toBe("medium");
    expect(recommendedReasoningEffortForModel("gpt-5.6-terra", "red")).toBe("high");
    expect(recommendedReasoningEffortForModel("gpt-5.6-sol", "review")).toBe("high");
    expect(recommendedReasoningEffortForModel("gpt-5.4-mini", "chat")).toBe("low");
    expect(recommendedReasoningEffortForModel("gpt-5.4-mini", "red")).toBe("high");
    expect(recommendedReasoningEffortForModel("claude-fable-5")).toBe("medium");
    expect(recommendedReasoningEffortForModel("some-custom-model")).toBe("medium");
    expect(recommendedReasoningEffortForModel(undefined)).toBe("medium");
    // gpt-5.5's advice carries the interactive-high rule the UI surfaces BEFORE save.
    expect(reasoningAdviceForModel("openai/gpt-5.5")).toMatch(/disabled for interactive/i);
    expect(reasoningAdviceForModel("gpt-5.4")).toMatch(/Terra.*preferable curated successor/i);
    expect(reasoningAdviceForModel("gpt-5.6-terra")).toMatch(/Green Team.*Coach/i);
    // mistral-medium-3-5's advice carries the 2026-07-10 benchmark tradeoff: None is fast/cheap
    // but proposes nothing, High actually proposes but is far slower/costlier.
    expect(reasoningAdviceForModel("mistral-medium-3-5")).toMatch(/EMPTY proposal list/);
    expect(reasoningAdviceForModel("mistral-medium-3-5")).toMatch(/\$0\.07/);
  });

  it("every rotation-pool model's recommended effort survives the interactive clamp unchanged", async () => {
    // Rotation must never auto-set an effort the interactive strategy path would then silently
    // rewrite (e.g. recommending high for gpt-5.5, or medium for a DeepSeek that treats it as off).
    const { MODEL_ROTATION_POOL } = await import("../src/lib/model-rotation");
    const { recommendedReasoningEffortForModel } = await import("../src/lib/model-reasoning-recommendations");
    const { interactiveStrategyReasoningEffort, reasoningCapabilityForModel } = await import("../src/lib/llm-request");
    for (const model of MODEL_ROTATION_POOL) {
      const recommended = recommendedReasoningEffortForModel(model);
      const served = interactiveStrategyReasoningEffort(model, recommended);
      if (reasoningCapabilityForModel(model)) expect(served, model).toBe(recommended);
      else expect(served, model).toBeUndefined();
    }
  });
});

describe("sentinel handling at the edges", () => {
  it("resolveOpenAiModel treats the sentinel as unset (safety net for non-run consumers)", async () => {
    vi.stubEnv("OPENAI_MODEL", "");
    const { resolveOpenAiModel, LLM_MODEL_ROTATION_SENTINEL } = await import("../src/lib/llm-request");
    // No-defaults: the sentinel (like any unset model) resolves to "" — fail closed, never a default.
    expect(resolveOpenAiModel({ llmModel: LLM_MODEL_ROTATION_SENTINEL })).toBe("");
    expect(resolveOpenAiModel({ llmModel: "openai/gpt-5.5" })).toBe("openai/gpt-5.5");
  });

  it("PUT /api/policy accepts and persists the sentinel for both seats", async () => {
    const { PUT } = await import("../app/api/policy/route");
    const { getPolicy } = await import("../src/lib/db");
    const { DEFAULT_REQUEST_USER_ID } = await import("../src/lib/request-user");
    const response = await PUT(
      new Request("http://localhost/api/policy", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ llmModel: "__rotate__", redTeamLlmModel: "__rotate__" })
      })
    );
    expect(response.status).toBe(200);
    const saved = getPolicy(DEFAULT_REQUEST_USER_ID);
    expect(saved.llmModel).toBe("__rotate__");
    expect(saved.redTeamLlmModel).toBe("__rotate__");
  });
});
