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
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

const LOCK_RM = 'rm -rf "${HOME}/.cache/ios-fleet/archive.lockdir"';

function workflowSteps(workflow) {
  return workflow.split(/- name:/);
}

function stepNamed(steps, name) {
  return steps.findIndex((step) => step.startsWith(` ${name}\n`) || step.startsWith(` ${name}\r`));
}

function runScript(step) {
  const marker = "run: |";
  const at = step.indexOf(marker);
  assert.ok(at >= 0, "step is missing a run block");
  const lines = step.slice(at + marker.length).split("\n");
  const body = [];
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === "") {
      body.push("");
      continue;
    }
    if (!/^ {10}/.test(line)) break;
    body.push(line.slice(10));
  }
  return `${body.join("\n").trimEnd()}\n`;
}

function runClear(script, home, runId) {
  return spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, GITHUB_RUN_ID: runId },
  });
}

function makeLock(home) {
  const lockdir = join(home, ".cache", "ios-fleet", "archive.lockdir");
  mkdirSync(lockdir, { recursive: true });
  return lockdir;
}

test("ios-ship clears a stale archive lock before acquire and before cache save", () => {
  const workflow = readFileSync(join(here, "../../.github/workflows/ios-ship.yml"), "utf8");
  const steps = workflowSteps(workflow);
  const restore = stepNamed(steps, "Restore iOS ship state");
  const clear = stepNamed(steps, "Clear stale archive lock from ship-state cache");
  const ship = stepNamed(steps, "Ship SocraticTrade to TestFlight");
  const removeBeforeSave = stepNamed(steps, "Remove archive lock before saving ship-state cache");
  const save = stepNamed(steps, "Save iOS ship state");

  assert.ok(restore >= 0, "restore step exists");
  assert.equal(clear, restore + 1, "lock clear runs immediately after cache restore");
  assert.ok(ship > clear, "the lock is cleared before Ship SocraticTrade acquires it");
  assert.ok(removeBeforeSave > ship, "the pre-save removal runs after the ship step");
  assert.equal(save, removeBeforeSave + 1, "the archive lock is removed immediately before the cache save");

  assert.match(workflow, /timeout-minutes: 90/);
  assert.match(steps[clear], /kill -0/);
  assert.match(steps[clear], /GITHUB_RUN_ID/);
  assert.match(steps[clear], /-mmin \+90/);
  assert.ok(steps[clear].includes(LOCK_RM), "the lock-clear step removes archive.lockdir");
  assert.match(steps[clear], /if \[ ! -e /);

  assert.match(steps[removeBeforeSave], /if: always\(\)/);
  assert.ok(steps[removeBeforeSave].includes(LOCK_RM), "the archive lock is removed before the ship-state cache is saved");

  const clearScript = runScript(steps[clear]);
  const saveScript = runScript(steps[removeBeforeSave]);
  const runId = "424242";
  const home = mkdtempSync(join(tmpdir(), "stale-archive-lock-"));
  const child = spawn("sleep", ["60"], { stdio: "ignore" });
  try {
    assert.ok(child.pid > 1, "sleep started");
    for (let i = 0; i < 50 && spawnSync("kill", ["-0", String(child.pid)]).status !== 0; i += 1) {
      spawnSync("sleep", ["0.02"]);
    }
    assert.equal(spawnSync("kill", ["-0", String(child.pid)]).status, 0, "owner pid is alive");

    const absent = runClear(clearScript, home, runId);
    assert.equal(absent.status, 0, absent.stderr);
    assert.match(absent.stdout, /No stale archive lock found/);

    const empty = makeLock(home);
    const emptyRun = runClear(clearScript, home, runId);
    assert.equal(emptyRun.status, 0, emptyRun.stderr);
    assert.match(emptyRun.stdout, /owner pid is gone/);
    assert.match(emptyRun.stdout, /owner run is gone/);
    assert.equal(existsSync(empty), false, "a restored lock with no owner is removed before acquire");

    const dead = makeLock(home);
    writeFileSync(join(dead, "owner.pid"), "2147483646");
    writeFileSync(join(dead, "owner.run"), runId);
    assert.notEqual(spawnSync("kill", ["-0", "2147483646"]).status, 0);
    const deadRun = runClear(clearScript, home, runId);
    assert.equal(deadRun.status, 0, deadRun.stderr);
    assert.match(deadRun.stdout, /owner pid is gone/);
    assert.equal(existsSync(dead), false, "a lock whose owner pid is gone is removed");

    const otherRun = makeLock(home);
    writeFileSync(join(otherRun, "owner.pid"), String(child.pid));
    writeFileSync(join(otherRun, "owner.run"), "111");
    const other = runClear(clearScript, home, runId);
    assert.equal(other.status, 0, other.stderr);
    assert.match(other.stdout, /owner run is gone/);
    assert.doesNotMatch(other.stdout, /owner pid is gone/);
    assert.equal(existsSync(otherRun), false, "a lock whose owner run is gone is removed");

    const old = makeLock(home);
    writeFileSync(join(old, "owner.pid"), String(child.pid));
    writeFileSync(join(old, "owner.run"), runId);
    const ago = new Date(Date.now() - 91 * 60 * 1000);
    utimesSync(old, ago, ago);
    const oldRun = runClear(clearScript, home, runId);
    assert.equal(oldRun.status, 0, oldRun.stderr);
    assert.match(oldRun.stdout, /older than 90 minutes/);
    assert.doesNotMatch(oldRun.stdout, /owner pid is gone/);
    assert.doesNotMatch(oldRun.stdout, /owner run is gone/);
    assert.equal(existsSync(old), false, "a lock older than the job timeout is removed");

    const live = makeLock(home);
    writeFileSync(join(live, "owner.pid"), String(child.pid));
    writeFileSync(join(live, "owner.run"), runId);
    const liveRun = runClear(clearScript, home, runId);
    assert.equal(liveRun.status, 0, liveRun.stderr);
    assert.match(liveRun.stdout, /held by pid/);
    assert.equal(existsSync(live), true, "a lock held by this run's live pid is kept");

    const saved = runClear(saveScript, home, runId);
    assert.equal(saved.status, 0, saved.stderr);
    assert.equal(existsSync(live), false, "the pre-save step removes the lock so the cache cannot restore it");
  } finally {
    child.kill("SIGKILL");
    rmSync(home, { recursive: true, force: true });
  }
});
