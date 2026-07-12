import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  SseParser,
  applySseMessage,
  connectOnce,
  resolveSubscription,
  toCongressEventEnvelope,
} from "../src/lib/congress-stream";
import { getCongressDataset } from "../src/lib/web-sources";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-congress-stream-${randomUUID()}.db`)}`;
});

const recent = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);

describe("SseParser", () => {
  it("parses a complete event with event/id/data fields", () => {
    const msgs = new SseParser().push("event: congress.trade\nid: e1\ndata: {\"a\":1}\n\n");
    expect(msgs).toEqual([{ event: "congress.trade", id: "e1", data: '{"a":1}' }]);
  });

  it("joins multi-line data and ignores comments/heartbeats", () => {
    const msgs = new SseParser().push(": heartbeat\ndata: line1\ndata: line2\n\n");
    expect(msgs).toEqual([{ event: undefined, id: undefined, data: "line1\nline2" }]);
  });

  it("handles events split across chunk boundaries", () => {
    const p = new SseParser();
    expect(p.push("data: {\"x\"")).toEqual([]); // incomplete — nothing dispatched yet
    expect(p.push(":5}\n\n")).toEqual([{ event: undefined, id: undefined, data: '{"x":5}' }]);
  });

  it("emits multiple events from one chunk and strips a single leading space after the colon", () => {
    const msgs = new SseParser().push("data:a\n\ndata: b\n\n");
    expect(msgs.map((m) => m.data)).toEqual(["a", "b"]);
  });
});

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
    await expect(resolveSubscription()).resolves.toEqual({ id: "sub_env", token: "env-tok" });
  });

  it("returns null when nothing is configured and auto-subscribe is off (inert)", async () => {
    await expect(resolveSubscription()).resolves.toBeNull();
  });
});

describe("connectOnce — App A subscription-model SSE (stubbed stream)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.CONGRESS_STREAM_SUBSCRIPTION_ID;
    delete process.env.CONGRESS_STREAM_SUBSCRIPTION_TOKEN;
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
