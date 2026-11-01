import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const workflowPath = join(repoRoot, ".github", "workflows", "auto-merge-prs.yml");

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
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
  return Buffer.from(b64, "base64").toString("utf8");
}

describe("pinned AFC auto-merge reusable", () => {
  it("uses GET for Kody check-run lookups (POST returns 404 and fail-closed disarms auto-merge)", () => {
    const sha = pinnedReusableSha();
    const source = fetchPinnedReusableSource(sha);
    expect(source).toMatch(
      /gh api "repos\/\$REPO\/commits\/\$HEAD\/check-runs"[\s\S]*--method GET/,
    );
  });
});
