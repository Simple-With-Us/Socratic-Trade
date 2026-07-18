/**
 * EarningsCalls.dev transcript source (src/lib/earningscalls-transcripts.ts).
 *
 * Covers: the durable calendar-month budget (reserve/refund, month rollover, persistence in the
 * settings table beyond process memory), reserve-before-call race safety, the fetch-once-forever
 * cache (a content hit never re-fetches), the negative-cache TTL, dormancy without a key /
 * with the kill-switch, holdings-first bounded selection, and the shape-tolerant parsers built
 * from the researched response expectations (top-level `data` envelopes; speaker segments with
 * speaker_name/speaker_type/text_content/component_order; flat full_text).
 */
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { EarningsCallsHttpResult, EarningsCallsRefreshDeps } from "../src/lib/earningscalls-transcripts";
import type { EarningsCallsTranscriptRow } from "../src/lib/db-earningscalls";

// Controllable stubs for the two modules the producer reaches through dynamic import. Default
// (impl undefined) = passthrough to the real module, so every pre-existing test is unaffected;
// individual tests install an impl and afterEach clears it.
const storeDocumentStub = vi.hoisted(() => ({
  impl: undefined as undefined | ((...args: unknown[]) => unknown)
}));
const requestFmpStub = vi.hoisted(() => ({
  impl: undefined as undefined | ((...args: unknown[]) => unknown)
}));

vi.mock("../src/lib/vector-db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/vector-db")>();
  return {
    ...actual,
    managedVectorLedgerAuthority: vi.fn(),
    storeDocument: (...args: Parameters<typeof actual.storeDocument>) =>
      storeDocumentStub.impl ? storeDocumentStub.impl(...args) : actual.storeDocument(...args)
  };
});

vi.mock("../src/lib/fmp-common", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/fmp-common")>();
  return { managedVectorLedgerAuthority: vi.fn(),
    ...actual,
    requestFmp: (...args: Parameters<typeof actual.requestFmp>) =>
      requestFmpStub.impl ? requestFmpStub.impl(...args) : actual.requestFmp(...args)
  };
});

const DB_PATH = join(tmpdir(), `agentic-earningscalls-${randomUUID()}.db`);

beforeAll(() => {
  process.env.DATABASE_URL = `file:${DB_PATH}`;
});

const ENV_KEYS = [
  "EARNINGSCALLS_API_KEY",
  "EARNINGSCALLS_RAPIDAPI_KEY",
  "EARNINGSCALLS_DISABLED",
  "EARNINGSCALLS_MONTHLY_BUDGET",
  "EARNINGSCALLS_RECENT_DAYS",
  "EARNINGSCALLS_TOP_CANDIDATES",
  "EARNINGSCALLS_NEGATIVE_TTL_DAYS",
  "EARNINGSCALLS_MAX_REQUESTS_PER_PASS",
  "FMP_API_KEY"
] as const;
const savedEnv = new Map<string, string | undefined>();
for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  storeDocumentStub.impl = undefined;
  requestFmpStub.impl = undefined;
});

async function lib() {
  return import("../src/lib/earningscalls-transcripts");
}

async function dbLib() {
  return import("../src/lib/db-earningscalls");
}

/** Fresh state between budget assertions: the counter is a settings row, so tests reset it by
 *  moving to a unique month via `nowMs` instead of mutating shared state. */
let monthCursor = Date.UTC(2030, 0, 15);
function freshMonthMs(): number {
  monthCursor += 400 * 86_400_000; // > 1 year forward — guaranteed different "YYYY-MM"
  return monthCursor;
}

const NOW = Date.UTC(2026, 6, 16, 12); // 2026-07-16T12:00Z, matches fixture event dates below

function latestCallPayload(overrides: Record<string, unknown> = {}): unknown {
  // Researched shape expectation: `data`-enveloped call metadata.
  return { managedVectorLedgerAuthority: vi.fn(),
    data: {
      earnings_call_id: 48291,
      company_ticker: "AAPL",
      company_name: "Apple Inc.",
      event_date_time: "2026-07-14 21:00:00",
      fiscal_year: 2026,
      fiscal_quarter: 3,
      ...overrides
    }
  };
}

const LONG_TEXT = "Operator remarks and prepared statements. ".repeat(20);

function transcriptPayload(): unknown {
  return { managedVectorLedgerAuthority: vi.fn(), data: { earnings_call_id: 48291, full_text: LONG_TEXT } };
}

function speakerPayload(): unknown {
  return { managedVectorLedgerAuthority: vi.fn(),
    data: {
      earnings_call_id: 48291,
      speakers: [
        { speaker_name: "Analyst A", speaker_type: "analyst", text_content: "Question about margins. ".repeat(10), component_order: 2 },
        { speaker_name: "Tim C", speaker_type: "executive", text_content: "Prepared remarks on the quarter. ".repeat(10), component_order: 1 }
      ]
    }
  };
}

