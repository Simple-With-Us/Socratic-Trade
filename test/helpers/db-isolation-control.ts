// The database a test file shares with the rest of the run, and the number of enrichment
// coverage rows in it.  A file that installs its own DATABASE_URL must leave the shared
// database alone, and the only way to check that is to look at the shared database directly.
//
// The shared database is opened READ-ONLY and is never created.  databasePath() falls back
// to file:./data/app.db when DATABASE_URL is unset, so a late fire-and-forget persist that
// escapes a file's fixture lands in the checkout's own application database.  Creating that
// file to look for it would cause the very pollution this count exists to detect, so a
// database that is not there is reported as holding no rows, which is the state the suite is
// supposed to be in.
import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

// The shape of the count row, validated at the trust boundary.  The database is an untrusted
// input here: it is a file on disk that another process may have written, so the row is parsed
// rather than assumed, and a row that does not match is surfaced as a fault instead of being
// folded into a count.
export const CoverageRowSchema = z.object({
  n: z.number().int().nonnegative(),
});

// The path the run shared before a file installed its own.  DATABASE_URL as the run had it,
// or the checkout default when the run had none.  This mirrors databasePath() in src/lib/db.ts.
export function sharedDatabasePath(prevDb: string | undefined): string {
  return resolve((prevDb ?? "file:./data/app.db").replace(/^file:/, ""));
}

export function sharedCoverageRowCount(prevDb: string | undefined): number {
  return coverageRowCount(sharedDatabasePath(prevDb));
}

// The number of enrichment coverage rows in the database at an absolute path.  The database is
// opened read-only and is never created; a database that is not there holds no rows.
export function coverageRowCount(path: string): number {
  if (!existsSync(path)) return 0;
  const handle = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const row: unknown = handle
      .prepare("SELECT COUNT(*) AS n FROM enrichment_coverage_runs")
      .get();
    if (row === undefined) return 0;
    const parsed = CoverageRowSchema.safeParse(row);
    if (!parsed.success) {
      throw new Error(`unexpected coverage count row shape: ${parsed.error.message}`);
    }
    return parsed.data.n;
  } catch (err) {
    // The table is absent, which is the same fact as the table holding no rows.  Anything
    // else is a real fault and is surfaced rather than folded into a zero.
    if (err instanceof Error && /no such table/i.test(err.message)) return 0;
    throw err;
  } finally {
    handle.close();
  }
}
