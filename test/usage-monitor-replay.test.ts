import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmpDir = path.join(tmpdir(), `socratic-usage-replay-${randomUUID()}`);
const tmpDbPath = path.join(tmpDir, "test.db");
if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
process.env.DATABASE_URL = `file:${tmpDbPath}`;

const push = await import("../src/lib/usage-monitor-push");
const replay = await import("../src/lib/usage-monitor-replay");
const {
  getDb,
  markProviderDispatchStarted,
  reserveProviderDispatch
} = await import("../src/lib/db");

const BASE_URL = "https://usage.example.test";

interface CapturedRequest {
  body: {
    schemaVersion?: number;
    producerId?: string;
    events: Array<Record<string, unknown>>;
  };
  rawBody: string;
}

function ack(received: number): Response {
  return new Response(JSON.stringify({
    ok: true,
    schemaVersion: 2,
    received,
    persisted: received,
    duplicates: 0,
    pruned: 0,
    rejected: 0,
  }), { status: 202 });
}

function telemetryKey(
  kind: "llm" | "rag" | "provider-dispatch" | "rag-rollup" | "provider-dispatch-rollup",
  sourceId: string
): string {
  const digest = createHash("sha256")
    .update(`${kind}\0${sourceId}`)
    .digest("hex");
  return `socratic-trade:${kind}:${digest}`;
}

function fetchStub(captured: CapturedRequest[], ok = true): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const rawBody = String(init?.body ?? "{}");
    captured.push({ rawBody, body: JSON.parse(rawBody) });
    if (!ok) return new Response("unavailable", { status: 503 });
    const eventCount = captured.at(-1)?.body.events.length ?? 0;
    return captured.at(-1)?.body.schemaVersion === 2
      ? ack(eventCount)
      : new Response(JSON.stringify({ ok: true, accepted: eventCount, ignoredPruned: 0 }), {
          status: 202,
        });
  }) as unknown as typeof fetch;
}

function insertLlm(input: {
  id: string;
  createdAt: string;
  provider?: string;
  costUsd?: number | null;
}): void {
  getDb()
    .prepare(
      `INSERT INTO llm_usage (
        id, user_id, provider, model, context, key_source, key_ref,
        prompt_tokens, completion_tokens, total_tokens, cost_usd, created_at
      ) VALUES (?, 'local', ?, 'gemini-2.5-pro', 'strategy', 'operator', 'key-ref', 80, 20, 100, ?, ?)`
    )
    .run(input.id, input.provider ?? "gemini", input.costUsd ?? null, input.createdAt);
}

function insertRag(input: {
  id: string;
  createdAt: string;
  provider?: string;
  costUsd?: number | null;
}): void {
  getDb()
    .prepare(
      `INSERT INTO rag_usage (
        id, user_id, operation, provider, model, tokens_in, tokens_out,
        batch_count, cost_est_usd, created_at
      ) VALUES (?, 'local', 'embed', ?, 'voyage-finance-2', 120, 0, 1, ?, ?)`
    )
    .run(input.id, input.provider ?? "voyage", input.costUsd ?? null, input.createdAt);
}

function insertQdrantRag(input: {
  id: string;
  createdAt: string;
  operation: "query" | "upsert";
  records: number;
  userId?: string;
  model?: string | null;
}): void {
  // Qdrant meters a record count as tokens_out and batch_count, with tokens_in 0 and no cost.
  getDb()
    .prepare(
      `INSERT INTO rag_usage (
        id, user_id, operation, provider, model, tokens_in, tokens_out,
        batch_count, cost_est_usd, created_at
      ) VALUES (?, ?, ?, 'qdrant', ?, 0, ?, ?, NULL, ?)`
    )
    .run(input.id, input.userId ?? "local", input.operation, input.model ?? null, input.records, input.records, input.createdAt);
}

// The units the Usage Monitor accepts (request|call|token|credit|usd|page|job|document|row|byte).
const UM_ACCEPTED_UNITS = ["request", "call", "token", "credit", "usd", "page", "job", "document", "row", "byte"];

function storedWatermark(key: string): { createdAt: string; id: string } | null {
  const row = getDb()
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row ? JSON.parse(row.value) : null;
}

beforeEach(() => {
  push.__resetUsageMonitorState();
  replay.__resetUsageMonitorReplayState();
  process.env.USAGE_MONITOR_BASE_URL = BASE_URL;
  process.env.USAGE_INGEST_TOKEN = "test-token";
  process.env.USAGE_MONITOR_ENV = "test";
  getDb().exec(
    "DELETE FROM llm_usage; DELETE FROM rag_usage; " +
    "DELETE FROM provider_usage_outbox; DELETE FROM provider_dispatch_attempts;"
  );
  getDb().prepare("DELETE FROM settings WHERE key LIKE 'usage_monitor_replay:%'").run();
  getDb().prepare("DELETE FROM settings WHERE key LIKE 'usage_monitor_callvolume:%'").run();
  const now = new Date().toISOString();
  const insertCutover = getDb()
    .prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, 'v2-active', ?)");
  insertCutover.run(replay.USAGE_MONITOR_REPLAY_V2_CUTOVER_KEYS.llm, now);
  insertCutover.run(replay.USAGE_MONITOR_REPLAY_V2_CUTOVER_KEYS.rag, now);
  insertCutover.run(replay.USAGE_MONITOR_REPLAY_V2_CUTOVER_KEYS.provider, now);
  // The windowed rollup seeds its watermark once on first start; most tests exercise it active.
  const insertRollup = getDb()
    .prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, 'rollup-active', ?)");
  insertRollup.run("usage_monitor_replay:rag_usage:rollup_cutover:v1", now);
});

afterEach(() => {
  push.__resetUsageMonitorState();
  replay.__resetUsageMonitorReplayState();
  delete process.env.USAGE_MONITOR_BASE_URL;
  delete process.env.USAGE_INGEST_TOKEN;
  delete process.env.USAGE_MONITOR_ENV;
  delete process.env.USAGE_MONITOR_BREAKER_THRESHOLD;
  delete process.env.USAGE_MONITOR_BREAKER_BASE_MS;
  delete process.env.USAGE_MONITOR_BREAKER_MAX_MS;
  vi.restoreAllMocks();
});

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { unlinkSync(`${tmpDbPath}${suffix}`); } catch { /* best-effort */ }
  }
});

