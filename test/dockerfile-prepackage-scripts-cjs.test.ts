import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The Dockerfile runs some TypeScript BEFORE `COPY package.json` -- deliberately, so a
 * docs-only no-op fails in seconds instead of after a ~30 minute `npm ci`.
 *
 * The cost of that ordering is a trap that only fires in the image: with no package.json
 * present, tsx cannot read our `"type": "module"` and falls back to a CJS transform, where a
 * top-level `await` is a hard error.  The script runs fine locally and fails only in the build.
 *
 * That is not hypothetical.  On 2026-08-21 a top-level await in
 * scripts/assert-rth-deploy-latch.ts broke EVERY deploy from 05:07Z onward with
 *   ERROR: Top-level await is currently not supported with the "cjs" output format
 * while the running container kept serving stale code, so merged fixes silently never shipped.
 *
 * This test transpiles each such script the same way the image does.  It does not execute them.
 */

function scriptsRunBeforePackageJsonCopy(): string[] {
  const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8").split("\n");
  const copyIdx = dockerfile.findIndex((l) => /^COPY\s+package\.json/.test(l.trim()));
  expect(copyIdx, "Dockerfile no longer has a `COPY package.json` line — update this test").toBeGreaterThan(-1);

  const found: string[] = [];
  for (const line of dockerfile.slice(0, copyIdx)) {
    const m = line.match(/^RUN\s+tsx\s+(\S+\.ts)\b/);
    if (m) found.push(m[1]);
  }
  return found;
}

describe("Dockerfile scripts that run before package.json exists", () => {
  const scripts = scriptsRunBeforePackageJsonCopy();

  it("finds at least one, so this test cannot silently pass on an empty list", () => {
    expect(scripts.length).toBeGreaterThan(0);
  });

  for (const script of scripts) {
    it(`${script} transpiles under the CJS format the image falls back to`, () => {
      // esbuild is already a transitive dep via tsx; invoking it directly mirrors what tsx does.
      expect(() =>
        execFileSync("npx", ["esbuild", script, "--format=cjs", "--loader:.ts=ts", "--bundle=false"], {
          cwd: new URL("..", import.meta.url).pathname,
          stdio: ["ignore", "ignore", "pipe"]
        })
      ).not.toThrow();
    });
  }
});
