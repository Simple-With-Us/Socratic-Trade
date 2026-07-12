import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-policy-notify-${randomUUID()}.db`)}`;
});

describe("policy notification event settings", () => {
  it("persists provider_degraded when Settings saves enabled notification events", async () => {
    const { PUT } = await import("../app/api/policy/route");
    const { getPolicy } = await import("../src/lib/db");
    const { DEFAULT_REQUEST_USER_ID } = await import("../src/lib/request-user");

    const response = await PUT(
      new Request("http://localhost/api/policy", {
        method: "PUT",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          notificationSettings: {
            ...getPolicy(DEFAULT_REQUEST_USER_ID).notificationSettings,
            enabledEvents: ["fill", "provider_degraded", "limit_order_stale", "not_real"]
          }
        })
      })
    );

    expect(response.status).toBe(200);
    const policy = await response.json();
    expect(policy.notificationSettings.enabledEvents).toEqual(["fill", "provider_degraded", "limit_order_stale"]);
    expect(getPolicy(DEFAULT_REQUEST_USER_ID).notificationSettings.enabledEvents).toEqual(["fill", "provider_degraded", "limit_order_stale"]);
  });

  it("rejects gpt-5.5 high reasoning for interactive strategy runs", async () => {
    const { PUT } = await import("../app/api/policy/route");

    const response = await PUT(
      new Request("http://localhost/api/policy", {
        method: "PUT",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          llmModel: "gpt-5.5",
          llmReasoningEffort: "high"
        })
      })
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("gpt-5.5 with high reasoning is disabled");

    const redTeamResponse = await PUT(
      new Request("http://localhost/api/policy", {
        method: "PUT",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          llmModel: "gpt-5.4-mini",
          redTeamLlmModel: "gpt-5.5",
          llmReasoningEffort: "high"
        })
      })
    );

    expect(redTeamResponse.status).toBe(400);
    expect(await redTeamResponse.text()).toContain("gpt-5.5 with high reasoning is disabled");
  });

  it("does NOT block unrelated saves when the STORED policy already has gpt-5.5 + high reasoning", async () => {
    const { PUT } = await import("../app/api/policy/route");
    const { getPolicy, setPolicy } = await import("../src/lib/db");
    const { DEFAULT_REQUEST_USER_ID } = await import("../src/lib/request-user");

    // Seed a stale stored config directly (bypassing the route): gpt-5.5 + high.
    // Run time already clamps this to medium, so unrelated policy writes must not
    // be rejected because of it (owner-reported bug: saving notification prefs and
    // enabling short selling both failed with the model error).
    setPolicy({ ...getPolicy(DEFAULT_REQUEST_USER_ID), llmModel: "gpt-5.5", llmReasoningEffort: "high" }, DEFAULT_REQUEST_USER_ID);

    const notifyResponse = await PUT(
      new Request("http://localhost/api/policy", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          notificationSettings: { enabledEvents: ["fill", "kill_switch"] }
        })
      })
    );
    expect(notifyResponse.status).toBe(200);
    expect(getPolicy(DEFAULT_REQUEST_USER_ID).notificationSettings.enabledEvents).toEqual(["fill", "kill_switch"]);

    const shortResponse = await PUT(
      new Request("http://localhost/api/policy", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ shortSellingEnabled: true })
      })
    );
    expect(shortResponse.status).toBe(200);
    expect(getPolicy(DEFAULT_REQUEST_USER_ID).shortSellingEnabled).toBe(true);
    // The stored model config is untouched by the unrelated saves.
    expect(getPolicy(DEFAULT_REQUEST_USER_ID).llmModel).toBe("gpt-5.5");
    expect(getPolicy(DEFAULT_REQUEST_USER_ID).llmReasoningEffort).toBe("high");

    // But a write that CHANGES the model/effort combo to the disallowed one is still rejected.
    const stillRejected = await PUT(
      new Request("http://localhost/api/policy", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ llmModel: "gpt-5.4-mini", llmReasoningEffort: "high", redTeamLlmModel: "gpt-5.5" })
      })
    );
    expect(stillRejected.status).toBe(400);
    expect(await stillRejected.text()).toContain("gpt-5.5 with high reasoning is disabled");
  });
});
