#!/usr/bin/env node
/**
 * Promote the build THIS SHIP uploaded into the app's EXTERNAL beta group.
 *
 * WHY THIS EXISTS (CT-2434, 2026-10-19):  the Congress.Trade Public Beta group
 * (external, public link, three testers) served build 202608311519, uploaded
 * 2026-08-31, while every other fleet app's external group tracked the current
 * build.  Nothing refreshed it:  external beta promotion was only wired into
 * BotFleet and Clutch (asc-api.mjs ensure-standing-testers), and this repo's
 * ios-ship.yml had no such step.  That one build expired 2026-11-29, after
 * which the public link served nothing at all.
 *
 * WHAT IT DOES, in order:
 *   1. find the app's external beta group,
 *   2. find the ONE build it was asked to promote -- by build number, exactly,
 *   3. add that build to the group (idempotent),
 *   4. submit that build for Beta App Review when Apple wants a submission.
 *
 * WHY IT MATCHES A BUILD NUMBER AND NEVER "THE NEWEST BUILD"
 * -------------------------------------------------------
 * The repo's own vendored client says this out loud, in
 * scripts/ios-fleet/asc-api.mjs (ensure-tf-ready):
 *
 *   "CFBundleVersion is known exactly at archive time (ship-testflight.sh
 *    passes it to xcodebuild as CURRENT_PROJECT_VERSION) and ASC ingests it
 *    verbatim as builds[].attributes.version, so it is an exact key.  There is
 *    deliberately NO 'newest build' fallback: that fallback IS the defect."
 *
 * "Newest" is wrong for the first minutes after an upload:  the newest build
 * App Store Connect knows about is then the PREVIOUS ship.  A promotion that
 * picks "the newest" therefore promotes a build nobody asked it to promote,
 * and a promotion that waits for "the newest" waits for the wrong build.
 *
 * So this script takes a build number -- the CFBundleVersion the ship used --
 * and looks it up by that exact key.  When the build is not there yet, or is
 * still processing, it says so loudly and promotes nothing.  It never falls
 * back to a different build:  a wrong promotion is worse than a late one,
 * because the wrong one looks like success.
 *
 * The build number normally comes from the ship itself:  the fleet script
 * numbers a build as the checkout's commit count and logs it as
 * "marketing=1.0.<n> build=<n>", so the ship workflow hands that number over.
 * Without one, this script falls back to the same commit count, which is what
 * the ship starts from.
 *
 * Auth:  every App Store Connect call goes through the vendored
 * scripts/ios-fleet/asc-api.mjs, which owns credential handling.  This file
 * never reads, holds or prints a credential, and it never mutates the vendored
 * pin (scripts/ios-fleet/check-drift.sh compares that pin by sha256).
 *
 * Usage:
 *   node scripts/promote-external-beta.mjs [--apple-id <id>] [--group <name>]
 *                                           [--build <n>]
 *
 * Exit codes:  0 done or nothing to do  |  3 partial (warnings printed).
 * The ship workflow treats a non-zero exit as a warning and never lets it fail
 * the TestFlight ship.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APPS_JSON = join(ROOT, "scripts", "ios-fleet", "apps.json");
const DEFAULT_APP_KEY = "congress";

// Build states that mean Apple will not accept this build for external testing.
// Anything not listed is passed through to the caller to decide on.
const BLOCKED_EXTERNAL_STATES = [
  "BETA_REJECTED",
  "MISSING_EXPORT_COMPLIANCE",
  "PROCESSING_EXCEPTION",
  "EXPIRED",
  "REMOVED",
];

/**
 * Pull a short, human-readable reason out of an App Store Connect error body.
 *
 * The body is untrusted external data, so it is checked before it is read:
 * `errors` has to be an array, and every element has to be an object whose
 * fields are strings.  A malformed element is skipped rather than believed,
 * because this runs inside a script that must never throw --  and `e.code`
 * on a null element would throw.
 */
export function ascErrorText(res) {
  const errors = res?.parsed?.errors;
  if (Array.isArray(errors)) {
    const parts = [];
    for (const e of errors) {
      if (!e || typeof e !== "object" || Array.isArray(e)) continue;
      const code =
        typeof e.code === "string" ? e.code : typeof e.status === "string" ? e.status : "ERROR";
      const detail =
        typeof e.detail === "string"
          ? e.detail
          : typeof e.title === "string"
            ? e.title
            : "request failed";
      parts.push(`${code}: ${detail}`);
    }
    if (parts.length) return parts.join(" | ");
  }
  const text = (res?.text || "").trim();
  if (text) return text.slice(0, 300);
  return `HTTP ${res?.status ?? "?"}`;
}

/**
 * Pick the external group to promote into.  A named group wins outright;  with
 * several external groups the one carrying the public link wins, because that
 * is the surface a tester actually reaches.
 */
