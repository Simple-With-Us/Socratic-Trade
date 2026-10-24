/**
 * version-plan.test.mjs - unit tests for the fleet's version-numbering rules.
 *
 * Pure:  no network, no credentials, no App Store Connect.  The data in the
 * "real Congress.Trade" case is the live App Store Connect state measured
 * 2026-10-24 (AFC-517 / CT-2444):
 *
 *   App Store versions : 1.0.235
 *   TestFlight trains  : 1.0.235 [202610110355]
 *                        1.0.236 [202610180036]
 *                        1.0.2353 [2353]   <- drift train (build "2353")
 *                        1.0.2358 [2358]   <- drift train (build "2358")
 *
 * so the next marketing version is 1.0.237 -- the drift trains must not push
 * it to 1.0.2359.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFloor,
  isDriftTrain,
  latestMarketingPatch,
  ownPatch,
  parsePatch,
  planVersion,
  nextMarketingPatch
} from "./version-plan.mjs";

const CONGRESS_APP_STORE_VERSIONS = ["1.0.235"];
const CONGRESS_TRAINS = [
  { version: "1.0.235", builds: ["202610110355"] },
  { version: "1.0.236", builds: ["202610180036"] },
  { version: "1.0.2353", builds: ["2353"] },
  { version: "1.0.2358", builds: ["2358"] }
];

test("parsePatch reads the patch of a version on a train", () => {
  assert.equal(parsePatch("1.0.236", "1.0"), 236);
  assert.equal(parsePatch("1.0.2358", "1.0"), 2358);
  assert.equal(parsePatch("2.0.5", "2.0"), 5);
});

test("parsePatch rejects a version that is not <prefix>.<digits>", () => {
  assert.equal(parsePatch("1.0", "1.0"), null);
  assert.equal(parsePatch("1.01.5", "1.0"), null);
  assert.equal(parsePatch("2.0.5", "1.0"), null);
  assert.equal(parsePatch("1.0.236.1", "1.0"), null);
  assert.equal(parsePatch("", "1.0"), null);
  assert.equal(parsePatch("1.0.abc", "1.0"), null);
});

test("parsePatch escapes the prefix", () => {
  // "1.0" must not match "120" or "1x0".
  assert.equal(parsePatch("120.5", "1.0"), null);
  assert.equal(parsePatch("1x0.5", "1.0"), null);
  assert.equal(parsePatch("1.0.5", "1.0"), 5);
});

test("ownPatch reads the patch of a version on its own train", () => {
  assert.equal(ownPatch("1.0.236"), 236);
  assert.equal(ownPatch("2.0.5"), 5);
  assert.equal(ownPatch("1.0"), null);
  assert.equal(ownPatch("nonsense"), null);
});

test("isDriftTrain spots a train that holds the build named after its patch", () => {
  assert.equal(isDriftTrain("1.0.2358", ["2358"], "1.0"), true);
  assert.equal(isDriftTrain("1.0.2353", ["2353", "202610180036"], "1.0"), true);
  // A UTC-stamped build is not the patch number:  not a drift train.
  assert.equal(isDriftTrain("1.0.236", ["202610180036"], "1.0"), false);
  // A train with no patch has no drift to speak of.
  assert.equal(isDriftTrain("1.0", ["1"], "1.0"), false);
  assert.equal(isDriftTrain("2.0.5", ["5"], "1.0"), false);
});

test("latestMarketingPatch ignores drift trains (real Congress.Trade data)", () => {
  const patch = latestMarketingPatch({
    prefix: "1.0",
    appStoreVersions: CONGRESS_APP_STORE_VERSIONS,
    trains: CONGRESS_TRAINS
  });
  // 1.0.2358 and 1.0.2353 are drift trains, so 236 wins.
  assert.equal(patch, 236);
});

test("latestMarketingPatch counts App Store versions that no train carries", () => {
  const patch = latestMarketingPatch({
    prefix: "1.0",
    appStoreVersions: ["1.0.240"],
    trains: [{ version: "1.0.2358", builds: ["2358"] }]
  });
  assert.equal(patch, 240);
});

test("latestMarketingPatch returns 0 for an empty train", () => {
  assert.equal(latestMarketingPatch({ prefix: "1.0", appStoreVersions: [], trains: [] }), 0);
});

test("buildFloor keeps the old UTC stamp inside the target train", () => {
  const floor = buildFloor({
    trainBuilds: ["202610180036"],
    appBuilds: [],
    platform: "IOS"
  });
  assert.equal(floor, 202610180036);
});

test("buildFloor ignores huge app builds on iOS but not on macOS", () => {
  const appBuilds = ["2353", "2358", "202610180036"];
  assert.equal(buildFloor({ trainBuilds: [], appBuilds, platform: "IOS" }), 2358);
  assert.equal(buildFloor({ trainBuilds: [], appBuilds, platform: "MAC_OS" }), 202610180036);
});

test("buildFloor ignores dotted and non-numeric build values", () => {
  const floor = buildFloor({
    trainBuilds: ["1.0.5", "abc", ""],
    appBuilds: ["42", "1.0.9", "x"],
    platform: "IOS"
  });
  assert.equal(floor, 42);
});

test("planVersion picks the next patch on the train (real Congress.Trade data)", () => {
  const ascPatch = latestMarketingPatch({
    prefix: "1.0",
    appStoreVersions: CONGRESS_APP_STORE_VERSIONS,
    trains: CONGRESS_TRAINS
  });
  assert.equal(ascPatch, 236);

  const floor = buildFloor({
    trainBuilds: [],                       // the new train is empty
    appBuilds: ["2353", "2358", "202610180036"],
    platform: "IOS"
  });
  assert.equal(floor, 2358);

  const plan = planVersion({
    prefix: "1.0",
    ascPatch,
    commitCount: 2360,
    floor
  });
  assert.equal(plan.marketing, "1.0.237");
  assert.equal(plan.build, "2360");
});

test("planVersion raises the build above the floor of the forced train", () => {
  const floor = buildFloor({
    trainBuilds: ["202610180036"],
    appBuilds: [],
    platform: "IOS"
  });
  assert.equal(floor, 202610180036);

  const plan = planVersion({
    prefix: "1.0",
    ascPatch: 236,
    forcedVersion: "1.0.236",
    commitCount: 2360,
    floor
  });
  assert.equal(plan.marketing, "1.0.236");
  assert.equal(plan.build, "202610180037");
});

test("planVersion never ships 1.0.N (N)", () => {
  // The commit count happens to be the patch number of the next marketing
  // version:  the build moves one up so the pair cannot read "1.0.237 (237)".
  const plan = planVersion({
    prefix: "1.0",
    ascPatch: 236,
    commitCount: 237,
    floor: 0
  });
  assert.equal(plan.marketing, "1.0.237");
  assert.equal(plan.build, "238");

  // Same rule for an explicit --version.
  const forced = planVersion({
    prefix: "1.0",
    ascPatch: 236,
    forcedVersion: "1.0.236",
    commitCount: 236,
    floor: 0
  });
  assert.equal(forced.marketing, "1.0.236");
  assert.equal(forced.build, "237");
});

test("planVersion keeps the macOS floor (build numbers grow across trains)", () => {
  const floor = buildFloor({
    trainBuilds: [],
    appBuilds: ["2358", "202610180036"],
    platform: "MAC_OS"
  });
  assert.equal(floor, 202610180036);

  const plan = planVersion({
    prefix: "1.0",
    ascPatch: 236,
    commitCount: 2360,
    floor
  });
  assert.equal(plan.marketing, "1.0.237");
  assert.equal(plan.build, "202610180037");
});

test("planVersion honours an exact --build override", () => {
  const plan = planVersion({
    prefix: "1.0",
    ascPatch: 236,
    forcedBuild: "999",
    commitCount: 2360,
    floor: 202610180036
  });
  assert.equal(plan.marketing, "1.0.237");
  assert.equal(plan.build, "999");
});

test("planVersion honours an exact --version override", () => {
  const plan = planVersion({
    prefix: "1.0",
    ascPatch: 236,
    forcedVersion: "2.0.5",
    commitCount: 2360,
    floor: 0
  });
  assert.equal(plan.marketing, "2.0.5");
  assert.equal(plan.build, "2360");
});

test("planVersion with no App Store Connect state plans 1.0.1", () => {
  const plan = planVersion({ prefix: "1.0", ascPatch: 0, commitCount: 7, floor: 0 });
  assert.equal(plan.marketing, "1.0.1");
  assert.equal(plan.build, "7");
});

test("nextMarketingPatch skips a patch a drift train already holds (Kody, AFC-517)", () => {
  const trains = [
    { version: "1.0.235", builds: ["202610110355"] },
    { version: "1.0.236", builds: ["236"] },        // drift train on the next patch
    { version: "1.0.237", builds: ["237", "2400"] } // drift train we already shipped into
  ];
  assert.equal(latestMarketingPatch({ prefix: "1.0", appStoreVersions: ["1.0.235"], trains }), 235);
  assert.equal(nextMarketingPatch({ prefix: "1.0", appStoreVersions: ["1.0.235"], trains }), 238);
});

test("nextMarketingPatch is latest + 1 when nothing is in the way", () => {
  assert.equal(
    nextMarketingPatch({
      prefix: "1.0",
      appStoreVersions: ["1.0.235"],
      trains: [{ version: "1.0.236", builds: ["202610180036"] }, { version: "1.0.2358", builds: ["2358"] }]
    }),
    237
  );
});

test("planVersion refuses a forced build that recreates 1.0.N (N) (Kody, AFC-517)", () => {
  assert.throws(() => planVersion({ prefix: "1.0", ascPatch: 236, forcedBuild: "237", commitCount: 10, floor: 0 }));
  assert.throws(() => planVersion({ prefix: "1.0", forcedVersion: "1.0.236", forcedBuild: "236", commitCount: 10, floor: 0 }));
  assert.deepEqual(
    planVersion({ prefix: "1.0", ascPatch: 236, forcedBuild: "999", commitCount: 10, floor: 0 }),
    { marketing: "1.0.237", build: "999" }
  );
});