describe("usage monitor durable replay", () => {
  it("replays historical LLM and RAG costs with raw providers, project attribution, and row IDs", async () => {
    insertLlm({
      id: "llm-gemini-paid",
      createdAt: "2026-07-10T12:00:00.000Z",
      provider: "gemini",
      costUsd: 0.42,
    });
    insertRag({
      id: "rag-voyage-paid",
      createdAt: "2026-07-10T12:01:00.000Z",
      provider: "voyage",
      costUsd: 0.003,
    });
    const captured: CapturedRequest[] = [];
    push.__setUsageMonitorFetch(fetchStub(captured));

    const result = await replay.runUsageMonitorReplay();

    expect(result).toEqual({
      configured: true,
      llm: { sent: 1, complete: true, failed: false },
      rag: { sent: 1, complete: true, failed: false },
      provider: { sent: 0, complete: true, failed: false },
      callVolume: { sent: 0, complete: true, failed: false },
    });
    const events = captured.flatMap((request) => request.body.events);
    expect(events).toHaveLength(2);
    expect(captured.every((request) => request.body.schemaVersion === 2)).toBe(true);
    expect(captured.every((request) => request.body.producerId === "socratic-trade")).toBe(true);
    const llm = events.find((event) => event.service === "llm")!;
    expect(llm).toMatchObject({
      project: "socratic-trade",
      provider: "gemini",
      costUsd: 0.42,
      metricType: "cost",
      occurredAt: "2026-07-10T12:00:00.000Z",
      eventId: telemetryKey("llm", "llm-gemini-paid"),
    });
    const rag = events.find((event) => event.service === "rag")!;
    // RAG rows are rolled into one event per closed 10-minute window and group.
    expect(rag).toMatchObject({
      project: "socratic-trade",
      provider: "voyage",
      costUsd: 0.003,
      requests: 1,
      occurredAt: "2026-07-10T12:00:00.000Z",
      windowStart: "2026-07-10T12:00:00.000Z",
      windowEnd: "2026-07-10T12:10:00.000Z",
      eventId: telemetryKey(
        "rag-rollup",
        ["2026-07-10T12:00:00.000Z", "voyage", "embed", "local", "m:voyage-finance-2"].join("\0")
      ),
    });
    expect(storedWatermark(replay.USAGE_MONITOR_REPLAY_WATERMARK_KEYS.llm)).toEqual({
      createdAt: "2026-07-10T12:00:00.000Z",
      id: "llm-gemini-paid",
    });
    expect(storedWatermark(replay.USAGE_MONITOR_REPLAY_WATERMARK_KEYS.rag)).toEqual({
      createdAt: "2026-07-10T12:01:00.000Z",
      id: "rag-voyage-paid",
    });
  });

  it("orders equal timestamps by row ID and safely overlaps the last acknowledged row", async () => {
    const occurredAt = "2026-07-10T13:00:00.000Z";
    insertLlm({ id: "llm-b", createdAt: occurredAt, costUsd: 0.02 });
    insertLlm({ id: "llm-a", createdAt: occurredAt, costUsd: 0.01 });
    const captured: CapturedRequest[] = [];
    push.__setUsageMonitorFetch(fetchStub(captured));

    const first = await replay.runUsageMonitorReplay({ pageSize: 1, maxPagesPerLedger: 1 });
    expect(first.llm).toEqual({ sent: 1, complete: false, failed: false });
    expect(captured[0]!.body.events[0]!.eventId).toBe(telemetryKey("llm", "llm-a"));
    expect(storedWatermark(replay.USAGE_MONITOR_REPLAY_WATERMARK_KEYS.llm)?.id).toBe("llm-a");

    captured.length = 0;
    const second = await replay.runUsageMonitorReplay({ pageSize: 2, maxPagesPerLedger: 2 });
    expect(second.llm).toEqual({ sent: 2, complete: true, failed: false });
    expect(captured[0]!.body.events.map((event) => event.eventId)).toEqual([
      telemetryKey("llm", "llm-a"),
      telemetryKey("llm", "llm-b"),
    ]);
    expect(storedWatermark(replay.USAGE_MONITOR_REPLAY_WATERMARK_KEYS.llm)?.id).toBe("llm-b");

    captured.length = 0;
    const third = await replay.runUsageMonitorReplay();
    expect(third.llm).toEqual({ sent: 1, complete: true, failed: false });
    expect(captured[0]!.body.events[0]!.eventId).toBe(telemetryKey("llm", "llm-b"));
  });

  it("atomically seeds all ledgers at direct-v2 cutover and records skipped rows", async () => {
    getDb().prepare("DELETE FROM settings WHERE key LIKE 'usage_monitor_replay:%'").run();
    insertLlm({ id: "llm-pre-v2", createdAt: "2026-07-10T13:30:00.000Z", costUsd: 0.01 });
    insertRag({ id: "rag-pre-v2", createdAt: "2026-07-10T13:31:00.000Z", costUsd: 0.02 });
    const captured: CapturedRequest[] = [];
    push.__setUsageMonitorFetch(fetchStub(captured));

    const first = await replay.runUsageMonitorReplay();

    expect(first).toEqual({
      configured: true,
      llm: { sent: 0, complete: true, failed: false },
      rag: { sent: 0, complete: true, failed: false },
      provider: { sent: 0, complete: true, failed: false },
      callVolume: { sent: 0, complete: true, failed: false },
    });
    expect(captured).toHaveLength(0);
    expect(storedWatermark(replay.USAGE_MONITOR_REPLAY_WATERMARK_KEYS.llm)?.id)
      .toBe("llm-pre-v2");
    expect(storedWatermark(replay.USAGE_MONITOR_REPLAY_WATERMARK_KEYS.rag)?.id)
      .toBe("rag-pre-v2");
    for (const lane of ["llm", "rag"] as const) {
      const key = replay.USAGE_MONITOR_REPLAY_V2_CUTOVER_KEYS[lane];
      expect(getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key))
        .toEqual({ value: "v2-seeded" });
      expect(getDb().prepare("SELECT value FROM settings WHERE key = ?").get(
        `${key}:pre_v2_rows_skipped`
      )).toEqual({ value: "1" });
    }

    insertLlm({ id: "llm-first-v2", createdAt: "2026-07-10T13:32:00.000Z", costUsd: 0.03 });
    const second = await replay.runUsageMonitorReplay();
    expect(second.llm).toEqual({ sent: 1, complete: true, failed: false });
    expect(captured[0]!.body.schemaVersion).toBe(2);
    expect(captured[0]!.body.producerId).toBe("socratic-trade");
    expect(captured[0]!.body.events.map((event) => event.eventId)).toEqual([
      telemetryKey("llm", "llm-first-v2"),
    ]);
    expect(getDb().prepare("SELECT value FROM settings WHERE key = ?").get(
      replay.USAGE_MONITOR_REPLAY_V2_CUTOVER_KEYS.llm
    )).toEqual({ value: "v2-active" });

    captured.length = 0;
    const third = await replay.runUsageMonitorReplay();
    expect(third.llm).toEqual({ sent: 1, complete: true, failed: false });
    expect(captured[0]!.body.events[0]!.eventId).toBe(
      telemetryKey("llm", "llm-first-v2")
    );
  });

  it("seeds every ledger before the first network await", async () => {
    const ragCutoverKey = replay.USAGE_MONITOR_REPLAY_V2_CUTOVER_KEYS.rag;
    getDb().prepare("DELETE FROM settings WHERE key = ?").run(ragCutoverKey);
    insertLlm({ id: "llm-new", createdAt: "2026-07-10T13:40:00.000Z", costUsd: 0.01 });
    insertRag({ id: "rag-old", createdAt: "2026-07-10T13:41:00.000Z", costUsd: 0.02 });
    const captured: CapturedRequest[] = [];
    let insertedFreshRag = false;
    push.__setUsageMonitorFetch((async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as CapturedRequest["body"];
      captured.push({ body, rawBody: String(init?.body ?? "{}") });
      if (body.events.some((event) => event.service === "llm")) {
        expect(getDb().prepare("SELECT value FROM settings WHERE key = ?").get(
          ragCutoverKey
        )).toEqual({ value: "v2-seeded" });
        expect(storedWatermark(replay.USAGE_MONITOR_REPLAY_WATERMARK_KEYS.rag)?.id)
          .toBe("rag-old");
        if (!insertedFreshRag) {
          insertedFreshRag = true;
          // Simulate a fresh row/live-v2 ACK while the earlier LLM POST is awaiting its ACK.
          insertRag({ id: "rag-new", createdAt: "2026-07-10T13:42:00.000Z", costUsd: 0.03 });
        }
      }
      return ack(body.events.length);
    }) as unknown as typeof fetch);

    const result = await replay.runUsageMonitorReplay();

    expect(result.llm.sent).toBe(1);
    expect(result.rag.sent).toBe(1);
    expect(captured.every((request) => request.body.schemaVersion === 2)).toBe(true);
    expect(captured.flatMap((request) => request.body.events).map((event) => event.eventId))
      .toEqual([
        telemetryKey("llm", "llm-new"),
        // rag-old (13:41) was seeded as the boundary; the rollup of the 13:40 window covers only
        // the rows after it, so the already-skipped row is never counted.
        telemetryKey(
          "rag-rollup",
          ["2026-07-10T13:40:00.000Z", "voyage", "embed", "local", "m:voyage-finance-2"].join("\0")
        ),
      ]);
  });

  it("halts a corrupt cutover lane without network or state writes", async () => {
    const cursor = { createdAt: "2026-07-10T13:50:00.000Z", id: "llm-v2-boundary" };
    insertLlm({ id: cursor.id, createdAt: cursor.createdAt, costUsd: 0.01 });
    insertLlm({ id: "llm-after-corruption", createdAt: "2026-07-10T13:51:00.000Z", costUsd: 0.02 });
    const cutoverKey = replay.USAGE_MONITOR_REPLAY_V2_CUTOVER_KEYS.llm;
    const now = new Date().toISOString();
    getDb().prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
      .run(replay.USAGE_MONITOR_REPLAY_WATERMARK_KEYS.llm, JSON.stringify(cursor), now);
    getDb().prepare("UPDATE settings SET value = ?, updated_at = ? WHERE key = ?")
      .run("v2-actve-typo", now, cutoverKey);
    const captured: CapturedRequest[] = [];
    push.__setUsageMonitorFetch(fetchStub(captured));

    const result = await replay.runUsageMonitorReplay();

    expect(result.llm).toEqual({ sent: 0, complete: false, failed: true });
    expect(captured).toHaveLength(0);
    expect(storedWatermark(replay.USAGE_MONITOR_REPLAY_WATERMARK_KEYS.llm)).toEqual(cursor);
    expect(getDb().prepare("SELECT value FROM settings WHERE key = ?").get(cutoverKey))
      .toEqual({ value: "v2-actve-typo" });
    expect(getDb().prepare("SELECT value FROM settings WHERE key = ?").get(
      `${cutoverKey}:pre_v2_rows_skipped`
    )).toBeUndefined();
  });

  it("rejects malformed pre-cutover watermarks without partially seeding any lane", async () => {
    const now = new Date().toISOString();
    const llmCutover = replay.USAGE_MONITOR_REPLAY_V2_CUTOVER_KEYS.llm;
    const ragCutover = replay.USAGE_MONITOR_REPLAY_V2_CUTOVER_KEYS.rag;
    const providerCutover = replay.USAGE_MONITOR_REPLAY_V2_CUTOVER_KEYS.provider;
    getDb().prepare("DELETE FROM settings WHERE key IN (?, ?, ?)")
      .run(llmCutover, ragCutover, providerCutover);
    getDb().prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
      .run(replay.USAGE_MONITOR_REPLAY_WATERMARK_KEYS.llm, "not-json", now);
    getDb().prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
      .run(
        replay.USAGE_MONITOR_REPLAY_WATERMARK_KEYS.rag,
        JSON.stringify({ createdAt: "definitely-not-a-ledger-time", id: "rag-bad" }),
        now
      );
    insertLlm({ id: "llm-would-be-seeded", createdAt: "2026-07-10T13:55:00.000Z" });
    insertRag({ id: "rag-would-be-seeded", createdAt: "2026-07-10T13:56:00.000Z" });
    const captured: CapturedRequest[] = [];
    push.__setUsageMonitorFetch(fetchStub(captured));

    const result = await replay.runUsageMonitorReplay();

    expect(result.llm.failed).toBe(true);
    expect(result.rag.failed).toBe(true);
    expect(result.provider.failed).toBe(true);
    expect(captured).toHaveLength(0);
    expect(getDb().prepare("SELECT value FROM settings WHERE key = ?").get(
      replay.USAGE_MONITOR_REPLAY_WATERMARK_KEYS.llm
    )).toEqual({ value: "not-json" });
    expect(getDb().prepare("SELECT value FROM settings WHERE key = ?").get(providerCutover))
      .toBeUndefined();
    expect(getDb().prepare("SELECT value FROM settings WHERE key = ?").get(
      `${providerCutover}:pre_v2_rows_skipped`
    )).toBeUndefined();
  });

  it("does not advance a watermark on ambiguous failure and reconstructs the same payload", async () => {
    insertLlm({
      id: "llm-retry",
      createdAt: "2026-07-10T14:00:00.000Z",
      costUsd: 0.25,
    });
    const failed: CapturedRequest[] = [];
    push.__setUsageMonitorFetch(fetchStub(failed, false));

    const first = await replay.runUsageMonitorReplay();
    expect(first.llm).toEqual({ sent: 0, complete: false, failed: true });
    expect(storedWatermark(replay.USAGE_MONITOR_REPLAY_WATERMARK_KEYS.llm)).toBeNull();

    const retried: CapturedRequest[] = [];
    push.__setUsageMonitorFetch(fetchStub(retried));
    const second = await replay.runUsageMonitorReplay();
    expect(second.llm).toEqual({ sent: 1, complete: true, failed: false });
    expect(retried[0]!.rawBody).toBe(failed[0]!.rawBody);
  });

  it("reconciles a crash-left dispatched provider call as unknown and replays it idempotently", async () => {
    const reserved = reserveProviderDispatch({
      provider: "fmp",
      operation: "earnings-transcript-dates",
      credentialRef: "fmp-key:test",
      userId: "local",
      now: "2026-07-10T12:00:00.000Z"
    });
    expect(reserved.admitted).toBe(true);
    if (!reserved.admitted) throw new Error("Expected provider reservation admission.");
    markProviderDispatchStarted(reserved.attemptId, "2026-07-10T12:00:01.000Z");

    const captured: CapturedRequest[] = [];
    push.__setUsageMonitorFetch(fetchStub(captured));
    // The outbox row is stamped with the real insert time: close its window by moving the clock.
    const later = Date.now() + 3_600_000;
    const first = await replay.runUsageMonitorReplay({ nowMs: later });

    expect(first.provider).toEqual({ sent: 1, complete: true, failed: false });
    const event = captured.flatMap((request) => request.body.events)
      .find((candidate) => candidate.service === "provider-dispatch");
    expect(event).toMatchObject({
      provider: "fmp",
      service: "provider-dispatch",
      label: "earnings-transcript-dates",
      requests: 1,
      confidence: "estimated",
      metadata: { outcome: "unknown", unknownOutcome: true, userId: "local" },
      eventId: expect.stringContaining("socratic-trade:provider-dispatch-rollup:"),
      windowStart: expect.any(String),
      windowEnd: expect.any(String),
    });
    expect(getDb().prepare(
      "SELECT status, outcome_code FROM provider_dispatch_attempts WHERE id = ?"
    ).get(reserved.attemptId)).toEqual({
      status: "unknown",
      outcome_code: "stale-owner-unresolved"
    });

    const firstRaw = captured[0]!.rawBody;
    captured.length = 0;
    // The window is closed and acknowledged: nothing is re-sent.
    const second = await replay.runUsageMonitorReplay({ nowMs: later });
    expect(second.provider).toEqual({ sent: 0, complete: true, failed: false });
    expect(captured).toHaveLength(0);

    // Crash between the ACK and the watermark write: the window is rebuilt byte-identically, so
    // the monitor dedupes it under the same key instead of 409-ing a changed resend.
    getDb().prepare("DELETE FROM settings WHERE key = ?")
      .run(replay.USAGE_MONITOR_REPLAY_WATERMARK_KEYS.provider);
    const third = await replay.runUsageMonitorReplay({ nowMs: later });
    expect(third.provider).toEqual({ sent: 1, complete: true, failed: false });
    expect(captured[0]!.rawBody).toBe(firstRaw);
  });

  it("does not send a window until it has ended plus the grace period", async () => {
    insertRag({ id: "rag-open-1", createdAt: "2026-07-10T15:01:00.000Z", costUsd: 0.001 });
    insertRag({ id: "rag-open-2", createdAt: "2026-07-10T15:09:30.000Z", costUsd: 0.002 });
    const captured: CapturedRequest[] = [];
    push.__setUsageMonitorFetch(fetchStub(captured));
    const windowEnd = Date.parse("2026-07-10T15:10:00.000Z");

    const open = await replay.runUsageMonitorReplay({ nowMs: windowEnd + 59_000 });
    expect(open.rag).toEqual({ sent: 0, complete: true, failed: false });
    expect(captured).toHaveLength(0);
    expect(storedWatermark(replay.USAGE_MONITOR_REPLAY_WATERMARK_KEYS.rag)).toBeNull();

    const closed = await replay.runUsageMonitorReplay({ nowMs: windowEnd + 60_000 });
    expect(closed.rag).toEqual({ sent: 1, complete: true, failed: false });
    const events = captured.flatMap((request) => request.body.events);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      service: "rag",
      provider: "voyage",
      requests: 2,
      unit: "token",
      quantity: 240,
      windowStart: "2026-07-10T15:00:00.000Z",
      windowEnd: "2026-07-10T15:10:00.000Z",
    });
    expect(events[0]!.costUsd).toBeCloseTo(0.003, 9);
  });

  it("sums per group, splits groups, and reports self-hosted Qdrant as call volume", async () => {
    insertRag({ id: "rag-v-1", createdAt: "2026-07-10T16:01:00.000Z", costUsd: 0.001 });
    insertRag({ id: "rag-v-2", createdAt: "2026-07-10T16:02:00.000Z", costUsd: 0.001 });
    insertRag({ id: "rag-o-1", createdAt: "2026-07-10T16:03:00.000Z", provider: "openrouter", costUsd: 0.0005 });
    insertRag({ id: "rag-q-1", createdAt: "2026-07-10T16:04:00.000Z", provider: "qdrant" });
    insertRag({ id: "rag-q-2", createdAt: "2026-07-10T16:09:59.000Z", provider: "qdrant" });
    insertRag({ id: "rag-next", createdAt: "2026-07-10T16:10:00.000Z", costUsd: 0.004 });
    const captured: CapturedRequest[] = [];
    push.__setUsageMonitorFetch(fetchStub(captured));

    const result = await replay.runUsageMonitorReplay({ nowMs: Date.parse("2026-07-10T17:00:00.000Z") });

    expect(result.rag).toEqual({ sent: 4, complete: true, failed: false });
    const events = captured.flatMap((request) => request.body.events);
    expect(events.map((e) => `${e.provider}:${e.windowStart}:${e.requests}`)).toEqual([
      "openrouter:2026-07-10T16:00:00.000Z:1",
      "qdrant:2026-07-10T16:00:00.000Z:2",
      "voyage:2026-07-10T16:00:00.000Z:2",
      "voyage:2026-07-10T16:10:00.000Z:1",
    ]);
    expect(storedWatermark(replay.USAGE_MONITOR_REPLAY_WATERMARK_KEYS.rag)?.id).toBe("rag-next");
  });

  it("reports closed Qdrant windows as request counts with no quantity or cost", async () => {
    insertQdrantRag({ id: "q-query-1", createdAt: "2026-07-10T16:01:00.000Z", operation: "query", records: 8 });
    insertQdrantRag({ id: "q-query-2", createdAt: "2026-07-10T16:02:00.000Z", operation: "query", records: 8 });
    insertQdrantRag({ id: "q-query-3", createdAt: "2026-07-10T16:03:00.000Z", operation: "query", records: 5 });
    insertQdrantRag({ id: "q-upsert-1", createdAt: "2026-07-10T16:04:00.000Z", operation: "upsert", records: 100 });
    insertQdrantRag({ id: "q-upsert-2", createdAt: "2026-07-10T16:05:00.000Z", operation: "upsert", records: 40 });
    insertQdrantRag({ id: "q-upsert-other", createdAt: "2026-07-10T16:06:00.000Z", operation: "upsert", records: 7, userId: "other" });
    insertRag({ id: "ctl-openrouter", createdAt: "2026-07-10T16:07:00.000Z", provider: "openrouter", costUsd: 0.0005 });
    const captured: CapturedRequest[] = [];
    push.__setUsageMonitorFetch(fetchStub(captured));

    const result = await replay.runUsageMonitorReplay({ nowMs: Date.parse("2026-07-10T17:00:00.000Z") });

    expect(result.rag).toEqual({ sent: 4, complete: true, failed: false });
    const events = captured.flatMap((request) => request.body.events);
    // Control: the capture fixture is live, so the Qdrant assertions below cannot pass vacuously.
    expect(events.filter((e) => e.provider === "openrouter")).toHaveLength(1);

    const qdrant = events.filter((e) => e.provider === "qdrant");
    expect(qdrant).toHaveLength(3);
    const byLabel = new Map(qdrant.map((e) => [`${e.label}:${(e.metadata as { userId: string }).userId}`, e]));
    for (const [key, requests, records] of [
      ["query:local", 3, 21],
      ["upsert:local", 2, 140],
      ["upsert:other", 1, 7],
    ] as const) {
      const event = byLabel.get(key)!;
      expect(event).toMatchObject({
        service: "rag",
        unit: "request",
        requests,
        metricType: "usage",
        windowStart: "2026-07-10T16:00:00.000Z",
        windowEnd: "2026-07-10T16:10:00.000Z",
        occurredAt: "2026-07-10T16:00:00.000Z",
        metadata: { batchCount: records, recordCount: records },
      });
      expect(event).not.toHaveProperty("quantity");
      expect(event).not.toHaveProperty("costUsd");
      expect(UM_ACCEPTED_UNITS).toContain(event.unit);
    }
    expect(new Set(qdrant.map((e) => e.eventId)).size).toBe(3);
  });

  it("sends nothing for an open Qdrant window", async () => {
    insertQdrantRag({ id: "q-open-1", createdAt: "2026-07-10T15:01:00.000Z", operation: "query", records: 3 });
    insertRag({ id: "ctl-open", createdAt: "2026-07-10T15:02:00.000Z", provider: "openrouter", costUsd: 0.001 });
    const captured: CapturedRequest[] = [];
    push.__setUsageMonitorFetch(fetchStub(captured));
    const windowEnd = Date.parse("2026-07-10T15:10:00.000Z");

    const open = await replay.runUsageMonitorReplay({ nowMs: windowEnd + 59_000 });
    expect(open.rag).toEqual({ sent: 0, complete: true, failed: false });
    expect(captured).toHaveLength(0);

    const closed = await replay.runUsageMonitorReplay({ nowMs: windowEnd + 60_000 });
    expect(closed.rag).toEqual({ sent: 2, complete: true, failed: false });
    const events = captured.flatMap((request) => request.body.events);
    // Control: the openrouter event is captured alongside the Qdrant one.
    expect(events.map((e) => e.provider).sort()).toEqual(["openrouter", "qdrant"]);
  });

  it("keeps a mixed openrouter and Qdrant window as one token event plus separate request events", async () => {
    insertRag({ id: "mix-or-1", createdAt: "2026-07-10T16:01:00.000Z", provider: "openrouter", costUsd: 0.0005 });
    insertRag({ id: "mix-or-2", createdAt: "2026-07-10T16:02:00.000Z", provider: "openrouter", costUsd: 0.0007 });
    insertQdrantRag({ id: "mix-q-1", createdAt: "2026-07-10T16:03:00.000Z", operation: "query", records: 4 });
    insertQdrantRag({ id: "mix-q-2", createdAt: "2026-07-10T16:04:00.000Z", operation: "upsert", records: 9 });
    const captured: CapturedRequest[] = [];
    push.__setUsageMonitorFetch(fetchStub(captured));

    await replay.runUsageMonitorReplay({ nowMs: Date.parse("2026-07-10T17:00:00.000Z") });

    const events = captured.flatMap((request) => request.body.events);
    const tokenEvents = events.filter((e) => e.unit === "token");
    expect(tokenEvents).toHaveLength(1);
    expect(tokenEvents[0]).toMatchObject({ provider: "openrouter", requests: 2, quantity: 240, metricType: "cost" });
    expect(tokenEvents[0]!.costUsd).toBeCloseTo(0.0012, 9);
    const requestEvents = events.filter((e) => e.unit === "request");
    expect(requestEvents.map((e) => `${e.provider}:${e.label}:${e.requests}`)).toEqual([
      "qdrant:query:1",
      "qdrant:upsert:1",
    ]);
  });

  it("rebuilds byte-identical Qdrant events after a crash before the watermark write", async () => {
    insertQdrantRag({ id: "crash-q-1", createdAt: "2026-07-10T16:01:00.000Z", operation: "query", records: 6 });
    insertQdrantRag({ id: "crash-q-2", createdAt: "2026-07-10T16:02:00.000Z", operation: "upsert", records: 30 });
    insertRag({ id: "crash-ctl", createdAt: "2026-07-10T16:03:00.000Z", provider: "openrouter", costUsd: 0.001 });
    const captured: CapturedRequest[] = [];
    push.__setUsageMonitorFetch(fetchStub(captured));
    const nowMs = Date.parse("2026-07-10T17:00:00.000Z");

    const first = await replay.runUsageMonitorReplay({ nowMs });
    expect(first.rag).toEqual({ sent: 3, complete: true, failed: false });
    const firstRaw = captured.map((request) => request.rawBody);
    expect(captured.flatMap((request) => request.body.events).filter((e) => e.provider === "qdrant")).toHaveLength(2);
    captured.length = 0;

    getDb().prepare("DELETE FROM settings WHERE key = ?")
      .run(replay.USAGE_MONITOR_REPLAY_WATERMARK_KEYS.rag);
    const second = await replay.runUsageMonitorReplay({ nowMs });
    expect(second.rag).toEqual({ sent: 3, complete: true, failed: false });
    expect(captured.map((request) => request.rawBody)).toEqual(firstRaw);
  });

  it("seeds the rollup watermark on first start so already-delivered rows are not counted again", async () => {
    getDb().prepare("DELETE FROM settings WHERE key LIKE '%rollup_cutover%'").run();
    insertRag({ id: "rag-live-1", createdAt: "2026-07-10T18:01:00.000Z", costUsd: 0.001 });
    insertRag({ id: "rag-live-2", createdAt: "2026-07-10T18:02:00.000Z", costUsd: 0.001 });
    const captured: CapturedRequest[] = [];
    push.__setUsageMonitorFetch(fetchStub(captured));
    const nowMs = Date.parse("2026-07-10T19:00:00.000Z");

    const first = await replay.runUsageMonitorReplay({ nowMs });
    expect(first.rag).toEqual({ sent: 0, complete: true, failed: false });
    expect(captured).toHaveLength(0);
    expect(storedWatermark(replay.USAGE_MONITOR_REPLAY_WATERMARK_KEYS.rag)?.id).toBe("rag-live-2");

    insertRag({ id: "rag-after", createdAt: "2026-07-10T18:30:00.000Z", costUsd: 0.002 });
    const second = await replay.runUsageMonitorReplay({ nowMs });
    expect(second.rag).toEqual({ sent: 1, complete: true, failed: false });
    expect(captured.flatMap((request) => request.body.events)[0]).toMatchObject({ requests: 1 });
  });

  it("seeds before the first network await, so rows written during the LLM replay are not swallowed", async () => {
    getDb().prepare("DELETE FROM settings WHERE key LIKE '%rollup_cutover%'").run();
    insertLlm({ id: "llm-await", createdAt: "2026-07-10T20:00:00.000Z", costUsd: 0.01 });
    insertRag({ id: "rag-seeded", createdAt: "2026-07-10T20:01:00.000Z", costUsd: 0.001 });
    const captured: CapturedRequest[] = [];
    let inserted = false;
    push.__setUsageMonitorFetch((async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as CapturedRequest["body"];
      captured.push({ body, rawBody: String(init?.body ?? "{}") });
      if (!inserted) {
        inserted = true;
        // Lands while the LLM POST awaits its ACK: must still be delivered by the rollup.
        insertRag({ id: "rag-during", createdAt: "2026-07-10T20:02:00.000Z", costUsd: 0.002 });
      }
      return ack(body.events.length);
    }) as unknown as typeof fetch);

    const result = await replay.runUsageMonitorReplay({ nowMs: Date.parse("2026-07-10T21:00:00.000Z") });

    expect(result.rag).toEqual({ sent: 1, complete: true, failed: false });
    const ragEvents = captured.flatMap((request) => request.body.events).filter((event) => event.service === "rag");
    expect(ragEvents).toHaveLength(1);
    expect(ragEvents[0]).toMatchObject({ requests: 1, windowStart: "2026-07-10T20:00:00.000Z" });
    expect(ragEvents[0]!.costUsd).toBeCloseTo(0.002, 9);
  });

  it("keeps a NULL model and an empty-string model as separate groups with distinct identities", async () => {
    getDb().prepare(
      "INSERT INTO rag_usage (id, user_id, operation, provider, model, tokens_in, tokens_out, batch_count, cost_est_usd, created_at) " +
      "VALUES ('rag-null-model', 'local', 'embed', 'openrouter', NULL, 10, 0, 1, 0.001, '2026-07-10T21:01:00.000Z')"
    ).run();
    getDb().prepare(
      "INSERT INTO rag_usage (id, user_id, operation, provider, model, tokens_in, tokens_out, batch_count, cost_est_usd, created_at) " +
      "VALUES ('rag-empty-model', 'local', 'embed', 'openrouter', '', 20, 0, 1, 0.002, '2026-07-10T21:02:00.000Z')"
    ).run();
    const captured: CapturedRequest[] = [];
    push.__setUsageMonitorFetch(fetchStub(captured));

    const result = await replay.runUsageMonitorReplay({ nowMs: Date.parse("2026-07-10T22:00:00.000Z") });

    expect(result.rag).toEqual({ sent: 2, complete: true, failed: false });
    const events = captured.flatMap((request) => request.body.events);
    expect(new Set(events.map((event) => event.eventId)).size).toBe(2);
    expect(events.map((event) => event.quantity).sort()).toEqual([10, 20]);
  });

  it("records a durable receipt of the rows the rag rollup seed skipped", async () => {
    getDb().prepare("DELETE FROM settings WHERE key LIKE '%rollup_cutover%'").run();
    getDb().prepare("DELETE FROM settings WHERE key = ?").run(replay.USAGE_MONITOR_REPLAY_WATERMARK_KEYS.rag);
    insertRag({ id: "rag-skip-1", createdAt: "2026-07-10T22:01:00.000Z", costUsd: 0.001 });
    insertRag({ id: "rag-skip-2", createdAt: "2026-07-10T22:02:00.000Z", costUsd: 0.001 });
    push.__setUsageMonitorFetch(fetchStub([]));

    await replay.runUsageMonitorReplay({ nowMs: Date.parse("2026-07-10T23:00:00.000Z") });

    const receipt = getDb()
      .prepare("SELECT value FROM settings WHERE key = 'usage_monitor_replay:rag_usage:rollup_cutover:v1:rows_skipped'")
      .get() as { value: string } | undefined;
    expect(receipt?.value).toBe("2");
    const audited = getDb()
      .prepare("SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'usage_monitor_replay_rollup_cutover_skip'")
      .get() as { n: number };
    expect(audited.n).toBeGreaterThan(0);
  });

  it("does not seed a rag lane whose v2 cutover state is invalid", async () => {
    getDb().prepare("DELETE FROM settings WHERE key LIKE '%rollup_cutover%'").run();
    const ragWatermark = replay.USAGE_MONITOR_REPLAY_WATERMARK_KEYS.rag;
    getDb().prepare("DELETE FROM settings WHERE key = ?").run(ragWatermark);
    getDb().prepare("UPDATE settings SET value = 'v2-actve-typo' WHERE key = ?")
      .run(replay.USAGE_MONITOR_REPLAY_V2_CUTOVER_KEYS.rag);
    insertRag({ id: "rag-invalid-lane", createdAt: "2026-07-10T23:01:00.000Z", costUsd: 0.001 });
    push.__setUsageMonitorFetch(fetchStub([]));

    const result = await replay.runUsageMonitorReplay({ nowMs: Date.parse("2026-07-11T00:00:00.000Z") });

    expect(result.rag).toEqual({ sent: 0, complete: false, failed: true });
    expect(storedWatermark(ragWatermark)).toBeNull();
    expect(getDb().prepare("SELECT value FROM settings WHERE key LIKE '%rag_usage:rollup_cutover%'").get()).toBeUndefined();
  });

  it("does not seed the provider lane: it never had a live push, so its backlog is delivered", async () => {
    const reserved = reserveProviderDispatch({
      provider: "fmp",
      operation: "income-statement",
      credentialRef: "fmp-key:test",
      userId: "local",
      now: "2026-07-10T12:00:00.000Z",
    });
    expect(reserved.admitted).toBe(true);
    if (!reserved.admitted) throw new Error("Expected provider reservation admission.");
    markProviderDispatchStarted(reserved.attemptId, "2026-07-10T12:00:01.000Z");
    const captured: CapturedRequest[] = [];
    push.__setUsageMonitorFetch(fetchStub(captured));

    const result = await replay.runUsageMonitorReplay({ nowMs: Date.now() + 3_600_000 });

    expect(result.provider.sent).toBe(1);
    expect(captured.flatMap((request) => request.body.events).some((e) => e.service === "provider-dispatch")).toBe(true);
  });

  it("advances the provider watermark past an all-retired page without posting", async () => {
    const reserved = reserveProviderDispatch({
      provider: "alpaca",
      operation: "get-portfolio",
      credentialRef: "alpaca-key:test",
      userId: "local",
      now: "2026-07-22T15:00:00.000Z",
    });
    expect(reserved.admitted).toBe(true);
    if (!reserved.admitted) throw new Error("Expected alpaca reservation admission.");
    markProviderDispatchStarted(reserved.attemptId, "2026-07-22T15:00:01.000Z");

    const captured: CapturedRequest[] = [];
    push.__setUsageMonitorFetch(fetchStub(captured));
    const result = await replay.runUsageMonitorReplay({ nowMs: Date.now() + 3_600_000 });

    // A window holding only retired-family rows builds no events, so nothing hits the network, but
    // the watermark still moves past it.
    expect(result.provider).toEqual({ sent: 0, complete: true, failed: false });
    expect(captured).toHaveLength(0);
    const watermark = storedWatermark(replay.USAGE_MONITOR_REPLAY_WATERMARK_KEYS.provider);
    expect(watermark?.id).toBe(`provider-attempt:${reserved.attemptId}`);
    expect(watermark?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("replays mixed retired+paid provider pages with only paid events on the wire", async () => {
    const retired = reserveProviderDispatch({
      provider: "robinhood",
      operation: "get-portfolio",
      credentialRef: "rh-key:test",
      userId: "local",
      now: "2026-07-22T15:10:00.000Z",
    });
    const paid = reserveProviderDispatch({
      provider: "fmp",
      operation: "income-statement",
      credentialRef: "fmp-key:test",
      userId: "local",
      now: "2026-07-22T15:10:01.000Z",
    });
    expect(retired.admitted).toBe(true);
    expect(paid.admitted).toBe(true);
    if (!retired.admitted || !paid.admitted) {
      throw new Error("Expected mixed provider reservation admission.");
    }
    markProviderDispatchStarted(retired.attemptId, "2026-07-22T15:10:00.500Z");
    markProviderDispatchStarted(paid.attemptId, "2026-07-22T15:10:01.500Z");

    const captured: CapturedRequest[] = [];
    push.__setUsageMonitorFetch(fetchStub(captured));
    const later = Date.now() + 3_600_000;
    const result = await replay.runUsageMonitorReplay({ nowMs: later });

    expect(result.provider).toEqual({ sent: 1, complete: true, failed: false });
    const providers = captured.flatMap((request) => request.body.events).map((e) => e.provider);
    expect(providers).toEqual(["fmp"]);
    expect(captured[0]!.body.schemaVersion).toBe(2);
    expect(captured[0]!.body.events[0]).toMatchObject({
      provider: "fmp",
      service: "provider-dispatch",
      eventId: expect.stringContaining("socratic-trade:provider-dispatch-rollup:"),
    });
    // Watermark advances past BOTH rows (order is (created_at, id); UUID order is not load-bearing).
    const watermarkId = storedWatermark(replay.USAGE_MONITOR_REPLAY_WATERMARK_KEYS.provider)?.id;
    expect([
      `provider-attempt:${retired.attemptId}`,
      `provider-attempt:${paid.attemptId}`,
    ]).toContain(watermarkId);

    // Closed windows are never re-sent; retired families never ship.
    captured.length = 0;
    const second = await replay.runUsageMonitorReplay({ nowMs: later });
    expect(second.provider).toEqual({ sent: 0, complete: true, failed: false });
    expect(captured).toHaveLength(0);
  });

  it("does not regress a watermark advanced by an overlapping process", async () => {
    const older = "2026-07-10T14:30:00.000Z";
    const newer = "2026-07-10T14:31:00.000Z";
    insertLlm({ id: "llm-older", createdAt: older, costUsd: 0.1 });
    insertLlm({ id: "llm-newer", createdAt: newer, costUsd: 0.2 });
    push.__setUsageMonitorFetch((async () => {
      // Simulate a second process ACKing the newer row while this process is awaiting its POST.
      getDb()
        .prepare(
          "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
        )
        .run(
          replay.USAGE_MONITOR_REPLAY_WATERMARK_KEYS.llm,
          JSON.stringify({ createdAt: newer, id: "llm-newer" }),
          new Date().toISOString()
        );
      return ack(1);
    }) as unknown as typeof fetch);

    const result = await replay.runUsageMonitorReplay({ pageSize: 1, maxPagesPerLedger: 1 });

    expect(result.llm).toEqual({ sent: 1, complete: false, failed: false });
    expect(storedWatermark(replay.USAGE_MONITOR_REPLAY_WATERMARK_KEYS.llm)).toEqual({
      createdAt: newer,
      id: "llm-newer",
    });
  });

  it("starts one immediate replay and one guarded interval only when configured", async () => {
    insertLlm({
      id: "llm-startup",
      createdAt: "2026-07-10T15:00:00.000Z",
      costUsd: 0.05,
    });
    const captured: CapturedRequest[] = [];
    push.__setUsageMonitorFetch(fetchStub(captured));
    const intervalSpy = vi.spyOn(globalThis, "setInterval");

    replay.startUsageMonitorReplay();
    replay.startUsageMonitorReplay();
    await vi.waitFor(() => expect(captured).toHaveLength(1));
    expect(intervalSpy).toHaveBeenCalledTimes(1);

    replay.__resetUsageMonitorReplayState();
    delete process.env.USAGE_INGEST_TOKEN;
    replay.startUsageMonitorReplay();
    expect(intervalSpy).toHaveBeenCalledTimes(1);
  });

  it("clears a stale v2 HMR timer and installs fresh direct-v2 replay state", async () => {
    const host = globalThis as unknown as {
      __usageMonitorReplay?: {
        version: number;
        timer: ReturnType<typeof setInterval> | null;
        inFlight: Promise<unknown> | null;
      };
    };
    const staleTimer = setInterval(() => undefined, 60_000);
    staleTimer.unref?.();
    host.__usageMonitorReplay = {
      version: 2,
      timer: staleTimer,
      inFlight: Promise.resolve({ stale: true }),
    };
    const clearSpy = vi.spyOn(globalThis, "clearInterval");
    vi.resetModules();

    const freshReplay = await import("../src/lib/usage-monitor-replay");

    expect(clearSpy).toHaveBeenCalledWith(staleTimer);
    expect(host.__usageMonitorReplay).toMatchObject({
      version: 3,
      timer: null,
      inFlight: null,
    });
    freshReplay.__resetUsageMonitorReplayState();
    delete host.__usageMonitorReplay;
  });

  it("shares the live-push circuit breaker: a tripped breaker suppresses replay's own delivery attempts too", async () => {
    process.env.USAGE_MONITOR_BREAKER_THRESHOLD = "1";
    process.env.USAGE_MONITOR_BREAKER_BASE_MS = "60000";
    process.env.USAGE_MONITOR_BREAKER_MAX_MS = "60000";
    insertLlm({ id: "llm-breaker-shared", createdAt: "2026-07-10T16:00:00.000Z", costUsd: 0.1 });

    // Trip the breaker via the live-push lane (a plain failed flush, not replay).
    let liveAttempts = 0;
    push.__setUsageMonitorFetch((async () => {
      liveAttempts += 1;
      throw new Error("connection refused");
    }) as unknown as typeof fetch);
    push.pushLlmUsage({ sourceEventId: "trip-it", provider: "openai", userId: "local", keySource: "operator", totalTokens: 1 });
    await push.flushUsageMonitor();
    expect(liveAttempts).toBe(1);

    // Now point at a fetch stub that would succeed if called — the open breaker must stop replay
    // from ever reaching it, proving the two lanes share one breaker instead of hammering
    // independently (replay's fixed 60s interval would otherwise keep probing on its own cadence).
    const captured: CapturedRequest[] = [];
    push.__setUsageMonitorFetch(fetchStub(captured));

    const result = await replay.runUsageMonitorReplay();
    expect(result.llm.failed).toBe(true);
    expect(captured).toHaveLength(0);
    expect(storedWatermark(replay.USAGE_MONITOR_REPLAY_WATERMARK_KEYS.llm)).toBeNull();
  });

  it("records usage-monitor health from the replay lane on failure AND recovery (not just a breaker trip)", async () => {
    // Scope health assertions to this test's rows.
    getDb().prepare("DELETE FROM api_health_log WHERE service = 'usage-monitor'").run();
    insertLlm({ id: "llm-health-truth", createdAt: "2026-07-10T17:00:00.000Z", costUsd: 0.05 });

    const healthRows = () =>
      getDb()
        .prepare("SELECT ok FROM api_health_log WHERE service = 'usage-monitor' ORDER BY ts DESC, rowid DESC")
        .all() as Array<{ ok: number }>;

    // Replay is the FIRST/only lane to hit a down monitor — without the fix this would open the
    // shared breaker but leave the admin health row stale-healthy.
    const failed: CapturedRequest[] = [];
    push.__setUsageMonitorFetch(fetchStub(failed, false));
    const first = await replay.runUsageMonitorReplay();
    expect(first.llm.failed).toBe(true);
    expect(failed.length).toBeGreaterThan(0); // it actually attempted the send
    const afterFail = healthRows();
    expect(afterFail.length).toBeGreaterThan(0);
    expect(afterFail[0]!.ok).toBe(0); // a real FAILURE was recorded, not just a silent breaker trip

    // Monitor recovers. The watermark never advanced on failure, so replay re-sends the same row and
    // records recovery from the replay lane.
    const okReq: CapturedRequest[] = [];
    push.__setUsageMonitorFetch(fetchStub(okReq));
    const second = await replay.runUsageMonitorReplay();
    expect(second.llm.failed).toBe(false);
    const afterOk = healthRows();
    expect(afterOk[0]!.ok).toBe(1); // recovery recorded from the replay lane
  });

  it("does not advance a durable watermark when a valid v2 ACK rejects an event", async () => {
    insertLlm({
      id: "llm-partial-ack",
      createdAt: "2026-07-10T17:30:00.000Z",
      costUsd: 0.05,
    });
    push.__setUsageMonitorFetch((async () => new Response(JSON.stringify({
      ok: true,
      schemaVersion: 2,
      received: 1,
      persisted: 0,
      duplicates: 0,
      pruned: 0,
      rejected: 1,
    }), { status: 202 })) as unknown as typeof fetch);

    const result = await replay.runUsageMonitorReplay();

    expect(result.llm).toEqual({ sent: 0, complete: false, failed: true });
    expect(storedWatermark(replay.USAGE_MONITOR_REPLAY_WATERMARK_KEYS.llm)).toBeNull();
  });

  it("drops a schema-invalid replay event without tripping the breaker and acks it (quarantine, not receiver-down)", async () => {
    process.env.USAGE_MONITOR_BREAKER_THRESHOLD = "1";
    const captured: CapturedRequest[] = [];
    push.__setUsageMonitorFetch(fetchStub(captured));

    // An all-poison batch (Infinity quantity fails the shared schema's .finite()). client.send would
    // reject it before any fetch; sendUsageMonitorBatch must NOT read that as a receiver outage.
    const poison = {
      environment: "test",
      provider: "poison-replay",
      service: "broker",
      project: "socratic-trade",
      metricType: "balance",
      quantity: Number.POSITIVE_INFINITY,
      unit: "usd",
      confidence: "actual",
      occurredAt: "2026-07-10T18:00:00.000Z",
      eventId: "socratic-trade:poison:replay-1",
    };

    const ok = await push.sendUsageMonitorBatch(
      [poison] as unknown as Parameters<typeof push.sendUsageMonitorBatch>[0]
    );
    expect(ok).toBe(true); // acknowledged so a durable caller advances its watermark past the bad row
    expect(captured).toHaveLength(0); // never contacted the receiver
    const breaker = push.__usageMonitorDebugState().breaker;
    expect(breaker.consecutiveFailures).toBe(0); // breaker untouched by the local validation reject
    expect(breaker.openUntil).toBe(0);
  });

  it("self-heals a 409 idempotency collision: skips exactly the monitor-named row, resends the rest, advances the watermark", async () => {
    // Prod incident 2026-07-28..30: a row already persisted monitor-side (pre-deploy content,
    // volatile gitSha) made the monitor 409 the WHOLE batch on every replay, permanently
    // wedging the watermark and starving every newer row. The collision IS proof of prior
    // delivery, so replay now skips exactly the named row (audited) and resends the rest.
    insertLlm({ id: "llm-collide", createdAt: "2026-07-29T10:00:00.000Z", costUsd: 0.07 });
    insertLlm({ id: "llm-fresh", createdAt: "2026-07-29T10:01:00.000Z", costUsd: 0.08 });
    getDb().prepare("DELETE FROM audit_events WHERE kind = 'usage_monitor_replay_collision_skip'").run();
    const collidingKey = await push.usageMonitorV2IdempotencyKey(telemetryKey("llm", "llm-collide"));

    const captured: CapturedRequest[] = [];
    let calls = 0;
    push.__setUsageMonitorFetch((async (_url: unknown, init?: RequestInit) => {
      calls += 1;
      const rawBody = String(init?.body ?? "{}");
      captured.push({ rawBody, body: JSON.parse(rawBody) });
      if (calls === 1) {
        return new Response(
          JSON.stringify({ error: `Idempotency key collision for "${collidingKey}". Event content differs from the stored event.` }),
          { status: 409, headers: { "content-type": "application/json" } }
        );
      }
      return ack(JSON.parse(rawBody).events.length);
    }) as unknown as typeof fetch);

    const result = await replay.runUsageMonitorReplay();

    expect(result.llm).toEqual({ sent: 2, complete: true, failed: false });
    expect(calls).toBe(2); // first attempt 409'd; resend without the poison row ACKed
    const firstIds = captured[0]!.body.events.map((event) => event.eventId);
    expect(firstIds).toEqual([telemetryKey("llm", "llm-collide"), telemetryKey("llm", "llm-fresh")]);
    const resentIds = captured[1]!.body.events.map((event) => event.eventId);
    expect(resentIds).toEqual([telemetryKey("llm", "llm-fresh")]); // only the colliding row was dropped
    // Watermark advanced past BOTH rows (the collision row counts as delivered monitor-side).
    expect(storedWatermark(replay.USAGE_MONITOR_REPLAY_WATERMARK_KEYS.llm)).toEqual({
      createdAt: "2026-07-29T10:01:00.000Z",
      id: "llm-fresh",
    });
    // The skip is loudly audited, never silent.
    const skipAudit = getDb()
      .prepare("SELECT payload FROM audit_events WHERE kind = 'usage_monitor_replay_collision_skip'")
      .all() as Array<{ payload: string }>;
    expect(skipAudit).toHaveLength(1);
    expect(JSON.parse(skipAudit[0]!.payload)).toMatchObject({
      rowId: "llm-collide",
      idempotencyKey: collidingKey,
    });
  });

  it("still fails the pass when the monitor names a collision key that is NOT in the page", async () => {
    insertLlm({ id: "llm-innocent", createdAt: "2026-07-29T11:00:00.000Z", costUsd: 0.05 });
    push.__setUsageMonitorFetch((async () => new Response(
      JSON.stringify({ error: 'Idempotency key collision for "socratic-trade:llm:not-in-this-page".' }),
      { status: 409, headers: { "content-type": "application/json" } }
    )) as unknown as typeof fetch);

    const result = await replay.runUsageMonitorReplay();

    expect(result.llm).toEqual({ sent: 0, complete: false, failed: true });
    expect(storedWatermark(replay.USAGE_MONITOR_REPLAY_WATERMARK_KEYS.llm)).toBeNull();
  });

  it("replays persisted call-volume windows after an in-memory crash", async () => {
    push.recordProviderCall("massive", {
      ok: true,
      service: "market-data",
      label: "congress-read",
    });
    push.__setUsageMonitorFetch((async () => new Response("unavailable", { status: 503 })) as unknown as typeof fetch);
    await push.flushUsageMonitor();
    push.__resetUsageMonitorState();

    const captured: CapturedRequest[] = [];
    push.__setUsageMonitorFetch(fetchStub(captured));
    const first = await replay.runUsageMonitorReplay();
    expect(first.callVolume).toEqual({ sent: 1, complete: true, failed: false });
    const vol = captured.flatMap((request) => request.body.events).find((event) => event.provider === "massive");
    expect(vol).toMatchObject({
      project: "socratic-trade",
      provider: "massive",
      service: "market-data",
      requests: 1,
    });
    expect((vol?.metadata as Record<string, unknown> | undefined)?.label).toBe("congress-read");

    captured.length = 0;
    const second = await replay.runUsageMonitorReplay();
    expect(second.callVolume).toEqual({ sent: 0, complete: true, failed: false });
    expect(captured.flatMap((request) => request.body.events).some((event) => event.provider === "massive")).toBe(false);
  });
});
