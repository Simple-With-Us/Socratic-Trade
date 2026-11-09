import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL = `file:${join(tmpdir(), `socratic-fmp-telemetry-${randomUUID()}.db`)}`;

const usage = await import("../src/lib/usage-monitor-push");
const { getDb } = await import("../src/lib/db");
const { resetApiCircuitBreaker } = await import("../src/lib/api-circuit-breaker");
const { fetchWithRetry } = await import("../src/lib/data-providers");
const { resetOperationLeaseForTest } = await import("../src/lib/operation-lease");
const {
  resetProviderQuotaState: resetInMemoryProviderQuotaState,
  resetProviderRateLimiterState
} = await import("../src/lib/provider-rate-limit");
const replay = await import("../src/lib/usage-monitor-replay");
const { refreshFmpTranscripts } = await import("../src/lib/web-sources/fmp-transcripts");

const FMP_KEY = "fmp-telemetry-secret-never-log-this";

function usageAck(received = 1): Response {
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

function resetProviderQuotaState(provider: string): void {
  resetInMemoryProviderQuotaState(provider);
  replay.__resetUsageMonitorReplayState();
  getDb().prepare("DELETE FROM provider_usage_outbox WHERE provider = ?").run(provider);
  getDb().prepare("DELETE FROM provider_dispatch_attempts WHERE provider = ?").run(provider);
  const now = new Date().toISOString();
  getDb().transaction(() => {
    getDb().prepare("DELETE FROM settings WHERE key IN (?, ?, ?)").run(
      replay.USAGE_MONITOR_REPLAY_WATERMARK_KEYS.provider,
      replay.USAGE_MONITOR_REPLAY_V2_CUTOVER_KEYS.provider,
      `${replay.USAGE_MONITOR_REPLAY_V2_CUTOVER_KEYS.provider}:pre_v2_rows_skipped`
    );
    // Production establishes the direct-v2 boundary synchronously during instrumentation startup,
    // before FMP workers can dispatch. Preserve that ordering in these producer-focused tests.
    getDb().prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, 'v2-active', ?)")
      .run(replay.USAGE_MONITOR_REPLAY_V2_CUTOVER_KEYS.provider, now);
  }).immediate();
}

async function flushUsageTruth(): Promise<void> {
  await usage.flushUsageMonitor();
  await replay.runUsageMonitorReplay({ pageSize: 100, maxPagesPerLedger: 10 });
}

function emittedEvents(
  requests: Array<string | { rawBody: string }>
): Array<Record<string, unknown>> {
  return requests.flatMap((request) => {
    const body = typeof request === "string" ? request : request.rawBody;
    return (JSON.parse(body) as { events: Array<Record<string, unknown>> }).events;
  });
}

beforeAll(() => {
  process.env.WEB_SOURCE_FMP_TRANSCRIPTS = "on";
  process.env.FMP_TRANSCRIPT_STORAGE_RIGHTS_CONFIRMED = "on";
  process.env.FMP_API_KEY = FMP_KEY;
  process.env.FMP_TRANSCRIPT_HTTP_RETRIES = "1";
  process.env.FMP_TRANSCRIPT_RETRY_DELAY_MS = "0";
  process.env.PROVIDER_RATE_LIMIT_DISABLED = "1";
  process.env.API_CIRCUIT_BREAKER_DISABLED = "1";
  process.env.USAGE_MONITOR_BASE_URL = "https://usage.jays.services";
  process.env.USAGE_INGEST_TOKEN = "usage-test-token";
  process.env.USAGE_MONITOR_ENV = "test";
  // usage-monitor-knobs.ts's subscription->knob lane gates on the SAME USAGE_MONITOR_BASE_URL set
  // above (for the unrelated usage-push telemetry this file tests) and defaults ON once a base URL
  // is configured. Left enabled, resolveProviderQuota("fmp") triggers a background refresh fetch
  // that hits this file's own stubbed global `fetch` and gets miscounted as an FMP provider request
  // — disable it explicitly so this file's request-count assertions only see real FMP calls.
  process.env.USAGE_MONITOR_KNOBS_ENABLED = "off";
});

