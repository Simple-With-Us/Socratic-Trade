import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const script = join(repoRoot, "scripts", "disable-pr-automerge.sh");

function fakeBin(body: string): { dir: string; calls: string } {
  const dir = mkdtempSync(join(tmpdir(), "disable-automerge-"));
  const calls = join(dir, "calls");
  const gh = join(dir, "gh");
  writeFileSync(gh, body.replaceAll("__CALLS__", calls), "utf8");
  chmodSync(gh, 0o755);
  return { dir, calls };
}

function run(bin: string, env: Record<string, string>): { status: number; stdout: string } {
  try {
    const stdout = execFileSync("bash", [script, "https://example.test/pr/1"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        NODE_ENV: "test",
        GH_TOKEN: env.GH_TOKEN ?? "",
        DISABLE_AUTOMERGE_FALLBACK_TOKEN: env.DISABLE_AUTOMERGE_FALLBACK_TOKEN ?? "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string | Buffer };
    const stdout = typeof e.stdout === "string" ? e.stdout : e.stdout?.toString("utf8") ?? "";
    return { status: typeof e.status === "number" ? e.status : 2, stdout };
  }
}

describe("disable-pr-automerge.sh", () => {
  it("retries with the Actions token when the primary token is rejected", () => {
    const { dir, calls } = fakeBin(`#!/bin/bash
printf '%s\\n' "$GH_TOKEN" >> "__CALLS__"
if [ "$GH_TOKEN" = "bad-pat" ]; then
  echo "non-200 OK status code: 401 Unauthorized Bad credentials" >&2
  exit 1
fi
echo "disabled"
exit 0
`);
    const got = run(dir, { GH_TOKEN: "bad-pat", DISABLE_AUTOMERGE_FALLBACK_TOKEN: "actions" });
    expect(got.status).toBe(0);
    expect(got.stdout).toContain("retrying disable with the Actions token");
    const recorded = execFileSync("cat", [calls], { encoding: "utf8" }).trim().split("\n");
    expect(recorded).toEqual(["bad-pat", "actions"]);
  });

  it("treats an already-off merge as success without a retry", () => {
    const { dir, calls } = fakeBin(`#!/bin/bash
printf '%s\\n' "$GH_TOKEN" >> "__CALLS__"
echo "auto merge is not enabled" >&2
exit 1
`);
    const got = run(dir, { GH_TOKEN: "bad-pat", DISABLE_AUTOMERGE_FALLBACK_TOKEN: "actions" });
    expect(got.status).toBe(0);
    expect(got.stdout).toContain("already off or not armed");
    const recorded = execFileSync("cat", [calls], { encoding: "utf8" }).trim().split("\n");
    expect(recorded).toEqual(["bad-pat"]);
  });

  it("fails when every token is rejected", () => {
    const { dir } = fakeBin(`#!/bin/bash
echo "401 Unauthorized Bad credentials" >&2
exit 1
`);
    const got = run(dir, { GH_TOKEN: "bad-pat", DISABLE_AUTOMERGE_FALLBACK_TOKEN: "also-bad" });
    expect(got.status).toBe(1);
    expect(got.stdout).toContain("credentials rejected");
  });

  it("treats an integration refusal as success when auto-merge is already off", () => {
    const { dir } = fakeBin(`#!/bin/bash
if [[ "$*" == *"--disable-auto"* ]]; then
  echo "GraphQL: Resource not accessible by integration (disablePullRequestAutoMerge)" >&2
  exit 1
fi
echo '{"autoMergeRequest":null}'
exit 0
`);
    const got = run(dir, { GH_TOKEN: "bad-pat", DISABLE_AUTOMERGE_FALLBACK_TOKEN: "actions" });
    expect(got.status).toBe(0);
    expect(got.stdout).toContain("already off");
  });

  it("fails when disable is rejected and auto-merge is still armed", () => {
    const { dir } = fakeBin(`#!/bin/bash
if [[ "$*" == *"--disable-auto"* ]]; then
  echo "GraphQL: Resource not accessible by integration (disablePullRequestAutoMerge)" >&2
  exit 1
fi
echo '{"autoMergeRequest":{"enabledAt":"2026-10-15T00:00:00Z"}}'
exit 0
`);
    const got = run(dir, { GH_TOKEN: "bad-pat", DISABLE_AUTOMERGE_FALLBACK_TOKEN: "actions" });
    expect(got.status).toBe(1);
    expect(got.stdout).toContain("still armed");
  });
});
