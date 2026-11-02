import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const workflowPath = join(repoRoot, ".github", "workflows", "auto-merge-prs.yml");

// The pinned AFC reusable lives in another repo, so checking it needs an
// authenticated `gh`.  CI test jobs carry no GitHub token, so the live check
// only runs where one is set (a dev box, or GH_TOKEN=... npx vitest run <this file>).
const ghToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;

function pinnedReusableSha(): string {
  const workflow = readFileSync(workflowPath, "utf8");
  const match = workflow.match(
    /uses: Simple-With-Us\/AI-Fleet-Coordinator\/\.github\/workflows\/auto-merge-reusable\.yml@([0-9a-f]{40})\b/,
  );
  if (!match) throw new Error("auto-merge-prs.yml is missing a pinned AFC reusable SHA");
  return match[1];
}

function fetchPinnedReusableSource(sha: string): string {
  const b64 = execFileSync(
    "gh",
    [
      "api",
      `repos/Simple-With-Us/AI-Fleet-Coordinator/contents/.github/workflows/auto-merge-reusable.yml?ref=${sha}`,
      "--jq",
      ".content",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000 },
  ).trim();
  return Buffer.from(b64, "base64").toString("utf8");
}

/** Every commit check-run lookup, with shell line continuations joined into one command. */
function checkRunLookupCommands(source: string): string[] {
  const joined = source.replace(/\\\r?\n/g, " ");
  return joined
    .split(/\r?\n/)
    .filter((line) => /gh api "repos\/\$REPO\/commits\/\$[A-Za-z_]+\/check-runs"/.test(line));
}

describe("check-run lookup parsing", () => {
  it("ties --method GET to the same command, not a later one", () => {
    const bad = [
      'gh api "repos/$REPO/commits/$HEAD/check-runs" \\',
      "  -f per_page=100",
      'gh api "repos/$REPO/pulls" --method GET',
    ].join("\n");
    const cmds = checkRunLookupCommands(bad);
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).not.toMatch(/--method GET/);
  });
});

describe.skipIf(!ghToken)("pinned AFC auto-merge reusable", () => {
  it("uses GET for Kody check-run lookups (POST returns 404 and fail-closed disarms auto-merge)", () => {
    const cmds = checkRunLookupCommands(fetchPinnedReusableSource(pinnedReusableSha()));
    expect(cmds.length).toBeGreaterThan(0);
    for (const cmd of cmds) expect(cmd).toMatch(/--method GET\b/);
  });
});
