import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(__dirname, "..");

describe("ST-4622 litestream restore drill ops scripts", () => {
  it("ships systemd units, installer, and passes the hermetic selftest", () => {
    const paths = [
      "scripts/ops/st-litestream-restore-drill.sh",
      "scripts/ops/st-litestream-restore-drill.service",
      "scripts/ops/st-litestream-restore-drill.timer",
      "scripts/ops/install-st-litestream-restore-drill.sh",
      "scripts/ops/st-litestream-restore-drill.selftest.sh",
    ];
    for (const rel of paths) {
      expect(existsSync(join(repoRoot, rel))).toBe(true);
    }
    const out = execFileSync("bash", [
      join(repoRoot, "scripts/ops/st-litestream-restore-drill.selftest.sh"),
    ], { encoding: "utf8" });
    expect(out).toMatch(/selftest: \d+ passed, 0 failed/);
  });
});
