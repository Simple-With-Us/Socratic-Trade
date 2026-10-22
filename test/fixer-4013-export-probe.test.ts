import { describe, it, expect } from "vitest";
// BF-FIXER probe for Socratic-Trade PR #4013.
//
// The Sentry CRITICAL review thread on app/api/health/route.ts:4 claims
// `clearLivenessWarning` is imported from "@/lib/db" but is NOT re-exported
// from that module, which would be a runtime break on the public health route.
//
// This test resolves the import through the exact same specifier the route uses.
// If the re-export chain is broken, this file fails to even import.
import { clearLivenessWarning } from "@/lib/db";

describe("PR #4013 re-export probe", () => {
  it("resolves clearLivenessWarning through @/lib/db (as route.ts imports it)", () => {
    expect(typeof clearLivenessWarning).toBe("function");
  });

  it("resolves clearLivenessWarning directly from @/lib/db-health", async () => {
    const mod = await import("@/lib/db-health");
    expect(typeof mod.clearLivenessWarning).toBe("function");
  });

  it("db.ts re-exports the db-health module (static source check)", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(
      path.join(process.cwd(), "src/lib/db.ts"),
      "utf8",
    );
    expect(src).toMatch(/export\s+\*\s+from\s+["']\.\/db-health["']/);
  });
});
