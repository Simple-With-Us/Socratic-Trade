import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const script = join(repoRoot, "scripts", "pr-touches-codeowners-paths.sh");

function protectedExit(...files: string[]): number {
  try {
    execFileSync("bash", [script, "--files", ...files], {
      cwd: repoRoot,
      stdio: "pipe",
    });
    return 0;
  } catch (err: unknown) {
    const e: { status?: unknown } =
      typeof err === "object" && err !== null && "status" in err
        ? { status: (err as { status?: unknown }).status }
        : {};
    return typeof e.status === "number" ? e.status : 2;
  }
}

describe("pr-touches-codeowners-paths.sh", () => {
  it("flags broker and execution paths from CODEOWNERS", () => {
    expect(protectedExit("src/lib/broker.ts")).toBe(0);
    expect(protectedExit("src/lib/robinhood.ts")).toBe(0);
    expect(protectedExit("src/lib/execution-mode.ts")).toBe(0);
    expect(protectedExit("app/api/orders/route.ts")).toBe(0);
    expect(protectedExit("src/lib/db-proposals.ts")).toBe(0);
  });

  it("allows non-money paths", () => {
    expect(protectedExit("README.md")).toBe(1);
    expect(protectedExit("app/console/page.tsx")).toBe(1);
    expect(protectedExit("docs/rollouts/example.md")).toBe(1);
  });

  it("matches broker-* globs without matching unrelated files", () => {
    expect(protectedExit("src/lib/broker-minimum-guard.ts")).toBe(0);
    expect(protectedExit("src/lib/market.ts")).toBe(1);
  });
});
