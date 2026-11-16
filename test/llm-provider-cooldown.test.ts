import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";

// Handoff 6b.4: short-lived per-LLM-provider cooldown for the Green/Red failover chains. A
// rate/quota failure cools that provider lane so the NEXT run skips it (audited) instead of
// re-discovering it dead; hard billing failures cool longer; an all-cooling chain is still
// attempted (least-recently-failed first) with ONE throttled exhaustion alert per window; and
// LLM_PROVIDER_COOLDOWN_DISABLED=1 restores exact pre-cooldown behavior.

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
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-llm-cooldown-${randomUUID()}.db`)}`;
});

beforeEach(async () => {
  const { resetLlmProviderCooldownsForTests } = await import("../src/lib/llm-provider-cooldown");
  resetLlmProviderCooldownsForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const OPENAI_ATTEMPT = { provider: "openai", model: "gpt-5.4-mini", keySource: "user" as const };
const GEMINI_ATTEMPT = { provider: "gemini", model: "gemini-2.5-flash", keySource: "user" as const };

describe("llm-provider-cooldown unit behavior", () => {
  it("classifies HTTP 402 and MiniMax's native insufficient-balance envelope as billing", async () => {
    const { classifyLlmRateOrQuotaFailure } = await import("../src/lib/llm-provider-cooldown");

    expect(classifyLlmRateOrQuotaFailure(402, undefined)).toBe("billing");
    expect(
      classifyLlmRateOrQuotaFailure(
        200,
        JSON.stringify({ base_resp: { status_code: 1008, status_msg: "insufficient balance" } })
      )
    ).toBe("billing");
    expect(classifyLlmRateOrQuotaFailure(400, "invalid request parameters")).toBeUndefined();
  });

  it("a transient 429 cools the lane so planning skips straight to the fallback (audited)", async () => {
    const { recordLlmProviderFailure, planLlmProviderAttempts, getLlmProviderCooldown } = await import("../src/lib/llm-provider-cooldown");
    const { listAudit } = await import("../src/lib/db");

    const kind = recordLlmProviderFailure({ provider: "openai", keySource: "user", status: 429, detail: "rate limited", model: "gpt-5.4-mini", step: "bull" });
    expect(kind).toBe("transient");
    expect(getLlmProviderCooldown("openai", "user")?.record.kind).toBe("transient");
    // A different lane of the SAME provider (operator failover key) is NOT cooled.
    expect(getLlmProviderCooldown("openai", "operator")).toBeUndefined();

    const planned = planLlmProviderAttempts([OPENAI_ATTEMPT, GEMINI_ATTEMPT], { step: "bull", runId: "run-skip" });
    expect(planned).toEqual([GEMINI_ATTEMPT]);

    const skips = listAudit(200).filter((e) => e.kind === "llm_provider_cooldown_skip");
    const skip = skips.find((e) => (e.payload as { runId?: string }).runId === "run-skip");
    expect(skip).toBeDefined();
    const payload = skip!.payload as { provider: string; kind: string; remainingMs: number };
    expect(payload.provider).toBe("openai");
    expect(payload.kind).toBe("transient");
    expect(payload.remainingMs).toBeGreaterThan(0);
  });

  it("non-rate/quota failures (5xx, timeouts) never set a cooldown", async () => {
    const { recordLlmProviderFailure, getLlmProviderCooldown } = await import("../src/lib/llm-provider-cooldown");
    expect(recordLlmProviderFailure({ provider: "openai", keySource: "user", status: 500, detail: "internal server error" })).toBeUndefined();
    expect(recordLlmProviderFailure({ provider: "openai", keySource: "user", detail: "request timed out" })).toBeUndefined();
    expect(getLlmProviderCooldown("openai", "user")).toBeUndefined();
  });

  it("a hard billing/insufficient_quota failure gets the longer TTL", async () => {
    vi.stubEnv("LLM_PROVIDER_COOLDOWN_TRANSIENT_MS", "1000");
    vi.stubEnv("LLM_PROVIDER_COOLDOWN_BILLING_MS", "600000");
    const { recordLlmProviderFailure, getLlmProviderCooldown } = await import("../src/lib/llm-provider-cooldown");

    recordLlmProviderFailure({ provider: "openai", keySource: "user", status: 429, detail: "rate limited" });
    recordLlmProviderFailure({
      provider: "gemini",
      keySource: "user",
      status: 429,
      detail: JSON.stringify({ error: { message: "You exceeded your current quota, please check your plan and billing details.", type: "insufficient_quota" } })
    });
    recordLlmProviderFailure({
      provider: "minimax",
      keySource: "user",
      status: 402,
      detail: JSON.stringify({ base_resp: { status_code: 1008, status_msg: "insufficient balance" } })
    });

    const transient = getLlmProviderCooldown("openai", "user");
    const billing = getLlmProviderCooldown("gemini", "user");
    const minimaxBilling = getLlmProviderCooldown("minimax", "user");
    expect(transient?.record.kind).toBe("transient");
    expect(billing?.record.kind).toBe("billing");
    expect(minimaxBilling?.record.kind).toBe("billing");
    expect(transient!.remainingMs).toBeLessThanOrEqual(1000);
    expect(billing!.remainingMs).toBeGreaterThan(1000);
    expect(minimaxBilling!.remainingMs).toBeGreaterThan(1000);
  });

  it("an expired cooldown is pruned and the lane serves again", async () => {
    vi.stubEnv("LLM_PROVIDER_COOLDOWN_TRANSIENT_MS", "5");
    const { recordLlmProviderFailure, planLlmProviderAttempts } = await import("../src/lib/llm-provider-cooldown");
    recordLlmProviderFailure({ provider: "openai", keySource: "user", status: 429, detail: "rate limited" });
    await sleep(15);
    const planned = planLlmProviderAttempts([OPENAI_ATTEMPT, GEMINI_ATTEMPT], { step: "bull" });
    expect(planned).toEqual([OPENAI_ATTEMPT, GEMINI_ATTEMPT]);
  });

  it("all-cooling still attempts the full chain, least-recently-failed first, with ONE exhaustion alert per window", async () => {
    const { recordLlmProviderFailure, planLlmProviderAttempts } = await import("../src/lib/llm-provider-cooldown");
    const { listAudit, listNotificationEvents } = await import("../src/lib/db");

    // gemini failed FIRST (least recently), then openai — planning must lead with gemini.
    recordLlmProviderFailure({ provider: "gemini", keySource: "user", status: 429, detail: "rate limited" });
    await sleep(10);
    recordLlmProviderFailure({ provider: "openai", keySource: "user", status: 429, detail: "rate limited" });

    const planned = planLlmProviderAttempts([OPENAI_ATTEMPT, GEMINI_ATTEMPT], { step: "bull", runId: "run-exhausted" });
    expect(planned).toEqual([GEMINI_ATTEMPT, OPENAI_ATTEMPT]); // never refuses; reordered, not dropped

    const exhausted = () => listAudit(300).filter((e) => e.kind === "llm_provider_cooldown_exhausted");
    expect(exhausted()).toHaveLength(1);
    await vi.waitFor(() => {
      const rows = listNotificationEvents("local", 50).filter(
        (n) => n.type === "provider_degraded" && (n.payload as { source?: string }).source === "llm-provider-cooldown"
      );
      expect(rows).toHaveLength(1);
    });

    // A second run inside the same cooldown window: attempts still planned, but NO second alert.
    const again = planLlmProviderAttempts([OPENAI_ATTEMPT, GEMINI_ATTEMPT], { step: "bull", runId: "run-exhausted-2" });
    expect(again).toEqual([GEMINI_ATTEMPT, OPENAI_ATTEMPT]);
    await sleep(25);
    expect(exhausted()).toHaveLength(1);
    expect(
      listNotificationEvents("local", 50).filter(
        (n) => n.type === "provider_degraded" && (n.payload as { source?: string }).source === "llm-provider-cooldown"
      )
    ).toHaveLength(1);
  });

  it("all-billing cooldowns still return the full chain so manual credit fixes recover immediately", async () => {
    const { recordLlmProviderFailure, planLlmProviderAttempts } = await import("../src/lib/llm-provider-cooldown");

    recordLlmProviderFailure({
      provider: "gemini",
      keySource: "user",
      status: 429,
      detail: "You exceeded your current quota, please check your plan and billing details."
    });
    await sleep(10);
    recordLlmProviderFailure({
      provider: "openai",
      keySource: "user",
      status: 429,
      detail: "insufficient_quota"
    });

    expect(planLlmProviderAttempts([OPENAI_ATTEMPT, GEMINI_ATTEMPT], { step: "bull" })).toEqual([
      GEMINI_ATTEMPT,
      OPENAI_ATTEMPT
    ]);
  });

  it("account boundary: user A's PERSONAL-key cooldown never cools user B's lane; operator lane stays shared", async () => {
    const { recordLlmProviderFailure, planLlmProviderAttempts, getLlmProviderCooldown } = await import("../src/lib/llm-provider-cooldown");

    // User A's own openai key 429s — only user A's personal lane cools.
    recordLlmProviderFailure({ provider: "openai", keySource: "user", status: 429, detail: "rate limited", model: "gpt-5.4-mini", step: "bull", userId: "user-a" });
    expect(getLlmProviderCooldown("openai", "user", "user-a")?.record.kind).toBe("transient");
    // User B's healthy personal key is a DIFFERENT lane — never cooled by A's exhaustion.
    expect(getLlmProviderCooldown("openai", "user", "user-b")).toBeUndefined();

    // Planning for user B keeps the primary; planning for user A skips it.
    expect(planLlmProviderAttempts([OPENAI_ATTEMPT, GEMINI_ATTEMPT], { step: "bull", userId: "user-b" })).toEqual([OPENAI_ATTEMPT, GEMINI_ATTEMPT]);
    expect(planLlmProviderAttempts([OPENAI_ATTEMPT, GEMINI_ATTEMPT], { step: "bull", userId: "user-a" })).toEqual([GEMINI_ATTEMPT]);

    // The OPERATOR lane is one shared credential: cooling it applies to EVERY user.
    const OPERATOR_ATTEMPT = { provider: "openai", model: "gpt-5.4-mini", keySource: "operator" as const };
    recordLlmProviderFailure({ provider: "openai", keySource: "operator", status: 429, detail: "rate limited", userId: "user-a" });
    expect(getLlmProviderCooldown("openai", "operator", "user-b")?.record.kind).toBe("transient");
    expect(planLlmProviderAttempts([OPERATOR_ATTEMPT, GEMINI_ATTEMPT], { step: "bull", userId: "user-b" })).toEqual([GEMINI_ATTEMPT]);
  });

  it("kill switch LLM_PROVIDER_COOLDOWN_DISABLED=1 restores exact current behavior", async () => {
    const { recordLlmProviderFailure, planLlmProviderAttempts, getLlmProviderCooldown } = await import("../src/lib/llm-provider-cooldown");

    // Cooldown recorded while enabled...
    recordLlmProviderFailure({ provider: "openai", keySource: "user", status: 429, detail: "rate limited" });
    expect(getLlmProviderCooldown("openai", "user")).toBeDefined();

    vi.stubEnv("LLM_PROVIDER_COOLDOWN_DISABLED", "1");
    // ...is ignored by planning, and new failures are not recorded.
    expect(planLlmProviderAttempts([OPENAI_ATTEMPT, GEMINI_ATTEMPT], { step: "bull" })).toEqual([OPENAI_ATTEMPT, GEMINI_ATTEMPT]);
    expect(recordLlmProviderFailure({ provider: "gemini", keySource: "user", status: 429, detail: "rate limited" })).toBeUndefined();
    expect(getLlmProviderCooldown("gemini", "user")).toBeUndefined();
  });
});

// ── Integration: a 429'd primary is skipped on the NEXT strategy run ─────────────────────────────

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

function geminiOk(): Response {
  return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: PROPOSALS_JSON } }] }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

