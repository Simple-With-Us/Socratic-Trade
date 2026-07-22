import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  isProviderTierCheckDue,
  probeFmpTier,
  probeMassiveTier,
  runProviderTierCheck,
  getProviderTierStatus
} from "../src/lib/provider-tier";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-provtier-${randomUUID()}.db`)}`;
});

function jsonRes(body: unknown, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const isOld = (url: string) => {
  // The history probe queries a ~2.5yr-old window; detect by the `from` date being well in the past.
  const m = url.match(/range\/1\/day\/(\d{4})-/);
  if (!m) return false;
  return Number(m[1]) <= new Date().getUTCFullYear() - 2;
};

describe("probeMassiveTier", () => {
  it("classifies paid when >2yr history is returned", async () => {
    const fetcher = (async (u: string) => jsonRes({ results: isOld(u) ? [{ c: 1 }, { c: 2 }] : [{ c: 9 }] })) as unknown as typeof fetch;
    const r = await probeMassiveTier("k", Date.now(), fetcher);
    expect(r.tier).toBe("paid");
    // Item 24: the structured signal names WHAT WAS TESTED (plan history-depth access), decoupled
    // from availability/freshness — and the prose must say it's a plan-capability check, never a
    // claim about how fresh today's served data is.
    expect(r.signal).toBe("history_depth_confirmed");
    expect(r.reason).toMatch(/plan|capability|access/i);
    expect(r.reason).toMatch(/not today's data freshness/i);
  });
  it("classifies free when the >2yr window comes back empty (2-year cap)", async () => {
    const fetcher = (async (u: string) => jsonRes({ results: isOld(u) ? [] : [{ c: 9 }] })) as unknown as typeof fetch;
    const r = await probeMassiveTier("k", Date.now(), fetcher);
    expect(r.tier).toBe("free");
    expect(r.signal).toBe("history_cap_empty");
  });
  it("classifies free on a single-call 429 (free 5/min cap)", async () => {
    const fetcher = (async () => jsonRes("rate", 429)) as unknown as typeof fetch;
    const r = await probeMassiveTier("k", Date.now(), fetcher);
    expect(r.tier).toBe("free");
    expect(r.signal).toBe("rate_limited_429");
  });
  it("classifies free when >2yr history is 403-blocked", async () => {
    const fetcher = (async (u: string) => (isOld(u) ? jsonRes("forbidden", 403) : jsonRes({ results: [{ c: 9 }] }))) as unknown as typeof fetch;
    const r = await probeMassiveTier("k", Date.now(), fetcher);
    expect(r.tier).toBe("free");
    expect(r.signal).toBe("history_cap_blocked");
  });
  it("stays unknown on a bad-key 401 (not a tier signal) or network error", async () => {
    const badKey = (async () => jsonRes("nope", 401)) as unknown as typeof fetch;
    const r1 = await probeMassiveTier("k", Date.now(), badKey);
    expect(r1.tier).toBe("unknown");
    expect(r1.signal).toBe("probe_error");
    const netErr = (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch;
    expect((await probeMassiveTier("k", Date.now(), netErr)).tier).toBe("unknown");
  });
  it("is unknown with no key", async () => {
    const r = await probeMassiveTier(undefined);
    expect(r.tier).toBe("unknown");
    expect(r.signal).toBe("no_key");
  });
});

describe("probeFmpTier", () => {
  it("classifies paid when ratios-ttm returns data", async () => {
    const fetcher = (async () => jsonRes([{ priceToEarningsRatioTTM: 30 }])) as unknown as typeof fetch;
    const r = await probeFmpTier("k", fetcher);
    expect(r.tier).toBe("paid");
    expect(r.signal).toBe("data_returned");
  });
  it("classifies free on a premium/upgrade error envelope", async () => {
    const fetcher = (async () => jsonRes({ "Error Message": "Exclusive Endpoint: upgrade your plan." })) as unknown as typeof fetch;
    const r = await probeFmpTier("k", fetcher);
    expect(r.tier).toBe("free");
    expect(r.signal).toBe("premium_gated_error");
  });
  it("classifies free on 429 (daily cap)", async () => {
    const fetcher = (async () => jsonRes("limit", 429)) as unknown as typeof fetch;
    const r = await probeFmpTier("k", fetcher);
    expect(r.tier).toBe("free");
    expect(r.signal).toBe("rate_limited_429");
  });
  it("stays unknown on an ambiguous/empty response", async () => {
    const fetcher = (async () => jsonRes([])) as unknown as typeof fetch;
    const r = await probeFmpTier("k", fetcher);
    expect(r.tier).toBe("unknown");
    expect(r.signal).toBe("ambiguous");
  });
});

describe("isProviderTierCheckDue", () => {
  // Note: nothing earlier in this file sets providerTier:lastCheckAt:local, so the first case sees it absent.
  it("is due when never run", () => {
    expect(isProviderTierCheckDue(Date.now(), "local")).toBe(true);
  });
  it("is not due before the interval elapses", async () => {
    const { setInternalSetting } = await import("../src/lib/db");
    const now = Date.now();
    setInternalSetting("providerTier:lastCheckAt:local", new Date(now - 3 * 3600_000).toISOString()); // 3h ago
    expect(isProviderTierCheckDue(now, "local")).toBe(false);
  });
  it("catches up (runs regardless of hour) once 1.5x the interval has elapsed", async () => {
    const { setInternalSetting } = await import("../src/lib/db");
    const now = Date.now();
    setInternalSetting("providerTier:lastCheckAt:local", new Date(now - 40 * 3600_000).toISOString()); // 40h ago > 36h
    expect(isProviderTierCheckDue(now, "local")).toBe(true);
  });
});

describe("runProviderTierCheck", () => {
  beforeEach(() => {
    process.env.MASSIVE_API_KEY = "massive-test";
    process.env.FMP_API_KEY = "fmp-test";
  });
  afterEach(() => {
    delete process.env.MASSIVE_API_KEY;
    delete process.env.FMP_API_KEY;
  });

  it("persists detected tiers and records a provider_degraded alert on a lapse", async () => {
    const { listNotificationEvents } = await import("../src/lib/db");
    // Massive → free (old window empty), FMP → paid (array data).
    const fetcher = (async (u: string) => {
      if (u.includes("financialmodelingprep.com")) return jsonRes([{ pe: 30 }]);
      return jsonRes({ results: isOld(u) ? [] : [{ c: 9 }] });
    }) as unknown as typeof fetch;

    await runProviderTierCheck({ userId: "local", fetcher });
    const status = getProviderTierStatus("local");
    expect(status.massive?.tier).toBe("free");
    expect(status.fmp?.tier).toBe("paid");
    // Item 24: the structured probe-evidence signal is persisted alongside tier/reason so health
    // consumers can distinguish capability probes from freshness without parsing prose.
    expect(status.massive?.signal).toBe("history_cap_empty");
    expect(status.fmp?.signal).toBe("data_returned");

    const events = listNotificationEvents("local", 50).filter((e) => e.type === "provider_degraded");
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.some((e) => e.title.toLowerCase().includes("lapsed"))).toBe(true);
  });

  it("alerts again when a key is restored to paid (change in either direction)", async () => {
    const { listNotificationEvents } = await import("../src/lib/db");
    const fetcher = (async (u: string) => {
      if (u.includes("financialmodelingprep.com")) return jsonRes([{ pe: 30 }]);
      return jsonRes({ results: [{ c: 9 }] }); // both windows return data → paid
    }) as unknown as typeof fetch;

    await runProviderTierCheck({ userId: "local", fetcher });
    expect(getProviderTierStatus("local").massive?.tier).toBe("paid");
    const restored = listNotificationEvents("local", 50).filter((e) => e.type === "provider_degraded" && e.title.includes("PAID"));
    expect(restored.length).toBeGreaterThanOrEqual(1);
  });
});

describe("massive limiter auto-clamp on detected free tier", () => {
  beforeEach(async () => {
    process.env.MASSIVE_REST_MAX_CALLS_PER_MINUTE = "100";
    const massive = await import("../src/lib/market-signals/massive");
    massive.clearMassiveRestBudgetForTests();
    massive.clearMassiveTierClampCacheForTests();
  });
  afterEach(() => { delete process.env.MASSIVE_REST_MAX_CALLS_PER_MINUTE; });

  it("clamps to 5/min when the watchdog flagged Massive as free, despite env=100", async () => {
    const { setInternalSetting } = await import("../src/lib/db");
    const massive = await import("../src/lib/market-signals/massive");
    setInternalSetting("providerTier:status:local", { massive: { tier: "free", at: new Date().toISOString(), reason: "test" } });
    massive.clearMassiveTierClampCacheForTests();
    massive.clearMassiveRestBudgetForTests();
    const now = Date.now();
    let allowed = 0;
    for (let i = 0; i < 8; i++) if (massive.reserveMassiveRestCall(now)) allowed++;
    expect(allowed).toBe(5);
  });

  it("allows the full env limit when Massive is paid", async () => {
    const { setInternalSetting } = await import("../src/lib/db");
    const massive = await import("../src/lib/market-signals/massive");
    setInternalSetting("providerTier:status:local", { massive: { tier: "paid", at: new Date().toISOString(), reason: "test" } });
    massive.clearMassiveTierClampCacheForTests();
    massive.clearMassiveRestBudgetForTests();
    const now = Date.now();
    let allowed = 0;
    for (let i = 0; i < 20; i++) if (massive.reserveMassiveRestCall(now)) allowed++;
    expect(allowed).toBe(20); // well under 100
  });
});