export function chooseExternalGroup(groups, groupName = null) {
  const external = (groups || []).filter((g) => g?.attributes?.isInternalGroup === false);
  if (!external.length) return null;
  if (groupName) {
    const wanted = groupName.trim().toLowerCase();
    return external.find((g) => String(g.attributes?.name || "").toLowerCase() === wanted) || null;
  }
  const publicLink = external.find((g) => g.attributes?.publicLinkEnabled === true);
  return publicLink || external[0];
}

/**
 * The build number this promotion is for.
 *
 * `explicit` is what the ship handed over.  Without it, the checkout's commit
 * count is used:  that is exactly how the fleet script numbers a build
 * (scripts/ios-fleet/ship-testflight.sh, BUILD_NUM="$(git rev-list --count
 * HEAD)"), and the promotion runs in the same checkout as the ship.
 *
 * A build number is a positive integer.  Number("0"), Number("-1") and
 * Number("nope") are all rejected here rather than being allowed through as a
 * number that silently matches nothing.
 */
/** One to three dot-separated integers, not all zero ("1.1.2", "0.1.0"). */
export function isDottedBuild(raw) {
  if (!/^\d+(\.\d+){1,2}$/.test(raw)) return false;
  const parts = raw.split(".").map(Number);
  if (!parts.every((x) => Number.isSafeInteger(x))) return false;
  return parts.some((x) => x > 0);
}