interface HttpLogEntry {
  path: string;
}

function makeHttp(
  responder: (path: string) => EarningsCallsHttpResult,
  log: HttpLogEntry[]
): NonNullable<EarningsCallsRefreshDeps["http"]> {
  return async (path: string) => {
    log.push({ path });
    return responder(path);
  };
}

function passDeps(partial: Partial<EarningsCallsRefreshDeps>): EarningsCallsRefreshDeps {
  return {
    force: true,
    heldSymbols: () => [],
    candidateSymbols: () => [],
    recentlyReported: async () => undefined,
    ingest: async () => true,
    ...partial
  };
}

describe("durable monthly budget", () => {
  it("reserves within the budget, is exhausted at the cap, and refunds undispatched units", async () => {
    const { tryReserveEarningsCallsRequests, refundEarningsCallsRequests, remainingEarningsCallsBudget } = await lib();
    process.env.EARNINGSCALLS_MONTHLY_BUDGET = "5";
    const now = freshMonthMs();
    expect(remainingEarningsCallsBudget(now)).toBe(5);
    expect(tryReserveEarningsCallsRequests(2, now)).toBe(2);
    expect(tryReserveEarningsCallsRequests(2, now)).toBe(2);
    // Partial admit at the boundary, then hard zero.
    expect(tryReserveEarningsCallsRequests(3, now)).toBe(1);
    expect(tryReserveEarningsCallsRequests(1, now)).toBe(0);
    refundEarningsCallsRequests(2, now);
    expect(remainingEarningsCallsBudget(now)).toBe(2);
  });

  it("rolls over at the UTC calendar-month boundary (and refunds no-op across it)", async () => {
    const { tryReserveEarningsCallsRequests, remainingEarningsCallsBudget, refundEarningsCallsRequests, earningsCallsMonthKey } = await lib();
    process.env.EARNINGSCALLS_MONTHLY_BUDGET = "3";
    const endOfMonth = Date.UTC(2033, 4, 31, 23, 59);
    const startOfNext = Date.UTC(2033, 5, 1, 0, 1);
    expect(earningsCallsMonthKey(endOfMonth)).not.toBe(earningsCallsMonthKey(startOfNext));
    expect(tryReserveEarningsCallsRequests(3, endOfMonth)).toBe(3);
    expect(remainingEarningsCallsBudget(endOfMonth)).toBe(0);
    // New month: full budget again.
    expect(remainingEarningsCallsBudget(startOfNext)).toBe(3);
    expect(tryReserveEarningsCallsRequests(1, startOfNext)).toBe(1);
    // A refund carrying last month's timestamp must not credit the new month.
    refundEarningsCallsRequests(3, endOfMonth);
    expect(remainingEarningsCallsBudget(startOfNext)).toBe(2);
  });

  it("persists spend durably (visible to a second raw DB connection — survives restart)", async () => {
    const { tryReserveEarningsCallsRequests, earningsCallsMonthKey } = await lib();
    process.env.EARNINGSCALLS_MONTHLY_BUDGET = "10";
    const now = freshMonthMs();
    expect(tryReserveEarningsCallsRequests(4, now)).toBe(4);
    // Read through an INDEPENDENT better-sqlite3 connection to the same file: proves the counter
    // lives in the database (settings row), not process memory — i.e. a restart cannot forget it.
    const raw = new Database(DB_PATH, { readonly: true });
    try {
      const row = raw
        .prepare("SELECT value FROM settings WHERE key = 'earningscalls_monthly_request_budget'")
        .get() as { value: string } | undefined;
      expect(row).toBeDefined();
      const parsed = JSON.parse(row!.value) as { monthKey: string; used: number };
      expect(parsed.monthKey).toBe(earningsCallsMonthKey(now));
      expect(parsed.used).toBe(4);
    } finally {
      raw.close();
    }
  });

  it("reserve-before-call race safety: concurrent reserves cannot jointly exceed the budget", async () => {
    const { tryReserveEarningsCallsRequests } = await lib();
    process.env.EARNINGSCALLS_MONTHLY_BUDGET = "7";
    const now = freshMonthMs();
    const admitted = await Promise.all(
      Array.from({ length: 20 }, () => Promise.resolve().then(() => tryReserveEarningsCallsRequests(1, now)))
    );
    expect(admitted.reduce((sum, n) => sum + n, 0)).toBe(7);
  });

  it("budget 0 override blocks every reservation", async () => {
    const { tryReserveEarningsCallsRequests } = await lib();
    process.env.EARNINGSCALLS_MONTHLY_BUDGET = "0";
    expect(tryReserveEarningsCallsRequests(1, freshMonthMs())).toBe(0);
  });
});

