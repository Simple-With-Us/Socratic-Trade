/**
 * centralTimestamp() is the "Released:" clock in TestFlight What to Test.
 *
 * The template is "Wed, Aug 12, 2026 at 1:15am": America/Chicago, 12-hour,
 * lowercase am/pm, no space before the meridiem, and no timezone suffix.
 * Intl may put a normal space or U+202F before AM/PM. Both fold away.
 *
 * 2026-08-12 06:15 UTC is 1:15am CDT. Nothing here calls App Store Connect.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { centralTimestamp } from "./asc-api.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ONE_FIFTEEN_AM = new Date("2026-08-12T06:15:00.000Z");
const ONE_FIFTEEN_PM = new Date("2026-08-12T18:15:00.000Z");

test("centralTimestamp emits 1:15am with no CT suffix", () => {
  const stamp = centralTimestamp(ONE_FIFTEEN_AM);
  assert.equal(stamp, "Wed, Aug 12, 2026 at 1:15am");
  assert.match(stamp, /1:15am/);
  assert.equal(stamp.includes("CT"), false);
  assert.equal(stamp.includes(" AM"), false);
  assert.equal(stamp.includes("\u202f"), false);
});

test("centralTimestamp emits lowercase pm", () => {
  assert.equal(centralTimestamp(ONE_FIFTEEN_PM), "Wed, Aug 12, 2026 at 1:15pm");
});

test("centralTimestamp folds a narrow no-break space before the meridiem", () => {
  const Original = Intl.DateTimeFormat;
  Intl.DateTimeFormat = class extends Original {
    format(value) {
      return super.format(value).replace(/ ([AP]M)$/, "\u202f$1");
    }
  };
  try {
    assert.equal(centralTimestamp(ONE_FIFTEEN_AM), "Wed, Aug 12, 2026 at 1:15am");
    assert.equal(centralTimestamp(ONE_FIFTEEN_PM), "Wed, Aug 12, 2026 at 1:15pm");
  } finally {
    Intl.DateTimeFormat = Original;
  }
});

test("ship PATH puts system binaries ahead of Homebrew", () => {
  const ship = readFileSync(join(here, "ship-testflight.sh"), "utf8");
  assert.match(
    ship,
    /export PATH="\/usr\/bin:\/bin:\/usr\/sbin:\/sbin:\/opt\/homebrew\/bin:\/usr\/local\/bin:\$\{PATH\}"/
  );
  assert.doesNotMatch(
    ship,
    /export PATH="\/opt\/homebrew\/bin:\/usr\/local\/bin:\$\{PATH\}"/
  );
});

test("ios-ship cache key includes run_attempt and splits restore and save", () => {
  const workflow = readFileSync(join(here, "../../.github/workflows/ios-ship.yml"), "utf8");
  const key = "ios-fleet-socratic-${{ github.run_id }}-${{ github.run_attempt }}";
  assert.equal(workflow.split(key).length - 1, 2);
  assert.match(workflow, /uses: actions\/cache\/restore@/);
  assert.match(workflow, /uses: actions\/cache\/save@/);
  assert.doesNotMatch(workflow, /uses: actions\/cache@/);
  assert.match(workflow, /ios-fleet-socratic-\$\{\{ github\.run_id \}\}-/);
});

test("ios-ship clears stale lockdirs after cache restore and before save", () => {
  const workflow = readFileSync(join(here, "../../.github/workflows/ios-ship.yml"), "utf8");
  const steps = workflow.split(/- name:/);
  const restore = steps.findIndex((s) => /Restore iOS ship state/.test(s));
  const clear = steps.findIndex((s) => /Clear stale ship locks from restored cache/.test(s));
  const gate = steps.findIndex((s) => /Scheduled ship gate \(skip unless/.test(s));
  const removeBeforeSave = steps.findIndex((s) =>
    /Remove ship lockdirs before saving state cache/.test(s)
  );
  const save = steps.findIndex((s) => /Save iOS ship state/.test(s));
  assert.ok(restore >= 0, "restore step exists");
  assert.equal(clear, restore + 1, "lock clear runs immediately after cache restore");
  assert.ok(clear < gate, "stale locks are cleared before the scheduled gate");
  assert.ok(removeBeforeSave > 0 && save > removeBeforeSave, "locks removed before cache save");
  assert.match(steps[clear], /\.lockdir/);
  assert.match(steps[removeBeforeSave], /if: always\(\)/);
  assert.match(steps[removeBeforeSave], /rm -rf/);
});