afterAll(() => {
  vi.unstubAllGlobals();
  usage.__resetUsageMonitorState();
  for (const key of [
    "WEB_SOURCE_FMP_TRANSCRIPTS",
    "FMP_TRANSCRIPT_STORAGE_RIGHTS_CONFIRMED",
    "FMP_API_KEY",
    "FMP_TRANSCRIPT_HTTP_RETRIES",
    "FMP_TRANSCRIPT_RETRY_DELAY_MS",
    "FMP_TRANSCRIPT_DATES_MAX_RESPONSE_BYTES",
    "PROVIDER_RATE_LIMIT_DISABLED",
    "API_CIRCUIT_BREAKER_DISABLED",
    "API_CIRCUIT_BREAKER_BACKOFF_MS",
    "USAGE_MONITOR_BASE_URL",
    "USAGE_INGEST_TOKEN",
    "USAGE_MONITOR_ENV",
    "USAGE_MONITOR_KNOBS_ENABLED"
  ]) delete process.env[key];
});

describe.skip("FMP transcript attempt telemetry [retired: requestFmpJson hard-blocked]", () => {
  it("sends every failed upstream attempt to usage.jays.services without key, URL, or body data", async () => {
    usage.__resetUsageMonitorState();
    resetOperationLeaseForTest();
    resetProviderQuotaState("fmp");
    resetProviderRateLimiterState("fmp");
    getDb().prepare("DELETE FROM settings WHERE key LIKE 'webSource:fmpTranscripts:%'").run();
    getDb().prepare("DELETE FROM api_health_log WHERE service IN ('fmp', 'fmp-transcripts')").run();

    const usageRequests: Array<{ url: string; rawBody: string }> = [];
    usage.__setUsageMonitorFetch((async (url: unknown, init?: RequestInit) => {
      usageRequests.push({ url: String(url), rawBody: String(init?.body ?? "") });
      return usageAck();
    }) as typeof fetch);

    const providerRequests: Array<{ url: string; apiKey: string | null }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      providerRequests.push({ url: String(url), apiKey: new Headers(init?.headers).get("apikey") });
      return new Response(`PROVIDER_BODY_MARKER ${FMP_KEY}`, { status: 503 });
    }));

    const result = await refreshFmpTranscripts(["AAPL"], Date.UTC(2026, 6, 13, 12), {
      force: true,
      maxRequests: 2
    });
    expect(result).toMatchObject({ requests: 2, ingested: 0, capability: "unknown" });
    expect(providerRequests).toHaveLength(2);
    for (const request of providerRequests) {
      expect(request.url).toContain("/stable/earning-call-transcript-dates");
      expect(request.url).not.toContain(FMP_KEY);
      expect(request.apiKey).toBe(FMP_KEY);
    }
    expect(
      getDb().prepare(
        "SELECT service, COUNT(*) AS count FROM api_health_log WHERE service IN ('fmp', 'fmp-transcripts') GROUP BY service"
      ).all()
    ).toEqual([{ service: "fmp-transcripts", count: 2 }]);

    await flushUsageTruth();
    expect(usageRequests).toHaveLength(1);
    expect(usageRequests[0]!.url).toBe("https://usage.jays.services/api/ingest/usage");
    expect(usageRequests[0]!.rawBody).not.toContain(FMP_KEY);
    expect(usageRequests[0]!.rawBody).not.toContain("PROVIDER_BODY_MARKER");
    expect(usageRequests[0]!.rawBody).not.toContain("earning-call-transcript-dates");
    expect(JSON.parse(usageRequests[0]!.rawBody)).toMatchObject({
      schemaVersion: 2,
      producerId: "socratic-trade",
    });

    const fmpEvents = emittedEvents(usageRequests).filter((event) => event.provider === "fmp");
    expect(fmpEvents).toHaveLength(2);
    expect(fmpEvents.reduce((sum, event) => sum + Number(event.requests ?? 0), 0)).toBe(2);
    for (const event of fmpEvents) {
      expect(event).toMatchObject({
        environment: "test",
        service: "provider-dispatch",
        billingMode: "estimated",
        metricType: "usage",
        unit: "request",
        requests: 1,
        confidence: "actual",
        metadata: { outcome: "failed", userId: "local", unknownOutcome: false }
      });
    }
  });

  it.each([
    {
      label: "malformed JSON",
      body: `{"PROVIDER_BODY_MARKER":"${FMP_KEY}"`,
      headers: new Headers({ "content-type": "application/json" }),
      maxBytes: undefined,
      expectedResultError: "dates:AAPL:transient",
      expectedHealthError: "HTTP 200 response body was invalid or incomplete JSON/UTF-8."
    },
    {
      label: "invalid UTF-8",
      body: Uint8Array.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]).buffer,
      headers: new Headers({ "content-type": "application/json" }),
      maxBytes: undefined,
      expectedResultError: "dates:AAPL:transient",
      expectedHealthError: "HTTP 200 response body was invalid or incomplete JSON/UTF-8."
    },
    {
      label: "embedded provider error object",
      body: JSON.stringify({ "Error Message": `PROVIDER_BODY_MARKER ${FMP_KEY}` }),
      headers: new Headers({ "content-type": "application/json" }),
      maxBytes: undefined,
      expectedResultError: "dates:AAPL:transient",
      expectedHealthError: "HTTP 200 response body did not match the expected FMP endpoint schema."
    },
    {
      label: "oversized JSON",
      body: JSON.stringify({ PROVIDER_BODY_MARKER: FMP_KEY }),
      headers: new Headers({ "content-type": "application/json", "content-length": "4096" }),
      maxBytes: "32",
      expectedResultError: "dates:AAPL:response_too_large",
      expectedHealthError: "HTTP 200 response exceeded the configured byte limit."
    }
  ])(
    "records one redacted failed attempt and no green telemetry for an HTTP 200 $label body",
    async ({ body, headers, maxBytes, expectedResultError, expectedHealthError }) => {
      usage.__resetUsageMonitorState();
      resetOperationLeaseForTest();
      resetProviderQuotaState("fmp");
      resetProviderRateLimiterState("fmp");
      process.env.API_CIRCUIT_BREAKER_DISABLED = "1";
      if (maxBytes) process.env.FMP_TRANSCRIPT_DATES_MAX_RESPONSE_BYTES = maxBytes;
      else delete process.env.FMP_TRANSCRIPT_DATES_MAX_RESPONSE_BYTES;
      getDb().prepare("DELETE FROM settings WHERE key LIKE 'webSource:fmpTranscripts:%'").run();
      getDb().prepare("DELETE FROM api_health_log WHERE service IN ('fmp', 'fmp-transcripts')").run();

      const usageRequests: string[] = [];
      usage.__setUsageMonitorFetch((async (_url: unknown, init?: RequestInit) => {
        usageRequests.push(String(init?.body ?? ""));
        return usageAck();
      }) as typeof fetch);
      const providerFetch = vi.fn(async () => new Response(body, { status: 200, headers }));
      vi.stubGlobal("fetch", providerFetch);

      const result = await refreshFmpTranscripts(["AAPL"], Date.UTC(2026, 6, 13, 12), {
        force: true,
        maxRequests: 1
      });

      expect(result).toMatchObject({ requests: 1, ingested: 0, capability: "unknown" });
      expect(result.errors).toEqual([expectedResultError]);
      expect(providerFetch).toHaveBeenCalledTimes(1);
      const healthRows = getDb().prepare(
        `SELECT service, ok, error_text
         FROM api_health_log
         WHERE service IN ('fmp', 'fmp-transcripts')
         ORDER BY rowid`
      ).all();
      expect(healthRows).toEqual([{
        service: "fmp-transcripts",
        ok: 0,
        error_text: expectedHealthError
      }]);
      expect(JSON.stringify(healthRows)).not.toContain(FMP_KEY);
      expect(JSON.stringify(healthRows)).not.toContain("PROVIDER_BODY_MARKER");
      expect(JSON.stringify(healthRows)).not.toContain("earning-call-transcript-dates");

      await flushUsageTruth();
      expect(usageRequests).toHaveLength(1);
      expect(usageRequests[0]).not.toContain(FMP_KEY);
      expect(usageRequests[0]).not.toContain("PROVIDER_BODY_MARKER");
      expect(usageRequests[0]).not.toContain("earning-call-transcript-dates");
      const fmpEvents = emittedEvents(usageRequests).filter((event) => event.provider === "fmp");
      expect(fmpEvents).toHaveLength(1);
      expect(fmpEvents[0]).toMatchObject({
        requests: 1,
        confidence: "actual",
        metadata: { outcome: "failed", userId: "local", unknownOutcome: false }
      });
      delete process.env.FMP_TRANSCRIPT_DATES_MAX_RESPONSE_BYTES;
    }
  );

  it("records dates green and an embedded body error red without a false body success", async () => {
    usage.__resetUsageMonitorState();
    resetOperationLeaseForTest();
    resetProviderQuotaState("fmp");
    resetProviderRateLimiterState("fmp");
    process.env.API_CIRCUIT_BREAKER_DISABLED = "1";
    getDb().prepare("DELETE FROM settings WHERE key LIKE 'webSource:fmpTranscripts:%'").run();
    getDb().prepare("DELETE FROM api_health_log WHERE service IN ('fmp', 'fmp-transcripts')").run();

    const usageRequests: string[] = [];
    usage.__setUsageMonitorFetch((async (_url: unknown, init?: RequestInit) => {
      usageRequests.push(String(init?.body ?? ""));
      return usageAck();
    }) as typeof fetch);
    const providerFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { symbol: "AAPL", year: 2026, quarter: 2, date: "2026-07-13" }
      ]), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [],
        "Error Message": `PROVIDER_BODY_MARKER ${FMP_KEY}`
      }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", providerFetch);

    const result = await refreshFmpTranscripts(["AAPL"], Date.UTC(2026, 6, 13, 12), {
      force: true,
      maxRequests: 2
    });

    expect(result).toMatchObject({ requests: 2, ingested: 0, capability: "unknown" });
    expect(result.errors).toEqual(["body:AAPL:transient"]);
    expect(providerFetch).toHaveBeenCalledTimes(2);
    const healthRows = getDb().prepare(
      `SELECT service, ok, error_text
       FROM api_health_log
       WHERE service = 'fmp-transcripts'
       ORDER BY rowid`
    ).all();
    expect(healthRows).toEqual([
      { service: "fmp-transcripts", ok: 1, error_text: null },
      {
        service: "fmp-transcripts",
        ok: 0,
        error_text: "HTTP 200 response body did not match the expected FMP endpoint schema."
      }
    ]);
    expect(JSON.stringify(healthRows)).not.toContain(FMP_KEY);
    expect(JSON.stringify(healthRows)).not.toContain("PROVIDER_BODY_MARKER");

    await flushUsageTruth();
    expect(usageRequests).toHaveLength(1);
    expect(usageRequests[0]).not.toContain(FMP_KEY);
    expect(usageRequests[0]).not.toContain("PROVIDER_BODY_MARKER");
    const fmpEvents = emittedEvents(usageRequests).filter((event) => event.provider === "fmp");
    expect(fmpEvents).toHaveLength(2);
    expect(fmpEvents.map((event) => (event.metadata as { outcome: string }).outcome).sort())
      .toEqual(["failed", "succeeded"]);
    expect(fmpEvents.reduce((sum, event) => sum + Number(event.requests ?? 0), 0)).toBe(2);
  });

  it("preserves legacy service-only health and usage attribution", async () => {
    process.env.API_CIRCUIT_BREAKER_DISABLED = "1";
    resetApiCircuitBreaker();
    getDb().prepare("DELETE FROM api_health_log WHERE service IN ('fmp', 'fmp-transcripts')").run();
    const providerFetch = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", providerFetch);

    await fetchWithRetry("https://provider.invalid/stable/example", { method: "GET" }, {
      service: "fmp",
      keySource: "env",
      userId: "local",
      retries: 0
    });

    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect(
      getDb().prepare(
        "SELECT service, ok FROM api_health_log WHERE service IN ('fmp', 'fmp-transcripts') ORDER BY service"
      ).all()
    ).toEqual([{ service: "fmp", ok: 1 }]);
  });

  it("writes no health, usage, audit, or settings after durable ownership is lost inside transport", async () => {
    usage.__resetUsageMonitorState();
    resetOperationLeaseForTest();
    resetProviderQuotaState("fmp");
    resetProviderRateLimiterState("fmp");
    process.env.API_CIRCUIT_BREAKER_DISABLED = "1";
    getDb().prepare("DELETE FROM settings WHERE key LIKE 'webSource:fmpTranscripts:%'").run();
    getDb().prepare("DELETE FROM api_health_log WHERE service IN ('fmp', 'fmp-transcripts')").run();
    getDb().prepare("DELETE FROM audit_events WHERE kind LIKE 'fmp_transcript%'").run();

    const usageRequests: string[] = [];
    usage.__setUsageMonitorFetch((async (_url: unknown, init?: RequestInit) => {
      usageRequests.push(String(init?.body ?? ""));
      return usageAck();
    }) as typeof fetch);

    let settingsAtLoss: unknown[] = [];
    let auditsAtLoss: unknown[] = [];
    const providerFetch = vi.fn(async () => {
      settingsAtLoss = getDb().prepare(
        "SELECT key, value FROM settings WHERE key <> 'operation_lease:rag-reindex' ORDER BY key"
      ).all();
      auditsAtLoss = getDb().prepare(
        "SELECT kind, payload FROM audit_events WHERE kind LIKE 'fmp_transcript%' ORDER BY rowid"
      ).all();
      getDb().prepare("DELETE FROM settings WHERE key = 'operation_lease:rag-reindex'").run();
      throw new Error("synthetic transport failure after lease theft");
    });
    vi.stubGlobal("fetch", providerFetch);

    await expect(
      refreshFmpTranscripts(["AAPL"], Date.UTC(2026, 6, 13, 13), { force: true, maxRequests: 1 })
    ).rejects.toThrow(/lease/i);

    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect(getDb().prepare(
      "SELECT service, ok, error_text FROM api_health_log WHERE service IN ('fmp', 'fmp-transcripts') ORDER BY rowid"
    ).all()).toEqual([]);
    expect(getDb().prepare(
      "SELECT kind, payload FROM audit_events WHERE kind LIKE 'fmp_transcript%' ORDER BY rowid"
    ).all()).toEqual(auditsAtLoss);
    expect(getDb().prepare(
      "SELECT key, value FROM settings WHERE key <> 'operation_lease:rag-reindex' ORDER BY key"
    ).all()).toEqual(settingsAtLoss);

    await flushUsageTruth();
    const fmpEvents = emittedEvents(usageRequests).filter((event) => event.provider === "fmp");
    expect(fmpEvents).toHaveLength(1);
    expect(fmpEvents[0]).toMatchObject({
      requests: 1,
      confidence: "actual",
      metadata: { outcome: "failed", userId: "local", unknownOutcome: false }
    });
    resetOperationLeaseForTest();
  });

  it("fences a successful transport response before health or usage telemetry after lease loss", async () => {
    usage.__resetUsageMonitorState();
    resetOperationLeaseForTest();
    resetProviderQuotaState("fmp");
    resetProviderRateLimiterState("fmp");
    process.env.API_CIRCUIT_BREAKER_DISABLED = "1";
    getDb().prepare("DELETE FROM settings WHERE key LIKE 'webSource:fmpTranscripts:%'").run();
    getDb().prepare("DELETE FROM api_health_log WHERE service IN ('fmp', 'fmp-transcripts')").run();
    getDb().prepare("DELETE FROM audit_events WHERE kind LIKE 'fmp_transcript%'").run();
    const usageRequests: string[] = [];
    usage.__setUsageMonitorFetch((async (_url: unknown, init?: RequestInit) => {
      usageRequests.push(String(init?.body ?? ""));
      return usageAck();
    }) as typeof fetch);
    let settingsAtLoss: unknown[] = [];
    const providerFetch = vi.fn(async () => {
      settingsAtLoss = getDb().prepare(
        "SELECT key, value FROM settings WHERE key <> 'operation_lease:rag-reindex' ORDER BY key"
      ).all();
      getDb().prepare("DELETE FROM settings WHERE key = 'operation_lease:rag-reindex'").run();
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", providerFetch);

    await expect(
      refreshFmpTranscripts(["AAPL"], Date.UTC(2026, 6, 13, 14), { force: true, maxRequests: 1 })
    ).rejects.toThrow(/lease/i);

    expect(getDb().prepare(
      "SELECT service, ok FROM api_health_log WHERE service IN ('fmp', 'fmp-transcripts') ORDER BY rowid"
    ).all()).toEqual([]);
    expect(getDb().prepare(
      "SELECT kind FROM audit_events WHERE kind LIKE 'fmp_transcript%' ORDER BY rowid"
    ).all()).toEqual([]);
    expect(getDb().prepare(
      "SELECT key, value FROM settings WHERE key <> 'operation_lease:rag-reindex' ORDER BY key"
    ).all()).toEqual(settingsAtLoss);
    await flushUsageTruth();
    const fmpEvents = emittedEvents(usageRequests).filter((event) => event.provider === "fmp");
    expect(fmpEvents).toHaveLength(1);
    expect(fmpEvents[0]).toMatchObject({
      requests: 1,
      confidence: "estimated",
      metadata: { outcome: "unknown", userId: "local", unknownOutcome: true }
    });
    resetOperationLeaseForTest();
  });

  it.each(["dates", "body"] as const)(
    "rechecks ownership after delayed terminal %s-response discard before cursor or capability writes",
    async (stage) => {
      usage.__resetUsageMonitorState();
      usage.__setUsageMonitorFetch((async () => (
        usageAck()
      )) as typeof fetch);
      resetOperationLeaseForTest();
      resetProviderQuotaState("fmp");
      resetProviderRateLimiterState("fmp");
      process.env.API_CIRCUIT_BREAKER_DISABLED = "1";
      getDb().prepare("DELETE FROM settings WHERE key LIKE 'webSource:fmpTranscripts:%'").run();
      getDb().prepare("DELETE FROM api_health_log WHERE service IN ('fmp', 'fmp-transcripts')").run();
      getDb().prepare("DELETE FROM audit_events WHERE kind LIKE 'fmp_transcript%'").run();

      const stateSnapshot = () => ({
        settings: getDb().prepare(
          "SELECT key, value FROM settings WHERE key LIKE 'webSource:fmpTranscripts:%' ORDER BY key"
        ).all(),
        audits: getDb().prepare(
          "SELECT kind, payload FROM audit_events WHERE kind LIKE 'fmp_transcript%' ORDER BY rowid"
        ).all()
      });
      let rowsAtLoss = stateSnapshot();
      let cancelEntered!: () => void;
      let releaseCancel!: () => void;
      const entered = new Promise<void>((resolve) => { cancelEntered = resolve; });
      const released = new Promise<void>((resolve) => { releaseCancel = resolve; });
      const deniedBody = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("endpoint not entitled"));
        },
        async cancel() {
          rowsAtLoss = stateSnapshot();
          getDb().prepare("DELETE FROM settings WHERE key = 'operation_lease:rag-reindex'").run();
          cancelEntered();
          await released;
        }
      });
      let providerCalls = 0;
      const providerFetch = vi.fn(async () => {
        providerCalls += 1;
        if (stage === "body" && providerCalls === 1) {
          return new Response(JSON.stringify([
            { symbol: "AAPL", year: 2026, period: "Q1", date: "2026-04-30" }
          ]), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response(deniedBody, { status: 402 });
      });
      vi.stubGlobal("fetch", providerFetch);

      const pending = refreshFmpTranscripts(["AAPL"], Date.UTC(2026, 6, 13, 15), {
        force: true,
        maxRequests: stage === "dates" ? 1 : 2
      });
      await entered;
      releaseCancel();

      await expect(pending).rejects.toThrow(/lease/i);
      expect(providerFetch).toHaveBeenCalledTimes(stage === "dates" ? 1 : 2);
      expect(stateSnapshot()).toEqual(rowsAtLoss);
      expect(
        getDb().prepare(
          "SELECT value FROM settings WHERE key = 'webSource:fmpTranscripts:capability'"
        ).get()
      ).toBeUndefined();
      resetOperationLeaseForTest();
      usage.__resetUsageMonitorState();
    }
  );

  it("uses the transcript health lane for circuit admission without charging a skipped FMP request", async () => {
    process.env.API_CIRCUIT_BREAKER_DISABLED = "0";
    process.env.API_CIRCUIT_BREAKER_BACKOFF_MS = "60000";
    resetApiCircuitBreaker();
    resetOperationLeaseForTest();
    resetProviderQuotaState("fmp");
    resetProviderRateLimiterState("fmp");
    getDb().prepare("DELETE FROM settings WHERE key LIKE 'webSource:fmpTranscripts:%'").run();
    getDb().prepare("DELETE FROM api_health_log WHERE service IN ('fmp', 'fmp-transcripts')").run();
    const insert = getDb().prepare(
      `INSERT INTO api_health_log (id, service, ts, ok, latency_ms, error_text, key_source, user_id)
       VALUES (?, 'fmp-transcripts', ?, 0, 1, 'HTTP 503', 'env', 'local')`
    );
    for (let index = 0; index < 5; index++) {
      insert.run(randomUUID(), new Date(Date.now() - index * 1_000).toISOString());
    }
    const providerFetch = vi.fn(async () => new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", providerFetch);

    const result = await refreshFmpTranscripts(["AAPL"], Date.now(), { force: true, maxRequests: 1 });

    expect(result).toMatchObject({ requests: 0, ingested: 0, capability: "unknown" });
    expect(result.errors).toEqual(["dates:AAPL:circuit-open"]);
    expect(providerFetch).not.toHaveBeenCalled();
    expect(
      getDb().prepare("SELECT COUNT(*) AS count FROM api_health_log WHERE service = 'fmp'").get()
    ).toEqual({ count: 0 });

    process.env.API_CIRCUIT_BREAKER_DISABLED = "1";
    delete process.env.API_CIRCUIT_BREAKER_BACKOFF_MS;
    resetApiCircuitBreaker();
  });
});
