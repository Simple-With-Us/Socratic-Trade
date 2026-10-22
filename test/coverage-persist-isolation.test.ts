/**
 * The coverage persist resolves the database it writes to when the write lands, not when it was
 * scheduled, so a test file that restores DATABASE_URL while that write is still in flight has
 * the write land in the database the worker is pointing at by then.  This file pins the ordering
 * that prevents it, and it pins the failure it prevents with a control assertion.
 */
import { describe, expect, it, afterAll } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { resetDbForTesting } from "../src/lib/db";
import {
  __awaitPendingEnrichmentCoveragePersist,
  setLastEnrichmentCoverageReport,
  type EnrichmentCoverageReport
} from "../src/lib/enrichment-coverage";
import { CoverageRowSchema, coverageRowCount, readCountRow } from "./helpers/db-isolation-control";

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

afterAll(async () => {
  // The coverage persist is scheduled as a fire-and-forget dynamic import, and it resolves the
  // database it writes to when the write lands rather than when it was scheduled.  Wait for it
  // before the shared path is restored, or a write that is still in flight lands in the database
  // the worker is pointing at by then, which is the run's shared one.  This file points the run
  // at two databases of its own rather than at one for the whole file, so the wait drains into
  // the temporary database this fixture installed, never into the run's shared path.
  await __awaitPendingEnrichmentCoveragePersist();
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

describe("the coverage count row is validated", () => {
  it("accepts the driver's own row and rejects a malformed one", () => {
    // The shape the driver really returns for the count query.
    expect(CoverageRowSchema.safeParse({ n: 3 }).success).toBe(true);
    expect(CoverageRowSchema.safeParse({ n: 0 }).success).toBe(true);
    // The shapes that must not be counted as rows.
    expect(CoverageRowSchema.safeParse({ n: "3" }).success).toBe(false);
    expect(CoverageRowSchema.safeParse({ n: -1 }).success).toBe(false);
    expect(CoverageRowSchema.safeParse({ n: 1.5 }).success).toBe(false);
    expect(CoverageRowSchema.safeParse({ count: 3 }).success).toBe(false);
    expect(CoverageRowSchema.safeParse(undefined).success).toBe(false);
    expect(CoverageRowSchema.safeParse(null).success).toBe(false);
  });

  it("counts the rows in a database that really holds them", () => {
    // The count comes from the driver's own row, so the validation has to accept what the driver
    // really returns on this database and not what a type annotation claims it returns.  Three
    // rows is three, an empty table is zero, and a database that is not there is zero and is not
    // created.
    const create = (path: string) => {
      const handle = new Database(path);
      handle.exec(
        "CREATE TABLE enrichment_coverage_runs (as_of TEXT PRIMARY KEY, symbol_count INTEGER, report_json TEXT, created_at TEXT)"
      );
      return handle;
    };

    const countedPath = join(dir, "counted.db");
    const counted = create(countedPath);
    const insert = counted.prepare(
      "INSERT INTO enrichment_coverage_runs (as_of, symbol_count, report_json, created_at) VALUES (?, ?, ?, ?)"
    );
    for (const asOf of ["2026-10-21", "2026-10-22", "2026-10-23"]) {
      insert.run(asOf, 1, "{}", "2026-10-21T00:00:00.000Z");
    }
    counted.close();
    expect(coverageRowCount(countedPath)).toBe(3);

    const emptyPath = join(dir, "empty.db");
    create(emptyPath).close();
    expect(coverageRowCount(emptyPath)).toBe(0);

    const absentPath = join(dir, "absent.db");
    expect(coverageRowCount(absentPath)).toBe(0);
    expect(existsSync(absentPath)).toBe(false);
  });

  it("reads a missing table as no rows, and anything else as a fault", () => {
    // The missing table is a driver error, and only a driver error counts as the missing table.
    // A plain error whose message happens to name a missing table is a real fault, and reading it
    // as a zero is the failure mode this helper exists to prevent.
    const driverFault = {
      prepare: () => {
        throw new Database.SqliteError("no such table: enrichment_coverage_runs", "SQLITE_ERROR");
      }
    } as unknown as Database.Database;
    expect(readCountRow(driverFault)).toBeUndefined();

    const plainFault = {
      prepare: () => {
        throw new Error("no such table: enrichment_coverage_runs");
      }
    } as unknown as Database.Database;
    expect(() => readCountRow(plainFault)).toThrow(/no such table/);
  });
});
