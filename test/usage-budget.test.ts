import { describe, expect, it, beforeEach, afterEach, afterAll } from "vitest";
import { existsSync, mkdirSync, unlinkSync } from "fs";
import path from "path";
import os from "os";

const tmpDir = path.join(os.tmpdir(), `trading-test-usage-budget-${Date.now()}`);
const tmpDbPath = path.join(tmpDir, "test.db");
if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
process.env.DATABASE_URL = `file:${tmpDbPath}`;

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { unlinkSync(`${tmpDbPath}${suffix}`); } catch { /* best-effort */ }
  }
});

const budget = await import("../src/lib/usage-budget");
const { DEFAULT_POLICY } = await import("../src/lib/defaults");
const { listNotificationEvents } = await import("../src/lib/db-notifications");

const BASE = "https://usage.example.test";
const TOKEN = "test-token";

type BudgetStatus = Awaited<ReturnType<typeof budget.getBudgetStatusCached>>;

function status(providers: Array<{ name: string; status: "ok" | "warning" | "exceeded" | "unconfigured"; spentUsd?: number; monthlyBudgetUsd?: number }>): NonNullable<BudgetStatus> {
  return {
    generatedAt: new Date().toISOString(),
    month: "2026-07",
    providers: providers.map((p) => ({
      name: p.name,
      status: p.status,
      monthlyBudgetUsd: p.monthlyBudgetUsd ?? 100,
      spentUsd: p.spentUsd ?? 0,
      remainingUsd: null,
      percentUsed: null,
    })),
    summary: {
      totalBudgetUsd: 100,
      totalSpentUsd: 0,
      remainingUsd: 100,
      percentUsed: 0,
      overBudget: providers.some((p) => p.status === "exceeded"),
      warning: providers.some((p) => p.status === "warning"),
    },
  };
}

describe("usage-budget: cheaperModel", () => {
  it("maps known models down a tier and returns undefined when none", () => {
    expect(budget.cheaperModel("gpt-4o")).toBe("gpt-4o-mini");
    expect(budget.cheaperModel("claude-opus-4-8")).toBe("claude-sonnet-4-6");
    expect(budget.cheaperModel("claude-haiku-4-5-20251001")).toBeUndefined(); // already cheapest (prefix)
    expect(budget.cheaperModel("gpt-4o-mini")).toBeUndefined();
    expect(budget.cheaperModel(undefined)).toBeUndefined();
  });
});

describe("usage-budget: evaluateBudgetForRun", () => {
  beforeEach(() => {
    process.env.USAGE_MONITOR_BASE_URL = BASE;
    process.env.USAGE_INGEST_TOKEN = TOKEN;
    process.env.USAGE_BUDGET_ENFORCE = "on";
  });
  afterEach(() => {
    delete process.env.USAGE_MONITOR_BASE_URL;
    delete process.env.USAGE_INGEST_TOKEN;
    delete process.env.USAGE_BUDGET_ENFORCE;
  });

  it("downgrades the model when the LLM provider is over budget", async () => {
    const decision = await budget.evaluateBudgetForRun(
      "local",
      { llmModel: "gpt-4o", redTeamLlmModel: "gpt-4o" },
      { status: status([{ name: "openai", status: "exceeded" }]) }
    );
    expect(decision.skip).toBe(false);
    expect(decision.downgraded).toBe(true);
    expect(decision.llmModel).toBe("gpt-4o-mini");
    expect(decision.redTeamLlmModel).toBe("gpt-4o-mini");
  });

  it("skips the cycle when over budget and already on the cheapest tier", async () => {
    const decision = await budget.evaluateBudgetForRun(
      "local",
      { llmModel: "gpt-4o-mini" },
      { status: status([{ name: "openai", status: "exceeded" }]) }
    );
    expect(decision.skip).toBe(true);
    expect(decision.downgraded).toBe(false);
  });

  it("still skips when green is cheapest even if the red model could be downgraded (F6)", async () => {
    const decision = await budget.evaluateBudgetForRun(
      "local",
      { llmModel: "gpt-4o-mini", redTeamLlmModel: "claude-opus-4-8" },
      { status: status([{ name: "openai", status: "exceeded" }]) }
    );
    expect(decision.skip).toBe(true);
    expect(decision.downgraded).toBe(false);
  });

  it("enforces the effective default model when policy.llmModel is unset (F1)", async () => {
    // No llmModel → resolves to the OpenAI default (gpt-5.4-mini), which HAS a cheaper tier.
    const decision = await budget.evaluateBudgetForRun(
      "local",
      {},
      { status: status([{ name: "openai", status: "exceeded" }]) }
    );
    expect(decision.skip).toBe(false);
    expect(decision.downgraded).toBe(true);
    expect(decision.llmModel).toBeTruthy();
  });

  it("does nothing when the LLM provider is under budget", async () => {
    const decision = await budget.evaluateBudgetForRun(
      "local",
      { llmModel: "gpt-4o" },
      { status: status([{ name: "openai", status: "ok" }, { name: "alpaca", status: "exceeded" }]) }
    );
    expect(decision.skip).toBe(false);
    expect(decision.downgraded).toBe(false);
  });

  it("is a no-op (fail-open) when enforcement is disabled", async () => {
    process.env.USAGE_BUDGET_ENFORCE = "off";
    const decision = await budget.evaluateBudgetForRun(
      "local",
      { llmModel: "gpt-4o" },
      { status: status([{ name: "openai", status: "exceeded" }]) }
    );
    expect(decision.skip).toBe(false);
    expect(decision.downgraded).toBe(false);
  });

  it("is a no-op when budget status is unavailable (monitor down)", async () => {
    const decision = await budget.evaluateBudgetForRun(
      "local",
      { llmModel: "gpt-4o" },
      { status: null }
    );
    expect(decision.skip).toBe(false);
    expect(decision.downgraded).toBe(false);
  });
});

