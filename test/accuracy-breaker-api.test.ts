/**
 * /api/policy enum validation for riskRules.accuracyBreakerAction (accuracy-breaker response,
 * docs/oss-lessons.md §8). "advisory" (default) and "close_only" persist; anything else 400s.
 * Regression mirror of drawdown-breaker-action-api.test.ts: a stored STRING enum inside riskRules
 * must NOT trip the numeric "risk rules must be non-negative numbers" sweep on subsequent saves.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-accuracy-action-api-${randomUUID()}.db`)}`;
});

function putRiskRules(riskRules: Record<string, unknown>) {
  return new Request("http://localhost/api/policy", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ riskRules })
  });
}

describe("/api/policy — riskRules.accuracyBreakerAction validation", () => {
  it("accepts and persists 'close_only'", async () => {
    const { PUT } = await import("../app/api/policy/route");
    const { getPolicy } = await import("../src/lib/db");
    const { DEFAULT_REQUEST_USER_ID } = await import("../src/lib/request-user");
    const response = await PUT(putRiskRules({ accuracyBreakerAction: "close_only" }));
    expect(response.status).toBe(200);
    expect((await response.json()).riskRules.accuracyBreakerAction).toBe("close_only");
    expect(getPolicy(DEFAULT_REQUEST_USER_ID).riskRules.accuracyBreakerAction).toBe("close_only");
  });

  it("accepts 'advisory' (the default action)", async () => {
    const { PUT } = await import("../app/api/policy/route");
    const response = await PUT(putRiskRules({ accuracyBreakerAction: "advisory" }));
    expect(response.status).toBe(200);
    expect((await response.json()).riskRules.accuracyBreakerAction).toBe("advisory");
  });

  it("rejects any other value with a clear 400 — including 'halt' (drawdown-only)", async () => {
    const { PUT } = await import("../app/api/policy/route");
    for (const bad of ["halt", "close-only", "stop", "off", 1, true]) {
      const response = await PUT(putRiskRules({ accuracyBreakerAction: bad }));
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("riskRules.accuracyBreakerAction must be advisory or close_only.");
    }
  });

  it("does NOT trip the numeric risk-rules sweep — an unrelated later save still succeeds once it's stored", async () => {
    const { PUT } = await import("../app/api/policy/route");
    expect((await PUT(putRiskRules({ accuracyBreakerAction: "close_only" }))).status).toBe(200);
    const response = await PUT(putRiskRules({ accuracyBreakerConsecutiveLosses: 3 }));
    expect(response.status).toBe(200);
    const policy = await response.json();
    expect(policy.riskRules.accuracyBreakerConsecutiveLosses).toBe(3);
    expect(policy.riskRules.accuracyBreakerAction).toBe("close_only"); // preserved through the merge
  });

  it("accepts the numeric accuracy-breaker thresholds", async () => {
    const { PUT } = await import("../app/api/policy/route");
    const response = await PUT(
      putRiskRules({ accuracyBreakerConsecutiveLosses: 3, accuracyBreakerWindow: 10, accuracyBreakerMinHitRatePct: 30, accuracyBreakerRecoveryWins: 2 })
    );
    expect(response.status).toBe(200);
    const policy = await response.json();
    expect(policy.riskRules.accuracyBreakerWindow).toBe(10);
    expect(policy.riskRules.accuracyBreakerMinHitRatePct).toBe(30);
  });

  it("still rejects a genuinely negative numeric accuracy-breaker rule", async () => {
    const { PUT } = await import("../app/api/policy/route");
    const response = await PUT(putRiskRules({ accuracyBreakerConsecutiveLosses: -1 }));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("risk rules must be non-negative numbers.");
  });
});
