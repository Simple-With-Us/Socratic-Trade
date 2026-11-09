import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  applySseMessage,
  CONGRESS_SSE_FLAP_CAP,
  CONGRESS_SSE_INITIAL_BACKOFF_MS,
  CONGRESS_SSE_MAX_BACKOFF_MS,
  CONGRESS_SSE_MIN_HEALTHY_MS,
  connectOnce,
  nextCongressSseBackoff,
  resetCongressStreamStateForTests,
  resolveSubscription,
  toCongressEventEnvelope,
} from "../src/lib/congress-stream";
import { getCongressDataset } from "../src/lib/web-sources";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-congress-stream-${randomUUID()}.db`)}`;
});

const recent = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);

describe("applySseMessage", () => {
  it("returns false on unparseable data", () => {
    expect(applySseMessage({ data: "{not json" })).toBe(false);
    expect(applySseMessage({ data: "" })).toBe(false);
  });

  it("applies a valid envelope, merging the SSE event/id into the envelope", () => {
    // ref.upsert is an informational no-op (no DB write) but still a valid applied event.
    expect(applySseMessage({ event: "ref.upsert", id: `e-${randomUUID()}`, data: JSON.stringify({ data: { ticker: "AAPL" } }) })).toBe(true);
  });

  it("recognizes App A control frames (cursor/ping/reconnect/error) instead of warning per heartbeat", () => {
    // These carry a bare number or a small object as `data` and must NOT be treated as trades or
    // logged as "dropped unparseable" (the pre-fix behavior on every 5s ping/cursor).
    expect(applySseMessage({ event: "cursor", data: "0" })).toBe(true);
    expect(applySseMessage({ event: "ping", data: String(Date.now()) })).toBe(true);
    expect(applySseMessage({ event: "reconnect", data: JSON.stringify({ since: 42 }) })).toBe(true);
    expect(applySseMessage({ event: "error", data: JSON.stringify({ message: "boom" }) })).toBe(true);
  });

  it("maps App A's raw trade.new Transaction into a congress.trade envelope", () => {
    const tx = { id: "tx-1", ticker: "AAPL", memberName: "Jane Doe", chamber: "house", txType: "P", txDate: recent(5), filedDate: recent(2) };
    const env = toCongressEventEnvelope(tx, { event: "trade.new", id: "42", data: "" });
    expect(env).toMatchObject({ type: "congress.trade", id: "tx-1" });
    expect((env!.data as { transaction: unknown }).transaction).toMatchObject({ ticker: "AAPL" });
  });
});

describe("resolveSubscription", () => {
  afterEach(() => {
    delete process.env.CONGRESS_STREAM_SUBSCRIPTION_ID;
    delete process.env.CONGRESS_STREAM_SUBSCRIPTION_TOKEN;
    delete process.env.CONGRESS_STREAM_AUTO_SUBSCRIBE;
  });

  it("returns the operator-provisioned env subscription id+token", async () => {
    process.env.CONGRESS_STREAM_SUBSCRIPTION_ID = "sub_env";
    process.env.CONGRESS_STREAM_SUBSCRIPTION_TOKEN = "env-tok";
    await expect(resolveSubscription()).resolves.toEqual({ id: "sub_env", secret: "env-tok" });
  });

  it("returns null when nothing is configured and auto-subscribe is off (inert)", async () => {
    await expect(resolveSubscription()).resolves.toBeNull();
  });
});

describe("nextCongressSseBackoff — flap policy (#2550)", () => {
  it("does not reset backoff on a short-lived 200 (flap)", () => {
    const out = nextCongressSseBackoff({
      previousBackoffMs: CONGRESS_SSE_INITIAL_BACKOFF_MS,
      livedMs: 800,
      flapsInWindow: 0,
    });
    expect(out.resetHealthy).toBe(false);
    expect(out.softFlap).toBe(true);
    expect(out.backoffMs).toBe(CONGRESS_SSE_INITIAL_BACKOFF_MS * 2);
    expect(out.flapsInWindow).toBe(1);
  });

  it("resets backoff only after a connection lived the healthy minimum", () => {
    const out = nextCongressSseBackoff({
      previousBackoffMs: 60_000,
      livedMs: CONGRESS_SSE_MIN_HEALTHY_MS,
      flapsInWindow: 3,
    });
    expect(out.resetHealthy).toBe(true);
    expect(out.softFlap).toBe(false);
    expect(out.backoffMs).toBe(CONGRESS_SSE_INITIAL_BACKOFF_MS);
    expect(out.flapsInWindow).toBe(0);
  });

  it("five soft SSE flaps do not hard-STOP the lane", async () => {
    const { logApiHealth, getLaneHealth, HEALTH_REASON_CONSECUTIVE_FAILURES } = await import("../src/lib/db-health");
    for (let i = 0; i < 5; i += 1) {
      logApiHealth({
        service: "congress.trade:sse",
        ok: false,
        errorText: "SSE flap (short-lived connection)",
        soft: true,
      });
    }
    const lane = getLaneHealth("congress.trade:sse", null);
    expect(lane.reason).not.toBe(HEALTH_REASON_CONSECUTIVE_FAILURES);
  });

  it("caps reconnect storms at the 5-minute max after five flaps", () => {
    const out = nextCongressSseBackoff({
      previousBackoffMs: 16_000,
      livedMs: 400,
      flapsInWindow: CONGRESS_SSE_FLAP_CAP - 1,
    });
    expect(out.backoffMs).toBe(CONGRESS_SSE_MAX_BACKOFF_MS);
    expect(out.flapsInWindow).toBe(CONGRESS_SSE_FLAP_CAP);
    expect(out.softFlap).toBe(true);
  });
});

describe("connectOnce — App A subscription-model SSE (stubbed stream)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.CONGRESS_STREAM_SUBSCRIPTION_ID;
    delete process.env.CONGRESS_STREAM_SUBSCRIPTION_TOKEN;
    resetCongressStreamStateForTests();
  });

  it("connects with ?subscription= + Bearer secret and ingests a pushed trade.new event end-to-end", async () => {
    process.env.CONGRESS_STREAM_SUBSCRIPTION_ID = "sub_test";
    process.env.CONGRESS_STREAM_SUBSCRIPTION_TOKEN = "strm-tok";

    const tx = { id: `tx-${randomUUID()}`, ticker: "PLTR", memberName: "Stream Tester", chamber: "house", txType: "P", txDate: recent(5), filedDate: recent(2) };
    const frame = `id: 99\nevent: trade.new\ndata: ${JSON.stringify(tx)}\n\n`;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(frame));
        c.close(); // one-shot: reader hits `done`, connectOnce returns
      },
    });

    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    vi.stubGlobal("fetch", fetchSpy);

    await connectOnce();

    // The connection honors App A's live contract: subscription in the query, secret as Bearer.
    expect(capturedUrl).toContain("/api/stream");
    expect(capturedUrl).toContain("subscription=sub_test");
    expect((capturedInit?.headers as Record<string, string>)?.authorization).toBe("Bearer strm-tok");

    // …and the pushed raw Transaction was mapped + ingested into App B's congress dataset.
    expect((getCongressDataset()?.trades ?? []).some((t) => t.symbol === "PLTR")).toBe(true);
  });
});
