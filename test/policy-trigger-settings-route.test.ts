/**
 * /api/policy — guard tuning fields + per-account trigger settings (2026-07-28).
 *
 * (d) Validation accepts/rejects the new fields correctly.
 * (e) The tuning UI fields round-trip through the policy PATCH path: the guardrails page's sparse
 *     dot-path draft builder (buildPatch) nests them under `tuning`/`triggerSettings`, so this
 *     exercises exactly the body shape the UI sends, including null-clear semantics.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-trigger-policy-route-${randomUUID()}.db`)}`;
});

function putPolicy(body: Record<string, unknown>) {
  return new Request("http://localhost/api/policy", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("/api/policy — tuning guard fields (vol targeting, heat budget, risk receipts)", () => {
  it("round-trips the four tuning guard fields through the PUT path the UI uses", async () => {
    const { PUT } = await import("../app/api/policy/route");
    const response = await PUT(putPolicy({
      tuning: { volTargeting: false, targetPortfolioVolPct: 18, portfolioHeatBudgetPct: 6, riskReceipts: false }
    }));
    expect(response.status).toBe(200);
    const saved = await response.json();
    expect(saved.tuning.volTargeting).toBe(false);
    expect(saved.tuning.targetPortfolioVolPct).toBe(18);
    expect(saved.tuning.portfolioHeatBudgetPct).toBe(6);
    expect(saved.tuning.riskReceipts).toBe(false);

    // An unrelated save must not drop them (deep-merge, not wholesale replace).
    const unrelated = await PUT(putPolicy({ maxDailyOrders: 7 }));
    expect(unrelated.status).toBe(200);
    const after = await unrelated.json();
    expect(after.tuning.targetPortfolioVolPct).toBe(18);
    expect(after.tuning.portfolioHeatBudgetPct).toBe(6);
    expect(after.maxDailyOrders).toBe(7);
  });

  it("clears an optional pct back to the shipped default on null (UI blank semantics)", async () => {
    const { PUT } = await import("../app/api/policy/route");
    expect((await PUT(putPolicy({ tuning: { targetPortfolioVolPct: 18 } }))).status).toBe(200);
    const cleared = await PUT(putPolicy({ tuning: { targetPortfolioVolPct: null } }));
    expect(cleared.status).toBe(200);
    // mergePolicy re-applies the DEFAULT_POLICY value — the guard reverts to its default, honestly.
    expect((await cleared.json()).tuning.targetPortfolioVolPct).toBe(25);
  });

  it("rejects out-of-range vol/heat pcts and non-boolean toggles", async () => {
    const { PUT } = await import("../app/api/policy/route");
    for (const bad of [{ targetPortfolioVolPct: 150 }, { targetPortfolioVolPct: -5 }]) {
      const response = await PUT(putPolicy({ tuning: bad }));
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("tuning.targetPortfolioVolPct must be between 0 (off) and 100.");
    }
    const heat = await PUT(putPolicy({ tuning: { portfolioHeatBudgetPct: 101 } }));
    expect(heat.status).toBe(400);
    expect(await heat.text()).toContain("tuning.portfolioHeatBudgetPct must be between 0 (off) and 100.");
    const bool = await PUT(putPolicy({ tuning: { volTargeting: "yes" } }));
    expect(bool.status).toBe(400);
    expect(await bool.text()).toContain("tuning.volTargeting must be a boolean.");
  });
});

describe("/api/policy — triggerSettings", () => {
  it("accepts and persists a full per-account trigger config", async () => {
    const { PUT } = await import("../app/api/policy/route");
    const response = await PUT(putPolicy({
      triggerSettings: { enabled: false, mode: "event", fallbackIntervalMinutes: 240, eventRunMode: "close_only" }
    }));
    expect(response.status).toBe(200);
    const saved = await response.json();
    expect(saved.triggerSettings).toEqual({
      enabled: false,
      mode: "event",
      fallbackIntervalMinutes: 240,
      eventRunMode: "close_only"
    });

    // Sibling keys survive a later partial update.
    const partial = await PUT(putPolicy({ triggerSettings: { mode: "both" } }));
    expect(partial.status).toBe(200);
    const after = await partial.json();
    expect(after.triggerSettings.mode).toBe("both");
    expect(after.triggerSettings.enabled).toBe(false);
    expect(after.triggerSettings.eventRunMode).toBe("close_only");
  });

  it("rejects invalid enum/boolean/interval values", async () => {
    const { PUT } = await import("../app/api/policy/route");
    const mode = await PUT(putPolicy({ triggerSettings: { mode: "banana" } }));
    expect(mode.status).toBe(400);
    expect(await mode.text()).toContain("triggerSettings.mode must be interval, event, or both.");
    const enabled = await PUT(putPolicy({ triggerSettings: { enabled: "on" } }));
    expect(enabled.status).toBe(400);
    expect(await enabled.text()).toContain("triggerSettings.enabled must be a boolean.");
    const fallback = await PUT(putPolicy({ triggerSettings: { fallbackIntervalMinutes: 0 } }));
    expect(fallback.status).toBe(400);
    expect(await fallback.text()).toContain("triggerSettings.fallbackIntervalMinutes must be at least 1 minute");
    const runMode = await PUT(putPolicy({ triggerSettings: { eventRunMode: "yolo" } }));
    expect(runMode.status).toBe(400);
    expect(await runMode.text()).toContain("triggerSettings.eventRunMode must be full or close_only.");
  });

  it("null-clears a sub-key back to 'use global' while siblings persist; absent stays absent", async () => {
    const { PUT } = await import("../app/api/policy/route");
    const { getPolicy } = await import("../src/lib/db");
    const { DEFAULT_REQUEST_USER_ID } = await import("../src/lib/request-user");

    // No trigger config: an unrelated save must NOT materialize the key.
    expect((await PUT(putPolicy({ maxDailyOrders: 8 }))).status).toBe(200);
    expect(getPolicy(DEFAULT_REQUEST_USER_ID).triggerSettings).toBeUndefined();

    expect((await PUT(putPolicy({ triggerSettings: { enabled: false, eventRunMode: "close_only" } }))).status).toBe(200);
    const cleared = await PUT(putPolicy({ triggerSettings: { enabled: null } }));
    expect(cleared.status).toBe(200);
    const after = await cleared.json();
    expect("enabled" in after.triggerSettings).toBe(false);
    expect(after.triggerSettings.eventRunMode).toBe("close_only");
  });
});
