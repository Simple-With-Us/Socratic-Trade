/**
 * The shape of the suite's database-isolation fixtures, pinned by source.
 *
 * The defect this guard catches: a fixture that captured the run's shared `DATABASE_URL` inside
 * `beforeAll`, after a differential assertion that can throw.  When that assertion failed, the
 * capture was never taken, the teardown read the missing capture as "the run had no
 * `DATABASE_URL`" and deleted the variable instead of restoring it.  The capture therefore has to
 * sit at module scope, where no hook can skip it, and the differential assertion has to stay in
 * the hook, where it still runs before the override is installed.
 *
 * The two properties are independent and both are needed.  The capture at module scope is what
 * makes the teardown's restore unconditional.  The assertion in the hook is what discriminates
 * the old module-scope override from the new one, because the old arrangement had already
 * installed this file's database by the time the hook ran.
 *
 * This is a source-shape guard rather than a behavioural one on purpose: the defect lives in the
 * order of two statements in a fixture, and a behavioural test for it would have to fail a hook
 * on purpose to observe the teardown.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = process.cwd();

// The files that install a database of their own for the whole file, and therefore have to
// capture the run's shared path and put it back.
const FIXTURE_FILES = [
  "test/market-dynamic-universe.test.ts",
  "test/provenance-stamps.test.ts",
  "test/enrichment-abort.test.ts",
  "test/enrichment-coverage.test.ts",
  "test/enrichment-coverage-persistence.test.ts"
] as const;

// The file that reproduces the teardown order in miniature, with two databases of its own rather
// than one override.
const ISOLATION_FILE = "test/coverage-persist-isolation.test.ts" as const;

// A capture taken inside a hook.  The declaration at module scope is `const prevDb = …`, so the
// statement form below cannot match it.
const CAPTURE_ASSIGNMENT = /^\s*prevDb\s*=\s*process\.env\.DATABASE_URL;?\s*$/m;

const CAPTURE_DECLARATION = "const prevDb = process.env.DATABASE_URL;";
const DIFFERENTIAL_ASSERTION = "expect(process.env.DATABASE_URL).not.toBe(dbUrl);";
const OVERRIDE = "process.env.DATABASE_URL = dbUrl;";
const RESTORE = "process.env.DATABASE_URL = prevDb;";

function read(file: string): string {
  return readFileSync(join(REPO, file), "utf8");
}

describe("the database-isolation fixtures capture the shared path at module scope", () => {
  for (const file of FIXTURE_FILES) {
    it(`${file} takes the capture outside every hook`, () => {
      const source = read(file);

      // The capture is a module-scope constant, so no hook can skip it.
      expect(source).toContain(CAPTURE_DECLARATION);

      // And no hook takes a second capture, which is the shape that loses the value when an
      // assertion throws first.
      expect(CAPTURE_ASSIGNMENT.test(source)).toBe(false);

      // The capture comes before the hooks, which is what "module scope" means here.
      const captureAt = source.indexOf(CAPTURE_DECLARATION);
      const beforeAllAt = source.indexOf("beforeAll(");
      const afterAllAt = source.indexOf("afterAll(");
      expect(captureAt).toBeGreaterThan(-1);
      expect(beforeAllAt).toBeGreaterThan(captureAt);
      expect(afterAllAt).toBeGreaterThan(captureAt);

      // The teardown puts the shared path back rather than deleting the variable.
      expect(source.slice(afterAllAt)).toContain(RESTORE);
    });

    it(`${file} keeps the differential assertion in the hook and ahead of the override`, () => {
      const source = read(file);
      const beforeAllAt = source.indexOf("beforeAll(");
      const afterAllAt = source.indexOf("afterAll(");
      const hook = source.slice(beforeAllAt, afterAllAt);

      expect(hook).toContain(DIFFERENTIAL_ASSERTION);
      expect(hook).toContain(OVERRIDE);

      // The assertion has to run before the override is installed.  Under the old module-scope
      // arrangement the file's database was already in place, so the assertion failed there,
      // and the override below has not been applied yet in the new arrangement, so it passes.
      expect(hook.indexOf(DIFFERENTIAL_ASSERTION)).toBeLessThan(hook.indexOf(OVERRIDE));
    });
  }

  it(`${ISOLATION_FILE} also captures the shared path at module scope`, () => {
    const source = read(ISOLATION_FILE);
    expect(source).toContain(CAPTURE_DECLARATION);
    expect(CAPTURE_ASSIGNMENT.test(source)).toBe(false);
    expect(source.slice(source.indexOf("afterAll("))).toContain(RESTORE);
  });
});
