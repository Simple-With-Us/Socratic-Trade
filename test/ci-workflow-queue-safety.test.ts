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
  it("cancels superseded pull_request and merge_group runs and keeps main, schedule, and workflow_dispatch alive", () => {
    const concurrency = topLevelBlock(workflow("ci.yml"), "concurrency");

    // Cancel only the events that stack behind a newer head. A literal `true`
    // would also drop in-flight main / schedule / workflow_dispatch suites; a
    // literal `false` serializes the PR queue behind the previous head.
    expect(concurrency).toMatch(
      /^  cancel-in-progress:\s*\$\{\{\s*github\.event_name == 'pull_request' \|\| github\.event_name == 'merge_group'\s*\}\}\s*$/m,
    );
    expect(concurrency).not.toMatch(/^  cancel-in-progress:\s*(?:true|false)\s*$/m);
    expect(concurrency).toMatch(/^  group: ci-\$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}\s*$/m);
    expect(concurrency).not.toContain("github.sha");
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
