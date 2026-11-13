import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// ST-4543: the LLM push must carry everything the local ledger knows (cache reads/writes,
// reasoning, served model, latency, status, billed-vs-estimated) in the canonical `ai` block, send
// OpenRouter-billed spend as `actual`, and rebuild the IDENTICAL event on replay (the monitor 409s
// an idempotency key whose content changed).
const tmpDir = path.join(tmpdir(), `socratic-usage-ai-block-${randomUUID()}`);
const tmpDbPath = path.join(tmpDir, "test.db");
if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
process.env.DATABASE_URL = `file:${tmpDbPath}`;

const push = await import("../src/lib/usage-monitor-push");
const replay = await import("../src/lib/usage-monitor-replay");
const { getDb } = await import("../src/lib/db");
const { recordLlmUsage, extractLlmUsage } = await import("../src/lib/llm-usage");
const { addChatUsage, newChatUsageTotals } = await import("../src/lib/chat/llm");
const { UsageTelemetryV2EventSchema } = await import("@jaywedgeworth22/congress-trading-shared");

const BASE_URL = "https://usage.example.test";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Wire = Record<string, any>;

function ackStub(captured: Wire[]): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    captured.push(...body.events);
    return new Response(
      JSON.stringify({ ok: true, schemaVersion: 2, received: body.events.length, persisted: body.events.length, duplicates: 0, pruned: 0, rejected: 0 }),
      { status: 202 }
    );
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  push.__resetUsageMonitorState();
  replay.__resetUsageMonitorReplayState();
  process.env.USAGE_MONITOR_BASE_URL = BASE_URL;
  process.env.USAGE_INGEST_TOKEN = "test-credential";
  process.env.USAGE_MONITOR_ENV = "test";
  getDb().exec("DELETE FROM llm_usage; DELETE FROM rag_usage; DELETE FROM provider_usage_outbox; DELETE FROM provider_dispatch_attempts;");
  getDb().prepare("DELETE FROM settings WHERE key LIKE 'usage_monitor_replay:%'").run();
  const insertCutover = getDb().prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, 'v2-active', ?)");
  const now = new Date().toISOString();
  insertCutover.run(replay.USAGE_MONITOR_REPLAY_V2_CUTOVER_KEYS.llm, now);
  insertCutover.run(replay.USAGE_MONITOR_REPLAY_V2_CUTOVER_KEYS.rag, now);
  insertCutover.run(replay.USAGE_MONITOR_REPLAY_V2_CUTOVER_KEYS.provider, now);
});

afterEach(() => {
  push.__resetUsageMonitorState();
  replay.__resetUsageMonitorReplayState();
  delete process.env.USAGE_MONITOR_BASE_URL;
  delete process.env.USAGE_INGEST_TOKEN;
  delete process.env.USAGE_MONITOR_ENV;
  vi.restoreAllMocks();
});

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { unlinkSync(`${tmpDbPath}${suffix}`); } catch { /* best-effort */ }
  }
});

describe("extractLlmUsage: detail fields", () => {
  it("reads Anthropic native cache reads, writes with the 5m/1h split, and the served model", () => {
    const u = extractLlmUsage({
      model: "claude-sonnet-5-5-20261001",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 4000,
        cache_creation_input_tokens: 1000,
        cache_creation: { ephemeral_5m_input_tokens: 400, ephemeral_1h_input_tokens: 600 },
      },
    });
    expect(u).toMatchObject({
      promptTokens: 5100,
      completionTokens: 50,
      cachedPromptTokens: 4000,
      cacheCreationTokens: 1000,
      cacheCreation1hTokens: 600,
      servedModel: "claude-sonnet-5-5-20261001",
    });
  });

  it("reads OpenRouter / OpenAI-compatible cached, cache-write and reasoning tokens plus billed cost", () => {
    const u = extractLlmUsage({
      model: "anthropic/claude-sonnet-5.5",
      usage: {
        prompt_tokens: 3000,
        completion_tokens: 800,
        prompt_tokens_details: { cached_tokens: 2000, cache_write_tokens: 500 },
        completion_tokens_details: { reasoning_tokens: 300 },
        cost: 0.0123,
      },
    });
    expect(u).toMatchObject({
      promptTokens: 3000,
      cachedPromptTokens: 2000,
      cacheCreationTokens: 500,
      reasoningTokens: 300,
      billedCostUsd: 0.0123,
      servedModel: "anthropic/claude-sonnet-5.5",
    });
  });

  it("omits every detail field a response does not carry", () => {
    const u = extractLlmUsage({ usage: { prompt_tokens: 10, completion_tokens: 5 } });
    expect(u).not.toHaveProperty("cachedPromptTokens");
    expect(u).not.toHaveProperty("reasoningTokens");
    expect(u).not.toHaveProperty("servedModel");
    expect(u).not.toHaveProperty("cacheCreation1hTokens");
  });
});

