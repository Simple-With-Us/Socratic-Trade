/**
 * version-plan.mjs - the pure rules behind the fleet's version numbering.
 *
 * Owner directive 2026-10-24 (AFC-517 / CT-2444).  This replaces the
 * 1.0.<commit_count> scheme unified in #2801 (2026-10-18), which made App
 * Store Connect show "1.0.2358 (2358)".
 *
 * The rules, in one place:
 *
 *   MARKETING_VERSION       = <prefix>.<P+1>
 *       <prefix> is the train from marketingVersionDefault ("1.0").
 *       P is the highest patch already used on that train in App Store
 *       Connect, counting BOTH App Store versions (appStoreVersions
 *       .versionString) AND TestFlight trains (preReleaseVersions.version)
 *       for the app's platform -- IGNORING any TestFlight train that is a
 *       "drift train":  a <prefix>.N train that holds a build whose
 *       CFBundleVersion is exactly the string "N".  Those are the
 *       1.0.N (N) uploads the retired scheme produced (1.0.2358 holding
 *       build 2358).  App Store versions are never ignored.
 *
 *   CURRENT_PROJECT_VERSION = the repo commit count, raised when needed so it
 *       is strictly greater than
 *         (a) every build already in the TARGET marketing train (any value,
 *             including the old 12-digit UTC stamps, because Apple requires
 *             build numbers to increase inside one version train), and
 *         (b) the highest plain-integer build below 1000000000 the app has on
 *             that platform (so the number stays monotonic on a shallow
 *             checkout).
 *       For platform MAC_OS, (b) also includes every build of any size,
 *       because macOS build numbers must increase across all trains.
 *
 *   The build number is INDEPENDENT of the marketing version.  It is never
 *   derived from it, and the marketing version is never derived from it.
 *   The only coupling is a safety rule:  a ship must never look like
 *   "1.0.N (N)", so a build that happens to equal the patch number is bumped
 *   by one.
 *
 * This module is PURE:  no I/O, no network, no environment.  The bash ship
 * script implements the same rules; this module is the readable reference
 * and the unit-testable copy of them.
 */

/** Escape a string for literal use inside a RegExp. */
function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The patch number of a version on a train.
 *
 * parsePatch("1.0.236", "1.0") -> 236
 * parsePatch("1.0", "1.0")     -> null   (no patch component)
 * parsePatch("1.01.5", "1.0")  -> null   (not "<prefix>.<digits>")
 * parsePatch("2.0.5", "1.0")   -> null   (a different train)
 *
 * The prefix is escaped, so a prefix of "1.0" can never match "120.5".
 */
export function parsePatch(version, prefix) {
  if (version === null || version === undefined) return null;
  if (prefix === null || prefix === undefined) return null;
  const value = String(version).trim();
  const train = String(prefix).trim();
  if (!value || !train) return null;
  const re = new RegExp(`^${escapeRegExp(train)}\\.(\\d+)$`);
  const match = re.exec(value);
  if (!match) return null;
  const patch = parseInt(match[1], 10);
  return Number.isFinite(patch) ? patch : null;
}

/**
 * The patch of a version on ITS OWN train ("2.0.5" -> 5), used for the
 * "never 1.0.N (N)" rule when an operator pins a version explicitly.
 */
export function ownPatch(version) {
  if (version === null || version === undefined) return null;
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version).trim());
  if (!match) return null;
  const patch = parseInt(match[3], 10);
  return Number.isFinite(patch) ? patch : null;
}

/**
 * True when a TestFlight train is a "drift train":  a <prefix>.N train that
 * holds a build whose CFBundleVersion is exactly the string "N".
 *
 * Those trains came from the retired 1.0.<commit_count> scheme (1.0.2358
 * holding build 2358) and must not push the next marketing patch forward.
 * App Store versions are never drift -- only trains can be.
 */
export function isDriftTrain(trainVersion, buildVersions, prefix) {
  const patch = parsePatch(trainVersion, prefix);
  if (patch === null) return false;
  const target = String(patch);
  for (const build of buildVersions || []) {
    if (build === null || build === undefined) continue;
    if (String(build) === target) return true;
  }
  return false;
}

