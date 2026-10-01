// The liveness watchdog's numeric env guards in scripts/coolify-prod-start.sh:
// non-numeric AND zero values must fall back to the defaults (0 would busy-loop
// the probe, or kill the app on the first missed probe).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const script = readFileSync(join(__dirname, "..", "scripts", "coolify-prod-start.sh"), "utf8");
const guards = script.split("\n").filter((line) => /^case "\$LIVENESS_WATCHDOG_(INTERVAL|FAILURES|BOOT_GRACE_S)"/.test(line));

describe.skipIf(process.platform === "win32")("liveness watchdog numeric guards", () => {
  const run = (name: string, value: string) =>
    execFileSync("bash", ["-c", `${name}=\"$1\"; DEFAULTS_DONE=1; ${guards.join("\n")}; printf '%s' "\$${name}"`, "_", value], {
      env: { ...process.env, LIVENESS_WATCHDOG_INTERVAL: "", LIVENESS_WATCHDOG_FAILURES: "", LIVENESS_WATCHDOG_BOOT_GRACE_S: "" },
    }).toString();

  it("found the guard lines", () => {
    expect(guards.length).toBeGreaterThanOrEqual(5);
  });

  it.each([["0"], ["00"], ["abc"], [""]])("interval %j falls back to 30", (value) => {
    expect(run("LIVENESS_WATCHDOG_INTERVAL", value)).toBe("30");
  });

  it.each([["0"], ["000"], ["x"], [""]])("failures %j falls back to 5", (value) => {
    expect(run("LIVENESS_WATCHDOG_FAILURES", value)).toBe("5");
  });

  it("keeps a valid value, and 0 stays valid for the boot grace (no grace)", () => {
    expect(run("LIVENESS_WATCHDOG_INTERVAL", "45")).toBe("45");
    expect(run("LIVENESS_WATCHDOG_BOOT_GRACE_S", "0")).toBe("0");
  });
});