describe("chat usage totals", () => {
  it("sums detail across a tool loop and only calls the cost billed when every step reported it", () => {
    const totals = newChatUsageTotals();
    addChatUsage(totals, extractLlmUsage({ model: "m-a", usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 40 }, cost: 0.01 } }));
    addChatUsage(totals, extractLlmUsage({ model: "m-b", usage: { prompt_tokens: 200, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 60 }, completion_tokens_details: { reasoning_tokens: 5 }, cost: 0.02 } }));
    expect(totals).toMatchObject({ prompt: 300, completion: 30, cached: 100, reasoning: 5, usageSteps: 2, billedSteps: 2, servedModel: "m-b" });
    expect(totals.billedCostUsd).toBeCloseTo(0.03, 10);

    const partial = newChatUsageTotals();
    addChatUsage(partial, extractLlmUsage({ usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.01 } }));
    addChatUsage(partial, extractLlmUsage({ usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    expect(partial.billedSteps).toBeLessThan(partial.usageSteps);
  });
});

describe("LLM usage event: canonical ai block", () => {
  it("sends the full ai block, legacy keys, and an actual billing mode for an OpenRouter-billed call", async () => {
    const captured: Wire[] = [];
    push.__setUsageMonitorFetch(ackStub(captured));
    recordLlmUsage({
      userId: "local",
      provider: "openrouter",
      model: "anthropic/claude-sonnet-5.5",
      context: "strategy",
      keySource: "operator",
      keyRef: "abcd1234",
      promptTokens: 3000,
      completionTokens: 800,
      cachedPromptTokens: 2000,
      cacheCreationTokens: 500,
      cacheCreation1hTokens: 200,
      reasoningTokens: 300,
      billedCostUsd: 0.0123,
      servedModel: "anthropic/claude-sonnet-5.5-20261001",
      latencyMs: 4321.4,
      status: "success",
    });
    await push.flushUsageMonitor();

    expect(captured).toHaveLength(1);
    const e = captured[0]!;
    expect(UsageTelemetryV2EventSchema.safeParse(e).success).toBe(true);
    expect(e).toMatchObject({ billingMode: "actual", confidence: "actual", metricType: "cost", costUsd: 0.0123, unit: "token", requests: 1 });
    expect(e.ai).toEqual({
      model: { requested: "anthropic/claude-sonnet-5.5", served: "anthropic/claude-sonnet-5.5-20261001" },
      harness: "socratic-trade",
      tokens: { input: 500, output: 800, cacheRead: 2000, cacheWrite5m: 300, cacheWrite1h: 200, reasoning: 300 },
      durationMs: 4321,
      billingMode: "payg",
      costSource: "billed",
    });
    // quantity is the sum of the billed ai buckets == prompt + completion.
    expect(e.quantity).toBe(3800);
    expect(e.metadata).toMatchObject({
      promptTokens: 3000,
      completionTokens: 800,
      cachedTokens: 2000,
      cacheWriteTokens: 300,
      cacheWriteOneHourTokens: 200,
      reasoningTokens: 300,
      latencyMs: 4321,
      status: "success",
      costSource: "billed",
      servedModel: "anthropic/claude-sonnet-5.5-20261001",
    });
  });

  it("keeps a price-table cost estimated and labels the ai cost source", async () => {
    const captured: Wire[] = [];
    push.__setUsageMonitorFetch(ackStub(captured));
    recordLlmUsage({ userId: "local", provider: "anthropic", model: "claude-sonnet-5-5", context: "chat", keySource: "user", promptTokens: 1000, completionTokens: 100, status: "timeout", latencyMs: 90000 });
    await push.flushUsageMonitor();
    const e = captured[0]!;
    expect(e).toMatchObject({ billingMode: "estimated", confidence: "estimated", metricType: "cost" });
    expect(e.ai.costSource).toBe("estimated");
    expect(e.ai.tokens).toEqual({ input: 1000, output: 100 });
    expect(e.metadata.status).toBe("timeout");
  });

  it("marks a multi-request chat run with its request count so it stays out of the per-request view", async () => {
    const captured: Wire[] = [];
    push.__setUsageMonitorFetch(ackStub(captured));
    recordLlmUsage({ userId: "local", provider: "openai", model: "gpt-5.5", context: "chat", keySource: "user", promptTokens: 10, completionTokens: 5, requestCount: 3 });
    await push.flushUsageMonitor();
    expect(captured[0]!.requests).toBe(3);
  });

  it("clamps malformed cache figures so the buckets never exceed the ledger total", async () => {
    const captured: Wire[] = [];
    push.__setUsageMonitorFetch(ackStub(captured));
    recordLlmUsage({ userId: "local", provider: "openai", model: "gpt-5.5", context: "chat", keySource: "user", promptTokens: 100, completionTokens: 10, cachedPromptTokens: 90, cacheCreationTokens: 50, cacheCreation1hTokens: 999, reasoningTokens: 99 });
    await push.flushUsageMonitor();
    const e = captured[0]!;
    expect(e.ai.tokens).toEqual({ input: 0, output: 10, cacheRead: 90, cacheWrite1h: 10, reasoning: 10 });
    expect(e.quantity).toBe(110);
  });

  it("falls back to the ledger total when the call reported no token counts", async () => {
    const captured: Wire[] = [];
    push.__setUsageMonitorFetch(ackStub(captured));
    recordLlmUsage({ userId: "local", provider: "openai", model: "gpt-5.5", context: "chat", keySource: "user", status: "error", latencyMs: 12 });
    await push.flushUsageMonitor();
    const e = captured[0]!;
    expect(e.ai.tokens).toBeUndefined();
    expect(e.ai.durationMs).toBe(12);
    expect(e.metadata.status).toBe("error");
  });

  it("replays a ledger row as a byte-identical event to the one pushed live", async () => {
    const live: Wire[] = [];
    push.__setUsageMonitorFetch(ackStub(live));
    recordLlmUsage({
      userId: "local",
      provider: "openrouter",
      model: "anthropic/claude-sonnet-5.5",
      context: "strategy",
      keySource: "operator",
      keyRef: "abcd1234",
      promptTokens: 3000,
      completionTokens: 800,
      cachedPromptTokens: 2000,
      cacheCreationTokens: 500,
      cacheCreation1hTokens: 200,
      reasoningTokens: 300,
      billedCostUsd: 0.0123,
      servedModel: "anthropic/claude-sonnet-5.5-20261001",
      latencyMs: 4321,
      status: "success",
      requestCount: 2,
    });
    await push.flushUsageMonitor();
    expect(live).toHaveLength(1);

    // Drop the live delivery state, keep the ledger row, and let replay rebuild it.
    push.__resetUsageMonitorState();
    getDb().prepare("DELETE FROM settings WHERE key LIKE 'usage_monitor_replay:%watermark%'").run();
    const replayed: Wire[] = [];
    push.__setUsageMonitorFetch(ackStub(replayed));
    await replay.runUsageMonitorReplay();

    expect(replayed).toHaveLength(1);
    expect(JSON.stringify(replayed[0])).toBe(JSON.stringify(live[0]));
  });
});
