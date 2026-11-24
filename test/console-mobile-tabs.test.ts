/** ST-4645 (audit W4) — the web phone tab bar's slot math.
 *
 *  The web bar was hard-capped at four destinations no matter how wide the
 *  window was, while the native app adapts to the window
 *  (ios/SocraticTrade/MobileControlView.swift:114-125, `TabBarCapacity`). The
 *  rules are ported here; these are pure functions, so they are unit-tested
 *  directly (this repo's vitest setup is node-only — no jsdom). */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_MOBILE_TAB_HREFS,
  MOBILE_TABS_MAX,
  MOBILE_TABS_MIN,
  MOBILE_TAB_SLOT_MIN_PX,
  autoFillMobileTabs,
  mobileTabPinLimit,
  resolveMobileTabs,
  tabBarCapacity
} from "../app/console/lib/mobile-tabs";

const ALL_HREFS = [
  "/console",
  "/console/approvals",
  "/console/lessons",
  "/console/activity",
  "/console/scan",
  "/console/watchlist",
  "/console/macro",
  "/console/orders",
  "/console/assistant",
  "/console/strategy",
  "/console/guardrails",
  "/console/connections",
  "/console/results",
  "/console/usage",
  "/console/settings"
];

describe("phone tab bar capacity", () => {
  it("shows five destinations beside More at 390px", () => {
    expect(tabBarCapacity(390)).toBe(5);
  });

  it("shows four at 360px and keeps growing with the window", () => {
    expect(tabBarCapacity(320)).toBe(4);
    expect(tabBarCapacity(360)).toBe(4);
    expect(tabBarCapacity(430)).toBe(5);
    expect(tabBarCapacity(640)).toBe(8);
  });

  it("never exceeds the native ceiling of eight, and never drops below two", () => {
    expect(tabBarCapacity(1024)).toBe(MOBILE_TABS_MAX);
    expect(tabBarCapacity(4000)).toBe(MOBILE_TABS_MAX);
    expect(tabBarCapacity(0)).toBe(MOBILE_TABS_MIN);
    expect(tabBarCapacity(-10)).toBe(MOBILE_TABS_MIN);
    expect(tabBarCapacity(Number.NaN)).toBe(MOBILE_TABS_MIN);
  });

  it("derives the slot count from the slot width", () => {
    expect(Math.floor(390 / MOBILE_TAB_SLOT_MIN_PX) - 1).toBe(5);
  });

  it("caps the pin limit at the capacity", () => {
    expect(mobileTabPinLimit(5)).toBe(5);
    expect(mobileTabPinLimit(1)).toBe(MOBILE_TABS_MIN);
    expect(mobileTabPinLimit(99)).toBe(MOBILE_TABS_MAX);
  });
});

describe("phone tab bar membership", () => {
  it("auto-fills to the capacity, defaults first", () => {
    const filled = autoFillMobileTabs(ALL_HREFS, DEFAULT_MOBILE_TAB_HREFS, 5);
    expect(filled).toHaveLength(5);
    // The owner-decided defaults stay exactly where they were.
    expect(filled.slice(0, DEFAULT_MOBILE_TAB_HREFS.length)).toEqual([...DEFAULT_MOBILE_TAB_HREFS]);
    // The extra slot is the next destination in canonical order.
    expect(filled[4]).toBe("/console/lessons");
  });

  it("keeps the owner's choice when it fits", () => {
    const chosen = ["/console", "/console/scan", "/console/orders"];
    expect(resolveMobileTabs(chosen, DEFAULT_MOBILE_TAB_HREFS, 5)).toEqual(chosen);
  });

  it("falls back to the defaults when the owner's choice does not fit", () => {
    const chosen = ["/console", "/console/scan", "/console/orders", "/console/macro", "/console/usage", "/console/strategy"];
    const resolved = resolveMobileTabs(chosen, DEFAULT_MOBILE_TAB_HREFS, 4);
    // Too narrow for what the owner picked -> the defaults, trimmed to fit.
    expect(resolved).toEqual([...DEFAULT_MOBILE_TAB_HREFS].slice(0, 4));
  });

  it("trims the owner's choice to the capacity when it fits", () => {
    const chosen = ["/console", "/console/scan", "/console/orders"];
    expect(resolveMobileTabs(chosen, DEFAULT_MOBILE_TAB_HREFS, 2)).toHaveLength(2);
  });
});
