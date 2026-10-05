import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function workflow(name: string): string {
  return readFileSync(join(repoRoot, ".github", "workflows", name), "utf8");
}

function topLevelBlock(source: string, key: string): string {
  return source.match(new RegExp(`^${key}:\\s*\\n((?:^[ \\t].*(?:\\n|$))*)`, "m"))?.[1] ?? "";
}

describe("CI queue safety", () => {
  it("preserves the active required verification run when a newer head arrives", () => {
    const concurrency = topLevelBlock(workflow("ci.yml"), "concurrency");

    // cancel-in-progress was the primary cause of the 2026-07-21 queue wedge
    // (docs/rollouts/2026-07-21-ci-queue-stuck-root-cause-fixes.md). macOS slot
    // pressure is handled by the classify iOS path gate instead (PR #4231).
    expect(concurrency).toMatch(/^  cancel-in-progress:\s*false\s*$/m);
    expect(concurrency).toMatch(/^  group: ci-\$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}\s*$/m);
    expect(concurrency).not.toContain("github.sha");
  });

  it("keeps the reusable iOS lane's cancel policy identical to its caller", () => {
    // ios-build.yml runs as ci.yml's verify-ios lane. A diverging predicate (e.g. keyed on
    // ref) tears down the iOS lane independently of the rest of the suite (PR #4231).
    const caller = topLevelBlock(workflow("ci.yml"), "concurrency").match(/^  cancel-in-progress:(.*)$/m)?.[1]?.trim();
    const callee = topLevelBlock(workflow("ios-build.yml"), "concurrency").match(/^  cancel-in-progress:(.*)$/m)?.[1]?.trim();
    expect(caller).toBe("false");
    expect(callee).toBe(caller);
  });

  it("path-gates verify-ios for merge_group runs too, failing closed", () => {
    const source = workflow("ci.yml");
    // classify must have a checkout on merge_group to diff the queue commit.
    expect(source).toMatch(
      /- uses: actions\/checkout@v\d+\n\s+if: github\.event_name == 'pull_request' \|\| github\.event_name == 'merge_group'/,
    );
    expect(source).toMatch(
      /if \[ "\$\{\{ github\.event_name \}\}" = "merge_group" \]; then[\s\S]*?github\.event\.merge_group\.base_sha[\s\S]*?github\.event\.merge_group\.head_sha[\s\S]*?ios_changed=true[\s\S]*?ios_gate "\$mg_files"/,
    );
  });

  it("matches iOS paths regardless of git path quoting", () => {
    const source = workflow("ci.yml");
    // Every changed-files diff disables core.quotePath so non-ASCII paths are emitted raw.
    const diffs = source.match(/\$\(git (?:-c core\.quotePath=false )?diff --name-only[^\n]*/g) ?? [];
    expect(diffs.length).toBeGreaterThanOrEqual(2);
    for (const d of diffs) expect(d).toContain("-c core.quotePath=false");

    // git still C-quotes names with `"`, `\\` or control bytes; the gate must tolerate the
    // leading quote so such an iOS path still requires verify-ios (never fails open).
    const pattern = source.match(/grep -aE '(\^"\?\(ios\/[^']*)'/)?.[1];
    expect(pattern).toBeDefined();
    const re = new RegExp(pattern!);
    for (const hit of [
      "ios/App/A.swift",
      "ios/App/Café.swift",
      '"ios/App/Caf\\303\\251.swift"',
      '"ios/App/we\\"ird.swift"',
      ".github/workflows/ios-build.yml",
    ]) {
      expect(re.test(hit), hit).toBe(true);
    }
    for (const miss of ["src/ios/x.ts", "docs/ios.md", ".github/workflows/ios-build.yml.bak", "app/page.tsx"]) {
      expect(re.test(miss), miss).toBe(false);
    }
  });

  it("routes PR-adjacent security, pin, and smoke work to the live CI pool", () => {
    for (const name of ["security.yml", "shared-package-pin-check.yml", "e2e.yml"]) {
      const source = workflow(name);

      // The live CI pool is GitHub-hosted ubuntu-latest (self-hosted runners
      // retired 2026-07-29 via this PR; ubuntu-latest assignment is working again).
      expect(source).toContain("runs-on: ubuntu-latest");
      expect(source).not.toContain("runs-on: [self-hosted, trading-live]");
    }
  });

  it("does not target the retired trading-live runner from any workflow", () => {
    const workflowsDir = join(repoRoot, ".github", "workflows");
    const workflowFiles = readdirSync(workflowsDir).filter(
      (name) => name.endsWith(".yml") || name.endsWith(".yaml")
    );

    for (const name of workflowFiles) {
      expect(workflow(name)).not.toContain("runs-on: [self-hosted, trading-live]");
    }
  });

  it("does not schedule Playwright smoke for every pull request", () => {
    const triggers = topLevelBlock(workflow("e2e.yml"), "on");

    expect(triggers).not.toMatch(/^  pull_request:/m);
    expect(triggers).not.toMatch(/^  merge_group:/m);
  });

  it("runs the shared-package pin check on every PR with Node available before comparison", () => {
    const source = workflow("shared-package-pin-check.yml");
    expect(source).toMatch(/^  pull_request:\s*$/m);
    expect(source).not.toMatch(/^  pull_request:\n(?:^[ \t]+.*\n)*^[ \t]+paths:/m);

    const nodeSetup = source.search(/uses: actions\/setup-node@/);
    const comparison = source.search(/Compare (ST \/ UM \/ CT shared-package pins|shared-package version against the peer consumer)/);
    expect(nodeSetup).toBeGreaterThan(-1);
    expect(nodeSetup).toBeLessThan(comparison);
  });
});
