// Socratic Trade Release signs MANUALLY with an App Store profile installed over
// the App Store Connect REST API, because Xcode 26 automatic signing calls
// developerservices2.apple.com and the fleet API key gets HTTP 401 there.
// See docs/rollouts/2026-09-30-st-ios-first-ship.md.
//
// The ship script never runs `xcodegen generate` on CI, so the CHECKED-IN
// project.pbxproj is what TestFlight archives.  These tests pin project.yml,
// the generated pbxproj, the profile map, and the entitlements to each other,
// and drive ship-testflight.sh against a stub xcodebuild to prove manual mode
// never asks Xcode's provisioning service for anything.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const repo = process.cwd();
const read = (p: string) => readFileSync(resolve(repo, p), "utf8");

const projectYml = read("ios/project.yml");
const pbxproj = read("ios/Socratic Trade.xcodeproj/project.pbxproj");
const entitlements = read("ios/SocraticTrade/SocraticTrade.entitlements");
const profileMap = JSON.parse(read("ios/appstore-profiles.json")) as Record<string, string>;
const workflow = read(".github/workflows/ios-ship.yml");
const installer = read("scripts/ios-install-appstore-profiles.sh");
const PROFILE = "Socratic Trade App Store (API) 2";

/** Build-settings blocks of the app target's XCBuildConfigurations, keyed by name. */
function appTargetConfigs(): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /isa = XCBuildConfiguration;\s*buildSettings = \{([\s\S]*?)\n\t\t\t\};\s*name = (\w+);/g;
  for (const m of pbxproj.matchAll(re)) {
    if (m[1].includes("PRODUCT_BUNDLE_IDENTIFIER = com.socratictrade.ios;")) out[m[2]] = m[1];
  }
  return out;
}

describe("Socratic Trade manual Release signing: config agreement", () => {
  it("maps the bundle to exactly one App Store profile", () => {
    expect(profileMap).toEqual({ "com.socratictrade.ios": PROFILE });
  });

  it("project.yml Release config is Manual + Apple Distribution + the mapped profile", () => {
    expect(projectYml).toMatch(/configs:\s*\n\s*Release:\s*\n\s*CODE_SIGN_STYLE: Manual/);
    expect(projectYml).toContain('CODE_SIGN_IDENTITY: "Apple Distribution"');
    expect(projectYml).toContain(`PROVISIONING_PROFILE_SPECIFIER: "${PROFILE}"`);
  });

  it("the checked-in pbxproj matches project.yml (the ship does not regenerate it)", () => {
    const configs = appTargetConfigs();
    expect(Object.keys(configs).sort()).toEqual(["Debug", "Release"]);
    expect(configs.Release).toContain("CODE_SIGN_STYLE = Manual;");
    expect(configs.Release).toContain('CODE_SIGN_IDENTITY = "Apple Distribution";');
    expect(configs.Release).toContain(`PROVISIONING_PROFILE_SPECIFIER = "${PROFILE}";`);
    // Debug stays Automatic for a logged-in Xcode session.
    expect(configs.Debug).toContain("CODE_SIGN_STYLE = Automatic;");
    expect(configs.Debug).not.toContain("PROVISIONING_PROFILE_SPECIFIER");
  });

  it("requests no App Group: the App Store profile's application-groups list is empty", () => {
    expect(entitlements).not.toContain("com.apple.security.application-groups");
    expect(projectYml).not.toMatch(/^\s*com\.apple\.security\.application-groups:/m);
    // Everything the profile does grant is still requested.
    expect(entitlements).toMatch(/<key>aps-environment<\/key>\s*<string>production<\/string>/);
    expect(entitlements).toContain("com.apple.developer.applesignin");
    for (const d of ["applinks:socratictrade.com", "applinks:socratic.trade", "webcredentials:socratic.trade"]) {
      expect(entitlements).toContain(d);
    }
  });

  it("no Swift code reads an App Group container, so dropping the entitlement is safe", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".swift")) {
          const src = readFileSync(p, "utf8");
          if (/suiteName:|forSecurityApplicationGroupIdentifier|group\.com\.socratictrade/.test(src)) hits.push(p);
        }
      }
    };
    walk(resolve(repo, "ios/SocraticTrade"));
    expect(hits).toEqual([]);
  });

  it("ios-ship.yml turns manual signing on and watches the installer", () => {
    expect(workflow).toMatch(/IOS_MANUAL_SIGN: "1"/);
    expect(workflow).toContain("'scripts/ios-install-appstore-profiles.sh'");
  });

  it("ios-ship.yml loads SENTRY_DSN from Infisical prod (never hardcoded)", () => {
    expect(workflow).toContain("infisical secrets get SENTRY_DSN");
    expect(workflow).toContain("SENTRY_DSN: ${{ secrets.SENTRY_DSN }}");
    expect(workflow).not.toMatch(/https:\/\/[a-z0-9]+@o\d+\.ingest/);
  });

  it("Sentry.xcconfig substitutes SENTRY_DSN and project.yml does not pin it empty", () => {
    const xcconfig = readFileSync(resolve(repo, "ios/Config/Sentry.xcconfig"), "utf8");
    const project = readFileSync(resolve(repo, "ios/project.yml"), "utf8");
    expect(xcconfig).toContain("SENTRY_DSN = $(SENTRY_DSN)");
    expect(xcconfig).not.toMatch(/https:\/\//);
    expect(project).toContain("Config/Sentry.xcconfig");
    expect(project).not.toMatch(/SENTRY_DSN:\s*""/);
    expect(project).not.toMatch(/https:\/\/[a-z0-9]+@/);
    expect(workflow).toContain('ver="2.46.0"');
    expect(workflow).toContain("yonaskolb/XcodeGen/releases/download/${ver}/xcodegen.zip");
  });

  it("the installer reads the same map and fails closed on the wrong profile", () => {
    expect(installer).toContain("ios/appstore-profiles.json");
    expect(installer).toContain("get-task-allow");
    expect(installer).toContain('profileState") == "ACTIVE"');
    expect(installer).not.toMatch(/\bprint\([^)]*profileContent/);
  });

  it("never points asc-api at a ~/.secrets handoff file (AFC-359)", () => {
    expect(installer).not.toContain("ASC_SECRETS_ENV");
    expect(installer).not.toContain(".secrets");
  });
});

