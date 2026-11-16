/**
 * EarningsCalls.dev transcript source (src/lib/earningscalls-transcripts.ts) — burst/smart-daily
 * program (docs/rollouts/2026-07-19-earningscalls-burst-smart-daily.md).
 *
 * Covers: dormancy without a key/with the kill-switch (must never regress — the deployed default
 * is a keyless config), the durable dual-bound budget (monthly soft + rolling-31-day ledger,
 * including a burst day's math), the entitlement probe (both a full-text pass and a
 * preview-detected block, with the one-time notification + no-retry-storm discipline), the
 * preview guard applying to every fetch (not just the first), the id-resolution listing engine's
 * cursor persistence and (symbol, fiscal_year, fiscal_quarter) -> id map, the smart picker's tier
 * ordering, one-shot burst arming/consumption, and the shape-tolerant parsers.
 *
 * IMPORTANT test-isolation notes for anyone extending this file:
 *   - The whole file shares ONE temp SQLite DB (DB_PATH below), so entitlement state, the burst
 *     counter, the listing cursor, and the monthly/rolling budget ledgers all persist ACROSS
 *     tests unless a test resets them. `primeConfirmedEntitlement()` resets entitlement/burst/
 *     cursor state to a clean slate AND pre-confirms full-text entitlement (skipping the /me
 *     probe) for tests that aren't specifically exercising the entitlement flow itself — call it
 *     at the top of any full-pass test that doesn't care about entitlement.
 *   - `primeConfirmedEntitlement()` also sets a generously high EARNINGSCALLS_MONTHLY_BUDGET /
 *     EARNINGSCALLS_ROLLING_WINDOW_BUDGET so the SHARED `NOW` constant (many tests use the same
 *     millisecond value, hence the same UTC month/day ledger buckets) can't cause one test's
 *     spend to starve a later test's budget. Dedicated budget/ledger tests use `freshMonthMs()`
 *     for a guaranteed-isolated month instead, matching the pre-existing convention.
 */
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { EarningsCallsHttpResult, EarningsCallsRefreshDeps } from "../src/lib/earningscalls-transcripts";
import type { EarningsCallsTranscriptRow } from "../src/lib/db-earningscalls";

