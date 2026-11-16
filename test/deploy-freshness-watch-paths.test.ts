// The deploy-freshness watchdog answers one question: is production missing a
// deployment that Coolify owed it.  It answers it with Coolify's live
// `watch_paths` allow list, which is recorded in src/lib/deploy-image-impact.ts
// and mirrored into scripts/alert-deploy-freshness.sh, because that script is
// pure ASCII bash that has to run before any node toolchain exists.
//
// The two copies drift silently.  When they do, the watchdog either pages on
// commits that can never deploy or stays quiet on commits that must, and both
// failures are silent.  This test fails on drift (ST-4575).
//
// The live list is the record of what ASC applied to socratic-app on
// 2026-08-18.  Do not PATCH it from a PR; it is applied out of band, and this
// test is how the repo learns that the live value moved.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COOLIFY_WATCH_PATHS_LIVE } from "../src/lib/deploy-image-impact";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = join(repoRoot, "scripts", "alert-deploy-freshness.sh");

function watchPathsFromScript(): string[] {
  const source = readFileSync(SCRIPT, "utf8");
  const match = source.match(/^WATCH_PATHS="([^"]*)"/m);
  if (!match) throw new Error(`WATCH_PATHS is not set in ${SCRIPT}`);
  return match[1].split(/\s+/).filter((entry) => entry.length > 0);
}

describe("deploy-freshness watch paths", () => {
  it("mirrors the live Coolify watch_paths", () => {
    // A git pathspec names a directory and everything under it, so `src`
    // covers `src/**`.  The live list carries both forms for every tree, so
    // the mirror carries the bare directory name once.
    const expected = [
      ...new Set(COOLIFY_WATCH_PATHS_LIVE.map((entry) => entry.replace(/\/\*\*$/, "")))
    ].sort();
    expect([...watchPathsFromScript()].sort()).toEqual(expected);
  });

  it("does not watch a path that Coolify does not watch", () => {
    // The false positive behind ST-4575 was a CI workflow file being treated
    // as image-affecting.  These are the trees the watchdog must never age.
    for (const path of [".github", "docs", "ios", "test", "STATUS.md", "PLAN.md"]) {
      expect(watchPathsFromScript()).not.toContain(path);
    }
  });

  it("watches the runtime trees the image is built from", () => {
    for (const path of ["src", "app", "public", "scripts", "Dockerfile", "package-lock.json"]) {
      expect(watchPathsFromScript()).toContain(path);
    }
  });

  it("uses the first-parent chain so a merge is judged by what landed on main", () => {
    // Without --first-parent a merge is compared against the PR branch tip,
    // so it looks like it changed every path main gained since the branch
    // point and a docs-only PR reads as image-affecting.
    const source = readFileSync(SCRIPT, "utf8");
    const revList = source.match(/^UNDEPLOYED_LIST=.*$/m);
    expect(revList).not.toBeNull();
    expect(revList?.[0]).toContain("--first-parent");
    expect(revList?.[0]).toContain("-- $WATCH_PATHS");
  });
});
