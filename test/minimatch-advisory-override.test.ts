import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type PackageJson = {
  overrides?: Record<string, unknown>;
};

type LockPackage = {
  version?: string;
};

type PackageLock = {
  packages?: Record<string, LockPackage>;
};

// GHSA-g3hv-75wg-m249 covers minimatch >=7 <11.0.1.
// GHSA-cf2h-pxjq-68xw is fixed in 11.0.7.  minimatch 3.1.5 is outside both ranges.
const MINIMATCH_OVERRIDE_KEY = "minimatch@>=7 <11.0.7";
const PATCHED_MINIMATCH = "11.0.8";

function versionParts(version: string): [number, number, number] {
  const [major = Number.NaN, minor = Number.NaN, patch = Number.NaN] = version
    .split(".")
    .map((part) => Number(part));
  return [major, minor, patch];
}

function compareVersions(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function isAllowedMinimatch(version: string): boolean {
  const [major] = versionParts(version);
  if (major === 3) return compareVersions(version, "3.0.5") >= 0;
  return compareVersions(version, "11.0.7") >= 0;
}

describe("minimatch advisory override", () => {
  it("replaces vulnerable 7 through 11.0.6 requests with 11.0.8", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as PackageJson;
    expect(packageJson.overrides?.[MINIMATCH_OVERRIDE_KEY]).toBe(PATCHED_MINIMATCH);
  });

  it("locks every minimatch copy on 3.0.5+ or 11.0.7+", () => {
    const lock = JSON.parse(readFileSync("package-lock.json", "utf8")) as PackageLock;
    const copies = Object.entries(lock.packages ?? {}).filter(([path]) =>
      /(?:^|\/)node_modules\/minimatch$/.test(path),
    );
    expect(copies.length).toBeGreaterThan(0);
    const offenders = copies
      .filter(([, meta]) => !meta.version || !isAllowedMinimatch(meta.version))
      .map(([path, meta]) => `${path}@${meta.version ?? "missing"}`);
    expect(offenders).toEqual([]);
  });
});
