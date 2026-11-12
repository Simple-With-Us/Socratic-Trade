import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const selftest = join(import.meta.dirname, "..", "scripts", "ops", "sentry-cron-checkin.selftest.sh");

describe("sentry-cron-checkin host wrap", () => {
  it("passes the hermetic selftest (ok, error, Sentry down, disabled)", () => {
    const result = spawnSync("bash", [selftest], { encoding: "utf8" });
    if (result.status !== 0) {
      expect(`${result.stdout}\n${result.stderr}`).toBe("");
    }
    expect(result.status).toBe(0);
  });
});
