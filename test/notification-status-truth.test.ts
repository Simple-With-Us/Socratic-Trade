import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import { getDb } from "../src/lib/db";
import { sendNotification } from "../src/lib/notifications";
import { notify } from "../src/lib/notify";
import type { NotificationEventType, NotifyChannelResult, TradingPolicy } from "../src/lib/types";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `notification-status-truth-${randomUUID()}.db`)}`;
  getDb();
});

beforeEach(() => {
  getDb().prepare("DELETE FROM notification_events").run();
  getDb().prepare("DELETE FROM audit_events").run();
  getDb().prepare("DELETE FROM notification_prefs").run();
});

function policyFor(type: NotificationEventType, webhookUrl = ""): TradingPolicy {
  return {
    ...DEFAULT_POLICY,
    notificationSettings: {
      ...DEFAULT_POLICY.notificationSettings,
      enabledEvents: [type],
      webhookUrl
    }
  };
}

function notifierReturning(results: NotifyChannelResult[]): typeof notify {
  return vi.fn(async () => results) as unknown as typeof notify;
}

function auditPayloads(kind: string): Array<Record<string, unknown>> {
  const rows = getDb().prepare("SELECT payload FROM audit_events WHERE kind = ? ORDER BY created_at ASC").all(kind) as Array<{ payload: string }>;
  return rows.map((row) => JSON.parse(row.payload) as Record<string, unknown>);
}

describe("truthful notification delivery aggregation", () => {
  it("records a neutral human skip when no channels are enabled", async () => {
    const notifyImpl = notifierReturning([]);
    const event = await sendNotification(
      { type: "fill", title: "Fill", payload: {} },
      { policy: policyFor("fill"), userId: "no-channels", notifyImpl }
    );

    expect(event).toMatchObject({ status: "skipped", error: "No notification channels enabled." });
    expect(notifyImpl).toHaveBeenCalledOnce();
  });

  it("renders every all-skipped channel reason in human terms", async () => {
    const event = await sendNotification(
      { type: "fill", title: "Fill", payload: {} },
      {
        policy: policyFor("fill"),
        userId: "all-skipped",
        notifyImpl: notifierReturning([
          { channel: "push", ok: false, skipped: "not_configured" },
          { channel: "email", ok: false, skipped: "no_target" }
        ])
      }
    );

    expect(event.status).toBe("skipped");
    expect(event.error).toBe("Phone push is not configured by the operator. | Email has no delivery target.");
  });

  it("records joined, channel-labelled failures when every delivery fails", async () => {
    const event = await sendNotification(
      { type: "run_failed", title: "Run failed", payload: {} },
      {
        policy: policyFor("run_failed"),
        userId: "all-failed",
        notifyImpl: notifierReturning([
          { channel: "push", ok: false, error: "HTTP 500" },
          { channel: "email", ok: false }
        ])
      }
    );

    expect(event.status).toBe("failed");
    expect(event.error).toBe("Phone push: HTTP 500 | Email: Delivery failed.");
  });

  it("records sent-with-partial-failure and audits a failed legacy webhook", async () => {
    const event = await sendNotification(
      { type: "fill", title: "Fill", payload: {} },
      {
        policy: policyFor("fill", "https://legacy.example/hook"),
        userId: "partial",
        notifyImpl: notifierReturning([{ channel: "email", ok: true }]),
        fetcher: async () => new Response("down", { status: 500 })
      }
    );

    expect(event.status).toBe("sent");
    expect(event.error).toBe("Partial delivery failure: Webhook: Webhook returned HTTP 500.");
    expect(auditPayloads("notify.error")).toContainEqual(
      expect.objectContaining({ channel: "webhook", kind: "fill", source: "legacy_policy_webhook", error: "Webhook returned HTTP 500." })
    );
    expect(auditPayloads("notification.delivery")).toContainEqual(
      expect.objectContaining({ notificationEventId: event.id, status: "sent" })
    );
  });

  it.each(["price_alert", "provider_degraded"] as const)("delivers and records former already-direct type %s exactly once", async (type) => {
    const notifyImpl = notifierReturning([{ channel: "email", ok: true }]);
    const event = await sendNotification(
      { type, title: type, payload: {} },
      { policy: policyFor(type), userId: `direct-${type}`, notifyImpl, directBody: "Detailed body" }
    );

    expect(event.status).toBe("sent");
    expect(event.error).toBeUndefined();
    expect(notifyImpl).toHaveBeenCalledOnce();
    expect(notifyImpl).toHaveBeenCalledWith(
      `direct-${type}`,
      expect.objectContaining({ kind: type, body: "Detailed body" }),
      expect.any(Object)
    );
  });

  it("records an unexpected bridge exception as failed and audits the exception", async () => {
    const notifyImpl = vi.fn(async () => {
      throw new Error("notification prefs unavailable");
    }) as unknown as typeof notify;
    const event = await sendNotification(
      { type: "fill", title: "Fill", payload: {} },
      { policy: policyFor("fill"), userId: "bridge-throw", notifyImpl }
    );

    expect(event.status).toBe("failed");
    expect(event.error).toBe("Delivery bridge: notification prefs unavailable");
    expect(auditPayloads("notify.bridge.error")).toContainEqual(
      expect.objectContaining({ userId: "bridge-throw", type: "fill", source: "direct", error: "notification prefs unavailable" })
    );
  });

  it("includes a lazy operator fallback result in the persisted aggregate", async () => {
    const additionalDelivery = vi.fn(async () => [{ channel: "email", ok: true }] satisfies NotifyChannelResult[]);
    const event = await sendNotification(
      { type: "provider_degraded", title: "Provider degraded", payload: {} },
      {
        policy: policyFor("provider_degraded"),
        userId: "fallback-success",
        notifyImpl: notifierReturning([]),
        additionalDelivery
      }
    );

    expect(event.status).toBe("sent");
    expect(event.error).toBeUndefined();
    expect(additionalDelivery).toHaveBeenCalledOnce();
    expect(auditPayloads("notification.delivery")).toContainEqual(
      expect.objectContaining({ notificationEventId: event.id, results: [{ channel: "email", ok: true }] })
    );
  });

  it("records a throwing additional delivery as a failed bridge outcome", async () => {
    const additionalDelivery = vi.fn(async () => {
      throw new Error("fallback dispatcher unavailable");
    });
    const event = await sendNotification(
      { type: "provider_degraded", title: "Provider degraded", payload: {} },
      {
        policy: policyFor("provider_degraded"),
        userId: "fallback-throw",
        notifyImpl: notifierReturning([]),
        additionalDelivery
      }
    );

    expect(event.status).toBe("failed");
    expect(event.error).toBe("Additional delivery: fallback dispatcher unavailable");
    expect(auditPayloads("notify.bridge.error")).toContainEqual(
      expect.objectContaining({ userId: "fallback-throw", type: "provider_degraded", source: "additional", error: "fallback dispatcher unavailable" })
    );
  });

  it("audits a successful legacy webhook through the same delivery telemetry vocabulary", async () => {
    const event = await sendNotification(
      { type: "fill", title: "Fill", payload: {} },
      {
        policy: policyFor("fill", "https://legacy.example/hook"),
        userId: "webhook-success",
        notifyImpl: notifierReturning([]),
        fetcher: async () => new Response(null, { status: 204 })
      }
    );

    expect(event.status).toBe("sent");
    expect(auditPayloads("notify.sent")).toContainEqual(
      expect.objectContaining({ channel: "webhook", kind: "fill", source: "legacy_policy_webhook" })
    );
  });

  it("does no direct, fallback, or webhook delivery when the event type is disabled", async () => {
    const notifyImpl = notifierReturning([{ channel: "email", ok: true }]);
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    const additionalDelivery = vi.fn(async () => [{ channel: "email", ok: true }] satisfies NotifyChannelResult[]);
    const policy = policyFor("fill", "https://legacy.example/hook");
    policy.notificationSettings.enabledEvents = [];

    const event = await sendNotification(
      { type: "fill", title: "Fill", payload: {} },
      { policy, userId: "disabled", notifyImpl, fetcher, additionalDelivery }
    );

    expect(event).toMatchObject({ status: "skipped", error: "Notification type is disabled." });
    expect(notifyImpl).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(additionalDelivery).not.toHaveBeenCalled();
  });
});
