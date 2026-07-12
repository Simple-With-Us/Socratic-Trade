import { describe, expect, it, beforeEach, afterEach, afterAll } from "vitest";
import { existsSync, mkdirSync, unlinkSync } from "fs";
import path from "path";
import os from "os";

// Isolated temp SQLite (logApiHealth writes to the DB on flush).
const tmpDir = path.join(os.tmpdir(), `trading-test-usage-push-${Date.now()}`);
const tmpDbPath = path.join(tmpDir, "test.db");
if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
process.env.DATABASE_URL = `file:${tmpDbPath}`;

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { unlinkSync(`${tmpDbPath}${suffix}`); } catch { /* best-effort */ }
  }
});

const push = await import("../src/lib/usage-monitor-push");
const { recordLlmUsage } = await import("../src/lib/llm-usage");

const BASE = "https://usage.example.test";
const TOKEN = "test-token";

interface CapturedRequest {
  url: string;
  auth: string | null;
  body: { events: Array<Record<string, unknown>> };
}

function makeFetchStub(captured: CapturedRequest[], opts: { throwErr?: boolean; status?: number } = {}) {
  return (async (url: unknown, init?: RequestInit) => {
    if (opts.throwErr) throw new Error("network down");
    const headers = init?.headers as Record<string, string> | undefined;
    captured.push({
      url: String(url),
      auth: headers?.authorization ?? headers?.Authorization ?? null,
      body: JSON.parse(String(init?.body ?? "{}")),
    });
    const status = opts.status ?? 202;
    return new Response(JSON.stringify({ ok: true, accepted: 1 }), { status });
  }) as unknown as typeof fetch;
}

describe("usage-monitor-push", () => {
  beforeEach(() => {
    push.__resetUsageMonitorState();
    process.env.USAGE_MONITOR_BASE_URL = BASE;
    process.env.USAGE_INGEST_TOKEN = TOKEN;
    process.env.USAGE_MONITOR_ENV = "test";
  });
  afterEach(() => {
    push.__resetUsageMonitorState();
    delete process.env.USAGE_MONITOR_BASE_URL;
    delete process.env.USAGE_INGEST_TOKEN;
    delete process.env.USAGE_MONITOR_ENV;
  });

  it("is a no-op when unconfigured (no network calls)", async () => {
    delete process.env.USAGE_MONITOR_BASE_URL;
    delete process.env.USAGE_INGEST_TOKEN;
    const captured: CapturedRequest[] = [];
    push.__setUsageMonitorFetch(makeFetchStub(captured));
    push.pushLlmUsage({ provider: "openai", userId: "local", keySource: "operator", totalTokens: 100, costUsd: 0.01 });
    push.recordProviderCall("finnhub", { ok: true });
    await push.flushUsageMonitor();
    expect(captured).toHaveLength(0);
  });

  it("pushes an LLM cost event as a schema-valid batch with bearer auth", async () => {
    const captured: CapturedRequest[] = [];
    push.__setUsageMonitorFetch(makeFetchStub(captured));
    push.pushLlmUsage({
      provider: "anthropic",
      model: "claude-opus-4-8",
      context: "strategy",
      userId: "local",
      keySource: "operator",
      keyRef: "abcd",
      promptTokens: 800,
      completionTokens: 200,
      totalTokens: 1000,
      costUsd: 0.03,
    });
    await push.flushUsageMonitor();

    expect(captured).toHaveLength(1);
    expect(captured[0]!.url).toBe(`${BASE}/api/ingest/usage`);
    expect(captured[0]!.auth).toBe(`Bearer ${TOKEN}`);
    const events = captured[0]!.body.events;
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.sourceApp).toBe("socratic-trade");
    expect(e.environment).toBe("test");
    expect(e.provider).toBe("anthropic");
    expect(e.service).toBe("llm");
    expect(e.metricType).toBe("cost");
    expect(e.unit).toBe("token");
    expect(e.quantity).toBe(1000);
    expect(e.costUsd).toBe(0.03);
    expect(e.requests).toBe(1);
    expect(typeof e.occurredAt).toBe("string");
    expect((e.metadata as Record<string, unknown>).model).toBe("claude-opus-4-8");
  });

  it("pushes a RAG event and aggregates market-data call-volume in one flush", async () => {
    const captured: CapturedRequest[] = [];
    push.__setUsageMonitorFetch(makeFetchStub(captured));
    push.pushRagUsage({ provider: "voyage", operation: "embed", model: "voyage-finance-2", userId: "local", tokensIn: 120, costUsd: 0.00001 });
    push.recordProviderCall("finnhub", { ok: true });
    push.recordProviderCall("finnhub", { ok: true });
    push.recordProviderCall("finnhub", { ok: false });
    await push.flushUsageMonitor();

    expect(captured).toHaveLength(1);
    const events = captured[0]!.body.events;
    const rag = events.find((e) => e.service === "rag");
    expect(rag).toBeDefined();
    expect(rag!.provider).toBe("voyage");
    expect(rag!.unit).toBe("token");

    const vol = events.find((e) => e.provider === "finnhub");
    expect(vol).toBeDefined();
    expect(vol!.metricType).toBe("usage");
    expect(vol!.unit).toBe("request");
    expect(vol!.requests).toBe(3);
    expect((vol!.metadata as Record<string, unknown>).successes).toBe(2);
    expect((vol!.metadata as Record<string, unknown>).failures).toBe(1);
  });

  it("tags Pinecone RAG volume as credits and scopes call-volume by key lane", async () => {
    const captured: CapturedRequest[] = [];
    push.__setUsageMonitorFetch(makeFetchStub(captured));
    push.pushRagUsage({ provider: "pinecone", operation: "query", userId: "local", tokensIn: 7, tokensOut: 5 });
    push.recordProviderCall("finnhub", { ok: true, keySource: "user", userId: "u_abc" });
    push.recordProviderCall("finnhub", { ok: true, keySource: "operator" });
    await push.flushUsageMonitor();

    const events = captured[0]!.body.events;
    const pine = events.find((e) => e.provider === "pinecone");
    expect(pine!.unit).toBe("credit");
    expect(pine!.quantity).toBe(7);
    expect((pine!.metadata as Record<string, unknown>).recordCount).toBe(5);

    // Two different credential lanes → two separate finnhub events, not one merged count.
    const finnhub = events.filter((e) => e.provider === "finnhub");
    expect(finnhub).toHaveLength(2);
    const userLane = finnhub.find((e) => (e.metadata as Record<string, unknown>).keySource === "user");
    expect(userLane).toBeDefined();
    expect((userLane!.metadata as Record<string, unknown>).userId).toBe("u_abc");
  });

  it("flush swallows push failures and recordLlmUsage still records + never throws", async () => {
    const captured: CapturedRequest[] = [];
    push.__setUsageMonitorFetch(makeFetchStub(captured, { throwErr: true }));
    expect(() =>
      recordLlmUsage({ provider: "openai", model: "gpt-4o-mini", context: "chat", userId: "local", keySource: "operator", promptTokens: 10, completionTokens: 5 })
    ).not.toThrow();
    await expect(push.flushUsageMonitor()).resolves.toBeUndefined();
    const { getLlmUsageSummary } = await import("../src/lib/llm-usage");
    expect(getLlmUsageSummary().length).toBeGreaterThan(0);
  });
});
