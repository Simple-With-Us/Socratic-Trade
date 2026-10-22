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
 * A third property is pinned the same way.  Every file that restores the shared path at file
 * scope has to wait for the pending coverage write before it restores, because the persist
 * resolves the database it writes to when the write lands rather than when it was scheduled, so
 * a teardown that restores the path first hands the write to the shared database.  The wait has
 * to sit ahead of the restore, and the guard says so rather than trusting the note to.
 *
 * The wait is matched as a live statement and the helper is matched as an import, both anchored
 * to a line of their own.  A fixture that had its wait commented out carries the same literal as
 * a comment, so a substring match would report green on exactly the regression the guard exists
 * to catch, and an assertion over the call would claim to check an import it never looked at.
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

// Every file that restores the shared path at file scope.  Five install a database of their own
// for the whole file; the sixth is the ordering fixture, which installs two databases of its own
// and still restores the shared path at module scope.
const FILE_SCOPE_RESTORERS = [...FIXTURE_FILES, ISOLATION_FILE] as const;

// A capture taken inside a hook.  The declaration at module scope is `const prevDb = …`, so the
// statement form below cannot match it.
const CAPTURE_ASSIGNMENT = /^\s*prevDb\s*=\s*process\.env\.DATABASE_URL;?\s*$/m;

const CAPTURE_DECLARATION = "const prevDb = process.env.DATABASE_URL;";
const DIFFERENTIAL_ASSERTION = "expect(process.env.DATABASE_URL).not.toBe(dbUrl);";
const OVERRIDE = "process.env.DATABASE_URL = dbUrl;";
const RESTORE = "process.env.DATABASE_URL = prevDb;";

// The wait, anchored to a line of its own rather than to a bare substring.  A fixture whose
// wait had been disabled by commenting the line out carries the same literal as a comment, so a
// `toContain` check is satisfied by exactly the regression this guard exists to catch, and the
// pending coverage write would land in the run's shared database while the guard reported green.
// Requiring the statement to start a line after optional whitespace cannot match a commented
// wait, because `//` comes before `await` on that line.
const AWAIT_PENDING_STATEMENT = /^[ \t]*await __awaitPendingEnrichmentCoveragePersist\(\);[ \t]*$/m;

// The import that brings the helper into the file, anchored to a line of its own for the same
// reason.  The braces span newlines, so this matches the single-line form and the multi-line
// form alike: `[^}]*` stops at the closing brace of the specifier list.
const IMPORT_OF_HELPER =
  /^[ \t]*import\s*\{[^}]*__awaitPendingEnrichmentCoveragePersist[^}]*\}\s*from\s*"\.\.\/src\/lib\/enrichment-coverage"/m;

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

/**
 * The body of the `finally` block inside one hook, matched by brace depth.
 *
 * `null` when the hook carries no `finally` at all, which is the shape that lets a rejected
 * await skip the restore: the wait is what can throw, and everything that puts the run's
 * `DATABASE_URL` back sits after it.
 */
