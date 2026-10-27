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

test("the published document keeps exactly one trailing newline", () => {
  const { dir, base, out } = fixture("afc-ios-versions-newline-", FLEET);
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
  // The merge runs inside a command substitution, and a command substitution
  // strips trailing newlines.  The write has to put one back, or the file
  // lands in the repository without its final newline and every later commit
  // shows a spurious "no newline at end of file" line.
  const raw = readFileSync(out, "utf8");
  assert.ok(raw.endsWith("\n"), "the manifest must end with a newline");
  assert.ok(!raw.endsWith("\n\n"), "the manifest must end with exactly one newline");
  rmSync(dir, { recursive: true, force: true });
});

test("the manifest target is the org repository the apps read", () => {
  const src = readFileSync(SCRIPT, "utf8");
  assert.match(src, /Simple-With-Us\/AI-Fleet-Coordinator/);
  assert.match(src, /site\/ios-versions\.json/);
});

test("placeholder (from IPA) versions are refused before any publish", () => {
  const { dir, base } = fixture("afc-ios-versions-placeholder-", FLEET);
  const res = run(
    [
      "--bundle-id",
      "com.socratictrade.ios",
      "--version",
      "(from IPA)",
      "--build",
      "(from IPA)",
      "--base-json",
      base,
      "--skip-local-write",
      "--skip-push",
    ],
    { GH_TOKEN: "", GITHUB_TOKEN: "" },
  );
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /placeholder/i);
  rmSync(dir, { recursive: true, force: true });
});

test("no-op comparison runs before any write to LOCAL_JSON", () => {
  // Regression: when the remote fetch fails, BASE_JSON is LOCAL_JSON.  Writing
  // MERGED before the comparison made every publish look like a no-op.
  const src = readFileSync(SCRIPT, "utf8");
  const noopIdx = src.indexOf("NEED_PUBLISH");
  const writeIdx = src.indexOf('printf \'%s\\n\' "$MERGED" >"$LOCAL_JSON"');
  assert.ok(noopIdx > 0, "no-op gate must exist");
  assert.ok(writeIdx > 0, "local write must exist");
  assert.ok(noopIdx < writeIdx, "no-op gate must run before LOCAL_JSON is overwritten");
  const doc = JSON.parse(JSON.stringify(FLEET));
  doc.apps["com.socratictrade.ios"].build = "202608250045";
  const { dir, base, out } = fixture("afc-ios-versions-localbase-", doc);
  // Same version+build is a no-op even when we would have written LOCAL_JSON.
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
      "--out-json",
      out,
      "--skip-local-write",
    ],
    { GH_TOKEN: "", GITHUB_TOKEN: "" },
  );
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.match(res.stdout, /already recorded/);
  rmSync(dir, { recursive: true, force: true });
});

test("appleId or displayName drift is not a no-op", () => {
  const doc = JSON.parse(JSON.stringify(FLEET));
  doc.apps["com.socratictrade.ios"].build = "202608250045";
  const { dir, base } = fixture("afc-ios-versions-meta-", doc);
  const res = run(
    [
      "--bundle-id",
      "com.socratictrade.ios",
      "--version",
      "1.0.68",
      "--build",
      "202608250045",
      "--apple-id",
      "9999999999",
      "--display-name",
      "Socratic-Trade-Renamed",
      "--base-json",
      base,
      "--skip-local-write",
    ],
    { GH_TOKEN: "", GITHUB_TOKEN: "ghs_notarealtoken" },
  );
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /GITHUB_TOKEN cannot write to/);
  rmSync(dir, { recursive: true, force: true });
});

test("publish requires GH_TOKEN and never falls back to stored gh credentials", () => {
  const src = readFileSync(SCRIPT, "utf8");
  assert.match(src, /stored gh credentials are not an approved secret source/);
  assert.doesNotMatch(src, /TOKEN_SOURCE="gh-auth"/);
  const { dir, base } = fixture("afc-ios-versions-no-token-", FLEET);
  const res = run(
    ["--bundle-id", "com.socratictrade.ios", "--version", "1.0.69", "--base-json", base, "--skip-local-write"],
    { GH_TOKEN: "", GITHUB_TOKEN: "" },
  );
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /GH_TOKEN is required/);
  rmSync(dir, { recursive: true, force: true });
});

test("pull-request publish re-seeds at the branch tip before the contents PUT", () => {
  // Differential control: the previous direct-write path never re-read the
  // tip.  The PR path must fetch_remote_json_at BASE_SHA before PUT so a
  // concurrent manifest update on main is not rolled back.
  const src = readFileSync(SCRIPT, "utf8");
  assert.match(src, /fetch_remote_json_at/);
  assert.match(src, /refusing to publish a pre-branch snapshot/);
  assert.match(src, /refusing to publish from the local snapshot/);
  assert.match(src, /--method PUT/);
  assert.match(src, /-f branch="\$\{PR_BRANCH\}"/);
  assert.match(src, /gh pr merge/);
});

