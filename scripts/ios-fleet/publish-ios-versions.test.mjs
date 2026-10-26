import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(ROOT, "scripts/ios-fleet/publish-ios-versions.sh");

const FLEET = {
  schemaVersion: 1,
  updatedAt: "2026-08-24T07:44:52Z",
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
    "net.dealdex": {
      marketingVersion: "1.0.2",
      build: "202608230250",
      appleId: 6802474288,
      displayName: "DealDex",
    },
  },
};

function run(args, env = {}) {
  return spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
}

function fixture(name, doc) {
  const dir = mkdtempSync(join(tmpdir(), name));
  const base = join(dir, "remote.json");
  const out = join(dir, "out.json");
  writeFileSync(base, JSON.stringify(doc, null, 2) + "\n");
  return { dir, base, out };
}

test("merge onto a multi-app remote keeps every sibling", () => {
  const { dir, base, out } = fixture("afc-ios-versions-", FLEET);
  const res = run([
    "--bundle-id",
    "com.socratictrade.ios",
    "--version",
    "1.0.69",
    "--build",
    "202608250045",
    "--apple-id",
    "6799238379",
    "--display-name",
    "Socratic-Trade",
    "--base-json",
    base,
    "--out-json",
    out,
    "--skip-push",
    "--skip-local-write",
  ]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const merged = JSON.parse(readFileSync(out, "utf8"));
  assert.deepEqual(Object.keys(merged.apps).sort(), Object.keys(FLEET.apps).sort());
  assert.equal(merged.apps["com.socratictrade.ios"].marketingVersion, "1.0.69");
  assert.equal(merged.apps["com.socratictrade.ios"].build, "202608250045");
  assert.equal(merged.apps["net.dealdex"].marketingVersion, "1.0.2");
  assert.equal(merged.apps["trade.congress.ios"].marketingVersion, "1.0.80");
  rmSync(dir, { recursive: true, force: true });
});

test("empty base is refused so a missing local file cannot wipe the fleet", () => {
  const { dir, base, out } = fixture("afc-ios-versions-empty-", { schemaVersion: 1, apps: {} });
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
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /no apps|refusing/i);
  rmSync(dir, { recursive: true, force: true });
});

test("a single-app base stays a single-app document", () => {
  const { dir, base, out } = fixture("afc-ios-versions-one-app-", {
    schemaVersion: 1,
    apps: { "com.socratictrade.ios": { marketingVersion: "1.0.68" } },
  });
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
  // A single-app base is a one-app remote, so one app stays one app:  the
  // refusal is about the merged document shrinking a multi-app remote.
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const merged = JSON.parse(readFileSync(out, "utf8"));
  assert.deepEqual(Object.keys(merged.apps), ["com.socratictrade.ios"]);
  rmSync(dir, { recursive: true, force: true });
});

test("a version and build the remote already records is a no-op", () => {
  const doc = JSON.parse(JSON.stringify(FLEET));
  doc.apps["com.socratictrade.ios"].build = "202608250045";
  const { dir, base } = fixture("afc-ios-versions-noop-", doc);
  const res = run(
    [
      "--bundle-id",
      "com.socratictrade.ios",
      "--version",
      "1.0.68",
      "--build",
      "202608250045",
      "--base-json",
      base,
      "--skip-local-write",
    ],
    { GH_TOKEN: "", GITHUB_TOKEN: "" },
  );
  // The check runs before the credential is resolved, so a ship with nothing
  // to publish needs no token, reaches no network, and leaves no pull request.
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.match(res.stdout, /already recorded/);
  assert.doesNotMatch(res.stdout, /pull/);
  rmSync(dir, { recursive: true, force: true });
});

test("the same version with a new build is NOT a no-op", () => {
  const doc = JSON.parse(JSON.stringify(FLEET));
  doc.apps["com.socratictrade.ios"].build = "202608250045";
  const { dir, base } = fixture("afc-ios-versions-newbuild-", doc);
  const res = run(
    [
      "--bundle-id",
      "com.socratictrade.ios",
      "--version",
      "1.0.68",
      "--build",
      "202608259999",
      "--base-json",
      base,
      "--skip-local-write",
    ],
    { GH_TOKEN: "", GITHUB_TOKEN: "ghs_notarealtoken" },
  );
  // It got past the no-op check and reached the credential, which is refused.
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /GITHUB_TOKEN cannot write to/);
  rmSync(dir, { recursive: true, force: true });
});

test("the publish never writes to the default branch", () => {
  const src = readFileSync(SCRIPT, "utf8");
  // Every contents write names the publish branch, so no write can land on
  // the default branch:  a ruleset with required status checks refuses that.
  const putCount = (src.match(/--method PUT/g) || []).length;
  const branchCount = (src.match(/-f branch="\$\{PR_BRANCH\}"/g) || []).length;
  assert.ok(putCount >= 1, "the script writes the document with a contents PUT");
  assert.equal(putCount, branchCount, "every contents write names the publish branch");
  assert.match(src, /git\/refs\/heads\//);
  assert.match(src, /--method POST\s+"repos\/\$\{REPO\}\/pulls"/);
  assert.match(src, /repos\/\$\{REPO\}\/pulls\?head=/);
});

test("the publish refuses the workflow's own read-only GITHUB_TOKEN", () => {
  const src = readFileSync(SCRIPT, "utf8");
  assert.match(src, /GITHUB_TOKEN cannot write to/);
  const { dir, base } = fixture("afc-ios-versions-token-", FLEET);
  const res = run(
    ["--bundle-id", "com.socratictrade.ios", "--version", "1.0.69", "--base-json", base, "--skip-local-write"],
    { GITHUB_TOKEN: "ghs_notarealtoken", GH_TOKEN: "" },
  );
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /GITHUB_TOKEN cannot write to/);
  rmSync(dir, { recursive: true, force: true });
});

test("the publish reads the live remote and refuses an empty apps map", () => {
  const src = readFileSync(SCRIPT, "utf8");
  assert.match(src, /fetch_remote_json/);
  assert.match(src, /refusing to publish an empty apps map/);
  assert.match(src, /--skip-push/);
  assert.doesNotMatch(src, /data = \{"schemaVersion": 1, "apps": \{\}\}/);
});

test("the manifest target is the org repository the apps read", () => {
  const src = readFileSync(SCRIPT, "utf8");
  assert.match(src, /Simple-With-Us\/AI-Fleet-Coordinator/);
  assert.match(src, /site\/ios-versions\.json/);
});
