import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-llm-budget-route-${randomUUID()}.db`)}`;
  delete process.env.TRIGGER_LLM_DAILY_TOKEN_BUDGET;
  delete process.env.TRIGGER_LLM_DAILY_COST_BUDGET_USD;
});

function request(method: string, body?: Record<string, unknown>) {
  return new Request("http://localhost/api/settings/llm-budget", {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
}

describe("/api/settings/llm-budget", () => {
  it("GET starts with no user cap and enforced=false", async () => {
    const { GET } = await import("../app/api/settings/llm-budget/route");
    const res = await GET(new Request("http://localhost/api/settings/llm-budget") as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tokenBudget).toBeNull();
    expect(body.costBudgetUsd).toBeNull();
    expect(body.enforced).toBe(false);
    expect(body.effective.tokenSource).toBe("none");
  });

  it("PATCH writes a user cost cap and GET round-trips it", async () => {
    const { PATCH, GET } = await import("../app/api/settings/llm-budget/route");
    const saved = await PATCH(request("PATCH", { costBudgetUsd: 7.5 }) as never);
    expect(saved.status).toBe(200);
    const written = await saved.json();
    expect(written.costBudgetUsd).toBe(7.5);
    expect(written.enforced).toBe(true);
    expect(written.effective.costSource).toBe("user");
    expect(written.effective.costLimitUsd).toBe(7.5);

    const read = await (await GET(request("GET") as never)).json();
    expect(read.costBudgetUsd).toBe(7.5);
    expect(read.effective.costSource).toBe("user");
  });

  it("PATCH null clears the user override", async () => {
    const { PATCH } = await import("../app/api/settings/llm-budget/route");
    expect((await PATCH(request("PATCH", { tokenBudget: 1000 }) as never)).status).toBe(200);
    const cleared = await PATCH(request("PATCH", { tokenBudget: null, costBudgetUsd: null }) as never);
    expect(cleared.status).toBe(200);
    const body = await cleared.json();
    expect(body.tokenBudget).toBeNull();
    expect(body.costBudgetUsd).toBeNull();
    expect(body.enforced).toBe(false);
  });

  it("rejects a negative cap", async () => {
    const { PATCH } = await import("../app/api/settings/llm-budget/route");
    const res = await PATCH(request("PATCH", { tokenBudget: -4 }) as never);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("non-negative");
  });
});