test("mocked branch-tip race has a stale control and publishes identical final output", () => {
  const {dir,base,out}=fixture("tip-race-",FLEET);
  const tip=structuredClone(FLEET); tip.apps["net.dealdex"].build="new-sibling";
  const payload=join(dir,"put.json"); const calls=join(dir,"calls");
  writeFileSync(join(dir,"gh"),`#!/usr/bin/env python3
import sys,os,json,base64
args=sys.argv[1:]; text=' '.join(args)
with open(os.environ['MOCK_CALLS'],'a') as f:f.write(text+'\\n')
if 'content=' in text:
 raw=next(a[8:] for a in args if a.startswith('content='))
 open(os.environ['MOCK_PUT'],'wb').write(base64.b64decode(raw))
elif '/contents/' in text and '--jq .content' in text:
 doc=json.loads(os.environ['MOCK_TIP'] if 'ref=tip-sha' in text else os.environ['MOCK_STALE'])
 print(base64.b64encode(json.dumps(doc).encode()).decode())
elif '/git/ref/heads/main' in text:print('tip-sha')
elif '/git/ref/heads/ios-' in text:sys.exit(1)
elif '/contents/' in text:print('file-sha')
elif '/pulls?' in text:print('null')
elif '/pulls' in text and 'POST' in text:print('https://github.com/example/repo/pull/1')
`,{mode:0o755});
  const env={PATH:dir+":"+process.env.PATH,GH_TOKEN:"test-only",GITHUB_TOKEN:"",MOCK_CALLS:calls,MOCK_PUT:payload,MOCK_STALE:JSON.stringify(FLEET),MOCK_TIP:JSON.stringify(tip),IOS_VERSIONS_AUTO_MERGE:"0"};
  // Control proves mock's first fetch is stale and would lose sibling history.
  const control=spawnSync(join(dir,"gh"),["api","repos/x/contents/site/ios-versions.json?ref=main","--jq",".content"],{env:{...process.env,...env},encoding:"utf8"});
  assert.equal(JSON.parse(Buffer.from(control.stdout.trim(),"base64")).apps["net.dealdex"].build,FLEET.apps["net.dealdex"].build);
  const res=run(["--bundle-id","com.socratictrade.ios","--version","1.0.69","--out-json",out,"--skip-local-write"],env);
  assert.equal(res.status,0,res.stderr);
  const uploaded=JSON.parse(readFileSync(payload,"utf8"));
  assert.equal(uploaded.apps["net.dealdex"].build,"new-sibling");
  assert.deepEqual(JSON.parse(readFileSync(out,"utf8")),uploaded);
  const oldCount=readFileSync(calls,"utf8").split('\n').length;
  for(const args of [["--version","(from IPA)"],["--version","1.0.69","--build","(from IPA)"]]) {
    assert.notEqual(run(["--bundle-id","com.socratictrade.ios",...args],env).status,0);
    assert.equal(readFileSync(calls,"utf8").split('\n').length,oldCount,"placeholder cannot reach mock network");
  }
  rmSync(dir,{recursive:true,force:true});
});

test("no-op with empty middle fields preserves timestamp and exact bytes",()=>{
 const doc=structuredClone(FLEET);const {dir,base,out}=fixture("empty-middle-",doc);
 const res=run(["--bundle-id","com.socratictrade.ios","--version","1.0.68","--display-name","Socratic-Trade","--base-json",base,"--out-json",out,"--skip-push","--skip-local-write"],{GH_TOKEN:"",GITHUB_TOKEN:""});
 assert.equal(res.status,0,res.stderr);assert.match(res.stdout,/already recorded/);
 assert.equal(readFileSync(out,"utf8"),readFileSync(base,"utf8"));
 rmSync(dir,{recursive:true,force:true});
});


test("legacy numeric string appleId compares equal and invalid CLI id fails clearly",()=>{
 const doc=structuredClone(FLEET);doc.apps["com.socratictrade.ios"].appleId="6799238379";
 const {dir,base,out}=fixture("legacy-apple-",doc);
 const args=["--bundle-id","com.socratictrade.ios","--version","1.0.68","--base-json",base,"--out-json",out,"--skip-local-write","--skip-push"];
 const ok=run([...args,"--apple-id","6799238379"]);
 assert.equal(ok.status,0,ok.stderr);assert.match(ok.stdout,/already recorded/);
 const bad=run([...args,"--apple-id","legacy-name"]);
 assert.equal(bad.status,2);assert.match(bad.stderr,/must be numeric/);assert.doesNotMatch(bad.stderr,/Traceback/);
 rmSync(dir,{recursive:true,force:true});