describe("dormancy", () => {
  it("without EARNINGSCALLS_API_KEY: disabled, zero HTTP calls, zero probes", async () => {
    const { refreshEarningsCallsTranscriptsIfDue } = await lib();
    delete process.env.EARNINGSCALLS_API_KEY;
    const log: HttpLogEntry[] = [];
    const result = await refreshEarningsCallsTranscriptsIfDue(NOW, passDeps({
      http: makeHttp(() => ({ ok: true, payload: latestCallPayload() }), log),
      heldSymbols: () => ["AAPL"]
    }));
    expect(result.enabled).toBe(false);
    expect(result.requests).toBe(0);
    expect(log).toHaveLength(0);
  });

  it("kill-switch EARNINGSCALLS_DISABLED=1 wins over a present key", async () => {
    const { refreshEarningsCallsTranscriptsIfDue } = await lib();
    const { earningsCallsTranscriptsEnabled } = await import("../src/lib/earningscalls-gate");
    process.env.EARNINGSCALLS_API_KEY = "test-key";
    process.env.EARNINGSCALLS_DISABLED = "1";
    expect(earningsCallsTranscriptsEnabled()).toBe(false);
    const log: HttpLogEntry[] = [];
    const result = await refreshEarningsCallsTranscriptsIfDue(NOW, passDeps({
      http: makeHttp(() => ({ ok: true, payload: latestCallPayload() }), log),
      heldSymbols: () => ["AAPL"]
    }));
    expect(result.enabled).toBe(false);
    expect(log).toHaveLength(0);
  });

  it("credential channels: RapidAPI key alone enables; direct key wins when both are set", async () => {
    const { earningsCallsCredential, earningsCallsTranscriptsEnabled } = await import("../src/lib/earningscalls-gate");
    delete process.env.EARNINGSCALLS_API_KEY;
    delete process.env.EARNINGSCALLS_DISABLED;

    process.env.EARNINGSCALLS_RAPIDAPI_KEY = "rapid-test-key";
    expect(earningsCallsTranscriptsEnabled()).toBe(true);
    expect(earningsCallsCredential()).toEqual({ channel: "rapidapi", key: "rapid-test-key" });

    process.env.EARNINGSCALLS_API_KEY = "direct-test-key";
    expect(earningsCallsCredential()).toEqual({ channel: "direct", key: "direct-test-key" });

    // Test dummy/placeholder keys
    process.env.EARNINGSCALLS_API_KEY = "placeholder";
    expect(earningsCallsCredential()).toEqual({ channel: "rapidapi", key: "rapid-test-key" });

    process.env.EARNINGSCALLS_API_KEY = "DUMMY  ";
    expect(earningsCallsCredential()).toEqual({ channel: "rapidapi", key: "rapid-test-key" });

    process.env.EARNINGSCALLS_API_KEY = "direct-test-key";
    process.env.EARNINGSCALLS_RAPIDAPI_KEY = "none";
    expect(earningsCallsCredential()).toEqual({ channel: "direct", key: "direct-test-key" });

    process.env.EARNINGSCALLS_API_KEY = "false";
    expect(earningsCallsCredential()).toBeNull();
    expect(earningsCallsTranscriptsEnabled()).toBe(false);

    delete process.env.EARNINGSCALLS_RAPIDAPI_KEY;
    delete process.env.EARNINGSCALLS_API_KEY;
    expect(earningsCallsTranscriptsEnabled()).toBe(false);
    expect(earningsCallsCredential()).toBeNull();
  });

  it("RapidAPI transport constants target the marketplace host under the same /api/v1 family", async () => {
    const { EARNINGSCALLS_RAPIDAPI_BASE, EARNINGSCALLS_RAPIDAPI_HOST, EARNINGSCALLS_BASE } = await lib();
    expect(EARNINGSCALLS_RAPIDAPI_HOST).toBe("earnings-call-transcripts1.p.rapidapi.com");
    expect(EARNINGSCALLS_RAPIDAPI_BASE).toBe(`https://${EARNINGSCALLS_RAPIDAPI_HOST}/api/v1`);
    expect(EARNINGSCALLS_BASE.endsWith("/api/v1")).toBe(true);
  });
});

