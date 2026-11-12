import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

const SKIP_DIR_NAMES = new Set([
  ".git",
  ".next",
  "node_modules",
  "build",
  "coverage",
  "data",
  "out",
  "playwright-report",
  "test-results",
]);

/** Paths where the old org slug is intentional archive or changelog. */
const SKIP_PATH_PREFIXES = [
  "docs/rollouts/",
  "docs/EFFORT-LOG.md",
  "reference/atlas-public/",
  "reference/atlas-public-src/",
  "docs/handoffs/",
  "docs/audits/",
  "docs/reviews/",
];

const STALE_PATTERNS: RegExp[] = [
  /github\.com\/jaywedgeworth22\//i,
  /repos\/jaywedgeworth22\//i,
  /raw\.githubusercontent\.com\/jaywedgeworth22\//i,
  /\bjaywedgeworth22\/Socratic[-.]Trade\b/i,
  /\bjaywedgeworth22\/Congress\.Trade\b/i,
  /\bjaywedgeworth22\/Usage-Monitor\b/i,
  /\bjaywedgeworth22\/congress-trading-shared\b/i,
  /\bjaywedgeworth22\/ai-fleet-coordinator\b/i,
  /\bjaywedgeworth22\/ios-app-versions\b/i,
  /\bjaywedgeworth22\/fleet-ops\b/i,
  /\bjaywedgeworth22\/agentic-trading\b/i,
  /\bjaywedgeworth22\/robinhood-agentic-trading\b/i,
];

function shouldSkipFile(rel: string): boolean {
  if (rel === ".github/CODEOWNERS") return true;
  if (rel === "test/github-org-slug.test.ts") return true;
  for (const prefix of SKIP_PATH_PREFIXES) {
    if (rel === prefix || rel.startsWith(prefix)) return true;
  }
  return false;
}

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIR_NAMES.has(name)) continue;
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) {
      walkFiles(abs, out);
      continue;
    }
    if (!st.isFile()) continue;
    const rel = relative(ROOT, abs).replace(/\\/g, "/");
    if (shouldSkipFile(rel)) continue;
    out.push(rel);
  }
  return out;
}

function isAllowedLine(line: string): boolean {
  if (/12656028\+jaywedgeworth22@users\.noreply\.github\.com/.test(line)) return true;
  if (/@jaywedgeworth22\b/.test(line)) return true;
  if (/EFFORT_ISSUES_ASSIGNEE.*jaywedgeworth22/.test(line)) return true;
  if (/github\.com\/jaywedgeworth22\/.+\/(pull\/|actions\/)/.test(line)) return true;
  return false;
}

describe("GitHub org slug (Simple-With-Us)", () => {
  it("has no live jaywedgeworth22 repo-owner strings outside archives", () => {
    const violations: string[] = [];
    for (const rel of walkFiles(ROOT)) {
      let text: string;
      try {
        text = readFileSync(join(ROOT, rel), "utf8");
      } catch {
        continue;
      }
      if (!text.includes("jaywedgeworth22")) continue;
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? "";
        if (isAllowedLine(line)) continue;
        for (const pat of STALE_PATTERNS) {
          if (pat.test(line)) {
            violations.push(`${rel}:${i + 1}: ${line.trim().slice(0, 160)}`);
            break;
          }
        }
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });
});