// ---------------------------------------------------------------------------
// Behaviour: drive the real fleet script against a stub xcodebuild.
// ---------------------------------------------------------------------------
const work = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "st-manual-sign-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

function sandbox(name: string, opts: { withMap: boolean }) {
  const root = join(work, name);
  const bin = join(root, "bin");
  const home = join(root, "home");
  const state = join(root, "state");
  const fakeRepo = join(root, "repo");
  const log = join(root, "xcodebuild.log");
  for (const d of [bin, home, state, join(root, "tmp"), join(fakeRepo, "ios", "Socratic Trade.xcodeproj")]) {
    mkdirSync(d, { recursive: true });
  }
  if (opts.withMap) cpSync(resolve(repo, "ios/appstore-profiles.json"), join(fakeRepo, "ios/appstore-profiles.json"));
  writeFileSync(join(fakeRepo, "README"), "seed\n");
  const git = (...args: string[]) => spawnSync("git", ["-C", fakeRepo, ...args], { encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "manual sign test");
  git("add", ".");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "seed");

  writeFileSync(
    join(bin, "xcodebuild"),
    `#!/usr/bin/env bash
if [[ "\${1:-}" == "-version" ]]; then echo "Xcode 26.6"; echo "Build version 17F113"; exit 0; fi
printf 'CALL %s\\n' "$*" >>"${log}"
prev=""; arch=""; exp=""; opts=""
for a in "$@"; do
  case "$prev" in -archivePath) arch="$a" ;; -exportPath) exp="$a" ;; -exportOptionsPlist) opts="$a" ;; esac
  prev="$a"
done
if [[ "$1" == "archive" ]]; then mkdir -p "$arch/Products/Applications/Socratic Trade.app"; exit 0; fi
if [[ "$1" == "-exportArchive" ]]; then
  printf 'OPTS %s\\n' "$(tr -d '\\n\\t' <"$opts")" >>"${log}"
  mkdir -p "$exp"; : >"$exp/Socratic Trade.ipa"; exit 0
fi
exit 99
`,
  );
  chmodSync(join(bin, "xcodebuild"), 0o755);
  // ASC API stub via IOS_FLEET_NODE only — do not shadow real `node` on PATH.
  // Bare node must stay real so load_secrets can run asc-key.mjs validate.
  const ascNode = join(bin, "asc-node-stub");
  const ascStubLines = [
    "#!/usr/bin/env bash",
    'cmd=""',
    'for a in "$@"; do',
    '  case "$a" in',
    '    */asc-api.mjs) cmd="asc-api" ;;',
    "    latest-marketing-patch|build-floor|released-store-version|next-shared-build)",
    '      if [[ "$cmd" == "asc-api" ]]; then cmd="${cmd}:${a}"; fi',
    "      ;;",
    "  esac",
    "done",
    'case "$cmd" in',
    '  asc-api:latest-marketing-patch) printf \'%s\\n\' "${FAKE_ASC_PATCH:-0}"; exit 0 ;;',
    "  asc-api:released-store-version)",
    '    [[ "${FAKE_RELEASED:-}" == "fail" ]] && exit 2',
    '    printf \'%s\\n\' "${FAKE_RELEASED:-}"',
    "    exit 0",
    "    ;;",
    "  asc-api:next-shared-build)",
    '    [[ -n "${FAKE_SHARED:-}" ]] || exit 2',
    '    printf \'%s\\n\' "${FAKE_SHARED}"',
    "    exit 0",
    "    ;;",
    '  asc-api:build-floor) printf \'%s\\n\' "${FAKE_ASC_FLOOR:-0}"; exit 0 ;;',
    "esac",
    "exit 2",
    "",
  ];
  writeFileSync(ascNode, ascStubLines.join("\n"));
  chmodSync(ascNode, 0o755);
  writeFileSync(join(bin, "fleet-secrets"), "#!/usr/bin/env bash\nexit 3\n");
  chmodSync(join(bin, "fleet-secrets"), 0o755);
  // Ephemeral EC P-256 key so asc-key.mjs validate accepts ASC_KEY_P8.
  const ascKeyP8 = execFileSync(
    "openssl",
    ["genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256"],
    { encoding: "utf8" },
  );
  const installerStub = join(root, "install-stub.sh");
  writeFileSync(installerStub, `#!/usr/bin/env bash\nprintf 'INSTALL map=%s\\n' "$IOS_APPSTORE_PROFILES_MAP" >>"${log}"\n`);
  chmodSync(installerStub, 0o755);
  return { root, bin, home, state, fakeRepo, log, installerStub, ascNode, ascKeyP8 };
}

