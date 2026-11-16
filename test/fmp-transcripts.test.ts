import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

beforeAll(async () => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `socratic-fmp-transcripts-${randomUUID()}.db`)}`;
  process.env.FMP_API_KEY = "test-fmp-key";
  // Force the one-time migration/module load outside the per-test 10s hook budget. On a busy
  // multi-agent host this cold import can take longer even though subsequent DB operations are fast.
  const { getDb } = await import("../src/lib/db");
  getDb();
}, 60_000);

const mocks = vi.hoisted(() => ({
  fetchWithRetry: vi.fn(),
  admitProviderRequests: vi.fn(() => 1),
  refundProviderRequests: vi.fn(),
  withProviderLimit: vi.fn(async (_provider: string, work: () => Promise<unknown>) => work()),
  hasIngestTextBudget: vi.fn(() => true),
  hasPineconeWriteBudget: vi.fn(() => true),
  storeDocument: vi.fn(),
  getCurrentVectorProviderAuthority: vi.fn(),
  managedVectorLedgerAuthority: vi.fn(),
  vectorTenantScope: vi.fn(),
  managedOccurrenceVectorPrefix: vi.fn(),
  managedOccurrenceVectorIdMatches: vi.fn(),
  managedVectorReceiptEvidence: vi.fn(),
  inventoryVectorRecordsByMetadata: vi.fn(),
  fetchExistingVectorRecordIds: vi.fn(),
  purgeVectorRecordsByMetadata: vi.fn(),
  purgeVectorRecordIds: vi.fn(),
  purgeVectorNamespaceAll: vi.fn()
}));

vi.mock("../src/lib/provider-rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/provider-rate-limit")>();
  return {
    ...actual,
    admitProviderRequests: mocks.admitProviderRequests,
    refundProviderRequests: mocks.refundProviderRequests,
    withProviderLimit: mocks.withProviderLimit
  };
});

vi.mock("../src/lib/data-providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/data-providers")>();
  return {
    ...actual,
    apiKeyFingerprint: () => "test-fingerprint",
    fetchWithRetry: async (...args: Parameters<typeof actual.fetchWithRetry>) => {
      const durable = args[2]?.durableAttempt;
      durable?.onDispatch();
      try {
        const response = await mocks.fetchWithRetry(...args);
        durable?.onResponse?.(response);
        return response;
      } catch (error) {
        durable?.onTransportError?.(error);
        throw error;
      }
    }
  };
});

vi.mock("../src/lib/vector-db", () => ({
  hasIngestTextBudget: mocks.hasIngestTextBudget,
  hasPineconeWriteBudget: mocks.hasPineconeWriteBudget,
  storeDocument: async (...args: unknown[]) => {
    const result = await mocks.storeDocument(...args);
    return result?.documentComplete === true
      ? { ...result, managedCommitProof: result.managedCommitProof ?? { commitId: "test:fmp", attemptToken: "test:fmp" } }
      : result;
  },
  getCurrentVectorProviderAuthority: mocks.getCurrentVectorProviderAuthority,
  managedVectorLedgerAuthority: mocks.managedVectorLedgerAuthority,
  vectorTenantScope: mocks.vectorTenantScope,
  managedOccurrenceVectorPrefix: mocks.managedOccurrenceVectorPrefix,
  managedOccurrenceVectorIdMatches: mocks.managedOccurrenceVectorIdMatches,
  managedVectorReceiptEvidence: mocks.managedVectorReceiptEvidence,
  inventoryVectorRecordsByMetadata: mocks.inventoryVectorRecordsByMetadata,
  fetchExistingVectorRecordIds: mocks.fetchExistingVectorRecordIds,
  purgeVectorRecordsByMetadata: mocks.purgeVectorRecordsByMetadata,
  purgeVectorRecordIds: mocks.purgeVectorRecordIds,
  purgeVectorNamespaceAll: mocks.purgeVectorNamespaceAll
}));

vi.mock("../src/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/db")>();
  return {
    ...actual,
    runWithActiveVectorCommitProof: <T>(_proof: unknown, work: () => T) => work()
  };
});

vi.mock("../src/lib/db-vector-commits", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/db-vector-commits")>();
  return {
    ...actual,
    runWithActiveVectorCommitProof: <T>(_proof: unknown, work: () => T) => work()
  };
});

function jsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  return new Response(JSON.stringify(payload), {
    ...init,
    status: init.status ?? 200,
    headers
  });
}

beforeEach(async () => {
  process.env.WEB_SOURCE_FMP_TRANSCRIPTS = "on";
  process.env.FMP_TRANSCRIPT_STORAGE_RIGHTS_CONFIRMED = "on";
  delete process.env.FMP_TRANSCRIPT_DATES_MAX_RESPONSE_BYTES;
  delete process.env.FMP_TRANSCRIPT_BODY_MAX_RESPONSE_BYTES;
  delete process.env.FMP_TRANSCRIPT_MAX_REQUESTS_PER_RUN;
  delete process.env.FMP_TRANSCRIPT_MAX_PER_SYMBOL;
  delete process.env.FMP_TRANSCRIPT_HTTP_RETRIES;
  delete process.env.FMP_TRANSCRIPT_RETRY_DELAY_MS;
  vi.clearAllMocks();
  mocks.admitProviderRequests.mockReturnValue(1);
  mocks.hasIngestTextBudget.mockReturnValue(true);
  mocks.hasPineconeWriteBudget.mockReturnValue(true);
  mocks.getCurrentVectorProviderAuthority.mockResolvedValue("test-current-authority");
  mocks.managedVectorLedgerAuthority.mockReturnValue("ledger:v1:test-current-authority");
  mocks.vectorTenantScope.mockReturnValue("shared:operator");
  mocks.managedOccurrenceVectorPrefix.mockReturnValue("occ:v3:test-current:");
  mocks.managedOccurrenceVectorIdMatches.mockReturnValue(false);
  mocks.managedVectorReceiptEvidence.mockReturnValue([]);
  mocks.inventoryVectorRecordsByMetadata.mockResolvedValue([]);
  mocks.fetchExistingVectorRecordIds.mockResolvedValue([]);
  mocks.purgeVectorRecordIds.mockImplementation(async ({ ids }) => ({ ids, deleted: ids.length }));
  mocks.purgeVectorNamespaceAll.mockResolvedValue(undefined);
  mocks.storeDocument.mockResolvedValue({
    attempted: 2,
    indexed: 2,
    documentComplete: true,
    managedCommitProof: { commitId: "test:fmp", attemptToken: "test:fmp" }
  });

  const { getDb } = await import("../src/lib/db");
  getDb().prepare("DELETE FROM settings WHERE key LIKE 'webSource:fmpTranscripts:%'").run();
  getDb().prepare("DELETE FROM settings WHERE key = 'operation_lease:rag-reindex'").run();
  getDb().prepare("DELETE FROM ingested_accessions WHERE doc_type = 'earnings-transcript'").run();
  getDb().prepare("DELETE FROM fmp_transcript_versions").run();
  getDb().prepare("DELETE FROM provider_usage_outbox").run();
  getDb().prepare("DELETE FROM provider_dispatch_attempts WHERE provider = 'fmp'").run();
}, 30_000);

afterEach(() => {
  delete process.env.WEB_SOURCE_FMP_TRANSCRIPTS;
  delete process.env.FMP_TRANSCRIPT_STORAGE_RIGHTS_CONFIRMED;
});

describe("fmpTranscriptCapThisVisit", () => {
  it("takes only the latest until it is stored, then deepens high-interest names only", async () => {
    const { fmpTranscriptCapThisVisit } = await import("../src/lib/web-sources/fmp-transcripts");
    expect(fmpTranscriptCapThisVisit({ latestStored: false, highInterest: false, maxPerSymbol: 2 })).toBe(1);
    expect(fmpTranscriptCapThisVisit({ latestStored: false, highInterest: true, maxPerSymbol: 2 })).toBe(1);
    expect(fmpTranscriptCapThisVisit({ latestStored: true, highInterest: true, maxPerSymbol: 2 })).toBe(2);
    expect(fmpTranscriptCapThisVisit({ latestStored: true, highInterest: false, maxPerSymbol: 2 })).toBe(0);
  });
});

describe("FMP transcript contracts", () => {
  it("requires both the producer flag and explicit content-storage rights confirmation", async () => {
    const { fmpTranscriptsEnabled } = await import("../src/lib/web-sources/fmp-transcripts");

    expect(fmpTranscriptsEnabled("on", "on")).toBe(true);
    expect(fmpTranscriptsEnabled("on", "off")).toBe(false);
    expect(fmpTranscriptsEnabled("off", "on")).toBe(false);
  });

  it("validates endpoint-specific envelopes and rejects embedded HTTP 200 provider errors", async () => {
    const { isValidFmpEndpointPayload } = await import("../src/lib/web-sources/fmp-transcripts");
    const dateRow = { symbol: "AAPL", year: 2025, quarter: 2, date: "2025-05-01" };
    const bodyRow = {
      symbol: "AAPL",
      year: 2025,
      period: "Q2",
      content: "Operator introduction. Management discussed results and outlook."
    };

    expect(isValidFmpEndpointPayload([dateRow], "dates")).toBe(true);
    expect(isValidFmpEndpointPayload({ data: [dateRow] }, "dates")).toBe(true);
    expect(isValidFmpEndpointPayload([], "dates")).toBe(true);
    expect(isValidFmpEndpointPayload([bodyRow], "body")).toBe(true);
    expect(isValidFmpEndpointPayload({ data: [bodyRow] }, "body")).toBe(true);
    expect(isValidFmpEndpointPayload([], "body")).toBe(true);

    expect(isValidFmpEndpointPayload({ "Error Message": "upgrade required" }, "dates")).toBe(false);
    expect(isValidFmpEndpointPayload({ data: [], error: "upgrade required" }, "dates")).toBe(false);
    expect(isValidFmpEndpointPayload({ data: [], message: "quota exceeded" }, "body")).toBe(false);
    expect(isValidFmpEndpointPayload({ data: [dateRow], success: false }, "dates")).toBe(false);
    expect(isValidFmpEndpointPayload([{ ...dateRow, errorCode: 402 }], "dates")).toBe(false);
    expect(isValidFmpEndpointPayload([dateRow], "body")).toBe(false);
    expect(isValidFmpEndpointPayload([bodyRow], "dates")).toBe(false);
    expect(isValidFmpEndpointPayload({ data: "not-an-array" }, "dates")).toBe(false);
  });

  it("uses ticker-inclusive identities and fair cursor rotation", async () => {
    const { rotateSymbolsAfterCursor, transcriptAccession } = await import(
      "../src/lib/web-sources/fmp-transcripts"
    );

    expect(transcriptAccession("aapl", 2025, 2)).toBe("FMP-EARNINGS-TRANSCRIPT:AAPL:2025:Q2");
    expect(transcriptAccession("MSFT", 2025, 2)).not.toBe(transcriptAccession("AAPL", 2025, 2));
    expect(rotateSymbolsAfterCursor(["AAPL", "MSFT", "AAPL", "NVDA"], "MSFT")).toEqual([
      "NVDA",
      "AAPL",
      "MSFT"
    ]);
  });

  it("parses exact periods and never executes hostile accessors, iterators, or coercions", async () => {
    const { parseFmpTranscriptBody, parseFmpTranscriptDates, rotateSymbolsAfterCursor } = await import(
      "../src/lib/web-sources/fmp-transcripts"
    );
    let getterCalls = 0;
    let iteratorCalls = 0;
    let coercionCalls = 0;
    const hostileRow: Record<string, unknown> = {};
    Object.defineProperty(hostileRow, "symbol", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "AAPL";
      }
    });
    const hostileRows = [hostileRow];
    Object.defineProperty(hostileRows, Symbol.iterator, {
      value() {
        iteratorCalls += 1;
        throw new Error("iterator must not run");
      }
    });
    const hostileSymbol = {
      toString() {
        coercionCalls += 1;
        return "AAPL";
      }
    };
    const prototypeOnlyRow = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(prototypeOnlyRow, "__proto__", {
      enumerable: true,
      value: { symbol: "AAPL", year: 2025, quarter: 1 }
    });
    const hostileArrayProxy = new Proxy([], {
      getOwnPropertyDescriptor() {
        throw new Error("descriptor trap must not escape");
      }
    });
    const revokedArray = Proxy.revocable([], {});
    revokedArray.revoke();

    expect(parseFmpTranscriptDates(hostileRows, "AAPL")).toEqual([]);
    expect(parseFmpTranscriptDates(hostileArrayProxy, "AAPL")).toEqual([]);
    expect(parseFmpTranscriptDates(revokedArray.proxy, "AAPL")).toEqual([]);
    expect(parseFmpTranscriptDates([prototypeOnlyRow], "AAPL")).toEqual([]);
    expect(parseFmpTranscriptBody(hostileRows, { symbol: "AAPL", year: 2025, quarter: 1 })).toBeUndefined();
    expect(rotateSymbolsAfterCursor([hostileSymbol as unknown as string, "MSFT"], undefined)).toEqual(["MSFT"]);
    expect({ getterCalls, iteratorCalls, coercionCalls }).toEqual({
      getterCalls: 0,
      iteratorCalls: 0,
      coercionCalls: 0
    });

    const dates = parseFmpTranscriptDates(
      [
        { symbol: "AAPL", year: 2025, quarter: 1, date: "2025-01-30 17:00:00" },
        { symbol: "MSFT", year: 2025, quarter: 1, date: "2025-01-29" }
      ],
      "AAPL"
    );
    expect(dates).toEqual([
      { symbol: "AAPL", year: 2025, quarter: 1, callDate: "2025-01-30T00:00:00.000Z" }
    ]);
    expect(
      parseFmpTranscriptBody(
        [{ symbol: "AAPL", year: 2025, quarter: 1, content: "Management discussion. ".repeat(10) }],
        dates[0]!
      )
    ).toMatchObject({ symbol: "AAPL", year: 2025, quarter: 1 });

    // FMP's current stable guide documents transcript bodies with `period: "Q3"`, not a
    // numeric `quarter`. Keep numeric compatibility while accepting only strict Q1-Q4 periods.
    expect(
      parseFmpTranscriptBody(
        [{
          symbol: "AAPL",
          year: 2025,
          period: "Q3",
          date: "2025-07-31 17:00:00",
          content: "Operator introduction. Management discusses results and outlook. ".repeat(8)
        }],
        { symbol: "AAPL", year: 2025, quarter: 3 }
      )
    ).toMatchObject({ symbol: "AAPL", year: 2025, quarter: 3 });
    expect(
      parseFmpTranscriptDates([{ symbol: "AAPL", year: 2025, period: "quarter-3" }], "AAPL")
    ).toEqual([]);
  });
});

describe.skip("refreshFmpTranscripts [retired: requestFmpJson hard-blocked]", () => {
  it("rejects user-scoped producer runs before any provider or vector work", async () => {
    const { refreshFmpTranscripts } = await import("../src/lib/web-sources/fmp-transcripts");

    await expect(refreshFmpTranscripts(["AAPL"], Date.UTC(2025, 0, 31), {
      force: true,
      maxRequests: 1,
      userId: "user-123"
    })).rejects.toThrow("operator-owned shared producer");
    expect(mocks.fetchWithRetry).not.toHaveBeenCalled();
    expect(mocks.storeDocument).not.toHaveBeenCalled();
  });

  it("does no key, lease, marker, or network work while either opt-in is absent", async () => {
    process.env.FMP_TRANSCRIPT_STORAGE_RIGHTS_CONFIRMED = "off";
    const { refreshFmpTranscripts } = await import("../src/lib/web-sources/fmp-transcripts");
    const { getDb } = await import("../src/lib/db");

    const result = await refreshFmpTranscripts(["AAPL"], Date.UTC(2025, 0, 31), { force: true });

    expect(result).toMatchObject({
      enabled: false,
      capability: "disabled",
      disabledReason: "storage_rights_unconfirmed",
      requests: 0
    });
    expect(mocks.fetchWithRetry).not.toHaveBeenCalled();
    expect(
      getDb().prepare("SELECT COUNT(*) AS count FROM settings WHERE key LIKE 'webSource:fmpTranscripts:%'").get()
    ).toEqual({ count: 0 });
  });

  it("anchors PIT availability to the actual body receipt, not an old caller run-start time", async () => {
    const callerNow = Date.UTC(2025, 0, 1, 8);
    const datesReceivedAt = Date.UTC(2025, 0, 31, 12);
    const bodyReceivedAt = Date.UTC(2025, 1, 2, 18, 30);
    let wallClock = datesReceivedAt;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => wallClock);
    mocks.fetchWithRetry
      .mockImplementationOnce(async () => jsonResponse([
        { symbol: "AAPL", year: 2025, quarter: 1, date: "2025-01-30 17:00:00" }
      ]))
      .mockImplementationOnce(async () => {
        wallClock = bodyReceivedAt;
        return jsonResponse([{
          symbol: "AAPL",
          year: 2025,
          quarter: 1,
          date: "2025-01-30 17:00:00",
          content: "Operator introduction. Management discusses results and outlook. ".repeat(8)
        }]);
      });
    const { getFmpTranscriptObservation, getFmpTranscriptStatus, refreshFmpTranscripts, transcriptAccession } = await import(
      "../src/lib/web-sources/fmp-transcripts"
    );
    const { hasIngestedAccession } = await import("../src/lib/db");

    const result = await refreshFmpTranscripts(["AAPL"], callerNow, { force: true, maxRequests: 2 })
      .finally(() => clock.mockRestore());

    expect(result).toMatchObject({
      enabled: true,
      capability: "available",
      requests: 2,
      symbolsAttempted: 1,
      transcriptsAttempted: 1,
      ingested: 1
    });
    expect(mocks.fetchWithRetry).toHaveBeenCalledTimes(2);
    for (const [url, init] of mocks.fetchWithRetry.mock.calls) {
      expect(String(url)).not.toContain("test-fmp-key");
      expect(new Headers((init as RequestInit).headers).get("apikey")).toBe("test-fmp-key");
    }
    const stored = mocks.storeDocument.mock.calls[0]![0];
    expect(stored).toMatchObject({
      ticker: "AAPL",
      doc_type: "earnings-transcript",
      published_at: "2025-01-30T00:00:00.000Z",
      acceptance_datetime: "2025-02-02T18:30:00.000Z",
      source: "fmp-earnings-transcript"
    });
    expect(stored.doc_id).toMatch(new RegExp(`^${transcriptAccession("AAPL", 2025, 1)}:VERSION:[a-f0-9]{64}$`));
    expect(String(stored.url)).not.toContain("apikey");
    expect(mocks.storeDocument.mock.calls[0]![2]).toMatchObject({
      leaseGuard: {
        assertOwnership: expect.any(Function),
        signal: expect.any(AbortSignal)
      }
    });
    expect(hasIngestedAccession(transcriptAccession("AAPL", 2025, 1), "earnings-transcript")).toBe(true);
    expect(getFmpTranscriptObservation(transcriptAccession("AAPL", 2025, 1))).toMatchObject({
      discoveredAt: "2025-01-31T12:00:00.000Z",
      firstContentSeenAt: "2025-02-02T18:30:00.000Z"
    });
    expect(getFmpTranscriptStatus(callerNow)).toMatchObject({
      featureEnabled: true,
      storageRightsConfirmed: true,
      enabled: true,
      due: false,
      capability: "available",
      ingestedCount: 1,
      lastAttemptAt: "2025-01-01T08:00:00.000Z",
      lastCapability: {
        status: "available",
        checkedAt: "2025-02-02T18:30:00.000Z",
        httpStatus: 200
      }
    });
  });

  it("classifies Starter-plan HTTP 402 as endpoint_not_entitled and stops after one call", async () => {
    mocks.fetchWithRetry.mockResolvedValue(new Response("upgrade required", { status: 402 }));
    const { getFmpTranscriptCapability, refreshFmpTranscripts } = await import(
      "../src/lib/web-sources/fmp-transcripts"
    );

    const result = await refreshFmpTranscripts(["AAPL", "MSFT", "NVDA"], Date.UTC(2025, 0, 31), {
      force: true,
      maxRequests: 12
    });

    expect(result).toMatchObject({
      capability: "endpoint_not_entitled",
      requests: 1,
      symbolsAttempted: 1,
      ingested: 0
    });
    expect(result.errors).toEqual(["dates:AAPL:endpoint_not_entitled"]);
    expect(mocks.fetchWithRetry).toHaveBeenCalledTimes(1);
    expect(mocks.fetchWithRetry.mock.calls[0]![2]).toMatchObject({
      service: "fmp",
      healthService: "fmp-transcripts",
      suppressHealthStatuses: [400, 401, 402, 403]
    });
    expect(getFmpTranscriptCapability()).toEqual({
      status: "endpoint_not_entitled",
      checkedAt: "2025-01-31T00:00:00.000Z",
      httpStatus: 402
    });
    expect(mocks.storeDocument).not.toHaveBeenCalled();
  });

  it("keeps empty 200 responses retryable and never creates a false completion row", async () => {
    mocks.fetchWithRetry.mockResolvedValue(jsonResponse([]));
    const { getFmpTranscriptCapability, refreshFmpTranscripts, transcriptAccession } = await import(
      "../src/lib/web-sources/fmp-transcripts"
    );
    const { hasIngestedAccession } = await import("../src/lib/db");

    const result = await refreshFmpTranscripts(["AAPL"], Date.UTC(2025, 0, 31), {
      force: true,
      maxRequests: 1
    });

    expect(result).toMatchObject({ capability: "unknown", requests: 1, retryableEmpty: 1, ingested: 0 });
    expect(getFmpTranscriptCapability()).toBeUndefined();
    expect(hasIngestedAccession(transcriptAccession("AAPL", 2025, 1), "earnings-transcript")).toBe(false);
    expect(mocks.storeDocument).not.toHaveBeenCalled();
  });

  it("keeps an empty transcript body retryable after successful period discovery", async () => {
    mocks.fetchWithRetry
      .mockResolvedValueOnce(jsonResponse([
        { symbol: "AAPL", year: 2025, quarter: 1, date: "2025-01-30" }
      ]))
      .mockResolvedValueOnce(jsonResponse([]));
    const { getFmpTranscriptCapability, refreshFmpTranscripts, transcriptAccession } = await import(
      "../src/lib/web-sources/fmp-transcripts"
    );
    const { hasIngestedAccession } = await import("../src/lib/db");

    const result = await refreshFmpTranscripts(["AAPL"], Date.UTC(2025, 0, 31), {
      force: true,
      maxRequests: 2
    });

    expect(result).toMatchObject({
      capability: "unknown",
      requests: 2,
      transcriptsAttempted: 1,
      retryableEmpty: 1,
      ingested: 0
    });
    expect(result.errors).toEqual(["body:AAPL:empty"]);
    expect(getFmpTranscriptCapability()).toBeUndefined();
    expect(hasIngestedAccession(transcriptAccession("AAPL", 2025, 1), "earnings-transcript")).toBe(false);
    expect(mocks.storeDocument).not.toHaveBeenCalled();
  });

  it.each([
    {
      status: 403,
      capability: "endpoint_not_entitled",
      error: "body:AAPL:endpoint_not_entitled",
      persisted: {
        status: "endpoint_not_entitled",
        checkedAt: "2025-01-31T00:00:00.000Z",
        httpStatus: 403
      }
    },
    { status: 404, capability: "unknown", error: "body:AAPL:http-404", persisted: undefined }
  ])("classifies transcript body endpoint HTTP $status without a false available claim", async ({
    status,
    capability,
    error,
    persisted
  }) => {
    mocks.fetchWithRetry
      .mockResolvedValueOnce(jsonResponse([
        { symbol: "AAPL", year: 2025, quarter: 1, date: "2025-01-30" }
      ]))
      .mockResolvedValueOnce(new Response("not available", { status }));
    const { getFmpTranscriptCapability, refreshFmpTranscripts } = await import(
      "../src/lib/web-sources/fmp-transcripts"
    );

    const result = await refreshFmpTranscripts(["AAPL"], Date.UTC(2025, 0, 31), {
      force: true,
      maxRequests: 2
    });

    expect(result).toMatchObject({ capability, requests: 2, ingested: 0 });
    expect(result.errors).toEqual([error]);
    expect(getFmpTranscriptCapability()).toEqual(persisted);
    expect(mocks.storeDocument).not.toHaveBeenCalled();
  });

  it("retries one transient body accession next run, then advances fairly after a second failure", async () => {
    process.env.FMP_TRANSCRIPT_HTTP_RETRIES = "0";
    process.env.FMP_TRANSCRIPT_MAX_PER_SYMBOL = "1";
    const dates = [{ symbol: "AAPL", year: 2025, quarter: 1, date: "2025-01-30" }];
    const datesAfterNewerPeriodArrives = [
      { symbol: "AAPL", year: 2025, quarter: 2, date: "2025-04-30" },
      ...dates
    ];
    const { refreshFmpTranscripts, transcriptAccession } = await import(
      "../src/lib/web-sources/fmp-transcripts"
    );
    const { getInternalSetting } = await import("../src/lib/db");
    const retryKey = "webSource:fmpTranscripts:bodyRetryAccession";

    mocks.fetchWithRetry
      .mockResolvedValueOnce(jsonResponse(dates))
      .mockResolvedValueOnce(new Response("temporary", { status: 503 }));
    const first = await refreshFmpTranscripts(["AAPL", "MSFT"], Date.UTC(2025, 0, 31), {
      force: true,
      maxRequests: 2
    });

    expect(first.errors).toEqual(["body:AAPL:http-503"]);
    expect(getInternalSetting(retryKey)).toBe(transcriptAccession("AAPL", 2025, 1));
    expect(getInternalSetting("webSource:fmpTranscripts:cursor")).toBeUndefined();
    expect(getInternalSetting("webSource:fmpTranscripts:nextAttemptAt")).toBe("2025-01-31T01:00:00.000Z");

    mocks.fetchWithRetry.mockReset();
    mocks.fetchWithRetry
      .mockResolvedValueOnce(jsonResponse(datesAfterNewerPeriodArrives))
      .mockResolvedValueOnce(new Response("temporary", { status: 503 }));
    const second = await refreshFmpTranscripts(["AAPL", "MSFT"], Date.UTC(2025, 0, 31, 1), {
      force: true,
      maxRequests: 2
    });

    expect(second.errors).toEqual(["body:AAPL:http-503"]);
    expect(String(mocks.fetchWithRetry.mock.calls[1]![0])).toContain("quarter=1");
    expect(getInternalSetting(retryKey)).toBeUndefined();
    expect(getInternalSetting("webSource:fmpTranscripts:cursor")).toBe("AAPL");
    expect(getInternalSetting("webSource:fmpTranscripts:nextAttemptAt")).toBe("2025-01-31T02:00:00.000Z");

    mocks.fetchWithRetry.mockReset();
    mocks.fetchWithRetry.mockResolvedValueOnce(jsonResponse([]));
    await refreshFmpTranscripts(["AAPL", "MSFT"], Date.UTC(2025, 0, 31, 2), {
      force: true,
      maxRequests: 1
    });

    expect(String(mocks.fetchWithRetry.mock.calls[0]![0])).toContain("symbol=MSFT");
  });

  it("retries invalid embeddings once, then advances fairly without a completion row", async () => {
    process.env.FMP_TRANSCRIPT_MAX_PER_SYMBOL = "1";
    const dates = [{ symbol: "AAPL", year: 2025, quarter: 1, date: "2025-01-30" }];
    const body = [{
      symbol: "AAPL",
      year: 2025,
      quarter: 1,
      content: "Operator introduction. Management discusses results and outlook. ".repeat(8)
    }];
    mocks.fetchWithRetry
      .mockResolvedValueOnce(jsonResponse(dates))
      .mockResolvedValueOnce(jsonResponse(body));
    mocks.storeDocument.mockResolvedValue({
      attempted: 2,
      indexed: 1,
      rejectedInvalidEmbeddings: 1
    });
    const { refreshFmpTranscripts, transcriptAccession } = await import(
      "../src/lib/web-sources/fmp-transcripts"
    );
    const { getInternalSetting, hasIngestedAccession } = await import("../src/lib/db");

    const result = await refreshFmpTranscripts(["AAPL", "MSFT"], Date.UTC(2025, 0, 31), {
      force: true,
      maxRequests: 2
    });

    expect(result).toMatchObject({ capability: "available", requests: 2, ingested: 0 });
    expect(result.errors).toEqual(["embed:AAPL:invalid-embeddings"]);
    expect(hasIngestedAccession(transcriptAccession("AAPL", 2025, 1), "earnings-transcript")).toBe(false);
    expect(getInternalSetting("webSource:fmpTranscripts:cursor")).toBeUndefined();
    expect(getInternalSetting("webSource:fmpTranscripts:embedRetryAccession"))
      .toBe(transcriptAccession("AAPL", 2025, 1));
    expect(getInternalSetting("webSource:fmpTranscripts:nextAttemptAt")).toBe("2025-01-31T01:00:00.000Z");

    mocks.fetchWithRetry.mockReset();
    mocks.fetchWithRetry
      .mockResolvedValueOnce(jsonResponse(dates))
      .mockResolvedValueOnce(jsonResponse(body));
    const second = await refreshFmpTranscripts(["AAPL", "MSFT"], Date.UTC(2025, 0, 31, 1), {
      force: true,
      maxRequests: 2
    });

    expect(second.errors).toEqual(["embed:AAPL:invalid-embeddings"]);
    expect(hasIngestedAccession(transcriptAccession("AAPL", 2025, 1), "earnings-transcript")).toBe(false);
    expect(getInternalSetting("webSource:fmpTranscripts:embedRetryAccession")).toBeUndefined();
    expect(getInternalSetting("webSource:fmpTranscripts:cursor")).toBe("AAPL");

    mocks.fetchWithRetry.mockReset();
    mocks.fetchWithRetry.mockResolvedValueOnce(jsonResponse([]));
    await refreshFmpTranscripts(["AAPL", "MSFT"], Date.UTC(2025, 0, 31, 2), {
      force: true,
      maxRequests: 1
    });
    expect(String(mocks.fetchWithRetry.mock.calls[0]![0])).toContain("symbol=MSFT");
  });

  it.each([
    ["store error", { attempted: 2, indexed: 0, error: "synthetic Pinecone failure" }, "failed"],
    ["empty store result", { attempted: 2, indexed: 0 }, "empty"],
    ["unexplained partial store result", { attempted: 2, indexed: 1, documentComplete: false }, "incomplete"]
  ])("gives a %s one priority retry, then rotates while leaving the accession incomplete", async (
    _label,
    storeResult,
    errorSuffix
  ) => {
    process.env.FMP_TRANSCRIPT_MAX_PER_SYMBOL = "1";
    const dates = [{ symbol: "AAPL", year: 2025, quarter: 1, date: "2025-01-30" }];
    const body = [{
      symbol: "AAPL",
      year: 2025,
      quarter: 1,
      content: "Operator introduction. Management discusses results and outlook. ".repeat(8)
    }];
    mocks.storeDocument.mockResolvedValue(storeResult);
    mocks.fetchWithRetry
      .mockResolvedValueOnce(jsonResponse(dates))
      .mockResolvedValueOnce(jsonResponse(body));
    const { refreshFmpTranscripts, transcriptAccession } = await import(
      "../src/lib/web-sources/fmp-transcripts"
    );
    const { getInternalSetting, hasIngestedAccession } = await import("../src/lib/db");
    const accession = transcriptAccession("AAPL", 2025, 1);
    const retryKey = "webSource:fmpTranscripts:embedRetryAccession";

    const first = await refreshFmpTranscripts(["AAPL", "MSFT"], Date.UTC(2025, 0, 31), {
      force: true,
      maxRequests: 2
    });

    expect(first.errors).toEqual([`embed:AAPL:${errorSuffix}`]);
    expect(getInternalSetting(retryKey)).toBe(accession);
    expect(getInternalSetting("webSource:fmpTranscripts:cursor")).toBeUndefined();
    expect(getInternalSetting("webSource:fmpTranscripts:nextAttemptAt")).toBe("2025-01-31T01:00:00.000Z");
    expect(hasIngestedAccession(accession, "earnings-transcript")).toBe(false);

    mocks.fetchWithRetry.mockReset();
    mocks.fetchWithRetry
      .mockResolvedValueOnce(jsonResponse(dates))
      .mockResolvedValueOnce(jsonResponse(body));
    const second = await refreshFmpTranscripts(["AAPL", "MSFT"], Date.UTC(2025, 0, 31, 1), {
      force: true,
      maxRequests: 2
    });

    expect(second.errors).toEqual([`embed:AAPL:${errorSuffix}`]);
    expect(getInternalSetting(retryKey)).toBeUndefined();
    expect(getInternalSetting("webSource:fmpTranscripts:cursor")).toBe("AAPL");
    expect(getInternalSetting("webSource:fmpTranscripts:nextAttemptAt")).toBe("2025-01-31T02:00:00.000Z");
    expect(hasIngestedAccession(accession, "earnings-transcript")).toBe(false);

    mocks.fetchWithRetry.mockReset();
    mocks.fetchWithRetry.mockResolvedValueOnce(jsonResponse([]));
    await refreshFmpTranscripts(["AAPL", "MSFT"], Date.UTC(2025, 0, 31, 2), {
      force: true,
      maxRequests: 1
    });
    expect(String(mocks.fetchWithRetry.mock.calls[0]![0])).toContain("symbol=MSFT");
  });

  it("records the complete chunk count after a retry rematerializes every occurrence vector", async () => {
    mocks.fetchWithRetry
      .mockResolvedValueOnce(jsonResponse([
        { symbol: "AAPL", year: 2025, quarter: 1, date: "2025-01-30" }
      ]))
      .mockResolvedValueOnce(jsonResponse([{
        symbol: "AAPL",
        year: 2025,
        quarter: 1,
        content: "Operator introduction. Management discusses results and outlook. ".repeat(8)
      }]));
    mocks.storeDocument.mockResolvedValue({ attempted: 4, indexed: 4, documentComplete: true });
    const { refreshFmpTranscripts, transcriptAccession } = await import(
      "../src/lib/web-sources/fmp-transcripts"
    );
    const { getDb } = await import("../src/lib/db");

    const result = await refreshFmpTranscripts(["AAPL"], Date.UTC(2025, 0, 31), {
      force: true,
      maxRequests: 2
    });

    expect(result.ingested).toBe(1);
    expect(
      getDb().prepare(
        "SELECT chunk_count FROM ingested_accessions WHERE accession = ? AND doc_type = ?"
      ).get(transcriptAccession("AAPL", 2025, 1), "earnings-transcript")
    ).toEqual({ chunk_count: 4 });
    const auditRow = getDb().prepare(
      "SELECT payload FROM audit_events WHERE kind = 'fmp_transcript_ingest' ORDER BY rowid DESC LIMIT 1"
    ).get() as { payload: string };
    expect(JSON.parse(auditRow.payload)).toMatchObject({ chunks: 4, indexedThisAttempt: 4 });
  });

  it("finishes the source ledger from an exact previously committed occurrence set", async () => {
    mocks.fetchWithRetry
      .mockResolvedValueOnce(jsonResponse([
        { symbol: "AAPL", year: 2025, quarter: 1, date: "2025-01-30" }
      ]))
      .mockResolvedValueOnce(jsonResponse([{
        symbol: "AAPL",
        year: 2025,
        quarter: 1,
        content: "Operator introduction. Management discusses results and outlook. ".repeat(8)
      }]));
    mocks.storeDocument.mockResolvedValue({
      attempted: 4,
      indexed: 0,
      skipped: true,
      reusedCommitted: true,
      documentComplete: true
    });
    const { refreshFmpTranscripts, transcriptAccession } = await import(
      "../src/lib/web-sources/fmp-transcripts"
    );
    const { getDb } = await import("../src/lib/db");

    const result = await refreshFmpTranscripts(["AAPL"], Date.UTC(2025, 0, 31), {
      force: true,
      maxRequests: 2
    });

    expect(result).toMatchObject({ ingested: 1, skippedExisting: 0 });
    expect(
      getDb().prepare(
        "SELECT chunk_count FROM ingested_accessions WHERE accession = ? AND doc_type = ?"
      ).get(transcriptAccession("AAPL", 2025, 1), "earnings-transcript")
    ).toEqual({ chunk_count: 4 });
    const auditRow = getDb().prepare(
      "SELECT payload FROM audit_events WHERE kind = 'fmp_transcript_ingest' ORDER BY rowid DESC LIMIT 1"
    ).get() as { payload: string };
    expect(JSON.parse(auditRow.payload)).toMatchObject({
      chunks: 4,
      indexedThisAttempt: 0,
      reusedCommitted: true,
      deduplicatedCompletion: true,
      exactReplayWasAlreadyComplete: false
    });
  });

  it("counts a real provider-generation repair as ingested even when source ledgers were complete", async () => {
    const dates = [{ symbol: "AAPL", year: 2025, quarter: 1, date: "2025-01-30" }];
    const transcript = {
      ...dates[0],
      content: "Operator introduction. Management discusses results and outlook. ".repeat(8)
    };
    mocks.fetchWithRetry
      .mockResolvedValueOnce(jsonResponse(dates))
      .mockResolvedValueOnce(jsonResponse([transcript]))
      .mockResolvedValueOnce(jsonResponse(dates))
      .mockResolvedValueOnce(jsonResponse([transcript]));
    mocks.storeDocument
      .mockResolvedValueOnce({
        attempted: 4,
        indexed: 4,
        documentComplete: true,
        managedCommitProof: { commitId: "test:fmp:first", attemptToken: "test:fmp:first" }
      })
      .mockResolvedValueOnce({
        attempted: 4,
        indexed: 4,
        documentComplete: true,
        managedCommitProof: { commitId: "test:fmp:repair", attemptToken: "test:fmp:repair" }
      });
    const { refreshFmpTranscripts } = await import("../src/lib/web-sources/fmp-transcripts");
    const { getDb } = await import("../src/lib/db");

    expect(await refreshFmpTranscripts(["AAPL"], Date.UTC(2025, 0, 31), {
      force: true,
      maxRequests: 2
    })).toMatchObject({ ingested: 1, skippedExisting: 0 });
    expect(await refreshFmpTranscripts(["AAPL"], Date.UTC(2025, 1, 1), {
      force: true,
      maxRequests: 2
    })).toMatchObject({ ingested: 1, skippedExisting: 0 });
    const auditRow = getDb().prepare(
      "SELECT payload FROM audit_events WHERE kind = 'fmp_transcript_ingest' ORDER BY rowid DESC LIMIT 1"
    ).get() as { payload: string };
    expect(JSON.parse(auditRow.payload)).toMatchObject({
      reusedCommitted: false,
      deduplicatedCompletion: false,
      exactReplayWasAlreadyComplete: false,
      indexedThisAttempt: 4
    });
  });

  it("refuses source completion when a caller reports content dedup without occurrence vectors", async () => {
    mocks.fetchWithRetry
      .mockResolvedValueOnce(jsonResponse([
        { symbol: "AAPL", year: 2025, quarter: 1, date: "2025-01-30" }
      ]))
      .mockResolvedValueOnce(jsonResponse([{
        symbol: "AAPL",
        year: 2025,
        quarter: 1,
        content: "Operator introduction. Management discusses results and outlook. ".repeat(8)
      }]));
    mocks.storeDocument.mockResolvedValue({
      attempted: 4,
      indexed: 0,
      skipped: true,
      dedupComplete: true,
      documentComplete: true
    });
    const { refreshFmpTranscripts, transcriptAccession } = await import(
      "../src/lib/web-sources/fmp-transcripts"
    );
    const { getDb } = await import("../src/lib/db");
    getDb().prepare("DELETE FROM audit_events WHERE kind = 'fmp_transcript_ingest'").run();

    const result = await refreshFmpTranscripts(["AAPL"], Date.UTC(2025, 0, 31), {
      force: true,
      maxRequests: 2
    });

    expect(result).toMatchObject({ ingested: 0, skippedExisting: 0 });
    expect(result.errors).toEqual(["embed:AAPL:empty"]);
    expect(
      getDb().prepare(
        "SELECT chunk_count FROM ingested_accessions WHERE accession = ? AND doc_type = ?"
      ).get(transcriptAccession("AAPL", 2025, 1), "earnings-transcript")
    ).toBeUndefined();
    const auditRows = getDb().prepare(
      "SELECT payload FROM audit_events WHERE kind = 'fmp_transcript_ingest' ORDER BY rowid"
    ).all() as Array<{ payload: string }>;
    expect(auditRows).toHaveLength(0);
  });

  it("re-probes the newest legacy-ingested period so provider corrections receive a version identity", async () => {
    process.env.FMP_TRANSCRIPT_MAX_PER_SYMBOL = "1";
    const { refreshFmpTranscripts, transcriptAccession } = await import(
      "../src/lib/web-sources/fmp-transcripts"
    );
    const { getDb, hasIngestedAccession } = await import("../src/lib/db");
    getDb().prepare(
      "INSERT INTO ingested_accessions (accession, doc_type, ticker, indexed_at, chunk_count) VALUES (?, ?, ?, ?, ?)"
    ).run(
      transcriptAccession("AAPL", 2025, 4),
      "earnings-transcript",
      "AAPL",
      "2025-01-01T00:00:00.000Z",
      2
    );
    mocks.fetchWithRetry
      .mockResolvedValueOnce(jsonResponse([
        { symbol: "AAPL", year: 2025, quarter: 4 },
        { symbol: "AAPL", year: 2025, quarter: 3 },
        { symbol: "AAPL", year: 2025, quarter: 2 }
      ]))
      .mockResolvedValueOnce(jsonResponse([{
        symbol: "AAPL",
        year: 2025,
        quarter: 4,
        content: "Operator introduction. Management discusses results and outlook. ".repeat(8)
      }]));

    const result = await refreshFmpTranscripts(["AAPL"], Date.UTC(2025, 0, 31), {
      force: true,
      maxRequests: 2
    });

    expect(result).toMatchObject({ requests: 2, skippedExisting: 0, transcriptsAttempted: 1, ingested: 1 });
    expect(String(mocks.fetchWithRetry.mock.calls[1]![0])).toContain("quarter=4");
    expect(hasIngestedAccession(transcriptAccession("AAPL", 2025, 4), "earnings-transcript")).toBe(true);
    expect(getDb().prepare(
      "SELECT COUNT(*) AS count FROM fmp_transcript_versions WHERE accession = ? AND state = 'committed'"
    ).get(transcriptAccession("AAPL", 2025, 4))).toEqual({ count: 1 });
  });

  it("retains corrected transcript bodies as distinct point-in-time versions and dedupes an exact replay", async () => {
    mocks.storeDocument
      .mockResolvedValueOnce({
        attempted: 2,
        indexed: 2,
        documentComplete: true,
        managedCommitProof: { commitId: "test:fmp:first", attemptToken: "test:fmp:first" }
      })
      .mockResolvedValueOnce({
        attempted: 2,
        indexed: 2,
        documentComplete: true,
        managedCommitProof: { commitId: "test:fmp:corrected", attemptToken: "test:fmp:corrected" }
      })
      .mockResolvedValueOnce({
        attempted: 2,
        indexed: 0,
        skipped: true,
        reusedCommitted: true,
        documentComplete: true,
        managedCommitProof: { commitId: "test:fmp:corrected", attemptToken: "test:fmp:corrected" }
      });
    const dates = [{ symbol: "AAPL", year: 2025, quarter: 1, date: "2025-01-30" }];
    const firstBody = {
      ...dates[0],
      content: "Operator introduction. First reported results and outlook. ".repeat(8)
    };
    const correctedBody = {
      ...dates[0],
      content: "Operator introduction. Corrected results and revised outlook. ".repeat(8)
    };
    const undatedDates = [{ symbol: "AAPL", year: 2025, quarter: 1 }];
    const undatedCorrectedBody = {
      ...undatedDates[0],
      content: correctedBody.content
    };
    mocks.fetchWithRetry
      .mockResolvedValueOnce(jsonResponse(dates))
      .mockResolvedValueOnce(jsonResponse([firstBody]))
      .mockResolvedValueOnce(jsonResponse(dates))
      .mockResolvedValueOnce(jsonResponse([correctedBody]))
      .mockResolvedValueOnce(jsonResponse(undatedDates))
      .mockResolvedValueOnce(jsonResponse([undatedCorrectedBody]));
    const { getFmpTranscriptObservation, refreshFmpTranscripts, transcriptAccession } = await import(
      "../src/lib/web-sources/fmp-transcripts"
    );
    const { getDb } = await import("../src/lib/db");

    const first = await refreshFmpTranscripts(["AAPL"], Date.UTC(2025, 0, 31), {
      force: true,
      maxRequests: 2
    });
    const corrected = await refreshFmpTranscripts(["AAPL"], Date.UTC(2025, 0, 31, 1), {
      force: true,
      maxRequests: 2
    });
    const exactReplay = await refreshFmpTranscripts(["AAPL"], Date.UTC(2025, 0, 31, 2), {
      force: true,
      maxRequests: 2
    });

    expect(first.ingested).toBe(1);
    expect(corrected.ingested).toBe(1);
    expect(exactReplay).toMatchObject({ ingested: 0, skippedExisting: 1 });
    const replayAudit = getDb().prepare(
      "SELECT payload FROM audit_events WHERE kind = 'fmp_transcript_ingest' ORDER BY rowid DESC LIMIT 1"
    ).get() as { payload: string };
    expect(JSON.parse(replayAudit.payload)).toMatchObject({
      reusedCommitted: true,
      deduplicatedCompletion: false,
      exactReplayWasAlreadyComplete: true
    });
    expect(mocks.storeDocument).toHaveBeenCalledTimes(3);
    const storedIds = mocks.storeDocument.mock.calls.map((call) => call[0].doc_id as string);
    expect(new Set(storedIds).size).toBe(2);
    expect(storedIds.every((id) => id.startsWith(
      `${transcriptAccession("AAPL", 2025, 1)}:VERSION:`
    ))).toBe(true);
    // A later dates/body replay may omit the call date. The durable version retains the first
    // valid event date, so the exact replay keeps its original PIT metadata and generation id.
    expect(mocks.storeDocument.mock.calls[2]![0]).toMatchObject({
      doc_id: mocks.storeDocument.mock.calls[1]![0].doc_id,
      published_at: "2025-01-30T00:00:00.000Z"
    });
    expect(getFmpTranscriptObservation(transcriptAccession("AAPL", 2025, 1))).toMatchObject({
      callDate: "2025-01-30T00:00:00.000Z"
    });
    const rows = getDb().prepare(`
      SELECT version_id, content_sha256, first_content_seen_at, state
      FROM fmp_transcript_versions WHERE accession = ? ORDER BY version_id
    `).all(transcriptAccession("AAPL", 2025, 1)) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.content_sha256)).size).toBe(2);
    expect(rows.every((row) => row.state === "committed" && Boolean(row.first_content_seen_at)))
      .toBe(true);
  });

  it("does not downgrade a committed transcript when an exact replay hits a transient vector failure", async () => {
    mocks.storeDocument
      .mockResolvedValueOnce({
        attempted: 2,
        indexed: 2,
        documentComplete: true,
        managedCommitProof: { commitId: "test:fmp:stable", attemptToken: "test:fmp:stable" }
      })
      .mockResolvedValueOnce({ attempted: 2, indexed: 0, error: "temporary-pinecone-failure" });
    const dates = [{ symbol: "AAPL", year: 2025, quarter: 1, date: "2025-01-30" }];
    const body = [{
      ...dates[0],
      content: "Operator introduction. Stable reported results and outlook. ".repeat(8)
    }];
    mocks.fetchWithRetry
      .mockResolvedValueOnce(jsonResponse(dates))
      .mockResolvedValueOnce(jsonResponse(body))
      .mockResolvedValueOnce(jsonResponse(dates))
      .mockResolvedValueOnce(jsonResponse(body));
    const { refreshFmpTranscripts, transcriptAccession } = await import(
      "../src/lib/web-sources/fmp-transcripts"
    );
    const { getDb } = await import("../src/lib/db");

    const first = await refreshFmpTranscripts(["AAPL"], Date.UTC(2025, 0, 31), {
      force: true,
      maxRequests: 2
    });
    const failedReplay = await refreshFmpTranscripts(["AAPL"], Date.UTC(2025, 0, 31, 1), {
      force: true,
      maxRequests: 2
    });

    expect(first.ingested).toBe(1);
    expect(failedReplay.errors).toContain("embed:AAPL:failed");
    expect(getDb().prepare(`
      SELECT state, vector_commit_id, chunk_count
      FROM fmp_transcript_versions WHERE accession = ?
    `).get(transcriptAccession("AAPL", 2025, 1))).toEqual({
      state: "committed",
      vector_commit_id: "test:fmp:stable",
      chunk_count: 2
    });
  });

  it("honors an explicit zero request cap", async () => {
    const { refreshFmpTranscripts } = await import("../src/lib/web-sources/fmp-transcripts");
    const result = await refreshFmpTranscripts(["AAPL"], Date.UTC(2025, 0, 31), {
      force: true,
      maxRequests: 0
    });

    expect(result).toMatchObject({ requests: 0, deferredForRequestBudget: 1, capability: "unknown" });
    expect(mocks.fetchWithRetry).not.toHaveBeenCalled();
  });

  it("retries the same symbol next run when discovery consumes the final request slot", async () => {
    const datesPayload = [{ symbol: "AAPL", year: 2025, quarter: 1, date: "2025-01-30" }];
    mocks.fetchWithRetry.mockResolvedValueOnce(jsonResponse(datesPayload));
    const { refreshFmpTranscripts } = await import("../src/lib/web-sources/fmp-transcripts");
    const { getInternalSetting } = await import("../src/lib/db");

    const first = await refreshFmpTranscripts(["AAPL", "MSFT"], Date.UTC(2025, 0, 31), {
      force: true,
      maxRequests: 1
    });

    expect(first).toMatchObject({ requests: 1, deferredForRequestBudget: 1, ingested: 0 });
    expect(getInternalSetting("webSource:fmpTranscripts:cursor")).toBeUndefined();
    expect(getInternalSetting("webSource:fmpTranscripts:nextAttemptAt")).toBe("2025-01-31T01:00:00.000Z");

    mocks.fetchWithRetry.mockReset();
    mocks.fetchWithRetry
      .mockResolvedValueOnce(jsonResponse(datesPayload))
      .mockResolvedValueOnce(jsonResponse([{
        ...datesPayload[0],
        content: "Operator introduction. Management discusses results and outlook. ".repeat(8)
      }]));

    const second = await refreshFmpTranscripts(["AAPL", "MSFT"], Date.UTC(2025, 0, 31, 1), {
      force: true,
      maxRequests: 2
    });

    expect(second).toMatchObject({ requests: 2, symbolsAttempted: 1, ingested: 1 });
    expect(String(mocks.fetchWithRetry.mock.calls[0]![0])).toContain("symbol=AAPL");
    expect(getInternalSetting("webSource:fmpTranscripts:cursor")).toBe("AAPL");
  });

  it("rejects oversized JSON before parsing or embedding", async () => {
    process.env.FMP_TRANSCRIPT_DATES_MAX_RESPONSE_BYTES = "10";
    mocks.fetchWithRetry.mockResolvedValue(jsonResponse([{ a: "too large" }]));
    const { refreshFmpTranscripts } = await import("../src/lib/web-sources/fmp-transcripts");

    const result = await refreshFmpTranscripts(["AAPL"], Date.UTC(2025, 0, 31), {
      force: true,
      maxRequests: 1
    });

    expect(result.errors).toEqual(["dates:AAPL:response_too_large"]);
    expect(result).toMatchObject({ requests: 1, ingested: 0, capability: "unknown" });
    expect(mocks.storeDocument).not.toHaveBeenCalled();
  });

  it("fails before any observation or vector write when durable lease ownership is lost", async () => {
    mocks.fetchWithRetry.mockImplementationOnce(async () => {
      const { getDb } = await import("../src/lib/db");
      getDb().prepare("DELETE FROM settings WHERE key = 'operation_lease:rag-reindex'").run();
      return jsonResponse([{ symbol: "AAPL", year: 2025, quarter: 1, date: "2025-01-30" }]);
    });
    const { refreshFmpTranscripts } = await import("../src/lib/web-sources/fmp-transcripts");

    await expect(
      refreshFmpTranscripts(["AAPL"], Date.UTC(2025, 0, 31), { force: true, maxRequests: 1 })
    ).rejects.toThrow(/lease/i);
    expect(mocks.storeDocument).not.toHaveBeenCalled();
  });

  it("uses its own next-attempt cadence and remains never-due while either opt-in is off", async () => {
    const { isFmpTranscriptRefreshDue } = await import("../src/lib/web-sources/fmp-transcripts");
    const { setInternalSetting } = await import("../src/lib/db");
    const now = Date.UTC(2025, 0, 31, 12);

    expect(isFmpTranscriptRefreshDue(now)).toBe(true);
    setInternalSetting("webSource:fmpTranscripts:nextAttemptAt", new Date(now + 60_000).toISOString());
    expect(isFmpTranscriptRefreshDue(now)).toBe(false);
    expect(isFmpTranscriptRefreshDue(now + 60_000)).toBe(true);

    process.env.FMP_TRANSCRIPT_STORAGE_RIGHTS_CONFIRMED = "off";
    expect(isFmpTranscriptRefreshDue(now + 60_000)).toBe(false);
  });

  it("blocks rights erasure when a v3 receipt belongs to an unreachable ledger or provider authority", async () => {
    const {
      inventoryFmpTranscriptRightsArtifacts,
      purgeFmpTranscriptRightsArtifacts
    } = await import("../src/lib/web-sources/fmp-transcripts");
    mocks.managedVectorReceiptEvidence.mockReturnValue([{
      id: "occ:v3:historical-ledger:historical-provider:tenant:source:digest",
      source: "fmp-earnings-transcript",
      tenantScope: "shared:operator",
      userId: "local",
      ledgerAuthority: "ledger:v1:historical-unreachable",
      providerAuthority: "historical-provider-unreachable",
      vectorNamespace: "managed"
    }]);

    const inventory = await inventoryFmpTranscriptRightsArtifacts();
    expect(inventory.authorityBlockers).toEqual([
      "historical-ledger-authority-unreachable",
      "historical-provider-authority-unreachable"
    ]);

    process.env.FMP_TRANSCRIPT_STORAGE_RIGHTS_CONFIRMED = "off";
    await expect(purgeFmpTranscriptRightsArtifacts({ dryRun: false }))
      .rejects.toThrow("blocked by unreachable historical authority");
    expect(mocks.purgeVectorNamespaceAll).not.toHaveBeenCalled();
    expect(mocks.purgeVectorRecordIds).not.toHaveBeenCalled();
  });

  it("fails closed when current provider identity cannot classify a receiptless managed ghost", async () => {
    const {
      inventoryFmpTranscriptRightsArtifacts,
      purgeFmpTranscriptRightsArtifacts
    } = await import("../src/lib/web-sources/fmp-transcripts");
    mocks.getCurrentVectorProviderAuthority.mockResolvedValue(undefined);
    mocks.inventoryVectorRecordsByMetadata.mockImplementation(async ({ namespace }) => (
      namespace === "managed"
        ? [{ id: "occ:v3:unreachable-provider:receiptless-ghost", metadata: {} }]
        : []
    ));

    const inventory = await inventoryFmpTranscriptRightsArtifacts();
    // The managed ghost cannot be selected without the physical provider token. The blocker is
    // therefore the critical proof that prevents a false-success local purge.
    expect(inventory.providerObservedVectorIds).toEqual([]);
    expect(inventory.authorityBlockers).toContain("current-provider-authority-unreachable");

    process.env.FMP_TRANSCRIPT_STORAGE_RIGHTS_CONFIRMED = "off";
    await expect(purgeFmpTranscriptRightsArtifacts({ dryRun: false }))
      .rejects.toThrow("blocked by unreachable historical authority");
    expect(mocks.purgeVectorNamespaceAll).not.toHaveBeenCalled();
    expect(mocks.purgeVectorRecordIds).not.toHaveBeenCalled();
  });

  it("purges immutable-source candidates even when mutable provider source metadata is corrupted", async () => {
    const {
      inventoryFmpTranscriptRightsArtifacts,
      purgeFmpTranscriptRightsArtifacts
    } = await import("../src/lib/web-sources/fmp-transcripts");
    const { audit, getDb, setInternalSetting } = await import("../src/lib/db");
    const db = getDb();
    const source = "fmp-earnings-transcript";
    const docType = "earnings-transcript";
    const accession = "FMP-EARNINGS-TRANSCRIPT:AAPL:2026:Q1";
    const versionId = `${accession}:VERSION:test-rights`;
    const commitId = "vcommit:test:rights";
    const decisionId = "decision:test:fmp-rights";
    const vectorId = "occ:v2:test:rights";
    const currentVectorId = "occ:v3:test-current:tenant:source:digest";
    const at = "2026-07-14T12:00:00.000Z";
    db.prepare(`
      INSERT INTO vector_ingest_commits (
        id, tenant_scope, user_id, source, accession, document_key, content_version,
        retrieval_metadata_version, parser_revision, embed_revision, expected_vectors,
        provider_authority, ledger_authority, vector_namespace, state,
        attempt_token, attempt_generation, created_at, updated_at, committed_at
      ) VALUES (?, 'shared:operator', 'local', ?, ?, ?, 'hash-rights', 'metadata-rights',
        'fmp-transcript-v1', 'v1', 1, 'test-current-authority',
        'ledger:v1:test-current-authority', 'managed', 'committed',
        'attempt-rights', 1, ?, ?, ?)
    `).run(commitId, source, versionId, accession, at, at, at);
    db.prepare(`
      INSERT INTO vector_document_heads (tenant_scope, source, accession, commit_id, updated_at)
      VALUES ('shared:operator', ?, ?, ?, ?)
    `).run(source, accession, commitId, at);
    db.prepare(`
      INSERT INTO vector_document_versions (
        commit_id, tenant_scope, source, document_key, valid_from, valid_to, updated_at
      ) VALUES (?, 'shared:operator', ?, ?, ?, NULL, ?)
    `).run(commitId, source, accession, at, at);
    db.prepare(`
      INSERT INTO vector_reconcile_observations (
        commit_id, fingerprint, observation_count, first_observed_at, last_observed_at
      ) VALUES (?, 'rights-observation', 1, ?, ?)
    `).run(commitId, at, at);
    db.prepare(`
      INSERT INTO chunk_occurrences (
        vector_id, content_hash, symbol, source, accession, section, ordinal, accepted_at,
        tenant_scope, content_version, commit_id, receipt_state, created_at
      ) VALUES (?, 'hash-rights', 'AAPL', ?, ?, 'body', 1, ?, 'shared:operator',
        'hash-rights', ?, 'committed', ?)
    `).run(vectorId, source, versionId, at, commitId, at);
    db.prepare(`
      INSERT OR IGNORE INTO document_chunks (content_hash, symbol, source, chunk_id, created_at)
      VALUES ('hash-rights', 'AAPL', ?, 'rights-chunk', ?)
    `).run(source, at);
    db.prepare(`
      INSERT INTO fmp_transcript_versions (
        version_id, accession, content_sha256, symbol, fiscal_year, fiscal_quarter,
        first_content_seen_at, state, vector_commit_id, chunk_count, observed_at, indexed_at, updated_at
      ) VALUES (?, ?, 'hash-rights', 'AAPL', 2026, 1, ?, 'committed', ?, 1, ?, ?, ?)
    `).run(versionId, accession, at, commitId, at, at, at);
    db.prepare(`
      INSERT INTO ingested_accessions (accession, doc_type, ticker, indexed_at, chunk_count)
      VALUES (?, ?, 'AAPL', ?, 1)
    `).run(accession, docType, at);
    setInternalSetting(`webSource:fmpTranscripts:observation:${accession}`, { accession });
    audit("fmp_transcript_ingest", { source, docType, versionId });
    const retainedAttribution = { source: "sec-edgar", docType: "10-q", accession: "sec-keep" };
    const retainedEvidence = { type: "rag", data: retainedAttribution };
    db.prepare(`
      INSERT INTO socratic_decisions (
        id, user_id, status, authority, thesis, rationale, action,
        evidence, rag_attributions, created_at, updated_at
      ) VALUES (?, 'local', 'observed', 'system', 'test', 'test', 'hold', ?, ?, ?, ?)
    `).run(
      decisionId,
      JSON.stringify([
        { type: "rag", data: { source, docType, quote: "licensed transcript excerpt" } },
        retainedEvidence
      ]),
      JSON.stringify([
        { source, docType, accession: versionId },
        retainedAttribution
      ]),
      at,
      at
    );

    // v2 is selected from the local FMP receipt despite corrupt mutable source metadata; v3 is
    // selected from its immutable source-token identity, also despite corrupt metadata.
    mocks.managedVectorReceiptEvidence.mockImplementation(() => (
      db.prepare("SELECT 1 AS ok FROM chunk_occurrences WHERE vector_id = ?").get(vectorId)
        ? [{
            id: vectorId,
            source,
            tenantScope: "shared:operator",
            userId: "local",
            ledgerAuthority: "ledger:v1:test-current-authority",
            providerAuthority: "test-current-authority",
            vectorNamespace: "managed"
          }]
        : []
    ));
    mocks.managedOccurrenceVectorIdMatches.mockImplementation(({ id }) => id === currentVectorId);
    let fmpNamespacePresent = true;
    let defaultNamespacePresent = true;
    mocks.inventoryVectorRecordsByMetadata.mockImplementation(async ({ namespace }) => {
      if (namespace === "fmp-transcripts") {
        return fmpNamespacePresent
          ? [{ id: currentVectorId, metadata: { source: "not-fmp" } }]
          : [];
      }
      if (namespace === "managed") return [];
      return defaultNamespacePresent
        ? [{ id: vectorId, metadata: { source: "not-fmp" } }]
        : [];
    });
    mocks.purgeVectorNamespaceAll.mockImplementation(async () => {
      fmpNamespacePresent = false;
    });
    mocks.purgeVectorRecordIds.mockImplementation(async ({ ids, namespace }) => {
      if (namespace === "default" && ids.includes(vectorId)) defaultNamespacePresent = false;
      return { ids, deleted: ids.length };
    });
    const inventory = await inventoryFmpTranscriptRightsArtifacts();
    expect(inventory).toMatchObject({
      providerVectorIds: [vectorId, currentVectorId],
      providerObservedVectorIds: [vectorId, currentVectorId],
      immutableCurrentSourceIds: [currentVectorId],
      localVectorIds: [vectorId],
      contentHashes: ["hash-rights"],
      commitIds: [commitId],
      activeHeadCommitIds: [commitId],
      documentVersionCommitIds: [commitId],
      reconcileObservationCommitIds: [commitId],
      versionIds: [versionId],
      ingestionRows: 1,
      derivedDecisionIds: [decisionId],
      authorityBlockers: [],
      derivedArtifactPolicy: "scrub-exact-provenance"
    });
    const dryRun = await purgeFmpTranscriptRightsArtifacts();
    expect(dryRun).toMatchObject({ dryRun: true, before: inventory, after: inventory });
    expect(mocks.purgeVectorRecordsByMetadata).not.toHaveBeenCalled();
    expect(mocks.purgeVectorRecordIds).not.toHaveBeenCalled();
    expect(mocks.purgeVectorNamespaceAll).not.toHaveBeenCalled();

    process.env.FMP_TRANSCRIPT_STORAGE_RIGHTS_CONFIRMED = "off";
    const purged = await purgeFmpTranscriptRightsArtifacts({ dryRun: false });
    expect(purged.dryRun).toBe(false);
    expect(purged.after).toMatchObject({
      providerVectorIds: [],
      providerObservedVectorIds: [],
      immutableCurrentSourceIds: [],
      localVectorIds: [],
      contentHashes: [],
      commitIds: [],
      activeHeadCommitIds: [],
      documentVersionCommitIds: [],
      reconcileObservationCommitIds: [],
      versionIds: [],
      ingestionRows: 0,
      observationKeys: [],
      derivedAuditIds: [],
      derivedDecisionIds: [],
      authorityBlockers: []
    });
    expect(mocks.purgeVectorNamespaceAll).toHaveBeenCalledWith(expect.objectContaining({
      userId: "local",
      namespace: "fmp-transcripts"
    }));
    expect(mocks.purgeVectorRecordIds).toHaveBeenCalledWith(expect.objectContaining({
      userId: "local",
      namespace: "default",
      ids: [vectorId]
    }));
    const scrubbedDecision = db.prepare(`
      SELECT evidence, rag_attributions FROM socratic_decisions WHERE id = ?
    `).get(decisionId) as { evidence: string; rag_attributions: string };
    expect(scrubbedDecision.evidence).not.toContain(source);
    expect(scrubbedDecision.rag_attributions).not.toContain(source);
    expect(JSON.parse(scrubbedDecision.evidence)).toEqual([retainedEvidence]);
    expect(JSON.parse(scrubbedDecision.rag_attributions)).toEqual([retainedAttribution]);
  });

  it("turns a concurrent shared RAG write into a benign no-marker/no-network busy result", async () => {
    const { OPERATION_LEASE_GROUPS, runWithOperationLease } = await import("../src/lib/operation-lease");
    const { getInternalSetting } = await import("../src/lib/db");
    const { refreshFmpTranscripts } = await import("../src/lib/web-sources/fmp-transcripts");
    let entered!: () => void;
    let release!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    const holder = runWithOperationLease(
      { group: OPERATION_LEASE_GROUPS.RAG_REINDEX, operation: "held-for-test" },
      async () => {
        entered();
        await releasePromise;
      }
    );
    await enteredPromise;

    const result = await refreshFmpTranscripts(["AAPL"], Date.UTC(2025, 0, 31), { force: true });
    expect(result.operationLease).toMatchObject({ status: "busy", activeOperation: "held-for-test" });
    expect(result.requests).toBe(0);
    expect(mocks.fetchWithRetry).not.toHaveBeenCalled();
    expect(getInternalSetting("webSource:fmpTranscripts:lastAttemptAt")).toBeUndefined();

    release();
    await holder;
  });
});
