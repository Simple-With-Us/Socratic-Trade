/**
 * Unit tests for app/api/webhooks/tradingview/route.ts POST handler.
 *
 * Drives the handler directly with `new Request(...)` — no HTTP server needed.
 * Mocks the three module boundaries the route depends on:
 *   • @/lib/db                     → audit()
 *   • @/lib/web-sources/technical  → technicalEnabled(), verifyWebhookSecret(), recordTradingViewSignal()
 *
 * Paper-mode safe: route places no orders and mutates no brokerage state.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoist mocks so vi.mock() factory sees them ────────────────────────────────
// Use vi.fn() without an initial return value to avoid TypeScript inferring an
// overly narrow return type from the factory default — the specific return values
// are set in beforeEach and per-test via mockReturnValue / mockImplementation.
const mocks = vi.hoisted(() => ({
  audit: vi.fn(),
  technicalEnabled: vi.fn(),
  verifyWebhookSecret: vi.fn(),
  recordTradingViewSignal: vi.fn()
}));

vi.mock("@/lib/db", () => ({
  audit: mocks.audit
}));

vi.mock("@/lib/web-sources/technical", () => ({
  technicalEnabled: mocks.technicalEnabled,
  verifyWebhookSecret: mocks.verifyWebhookSecret,
  recordTradingViewSignal: mocks.recordTradingViewSignal
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

const WEBHOOK_URL = "http://localhost/api/webhooks/tradingview";

/** Build a minimal POST request with the given body and optional extra headers. */
function makeRequest(body: unknown, extraHeaders: Record<string, string> = {}): Request {
  return new Request(WEBHOOK_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...extraHeaders
    },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
}

/** Happy-path payload */
const validPayload = { secret: "test-secret", symbol: "AAPL", action: "bullish", signal: "sma_cross", bar_time: Date.now() };

// ── Test setup ────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Reset to happy-path defaults.
  mocks.technicalEnabled.mockReturnValue(true);
  mocks.verifyWebhookSecret.mockReturnValue(true);
  mocks.recordTradingViewSignal.mockReturnValue({ ok: true, symbol: "AAPL", deduped: false });
  // Clear env vars that affect IP allowlist behaviour.
  delete process.env.TRADINGVIEW_WEBHOOK_IPS;
  delete process.env.TRADINGVIEW_WEBHOOK_SECRET;
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /api/webhooks/tradingview", () => {
  it("returns 404 when technical source is disabled", async () => {
    const { POST } = await import("../app/api/webhooks/tradingview/route");
    mocks.technicalEnabled.mockReturnValue(false);

    const res = await POST(makeRequest(validPayload));

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("returns 403 and audits ip rejection when IP is not in the allowlist", async () => {
    const { POST } = await import("../app/api/webhooks/tradingview/route");
    process.env.TRADINGVIEW_WEBHOOK_IPS = "1.2.3.4";

    const res = await POST(makeRequest(validPayload, { "x-forwarded-for": "9.9.9.9" }));

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(mocks.audit).toHaveBeenCalledWith(
      "tradingview_webhook_rejected",
      expect.objectContaining({ reason: "ip" })
    );
  });

  it("passes the IP check when no allowlist is configured", async () => {
    const { POST } = await import("../app/api/webhooks/tradingview/route");
    // No TRADINGVIEW_WEBHOOK_IPS set → allowlist disabled → any IP is allowed.
    const res = await POST(makeRequest(validPayload));
    expect(res.status).toBe(200);
    expect(mocks.audit).not.toHaveBeenCalledWith("tradingview_webhook_rejected", expect.anything());
  });

  it("returns 400 on malformed JSON body", async () => {
    const { POST } = await import("../app/api/webhooks/tradingview/route");

    const res = await POST(makeRequest("this is { not json", { "content-type": "text/plain" }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    // Bad JSON must never reach the secret check.
    expect(mocks.verifyWebhookSecret).not.toHaveBeenCalled();
  });

  // ITEM 13 (bounded body): this route previously had NO byte cap at all, unlike the congress
  // webhook (which at least checked a declared content-length). A single Pine alert() payload
  // is always tiny, so an oversized body is always rejected — see src/lib/bounded-body.ts.
  it("returns 413 and never reaches the secret check for an oversized body", async () => {
    const { POST } = await import("../app/api/webhooks/tradingview/route");

    const oversized = JSON.stringify({ ...validPayload, padding: "a".repeat(2 * 1024 * 1024) });
    const res = await POST(makeRequest(oversized, { "content-type": "application/json" }));

    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(mocks.verifyWebhookSecret).not.toHaveBeenCalled();
  });

  it("accepts a normal-sized payload comfortably under the byte cap", async () => {
    const { POST } = await import("../app/api/webhooks/tradingview/route");
    const res = await POST(makeRequest(validPayload));
    expect(res.status).toBe(200);
  });

  it("returns 401 and audits secret rejection when secret does not match", async () => {
    const { POST } = await import("../app/api/webhooks/tradingview/route");
    mocks.verifyWebhookSecret.mockReturnValue(false);

    const res = await POST(makeRequest({ ...validPayload, secret: "wrong-secret" }));

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(mocks.audit).toHaveBeenCalledWith(
      "tradingview_webhook_rejected",
      expect.objectContaining({ reason: "secret" })
    );
  });

  it("returns 422 when recordTradingViewSignal reports ok:false", async () => {
    const { POST } = await import("../app/api/webhooks/tradingview/route");
    mocks.recordTradingViewSignal.mockReturnValue({ ok: false, warning: "missing symbol" });

    const res = await POST(makeRequest(validPayload));

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe("missing symbol");
  });

  it("returns 500 and audits the error when recordTradingViewSignal throws", async () => {
    const { POST } = await import("../app/api/webhooks/tradingview/route");
    mocks.recordTradingViewSignal.mockImplementation(() => { throw new Error("db exploded"); });

    const res = await POST(makeRequest(validPayload));

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(mocks.audit).toHaveBeenCalledWith(
      "tradingview_webhook_error",
      expect.objectContaining({ error: "db exploded" })
    );
  });

  it("returns 200 with symbol and deduped:false on the happy path", async () => {
    const { POST } = await import("../app/api/webhooks/tradingview/route");
    mocks.recordTradingViewSignal.mockReturnValue({ ok: true, symbol: "AAPL", deduped: false });

    const res = await POST(makeRequest(validPayload));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.symbol).toBe("AAPL");
    expect(body.deduped).toBe(false);
  });

  it("returns 200 with deduped:true when the signal is an identical retry", async () => {
    const { POST } = await import("../app/api/webhooks/tradingview/route");
    mocks.recordTradingViewSignal.mockReturnValue({ ok: true, symbol: "AAPL", deduped: true });

    const res = await POST(makeRequest(validPayload));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deduped).toBe(true);
  });
});
