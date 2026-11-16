// Point-in-time fundamentals revision chain (qlib/ai-hedge-fund lookahead lesson), scoped to
// SEC-XBRL-derived GAAP facts. Verifies: an original 10-K fact + a later 10-K/A restatement of the
// SAME fiscal_period_end form a queryable revision chain (getFundamentalAsOf returns the value that
// was actually known as of a given date, never a future restatement); strict mode fails closed
// pre-first-filing instead of guessing; lenient mode falls back to symbol_field_latest so a field
// with no revision history yet never blocks a live decision; and superseded_by is set on the
// superseded row while it stays queryable. Migration/version coverage lives in
// test/persistence-hardening.test.ts (schema version 76) and test/account-deletion-coverage.test.ts
// (fundamental_revisions has no user_id column — GLOBAL market data, exempt by design).
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-fundamental-revisions-${randomUUID()}.db`)}`;
  delete process.env.FUNDAMENTALS_ASOF_STRICT;
});

describe("fundamental_revisions — point-in-time revision chain", () => {
  it("an original 10-K fact then a later 10-K/A restatement of the SAME period form a chain: as-of before the restatement reads the original, as-of after reads the restated value", async () => {
    const { recordFundamentalRevision, getFundamentalAsOf } = await import("../src/lib/db-fundamentals");
    const symbol = "REVA";

    recordFundamentalRevision({
      symbol,
      field: "debtToEquity",
      fiscalPeriodEnd: "2023-12-31",
      value: 1.5,
      form: "10-K",
      filedAt: "2024-02-01",
      provider: "sec-xbrl"
    });
    recordFundamentalRevision({
      symbol,
      field: "debtToEquity",
      fiscalPeriodEnd: "2023-12-31",
      value: 1.8,
      form: "10-K/A",
      filedAt: "2024-04-01",
      provider: "sec-xbrl"
    });

    // Between the two filed dates: only the ORIGINAL 10-K was known.
    expect(getFundamentalAsOf(symbol, "debtToEquity", "2024-03-01")).toBe(1.5);
    // Before either filing: nothing known yet.
    expect(getFundamentalAsOf(symbol, "debtToEquity", "2024-01-15")).toBeUndefined();
    // Exactly on the original filing date: known.
    expect(getFundamentalAsOf(symbol, "debtToEquity", "2024-02-01")).toBe(1.5);
    // On/after the restatement's filed date: the RESTATED value.
    expect(getFundamentalAsOf(symbol, "debtToEquity", "2024-04-01")).toBe(1.8);
    expect(getFundamentalAsOf(symbol, "debtToEquity", "2024-12-31")).toBe(1.8);
  });

  it("marks the superseded row's superseded_by (the successor's filed_at) while leaving it queryable", async () => {
    const { recordFundamentalRevision, getFundamentalAsOf } = await import("../src/lib/db-fundamentals");
    const { getDb } = await import("../src/lib/db");
    const symbol = "REVB";

    recordFundamentalRevision({
      symbol,
      field: "revenueGrowth",
      fiscalPeriodEnd: "2023-12-31",
      value: 10,
      form: "10-K",
      filedAt: "2024-02-01",
      provider: "sec-xbrl"
    });
    recordFundamentalRevision({
      symbol,
      field: "revenueGrowth",
      fiscalPeriodEnd: "2023-12-31",
      value: 12.5,
      form: "10-K/A",
      filedAt: "2024-04-01",
      provider: "sec-xbrl"
    });

    const rows = getDb()
      .prepare(
        `SELECT filed_at, value, superseded_by FROM fundamental_revisions
         WHERE symbol = ? AND field = ? AND fiscal_period_end = ?
         ORDER BY filed_at ASC`
      )
      .all(symbol, "revenueGrowth", "2023-12-31") as Array<{ filed_at: string; value: number; superseded_by: string | null }>;

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ filed_at: "2024-02-01", value: 10, superseded_by: "2024-04-01" });
    expect(rows[1]).toMatchObject({ filed_at: "2024-04-01", value: 12.5, superseded_by: null });

    // The superseded row stays queryable directly, and still participates correctly in an
    // AS-OF query dated before its successor's filed_at.
    expect(getFundamentalAsOf(symbol, "revenueGrowth", "2024-03-01")).toBe(10);
  });

  it("recording the same (symbol, field, fiscal_period_end, filed_at) fact twice is a no-op (idempotent) and does not re-supersede", async () => {
    const { recordFundamentalRevision } = await import("../src/lib/db-fundamentals");
    const { getDb } = await import("../src/lib/db");
    const symbol = "REVC";

    recordFundamentalRevision({
      symbol,
      field: "debtToEquity",
      fiscalPeriodEnd: "2023-12-31",
      value: 2.0,
      form: "10-K",
      filedAt: "2024-02-01",
      provider: "sec-xbrl"
    });
    // Re-record the identical fact (e.g. a later scan re-observing the same filing).
    recordFundamentalRevision({
      symbol,
      field: "debtToEquity",
      fiscalPeriodEnd: "2023-12-31",
      value: 2.0,
      form: "10-K",
      filedAt: "2024-02-01",
      provider: "sec-xbrl"
    });

    const rows = getDb()
      .prepare(`SELECT superseded_by FROM fundamental_revisions WHERE symbol = ? AND field = ?`)
      .all(symbol, "debtToEquity") as Array<{ superseded_by: string | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].superseded_by).toBeNull();
  });

  it("strict mode returns undefined pre-first-filing instead of guessing", async () => {
    const { recordFundamentalRevision, getFundamentalAsOf } = await import("../src/lib/db-fundamentals");
    const symbol = "REVD";

    recordFundamentalRevision({
      symbol,
      field: "debtToEquity",
      fiscalPeriodEnd: "2023-12-31",
      value: 3.0,
      form: "10-K",
      filedAt: "2024-02-01",
      provider: "sec-xbrl"
    });

    // Lenient default: no coverage yet for this date -> falls back to symbol_field_latest, which
    // has nothing for this symbol either -> undefined (not a strict-vs-lenient distinction here).
    expect(getFundamentalAsOf(symbol, "debtToEquity", "2024-01-01")).toBeUndefined();
    // Explicit strict: same outcome, but for the RIGHT reason (fails closed on the missing
    // revision row rather than falling through to a latest-value lookup at all).
    expect(getFundamentalAsOf(symbol, "debtToEquity", "2024-01-01", { strict: true })).toBeUndefined();
    // Once the filing exists, strict mode returns it exactly like lenient mode.
    expect(getFundamentalAsOf(symbol, "debtToEquity", "2024-02-01", { strict: true })).toBe(3.0);
  });

  it("lenient mode (the default) falls back to symbol_field_latest when no revision row covers the date; strict mode does not", async () => {
    const { getFundamentalAsOf } = await import("../src/lib/db-fundamentals");
    const { upsertSymbolFieldLatest } = await import("../src/lib/db-fundamentals");
    const symbol = "REVE";
    const now = new Date().toISOString();

    // No revision history at all for this symbol/field — only a latest-store row (today's
    // non-PIT behavior, e.g. a screener-derived continuous metric or a not-yet-backfilled field).
    upsertSymbolFieldLatest([
      { symbol, field: "debtToEquity", valueJson: JSON.stringify(4.2), source: "yahoo-finance", asOf: now, fetchedAt: now }
    ]);

    expect(getFundamentalAsOf(symbol, "debtToEquity", "2020-01-01")).toBe(4.2);
    expect(getFundamentalAsOf(symbol, "debtToEquity", "2020-01-01", { strict: true })).toBeUndefined();
  });

  it("FUNDAMENTALS_ASOF_STRICT=on flips the default to strict; an explicit per-call strict:false still overrides it", async () => {
    const { getFundamentalAsOf, upsertSymbolFieldLatest, fundamentalsAsOfStrictEnabled } = await import(
      "../src/lib/db-fundamentals"
    );
    const symbol = "REVF";
    const now = new Date().toISOString();
    upsertSymbolFieldLatest([
      { symbol, field: "debtToEquity", valueJson: JSON.stringify(5.5), source: "yahoo-finance", asOf: now, fetchedAt: now }
    ]);

    expect(fundamentalsAsOfStrictEnabled()).toBe(false);
    expect(getFundamentalAsOf(symbol, "debtToEquity", "2020-01-01")).toBe(5.5);

    process.env.FUNDAMENTALS_ASOF_STRICT = "on";
    try {
      expect(fundamentalsAsOfStrictEnabled()).toBe(true);
      // Default now strict -> no fallback to symbol_field_latest.
      expect(getFundamentalAsOf(symbol, "debtToEquity", "2020-01-01")).toBeUndefined();
      // Explicit override still wins over the env default.
      expect(getFundamentalAsOf(symbol, "debtToEquity", "2020-01-01", { strict: false })).toBe(5.5);
    } finally {
      delete process.env.FUNDAMENTALS_ASOF_STRICT;
    }
  });

  it("picks the most recent fiscal period known as of the date, not just the most recent filing overall", async () => {
    const { recordFundamentalRevision, getFundamentalAsOf } = await import("../src/lib/db-fundamentals");
    const symbol = "REVG";

    recordFundamentalRevision({
      symbol,
      field: "debtToEquity",
      fiscalPeriodEnd: "2022-12-31",
      value: 1.0,
      form: "10-K",
      filedAt: "2023-02-01",
      provider: "sec-xbrl"
    });
    recordFundamentalRevision({
      symbol,
      field: "debtToEquity",
      fiscalPeriodEnd: "2023-12-31",
      value: 1.3,
      form: "10-K",
      filedAt: "2024-02-01",
      provider: "sec-xbrl"
    });

    // As of a date after BOTH filings, the newer fiscal period's value wins.
    expect(getFundamentalAsOf(symbol, "debtToEquity", "2024-06-01")).toBe(1.3);
    // As of a date only the FIRST filing had happened by, the older period's value is all that's known.
    expect(getFundamentalAsOf(symbol, "debtToEquity", "2023-06-01")).toBe(1.0);
  });

  it("recordFundamentalRevision silently skips invalid input (missing required fields, non-finite value)", async () => {
    const { recordFundamentalRevision, getFundamentalAsOf } = await import("../src/lib/db-fundamentals");
    const symbol = "REVH";

    expect(() =>
      recordFundamentalRevision({
        symbol,
        field: "",
        fiscalPeriodEnd: "2023-12-31",
        value: 1,
        form: "10-K",
        filedAt: "2024-02-01",
        provider: "sec-xbrl"
      })
    ).not.toThrow();
    expect(() =>
      recordFundamentalRevision({
        symbol,
        field: "debtToEquity",
        fiscalPeriodEnd: "2023-12-31",
        value: Number.NaN,
        form: "10-K",
        filedAt: "2024-02-01",
        provider: "sec-xbrl"
      })
    ).not.toThrow();

    expect(getFundamentalAsOf(symbol, "debtToEquity", "2024-06-01", { strict: true })).toBeUndefined();
  });
});