/**
 * The highest patch already used on a train.
 *
 * appStoreVersions: ["1.0.235"]  -- the App Store versions, never ignored.
 * trains: [{ version: "1.0.236", builds: ["202610180036"] }]  -- the
 * TestFlight trains; a drift train is ignored.
 *
 * Returns 0 when the train has nothing on it yet.
 */
export function latestMarketingPatch({ prefix, appStoreVersions = [], trains = [] } = {}) {
  let best = 0;
  const consider = (patch) => {
    if (patch !== null && patch !== undefined && Number.isFinite(patch) && patch > best) {
      best = patch;
    }
  };

  for (const version of appStoreVersions || []) {
    const value = typeof version === "string" ? version : version?.versionString;
    consider(parsePatch(value, prefix));
  }

  for (const train of trains || []) {
    if (!train) continue;
    const version = typeof train === "string" ? train : train.version;
    const builds = typeof train === "string" ? [] : train.builds || [];
    if (isDriftTrain(version, builds, prefix)) continue;
    consider(parsePatch(version, prefix));
  }

  return best;
}

/** A plain integer build number, or null when the value is not one. */
function integerBuild(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return null;
  const parsed = parseInt(text, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/** The macOS platform key used by the App Store Connect API. */
export const MAC_PLATFORM = "MAC_OS";

/**
 * The build number the next ship has to exceed.
 *
 * trainBuilds: every build already in the target marketing train.  All of
 *   them count, any size:  Apple requires build numbers to increase inside
 *   one version train, so an old 12-digit UTC stamp (202610180036) still
 *   holds the floor up.
 * appBuilds: the app's builds on that platform.  Only the plain integers
 *   below 1000000000 count on iOS, so the retired UTC stamps do not push the
 *   commit count out of the way forever.  On macOS EVERY build counts,
 *   because macOS build numbers must increase across all trains.
 *
 * Non-numeric or dotted build values (e.g. "1.0.5") are ignored.
 */
export function buildFloor({ trainBuilds = [], appBuilds = [], platform = "" } = {}) {
  const isMac = String(platform || "").toUpperCase() === MAC_PLATFORM;
  let floor = 0;

  for (const build of trainBuilds || []) {
    const parsed = integerBuild(build);
    if (parsed !== null && parsed > floor) floor = parsed;
  }

  for (const build of appBuilds || []) {
    const parsed = integerBuild(build);
    if (parsed === null) continue;
    if (isMac) {
      if (parsed > floor) floor = parsed;
    } else if (parsed < 1000000000 && parsed > floor) {
      floor = parsed;
    }
  }

  return floor;
}

/**
 * The marketing version and the build number for one ship.
 *
 *   prefix        the default train, e.g. "1.0"
 *   ascPatch      the highest patch already used on that train (0 if none)
 *   forcedVersion an exact --version override, or ""
 *   forcedBuild   an exact --build override, or ""
 *   commitCount   the repo commit count
 *   floor         the build floor (see buildFloor)
 *
 * Returns { marketing, build } as strings.
 */
export function planVersion({
  prefix = "1.0",
  ascPatch = 0,
  forcedVersion = "",
  forcedBuild = "",
  commitCount = 0,
  floor = 0
} = {}) {
  const train = String(prefix || "1.0");
  const patch = Number.isFinite(ascPatch) ? Math.max(0, Math.trunc(ascPatch)) : 0;

  let marketing;
  let targetPatch;
  if (forcedVersion) {
    marketing = String(forcedVersion);
    targetPatch = ownPatch(marketing);
  } else {
    marketing = `${train}.${patch + 1}`;
    targetPatch = patch + 1;
  }

  let build;
  if (forcedBuild !== "" && forcedBuild !== null && forcedBuild !== undefined) {
    // An explicit --build is honoured exactly.
    build = String(forcedBuild);
  } else {
    const commits = Number.isFinite(commitCount) ? Math.trunc(commitCount) : 0;
    const known = Number.isFinite(floor) ? Math.trunc(floor) : 0;
    let candidate = commits;
    if (candidate <= known) candidate = known + 1;
    // A ship must never look like "1.0.N (N)":  if the build number happens to
    // be the patch number, move it one up.
    if (targetPatch !== null && candidate === targetPatch) candidate += 1;
    build = String(candidate);
  }

  return { marketing, build };
}
