import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const script = join(repoRoot, "scripts", "pr-touches-codeowners-paths.sh");
const defaultCodeowners = join(repoRoot, ".github", "CODEOWNERS");

function protectedExit(
  ...files: string[]
): { status: number; codeownersFile: string } {
  const codeownersFile =
    process.env.CODEOWNERS_FILE ?? defaultCodeowners;
  try {
    execFileSync("bash", [script, "--files", ...files], {
      cwd: repoRoot,
      stdio: "pipe",
      env: {
        ...process.env,
        CODEOWNERS_FILE: codeownersFile,
      },
    });
    return { status: 0, codeownersFile };
  } catch (err: unknown) {
    const e: { status?: unknown } =
      typeof err === "object" && err !== null && "status" in err
        ? { status: (err as { status?: unknown }).status }
        : {};
    return {
      status: typeof e.status === "number" ? e.status : 2,
      codeownersFile,
    };
  }
}

describe("pr-touches-codeowners-paths.sh", () => {
  it("flags broker and execution paths from CODEOWNERS", () => {
    expect(protectedExit("src/lib/broker.ts").status).toBe(0);
    expect(protectedExit("src/lib/robinhood.ts").status).toBe(0);
    expect(protectedExit("src/lib/execution-mode.ts").status).toBe(0);
    expect(protectedExit("app/api/orders/route.ts").status).toBe(0);
    expect(protectedExit("src/lib/db-proposals.ts").status).toBe(0);
  });

  it("allows non-money paths", () => {
    expect(protectedExit("README.md").status).toBe(1);
    expect(protectedExit("app/console/page.tsx").status).toBe(1);
    expect(protectedExit("docs/rollouts/example.md").status).toBe(1);
  });

  it("matches broker-* globs without matching unrelated files", () => {
    expect(protectedExit("src/lib/broker-minimum-guard.ts").status).toBe(0);
    expect(protectedExit("src/lib/market.ts").status).toBe(1);
  });

  it("honors CODEOWNERS_FILE override (base-revision seam)", () => {
    const dir = mkdtempSync(join(tmpdir(), "codeowners-test-"));
    const overridePath = join(dir, "CODEOWNERS");
    writeFileSync(overridePath, "broker.ts @owner\n", "utf8");

    const prev = process.env.CODEOWNERS_FILE;
    process.env.CODEOWNERS_FILE = overridePath;
    try {
      expect(protectedExit("nested/pkg/broker.ts").status).toBe(0);
      expect(protectedExit("broker.ts").status).toBe(0);
      expect(protectedExit("nested/pkg/other.ts").status).toBe(1);
    } finally {
      if (prev === undefined) {
        delete process.env.CODEOWNERS_FILE;
      } else {
        process.env.CODEOWNERS_FILE = prev;
      }
    }
  });
});
