/** ST-4642 (audit #5) — the console's data layer must not re-fetch the whole
 *  dashboard snapshot on routes that display none of it, and must never let a
 *  route's data go stale in a way that changes what it shows.
 *
 *  These are pure rules, so they are unit-tested directly (this repo's vitest
 *  setup is node-only — no jsdom, no testing-library). */

import { describe, expect, it } from "vitest";
import {
  CONSOLE_STREAM_EVENT_TYPES,
  FULL_ROUTE_POLL_MS,
  LIGHT_ROUTE_POLL_MS,
  isLightDataRoute,
  normalizeConsoleRoute,
  routeDataProfile
} from "../app/console/lib/route-data-profile";

describe("route data profile", () => {
  it("keeps every event type relevant on a route that shows market data", () => {
    const profile = routeDataProfile("/console/scan");
    for (const type of CONSOLE_STREAM_EVENT_TYPES) {
      expect(profile.relevantEvents.has(type)).toBe(true);
    }
    expect(profile.pollMs).toBe(FULL_ROUTE_POLL_MS);
  });

  it("drops only market-data on a route that shows no market data", () => {
    const profile = routeDataProfile("/console/settings");
    expect(profile.relevantEvents.has("market-data")).toBe(false);
    // Everything that can change policy, accounts, proposals, orders or the
    // notification count still refreshes — the chrome's badges stay live.
    for (const type of ["ready", "run-complete", "order", "proposal", "dirty", "pending-learned-change"]) {
      expect(profile.relevantEvents.has(type)).toBe(true);
    }
    expect(profile.pollMs).toBe(LIGHT_ROUTE_POLL_MS);
  });

  it("treats Guardrails as a market-data route (it reads positions and equity)", () => {
    expect(isLightDataRoute("/console/guardrails")).toBe(false);
    expect(routeDataProfile("/console/guardrails").relevantEvents.has("market-data")).toBe(true);
  });

  it("recognises the light routes and their sub-routes", () => {
    for (const route of ["/console/settings", "/console/strategy", "/console/connections", "/console/lessons", "/console/decisions"]) {
      expect(isLightDataRoute(route)).toBe(true);
      expect(isLightDataRoute(`${route}/anything`)).toBe(true);
    }
    for (const route of ["/console", "/console/orders", "/console/activity", "/console/results", "/console/watchlist", "/console/macro", "/console/approvals"]) {
      expect(isLightDataRoute(route)).toBe(false);
    }
  });

  it("normalizes trailing slashes", () => {
    expect(normalizeConsoleRoute("/console/settings/")).toBe("/console/settings");
    expect(normalizeConsoleRoute("/console/")).toBe("/console");
    expect(normalizeConsoleRoute(null)).toBe("");
  });

  it("falls back to the full profile for an unknown route", () => {
    const profile = routeDataProfile("/console/something-new");
    expect(profile.relevantEvents.has("market-data")).toBe(true);
    expect(profile.pollMs).toBe(FULL_ROUTE_POLL_MS);
  });
});
