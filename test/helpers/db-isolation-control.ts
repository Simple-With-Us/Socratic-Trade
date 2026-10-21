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

// The path the run shared before a file installed its own.  DATABASE_URL as the run had it,
// or the checkout default when the run had none.  This mirrors databasePath() in src/lib/db.ts.
export function sharedDatabasePath(prevDb: string | undefined): string {
  return resolve((prevDb ?? "file:./data/app.db").replace(/^file:/, ""));
}

export function sharedCoverageRowCount(prevDb: string | undefined): number {
  const path = sharedDatabasePath(prevDb);
  if (!existsSync(path)) return 0;
  const handle = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const row = handle.prepare("SELECT COUNT(*) AS n FROM enrichment_coverage_runs").get() as
      | { n: number }
      | undefined;
    return row?.n ?? 0;
  } catch (err) {
    // The table is absent, which is the same fact as the table holding no rows.  Anything
    // else is a real fault and is surfaced rather than folded into a zero.
    if (err instanceof Error && /no such table/i.test(err.message)) return 0;
    throw err;
  } finally {
    handle.close();
  }
}
