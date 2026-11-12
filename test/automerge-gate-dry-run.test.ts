import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const dryRun = join(repoRoot, "scripts", "automerge-gate-dry-run.sh");
const workflowPath = join(repoRoot, ".github", "workflows", "auto-merge-prs.yml");
const codeownersPath = join(repoRoot, ".github", "CODEOWNERS");

function run(...args: string[]): string {
  return execFileSync("bash", [dryRun, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function decision(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of stdout.trim().split("\n")) {
    const eq = line.indexOf("=");
    out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

function codeownersGlobs(text: string): string[] {
  const globs: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const pattern = line.split(/\s+/)[0];
    if (pattern) globs.push(pattern);
  }
  return globs;
}

function documentedGlobs(workflow: string): string[] {
  const start = workflow.indexOf("# BEGIN MONEY_PATH_GLOBS\n");
  const end = workflow.indexOf("# END MONEY_PATH_GLOBS");
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return workflow
    .slice(start, end)
    .split("\n")
    .filter((line) => line.startsWith("# /"))
    .map((line) => line.slice(2));
}

/** One repo path that the CODEOWNERS glob must match. */
function sampleFor(glob: string): string {
  const pat = glob.startsWith("/") ? glob.slice(1) : glob;
  if (pat.endsWith("/")) return `${pat}route.ts`;
  if (pat.includes("*")) return pat.replaceAll("*", "sample");
  return pat;
}

describe("auto-merge money-path globs", () => {
  it("documents the same globs as CODEOWNERS and the dry run", () => {
    const fromCodeowners = codeownersGlobs(readFileSync(codeownersPath, "utf8"));
    const fromWorkflow = documentedGlobs(readFileSync(workflowPath, "utf8"));
    const fromDryRun = run("--list-globs").trim().split("\n");
    expect(fromWorkflow).toEqual(fromCodeowners);
    expect(fromDryRun).toEqual(fromCodeowners);
    expect(fromCodeowners.length).toBeGreaterThan(0);
  });

  it("does not arm a money-path diff and disarms one that was already armed", () => {
    const globs = run("--list-globs").trim().split("\n");
    for (const glob of globs) {
      const got = decision(run("--files", sampleFor(glob)));
      expect(got.touches_protected, glob).toBe("true");
      expect(got.arm, glob).toBe("false");
      expect(got.disarm, glob).toBe("true");
    }
  });

  it("does not arm a do-not-automerge PR and disarms one that was already armed", () => {
    const got = decision(run("--label", "do-not-automerge", "--files", "README.md"));
    expect(got.touches_protected).toBe("false");
    expect(got.hold_label).toBe("true");
    expect(got.arm).toBe("false");
    expect(got.disarm).toBe("true");
  });

  it("arms a non-money diff that has no hold label", () => {
    const got = decision(run("--files", "README.md", "docs/rollouts/example.md"));
    expect(got.touches_protected).toBe("false");
    expect(got.hold_label).toBe("false");
    expect(got.arm).toBe("true");
    expect(got.disarm).toBe("false");
  });

  it("disarms a diff that edits the disable script", () => {
    const got = decision(run("--files", "scripts/disable-pr-automerge.sh"));
    expect(got.gate_edit).toBe("true");
    expect(got.arm).toBe("false");
    expect(got.disarm).toBe("true");
  });

  it("reads CODEOWNERS when launched outside the repo", () => {
    const stdout = execFileSync("bash", [dryRun, "--files", "src/lib/broker.ts"], {
      cwd: tmpdir(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const got = decision(stdout);
    expect(got.touches_protected).toBe("true");
    expect(got.arm).toBe("false");
    expect(got.disarm).toBe("true");
  });
});
