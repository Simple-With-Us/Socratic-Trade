import { beforeEach, describe, expect, it } from "vitest";
import {
  FEED_DESTINATION_KEY,
  FEED_TAB_KEY,
  NAV_DESTINATION_KEY,
  NAV_V2_OVERRIDE_KEY,
  WORKSPACE_TAB_KEY,
  destinationToWorkspaceTab,
  feedTabToDestination,
  isNavV2Enabled,
  isWorkspaceTab,
  migrateNavKeysToDestinations,
  workspaceTabToDestination,
  type DestinationTab,
  type FeedTab,
  type WorkspaceTab
} from "../app/nav-destinations";

// Minimal in-memory Storage stand-in (jsdom-free, deterministic).
function memStorage(seed: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    _map: map
  };
}

const ALL_WORKSPACE_TABS: WorkspaceTab[] = [
  "decision",
  "assistant",
  "market",
  "macro",
  "performance",
  "tax",
  "strategy"
];
const ALL_FEED_TABS: FeedTab[] = ["activity", "runs", "notifications", "audit"];

describe("nav destination mapping (PR #2)", () => {
  it("maps every workspace tab to a destination per the spec", () => {
    expect(workspaceTabToDestination("decision")).toBe("dashboard");
    expect(workspaceTabToDestination("macro")).toBe("dashboard");
    expect(workspaceTabToDestination("assistant")).toBe("dashboard");
    expect(workspaceTabToDestination("market")).toBe("scan");
    expect(workspaceTabToDestination("performance")).toBe("results");
    expect(workspaceTabToDestination("tax")).toBe("results");
    expect(workspaceTabToDestination("strategy")).toBe("strategy");
    // total over the union — no tab throws / returns undefined
    for (const tab of ALL_WORKSPACE_TABS) {
      expect(typeof workspaceTabToDestination(tab)).toBe("string");
    }
  });

  it("maps the feed 'notifications' tab to the retired-noun 'alert-history'", () => {
    expect(feedTabToDestination("notifications")).toBe("alert-history");
    expect(feedTabToDestination("activity")).toBe("activity");
    expect(feedTabToDestination("runs")).toBe("runs");
    expect(feedTabToDestination("audit")).toBe("audit");
  });

  it("resolves a destination back to the panel the old tab id rendered (NAV_V2 on)", () => {
    // The 1:1 destinations round-trip exactly (the acceptance guarantee).
    const roundTrip: WorkspaceTab[] = ["decision", "market", "strategy"];
    for (const tab of roundTrip) {
      const dest = workspaceTabToDestination(tab) as DestinationTab;
      expect(destinationToWorkspaceTab(dest)).toBe(tab);
    }
    // Many→one destinations resolve to a defined canonical panel (never a gap).
    expect(destinationToWorkspaceTab("results")).toBe("performance");
    expect(destinationToWorkspaceTab("dashboard")).toBe("decision");
    expect(destinationToWorkspaceTab("approvals")).toBe("decision");
    expect(destinationToWorkspaceTab("guardrails")).toBe("strategy");
  });
});

describe("nav destination shim (PR #2)", () => {
  it("(a) seeds mapped destination keys from legacy keys", () => {
    const s = memStorage({ [WORKSPACE_TAB_KEY]: "tax", [FEED_TAB_KEY]: "notifications" });
    const wrote = migrateNavKeysToDestinations(s);
    expect(wrote).toBe(true);
    expect(s.getItem(NAV_DESTINATION_KEY)).toBe("results");
    expect(s.getItem(FEED_DESTINATION_KEY)).toBe("alert-history");
    // (d) legacy keys are retained — a flag-off read path still finds them.
    expect(s.getItem(WORKSPACE_TAB_KEY)).toBe("tax");
    expect(s.getItem(FEED_TAB_KEY)).toBe("notifications");
  });

  it("(b) is idempotent — re-running is a no-op once the new keys exist", () => {
    const s = memStorage({ [WORKSPACE_TAB_KEY]: "performance", [FEED_TAB_KEY]: "runs" });
    expect(migrateNavKeysToDestinations(s)).toBe(true);
    expect(s.getItem(NAV_DESTINATION_KEY)).toBe("results");
    // second run writes nothing and does not clobber the seeded values
    expect(migrateNavKeysToDestinations(s)).toBe(false);
    expect(s.getItem(NAV_DESTINATION_KEY)).toBe("results");
    expect(s.getItem(FEED_DESTINATION_KEY)).toBe("runs");
  });

  it("does not overwrite a pre-existing destination key even if the legacy tab changed", () => {
    const s = memStorage({
      [WORKSPACE_TAB_KEY]: "strategy",
      [NAV_DESTINATION_KEY]: "results" // already migrated to a different value earlier
    });
    expect(migrateNavKeysToDestinations(s)).toBe(false);
    expect(s.getItem(NAV_DESTINATION_KEY)).toBe("results");
  });

  it("no-ops cleanly when there are no legacy keys (first-run user)", () => {
    const s = memStorage();
    expect(migrateNavKeysToDestinations(s)).toBe(false);
    expect(s.getItem(NAV_DESTINATION_KEY)).toBeNull();
    expect(s.getItem(FEED_DESTINATION_KEY)).toBeNull();
  });

  it("ignores an invalid/garbage legacy value rather than seeding a bad destination", () => {
    const s = memStorage({ [WORKSPACE_TAB_KEY]: "bogus-tab" });
    expect(migrateNavKeysToDestinations(s)).toBe(false);
    expect(s.getItem(NAV_DESTINATION_KEY)).toBeNull();
  });

  it("(c) legacy workspace ids remain valid guard aliases through migration", () => {
    expect(isWorkspaceTab("tax")).toBe(true);
    expect(isWorkspaceTab("performance")).toBe(true);
    expect(isWorkspaceTab("bogus")).toBe(false);
  });
});

describe("NAV_V2 flag", () => {
  beforeEach(() => {
    delete process.env.NEXT_PUBLIC_NAV_V2;
  });

  it("defaults off with no override and no env", () => {
    expect(isNavV2Enabled(memStorage())).toBe(false);
    expect(isNavV2Enabled(null)).toBe(false);
  });

  it("localStorage override wins over the env default", () => {
    process.env.NEXT_PUBLIC_NAV_V2 = "1";
    expect(isNavV2Enabled(memStorage({ [NAV_V2_OVERRIDE_KEY]: "off" }))).toBe(false);
    expect(isNavV2Enabled(memStorage({ [NAV_V2_OVERRIDE_KEY]: "on" }))).toBe(true);
  });

  it("honors the env default when there is no override", () => {
    process.env.NEXT_PUBLIC_NAV_V2 = "true";
    expect(isNavV2Enabled(memStorage())).toBe(true);
    process.env.NEXT_PUBLIC_NAV_V2 = "0";
    expect(isNavV2Enabled(memStorage())).toBe(false);
  });
});