describe("cross-run cooldown wired into the Bull failover chain", () => {
  it("run 1: primary 429 fails over and cools the lane; run 2: skips straight to the fallback without touching the primary", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-openai-key");
    vi.stubEnv("GEMINI_API_KEY", "test-gemini-key");
    let openaiCalls = 0;
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("openrouter.ai") || href.includes("api.openai.com")) {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        const isGemini = body.model?.includes("gemini") || body.model?.includes("google");
        if (!isGemini) {
          openaiCalls += 1;
          return new Response("rate limited", { status: 429 });
        }
        return geminiOk();
      }
      if (href.includes("nasdaq.com")) return nasdaqRow();
      return new Response("not found", { status: 404 });
    });

    const { setPolicy, upsertConnectedAccount, setActiveConnectedAccount, upsertUserApiKey, listAudit, getDb } = await import("../src/lib/db");
    upsertUserApiKey("local", "openrouter", "test-openai-key", "fixture");
    upsertUserApiKey("local", "gemini", "test-gemini-key", "fixture");
    const accountId = randomUUID();
    upsertConnectedAccount({ id: accountId, userId: "local", broker: "test", environment: "paper", accountNumber: "TEST", label: "Cooldown Test", isActive: true });
    setActiveConnectedAccount(accountId);
    setPolicy({
      ...DEFAULT_POLICY,
      systemState: "active",
      llmModel: "openai/gpt-4.1-mini",
      includedIndices: [],
      additionalSymbols: ["AAPL"],
      strategyAuthority: "decide",
      llmFallbackModels: ["gemini-2.5-flash"],
      redTeamLlmModel: "gemini-2.5-flash"
    });
    const { runStrategyOnce } = await import("../src/lib/strategy");

    // Run 1: primary 429s, fallback serves, and the openai/user lane enters cooldown.
    const first = await runStrategyOnce();
    expect(first.status).toBe("completed");
    expect(openaiCalls).toBeGreaterThan(0);
    const callsAfterFirst = openaiCalls;
    const firstKinds = listAudit(500)
      .filter((e) => (e.payload as { runId?: string })?.runId === first.runId)
      .map((e) => e.kind);
    expect(firstKinds).toContain("strategy_llm_failover");
    const cooldownSet = listAudit(500).find(
      (e) => e.kind === "llm_provider_cooldown_set" && (e.payload as { runId?: string }).runId === first.runId
    );
    expect(cooldownSet).toBeDefined();
    expect((cooldownSet!.payload as { provider: string; kind: string }).provider).toBe("openai");

    // Clear pending proposals from the first run so they don't trigger the revalidation step in the second run.
    getDb().prepare("DELETE FROM trade_proposals").run();

    // Run 2: the cooled primary is never called — the fallback serves directly, loudly audited.
    const second = await runStrategyOnce();
    expect(second.status).toBe("completed");
    expect(openaiCalls).toBe(callsAfterFirst); // no re-discovery of the dead provider
    const skip = listAudit(500).find(
      (e) => e.kind === "llm_provider_cooldown_skip" && (e.payload as { runId?: string }).runId === second.runId
    );
    expect(skip).toBeDefined();
    expect((skip!.payload as { provider: string; step: string }).provider).toBe("openai");
    const bullStep = second.llmSteps?.find((s) => s.step === "bull");
    expect(bullStep?.provider).toBe("gemini");
    // Served-model attribution stays failover-aware even when the fallback is the FIRST attempt.
    expect(second.proposals.length).toBeGreaterThan(0);
    for (const p of second.proposals) {
      expect(p.proposal.proposedByModel).toBe("gemini-2.5-flash");
    }
  }, 60_000);
});
