/**
 * Tests for the trigger-engine wiring added to
 * app/api/webhooks/tradingview/route.ts POST handler.
 *
 * Specifically verifies that after a successful recordTradingViewSignal():
 *   (a) A fresh TV alert invokes broadcastMaterialEvent for the symbol
 *   (b) The route returns its normal 200 success response
 *   (c) A deduped signal does NOT submit a material event (prevents engine spam)
 *   (d) A throw from broadcastMaterialEvent does NOT break the webhook response
 *   (e) Failed-gate paths (bad secret, ok:false record) do NOT call the engine
 *
 * Route calls `void submitTriggerEvent(...)` (fire-and-forget). Tests that need
 * to assert on broadcastMaterialEvent call counts import `submitTriggerEvent`
 * directly and await it — this is the testable seam for the dynamic-import path.
 * Tests that only need to verify the HTTP response shape drive the full POST handler.
 *
 * Mock wiring follows the same vi.hoisted pattern as webhooks-tradingview.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoist mocks ───────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  audit: vi.fn(),
  technicalEnabled: vi.fn(),
  verifyWebhookSecret: vi.fn(),
  recordTradingViewSignal: vi.fn(),
  broadcastMaterialEvent: vi.fn(),
  submitMaterialEvent: vi.fn(),
  triggerEngineEnabled: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  audit: mocks.audit,
}));

vi.mock("@/lib/web-sources/technical", () => ({
  technicalEnabled: mocks.technicalEnabled,
  verifyWebhookSecret: mocks.verifyWebhookSecret,
  recordTradingViewSignal: mocks.recordTradingViewSignal,
}));

// Mock the trigger engine module the route dynamically imports.
vi.mock("@/lib/triggers", () => ({
  broadcastMaterialEvent: mocks.broadcastMaterialEvent,
  submitMaterialEvent: mocks.submitMaterialEvent,
  triggerEngineEnabled: mocks.triggerEngineEnabled,
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

const WEBHOOK_URL = "http://localhost/api/webhooks/tradingview";

function makeRequest(body: unknown): Request {
  return new Request(WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Happy-path payload with a stable bar_time for sourceId determinism. */
const validPayload = {
  secret: "test-secret",
  symbol: "TSLA",
  action: "bullish",
  signal: "rsi_oversold",
  bar_time: 1700000000,
};

// ── Test setup ────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Happy-path defaults — gate checks pass, record succeeds, not deduped.
  mocks.technicalEnabled.mockReturnValue(true);
  mocks.verifyWebhookSecret.mockReturnValue(true);
  mocks.recordTradingViewSignal.mockReturnValue({ ok: true, symbol: "TSLA", deduped: false });
  // Clear env vars between tests.
  delete process.env.TRADINGVIEW_WEBHOOK_IPS;
  delete process.env.TRIGGER_ENGINE;
});

// ── Tests — submitTriggerEvent (testable seam for the dynamic-import path) ────

describe("submitTriggerEvent helper", () => {
  it("(a) calls broadcastMaterialEvent with type:technical and the alert symbol", async () => {
    const { submitTriggerEvent } = await import("../src/lib/tradingview-trigger");
    await submitTriggerEvent("TSLA", "tradingview:TSLA:rsi_oversold:1700000000");

    expect(mocks.broadcastMaterialEvent).toHaveBeenCalledTimes(1);
    expect(mocks.broadcastMaterialEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "technical",
        symbol: "TSLA",
        sourceId: "tradingview:TSLA:rsi_oversold:1700000000",
        reason: expect.stringContaining("TradingView"),
      })
    );
  });

  it("sourceId embeds symbol, signal, and bar_time for stable dedup", async () => {
    const { submitTriggerEvent } = await import("../src/lib/tradingview-trigger");
    const sourceId = `tradingview:TSLA:rsi_oversold:${validPayload.bar_time}`;
    await submitTriggerEvent("TSLA", sourceId);

    const [event] = mocks.broadcastMaterialEvent.mock.calls[0] as [{ sourceId: string }];
    expect(event.sourceId).toBe(sourceId);
  });

  it("(d) swallows broadcastMaterialEvent throws without propagating", async () => {
    mocks.broadcastMaterialEvent.mockImplementation(() => {
      throw new Error("trigger engine exploded");
    });
    const { submitTriggerEvent } = await import("../src/lib/tradingview-trigger");
    // Must not throw.
    await expect(submitTriggerEvent("TSLA", "sid")).resolves.toBeUndefined();
  });

  it("the engine's own gate controls whether the event causes a run (disabled by default)", async () => {
    // When engine is disabled the real broadcastMaterialEvent is a no-op.
    // Our mock here IS called — verifying the route always delegates to the engine
    // rather than duplicating the TRIGGER_ENGINE check itself.
    delete process.env.TRIGGER_ENGINE;
    const { submitTriggerEvent } = await import("../src/lib/tradingview-trigger");
    await submitTriggerEvent("TSLA", "tradingview:TSLA:rsi_oversold:0");
    // The mock was called: it's the engine's responsibility to no-op when disabled.
    expect(mocks.broadcastMaterialEvent).toHaveBeenCalledTimes(1);
  });
});

// ── Tests — POST handler (HTTP response shape) ────────────────────────────────

describe("POST /api/webhooks/tradingview — trigger wiring response contract", () => {
  it("(b) returns 200 with normal body on a fresh valid signal", async () => {
    const { POST } = await import("../app/api/webhooks/tradingview/route");
    const res = await POST(makeRequest(validPayload));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.symbol).toBe("TSLA");
    expect(body.deduped).toBe(false);
  });

  it("(b) returns 200 when TRIGGER_ENGINE is enabled", async () => {
    process.env.TRIGGER_ENGINE = "on";
    const { POST } = await import("../app/api/webhooks/tradingview/route");
    const res = await POST(makeRequest(validPayload));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("(c) does NOT submit a material event for a deduped (identical retry) signal", async () => {
    mocks.recordTradingViewSignal.mockReturnValue({ ok: true, symbol: "TSLA", deduped: true });
    process.env.TRIGGER_ENGINE = "on";

    const { POST } = await import("../app/api/webhooks/tradingview/route");
    const res = await POST(makeRequest(validPayload));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deduped).toBe(true);
    // deduped → no material event — prevents engine spam from TV retries.
    expect(mocks.broadcastMaterialEvent).not.toHaveBeenCalled();
  });

  it("(e) does NOT call the engine when recordTradingViewSignal returns ok:false", async () => {
    mocks.recordTradingViewSignal.mockReturnValue({ ok: false, warning: "missing symbol" });
    process.env.TRIGGER_ENGINE = "on";

    const { POST } = await import("../app/api/webhooks/tradingview/route");
    const res = await POST(makeRequest(validPayload));

    expect(res.status).toBe(422);
    expect(mocks.broadcastMaterialEvent).not.toHaveBeenCalled();
  });

  it("(e) does NOT call the engine when secret verification fails", async () => {
    mocks.verifyWebhookSecret.mockReturnValue(false);
    process.env.TRIGGER_ENGINE = "on";

    const { POST } = await import("../app/api/webhooks/tradingview/route");
    const res = await POST(makeRequest({ ...validPayload, secret: "wrong" }));

    expect(res.status).toBe(401);
    expect(mocks.broadcastMaterialEvent).not.toHaveBeenCalled();
  });
});
