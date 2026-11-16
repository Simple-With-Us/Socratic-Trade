import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-notify-test-${randomUUID()}.db`)}`;
});

describe("sendPolicyWebhookTest", () => {
  it("returns null when policy.notificationSettings.webhookUrl is unset", async () => {
    const { sendPolicyWebhookTest } = await import("../src/lib/notifications");
    const result = await sendPolicyWebhookTest("local");
    expect(result).toBeNull();
  });

  it("POSTs through the legacy embed path when webhookUrl is configured", async () => {
    const { setPolicy, getPolicy } = await import("../src/lib/db");
    const { sendPolicyWebhookTest } = await import("../src/lib/notifications");
    const url = "https://discord.com/api/webhooks/12345/abcdef";
    const current = getPolicy("local");
    setPolicy(
      {
        ...current,
        notificationSettings: { ...current.notificationSettings, webhookUrl: url }
      },
      "local"
    );

    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    const result = await sendPolicyWebhookTest("local", {
      fetcher: fetcher as typeof fetch,
      resolveWebhookHost: async () => ["8.8.8.8"]
    });

    expect(result).toEqual({ channel: "webhook", ok: true });
    expect(fetcher).toHaveBeenCalledOnce();
    const firstCall = fetcher.mock.calls[0] as unknown as [string, RequestInit] | undefined;
    expect(firstCall?.[0]).toBe(url);
    const init = firstCall?.[1];
    expect(init?.method).toBe("POST");
    const body = JSON.parse(String(init?.body));
    expect(body.embeds).toBeDefined();
    expect(body.embeds[0].title).toContain("Test notification");
  });
});
