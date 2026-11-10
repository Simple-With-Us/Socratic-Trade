import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import { getDb } from "../src/lib/db";
import { sendNotification } from "../src/lib/notifications";
import type { notify } from "../src/lib/notify";
import type { NotificationEventType, NotifyChannelResult, TradingPolicy } from "../src/lib/types";

// Covers two body-formatting bugs in src/lib/notifications.ts:
//   1. run_failed's directNotificationBody/formatDiscordPayload used to fall straight through to the
//      title when payload.summary was absent, duplicating the title as the body and dropping the real
//      broker rejection/decline/uncertainty detail every emission site actually carries under
//      payload.reason or payload.error (e.g. SMS "BAC order rejected by broker\nBAC order rejected by
//      broker").
//   2. fill's formatters rendered a "pending_reconciliation" pre-confirmation placeholder receipt's
//      zeroed quantity/price/notional verbatim (e.g. "BUY 0 JPM pending_reconciliation ($0.00)")
//      instead of an intent-truthful "not yet confirmed" body.

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `notification-body-fixes-${randomUUID()}.db`)}`;
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

function notifierCapturingBody(): { notifyImpl: typeof notify; bodies: string[] } {
  const bodies: string[] = [];
  const notifyImpl = vi.fn(async (_userId: string, message: { body: string }) => {
    bodies.push(message.body);
    return [{ channel: "sms", ok: true }] satisfies NotifyChannelResult[];
  }) as unknown as typeof notify;
  return { notifyImpl, bodies };
}

async function directBody(
  type: NotificationEventType,
  title: string,
  payload: unknown,
  userId = randomUUID()
): Promise<string> {
  const { notifyImpl, bodies } = notifierCapturingBody();
  await sendNotification({ type, title, payload }, { policy: policyFor(type), userId, notifyImpl });
  expect(bodies).toHaveLength(1);
  return bodies[0];
}

// The legacy webhook path now re-validates its target with a real DNS lookup on every send
// (SSRF/rebinding hardening — src/lib/egress-guard.ts). Stub it so this test doesn't depend
// on real network/DNS access even though discord.com is a real, resolvable host.
const resolveWebhookHost = async () => ["8.8.8.8"];

async function discordEmbed(type: NotificationEventType, title: string, payload: unknown): Promise<{ description?: string; fields?: Array<{ name: string; value: string }> }> {
  let capturedBody: any = null;
  const fetcher = async (_url: string | URL | Request, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body));
    return new Response(null, { status: 204 });
  };
  await sendNotification(
    { type, title, payload },
    {
      policy: policyFor(type, "https://discord.com/api/webhooks/12345/abcde"),
      userId: randomUUID(),
      fetcher: fetcher as unknown as typeof fetch,
      resolveWebhookHost
    }
  );
  expect(capturedBody?.embeds).toHaveLength(1);
  return capturedBody.embeds[0];
}

describe("run_failed notification body — broker rejection reason surfacing", () => {
  it("prefers payload.reason over the (duplicated) title", async () => {
    const body = await directBody("run_failed", "BAC order rejected by broker", { reason: "Broker declined: insufficient buying power." });
    expect(body).toBe("Broker declined: insufficient buying power.");
  });

  it("prefers payload.error when reason is absent", async () => {
    const body = await directBody("run_failed", "BAC order placement uncertain — verify with broker", { error: "Broker request timed out after 30s." });
    expect(body).toBe("Broker request timed out after 30s.");
  });

  it("prefers payload.summary over reason/error when present", async () => {
    const body = await directBody("run_failed", "Strategy run failed", {
      summary: "Model config invalid: unknown provider 'foo'.",
      reason: "should not win",
      error: "should not win either"
    });
    expect(body).toBe("Model config invalid: unknown provider 'foo'.");
  });

  it("falls back to the title only when summary, reason, and error are all absent", async () => {
    const body = await directBody("run_failed", "BAC order declined by broker (rejected)", { runId: "run-1", orderId: "o-1", state: "rejected" });
    expect(body).toBe("BAC order declined by broker (rejected)");
  });

  it("mirrors the same fallback chain in the Discord embed description", async () => {
    const embed = await discordEmbed("run_failed", "BAC order rejected by broker", { reason: "Broker declined: pattern day trader restriction." });
    expect(embed.description).toBe("Broker declined: pattern day trader restriction.");
  });

  it("Discord embed falls back to the generic message (not the raw title) when nothing is present", async () => {
    const embed = await discordEmbed("run_failed", "BAC order declined by broker (rejected)", { runId: "run-1" });
    expect(embed.description).toBe("Strategy run failed.");
  });
});

describe("kill_switch notification body — shares the run_failed fallback chain", () => {
  it("renders payload.summary when present (scheduled-halt emitter)", async () => {
    const body = await directBody("kill_switch", "Kill switch blocked strategy run", { summary: "Daily loss limit breached: -3.2% vs -3.0% cap." });
    expect(body).toBe("Daily loss limit breached: -3.2% vs -3.0% cap.");
  });

  it("renders payload.reason for the circuit-breaker/volatility-brake halts (which carry no summary)", async () => {
    // Mirrors strategy.ts's breaker halt payload shape: { runId, reason, equity, revertedTo }.
    const body = await directBody(
      "kill_switch",
      "Circuit breaker HALTED autonomous trading (manual re-arm required)",
      { runId: "run-1", reason: "Drawdown -8.4% from high-water mark exceeded the 8% circuit breaker.", equity: 91234, revertedTo: "halted" }
    );
    expect(body).toBe("Drawdown -8.4% from high-water mark exceeded the 8% circuit breaker.");
  });

  it("Discord embed falls back to payload.reason for reason-only kill_switch alerts", async () => {
    const embed = await discordEmbed(
      "kill_switch",
      "Volatility brake halted new entries",
      { runId: "run-2", reason: "VIX 41.2 above the 35 volatility brake threshold." }
    );
    expect(embed.description).toBe("VIX 41.2 above the 35 volatility brake threshold.");
  });
});

describe("fill notification body — pending_reconciliation placeholder guard", () => {
  it("renders an intent-truthful body for a placeholder receipt (qty 0, price 0, notional 0)", async () => {
    const body = await directBody("fill", "JPM live order pending_new", {
      fill: { symbol: "JPM", side: "buy", status: "pending_reconciliation", quantity: 0, price: 0, notional: 0 }
    });
    expect(body).toBe("BUY JPM — order accepted by broker; fill not yet confirmed");
    expect(body).not.toContain("$0.00");
    expect(body).not.toContain(" 0 ");
  });

  it("includes an estimated notional only when a real estimate is available on fill.raw", async () => {
    const body = await directBody("fill", "JPM live order pending_new", {
      fill: {
        symbol: "JPM",
        side: "buy",
        status: "pending_reconciliation",
        quantity: 0,
        price: 0,
        notional: 0,
        raw: { review: { estimatedNotional: 1234.56 } }
      }
    });
    expect(body).toBe("BUY JPM — order accepted by broker; fill not yet confirmed (~$1234.56 est.)");
  });

  it("falls back to the proposal's dollarAmount for the estimate when review.estimatedNotional is absent", async () => {
    const body = await directBody("fill", "JPM live order pending_new", {
      fill: {
        symbol: "JPM",
        side: "buy",
        status: "pending_reconciliation",
        quantity: 0,
        price: 0,
        notional: 0,
        raw: { proposal: { dollarAmount: 500 } }
      }
    });
    expect(body).toBe("BUY JPM — order accepted by broker; fill not yet confirmed (~$500.00 est.)");
  });

  it("renders a real confirmed fill normally (unaffected by the placeholder guard)", async () => {
    const body = await directBody("fill", "JPM live order filled", {
      fill: { symbol: "JPM", side: "buy", status: "filled", quantity: 10, price: 50, notional: 500 }
    });
    expect(body).toBe("BUY 10 JPM filled ($500.00)");
  });

  it("renders a partial fill normally", async () => {
    const body = await directBody("fill", "JPM live order partially_filled", {
      fill: { symbol: "JPM", side: "buy", status: "partially_filled", quantity: 5, price: 50, notional: 250 }
    });
    expect(body).toBe("BUY 5 JPM partially_filled ($250.00)");
  });

  it("does not misclassify a genuinely zero-priced CONFIRMED fill as a placeholder", async () => {
    // status "filled" (not pending_reconciliation) with a real $0 price must still render as a
    // confirmed fill — the guard keys off status, not just quantity/price being zero.
    const body = await directBody("fill", "JPM live order filled", {
      fill: { symbol: "JPM", side: "buy", status: "filled", quantity: 0, price: 0, notional: 0 }
    });
    expect(body).toBe("BUY 0 JPM filled ($0.00)");
  });

  it("mirrors the placeholder guard in the Discord embed fields", async () => {
    const embed = await discordEmbed("fill", "JPM live order pending_new", {
      fill: {
        symbol: "JPM",
        side: "buy",
        status: "pending_reconciliation",
        quantity: 0,
        price: 0,
        notional: 0,
        raw: { review: { estimatedNotional: 1234.56 } }
      }
    });
    expect(embed.fields).toContainEqual({ name: "Status", value: "Order accepted by broker; fill not yet confirmed", inline: true });
    expect(embed.fields).toContainEqual({ name: "Notional", value: "~$1234.56 est.", inline: true });
    expect(embed.fields).not.toContainEqual(expect.objectContaining({ name: "Price" }));
  });

  it("Discord embed still shows real Price/Notional fields for a confirmed fill", async () => {
    const embed = await discordEmbed("fill", "JPM live order filled", {
      fill: { symbol: "JPM", side: "buy", status: "filled", quantity: 2, price: 200, notional: 400 }
    });
    expect(embed.fields).toContainEqual({ name: "Price", value: "$200.00", inline: true });
    expect(embed.fields).toContainEqual({ name: "Notional", value: "$400.00", inline: true });
  });
});

// risk_advisory is emitted by both agent-originated advisories (e.g. the drawdown breaker in
// advisory mode) AND owner-initiated actions (e.g. a manual order cancel that would leave dust
// below the broker minimum — app/api/orders/cancel). The shared tail must read honestly for
// both instead of claiming "the agent is still in control" when the owner acted directly.
describe("risk_advisory notification body — neutral advisory tail", () => {
  it("ends with 'nothing was blocked or changed' for an agent-originated drawdown advisory", async () => {
    const body = await directBody("risk_advisory", "Accuracy breaker degraded (advisory)", {
      reason: "Hit rate 28% over the last 12 closed trades (floor 40%).",
      drawdownPct: 4.25,
      equity: 96100,
      highWaterMark: 100400
    });
    expect(body).toContain("Hit rate 28% over the last 12 closed trades (floor 40%).");
    expect(body).toContain("Drawdown: 4.25% from the equity high-water mark");
    expect(body.endsWith("Advisory only — nothing was blocked or changed.")).toBe(true);
    expect(body).not.toContain("the agent is still in control");
  });

  it("uses the same tail for an owner-initiated cancel-dust advisory", async () => {
    const body = await directBody("risk_advisory", "Cancel would leave unplaceable dust", {
      reason: "Canceling this working order would leave 0.4 shares below the broker minimum."
    });
    expect(body).toBe(
      "Canceling this working order would leave 0.4 shares below the broker minimum.\nAdvisory only — nothing was blocked or changed."
    );
    expect(body).not.toContain("the agent is still in control");
  });

  it("Discord fallback copy uses the same neutral tail when no reason is supplied", async () => {
    const embed = await discordEmbed("risk_advisory", "Accuracy breaker degraded (advisory)", {});
    expect(embed.description).toBe(
      "A risk guardrail threshold was breached (advisory — nothing was blocked or changed)."
    );
    expect(embed.description).not.toContain("the agent is still in control");
  });
});
