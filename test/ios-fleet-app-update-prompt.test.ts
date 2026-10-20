import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repo = process.cwd();
const fleetPrompt = readFileSync(resolve(repo, "scripts/ios-fleet/AppUpdatePrompt.swift"), "utf8");
const appPrompt = readFileSync(resolve(repo, "ios/SocraticTrade/AppUpdatePrompt.swift"), "utf8");
const apps = JSON.parse(readFileSync(resolve(repo, "scripts/ios-fleet/apps.json"), "utf8")) as {
  apps: Record<string, { bundleId?: string; appleId?: number; notes?: string }>;
};
const versions = JSON.parse(
  readFileSync(resolve(repo, "scripts/ios-fleet/ios-app-versions.json"), "utf8")
) as { apps: Record<string, { appleId?: number; marketingVersion?: string }> };
const ship = readFileSync(resolve(repo, "scripts/ios-fleet/ship-testflight.sh"), "utf8");
const pin = readFileSync(resolve(repo, "scripts/ios-fleet.sha256"), "utf8");
const pinScript = readFileSync(resolve(repo, "scripts/ios-fleet-pin.sh"), "utf8");

const STALE_APPLE_ID_MARKERS = [
  "knownAppleIds",
  "online.dealdex",
  "6_802_474_288",
  "6_799_238_379",
  "6_798_076_688",
  "6_799_230_435",
  "6_799_230_729",
  "6802474288",
  "6799238379",
  "6798076688",
  "6799230435",
  "6799230729",
];

describe("AppUpdatePrompt fleet pin/copy", () => {
  it("keeps the in-repo pin and the iOS target copy identical", () => {
    expect(appPrompt).toBe(fleetPrompt);
  });

  it("does not hardcode Apple IDs or the stale DealDex bundle in Swift", () => {
    for (const marker of STALE_APPLE_ID_MARKERS) {
      expect(fleetPrompt, marker).not.toContain(marker);
    }
    expect(fleetPrompt).toContain("Simple-With-Us/AI-Fleet-Coordinator");
    expect(fleetPrompt).toContain("versions.json");
    expect(fleetPrompt).toContain("entry?.appleId");
    expect(fleetPrompt).not.toContain("Package.swift");
  });

  it("registers live DealDex as net.dealdex 6802474288", () => {
    expect(apps.apps.dealdex.bundleId).toBe("net.dealdex");
    expect(apps.apps.dealdex.appleId).toBe(6802474288);
    expect(apps.apps.dealdex.notes).toMatch(/online\.dealdex is not the live bundle/);
    expect(apps.apps.dealdex.notes).toMatch(/Do not upload me\.grok\.dealdex/);
    expect(versions.apps["net.dealdex"]?.appleId).toBe(6802474288);
    expect(versions.apps["online.dealdex"]).toBeUndefined();
    expect(versions.apps["me.grok.dealdex"]).toBeUndefined();
  });

  it("refuses me.grok.dealdex uploads and pins the Swift file", () => {
    expect(ship).toContain('BUNDLE_ID" == "me.grok.dealdex"');
    expect(ship).toContain("refusing to upload me.grok.dealdex");
    expect(ship).toContain("DealDex live bundle is net.dealdex");
    expect(ship).toMatch(/socratic\|congress\|usage\|usage-local/);
    expect(pin).toContain("AppUpdatePrompt.swift");
    expect(pinScript).toContain("AppUpdatePrompt.swift");
  });
});
