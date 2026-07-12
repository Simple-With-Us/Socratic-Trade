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
    expect((await probeMassiveTier("k", Date.now(), fetcher)).tier).toBe("paid");
  });
  it("classifies free when the >2yr window comes back empty (2-year cap)", async () => {
    const fetcher = (async (u: string) => jsonRes({ results: isOld(u) ? [] : [{ c: 9 }] })) as unknown as typeof fetch;
    expect((await probeMassiveTier("k", Date.now(), fetcher)).tier).toBe("free");
  });
  it("classifies free on a single-call 429 (free 5/min cap)", async () => {
    const fetcher = (async () => jsonRes("rate", 429)) as unknown as typeof fetch;
    expect((await probeMassiveTier("k", Date.now(), fetcher)).tier).toBe("free");
  });
  it("classifies free when >2yr history is 403-blocked", async () => {
    const fetcher = (async (u: string) => (isOld(u) ? jsonRes("forbidden", 403) : jsonRes({ results: [{ c: 9 }] }))) as unknown as typeof fetch;
    expect((await probeMassiveTier("k", Date.now(), fetcher)).tier).toBe("free");
  });
  it("stays unknown on a bad-key 401 (not a tier signal) or network error", async () => {
    const badKey = (async () => jsonRes("nope", 401)) as unknown as typeof fetch;
    expect((await probeMassiveTier("k", Date.now(), badKey)).tier).toBe("unknown");
    const netErr = (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch;
    expect((await probeMassiveTier("k", Date.now(), netErr)).tier).toBe("unknown");
  });
  it("is unknown with no key", async () => {
    expect((await probeMassiveTier(undefined)).tier).toBe("unknown");
  });
});

describe("probeFmpTier", () => {
  it("classifies paid when ratios-ttm returns data", async () => {
    const fetcher = (async () => jsonRes([{ priceToEarningsRatioTTM: 30 }])) as unknown as typeof fetch;
    expect((await probeFmpTier("k", fetcher)).tier).toBe("paid");
  });
  it("classifies free on a premium/upgrade error envelope", async () => {
    const fetcher = (async () => jsonRes({ "Error Message": "Exclusive Endpoint: upgrade your plan." })) as unknown as typeof fetch;
    expect((await probeFmpTier("k", fetcher)).tier).toBe("free");
  });
  it("classifies free on 429 (daily cap)", async () => {
    const fetcher = (async () => jsonRes("limit", 429)) as unknown as typeof fetch;
    expect((await probeFmpTier("k", fetcher)).tier).toBe("free");
  });
  it("stays unknown on an ambiguous/empty response", async () => {
    const fetcher = (async () => jsonRes([])) as unknown as typeof fetch;
    expect((await probeFmpTier("k", fetcher)).tier).toBe("unknown");
  });
});

describe("isProviderTierCheckDue", () => {
  // Note: nothing earlier in this file sets providerTier:lastCheckAt, so the first case sees it absent.
  it("is due when never run", () => {
    expect(isProviderTierCheckDue(Date.now())).toBe(true);
  });
  it("is not due before the interval elapses", async () => {
    const { setInternalSetting } = await import("../src/lib/db");
    const now = Date.now();
    setInternalSetting("providerTier:lastCheckAt", new Date(now - 3 * 3600_000).toISOString()); // 3h ago
    expect(isProviderTierCheckDue(now)).toBe(false);
  });
  it("catches up (runs regardless of hour) once 1.5x the interval has elapsed", async () => {
    const { setInternalSetting } = await import("../src/lib/db");
    const now = Date.now();
    setInternalSetting("providerTier:lastCheckAt", new Date(now - 40 * 3600_000).toISOString()); // 40h ago > 36h
    expect(isProviderTierCheckDue(now)).toBe(true);
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
    const status = getProviderTierStatus();
    expect(status.massive?.tier).toBe("free");
    expect(status.fmp?.tier).toBe("paid");

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
    expect(getProviderTierStatus().massive?.tier).toBe("paid");
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
    setInternalSetting("providerTier:status", { massive: { tier: "free", at: new Date().toISOString(), reason: "test" } });
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
    setInternalSetting("providerTier:status", { massive: { tier: "paid", at: new Date().toISOString(), reason: "test" } });
    massive.clearMassiveTierClampCacheForTests();
    massive.clearMassiveRestBudgetForTests();
    const now = Date.now();
    let allowed = 0;
    for (let i = 0; i < 20; i++) if (massive.reserveMassiveRestCall(now)) allowed++;
    expect(allowed).toBe(20); // well under 100
  });
});