function ship(sb: ReturnType<typeof sandbox>, extraEnv: Record<string, string>) {
  const nodeDir = resolve(process.execPath, "..");
  const res = spawnSync(
    "bash",
    [
      resolve(repo, "scripts/ios-fleet/ship-testflight.sh"),
      "socratic",
      "--repo-root", sb.fakeRepo,
      "--export-only", "--skip-xcodegen", "--allow-unverified-seq", "--force-ship",
    ],
    {
      encoding: "utf8",
      env: {
        NODE_ENV: "test",
        HOME: sb.home,
        PATH: `${sb.bin}:${nodeDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
        TMPDIR: join(sb.root, "tmp"),
        IOS_FLEET_STATE_DIR: sb.state,
        IOS_INSTALL_PROFILES_SCRIPT: sb.installerStub,
        IOS_FLEET_NODE: sb.ascNode,
        FLEET_SECRETS: join(sb.bin, "fleet-secrets"),
        ASC_KEY_ID: "fakekeyid",
        ASC_ISSUER_ID: "fakeissuerid",
        ASC_KEY_P8: sb.ascKeyP8,
        // Empty released train + shared four-digit build for apps.json fixedMarketingVersion 0.1.0.
        FAKE_RELEASED: "",
        FAKE_SHARED: "1000",
        FAKE_ASC_PATCH: "0",
        FAKE_ASC_FLOOR: "0",
        ...extraEnv,
      },
      timeout: 60_000,
    },
  );
  const log = existsSync(sb.log) ? readFileSync(sb.log, "utf8") : "";
  return { status: res.status, out: `${res.stdout}${res.stderr}`, log };
}

describe("ship-testflight.sh manual signing (stub xcodebuild)", () => {
  it("default for socratic: installs profiles, archives with no provisioning or auth flags, exports manually", () => {
    const sb = sandbox("manual", { withMap: true });
    const r = ship(sb, {});
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("manual App Store signing");
    expect(r.log).toContain(`INSTALL map=${join(sb.fakeRepo, "ios/appstore-profiles.json")}`);
    const archive = r.log.split("\n").find((l) => l.startsWith("CALL archive")) ?? "";
    expect(archive).toContain("-configuration Release");
    expect(archive).not.toContain("-allowProvisioningUpdates");
    expect(archive).not.toContain("-allowProvisioningDeviceRegistration");
    expect(archive).not.toContain("-authenticationKey");
    expect(archive).not.toContain("CODE_SIGN_STYLE=");
    expect(archive).not.toContain("PROVISIONING_PROFILE_SPECIFIER=");
    const exp = r.log.split("\n").find((l) => l.startsWith("CALL -exportArchive")) ?? "";
    expect(exp).not.toContain("-allowProvisioningUpdates");
    const opts = r.log.split("\n").find((l) => l.startsWith("OPTS ")) ?? "";
    expect(opts).toContain("<key>signingStyle</key><string>manual</string>");
    expect(opts).toContain("<key>signingCertificate</key><string>Apple Distribution</string>");
    expect(opts).toContain(`<key>com.socratictrade.ios</key><string>${PROFILE}</string>`);
    expect(opts).toContain("<key>destination</key><string>export</string>");
  });

  it("IOS_MANUAL_SIGN=0 keeps the automatic path for other apps", () => {
    const sb = sandbox("auto", { withMap: true });
    const r = ship(sb, { IOS_MANUAL_SIGN: "0" });
    expect(r.status, r.out).toBe(0);
    expect(r.log).not.toContain("INSTALL ");
    const archive = r.log.split("\n").find((l) => l.startsWith("CALL archive")) ?? "";
    expect(archive).toContain("-allowProvisioningUpdates");
    expect(archive).toContain("CODE_SIGN_STYLE=Automatic");
  });

  it("IOS_MANUAL_SIGN=1 without a profile map dies before archiving", () => {
    const sb = sandbox("nomap", { withMap: false });
    const r = ship(sb, { IOS_MANUAL_SIGN: "1" });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("profile map is missing");
    expect(r.log).not.toContain("CALL archive");
  });
});
