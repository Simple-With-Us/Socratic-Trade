import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  __resetEnrichmentCoverageForTests,
  buildEnrichmentCoverageReport,
  getLastEnrichmentCoverageReport,
  type EnrichmentCoverageRecord
} from "../src/lib/enrichment-coverage";
import {
  __clearEnrichmentCoverageStoreForTests,
  listEnrichmentCoverageFieldHistory,
  listEnrichmentCoverageRunHistory,
  loadLatestEnrichmentCoverageReport,
  resolveEnrichmentCoverageReport
} from "../src/lib/db-enrichment-coverage";
import { resetDbForTesting } from "../src/lib/db";

// Every call to buildEnrichmentCoverageReport persists a coverage report, so this file needs a
// database of its own.  The path is held for the whole FILE because the persist is a
// fire-and-forget dynamic import, so it can resolve after the test that triggered it has
// finished.  The run's own database path is saved and restored rather than deleted, because
// deleting it hands the next file in the worker the checkout's default database.
const dbDir = mkdtempSync(join(tmpdir(), `enrich-cov-persist-${randomUUID()}-`));
const prevDb = process.env.DATABASE_URL;
process.env.DATABASE_URL = `file:${join(dbDir, "app.db")}`;

beforeAll(() => {
  resetDbForTesting();
});

afterAll(() => {
  resetDbForTesting();
  if (prevDb === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = prevDb;
  try {
    rmSync(dbDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

beforeEach(() => {
  __resetEnrichmentCoverageForTests();
  // Each test starts from an empty coverage store, so the run counts it asserts are its own runs.
  try {
    __clearEnrichmentCoverageStoreForTests();
  } catch {
    /* the store may not exist yet */
  }
});

describe("enrichment coverage persistence", () => {
  it("persists on build and survives process memory reset", async () => {
    const merged = {
      AAPL: { peRatio: 20, sources: { peRatio: "yahoo-finance" } },
      MSFT: { peRatio: 25, sources: { peRatio: "yahoo-finance" } }
    };
    const report = buildEnrichmentCoverageReport(merged, ["yahoo-finance"]);
    expect(getLastEnrichmentCoverageReport()?.symbolCount).toBe(2);

    // Allow fire-and-forget persist to finish.
    await new Promise((r) => setTimeout(r, 50));

    __resetEnrichmentCoverageForTests();
    expect(getLastEnrichmentCoverageReport()).toBeNull();

    const loaded = loadLatestEnrichmentCoverageReport();
    expect(loaded?.asOf).toBe(report.asOf);
    expect(loaded?.symbolCount).toBe(2);
    expect(loaded?.fields.find((f) => f.field === "peRatio")?.filledCount).toBe(2);

    const resolved = resolveEnrichmentCoverageReport();
    expect(resolved?.asOf).toBe(report.asOf);

    const history = listEnrichmentCoverageRunHistory(5);
    expect(history.length).toBe(1);
    expect(history[0]?.symbolCount).toBe(2);

    const peHistory = listEnrichmentCoverageFieldHistory("peRatio", 5);
    expect(peHistory.length).toBe(1);
    expect(peHistory[0]?.fillRate).toBe(1);
  });

  it("stores multiple runs and returns newest first in history", async () => {
    const oneSymbol: Record<string, EnrichmentCoverageRecord> = {
      A: { sector: "Tech", sources: { sector: "yahoo-finance" } } as EnrichmentCoverageRecord
    };
    buildEnrichmentCoverageReport(oneSymbol, ["yahoo-finance"]);
    await new Promise((r) => setTimeout(r, 30));
    const twoSymbols: Record<string, EnrichmentCoverageRecord> = {
      A: { sector: "Tech", sources: { sector: "yahoo-finance" } } as EnrichmentCoverageRecord,
      B: { sector: "Tech", sources: { sector: "yahoo-finance" } } as EnrichmentCoverageRecord
    };
    buildEnrichmentCoverageReport(twoSymbols, ["yahoo-finance"]);
    await new Promise((r) => setTimeout(r, 30));

    const history = listEnrichmentCoverageRunHistory(10);
    expect(history.length).toBe(2);
    expect(history[0]!.symbolCount).toBe(2);
    expect(history[1]!.symbolCount).toBe(1);
  });
});