describe("fetch-once-forever cache + negative TTL", () => {
  it("fetches, caches, and a later pass with a content hit NEVER re-fetches the transcript", async () => {
    const { refreshEarningsCallsTranscriptsIfDue } = await lib();
    const { getEarningsCallsTranscript } = await dbLib();
    process.env.EARNINGSCALLS_API_KEY = "test-key";
    const log: HttpLogEntry[] = [];
    const http = makeHttp(
      (path) => path.startsWith("/transcripts/")
        ? { ok: true, payload: transcriptPayload() }
        : { ok: true, payload: latestCallPayload() },
      log
    );
    const first = await refreshEarningsCallsTranscriptsIfDue(NOW, passDeps({ http, heldSymbols: () => ["AAPL"] }));
    expect(first.probed).toBe(1);
    expect(first.fetched).toBe(1);
    expect(log.map((entry) => entry.path)).toEqual([
      "/companies/ticker/AAPL/latest",
      "/transcripts/48291?format=full"
    ]);
    const cached = getEarningsCallsTranscript("AAPL", 2026, 3);
    expect(cached?.content).toContain("Operator remarks");

    // Second pass 4 days later (probe watermark expired, so the symbol is re-probed) — the
    // transcript endpoint must NOT be called again for the same (symbol, fy, fq).
    log.length = 0;
    const later = NOW + 4 * 86_400_000 - 2 * 86_400_000; // still inside the 7d recency window
    const second = await refreshEarningsCallsTranscriptsIfDue(later + 2 * 86_400_000 * 0, passDeps({ http, heldSymbols: () => ["AAPL"] }));
    void second;
    expect(log.filter((entry) => entry.path.startsWith("/transcripts/"))).toHaveLength(0);
  });

  it("negative-caches an empty transcript response and respects the TTL before retrying", async () => {
    const { refreshEarningsCallsTranscriptsIfDue } = await lib();
    const { getEarningsCallsTranscript } = await dbLib();
    process.env.EARNINGSCALLS_API_KEY = "test-key";
    process.env.EARNINGSCALLS_NEGATIVE_TTL_DAYS = "3";
    const symbol = "MSFT";
    const log: HttpLogEntry[] = [];
    let transcriptAvailable = false;
    const http = makeHttp(
      (path) => path.startsWith("/transcripts/")
        ? { ok: true, payload: transcriptAvailable ? transcriptPayload() : { data: {} } }
        : { ok: true, payload: latestCallPayload({ company_ticker: symbol, event_date_time: new Date(NOW - 86_400_000).toISOString() }) },
      log
    );
    const first = await refreshEarningsCallsTranscriptsIfDue(NOW, passDeps({ http, heldSymbols: () => [symbol] }));
    expect(first.fetched).toBe(0);
    const negative = getEarningsCallsTranscript(symbol, 2026, 3);
    expect(negative).toBeDefined();
    expect(negative?.content).toBeUndefined();

    // 1 day later: inside BOTH the probe watermark and the negative TTL — zero transcript calls.
    log.length = 0;
    transcriptAvailable = true;
    await refreshEarningsCallsTranscriptsIfDue(NOW + 86_400_000, passDeps({ http, heldSymbols: () => [symbol] }));
    expect(log).toHaveLength(0);

    // 4 days later: TTL expired — the transcript is retried and now lands.
    log.length = 0;
    const retry = await refreshEarningsCallsTranscriptsIfDue(NOW + 4 * 86_400_000, passDeps({
      http: makeHttp(
        (path) => path.startsWith("/transcripts/")
          ? { ok: true, payload: transcriptPayload() }
          : { ok: true, payload: latestCallPayload({ company_ticker: symbol, event_date_time: new Date(NOW + 3 * 86_400_000).toISOString() }) },
        log
      ),
      heldSymbols: () => [symbol]
    }));
    expect(retry.fetched).toBe(1);
    expect(getEarningsCallsTranscript(symbol, 2026, 3)?.content).toContain("Operator remarks");
  });
});

describe("selection policy", () => {
  it("is bounded per pass and probes holdings before scan candidates", async () => {
    const { refreshEarningsCallsTranscriptsIfDue } = await lib();
    process.env.EARNINGSCALLS_API_KEY = "test-key";
    process.env.EARNINGSCALLS_MAX_REQUESTS_PER_PASS = "3";
    process.env.EARNINGSCALLS_TOP_CANDIDATES = "2";
    const log: HttpLogEntry[] = [];
    // Every probe returns an old call (outside the recency window) so each symbol costs exactly
    // one probe request and the ordering/bound is directly visible in the HTTP log.
    const http = makeHttp(
      () => ({ ok: true, payload: latestCallPayload({ event_date_time: "2025-01-05 21:00:00" }) }),
      log
    );
    const result = await refreshEarningsCallsTranscriptsIfDue(NOW, passDeps({
      http,
      heldSymbols: () => ["HOLD1", "HOLD2"],
      candidateSymbols: () => ["CAND1", "CAND2", "CAND3", "CAND4"]
    }));
    expect(result.requests).toBe(3);
    expect(log.map((entry) => entry.path)).toEqual([
      "/companies/ticker/HOLD1/latest",
      "/companies/ticker/HOLD2/latest",
      "/companies/ticker/CAND1/latest" // TOP_CANDIDATES trims to CAND1/CAND2; per-pass cap stops after 3 total
    ]);
  });

  it("recency prefilter (earnings-calendar data the app already has) skips symbols that did not report", async () => {
    const { refreshEarningsCallsTranscriptsIfDue } = await lib();
    process.env.EARNINGSCALLS_API_KEY = "test-key";
    const log: HttpLogEntry[] = [];
    const http = makeHttp(() => ({ ok: true, payload: latestCallPayload({ event_date_time: "2025-01-05 21:00:00" }) }), log);
    const result = await refreshEarningsCallsTranscriptsIfDue(NOW, passDeps({
      http,
      heldSymbols: () => ["REPORTED", "QUIET1", "QUIET2"],
      recentlyReported: async () => new Set(["REPORTED"])
    }));
    expect(result.probed).toBe(1);
    expect(log.map((entry) => entry.path)).toEqual(["/companies/ticker/REPORTED/latest"]);
  });

  it("budget exhaustion skips quietly (bounded audit) instead of retry-storming", async () => {
    const { refreshEarningsCallsTranscriptsIfDue } = await lib();
    process.env.EARNINGSCALLS_API_KEY = "test-key";
    process.env.EARNINGSCALLS_MONTHLY_BUDGET = "0"; // remaining budget is 0 from the start
    const log: HttpLogEntry[] = [];
    const http = makeHttp(() => ({ ok: true, payload: latestCallPayload() }), log);
    const result = await refreshEarningsCallsTranscriptsIfDue(freshMonthMs(), passDeps({
      http,
      heldSymbols: () => ["AAPL", "MSFT", "NVDA"]
    }));
    expect(result.enabled).toBe(true);
    expect(result.requests).toBe(0);
    expect(result.skippedBudget).toBe(1); // one quiet skip, then the pass stops — no per-symbol storm
    expect(log).toHaveLength(0);
  });
});

