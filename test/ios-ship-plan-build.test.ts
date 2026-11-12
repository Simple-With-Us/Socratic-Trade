import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// The plan-build step must pass plan-release-build the SAME inputs the local
// ship script plans with (Kody #4964 round 1): bundle id, paired bundle id,
// and the pairedBuildFeed floor. A bundle-only CI plan sits below the true M
// once the registry gains paired keys, and the this-platform-only --build
// check still accepts it -- a wasted archive and a rejected upload.
function planStep(): string {
  const source = readFileSync(join(repoRoot, ".github", "workflows", "ios-ship.yml"), "utf8");
  const start = source.indexOf("- name: Plan release build (compute once)");
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf("\n      - name:", start + 10);
  return source.slice(start, end === -1 ? undefined : end);
}

describe("ios-ship plan-build inputs", () => {
  it("reads the paired bundle id and feed floor from the registry", () => {
    const step = planStep();
    expect(step).toContain('["apps"]["socratic"]');
    expect(step).toContain("pairedBundleId");
    // Legacy key from the retired counter; pairedBundleId wins.
    expect(step).toContain("macBundleId");
    expect(step).toContain("pairedBuildFeed");
  });

  it("passes the collected args, not just the bundle id, to plan-release-build", () => {
    const step = planStep();
    expect(step).toContain('plan-release-build "${plan_args[@]}" --merge-stamp "$stamp"');
    expect(step).not.toContain('plan-release-build "$bundle" --merge-stamp');
  });

  it("fails closed on a non-https, unreadable, or unusable feed", () => {
    const step = planStep();
    expect(step).toContain("is not https");
    expect(step).toContain("could not be read");
    expect(step).toContain("no usable plain-integer <sparkle:version>");
  });

  it("stays in step with the local planner's registry keys", () => {
    // ship-testflight.sh asc_next_shared_build is the other plan site; a key
    // rename must break loudly here, not silently diverge the two plans.
    const ship = readFileSync(
      join(repoRoot, "scripts", "ios-fleet", "ship-testflight.sh"),
      "utf8",
    );
    for (const key of ["pairedBundleId", "macBundleId", "pairedBuildFeed"]) {
      expect(ship).toContain(`json_get "$APP_KEY" ${key}`);
      expect(planStep()).toContain(key);
    }
  });
});