describe("usage-budget: getBudgetStatusCached", () => {
  afterEach(() => {
    delete process.env.USAGE_MONITOR_BASE_URL;
    delete process.env.USAGE_INGEST_TOKEN;
  });

  it("fetches + parses the monitor response with bearer auth", async () => {
    process.env.USAGE_MONITOR_BASE_URL = BASE;
    process.env.USAGE_INGEST_TOKEN = TOKEN;
    let capturedAuth: string | null = null;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      capturedAuth = headers?.authorization ?? null;
      return new Response(JSON.stringify(status([{ name: "anthropic", status: "warning" }])), { status: 200 });
    }) as unknown as typeof fetch;

    const s = await budget.getBudgetStatusCached({ force: true, fetchImpl });
    expect(capturedAuth).toBe(`Bearer ${TOKEN}`);
    expect(s?.providers[0]?.name).toBe("anthropic");
    expect(s?.providers[0]?.status).toBe("warning");
  });

  it("returns null when unconfigured", async () => {
    const s = await budget.getBudgetStatusCached({ force: true });
    expect(s).toBeNull();
  });
});

describe("usage-budget: checkBudgetAndAlert", () => {
  beforeEach(() => {
    process.env.USAGE_MONITOR_BASE_URL = BASE;
    process.env.USAGE_INGEST_TOKEN = TOKEN;
  });
  afterEach(() => {
    delete process.env.USAGE_MONITOR_BASE_URL;
    delete process.env.USAGE_INGEST_TOKEN;
  });

  it("records a budget_alert notification for an exceeded provider without throwing", async () => {
    const before = listNotificationEvents("local", 100).length;
    await expect(
      budget.checkBudgetAndAlert("local", DEFAULT_POLICY, {
        status: status([{ name: "anthropic", status: "exceeded", spentUsd: 120, monthlyBudgetUsd: 100 }]),
      })
    ).resolves.toBeUndefined();
    const after = listNotificationEvents("local", 100);
    expect(after.length).toBeGreaterThan(before);
    expect(after.some((n) => n.type === "budget_alert")).toBe(true);
  });
});

describe("usage-budget: formatBudgetAdvisory", () => {
  it("returns undefined when status is null/undefined", () => {
    expect(budget.formatBudgetAdvisory(null)).toBeUndefined();
    expect(budget.formatBudgetAdvisory(undefined)).toBeUndefined();
  });

  it("returns undefined when every provider is ok/unconfigured (nothing worth mentioning)", () => {
    const s = status([{ name: "openai", status: "ok" }, { name: "anthropic", status: "unconfigured" }]);
    expect(budget.formatBudgetAdvisory(s)).toBeUndefined();
  });

  it("summarizes an exceeded provider with a downgrade/skip suggestion, not a command", () => {
    const s = status([{ name: "openai", status: "exceeded", spentUsd: 150, monthlyBudgetUsd: 100 }]);
    const line = budget.formatBudgetAdvisory(s);
    expect(line).toBeTruthy();
    expect(line).toContain("openai");
    expect(line).toContain("150.00");
    expect(line).toContain("$100");
    expect(line).toContain("status=exceeded");
    // Advisory language, not a directive — the agent decides.
    expect(line).toMatch(/worth weighing|your call/i);
  });

  it("summarizes a warning provider with a softer watch-it suggestion", () => {
    const s = status([{ name: "anthropic", status: "warning", spentUsd: 85, monthlyBudgetUsd: 100 }]);
    const line = budget.formatBudgetAdvisory(s);
    expect(line).toBeTruthy();
    expect(line).toContain("anthropic");
    expect(line).toContain("status=warning");
    expect(line).toMatch(/approaching|your call/i);
  });

  it("only mentions notable providers, silently omitting ok/unconfigured ones", () => {
    const s = status([
      { name: "openai", status: "ok" },
      { name: "anthropic", status: "exceeded", spentUsd: 200, monthlyBudgetUsd: 100 },
    ]);
    const line = budget.formatBudgetAdvisory(s);
    expect(line).toContain("anthropic");
    expect(line).not.toContain("openai");
  });
});