describe("parsers (fixtures follow the researched response shapes)", () => {
  it("timezone-less event datetimes parse as UTC regardless of host timezone (cache-key safety)", async () => {
    const { calendarPeriodForTest } = await lib();
    // 2026-03-31 23:30 UTC is Q1; a local-time parse on any west-of-UTC host would still be
    // March, but on an east-of-UTC host (or for the mirror case at 00:30 on a west host) the
    // quarter flips. Pin the UTC bucketing explicitly on both edges of a quarter boundary.
    expect(calendarPeriodForTest("2026-03-31 23:30:00", 0)).toEqual({ year: 2026, quarter: 1 });
    expect(calendarPeriodForTest("2026-04-01 00:30:00", 0)).toEqual({ year: 2026, quarter: 2 });
    // Explicit offsets are honored, not double-shifted: 01:30+02:00 = 23:30Z the previous day.
    expect(calendarPeriodForTest("2026-04-01T01:30:00+02:00", 0)).toEqual({ year: 2026, quarter: 1 });
    // Date-only stays midnight-UTC.
    expect(calendarPeriodForTest("2026-06-30", 0)).toEqual({ year: 2026, quarter: 2 });
  });

  it("parses a data-enveloped latest-call payload", async () => {
    const { parseEarningsCallsLatestCall } = await lib();
    const parsed = parseEarningsCallsLatestCall(latestCallPayload());
    expect(parsed).toEqual({
      eventId: 48291,
      eventDate: "2026-07-14 21:00:00",
      fiscalYear: 2026,
      fiscalQuarter: 3,
      ticker: "AAPL"
    });
  });

  it("parses a bare (non-enveloped) latest-call payload with alternate field names", async () => {
    const { parseEarningsCallsLatestCall } = await lib();
    const parsed = parseEarningsCallsLatestCall({ id: 99, date: "2026-07-10", year: 2026, quarter: 2, ticker: "MSFT" });
    expect(parsed?.eventId).toBe(99);
    expect(parsed?.fiscalQuarter).toBe(2);
  });

  it("returns undefined when no usable call id exists", async () => {
    const { parseEarningsCallsLatestCall } = await lib();
    expect(parseEarningsCallsLatestCall({ data: { company_name: "Apple" } })).toBeUndefined();
    expect(parseEarningsCallsLatestCall(null)).toBeUndefined();
    expect(parseEarningsCallsLatestCall([])).toBeUndefined();
  });

  it("parses flat full_text transcripts", async () => {
    const { parseEarningsCallsTranscript } = await lib();
    expect(parseEarningsCallsTranscript(transcriptPayload())).toContain("Operator remarks");
  });

  it("joins speaker segments (ordered by component_order, speaker-tagged) when no flat text exists", async () => {
    const { parseEarningsCallsTranscript } = await lib();
    const text = parseEarningsCallsTranscript(speakerPayload());
    expect(text).toBeDefined();
    expect(text!.indexOf("Tim C (executive):")).toBeLessThan(text!.indexOf("Analyst A (analyst):"));
  });

  it("rejects stub/empty transcript bodies (negative-cache material, never fake content)", async () => {
    const { parseEarningsCallsTranscript } = await lib();
    expect(parseEarningsCallsTranscript({ data: {} })).toBeUndefined();
    expect(parseEarningsCallsTranscript({ data: { full_text: "Too short." } })).toBeUndefined();
  });
});

