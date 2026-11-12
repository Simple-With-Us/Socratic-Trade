import { readFileSync } from "node:fs";
import * as semver from "semver";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const PackageJsonSchema = z.object({
  overrides: z.record(z.string(), z.unknown()).optional(),
});

const PackageLockSchema = z.object({
  packages: z
    .record(
      z.string(),
      z
        .object({
          version: z.string().optional(),
        })
        .passthrough(),
    )
    .optional(),
});

// GHSA-g3hv-75wg-m249 covers minimatch >=7 <11.0.1.
// GHSA-cf2h-pxjq-68xw is fixed in 11.0.7.  minimatch 3.1.5 is outside both ranges.
const MINIMATCH_OVERRIDE_KEY = "minimatch@>=7 <11.0.7";
const MINIMATCH_PATCH_FLOOR = "11.0.7";
const MINIMATCH_V3_FLOOR = "3.0.5";
const VULNERABLE_MINIMATCH_RANGE = ">=7 <11.0.7";

function isSafeOverrideValue(value: string): boolean {
  const overrideRange = semver.validRange(value);
  if (!overrideRange) return false;
  if (semver.intersects(overrideRange, VULNERABLE_MINIMATCH_RANGE)) return false;
  const minimumOverride = semver.minVersion(overrideRange);
  if (!minimumOverride) return false;
  return semver.gte(minimumOverride, MINIMATCH_PATCH_FLOOR);
}

function isAllowedMinimatch(version: string): boolean {
  const parsed = semver.parse(version);
  if (!parsed) return false;
  if (parsed.major === 3) return semver.gte(parsed, MINIMATCH_V3_FLOOR);
  if (parsed.major >= 4 && parsed.major < 7) return true;
  return semver.gte(parsed, MINIMATCH_PATCH_FLOOR);
}

describe("minimatch advisory override", () => {
  it("replaces vulnerable 7 through 11.0.6 requests with a patched 11.0.7+", () => {
    const packageJson = PackageJsonSchema.parse(
      JSON.parse(readFileSync("package.json", "utf8")),
    );
    const override = packageJson.overrides?.[MINIMATCH_OVERRIDE_KEY];
    expect(typeof override).toBe("string");
    expect(isSafeOverrideValue(String(override))).toBe(true);
  });

  it("locks every minimatch copy on a safe 3.x, 4.x-6.x, or 11.0.7+ line", () => {
    const lock = PackageLockSchema.parse(
      JSON.parse(readFileSync("package-lock.json", "utf8")),
    );
    const copies = Object.entries(lock.packages ?? {}).filter(([path]) =>
      /(?:^|\/)node_modules\/minimatch$/.test(path),
    );
    expect(copies.length).toBeGreaterThan(0);
    const offenders = copies
      .filter(([, meta]) => !meta.version || !isAllowedMinimatch(meta.version))
      .map(([path, meta]) => `${path}@${meta.version ?? "missing"}`);
    expect(offenders).toEqual([]);
  });

  it("allows unaffected 4.x-6.x copies and patched prereleases, and rejects advisory ranges", () => {
    expect(isAllowedMinimatch("3.1.5")).toBe(true);
    expect(isAllowedMinimatch("3.0.5")).toBe(true);
    expect(isAllowedMinimatch("3.0.4")).toBe(false);
    expect(isAllowedMinimatch("5.0.0")).toBe(true);
    expect(isAllowedMinimatch("6.0.2")).toBe(true);
    expect(isAllowedMinimatch("10.2.6")).toBe(false);
    expect(isAllowedMinimatch("11.0.6")).toBe(false);
    expect(isAllowedMinimatch("11.0.7")).toBe(true);
    expect(isAllowedMinimatch("11.0.8")).toBe(true);
    expect(isAllowedMinimatch("11.0.9-rc.1")).toBe(true);
    expect(isAllowedMinimatch("11.0.7-rc.1")).toBe(false);
    expect(isAllowedMinimatch("not-a-version")).toBe(false);
  });

  it("accepts an exact or range override whose minimum is 11.0.7+, and rejects a range that includes a vulnerable version", () => {
    expect(isSafeOverrideValue("11.0.8")).toBe(true);
    expect(isSafeOverrideValue("^11.0.8")).toBe(true);
    expect(isSafeOverrideValue(">=11.0.7 <12")).toBe(true);
    expect(isSafeOverrideValue("^11.0.6")).toBe(false);
    expect(isSafeOverrideValue(">=7 <11.0.7")).toBe(false);
    expect(isSafeOverrideValue(">=11.0.6")).toBe(false);
    expect(isSafeOverrideValue("*")).toBe(false);
    expect(isSafeOverrideValue("not-a-version")).toBe(false);
  });
});