const storeDocumentStub = vi.hoisted(() => ({
  impl: undefined as undefined | ((...args: unknown[]) => unknown)
}));
const notifyStub = vi.hoisted(() => ({
  impl: undefined as undefined | ((...args: unknown[]) => unknown),
  calls: [] as unknown[][]
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

// Spied (not fully mocked out) so "exactly ONE notification, no retry storm" is directly
// countable without depending on any real push/email/webhook channel being configured.
vi.mock("../src/lib/notifications", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/notifications")>();
  return {
    ...actual,
    sendNotification: (...args: unknown[]) => {
      notifyStub.calls.push(args);
      return notifyStub.impl
        ? notifyStub.impl(...args)
        : Promise.resolve({
            id: "test-event",
            createdAt: new Date().toISOString(),
            type: (args[0] as { type: string }).type,
            title: (args[0] as { title: string }).title,
            status: "sent",
            payload: (args[0] as { payload: unknown }).payload
          });
    }
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
  "EARNINGSCALLS_ROLLING_WINDOW_BUDGET",
  "EARNINGSCALLS_RECENT_DAYS",
  "EARNINGSCALLS_TOP_CANDIDATES",
  "EARNINGSCALLS_NEGATIVE_TTL_DAYS",
  "EARNINGSCALLS_DAILY_TARGET_TRANSCRIPTS",
  "EARNINGSCALLS_BURST_MAX_TRANSCRIPTS",
  "EARNINGSCALLS_PREVIEW_GUARD_MIN_CHARS",
  "EARNINGSCALLS_MAX_REQUESTS_PER_PASS",
  "EARNINGSCALLS_ENTITLEMENT_PROBE_ANCHOR",
  "RAG_PINECONE_WRITE_CLASS"
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
  notifyStub.impl = undefined;
  notifyStub.calls = [];
});

async function lib() {
  return import("../src/lib/earningscalls-transcripts");
}

async function dbLib() {
  return import("../src/lib/db-earningscalls");
}

/** Fresh state between budget assertions: the counters are settings rows, so tests get isolation
 *  by moving to a unique month via `nowMs` instead of mutating shared state. */
let monthCursor = Date.UTC(2030, 0, 15);
function freshMonthMs(): number {
  monthCursor += 400 * 86_400_000; // > 1 year forward — guaranteed different "YYYY-MM"
  return monthCursor;
}

const NOW = Date.UTC(2026, 6, 16, 12); // 2026-07-16T12:00Z, matches fixture event dates below

/** Reset entitlement/burst/listing-cursor state AND pre-confirm full-text entitlement (skips the
 *  /me probe) with a generous dual-bound budget, so a test that isn't specifically about
 *  entitlement/budget doesn't have to account for the probe's extra request or worry about the
 *  shared `NOW` constant's UTC-month/day ledger buckets colliding with another test's spend. */
async function primeConfirmedEntitlement(): Promise<void> {
  const { resetEarningsCallsStateForTest, setEarningsCallsEntitlementStateForTest } = await lib();
  resetEarningsCallsStateForTest();
  setEarningsCallsEntitlementStateForTest({ status: "confirmed_full" });
  process.env.EARNINGSCALLS_MONTHLY_BUDGET = "1000";
  process.env.EARNINGSCALLS_ROLLING_WINDOW_BUDGET = "1000";
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
    heldSymbolValues: () => new Map(),
    candidateSymbols: () => [],
    watchlistSymbols: () => [],
    manifestRank: () => new Map(),
    recentlyReported: async () => undefined,
    ingest: async () => true,
    ...partial
  };
}

function latestCallPayload(overrides: Record<string, unknown> = {}): unknown {
  return {
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

// Comfortably below the 1200-char default preview guard (matches the documented ~250-char preview).
const PREVIEW_TEXT = "x".repeat(250);
// Comfortably above it — a genuine full transcript.
const FULL_TEXT =
  "Operator remarks and prepared statements from the executive team covering revenue growth, gross margin trends, and forward guidance for the quarter. ".repeat(
    12
  );
// Below MIN_TRANSCRIPT_CHARS(100) but not empty — parser-level "stub" fixture (unrelated to the
// preview guard, which sits well above this).
const LONG_TEXT = "Operator remarks and prepared statements. ".repeat(20);

function transcriptPayload(overrides: Record<string, unknown> = {}): unknown {
  return { data: { earnings_call_id: 48291, full_text: FULL_TEXT, ...overrides } };
}

function previewTranscriptPayload(): unknown {
  return { data: { earnings_call_id: 48291, full_text: PREVIEW_TEXT } };
}

function speakerPayload(): unknown {
  return {
    data: {
      earnings_call_id: 48291,
      speakers: [
        { speaker_name: "Analyst A", speaker_type: "analyst", text_content: "What's the outlook? ".repeat(10), component_order: 2 },
        { speaker_name: "Tim C", speaker_type: "executive", text_content: "Thanks for joining. ".repeat(10), component_order: 1 }
      ]
    }
  };
}

describe("durable dual-bound budget (monthly soft + rolling 31-day)", () => {
  it("reserves within the monthly budget, is exhausted at the cap, and refunds undispatched units", async () => {
    const { tryReserveEarningsCallsRequests, refundEarningsCallsRequests, remainingEarningsCallsBudget } = await lib();
    process.env.EARNINGSCALLS_MONTHLY_BUDGET = "5";
    const now = freshMonthMs();
    expect(remainingEarningsCallsBudget(now)).toBe(5);
    expect(tryReserveEarningsCallsRequests(2, now)).toBe(2);
    expect(tryReserveEarningsCallsRequests(2, now)).toBe(2);
    expect(tryReserveEarningsCallsRequests(3, now)).toBe(1);
    expect(tryReserveEarningsCallsRequests(1, now)).toBe(0);
    refundEarningsCallsRequests(2, now);
    expect(remainingEarningsCallsBudget(now)).toBe(2);
  });

  it("rolls over at the UTC calendar-month boundary for the monthly bound (and refunds no-op across it)", async () => {
    const { tryReserveEarningsCallsRequests, remainingEarningsCallsBudget, refundEarningsCallsRequests, earningsCallsMonthKey } = await lib();
    process.env.EARNINGSCALLS_MONTHLY_BUDGET = "3";
    process.env.EARNINGSCALLS_ROLLING_WINDOW_BUDGET = "195";
    const endOfMonth = Date.UTC(2033, 4, 31, 23, 59);
    const startOfNext = Date.UTC(2033, 5, 1, 0, 1);
    expect(earningsCallsMonthKey(endOfMonth)).not.toBe(earningsCallsMonthKey(startOfNext));
    expect(tryReserveEarningsCallsRequests(3, endOfMonth)).toBe(3);
    expect(remainingEarningsCallsBudget(endOfMonth)).toBe(0);
    expect(remainingEarningsCallsBudget(startOfNext)).toBe(3);
    expect(tryReserveEarningsCallsRequests(1, startOfNext)).toBe(1);
    refundEarningsCallsRequests(3, endOfMonth);
    expect(remainingEarningsCallsBudget(startOfNext)).toBe(2);
  });

  it("persists spend durably (visible to a second raw DB connection — survives restart)", async () => {
    const { tryReserveEarningsCallsRequests, earningsCallsMonthKey } = await lib();
    process.env.EARNINGSCALLS_MONTHLY_BUDGET = "10";
    const now = freshMonthMs();
    expect(tryReserveEarningsCallsRequests(4, now)).toBe(4);
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

  it("budget 0 override (either bound) blocks every reservation", async () => {
    const { tryReserveEarningsCallsRequests } = await lib();
    process.env.EARNINGSCALLS_MONTHLY_BUDGET = "0";
    expect(tryReserveEarningsCallsRequests(1, freshMonthMs())).toBe(0);
  });

  it("dual bound: the ROLLING window can be the tighter constraint even when the monthly soft budget has room", async () => {
    const { tryReserveEarningsCallsRequests, remainingEarningsCallsBudget, remainingEarningsCallsRollingBudget, earningsCallsBudgetUsage } = await lib();
    process.env.EARNINGSCALLS_MONTHLY_BUDGET = "180";
    process.env.EARNINGSCALLS_ROLLING_WINDOW_BUDGET = "30";
    const now = freshMonthMs();
    expect(tryReserveEarningsCallsRequests(25, now)).toBe(25); // a burst day
    expect(remainingEarningsCallsRollingBudget(now)).toBe(5);
    expect(remainingEarningsCallsBudget(now)).toBe(5); // rolling bound wins, not the monthly 155 remaining
    const usage = earningsCallsBudgetUsage(now);
    expect(usage.monthlyRemaining).toBe(155);
    expect(usage.rollingRemaining).toBe(5);
    const nextDay = now + 86_400_000;
    expect(tryReserveEarningsCallsRequests(10, nextDay)).toBe(5); // only 5 left in the rolling window
    expect(remainingEarningsCallsBudget(nextDay)).toBe(0);
  });

  it("rolling ledger math: a 25-request burst day plus 6/day daily passes caps the SAME 31-day window at 195, not the generous monthly bound", async () => {
    const { tryReserveEarningsCallsRequests } = await lib();
    process.env.EARNINGSCALLS_MONTHLY_BUDGET = "300"; // deliberately generous — must not bind here
    process.env.EARNINGSCALLS_ROLLING_WINDOW_BUDGET = "195";
    const start = freshMonthMs();
    let total = tryReserveEarningsCallsRequests(25, start); // the burst
    for (let day = 1; day <= 30; day++) {
      total += tryReserveEarningsCallsRequests(6, start + day * 86_400_000);
    }
    // Requested 25 + 30*6 = 205 inside a single trailing-31-day window (day0..day30 is 31 days,
    // none of which has yet fallen out of that window as of the last call) — the rolling bound
    // (195) is what actually caps the admitted total.
    expect(total).toBe(195);
  });
});

describe("dormancy (must never regress — this is the deployed default)", () => {
  it("without EARNINGSCALLS_API_KEY: disabled, zero HTTP calls, zero probes", async () => {
    const { refreshEarningsCallsTranscriptsIfDue } = await lib();
    delete process.env.EARNINGSCALLS_API_KEY;
    const log: HttpLogEntry[] = [];
    const result = await refreshEarningsCallsTranscriptsIfDue(NOW, passDeps({
      http: makeHttp(() => ({ ok: true, payload: latestCallPayload() }), log),
      heldSymbolValues: () => new Map([["AAPL", 1000]])
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
      heldSymbolValues: () => new Map([["AAPL", 1000]])
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

    process.env.EARNINGSCALLS_API_KEY = "placeholder";
    expect(earningsCallsCredential()).toEqual({ channel: "rapidapi", key: "rapid-test-key" });

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

describe("entitlement probe", () => {
  it("full-text response: confirms entitlement, proceeds normally, never notifies", async () => {
    const { refreshEarningsCallsTranscriptsIfDue, earningsCallsEntitlementState, resetEarningsCallsStateForTest } = await lib();
    process.env.EARNINGSCALLS_API_KEY = "test-key";
    process.env.EARNINGSCALLS_MONTHLY_BUDGET = "1000";
    process.env.EARNINGSCALLS_ROLLING_WINDOW_BUDGET = "1000";
    resetEarningsCallsStateForTest();
    const log: HttpLogEntry[] = [];
    const http = makeHttp((path) => {
      if (path === "/me") return { ok: true, payload: { plan: "pro", tier: "paid" } };
      if (path.startsWith("/transcripts/recent")) return { ok: true, payload: { data: [] } };
      if (path.startsWith("/companies/ticker/")) return { ok: true, payload: latestCallPayload() };
      if (path.startsWith("/transcripts/")) return { ok: true, payload: transcriptPayload() };
      return { ok: false, kind: "not_found" };
    }, log);
    const result = await refreshEarningsCallsTranscriptsIfDue(NOW, passDeps({
      http,
      heldSymbolValues: () => new Map([["ENT1", 1000]])
    }));
    expect(result.entitlementBlocked).toBeFalsy();
    expect(result.fetched).toBe(1);
    expect(log.map((e) => e.path)).toContain("/me");
    expect(earningsCallsEntitlementState().status).toBe("confirmed_full");
    expect(notifyStub.calls).toHaveLength(0);
  });

  it("preview response: blocks entitlement, refuses further work, notifies exactly once (no retry storm)", async () => {
    const { refreshEarningsCallsTranscriptsIfDue, earningsCallsEntitlementState, resetEarningsCallsStateForTest } = await lib();
    process.env.EARNINGSCALLS_API_KEY = "test-key";
    process.env.EARNINGSCALLS_MONTHLY_BUDGET = "1000";
    process.env.EARNINGSCALLS_ROLLING_WINDOW_BUDGET = "1000";
    resetEarningsCallsStateForTest();
    const log: HttpLogEntry[] = [];
    const http = makeHttp((path) => {
      if (path === "/me") return { ok: true, payload: { status: "ok" } }; // no tier text either way — the transcript-length check must be what trips this
      if (path.startsWith("/transcripts/recent")) return { ok: true, payload: { data: [] } };
      if (path.startsWith("/companies/ticker/")) return { ok: true, payload: latestCallPayload() };
      if (path.startsWith("/transcripts/")) return { ok: true, payload: previewTranscriptPayload() };
      return { ok: false, kind: "not_found" };
    }, log);

    const first = await refreshEarningsCallsTranscriptsIfDue(NOW, passDeps({
      http,
      heldSymbolValues: () => new Map([["ENT2", 1000]])
    }));
    expect(first.entitlementBlocked).toBe(true);
    const state = earningsCallsEntitlementState();
    expect(state.status).toBe("preview_blocked");
    expect(state.previewLength).toBe(PREVIEW_TEXT.length);
    expect(notifyStub.calls).toHaveLength(1);

    // No transcript row was written for the preview — never cached, never ingested.
    const { getEarningsCallsTranscript } = await dbLib();
    expect(getEarningsCallsTranscript("ENT2", 2026, 3)).toBeUndefined();

    // A second pass (even the next day, forced) REFUSES entirely: zero requests, no second
    // notification.
    log.length = 0;
    const second = await refreshEarningsCallsTranscriptsIfDue(NOW + 86_400_000, passDeps({
      http,
      heldSymbolValues: () => new Map([["ENT2", 1000]])
    }));
    expect(second.entitlementBlocked).toBe(true);
    expect(second.requests).toBe(0);
    expect(log).toHaveLength(0);
    expect(notifyStub.calls).toHaveLength(1); // still just one, ever
  });

  it("the /me tier-text sniff alone can trip the block before spending a transcript-fetch request", async () => {
    const { refreshEarningsCallsTranscriptsIfDue, earningsCallsEntitlementState, resetEarningsCallsStateForTest } = await lib();
    process.env.EARNINGSCALLS_API_KEY = "test-key";
    process.env.EARNINGSCALLS_MONTHLY_BUDGET = "1000";
    process.env.EARNINGSCALLS_ROLLING_WINDOW_BUDGET = "1000";
    resetEarningsCallsStateForTest();
    const log: HttpLogEntry[] = [];
    const http = makeHttp((path) => {
      if (path === "/me") return { ok: true, payload: { plan: "free trial preview" } };
      return { ok: true, payload: latestCallPayload() };
    }, log);
    const result = await refreshEarningsCallsTranscriptsIfDue(NOW, passDeps({
      http,
      heldSymbolValues: () => new Map([["ENT3", 1000]])
    }));
    expect(result.entitlementBlocked).toBe(true);
    expect(earningsCallsEntitlementState().status).toBe("preview_blocked");
    // Only /me was dispatched — the block fired before the listing call or any candidate work.
    expect(log.map((e) => e.path)).toEqual(["/me"]);
    expect(notifyStub.calls).toHaveLength(1);
  });

  it("clear-entitlement-block resets to unknown without spending any requests, re-arming automatic detection", async () => {
    const { resetEarningsCallsStateForTest, setEarningsCallsEntitlementStateForTest, clearEarningsCallsEntitlementBlock, earningsCallsEntitlementState } = await lib();
    resetEarningsCallsStateForTest();
    setEarningsCallsEntitlementStateForTest({ status: "preview_blocked", previewLength: 250, notifiedAt: new Date().toISOString() });
    expect(earningsCallsEntitlementState().status).toBe("preview_blocked");
    const cleared = clearEarningsCallsEntitlementBlock();
    expect(cleared.status).toBe("unknown");
    expect(earningsCallsEntitlementState().status).toBe("unknown");
  });

  it("manuallyProbeEarningsCallsEntitlement re-checks immediately, outside the once/day cadence", async () => {
    const { manuallyProbeEarningsCallsEntitlement, resetEarningsCallsStateForTest, earningsCallsEntitlementState } = await lib();
    const { runWithOperationLease, OPERATION_LEASE_GROUPS } = await import("../src/lib/operation-lease");
    process.env.EARNINGSCALLS_API_KEY = "test-key";
    process.env.EARNINGSCALLS_MONTHLY_BUDGET = "1000";
    process.env.EARNINGSCALLS_ROLLING_WINDOW_BUDGET = "1000";
    resetEarningsCallsStateForTest();
    const http = makeHttp((path) => {
      if (path === "/me") return { ok: true, payload: {} };
      if (path.startsWith("/companies/ticker/")) return { ok: true, payload: latestCallPayload({ company_ticker: "AAPL" }) };
      if (path.startsWith("/transcripts/")) return { ok: true, payload: transcriptPayload() };
      return { ok: false, kind: "not_found" };
    }, []);
    const guarded = await runWithOperationLease(
      { group: OPERATION_LEASE_GROUPS.RAG_REINDEX, operation: "test-manual-probe" },
      async (claim, signal) => manuallyProbeEarningsCallsEntitlement(NOW, claim, signal, { http })
    );
    expect(guarded.acquired).toBe(true);
    const value = (guarded as { value?: Awaited<ReturnType<typeof manuallyProbeEarningsCallsEntitlement>> }).value;
    expect(value?.state.status).toBe("confirmed_full");
    expect(earningsCallsEntitlementState().status).toBe("confirmed_full");
  });
});

describe("preview guard everywhere (not just the first fetch)", () => {
  it("a preview-length body on a LATER fetch (after entitlement was already confirmed) still blocks — defense in depth", async () => {
    await primeConfirmedEntitlement();
    const { refreshEarningsCallsTranscriptsIfDue, earningsCallsEntitlementState } = await lib();
    process.env.EARNINGSCALLS_API_KEY = "test-key";
    const { getEarningsCallsTranscript } = await dbLib();
    const http = makeHttp((path) => {
      if (path.startsWith("/transcripts/recent")) return { ok: true, payload: { data: [] } };
      if (path.startsWith("/companies/ticker/")) return { ok: true, payload: latestCallPayload({ company_ticker: "PVW1", event_date_time: "2026-07-15 10:00:00" }) };
      if (path.startsWith("/transcripts/")) return { ok: true, payload: previewTranscriptPayload() };
      return { ok: false, kind: "not_found" };
    }, []);
    const result = await refreshEarningsCallsTranscriptsIfDue(NOW, passDeps({
      http,
      heldSymbolValues: () => new Map([["PVW1", 2000]])
    }));
    expect(result.entitlementBlocked).toBe(true);
    expect(earningsCallsEntitlementState().status).toBe("preview_blocked");
    expect(getEarningsCallsTranscript("PVW1", 2026, 3)).toBeUndefined();
    expect(notifyStub.calls).toHaveLength(1);
  });

  it("a full-length body is cached and ingested normally (the guard does not reject real content)", async () => {
    await primeConfirmedEntitlement();
    const { refreshEarningsCallsTranscriptsIfDue } = await lib();
    process.env.EARNINGSCALLS_API_KEY = "test-key";
    const { getEarningsCallsTranscript } = await dbLib();
    const http = makeHttp((path) => {
      if (path.startsWith("/transcripts/recent")) return { ok: true, payload: { data: [] } };
      if (path.startsWith("/companies/ticker/")) return { ok: true, payload: latestCallPayload({ company_ticker: "PVW2", event_date_time: "2026-07-15 10:00:00" }) };
      if (path.startsWith("/transcripts/")) return { ok: true, payload: transcriptPayload() };
      return { ok: false, kind: "not_found" };
    }, []);
    const result = await refreshEarningsCallsTranscriptsIfDue(NOW, passDeps({
      http,
      heldSymbolValues: () => new Map([["PVW2", 2000]])
    }));
    console.log("RESULT IS:", JSON.stringify(result, null, 2));
    expect(result.fetched).toBe(1);
    expect(result.entitlementBlocked).toBeFalsy();
    expect(getEarningsCallsTranscript("PVW2", 2026, 3)?.content).toContain("Operator remarks");
  });
});

describe("id-resolution listing engine + (symbol, fy, fq) -> id map", () => {
  it("persists the /transcripts/recent cursor durably and resumes from it on the next pass (crash-safe)", async () => {
    await primeConfirmedEntitlement();
    const { refreshEarningsCallsTranscriptsIfDue } = await lib();
    const { getLatestEarningsCallsEventForSymbol } = await dbLib();
    process.env.EARNINGSCALLS_API_KEY = "test-key";
    const log: HttpLogEntry[] = [];
    const http = makeHttp((path) => {
      if (path.startsWith("/transcripts/recent")) {
        return {
          ok: true,
          payload: { data: [{ earnings_call_id: 9001, ticker: "ZZZ1", event_date_time: "2026-07-15 10:00:00" }], next_after_id: 9001 }
        };
      }
      return { ok: false, kind: "not_found" };
    }, log);

    await refreshEarningsCallsTranscriptsIfDue(NOW, passDeps({ http }));
    expect(log.map((e) => e.path)).toContain("/transcripts/recent?limit=100");
    expect(getLatestEarningsCallsEventForSymbol("ZZZ1")?.eventId).toBe(9001);

    // "Restart": a fresh raw connection proves the cursor lives in the DB, not process memory.
    const raw = new Database(DB_PATH, { readonly: true });
    try {
      const row = raw.prepare("SELECT value FROM settings WHERE key = 'earningscalls:recentListingCursor'").get() as
        | { value: string }
        | undefined;
      expect(row).toBeDefined();
      expect(JSON.parse(row!.value)).toBe(9001);
    } finally {
      raw.close();
    }

    log.length = 0;
    await refreshEarningsCallsTranscriptsIfDue(NOW + 86_400_000, passDeps({ http }));
    expect(log.map((e) => e.path)).toContain("/transcripts/recent?after_id=9001&limit=100");
  });

  it("a symbol with a known event-index entry skips the fallback per-symbol probe entirely", async () => {
    await primeConfirmedEntitlement();
    const { refreshEarningsCallsTranscriptsIfDue } = await lib();
    const { upsertEarningsCallsEventIndex, getEarningsCallsTranscript } = await dbLib();
    process.env.EARNINGSCALLS_API_KEY = "test-key";
    upsertEarningsCallsEventIndex({
      symbol: "IDX9",
      fiscalYear: 2026,
      fiscalQuarter: 3,
      eventId: 5555,
      eventDate: "2026-07-15 10:00:00",
      source: "listing"
    });
    const log: HttpLogEntry[] = [];
    const http = makeHttp((path) => {
      if (path.startsWith("/transcripts/recent")) return { ok: true, payload: { data: [] } };
      if (path === "/transcripts/5555?format=full") return { ok: true, payload: transcriptPayload() };
      // A probe hit here would prove the fallback was NOT skipped — fail loudly.
      if (path.startsWith("/companies/ticker/")) return { ok: false, kind: "not_found" };
      return { ok: false, kind: "not_found" };
    }, log);
    const result = await refreshEarningsCallsTranscriptsIfDue(NOW, passDeps({
      http,
      heldSymbolValues: () => new Map([["IDX9", 1000]])
    }));
    expect(result.fetched).toBe(1);
    expect(result.probed).toBe(0);
    expect(log.some((e) => e.path.startsWith("/companies/ticker/"))).toBe(false);
    expect(getEarningsCallsTranscript("IDX9", 2026, 3)?.content).toContain("Operator remarks");
  });

  it("(symbol, fiscal_year, fiscal_quarter) -> id map: upsert/read/latest-for-symbol/has-any correctness", async () => {
    const { upsertEarningsCallsEventIndex, getEarningsCallsEventIndex, getLatestEarningsCallsEventForSymbol, hasAnyEarningsCallsEventForSymbol } = await dbLib();
    expect(hasAnyEarningsCallsEventForSymbol("MAP1")).toBe(false);
    upsertEarningsCallsEventIndex({ symbol: "MAP1", fiscalYear: 2025, fiscalQuarter: 4, eventId: 100, eventDate: "2025-12-01", source: "listing" });
    upsertEarningsCallsEventIndex({ symbol: "MAP1", fiscalYear: 2026, fiscalQuarter: 2, eventId: 200, eventDate: "2026-06-01", source: "probe" });
    expect(hasAnyEarningsCallsEventForSymbol("MAP1")).toBe(true);
    expect(getEarningsCallsEventIndex("MAP1", 2025, 4)?.eventId).toBe(100);
    const latest = getLatestEarningsCallsEventForSymbol("MAP1");
    expect(latest).toEqual(expect.objectContaining({ fiscalYear: 2026, fiscalQuarter: 2, eventId: 200 }));

    // event_id always takes the incoming value; a missing event_date on a later upsert never
    // clobbers a previously-known one (COALESCE).
    upsertEarningsCallsEventIndex({ symbol: "MAP2", fiscalYear: 2026, fiscalQuarter: 1, eventId: 10, eventDate: "2026-03-01", source: "probe" });
    upsertEarningsCallsEventIndex({ symbol: "MAP2", fiscalYear: 2026, fiscalQuarter: 1, eventId: 11, source: "listing" });
    const row = getEarningsCallsEventIndex("MAP2", 2026, 1);
    expect(row?.eventId).toBe(11);
    expect(row?.eventDate).toBe("2026-03-01");
    expect(row?.source).toBe("listing");
  });
});

describe("smart picker (scoreEarningsCallsCandidates)", () => {
  it("orders by tier first (holdings > earnings recency > scan-rank > watchlist > manifest-tail), then within-tier score", async () => {
    const { scoreEarningsCallsCandidates } = await lib();
    const scored = scoreEarningsCallsCandidates({
      holdingsValue: new Map([["SMALL", 100], ["BIG", 5000]]),
      recentlyReportedSymbols: new Set(["RECENT_BOOL"]),
      recentEventDates: new Map([["RECENT_NEW", "2026-07-15"], ["RECENT_OLD", "2026-07-10"]]),
      scanCandidates: ["SCAN1", "SCAN2"],
      watchlistSymbols: ["WATCH1"],
      manifestRank: new Map([["TAIL2", 2], ["TAIL1", 1]])
    });
    const symbols = scored.map((c) => c.symbol);
    expect(symbols.slice(0, 2)).toEqual(["BIG", "SMALL"]);
    expect(symbols.slice(2, 5)).toEqual(["RECENT_NEW", "RECENT_OLD", "RECENT_BOOL"]);
    expect(symbols.slice(5, 7)).toEqual(["SCAN1", "SCAN2"]);
    expect(symbols[7]).toBe("WATCH1");
    expect(symbols.slice(8, 10)).toEqual(["TAIL1", "TAIL2"]);
    expect(scored.every((c) => c.rationale.length > 0)).toBe(true);
    expect(scored.map((c) => c.tier)).toEqual([1, 1, 2, 2, 2, 3, 3, 4, 5, 5]);
  });

  it("a symbol appears exactly once, at its best (lowest-numbered) tier", async () => {
    const { scoreEarningsCallsCandidates } = await lib();
    const scored = scoreEarningsCallsCandidates({
      holdingsValue: new Map([["DUPE", 10]]),
      recentlyReportedSymbols: new Set(["DUPE"]),
      scanCandidates: ["DUPE"],
      watchlistSymbols: ["DUPE"],
      manifestRank: new Map([["DUPE", 1]])
    });
    expect(scored.filter((c) => c.symbol === "DUPE")).toHaveLength(1);
    expect(scored[0].tier).toBe(1);
  });

  it("holdings with zero/negative value never enter tier 1 (they can still appear via a lower tier)", async () => {
    const { scoreEarningsCallsCandidates } = await lib();
    const scored = scoreEarningsCallsCandidates({
      holdingsValue: new Map([["ZERO", 0], ["NEG", -5]]),
      scanCandidates: ["ZERO"],
      watchlistSymbols: [],
      manifestRank: new Map()
    });
    expect(scored.some((c) => c.symbol === "NEG")).toBe(false);
    expect(scored.find((c) => c.symbol === "ZERO")?.tier).toBe(3);
  });
});

describe("burst arming (one-shot)", () => {
  it("is consumed exactly once by the next pass, then reverts to the ordinary daily target", async () => {
    await primeConfirmedEntitlement();
    const { refreshEarningsCallsTranscriptsIfDue, armEarningsCallsBurst, earningsCallsBurstPending } = await lib();
    process.env.EARNINGSCALLS_API_KEY = "test-key";
    expect(armEarningsCallsBurst(25)).toBe(25);
    expect(earningsCallsBurstPending()).toBe(25);

    const log: HttpLogEntry[] = [];
    const http = makeHttp((path) => {
      if (path.startsWith("/transcripts/recent")) return { ok: true, payload: { data: [] } };
      return { ok: false, kind: "not_found" };
    }, log);

    const first = await refreshEarningsCallsTranscriptsIfDue(NOW, passDeps({ http }));
    expect(first.isBurst).toBe(true);
    expect(earningsCallsBurstPending()).toBe(0);

    log.length = 0;
    const second = await refreshEarningsCallsTranscriptsIfDue(NOW + 86_400_000, passDeps({ http }));
    expect(second.isBurst).toBe(false);
  });

  it("armEarningsCallsBurst clamps to the configured ceiling", async () => {
    const { armEarningsCallsBurst, earningsCallsBurstPending } = await lib();
    process.env.EARNINGSCALLS_BURST_MAX_TRANSCRIPTS = "25";
    expect(armEarningsCallsBurst(1000)).toBe(25);
    expect(earningsCallsBurstPending()).toBe(25);
    expect(armEarningsCallsBurst(-5)).toBe(0);
  });

  it("a burst fetches even outside the recency window (an ordinary daily pass would skip it)", async () => {
    await primeConfirmedEntitlement();
    const { refreshEarningsCallsTranscriptsIfDue } = await lib();
    process.env.EARNINGSCALLS_API_KEY = "test-key";
    process.env.EARNINGSCALLS_RECENT_DAYS = "7";
    const { getEarningsCallsTranscript } = await dbLib();
    const oldEventDate = "2026-01-01 10:00:00"; // months before NOW — outside a 7-day window
    const log: HttpLogEntry[] = [];
    const http = makeHttp((path) => {
      if (path.startsWith("/transcripts/recent")) return { ok: true, payload: { data: [] } };
      if (path.startsWith("/companies/ticker/")) return { ok: true, payload: latestCallPayload({ company_ticker: "OLDCO", event_date_time: oldEventDate, fiscal_year: 2025, fiscal_quarter: 4 }) };
      if (path.startsWith("/transcripts/")) return { ok: true, payload: transcriptPayload() };
      return { ok: false, kind: "not_found" };
    }, log);
    const result = await refreshEarningsCallsTranscriptsIfDue(NOW, passDeps({
      http,
      burstTranscripts: 1,
      heldSymbolValues: () => new Map([["OLDCO", 1000]])
    }));
    expect(result.isBurst).toBe(true);
    expect(result.fetched).toBe(1);
    expect(getEarningsCallsTranscript("OLDCO", 2025, 4)?.content).toContain("Operator remarks");
  });

  it("burst targeted-historical backfill: a held symbol with zero coverage gets a full call-history resolve", async () => {
    await primeConfirmedEntitlement();
    const { refreshEarningsCallsTranscriptsIfDue } = await lib();
    process.env.EARNINGSCALLS_API_KEY = "test-key";
    const { getEarningsCallsTranscript, getLatestEarningsCallsEventForSymbol } = await dbLib();
    const log: HttpLogEntry[] = [];
    const http = makeHttp((path) => {
      if (path.startsWith("/transcripts/recent")) return { ok: true, payload: { data: [] } };
      if (path === "/companies/ticker/HIST1") {
        return {
          ok: true,
          payload: {
            data: [
              { earnings_call_id: 301, fiscal_year: 2025, fiscal_quarter: 2, event_date_time: "2025-06-01" },
              { earnings_call_id: 302, fiscal_year: 2025, fiscal_quarter: 3, event_date_time: "2025-09-01" }
            ]
          }
        };
      }
      if (path === "/transcripts/302?format=full") return { ok: true, payload: transcriptPayload() };
      return { ok: false, kind: "not_found" };
    }, log);
    const result = await refreshEarningsCallsTranscriptsIfDue(NOW, passDeps({
      http,
      burstTranscripts: 5,
      heldSymbolValues: () => new Map([["HIST1", 5000]])
    }));
    expect(log.some((e) => e.path === "/companies/ticker/HIST1")).toBe(true);
    expect(getLatestEarningsCallsEventForSymbol("HIST1")).toEqual(expect.objectContaining({ fiscalYear: 2025, fiscalQuarter: 3, eventId: 302 }));
    expect(result.fetched).toBe(1);
    expect(getEarningsCallsTranscript("HIST1", 2025, 3)?.content).toContain("Operator remarks");
  });
});

describe("fetch-once-forever cache + negative TTL (unchanged product invariant)", () => {
  it("fetches, caches, and a later pass with a content hit NEVER re-fetches the transcript", async () => {
    await primeConfirmedEntitlement();
    const { refreshEarningsCallsTranscriptsIfDue } = await lib();
    const { getEarningsCallsTranscript } = await dbLib();
    process.env.EARNINGSCALLS_API_KEY = "test-key";
    const log: HttpLogEntry[] = [];
    const http = makeHttp((path) => {
      if (path.startsWith("/transcripts/recent")) return { ok: true, payload: { data: [] } };
      return path.startsWith("/transcripts/")
        ? { ok: true, payload: transcriptPayload() }
        : { ok: true, payload: latestCallPayload({ company_ticker: "FOF1" }) };
    }, log);
    const first = await refreshEarningsCallsTranscriptsIfDue(NOW, passDeps({ http, heldSymbolValues: () => new Map([["FOF1", 1000]]) }));
    expect(first.probed).toBe(1);
    expect(first.fetched).toBe(1);
    expect(log.map((e) => e.path)).toContain("/companies/ticker/FOF1/latest");
    expect(log.map((e) => e.path)).toContain("/transcripts/48291?format=full");
    const cached = getEarningsCallsTranscript("FOF1", 2026, 3);
    expect(cached?.content).toContain("Operator remarks");

    log.length = 0;
    const second = await refreshEarningsCallsTranscriptsIfDue(NOW + 86_400_000, passDeps({ http, heldSymbolValues: () => new Map([["FOF1", 1000]]) }));
    void second;
    expect(log.filter((e) => e.path.startsWith("/transcripts/") && !e.path.startsWith("/transcripts/recent"))).toHaveLength(0);
  });

  it("negative-caches an empty ANSWERED transcript response and respects the TTL before retrying", async () => {
    await primeConfirmedEntitlement();
    const { refreshEarningsCallsTranscriptsIfDue } = await lib();
    const { getEarningsCallsTranscript } = await dbLib();
    process.env.EARNINGSCALLS_API_KEY = "test-key";
    process.env.EARNINGSCALLS_NEGATIVE_TTL_DAYS = "3";
    const symbol = "FOF2";
    let transcriptAvailable = false;
    const http = makeHttp((path) => {
      if (path.startsWith("/transcripts/recent")) return { ok: true, payload: { data: [] } };
      if (path.startsWith("/transcripts/")) return transcriptAvailable ? { ok: true, payload: transcriptPayload() } : { ok: true, payload: { data: {} } };
      return { ok: true, payload: latestCallPayload({ company_ticker: symbol, event_date_time: new Date(NOW - 86_400_000).toISOString() }) };
    }, []);
    const first = await refreshEarningsCallsTranscriptsIfDue(NOW, passDeps({ http, heldSymbolValues: () => new Map([[symbol, 1000]]) }));
    expect(first.fetched).toBe(0);
    const negative = getEarningsCallsTranscript(symbol, 2026, 3);
    expect(negative).toBeDefined();
    expect(negative?.content).toBeUndefined();

    transcriptAvailable = true;
    const stillWithinTtl = await refreshEarningsCallsTranscriptsIfDue(NOW + 86_400_000, passDeps({ http, heldSymbolValues: () => new Map([[symbol, 1000]]) }));
    expect(stillWithinTtl.fetched).toBe(0);

    const retry = await refreshEarningsCallsTranscriptsIfDue(NOW + 4 * 86_400_000, passDeps({ http, heldSymbolValues: () => new Map([[symbol, 1000]]) }));
    expect(retry.fetched).toBe(1);
    expect(getEarningsCallsTranscript(symbol, 2026, 3)?.content).toContain("Operator remarks");
  });
});

describe("parsers (fixtures follow the researched response shapes)", () => {
  it("timezone-less event datetimes parse as UTC regardless of host timezone (cache-key safety)", async () => {
    const { calendarPeriodForTest } = await lib();
    expect(calendarPeriodForTest("2026-03-31 23:30:00", 0)).toEqual({ year: 2026, quarter: 1 });
    expect(calendarPeriodForTest("2026-04-01 00:30:00", 0)).toEqual({ year: 2026, quarter: 2 });
    expect(calendarPeriodForTest("2026-04-01T01:30:00+02:00", 0)).toEqual({ year: 2026, quarter: 1 });
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
    console.log("TEXT IS:", text);
    console.log("PAYLOAD IS:", JSON.stringify(speakerPayload()));
    expect(text).toBeDefined();
    expect(text!.indexOf("Tim C (executive):")).toBeLessThan(text!.indexOf("Analyst A (analyst):"));
  });

  it("rejects stub/empty transcript bodies (negative-cache material, never fake content)", async () => {
    const { parseEarningsCallsTranscript } = await lib();
    expect(parseEarningsCallsTranscript({ data: {} })).toBeUndefined();
    expect(parseEarningsCallsTranscript({ data: { full_text: "Too short." } })).toBeUndefined();
    // Passes the base 100-char floor but is well below the preview guard — the PARSER still
    // returns it (that's the point: the preview guard is a SEPARATE, later check, not the
    // parser's job — see classifyFetchedContent / EARNINGSCALLS_PREVIEW_GUARD_MIN_CHARS).
    expect(parseEarningsCallsTranscript({ data: { full_text: LONG_TEXT } })).toContain("Operator remarks");
  });

  it("parses /transcripts/recent-style listing pages: items + next_after_id cursor, shape-tolerant", async () => {
    const { parseEarningsCallsListingPage } = await lib();
    const page = parseEarningsCallsListingPage({
      data: [
        { earnings_call_id: 1, ticker: "A", event_date_time: "2026-07-01", fiscal_year: 2026, fiscal_quarter: 2 },
        { id: 2, symbol: "B", date: "2026-07-02" }
      ],
      next_after_id: 2
    });
    expect(page.items).toHaveLength(2);
    expect(page.items[0]).toEqual({ eventId: 1, eventDate: "2026-07-01", fiscalYear: 2026, fiscalQuarter: 2, ticker: "A" });
    expect(page.items[1].ticker).toBe("B");
    expect(page.nextAfterId).toBe(2);
  });

  it("listing page parser tolerates a bare array (no cursor) and a nested items key", async () => {
    const { parseEarningsCallsListingPage } = await lib();
    const bare = parseEarningsCallsListingPage([{ id: 7, ticker: "C" }]);
    expect(bare.items).toHaveLength(1);
    expect(bare.nextAfterId).toBeUndefined();
    const nested = parseEarningsCallsListingPage({ data: { items: [{ id: 8, ticker: "D" }] } });
    expect(nested.items).toHaveLength(1);
    expect(nested.items[0].ticker).toBe("D");
    const garbage = parseEarningsCallsListingPage({ unrelated: true });
    expect(garbage.items).toEqual([]);
  });
});

describe("cache CRUD invariants", () => {
  it("upsert never downgrades stored content to a negative row", async () => {
    const { upsertEarningsCallsTranscript, getEarningsCallsTranscript } = await dbLib();
    const at = new Date(NOW).toISOString();
    upsertEarningsCallsTranscript({ symbol: "CRUD1", fiscalYear: 2026, fiscalQuarter: 2, content: LONG_TEXT, fetchedAt: at, eventId: 7 });
    upsertEarningsCallsTranscript({ symbol: "CRUD1", fiscalYear: 2026, fiscalQuarter: 2, content: undefined, fetchedAt: at });
    const row = getEarningsCallsTranscript("CRUD1", 2026, 2);
    expect(row?.content).toBe(LONG_TEXT);
    expect(row?.eventId).toBe(7);
  });

  it("pending-ingest queue lists cached-but-unindexed rows and empties after marking", async () => {
    const { upsertEarningsCallsTranscript, listUningestedEarningsCallsTranscripts, markEarningsCallsTranscriptIngested } = await dbLib();
    const at = new Date(NOW).toISOString();
    upsertEarningsCallsTranscript({ symbol: "CRUD2", fiscalYear: 2026, fiscalQuarter: 1, content: LONG_TEXT, fetchedAt: at });
    const pending = listUningestedEarningsCallsTranscripts(50);
    expect(pending.some((row: EarningsCallsTranscriptRow) => row.symbol === "CRUD2")).toBe(true);
    markEarningsCallsTranscriptIngested("CRUD2", 2026, 1);
    expect(listUningestedEarningsCallsTranscripts(50).some((row) => row.symbol === "CRUD2")).toBe(false);
  });
});

describe("resolution fallback + lease/ingest semantics (adapted from the pre-redesign coverage)", () => {
  it("a definitive 404 fallback probe IS watermarked — no repeat probe inside the negative TTL", async () => {
    await primeConfirmedEntitlement();
    const { refreshEarningsCallsTranscriptsIfDue } = await lib();
    process.env.EARNINGSCALLS_API_KEY = "test-key";
    const log: HttpLogEntry[] = [];
    const http = makeHttp((path) => (path.startsWith("/transcripts/recent") ? { ok: true, payload: { data: [] } } : { ok: false, kind: "not_found" }), log);
    const first = await refreshEarningsCallsTranscriptsIfDue(NOW, passDeps({ http, heldSymbolValues: () => new Map([["NF1", 1000]]) }));
    expect(first.probed).toBe(1);
    expect(first.errors).toHaveLength(0);
    log.length = 0;
    await refreshEarningsCallsTranscriptsIfDue(NOW + 86_400_000, passDeps({ http, heldSymbolValues: () => new Map([["NF1", 1000]]) }));
    expect(log.some((e) => e.path.startsWith("/companies/ticker/"))).toBe(false);
  });

  it("a busy RAG_REINDEX lease defers the pass (no HTTP, watermark untouched, operationLease surfaced)", async () => {
    await primeConfirmedEntitlement();
    const { refreshEarningsCallsTranscriptsIfDue } = await lib();
    const { runWithOperationLease, OPERATION_LEASE_GROUPS } = await import("../src/lib/operation-lease");
    process.env.EARNINGSCALLS_API_KEY = "test-key";
    const log: HttpLogEntry[] = [];
    const deps = passDeps({
      http: makeHttp((path) => (path.startsWith("/transcripts/recent") ? { ok: true, payload: { data: [] } } : { ok: true, payload: latestCallPayload() }), log),
      heldSymbolValues: () => new Map([["LEASE1", 1000]])
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
    const after = await refreshEarningsCallsTranscriptsIfDue(NOW, deps);
    expect(after.operationLease).toBeUndefined();
    expect(after.probed).toBe(1);
  });

  it("ingest completion requires storeDocument's full receipt — partial multi-chunk writes stay retryable, and the lease fence threads through", async () => {
    await primeConfirmedEntitlement();
    const { refreshEarningsCallsTranscriptsIfDue } = await lib();
    const { upsertEarningsCallsTranscript, getEarningsCallsTranscript, listUningestedEarningsCallsTranscripts, markEarningsCallsTranscriptIngested } = await dbLib();
    process.env.EARNINGSCALLS_API_KEY = "test-key";
    for (const leftover of listUningestedEarningsCallsTranscripts(500)) {
      markEarningsCallsTranscriptIngested(leftover.symbol, leftover.fiscalYear, leftover.fiscalQuarter);
    }
    upsertEarningsCallsTranscript({ symbol: "ING1", fiscalYear: 2026, fiscalQuarter: 3, content: LONG_TEXT, fetchedAt: new Date(NOW).toISOString(), eventId: 555 });
    const noHttp = passDeps({ http: makeHttp(() => ({ ok: false, kind: "not_found" }), []), ingest: undefined });

    storeDocumentStub.impl = () => Promise.resolve({ attempted: 3, indexed: 1, documentComplete: false });
    let result = await refreshEarningsCallsTranscriptsIfDue(NOW, noHttp);
    expect(result.ingested).toBe(0);
    expect(getEarningsCallsTranscript("ING1", 2026, 3)?.ingestedAt).toBeUndefined();

    let capturedOptions: { leaseGuard?: { signal?: unknown; assertOwnership?: unknown } } | undefined;
    storeDocumentStub.impl = (...args: unknown[]) => {
      // Full transcript ingest passes leaseGuard; the follow-on earnings-summary abstract does not.
      const opts = args[2] as typeof capturedOptions;
      if (opts?.leaseGuard) capturedOptions = opts;
      return Promise.resolve({ attempted: 3, indexed: 3, documentComplete: true });
    };
    result = await refreshEarningsCallsTranscriptsIfDue(NOW, noHttp);
    expect(capturedOptions?.leaseGuard?.signal).toBeInstanceOf(AbortSignal);
    expect(typeof capturedOptions?.leaseGuard?.assertOwnership).toBe("function");
    expect(result.ingested).toBe(1);
    expect(getEarningsCallsTranscript("ING1", 2026, 3)?.ingestedAt).toBeDefined();
    const raw = new Database(DB_PATH, { readonly: true });
    try {
      const ledger = raw.prepare("SELECT chunk_count FROM ingested_accessions WHERE accession = ?").get("earningscalls:ING1:2026Q3") as
        | { chunk_count: number }
        | undefined;
      expect(ledger?.chunk_count).toBe(3);
    } finally {
      raw.close();
    }
  });

  it("an UNAVAILABLE recency calendar (undefined) falls back to probing; a real empty calendar is authoritative (quiet day, 0 requests)", async () => {
    await primeConfirmedEntitlement();
    const { refreshEarningsCallsTranscriptsIfDue } = await lib();
    process.env.EARNINGSCALLS_API_KEY = "test-key";
    const log1: HttpLogEntry[] = [];
    const r1 = await refreshEarningsCallsTranscriptsIfDue(NOW, passDeps({
      http: makeHttp((path) => (path.startsWith("/transcripts/recent") ? { ok: true, payload: { data: [] } } : { ok: true, payload: latestCallPayload({ event_date_time: "2025-01-05 21:00:00" }) }), log1),
      heldSymbolValues: () => new Map([["CALX", 1000]]),
      recentlyReported: () => Promise.resolve(undefined)
    }));
    expect(r1.probed).toBe(1);

    const log2: HttpLogEntry[] = [];
    const r2 = await refreshEarningsCallsTranscriptsIfDue(NOW, passDeps({
      http: makeHttp(() => ({ ok: true, payload: latestCallPayload() }), log2),
      heldSymbolValues: () => new Map([["CALY", 1000]]),
      recentlyReported: () => Promise.resolve(new Set<string>())
    }));
    expect(r2.probed).toBe(0);
    expect(log2).toHaveLength(0); // quiet day: not even the listing call
  });

  it("budget exhaustion skips quietly (bounded audit) instead of retry-storming", async () => {
    await primeConfirmedEntitlement();
    const { refreshEarningsCallsTranscriptsIfDue } = await lib();
    process.env.EARNINGSCALLS_API_KEY = "test-key";
    process.env.EARNINGSCALLS_MONTHLY_BUDGET = "0";
    const log: HttpLogEntry[] = [];
    const result = await refreshEarningsCallsTranscriptsIfDue(freshMonthMs(), passDeps({
      http: makeHttp(() => ({ ok: true, payload: latestCallPayload() }), log),
      heldSymbolValues: () => new Map([["AAPL", 3000], ["MSFT", 2000], ["NVDA", 1000]])
    }));
    expect(result.enabled).toBe(true);
    expect(result.requests).toBe(0);
    expect(result.skippedBudget).toBe(1); // one quiet skip, then the pass stops — no per-symbol storm
    expect(log).toHaveLength(0);
  });
});

describe("signal sections + local FTS (ROIC mirror)", () => {
  const SPEAKER_TEXT = [
    "Tim Cook (CEO): Welcome everyone. Revenue grew double digits and services hit a record.",
    "Luca Maestri (CFO): Gross margin expanded on mix and we remain confident in the outlook.",
    "Operator: First question from Jane Doe.",
    "Jane Doe (Analyst): Can you talk about iPhone demand in China?",
    "Tim Cook (CEO): China demand was solid with strong upgrade cycles.",
    "Operator: Next question from John Smith.",
    "John Smith (Analyst): How should we think about services growth?",
    "Luca Maestri (CFO): Services growth remains durable across categories."
  ].join("\n\n");

  it("earningsCallsSpeakerSections prefers speaker/role markers and falls back to half/half", async () => {
    const { earningsCallsSpeakerSections } = await lib();
    const labeled = earningsCallsSpeakerSections(SPEAKER_TEXT);
    expect(labeled.some((s) => s.itemCode === "management")).toBe(true);
    expect(labeled.some((s) => s.itemCode === "analyst" || s.itemCode === "qa")).toBe(true);
    expect(labeled.some((s) => s.itemCode === "operator")).toBe(true);

    const plain = "Prepared remarks without labels. ".repeat(40) + "\n\n" + "More commentary after the break. ".repeat(40);
    const fallback = earningsCallsSpeakerSections(plain);
    expect(fallback.map((s) => s.itemCode)).toEqual(["management", "qa"]);
    expect(fallback[0]!.text.length).toBeGreaterThan(50);
    expect(fallback[1]!.text.length).toBeGreaterThan(50);
  });

  it("highlight+signal skips full-body storeDocument, attempts signal extras, and writes FTS for earningscalls:AAPL:2024Q1", async () => {
    await primeConfirmedEntitlement();
    const { refreshEarningsCallsTranscriptsIfDue, accessionFor } = await lib();
    const { upsertEarningsCallsTranscript, listUningestedEarningsCallsTranscripts, markEarningsCallsTranscriptIngested } =
      await dbLib();
    const { pinBareSecAccession, countLocalFtsRows } = await import("../src/lib/rag/persist-local-complete");
    process.env.EARNINGSCALLS_API_KEY = "test-key";
    process.env.RAG_PINECONE_WRITE_CLASS = "highlight+signal";
    for (const leftover of listUningestedEarningsCallsTranscripts(500)) {
      markEarningsCallsTranscriptIngested(leftover.symbol, leftover.fiscalYear, leftover.fiscalQuarter);
    }
    // Clear any prior AAPL 2024Q1 ingest from an earlier test in this shared DB.
    const { getDb } = await import("../src/lib/db");
    getDb()
      .prepare(
        `UPDATE earningscalls_transcripts SET ingested_at = NULL
         WHERE symbol = 'AAPL' AND fiscal_year = 2024 AND fiscal_quarter = 1`
      )
      .run();
    upsertEarningsCallsTranscript({
      symbol: "AAPL",
      fiscalYear: 2024,
      fiscalQuarter: 1,
      content: SPEAKER_TEXT,
      fetchedAt: new Date(NOW).toISOString(),
      eventId: 4242
    });
    const accession = accessionFor({ symbol: "AAPL", fiscalYear: 2024, fiscalQuarter: 1 });
    expect(accession).toBe("earningscalls:AAPL:2024Q1");
    expect(pinBareSecAccession(accession)).toBe(accession);

    const calls: Array<{ docId?: string; documentKey?: string; docType?: string }> = [];
    storeDocumentStub.impl = (...args: unknown[]) => {
      const doc = args[0] as { doc_id?: string; doc_type?: string };
      const opts = args[2] as { documentKey?: string } | undefined;
      calls.push({ docId: doc?.doc_id, documentKey: opts?.documentKey, docType: doc?.doc_type });
      return Promise.resolve({ attempted: 2, indexed: 2, documentComplete: true });
    };

    const result = await refreshEarningsCallsTranscriptsIfDue(
      NOW,
      passDeps({ http: makeHttp(() => ({ ok: false, kind: "not_found" }), []), ingest: undefined })
    );
    expect(result.ingested).toBe(1);

    const fullBodyCalls = calls.filter(
      (c) => c.documentKey === accession || c.docId === accession
    );
    expect(fullBodyCalls).toHaveLength(0);

    const signalCalls = calls.filter(
      (c) =>
        String(c.documentKey ?? c.docId ?? "").includes(":section:") &&
        String(c.documentKey ?? c.docId ?? "").includes(accession)
    );
    expect(signalCalls.length).toBeGreaterThan(0);
    expect(countLocalFtsRows(accession)).toBeGreaterThan(0);

    const raw = new Database(DB_PATH, { readonly: true });
    try {
      const rows = raw
        .prepare("SELECT COUNT(*) AS n FROM document_chunks_fts WHERE accession = ?")
        .get(accession) as { n: number };
      expect(rows.n).toBeGreaterThan(0);
    } finally {
      raw.close();
    }
  });

  it("default full-body write-class still storeDocuments the transcript body", async () => {
    await primeConfirmedEntitlement();
    const { refreshEarningsCallsTranscriptsIfDue, accessionFor } = await lib();
    const { upsertEarningsCallsTranscript, listUningestedEarningsCallsTranscripts, markEarningsCallsTranscriptIngested } =
      await dbLib();
    process.env.EARNINGSCALLS_API_KEY = "test-key";
    delete process.env.RAG_PINECONE_WRITE_CLASS;
    for (const leftover of listUningestedEarningsCallsTranscripts(500)) {
      markEarningsCallsTranscriptIngested(leftover.symbol, leftover.fiscalYear, leftover.fiscalQuarter);
    }
    upsertEarningsCallsTranscript({
      symbol: "FBODY",
      fiscalYear: 2025,
      fiscalQuarter: 2,
      content: SPEAKER_TEXT,
      fetchedAt: new Date(NOW).toISOString(),
      eventId: 777
    });
    const accession = accessionFor({ symbol: "FBODY", fiscalYear: 2025, fiscalQuarter: 2 });

    const calls: Array<{ documentKey?: string; docId?: string }> = [];
    storeDocumentStub.impl = (...args: unknown[]) => {
      const doc = args[0] as { doc_id?: string };
      const opts = args[2] as { documentKey?: string } | undefined;
      calls.push({ documentKey: opts?.documentKey, docId: doc?.doc_id });
      return Promise.resolve({ attempted: 3, indexed: 3, documentComplete: true });
    };

    const result = await refreshEarningsCallsTranscriptsIfDue(
      NOW,
      passDeps({ http: makeHttp(() => ({ ok: false, kind: "not_found" }), []), ingest: undefined })
    );
    expect(result.ingested).toBe(1);
    expect(calls.some((c) => c.documentKey === accession || c.docId === accession)).toBe(true);
    expect(calls.some((c) => String(c.documentKey ?? c.docId ?? "").includes(":section:"))).toBe(true);
  });
});