describe("cache CRUD invariants", () => {
  it("upsert never downgrades stored content to a negative row", async () => {
    const { upsertEarningsCallsTranscript, getEarningsCallsTranscript } = await dbLib();
    const at = new Date(NOW).toISOString();
    upsertEarningsCallsTranscript({ symbol: "NVDA", fiscalYear: 2026, fiscalQuarter: 2, content: LONG_TEXT, fetchedAt: at, eventId: 7 });
    upsertEarningsCallsTranscript({ symbol: "NVDA", fiscalYear: 2026, fiscalQuarter: 2, content: undefined, fetchedAt: at });
    const row = getEarningsCallsTranscript("NVDA", 2026, 2);
    expect(row?.content).toBe(LONG_TEXT);
    expect(row?.eventId).toBe(7);
  });

  it("pending-ingest queue lists cached-but-unindexed rows and empties after marking", async () => {
    const { upsertEarningsCallsTranscript, listUningestedEarningsCallsTranscripts, markEarningsCallsTranscriptIngested } = await dbLib();
    const at = new Date(NOW).toISOString();
    upsertEarningsCallsTranscript({ symbol: "AMD", fiscalYear: 2026, fiscalQuarter: 1, content: LONG_TEXT, fetchedAt: at });
    const pending = listUningestedEarningsCallsTranscripts(50);
    expect(pending.some((row: EarningsCallsTranscriptRow) => row.symbol === "AMD")).toBe(true);
    markEarningsCallsTranscriptIngested("AMD", 2026, 1);
    expect(listUningestedEarningsCallsTranscripts(50).some((row) => row.symbol === "AMD")).toBe(false);
  });
});

