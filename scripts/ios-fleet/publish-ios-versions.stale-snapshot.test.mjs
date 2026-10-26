// Socratic-Trade's own addition to the shared publisher contract.
//
// The shared contract lives in `publish-ios-versions.test.mjs` and is copied
// byte-identically into every repo that ships, so a copy that drifts is
// visible.  This file holds the assertions that are specific to this repo:
// the vendored `ios-app-versions.json` here is a stale snapshot, and
// publishing from it would drop fleet apps.
//
// Do not read the live `ios-app-versions.json` for the fixture:  later ships
// refresh that file, and GitHub's `pull_request` merge commit then fails a
// pin on yesterday's keys.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(ROOT, "scripts/ios-fleet/publish-ios-versions.sh");

function run(args, env = {}) {
  return spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
}

// The 2026-08-21 vendored snapshot (before #3102 added net.dealdex).
const STALE_SNAPSHOT = {
  schemaVersion: 1,
  updatedAt: "2026-08-21T19:00:00Z",
  apps: {
    "com.socratictrade.ios": {
      displayName: "Socratic-Trade",
      marketingVersion: "1.0.68",
      appleId: 6799238379,
    },
    "trade.congress.ios": {
      displayName: "Congress.Trade",
      marketingVersion: "1.0.80",
      appleId: 6798076688,
    },
    "services.jays.usage.client.monitor": {
      displayName: "Usage Client Monitor",
      marketingVersion: "1.0.8",
      appleId: 6799230435,
    },
    "services.jays.usage.local.monitor": {
      displayName: "Usage Local Monitor",
      marketingVersion: "1.0.7",
      appleId: 6799230729,
    },
    "online.dealdex": {
      displayName: "DealDex",
      marketingVersion: "1.0.1",
      appleId: 6802474288,
    },
    "codes.autorotate": {
      displayName: "Autorotate",
      marketingVersion: "1.0.1",
    },
  },
};

test("publishing from a stale snapshot omits later fleet apps", () => {
  const dir = mkdtempSync(join(tmpdir(), "st-ios-versions-stale-"));
  const base = join(dir, "stale.json");
  const out = join(dir, "out.json");
  writeFileSync(base, JSON.stringify(STALE_SNAPSHOT, null, 2) + "\n");
  const res = run([
    "--bundle-id",
    "com.socratictrade.ios",
    "--version",
    "1.0.69",
    "--base-json",
    base,
    "--out-json",
    out,
    "--skip-push",
    "--skip-local-write",
  ]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const merged = JSON.parse(readFileSync(out, "utf8"));
  assert.ok(!merged.apps["net.dealdex"], "stale base must not invent later fleet keys");
  assert.equal(merged.apps["services.jays.usage.client.monitor"].marketingVersion, "1.0.8");
  assert.equal(merged.apps["services.jays.usage.local.monitor"].marketingVersion, "1.0.7");
  assert.equal(merged.apps["codes.autorotate"].marketingVersion, "1.0.1");
  assert.equal(merged.apps["com.socratictrade.ios"].marketingVersion, "1.0.69");
  rmSync(dir, { recursive: true, force: true });
});

test("the merge keeps every sibling the base already carried", () => {
  const dir = mkdtempSync(join(tmpdir(), "st-ios-versions-siblings-"));
  const base = join(dir, "remote.json");
  const out = join(dir, "out.json");
  writeFileSync(base, JSON.stringify(STALE_SNAPSHOT, null, 2) + "\n");
  const res = run([
    "--bundle-id",
    "com.socratictrade.ios",
    "--version",
    "1.0.69",
    "--build",
    "202608250045",
    "--base-json",
    base,
    "--out-json",
    out,
    "--skip-push",
    "--skip-local-write",
  ]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const merged = JSON.parse(readFileSync(out, "utf8"));
  assert.deepEqual(Object.keys(merged.apps).sort(), Object.keys(STALE_SNAPSHOT.apps).sort());
  assert.equal(merged.apps["com.socratictrade.ios"].build, "202608250045");
  rmSync(dir, { recursive: true, force: true });
});