function finallyBody(hook: string): string | null {
  const at = hook.indexOf("finally");
  if (at < 0) return null;

  const open = hook.indexOf("{", at);
  if (open < 0) return null;

  let depth = 0;
  for (let i = open; i < hook.length; i += 1) {
    if (hook[i] === "{") depth += 1;
    else if (hook[i] === "}") {
      depth -= 1;
      if (depth === 0) return hook.slice(open + 1, i);
    }
  }

  return null;
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

describe("the database-isolation fixtures wait for the pending coverage write before they restore", () => {
  for (const file of FILE_SCOPE_RESTORERS) {
    it(`${file} awaits the pending write ahead of the restore`, () => {
      const source = read(file);

      // The file has to import the helper, not merely call something with that name: an
      // assertion over the call literal checks the wait and says nothing about where the helper
      // came from, so it cannot prove the property this comment and the note claim.
      expect(source).toMatch(IMPORT_OF_HELPER);

      const hook = hookBody(source, "afterAll");

      // The wait has to be in the teardown rather than in a test, because a persist can still be
      // in flight when the last test of the file has finished.  It has to be a live statement:
      // a commented-out wait carries the same text and must not satisfy the guard.
      expect(hook).toMatch(AWAIT_PENDING_STATEMENT);

      // And it has to come before the restore.  A wait placed after the restore drains into the
      // database the worker is pointing at by then, which is the shared one, so it closes the
      // race only after the race has already been lost.
      const awaitAt = hook.search(AWAIT_PENDING_STATEMENT);
      const restoreAt = hook.indexOf(RESTORE);
      expect(awaitAt).toBeGreaterThan(-1);
      expect(restoreAt).toBeGreaterThan(-1);
      expect(awaitAt).toBeLessThan(restoreAt);
    });
  }
});

describe("the ordering fixture restores DATABASE_URL even when the wait rejects", () => {
  // The wait is the one statement in this teardown that can throw: the helper awaits the
  // in-flight write handles, so a persist that rejects rejects the teardown.  Everything that
  // puts the run's DATABASE_URL back sits after it, and this file owns that variable from module
  // scope onward, so skipping the restore carries a temporary path that the teardown then deletes
  // into every later file in the same worker.  The five guard fixtures carry the same shape and
  // inherit it from the earlier rounds; this round fixed the file it touched, and this guard pins
  // that one.  It is deliberately not a prohibition, so fixing the other five needs no change here.
  it(`${ISOLATION_FILE} keeps the reset and the restore in a finally`, () => {
    const hook = hookBody(read(ISOLATION_FILE), "afterAll");

    expect(hook).toContain("try {");
    const guard = finallyBody(hook);
    expect(guard).not.toBeNull();
    expect(guard).toContain("resetDbForTesting();");
    expect(guard).toContain(RESTORE);
  });

  it("finds the finally block and reports a hook that has none", () => {
    // The guard above is only as good as the block lookup, so the lookup is pinned from both
    // sides: a real finally is found, and a teardown whose wait is not wrapped returns null
    // rather than a body borrowed from somewhere else in the hook.
    const wrapped =
      "  try {\n    await __awaitPendingEnrichmentCoveragePersist();\n  } finally {\n    process.env.DATABASE_URL = prevDb;\n  }\n";
    const unwrapped =
      "  await __awaitPendingEnrichmentCoveragePersist();\n  process.env.DATABASE_URL = prevDb;\n";

    expect(finallyBody(wrapped)).toContain(RESTORE);
    expect(finallyBody(unwrapped)).toBeNull();
  });
});

describe("the wait guard's own patterns reject the regressions it exists to catch", () => {
  // These are the guard on the guard.  The case that matters is the one the assertions above
  // used to miss: a wait that has been disabled by commenting it out keeps the literal, so a
  // substring check reports green while the race is back.
  const LIVE_WAIT = '  await __awaitPendingEnrichmentCoveragePersist();\n  process.env.DATABASE_URL = prevDb;';
  const COMMENTED_WAIT = '  // await __awaitPendingEnrichmentCoveragePersist();\n  process.env.DATABASE_URL = prevDb;';
  const WAIT_AFTER_RESTORE = '  process.env.DATABASE_URL = prevDb;\n  await __awaitPendingEnrichmentCoveragePersist();';

  it("matches a live wait and rejects the same wait commented out", () => {
    expect(LIVE_WAIT).toMatch(AWAIT_PENDING_STATEMENT);
    expect(COMMENTED_WAIT).not.toMatch(AWAIT_PENDING_STATEMENT);
  });

  it("orders the live wait ahead of the restore and not behind it", () => {
    // The order check reads the match offset, so it has to hold on the live form and fail on the
    // inverted one.  An unmatched pattern reports -1, which the toBeGreaterThan assertion catches
    // before the comparison, so a commented-out wait cannot slip through as -1 < restoreAt.
    expect(LIVE_WAIT.search(AWAIT_PENDING_STATEMENT)).toBeLessThan(LIVE_WAIT.indexOf(RESTORE));
    expect(WAIT_AFTER_RESTORE.search(AWAIT_PENDING_STATEMENT)).toBeGreaterThan(
      WAIT_AFTER_RESTORE.indexOf(RESTORE)
    );
  });

  it("matches the import in its single-line and multi-line forms", () => {
    expect(
      'import { __awaitPendingEnrichmentCoveragePersist } from "../src/lib/enrichment-coverage";'
    ).toMatch(IMPORT_OF_HELPER);
    expect(
      'import {\n  __resetEnrichmentCoverageForTests,\n  __awaitPendingEnrichmentCoveragePersist,\n} from "../src/lib/enrichment-coverage";'
    ).toMatch(IMPORT_OF_HELPER);
  });

  it("rejects a call that carries no import", () => {
    // The regression the import assertion exists to catch: the call literal on its own, with the
    // helper never imported.  A `toContain` check over the call satisfies this shape.
    expect(LIVE_WAIT).not.toMatch(IMPORT_OF_HELPER);
    expect(LIVE_WAIT).toContain("await __awaitPendingEnrichmentCoveragePersist();");
  });
});
