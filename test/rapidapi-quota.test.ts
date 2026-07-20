import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  rapidApiProviderDailyCap,
  rapidApiCombinedDailyCap,
  tryReserveRapidApiCalls,
  refundRapidApiCalls,
  __resetRapidApiQuotaForTests
} from "../src/lib/rapidapi-quota";

// Isolated temp SQLite DB per this test file (repo convention — see beforeAll in
// test/alpha-vantage-key-pool.test.ts) so the persisted budget setting never leaks
// into/out of other test files.
beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-rapidapi-quota-${randomUUID()}.db`)}`;
});

beforeEach(() => {
  __resetRapidApiQuotaForTests();
});

afterEach(() => {
  delete process.env.PROVIDER_QUOTA_MBOUM_PER_DAY;
  delete process.env.PROVIDER_QUOTA_YAHOO_FINANCE15_PER_DAY;
  delete process.env.PROVIDER_QUOTA_ALPHA_VANTAGE_RAPIDAPI_PER_DAY;
  delete process.env.PROVIDER_QUOTA_RAPIDAPI_COMBINED_PER_DAY;
});

describe("rapidApiProviderDailyCap / rapidApiCombinedDailyCap — defaults + env overrides", () => {
  it("defaults match the owner-specified monthly-cap-derived allowances", () => {
    expect(rapidApiProviderDailyCap("mboum-finance")).toBe(16);
    expect(rapidApiProviderDailyCap("yahoo-finance15")).toBe(3);
    expect(rapidApiProviderDailyCap("alpha-vantage-rapidapi")).toBe(500);
    expect(rapidApiCombinedDailyCap()).toBe(900);
  });

  it("env overrides each provider's own cap independently", () => {
    process.env.PROVIDER_QUOTA_MBOUM_PER_DAY = "5";
    expect(rapidApiProviderDailyCap("mboum-finance")).toBe(5);
    expect(rapidApiProviderDailyCap("yahoo-finance15")).toBe(3); // unaffected
  });

  it("env overrides the combined ceiling", () => {
    process.env.PROVIDER_QUOTA_RAPIDAPI_COMBINED_PER_DAY = "1200";
    expect(rapidApiCombinedDailyCap()).toBe(1200);
  });

  it("falls back to the default on unparsable/negative overrides", () => {
    process.env.PROVIDER_QUOTA_MBOUM_PER_DAY = "not-a-number";
    expect(rapidApiProviderDailyCap("mboum-finance")).toBe(16);
    process.env.PROVIDER_QUOTA_MBOUM_PER_DAY = "-5";
    expect(rapidApiProviderDailyCap("mboum-finance")).toBe(16);
  });

  it("0 is a valid override — proactively blocks all calls for that provider", () => {
    process.env.PROVIDER_QUOTA_MBOUM_PER_DAY = "0";
    expect(rapidApiProviderDailyCap("mboum-finance")).toBe(0);
    expect(tryReserveRapidApiCalls("mboum-finance", 1)).toBe(0);
  });
});

