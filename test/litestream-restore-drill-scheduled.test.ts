import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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

  it("gives systemd more headroom than the wrapper timeout so the wrapper can alert first", () => {
    const unit = readFileSync(join(repoRoot, "scripts/ops/st-litestream-restore-drill.service"), "utf8");
    const wrapper = readFileSync(join(repoRoot, "scripts/ops/st-litestream-restore-drill.sh"), "utf8");
    const unitTimeout = Number(unit.match(/^TimeoutStartSec=(\d+)/m)?.[1]);
    const wrapperDefault = Number(wrapper.match(/ST_RESTORE_DRILL_TIMEOUT_SECONDS:-(\d+)/)?.[1]);
    expect(wrapperDefault).toBeGreaterThan(0);
    expect(unitTimeout).toBeGreaterThan(wrapperDefault);
  });
});