export function resolveExpectedBuildNumber({ explicit = null, repoRoot = ROOT } = {}) {
  const raw = explicit == null ? "" : String(explicit).trim();
  if (raw !== "") {
    // A plain integer ("239") or one to three dot-separated integers
    // ("1.1.2"):  the two forms Apple's CFBundleVersion takes.  "1e3", "1..2",
    // ".1", "1." and a fourth component are not build numbers, even though
    // Number() would turn some of them into numbers.  A plain integer comes
    // back as a number, a dotted build as the exact string, because "1.1.2"
    // must reach App Store Connect character for character.
    if (/^\d+$/.test(raw)) {
      const n = Number(raw);
      if (!Number.isSafeInteger(n) || n <= 0) return null;
      return n;
    }
    if (isDottedBuild(raw)) return raw;
    return null;
  }
  const res = spawnSync("git", ["-C", repoRoot, "rev-list", "--count", "HEAD"], { encoding: "utf8" });
  if (res.status !== 0) return null;
  const n = Number((res.stdout || "").trim());
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

/**
 * Look the target build up by its exact build number.
 *
 * The query is the same one the vendored client uses for ensure-tf-ready:
 * filter[version] is CFBundleVersion, which ASC ingests verbatim.  Two rows
 * matching one build number is ambiguous, and the vendored client refuses to
 * guess there ("N builds match version X -- ambiguous, refusing to guess");
 * so does this.
 */
export function findExactBuild(asc, appId, buildNumber, marketingVersion = null) {
  // A marketing version, when the ship knows it, pins the lookup to that train:
  // a dotted build string is only unique inside its train.
  let trainFilter = "";
  if (marketingVersion != null && String(marketingVersion).trim() !== "") {
    // Given but malformed:  refuse rather than quietly look the build up
    // across every train, which is the ambiguity the pin exists to avoid.
    const mv = String(marketingVersion).trim();
    if (!/^\d+(\.\d+)*$/.test(mv)) {
      return { ok: false, error: `invalid marketing version ${JSON.stringify(mv)}; refusing an unpinned lookup`, rows: [], build: null };
    }
    trainFilter = `&filter[preReleaseVersion.version]=${encodeURIComponent(mv)}`;
  }
  const res = asc(
    "GET",
    `/v1/builds?filter[app]=${appId}&filter[version]=${buildNumber}${trainFilter}` +
      `&limit=2&include=buildBetaDetail,preReleaseVersion` +
      `&fields[builds]=version,processingState,uploadedDate`
  );
  if (!res.ok) return { ok: false, error: ascErrorText(res), rows: [], build: null };
  const rows = res.parsed?.data || [];
  if (rows.length > 1) return { ok: true, rows, build: null, ambiguous: true };
  return { ok: true, rows, build: rows[0] || null, ambiguous: false };
}

/**
 * The newest build App Store Connect knows about, for diagnostics only.
 *
 * This is never used to choose what to promote -- see the header.  It exists
 * so a failed promotion can say what IS there, which is the difference between
 * "the build has not been ingested yet" and "the promotion is broken".
 */
export function newestKnownBuild(asc, appId) {
  const res = asc(
    "GET",
    `/v1/builds?filter[app]=${appId}&sort=-uploadedDate&limit=1&fields[builds]=version,processingState`
  );
  if (!res.ok) return null;
  return res.parsed?.data?.[0] || null;
}

/**
 * Do the promotion.  `asc` is injected so the test can drive it without a
 * network or a credential;  the real one shells out to the vendored client.
 *
 * Returns a summary object.  Never throws:  a failure is a warning, because
 * this runs inside a ship that already succeeded.  `outcome` says what
 * actually happened, so a no-op can never be mistaken for a promotion.
 */
export function promoteExternalBeta({
  asc,
  appId,
  groupName = null,
  buildNumber = null,
  marketingVersion = null,
  log = () => {},
  warn = () => {},
}) {
  const out = {
    appId: appId || null,
    groupId: null,
    groupName: null,
    targetBuildNumber: buildNumber ?? null,
    buildId: null,
    buildVersion: null,
    outcome: "unknown",
    added: false,
    submitted: false,
    alreadyPresent: false,
    externalState: null,
    warnings: 0,
  };
  const note = (msg) => {
    out.warnings += 1;
    warn(msg);
  };

  if (!appId) {
    out.outcome = "no-app-id";
    note("no App Store Connect app id; nothing promoted");
    return out;
  }
  const buildOk =
    (Number.isInteger(buildNumber) && buildNumber > 0) ||
    (typeof buildNumber === "string" && isDottedBuild(buildNumber));
  if (!buildOk) {
    out.outcome = "no-target-build";
    note(
      "no build number to promote; pass --build <n> with the CFBundleVersion the ship uploaded"
    );
    return out;
  }

  // 1. The external group.
  const groupsRes = asc(
    "GET",
    `/v1/apps/${appId}/betaGroups?limit=200&fields[betaGroups]=name,isInternalGroup,publicLinkEnabled`
  );
  if (!groupsRes.ok) {
    out.outcome = "asc-error";
    note(`could not list beta groups: ${ascErrorText(groupsRes)}`);
    return out;
  }
  const group = chooseExternalGroup(groupsRes.parsed?.data, groupName);
  if (!group) {
    out.outcome = "no-external-group";
    note(
      groupName
        ? `no external beta group named "${groupName}" for app ${appId}; create it in App Store Connect > TestFlight > External Testing`
        : `app ${appId} has no external beta group; create one in App Store Connect > TestFlight > External Testing`
    );
    return out;
  }
  out.groupId = group.id;
  out.groupName = group.attributes?.name || null;

  // 2. THE build -- by number, never by recency.
  const found = findExactBuild(asc, appId, buildNumber, marketingVersion);
  if (!found.ok) {
    out.outcome = "asc-error";
    note(`could not look up build ${buildNumber}: ${found.error}`);
    return out;
  }
  if (found.ambiguous) {
    out.outcome = "ambiguous";
    note(
      `${found.rows.length} builds match build number ${buildNumber}; refusing to guess which one to promote`
    );
    return out;
  }
  if (!found.build) {
    const newest = newestKnownBuild(asc, appId);
    out.outcome = "not-visible";
    note(
      `build ${buildNumber} (the one this ship uploaded) is not in App Store Connect yet; ` +
        `the public beta was NOT refreshed` +
        (newest?.attributes?.version ? `; the newest build present is ${newest.attributes.version}` : "")
    );
    return out;
  }
  const build = found.build;
  const state = build.attributes?.processingState;
  if (state !== "VALID") {
    out.outcome = "not-ready";
    note(`build ${buildNumber} is still ${state}; the public beta was NOT refreshed`);
    return out;
  }
  out.buildId = build.id;
  out.buildVersion = build.attributes?.version || String(buildNumber);

  // 3. Idempotence:  a build already in the group needs no second link.
  //    Match on the immutable build `id`, never on `version`:  an id is
  //    unique for the life of the build, and JSON:API always returns it.
  const inGroupRes = asc("GET", `/v1/betaGroups/${group.id}/builds?limit=200&fields[builds]=version`);
  const already = inGroupRes.ok
    ? (inGroupRes.parsed?.data || []).some((b) => b.id === out.buildId)
    : false;
  if (already) {
    out.alreadyPresent = true;
    out.outcome = "already-present";
    log(`build ${out.buildVersion} is already in "${out.groupName}"`);
  } else {
    const linkRes = asc(
      "POST",
      `/v1/betaGroups/${group.id}/relationships/builds`,
      JSON.stringify({ data: [{ type: "builds", id: build.id }] })
    );
    if (!linkRes.ok) {
      out.outcome = "asc-error";
      note(`could not add build ${out.buildVersion} to "${out.groupName}": ${ascErrorText(linkRes)}`);
      return out;
    }
    out.added = true;
    out.outcome = "promoted";
    log(`build ${out.buildVersion} added to "${out.groupName}"`);
  }

  // 4. Beta App Review.  External testers only get a build Apple approved, and
  //    Apple only wants one submission per build.
  const detailRes = asc(
    "GET",
    `/v1/builds/${build.id}/buildBetaDetail?fields[buildBetaDetails]=externalBuildState,internalBuildState`
  );
  if (!detailRes.ok) {
    note(`could not read the build's external state: ${ascErrorText(detailRes)}`);
    return out;
  }
  const externalState = detailRes.parsed?.data?.attributes?.externalBuildState || "unknown";
  out.externalState = externalState;
  if (externalState === "READY_FOR_BETA_SUBMISSION") {
    const subRes = asc(
      "POST",
      "/v1/betaAppReviewSubmissions",
      JSON.stringify({
        data: { type: "betaAppReviewSubmissions", relationships: { build: { data: { type: "builds", id: build.id } } } },
      })
    );
    if (subRes.ok) {
      out.submitted = true;
      log(`build ${out.buildVersion} submitted for Beta App Review`);
    } else {
      note(`Beta App Review submission failed: ${ascErrorText(subRes)}`);
    }
  } else if (BLOCKED_EXTERNAL_STATES.includes(externalState)) {
    note(`build ${out.buildVersion} cannot reach external testers (externalBuildState=${externalState})`);
  } else {
    log(`build ${out.buildVersion} external state is ${externalState}; no submission needed`);
  }

  return out;
}

/**
 * The real App Store Connect client:  the vendored scripts/ios-fleet/asc-api.mjs
 * owns the credential, so this only shells out and parses what it prints.
 */
export function makeAscClient(root = ROOT) {
  const client = join(root, "scripts", "ios-fleet", "asc-api.mjs");
  return (method, path, body) => {
    const args = [client, method, path];
    if (body) args.push(body);
    const res = spawnSync(process.execPath, args, { encoding: "utf8" });
    const stdout = (res.stdout || "").trim();
    let parsed = null;
    try {
      parsed = stdout ? JSON.parse(stdout) : null;
    } catch {
      parsed = null;
    }
    const httpStatus = Number((res.stderr || "").match(/HTTP (\d+)/)?.[1] || 0);
    return {
      ok: res.status === 0,
      status: httpStatus || res.status || 0,
      parsed,
      text: stdout,
      stderr: res.stderr || "",
    };
  };
}

/** Read the app's App Store Connect id out of the vendored apps.json. */
export function readAppleId(root = ROOT, appKey = DEFAULT_APP_KEY) {
  const raw = readFileSync(join(root, "scripts", "ios-fleet", "apps.json"), "utf8");
  const apps = JSON.parse(raw)?.apps || {};
  const id = apps[appKey]?.appleId;
  return id == null ? null : String(id);
}

function parseArgs(argv) {
  const out = { appleId: null, group: null, appKey: DEFAULT_APP_KEY, build: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--apple-id") out.appleId = argv[++i] || null;
    else if (argv[i] === "--group") out.group = argv[++i] || null;
    else if (argv[i] === "--app") out.appKey = argv[++i] || DEFAULT_APP_KEY;
    else if (argv[i] === "--build") out.build = argv[++i] || null;
    else if (argv[i] === "--marketing") out.marketing = argv[++i] || null;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let appId = args.appleId;
  if (!appId) {
    // A missing or malformed apps.json throws out of readAppleId.  This runs
    // inside a ship that already succeeded, so that is a warning on the
    // documented exit 3, never an unhandled throw and exit 1.
    try {
      appId = readAppleId(ROOT, args.appKey);
    } catch (err) {
      console.error(
        `promote-external-beta: warning: could not read the app id from apps.json (${err?.message || err})`
      );
      process.exit(3);
    }
  }
  if (!appId) {
    console.error("promote-external-beta: no App Store Connect app id; pass --apple-id");
    process.exit(3);
  }
  const buildNumber = resolveExpectedBuildNumber({ explicit: args.build, repoRoot: ROOT });
  if (!buildNumber) {
    console.error(
      "promote-external-beta: could not determine the build number to promote; pass --build <n>"
    );
    process.exit(3);
  }
  const asc = makeAscClient(ROOT);
  const result = promoteExternalBeta({
    asc,
    appId,
    groupName: args.group,
    buildNumber,
    marketingVersion: args.marketing || null,
    log: (m) => console.error(`promote-external-beta: ${m}`),
    warn: (m) => console.error(`promote-external-beta: warning: ${m}`),
  });
  console.log(JSON.stringify(result));
  process.exit(result.warnings ? 3 : 0);
}

// pathToFileURL, not `file://${process.argv[1]}`:  on Windows the argv path
// carries backslashes, so the naive comparison never matches and the CLI body
// would be a silent no-op that still exits 0.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
