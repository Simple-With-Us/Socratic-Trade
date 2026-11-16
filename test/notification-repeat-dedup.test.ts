import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Repeat-notification suppression for block / pending_approval (prod 2026-07-28..30: the same
// "Sell AAPL blocked — available 0" and staleness-gate blocks re-notified on EVERY strategy run
// while one stuck condition persisted). The block itself stays persisted via the run-proposal
// path; only the repeated NOTIFICATION is suppressed within a cooldown, keyed by
// (type, symbol, side, digit-normalized primary reason). Only status='sent' rows dedupe.

beforeEach(() => {
  vi.resetModules();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-notify-repeat-${randomUUID()}.db`)}`;
  delete process.env.NOTIFICATION_REPEAT_DEDUP_MS;
});

const blockInput = (reason: string, symbol = "AAPL") => ({
  type: "block" as const,
  title: `Sell ${symbol} blocked`,
  payload: { proposal: { symbol, side: "sell" }, decision: { reasons: [reason] } }
});

async function seedSentBlock(userId: string, reason: string, symbol = "AAPL", status: "sent" | "failed" = "sent") {
  const { insertNotificationEvent } = await import("../src/lib/db");
  return insertNotificationEvent({
    userId,
    type: "block",
    title: `Sell ${symbol} blocked`,
    status,
    payload: { proposal: { symbol, side: "sell" }, decision: { reasons: [reason] } }
  });
}

describe("notification repeat-dedup (block / pending_approval)", () => {
  it("suppresses a repeat of an identical, already-delivered block within the cooldown", async () => {
    const userId = `user-${randomUUID()}`;
    await seedSentBlock(userId, "Only 0 of 6 shares available to sell");
    const { sendNotification } = await import("../src/lib/notifications");
    const { listNotificationEvents } = await import("../src/lib/db");
    const before = listNotificationEvents(userId).length;

    const event = await sendNotification(blockInput("Only 0 of 6 shares available to sell"), { userId });

    expect(event.status).toBe("skipped");
    expect(event.error).toMatch(/repeat-dedup/i);
    expect(listNotificationEvents(userId)).toHaveLength(before); // no new feed row either
  });

  it("digit changes in the reason (quote age, requested qty) do NOT defeat the fingerprint", async () => {
    const userId = `user-${randomUUID()}`;
    await seedSentBlock(userId, "Only 0 of 6 shares available to sell");
    const { sendNotification } = await import("../src/lib/notifications");

    const event = await sendNotification(blockInput("Only 0 of 3 shares available to sell"), { userId });
    expect(event.status).toBe("skipped");
    expect(event.error).toMatch(/repeat-dedup/i);
  });

  it("fires normally for a DIFFERENT reason, symbol, or notification type", async () => {
    const userId = `user-${randomUUID()}`;
    await seedSentBlock(userId, "Only 0 of 6 shares available to sell");
    const { sendNotification } = await import("../src/lib/notifications");
    const { listNotificationEvents } = await import("../src/lib/db");
    const before = listNotificationEvents(userId).length;

    const differentReason = await sendNotification(blockInput("Quote staleness gate: quote is 42 minutes old"), { userId });
    expect(differentReason.error ?? "").not.toMatch(/repeat-dedup/i);

    const differentSymbol = await sendNotification(blockInput("Only 0 of 6 shares available to sell", "EA"), { userId });
    expect(differentSymbol.error ?? "").not.toMatch(/repeat-dedup/i);

    const differentType = await sendNotification(
      { type: "run_failed", title: "Run failed", payload: { proposal: { symbol: "AAPL", side: "sell" }, decision: { reasons: ["Only 0 of 6 shares available to sell"] } } },
      { userId }
    );
    expect(differentType.error ?? "").not.toMatch(/repeat-dedup/i);

    expect(listNotificationEvents(userId).length).toBeGreaterThan(before);
  });

  it("a prior FAILED/SKIPPED delivery does not suppress the next attempt", async () => {
    const userId = `user-${randomUUID()}`;
    await seedSentBlock(userId, "Only 0 of 6 shares available to sell", "AAPL", "failed");
    const { sendNotification } = await import("../src/lib/notifications");

    const event = await sendNotification(blockInput("Only 0 of 6 shares available to sell"), { userId });
    expect(event.error ?? "").not.toMatch(/repeat-dedup/i);
  });

  it("respects the NOTIFICATION_REPEAT_DEDUP_MS window (0-age cutoff => no suppression)", async () => {
    const userId = `user-${randomUUID()}`;
    await seedSentBlock(userId, "Only 0 of 6 shares available to sell");
    process.env.NOTIFICATION_REPEAT_DEDUP_MS = "1"; // 1ms window: the seeded row is already outside it
    const { sendNotification } = await import("../src/lib/notifications");

    await new Promise((resolve) => setTimeout(resolve, 5));
    const event = await sendNotification(blockInput("Only 0 of 6 shares available to sell"), { userId });
    expect(event.error ?? "").not.toMatch(/repeat-dedup/i);
  });
});

describe("repeatNotificationFingerprint", () => {
  it("is stable across digit changes and differs by type/symbol/side/reason", async () => {
    const { repeatNotificationFingerprint } = await import("../src/lib/notifications");
    const a = repeatNotificationFingerprint(blockInput("Quote is 17 minutes old"));
    const b = repeatNotificationFingerprint(blockInput("Quote is 42 minutes old"));
    expect(a).toBe(b);

    expect(repeatNotificationFingerprint(blockInput("Quote is 17 minutes old", "JNJ"))).not.toBe(a);
    expect(repeatNotificationFingerprint({ type: "pending_approval", payload: blockInput("Quote is 17 minutes old").payload })).not.toBe(a);
    expect(repeatNotificationFingerprint(blockInput("A completely different reason"))).not.toBe(a);
  });

  it("returns null for non-dedup types and for payloads without symbol or reason (never deduped)", async () => {
    const { repeatNotificationFingerprint } = await import("../src/lib/notifications");
    expect(repeatNotificationFingerprint({ type: "fill", payload: { proposal: { symbol: "AAPL", side: "sell" }, decision: { reasons: ["x"] } } })).toBeNull();
    expect(repeatNotificationFingerprint({ type: "block", payload: {} })).toBeNull();
    expect(repeatNotificationFingerprint({ type: "block", payload: null })).toBeNull();
  });

  it("fingerprints price_alert by alert id, not symbol", async () => {
    const { repeatNotificationFingerprint } = await import("../src/lib/notifications");
    const aaplBelow = repeatNotificationFingerprint({
      type: "price_alert",
      payload: { alert: { id: "alert-a", symbol: "AAPL" }, currentPrice: 100 }
    });
    const aaplAbove = repeatNotificationFingerprint({
      type: "price_alert",
      payload: { alert: { id: "alert-b", symbol: "AAPL" }, currentPrice: 200 }
    });
    expect(aaplBelow).toBe("price_alert|alert-a");
    expect(aaplAbove).toBe("price_alert|alert-b");
    expect(aaplBelow).not.toBe(aaplAbove);
    expect(repeatNotificationFingerprint({ type: "price_alert", payload: { alert: { symbol: "AAPL" } } })).toBeNull();
  });

  it("fingerprints provider_degraded by service/source and budget_alert by provider+limit", async () => {
    const { repeatNotificationFingerprint } = await import("../src/lib/notifications");
    expect(
      repeatNotificationFingerprint({
        type: "provider_degraded",
        payload: { service: "Pinecone", keySource: "env" }
      })
    ).toBe("provider_degraded|pinecone|env");
    expect(
      repeatNotificationFingerprint({
        type: "budget_alert",
        payload: { provider: "Pinecone", operation: "upsert-budget", limitName: "Write Unit daily fuse" }
      })
    ).toBe("budget_alert|pinecone|upsert-budget|write unit daily fuse");
    expect(repeatNotificationFingerprint({ type: "provider_degraded", payload: {} })).toBeNull();
  });
});

describe("alert repeat lock (60s same-fingerprint)", () => {
  const priceInput = (alertId: string, symbol = "AAPL") => ({
    type: "price_alert" as const,
    title: `Price alert: ${symbol}`,
    payload: { alert: { id: alertId, symbol, op: ">", price: 100 }, currentPrice: 110 }
  });

  async function seedSent(
    userId: string,
    input: { type: "price_alert" | "provider_degraded"; title: string; payload: unknown },
    status: "sent" | "failed" | "skipped" = "sent"
  ) {
    const { insertNotificationEvent } = await import("../src/lib/db");
    return insertNotificationEvent({
      userId,
      type: input.type,
      title: input.title,
      status,
      payload: input.payload
    });
  }

  it("suppresses a second send of the same price_alert id inside 60s", async () => {
    const userId = `user-${randomUUID()}`;
    await seedSent(userId, priceInput("alert-same"));
    const { sendNotification } = await import("../src/lib/notifications");
    const { listNotificationEvents } = await import("../src/lib/db");
    const before = listNotificationEvents(userId).length;

    const event = await sendNotification(priceInput("alert-same"), { userId });

    expect(event.status).toBe("skipped");
    expect(event.error).toMatch(/repeat-dedup/i);
    expect(listNotificationEvents(userId)).toHaveLength(before);
  });

  it("still sends a different price_alert id for the same symbol", async () => {
    const userId = `user-${randomUUID()}`;
    await seedSent(userId, priceInput("alert-a"));
    const { sendNotification } = await import("../src/lib/notifications");

    const event = await sendNotification(priceInput("alert-b"), { userId });
    expect(event.error ?? "").not.toMatch(/repeat-dedup/i);
  });

  it("a failed or skipped first price_alert does not suppress the next attempt", async () => {
    const userId = `user-${randomUUID()}`;
    await seedSent(userId, priceInput("alert-fail"), "failed");
    const { sendNotification } = await import("../src/lib/notifications");

    const afterFailed = await sendNotification(priceInput("alert-fail"), { userId });
    expect(afterFailed.error ?? "").not.toMatch(/repeat-dedup/i);

    await seedSent(userId, priceInput("alert-skip"), "skipped");
    const afterSkipped = await sendNotification(priceInput("alert-skip"), { userId });
    expect(afterSkipped.error ?? "").not.toMatch(/repeat-dedup/i);
  });

  it("suppresses a repeat provider_degraded for the same service inside 60s", async () => {
    const userId = `user-${randomUUID()}`;
    const input = {
      type: "provider_degraded" as const,
      title: "pinecone connection failed",
      payload: { service: "pinecone", keySource: "env" }
    };
    await seedSent(userId, input);
    const { sendNotification } = await import("../src/lib/notifications");
    const { listNotificationEvents } = await import("../src/lib/db");
    const before = listNotificationEvents(userId).length;

    const event = await sendNotification(input, { userId });
    expect(event.status).toBe("skipped");
    expect(event.error).toMatch(/repeat-dedup/i);
    expect(listNotificationEvents(userId)).toHaveLength(before);
  });
});
