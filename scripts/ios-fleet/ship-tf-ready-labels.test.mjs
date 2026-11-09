#!/usr/bin/env node
/**
 * Offline contract: ensure_tf_ready maps asc-api.mjs exit codes 2-6 to distinct
 * operator-facing messages (OPS-1052).  No App Store Connect or ship run.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const shipPath = join(ROOT, "scripts/ios-fleet/ship-testflight.sh");
const ship = readFileSync(shipPath, "utf8");
const workflow = readFileSync(join(ROOT, ".github/workflows/ios-ship.yml"), "utf8");

/** Full `ensure_tf_ready()` body only — never slice rc branches from the whole ship script (other rc=4 blocks exist). */
function extractEnsureTfReadyBody(source) {
  const extracted = spawnSync("sed", ["-n", "/^ensure_tf_ready()/,/^}/p", shipPath], {
    encoding: "utf8",
  }).stdout;
  assert.ok(extracted.includes("ensure_tf_ready()"), "ensure_tf_ready() not found in ship-testflight.sh");
  const start = source.indexOf("ensure_tf_ready() {");
  assert.ok(start >= 0, "ensure_tf_ready() definition missing");
  const closeLine = extracted.trimEnd().split("\n").pop() || "";
  assert.equal(closeLine, "}", "sed range must end at ensure_tf_ready closing brace");
  return extracted;
}

const ensureFn = extractEnsureTfReadyBody(ship);

function sliceBetweenIn(haystack, start, end) {
  const a = haystack.indexOf(start);
  assert.ok(a >= 0, `missing marker in ensure_tf_ready: ${start}`);
  const b = end ? haystack.indexOf(end, a + start.length) : haystack.length;
  assert.ok(b > a, `missing end marker after: ${start}`);
  return haystack.slice(a, b);
}

test("ensure_tf_ready has distinct branches for rc 0,3,4,5,6 and a dedicated rc=2 fallback", () => {
  assert.match(ensureFn, /if \[\[ \$rc -eq 0 \]\]/);
  assert.match(ensureFn, /if \[\[ \$rc -eq 5 \]\]/);
  assert.match(ensureFn, /if \[\[ \$rc -eq 6 \]\]/);
  assert.match(ensureFn, /if \[\[ \$rc -eq 3 \]\]/);
  assert.match(ensureFn, /if \[\[ \$rc -eq 4 \]\]/);
  assert.match(ensureFn, /build may be stuck on export compliance/);

  const rc5 = sliceBetweenIn(ensureFn, "if [[ $rc -eq 5 ]]", "if [[ $rc -eq 6 ]]");
  const rc6 = sliceBetweenIn(ensureFn, "if [[ $rc -eq 6 ]]", "if [[ $rc -eq 3 ]]");
  const rc3 = sliceBetweenIn(ensureFn, "if [[ $rc -eq 3 ]]", "if [[ $rc -eq 4 ]]");
  const rc4 = sliceBetweenIn(ensureFn, "if [[ $rc -eq 4 ]]", "# rc=2 is a usage error");
  const rc2 = sliceBetweenIn(ensureFn, "# rc=2 is a usage error", "return 0\n}");

  const needles = {
    5: "no internal TestFlight testers with access to all builds",
    6: "internal TestFlight tester count could not be read",
    3: "has not reached IN_BETA_TESTING",
    4: "ASC never surfaced build",
    2: "export compliance not declared",
  };

  assert.match(rc5, new RegExp(needles[5]));
  assert.match(rc6, new RegExp(needles[6]));
  assert.match(rc3, new RegExp(needles[3]));
  assert.match(rc4, new RegExp(needles[4]));
  assert.match(rc2, new RegExp(needles[2]));

  assert.doesNotMatch(rc5, /stuck on export compliance/);
  assert.doesNotMatch(rc6, /stuck on export compliance/);
  assert.match(rc5, /::warning title=TestFlight has no reachable internal tester::/);
  assert.match(rc6, /::warning title=TestFlight internal installability unverified::/);
  assert.doesNotMatch(rc5, /external TestFlight/);
  assert.doesNotMatch(rc6, /external installability/);

  // Regression: a whole-file slice would bind rc=4 to an unrelated block (~line 802).
  const bogusRc4 = ship.indexOf("if [[ $rc -eq 4 ]]");
  const ensureStart = ship.indexOf("ensure_tf_ready() {");
  const rc4InFn = ensureFn.indexOf("if [[ $rc -eq 4 ]]");
  assert.ok(bogusRc4 < ensureStart, "ship script should contain an earlier rc=4 block outside ensure_tf_ready");
  assert.ok(rc4InFn > 0, "ensure_tf_ready must contain its own rc=4 branch");
  assert.notEqual(
    ship.slice(bogusRc4, ship.indexOf("if [[ $rc -eq 4 ]]", bogusRc4 + 1)),
    rc4,
    "rc=4 assertions must come from ensure_tf_ready, not the first file match",
  );
});

test("ensure_tf_ready runtime labels each mocked asc-api exit code distinctly", () => {
  assert.ok(ensureFn.includes("ensure_tf_ready()"));
  for (const rc of [2, 3, 4, 5, 6]) {
    const script = `set -euo pipefail
log(){ printf '%s\\n' "$*"; }
BUNDLE_ID=com.socratictrade.ios
BUILD_NUM=202611091230
MARKETING=1.0.0
LOG_DIR=$(mktemp -d)
FLEET_DIR=${JSON.stringify(join(ROOT, "scripts/ios-fleet"))}
ASC_NODE=node
REPO_ROOT=${JSON.stringify(ROOT)}
DISPLAY_NAME="Socratic Trade"
PREV_SHIP_SHA=deadbeef
IOS_PATH_PREFIX=ios
GITHUB_ACTIONS=1
node(){
  echo "mock ensure-tf-ready rc=${rc}" >>"$LOG_DIR/ensure-tf-ready.err"
  return ${rc}
}
${ensureFn}
ensure_tf_ready
`;
    const run = spawnSync("bash", ["-c", script], { encoding: "utf8" });
    assert.equal(run.status, 0, `ensure_tf_ready must stay green for rc=${rc}`);
    const out = `${run.stdout}\n${run.stderr}`;
    if (rc === 5) {
      assert.match(out, /no internal TestFlight testers with access to all builds/);
      assert.doesNotMatch(out, /stuck on export compliance/);
      assert.doesNotMatch(out, /external tester/);
    } else if (rc === 6) {
      assert.match(out, /internal TestFlight tester count could not be read/);
      assert.doesNotMatch(out, /stuck on export compliance/);
      assert.doesNotMatch(out, /external installability/);
    } else if (rc === 3) {
      assert.match(out, /IN_BETA_TESTING/);
    } else if (rc === 4) {
      assert.match(out, /ASC never surfaced build/);
    } else {
      assert.match(out, /export compliance/);
    }
  }
});

test("ios-ship workflow re-runs ensure-tf-ready only after standing-tester sync when that step exists", () => {
  const syncMarker = "name: Sync standing TestFlight testers";
  if (!workflow.includes(syncMarker)) {
    assert.ok(true, "no standing-tester sync step in this repo yet; ordering fix is N/A");
    return;
  }
  const afterSync = workflow.slice(workflow.indexOf(syncMarker));
  assert.match(
    afterSync,
    /ensure-tf-ready[\s\S]*GITHUB_STEP_SUMMARY/,
    "post-sync ensure-tf-ready must write the ship summary from the second check",
  );
});