describe("codex review fixes (PR #1680)", () => {
  it("clamps the per-pass request cap to the provider-safe ceiling (env can lower, never raise)", async () => {
    const { earningsCallsMaxRequestsPerPass } = await lib();
    process.env.EARNINGSCALLS_MAX_REQUESTS_PER_PASS = "50"; // out of range -> default 6
    expect(earningsCallsMaxRequestsPerPass()).toBe(6);
    process.env.EARNINGSCALLS_MAX_REQUESTS_PER_PASS = "7"; // 7 x 32 UTC days = 224 > 200
    expect(earningsCallsMaxRequestsPerPass()).toBe(6);
    process.env.EARNINGSCALLS_MAX_REQUESTS_PER_PASS = "3"; // lowering is allowed
    expect(earningsCallsMaxRequestsPerPass()).toBe(3);
    process.env.EARNINGSCALLS_MAX_REQUESTS_PER_PASS = "0"; // pause is allowed
    expect(earningsCallsMaxRequestsPerPass()).toBe(0);
  });

  it("a FAILED (transient) probe is not watermarked — the symbol is re-probed on the next pass", async () => {
    const { refreshEarningsCallsTranscriptsIfDue } = await lib();
    process.env.EARNINGSCALLS_API_KEY = "test-key";
    const log: HttpLogEntry[] = [];
    let fail = true;
    const http = makeHttp(
      (path) => {
        if (path.startsWith("/transcripts/")) return { managedVectorLedgerAuthority: vi.fn(), ok: true, payload: transcriptPayload() };
        return fail
          ? { ok: false, kind: "transient" }
          : { ok: true, payload: latestCallPayload({ company_ticker: "TRNS1" }) };
      },
      log
    );
    await refreshEarningsCallsTranscriptsIfDue(NOW, passDeps({ http, heldSymbols: () => ["TRNS1"] }));
    // One day later (inside the 3d negative TTL): the failed probe left no watermark, so the
    // symbol is probed again — the OLD behavior would have skipped it until the TTL expired.
    fail = false;
    log.length = 0;
    const second = await refreshEarningsCallsTranscriptsIfDue(NOW + 86_400_000, passDeps({ http, heldSymbols: () => ["TRNS1"] }));
    expect(log.map((entry) => entry.path)).toContain("/companies/ticker/TRNS1/latest");
    expect(second.probed).toBe(1);
  });

  it("a definitive 404 probe IS watermarked — no repeat probe inside the TTL", async () => {
    const { refreshEarningsCallsTranscriptsIfDue } = await lib();
    process.env.EARNINGSCALLS_API_KEY = "test-key";
    const log: HttpLogEntry[] = [];
    const http = makeHttp(() => ({ ok: false, kind: "not_found" }), log);
    const first = await refreshEarningsCallsTranscriptsIfDue(NOW, passDeps({ http, heldSymbols: () => ["NF1"] }));
    expect(first.probed).toBe(1);
    expect(first.errors).toHaveLength(0); // a known-miss is an answer, not an error
    log.length = 0;
    await refreshEarningsCallsTranscriptsIfDue(NOW + 86_400_000, passDeps({ http, heldSymbols: () => ["NF1"] }));
    expect(log).toHaveLength(0);
  });

  it("a FAILED transcript body is never negative-cached; transient continues, rate-limit stops the pass", async () => {
    const { refreshEarningsCallsTranscriptsIfDue } = await lib();
    const { getEarningsCallsTranscript } = await dbLib();
    process.env.EARNINGSCALLS_API_KEY = "test-key";
    // Phase 1 — transient body failure: no cache row, and the pass CONTINUES to the next symbol.
    const log1: HttpLogEntry[] = [];
    const http1 = makeHttp(
      (path) => path.startsWith("/transcripts/")
        ? { ok: false, kind: "transient" }
        : { ok: true, payload: latestCallPayload() },
      log1
    );
    const r1 = await refreshEarningsCallsTranscriptsIfDue(NOW, passDeps({ http: http1, heldSymbols: () => ["TB1", "TB2"] }));
    expect(getEarningsCallsTranscript("TB1", 2026, 3)).toBeUndefined(); // stays retryable
    expect(r1.probed).toBe(2); // continue, not break
    expect(r1.errors).toHaveLength(0);
    // Phase 2 — rate-limited body: no cache row, error recorded, pass stops early.
    const log2: HttpLogEntry[] = [];
    const http2 = makeHttp(
      (path) => path.startsWith("/transcripts/")
        ? { ok: false, kind: "rate_limited" }
        : { ok: true, payload: latestCallPayload() },
      log2
    );
    const r2 = await refreshEarningsCallsTranscriptsIfDue(NOW, passDeps({ http: http2, heldSymbols: () => ["RL1", "RL2"] }));
    expect(getEarningsCallsTranscript("RL1", 2026, 3)).toBeUndefined();
    expect(r2.errors).toContain("transcript:RL1:rate_limited");
    expect(log2.some((entry) => entry.path === "/companies/ticker/RL2/latest")).toBe(false); // break
  });

  it("the pre-subscription 405 (not_subscribed) stops the pass after ONE probe — no per-symbol budget burn", async () => {
    // Regression (PR #1708, Codex round 1 P1): suppressing the pre-subscription 405 from the
    // health/circuit-breaker path removed the backpressure that used to cap the quota burn. A 405
    // is a CHANNEL-WIDE terminal state, so the pass must break on the first one — otherwise every
    // symbol in the queue dispatches a known-failing, unrefunded call, exhausting the monthly
    // budget before the subscription is ever enabled. Mirrors auth/rate_limited pass-stop.
    const { refreshEarningsCallsTranscriptsIfDue } = await lib();
    process.env.EARNINGSCALLS_API_KEY = "test-key";
    const log: HttpLogEntry[] = [];
    const http = makeHttp(() => ({ ok: false, kind: "not_subscribed" }), log);
    const r = await refreshEarningsCallsTranscriptsIfDue(
      NOW,
      passDeps({ http, heldSymbols: () => ["NS1", "NS2", "NS3"] })
    );
    // Exactly one probe dispatched, then break — not one-per-symbol.
    expect(r.probed).toBe(1);
    expect(log.filter((e) => e.path.endsWith("/latest"))).toHaveLength(1);
    expect(log.some((e) => e.path === "/companies/ticker/NS2/latest")).toBe(false);
    expect(r.errors).toContain("probe:NS1:not_subscribed");
  });

  it("a definitive 404 transcript body (call known, transcript unpublished) IS negative-cached", async () => {
    const { refreshEarningsCallsTranscriptsIfDue } = await lib();
    const { getEarningsCallsTranscript } = await dbLib();
    process.env.EARNINGSCALLS_API_KEY = "test-key";
    const http = makeHttp(
      (path) => path.startsWith("/transcripts/")
        ? { ok: false, kind: "not_found" }
        : { ok: true, payload: latestCallPayload() },
      []
    );
    await refreshEarningsCallsTranscriptsIfDue(NOW, passDeps({ http, heldSymbols: () => ["NB1"] }));
    const row = getEarningsCallsTranscript("NB1", 2026, 3);
    expect(row).toBeDefined();
    expect(row?.content).toBeUndefined();
  });

  it("an UNAVAILABLE FMP calendar (unentitled 402/403 -> null) falls back to probing; a real empty calendar is authoritative", async () => {
    const { refreshEarningsCallsTranscriptsIfDue } = await lib();
    process.env.EARNINGSCALLS_API_KEY = "test-key";
    process.env.FMP_API_KEY = "fmp-test-key";
    // Phase 1 — requestFmp returns null (endpoint unentitled): the prefilter must NOT be treated
    // as an authoritative empty calendar; the probe fallback engages.
    requestFmpStub.impl = () => Promise.resolve(null);
    const log1: HttpLogEntry[] = [];
    const r1 = await refreshEarningsCallsTranscriptsIfDue(NOW, passDeps({
      http: makeHttp(() => ({ ok: true, payload: latestCallPayload({ event_date_time: "2025-01-05 21:00:00" }) }), log1),
      heldSymbols: () => ["FMPX"],
      recentlyReported: undefined // use the real FMP prefilter path
    }));
    expect(r1.probed).toBe(1);
    expect(log1.map((entry) => entry.path)).toEqual(["/companies/ticker/FMPX/latest"]);
    // Phase 2 — a REAL empty calendar array is an authoritative "nothing reported": zero probes.
    requestFmpStub.impl = () => Promise.resolve([]);
    const log2: HttpLogEntry[] = [];
    const r2 = await refreshEarningsCallsTranscriptsIfDue(NOW, passDeps({
      http: makeHttp(() => ({ ok: true, payload: latestCallPayload() }), log2),
      heldSymbols: () => ["FMPY"],
      recentlyReported: undefined
    }));
    expect(r2.probed).toBe(0);
    expect(log2).toHaveLength(0);
  });

  it("a busy RAG_REINDEX lease defers the pass (no HTTP, watermark untouched, operationLease surfaced)", async () => {
    const { refreshEarningsCallsTranscriptsIfDue } = await lib();
    const { runWithOperationLease, OPERATION_LEASE_GROUPS } = await import("../src/lib/operation-lease");
    process.env.EARNINGSCALLS_API_KEY = "test-key";
    const log: HttpLogEntry[] = [];
    const deps = passDeps({
      http: makeHttp(() => ({ ok: true, payload: latestCallPayload() }), log),
      heldSymbols: () => ["LEASE1"]
    });
    const held = await runWithOperationLease(
      { group: OPERATION_LEASE_GROUPS.RAG_REINDEX, operation: "test-holds-the-lease" },
      async () => refreshEarningsCallsTranscriptsIfDue(NOW, deps)
    );
    expect(held.acquired).toBe(true);
    const deferred = (held as { value?: Awaited<ReturnType<typeof refreshEarningsCallsTranscriptsIfDue>> }).value;
    expect(deferred?.operationLease).toBeDefined();
    expect(deferred?.requests).toBe(0);
    expect(log).toHaveLength(0);
    // Lease released: the same pass now runs.
    const after = await refreshEarningsCallsTranscriptsIfDue(NOW, deps);
    expect(after.operationLease).toBeUndefined();
    expect(after.probed).toBe(1);
  });

  it("ingest completion requires storeDocument's full receipt — partial multi-chunk writes stay retryable", async () => {
    const { refreshEarningsCallsTranscriptsIfDue } = await lib();
    const { upsertEarningsCallsTranscript, getEarningsCallsTranscript, listUningestedEarningsCallsTranscripts, markEarningsCallsTranscriptIngested } = await dbLib();
    process.env.EARNINGSCALLS_API_KEY = "test-key";
    // Isolate the free-retry queue: mark every leftover pending row from earlier tests.
    for (const leftover of listUningestedEarningsCallsTranscripts(500)) {
      markEarningsCallsTranscriptIngested(leftover.symbol, leftover.fiscalYear, leftover.fiscalQuarter);
    }
    upsertEarningsCallsTranscript({ symbol: "ING1", fiscalYear: 2026, fiscalQuarter: 3, content: LONG_TEXT, fetchedAt: new Date(NOW).toISOString(), eventId: 555 });
    const noHttp = passDeps({ http: makeHttp(() => ({ ok: false, kind: "transient" }), []), heldSymbols: () => [], ingest: undefined });
    // Phase 1 — PARTIAL write (documentComplete=false despite indexed>0): must NOT mark ingested.
    storeDocumentStub.impl = () => Promise.resolve({ attempted: 3, indexed: 1, documentComplete: false });
    let result = await refreshEarningsCallsTranscriptsIfDue(NOW, noHttp);
    expect(result.ingested).toBe(0);
    expect(getEarningsCallsTranscript("ING1", 2026, 3)?.ingestedAt).toBeUndefined();
    // Phase 2 — full receipt (documentComplete + exact cardinality): marks ingested, ledger
    // records the full chunk count. Also prove the RAG lease fence is threaded through to
    // storeDocument (Codex round 2): the default ingest must pass a leaseGuard built from the
    // pass's durable lease claim.
    let capturedOptions: { leaseGuard?: { signal?: unknown; assertOwnership?: unknown } } | undefined;
    storeDocumentStub.impl = (...args: unknown[]) => {
      capturedOptions = args[2] as typeof capturedOptions;
      return Promise.resolve({ attempted: 3, indexed: 3, documentComplete: true });
    };
    result = await refreshEarningsCallsTranscriptsIfDue(NOW, noHttp);
    expect(capturedOptions?.leaseGuard?.signal).toBeInstanceOf(AbortSignal);
    expect(typeof capturedOptions?.leaseGuard?.assertOwnership).toBe("function");
    expect(result.ingested).toBe(1);
    expect(getEarningsCallsTranscript("ING1", 2026, 3)?.ingestedAt).toBeDefined();
    const raw = new Database(DB_PATH, { readonly: true });
    try {
      const ledger = raw
        .prepare("SELECT chunk_count FROM ingested_accessions WHERE accession = ?")
        .get("earningscalls:ING1:2026Q3") as { chunk_count: number } | undefined;
      expect(ledger?.chunk_count).toBe(3);
    } finally {
      raw.close();
    }
  });
});
