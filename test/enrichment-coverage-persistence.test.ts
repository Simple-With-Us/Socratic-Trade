import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

let dbPath: string;

beforeEach(() => {
  __resetEnrichmentCoverageForTests();
  resetDbForTesting();
  dbPath = join(mkdtempSync(join(tmpdir(), "enrich-cov-")), "app.db");
  process.env.DATABASE_URL = `file:${dbPath}`;
});

afterEach(() => {
  try {
    __clearEnrichmentCoverageStoreForTests();
  } catch {
    /* db may already be torn down */
  }
  resetDbForTesting();
  delete process.env.DATABASE_URL;
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
