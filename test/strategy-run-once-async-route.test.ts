/**
 * POST /api/strategy/run — durable async run-once.
 * The request must be written before 202 so an app restart cannot lose a slow LLM run after the
 * client has been told it started.  A background worker executes only that persisted request.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/strategy", async (importActual) => {
  const actual = await importActual<typeof import("../src/lib/strategy")>();
  return { ...actual, runStrategyOnce: vi.fn() };
});

import { runStrategyOnce } from "@/lib/strategy";
import { getPolicy, setPolicy } from "@/lib/db";
import { DEV_USER_ID } from "@/lib/auth/identity";

const LLM_ENV = ["OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "XAI_API_KEY", "GEMINI_API_KEY", "MISTRAL_API_KEY", "DEEPSEEK_API_KEY"];
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-run-once-async-${randomUUID()}.db`)}`;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(runStrategyOnce).mockReset();
});

function stubLlmKeyAvailable(): void {
  vi.stubEnv("LLM_OPERATOR_FALLBACK", "on");
  vi.stubEnv("OPENROUTER_API_KEY", "test-operator-key");
  setPolicy({ ...getPolicy(DEV_USER_ID), llmModel: "gpt-5.4-mini" }, DEV_USER_ID);
}

function stubNoLlmKey(): void {
  vi.stubEnv("LLM_OPERATOR_FALLBACK", "off");
  for (const k of LLM_ENV) vi.stubEnv(k, "");
}

async function callRoute(body: unknown = { manual: true }): Promise<Response> {
  const { getDb } = await import("../src/lib/db");
  getDb();
  const { POST } = await import("../app/api/strategy/run/route");
  return POST(new Request("http://localhost/api/strategy/run", { method: "POST", body: JSON.stringify(body) }));
}

describe("POST /api/strategy/run — durable async run-once", () => {
  it("persists a real run id before returning 202 and does not wait for the executor", async () => {
    stubLlmKeyAvailable();
    let resolveRun!: (value: unknown) => void;
    vi.mocked(runStrategyOnce).mockReturnValue(
      new Promise((resolve) => {
        resolveRun = resolve;
      }) as never
    );

    const start = Date.now();
    const res = await callRoute();
    const elapsed = Date.now() - start;
    expect(res.status).toBe(202);
    const body = (await res.json()) as { runId: string; status: string; summary: string };
    expect(body).toMatchObject({ status: "queued" });
    expect(body.runId).toMatch(/^[a-f0-9-]{36}$/);
    expect(elapsed).toBeLessThan(2_000);

    await tick();
    expect(runStrategyOnce).toHaveBeenCalledWith(DEV_USER_ID, { manual: true, runId: body.runId });
    const { getStrategyRunRequest } = await import("../src/lib/strategy-run-requests");
    expect(getStrategyRunRequest(body.runId, DEV_USER_ID)?.status).toBe("running");
    resolveRun({ runId: body.runId, status: "completed", summary: "done", proposals: [] });
    await tick();
    expect(getStrategyRunRequest(body.runId, DEV_USER_ID)).toMatchObject({
      status: "completed",
      result: { runId: body.runId, summary: "done" }
    });
  });

  it("deduplicates an additional click while the durable run is in progress", async () => {
    stubLlmKeyAvailable();
    let resolveRun!: (value: unknown) => void;
    vi.mocked(runStrategyOnce).mockReturnValue(
      new Promise((resolve) => {
        resolveRun = resolve;
      }) as never
    );

    const first = await callRoute();
    const firstBody = (await first.json()) as { runId: string };
    await tick();
    const second = await callRoute();
    const secondBody = (await second.json()) as { runId: string; status: string };

    expect(second.status).toBe(202);
    expect(secondBody.status).toBe("queued");
    expect(secondBody.runId).toBe(firstBody.runId);
    expect(runStrategyOnce).toHaveBeenCalledTimes(1);
    resolveRun({ runId: firstBody.runId, status: "completed", summary: "done", proposals: [] });
    await tick();
  });

  it("keeps the 412 LLM-gate pre-check synchronous and never launches the run executor", async () => {
    stubNoLlmKey();
    setPolicy({ ...getPolicy(DEV_USER_ID), llmModel: "gpt-5.4-mini" }, DEV_USER_ID);
    const res = await callRoute();
    expect(res.status).toBe(412);
    expect(runStrategyOnce).not.toHaveBeenCalled();
  });

  it("still 412s an explicitly BLANK Green model with the model-choice message (key present)", async () => {
    stubLlmKeyAvailable();
    setPolicy({ ...getPolicy(DEV_USER_ID), llmModel: "" }, DEV_USER_ID);
    const res = await callRoute();
    expect(res.status).toBe(412);
    const body = (await res.json()) as { summary: string };
    const { LLM_MODEL_REQUIRED_STRATEGY_MESSAGE } = await import("../src/lib/llm-required");
    expect(body.summary).toBe(LLM_MODEL_REQUIRED_STRATEGY_MESSAGE);
    expect(runStrategyOnce).not.toHaveBeenCalled();
  });

  it("lets a rotating Green through when the eligible rotation pool is non-empty (no 412)", async () => {
    stubLlmKeyAvailable();
    setPolicy({ ...getPolicy(DEV_USER_ID), llmModel: "__rotate__" }, DEV_USER_ID);
    vi.mocked(runStrategyOnce).mockResolvedValue({
      runId: "run-rotate",
      status: "completed",
      summary: "ok",
      proposals: []
    } as never);
    const res = await callRoute();
    expect(res.status).toBe(202);
    await tick();
    expect(runStrategyOnce).toHaveBeenCalledTimes(1);
  });

  it("412s a rotating Green with the actionable ROTATION message when NO credential resolves (empty pool)", async () => {
    stubNoLlmKey();
    setPolicy({ ...getPolicy(DEV_USER_ID), llmModel: "__rotate__" }, DEV_USER_ID);
    const res = await callRoute();
    expect(res.status).toBe(412);
    const body = (await res.json()) as { summary: string };
    const { LLM_ROTATION_EMPTY_POOL_STRATEGY_MESSAGE } = await import("../src/lib/llm-required");
    expect(body.summary).toBe(LLM_ROTATION_EMPTY_POOL_STRATEGY_MESSAGE);
    expect(runStrategyOnce).not.toHaveBeenCalled();
  });

  it("does NOT gate on a rotating RED seat (blank/rotating red routes per-opening to human, not a 412)", async () => {
    stubLlmKeyAvailable();
    setPolicy({ ...getPolicy(DEV_USER_ID), redTeamLlmModel: "__rotate__" }, DEV_USER_ID);
    vi.mocked(runStrategyOnce).mockResolvedValue({
      runId: "run-red-rotate",
      status: "completed",
      summary: "ok",
      proposals: []
    } as never);
    const res = await callRoute();
    expect(res.status).toBe(202);
    await tick();
    expect(runStrategyOnce).toHaveBeenCalledTimes(1);
  });
});