describe("tryReserveRapidApiCalls / refundRapidApiCalls — per-provider cap", () => {
  it("admits up to the provider's own daily cap, then 0", () => {
    process.env.PROVIDER_QUOTA_MBOUM_PER_DAY = "3";
    const now = Date.parse("2026-07-19T12:00:00Z");
    expect(tryReserveRapidApiCalls("mboum-finance", 2, now)).toBe(2);
    expect(tryReserveRapidApiCalls("mboum-finance", 2, now)).toBe(1); // only 1 left of the 3-cap
    expect(tryReserveRapidApiCalls("mboum-finance", 1, now)).toBe(0); // fully exhausted
  });

  it("never admits more than requested even with headroom remaining", () => {
    process.env.PROVIDER_QUOTA_MBOUM_PER_DAY = "100";
    const now = Date.now();
    expect(tryReserveRapidApiCalls("mboum-finance", 5, now)).toBe(5);
  });

  it("tracks each provider's own cap independently — one provider's exhaustion doesn't affect another", () => {
    process.env.PROVIDER_QUOTA_MBOUM_PER_DAY = "1";
    process.env.PROVIDER_QUOTA_YAHOO_FINANCE15_PER_DAY = "1";
    const now = Date.now();
    expect(tryReserveRapidApiCalls("mboum-finance", 1, now)).toBe(1);
    expect(tryReserveRapidApiCalls("mboum-finance", 1, now)).toBe(0);
    // yahoo-finance15's own cap is untouched by mboum-finance's exhaustion.
    expect(tryReserveRapidApiCalls("yahoo-finance15", 1, now)).toBe(1);
  });

  it("refund gives a reservation back so a later call in the same day can use it", () => {
    process.env.PROVIDER_QUOTA_MBOUM_PER_DAY = "1";
    const now = Date.now();
    expect(tryReserveRapidApiCalls("mboum-finance", 1, now)).toBe(1);
    expect(tryReserveRapidApiCalls("mboum-finance", 1, now)).toBe(0);
    refundRapidApiCalls("mboum-finance", 1, now);
    expect(tryReserveRapidApiCalls("mboum-finance", 1, now)).toBe(1);
  });

  it("refund no-ops across a day rollover instead of crediting into the new day's counter", () => {
    process.env.PROVIDER_QUOTA_MBOUM_PER_DAY = "1";
    const day1 = Date.parse("2026-07-19T12:00:00Z");
    const day2 = Date.parse("2026-07-20T12:00:00Z");
    expect(tryReserveRapidApiCalls("mboum-finance", 1, day1)).toBe(1);
    refundRapidApiCalls("mboum-finance", 1, day2); // stale day — must not touch day2's fresh counter
    // day2 should still have its own full, un-decremented cap of 1 (the refund was a no-op, not a
    // free +1 into today).
    expect(tryReserveRapidApiCalls("mboum-finance", 1, day2)).toBe(1);
    expect(tryReserveRapidApiCalls("mboum-finance", 1, day2)).toBe(0);
  });

  it("persists usage across a fresh in-process call (survives a restart)", () => {
    process.env.PROVIDER_QUOTA_MBOUM_PER_DAY = "2";
    const now = Date.now();
    expect(tryReserveRapidApiCalls("mboum-finance", 2, now)).toBe(2);
    // A "restart" here is simulated by simply calling again — the counter is read from the
    // persisted setting (getInternalSetting), not an in-memory module-level variable.
    expect(tryReserveRapidApiCalls("mboum-finance", 1, now)).toBe(0);
  });
});

describe("tryReserveRapidApiCalls — combined ceiling across all three providers", () => {
  it("the combined cap binds even when each provider's own cap has headroom", () => {
    process.env.PROVIDER_QUOTA_MBOUM_PER_DAY = "50";
    process.env.PROVIDER_QUOTA_YAHOO_FINANCE15_PER_DAY = "50";
    process.env.PROVIDER_QUOTA_ALPHA_VANTAGE_RAPIDAPI_PER_DAY = "50";
    process.env.PROVIDER_QUOTA_RAPIDAPI_COMBINED_PER_DAY = "10";
    const now = Date.now();
    expect(tryReserveRapidApiCalls("mboum-finance", 6, now)).toBe(6);
    expect(tryReserveRapidApiCalls("yahoo-finance15", 6, now)).toBe(4); // only 4 left of the combined 10
    expect(tryReserveRapidApiCalls("alpha-vantage-rapidapi", 1, now)).toBe(0); // combined ceiling fully spent
  });

  it("binding limit is whichever is LOWER — a provider's own tiny cap binds before the combined one", () => {
    process.env.PROVIDER_QUOTA_YAHOO_FINANCE15_PER_DAY = "3";
    process.env.PROVIDER_QUOTA_RAPIDAPI_COMBINED_PER_DAY = "900";
    const now = Date.now();
    expect(tryReserveRapidApiCalls("yahoo-finance15", 10, now)).toBe(3); // own cap (3) binds, not combined (900)
  });
});
