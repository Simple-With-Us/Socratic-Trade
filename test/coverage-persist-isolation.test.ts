/**
 * The coverage persist resolves the database it writes to when the write lands, not when it was
 * scheduled, so a test file that restores DATABASE_URL while that write is still in flight has
 * the write land in the database the worker is pointing at by then.  This file pins the ordering
 * that prevents it, and it pins the failure it prevents with a control assertion.
 */
import { describe, expect, it, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { resetDbForTesting } from "../src/lib/db";
import {
  __awaitPendingEnrichmentCoveragePersist,
  setLastEnrichmentCoverageReport,
  type EnrichmentCoverageReport
} from "../src/lib/enrichment-coverage";
import { coverageRowCount } from "./helpers/db-isolation-control";

// Two databases inside this file's own temporary directory.  The first stands in for the
// database a test file installs for itself, and the second for the database the worker is
// pointed at when the write lands, which is the shared one in the suite.  Both are temporary
// files, so nothing here can reach the run's own shared database.
const dir = mkdtempSync(join(tmpdir(), `coverage-persist-isolation-${randomUUID()}-`));
const ownPath = join(dir, "own.db");
const sharedPath = join(dir, "shared.db");
const ownUrl = `file:${ownPath}`;
const sharedUrl = `file:${sharedPath}`;
const prevDb = process.env.DATABASE_URL;

const report: EnrichmentCoverageReport = {
  asOf: "2026-10-21T00:00:00.000Z",
  symbolCount: 1,
  fields: [],
  missingFields: [],
  partialFields: [],
  sourceWinTotals: {},
  providerFailures: [],
  contributingSources: []
};

afterAll(() => {
  resetDbForTesting();
  if (prevDb === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = prevDb;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("coverage persist isolation", () => {
  it("lands the coverage row in the file's own database when the teardown waits for it", async () => {
    resetDbForTesting();
    process.env.DATABASE_URL = ownUrl;

    setLastEnrichmentCoverageReport(report);

    // The teardown order the affected files use.  Wait for the pending write while the file's
    // own database is still the target, then close the handle, then restore the shared path.
    await __awaitPendingEnrichmentCoveragePersist();
    resetDbForTesting();

    expect(coverageRowCount(ownPath)).toBe(1);

    process.env.DATABASE_URL = sharedUrl;
    expect(coverageRowCount(sharedPath)).toBe(0);
  });

  it("control: the same write lands in the shared database when the teardown restores first", async () => {
    // This is the order the finding names, and it is what makes the assertion above mean
    // something.  Without this control the shared database would hold the row and the first
    // test would fail.  If this ever stops reproducing, the defect is gone and this control
    // has to be rewritten rather than the first test weakened.
    resetDbForTesting();
    process.env.DATABASE_URL = ownUrl;

    setLastEnrichmentCoverageReport(report);

    // The order the finding names.  Close the cached handle, then restore the shared path
    // while the write is still in flight.
    resetDbForTesting();
    process.env.DATABASE_URL = sharedUrl;
    await __awaitPendingEnrichmentCoveragePersist();

    expect(coverageRowCount(sharedPath)).toBe(1);
  });
});
