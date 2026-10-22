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
import { fileURLToPath } from "node:url";

// The repo root is resolved from this file's own location, not from the runner's working
// directory.  A `vitest --root` invocation from a parent folder, or a CI job that changes
// directory before the run, must still find the fixtures rather than fail every case with an
// opaque ENOENT.
const REPO = fileURLToPath(new URL("..", import.meta.url));

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

/**
 * The body of one hook, matched by brace depth.
 *
 * The region between the `beforeAll` and the `afterAll` is not the hook body: it also holds any
 * helper or `describe` code that sits between the two.  A fixture that moved the differential
 * assertion or the override into such a helper would satisfy a search over that whole region
 * while the hook itself no longer carried them, and the guard would pass on exactly the
 * regression it exists to catch.  Matching the braces finds the callback's own body, and a
 * nested `beforeAll` inside it is caught for free, because the outer body would then be missing
 * the assertion.
 */
function hookBody(source: string, hook: string): string {
  const at = source.indexOf(`${hook}(`);
  if (at < 0) throw new Error(`no ${hook} hook found in the fixture source`);

  const open = source.indexOf("{", at);
  if (open < 0) throw new Error(`the ${hook} hook has no body`);

  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }

  throw new Error(`the ${hook} hook is not terminated`);
}

function read(file: string): string {
  const path = join(REPO, file);
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`cannot read the fixture source at ${path}: ${(error as Error).message}`);
  }
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
      expect(hookBody(source, "afterAll")).toContain(RESTORE);
    });

    it(`${file} keeps the differential assertion in the hook and ahead of the override`, () => {
      const source = read(file);
      const hook = hookBody(source, "beforeAll");

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
    expect(hookBody(source, "afterAll")).toContain(RESTORE);
  });
});
