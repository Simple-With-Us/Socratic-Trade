import { afterEach, describe, expect, it } from "vitest";
import {
  PEER_LANE_SLOW_BACKOFF_MS,
  PEER_LANE_SLOW_P50_MS,
  PEER_LANE_USAGE_MONITOR,
  peerAwareDelayMs,
  peerLaneDelayMultiplier,
  peerLaneP50Ms,
  recordPeerLaneSample,
  resetPeerLaneBackoffForTests,
  shouldDeferPeerRefresh,
} from "../src/lib/peer-lane-backoff";

afterEach(() => {
  resetPeerLaneBackoffForTests();
});

describe("peer-lane-backoff", () => {
  it("p50 of an even window is the average of the two middle samples", () => {
    recordPeerLaneSample(PEER_LANE_USAGE_MONITOR, 1000);
    recordPeerLaneSample(PEER_LANE_USAGE_MONITOR, 3000);
    recordPeerLaneSample(PEER_LANE_USAGE_MONITOR, 5000);
    recordPeerLaneSample(PEER_LANE_USAGE_MONITOR, 7000);
    expect(peerLaneP50Ms(PEER_LANE_USAGE_MONITOR)).toBe(4000);
  });

  it("stays at 1x when p50 is at or under 2s", () => {
    recordPeerLaneSample(PEER_LANE_USAGE_MONITOR, 1500);
    recordPeerLaneSample(PEER_LANE_USAGE_MONITOR, 1800);
    expect(peerLaneDelayMultiplier(PEER_LANE_USAGE_MONITOR)).toBe(1);
    expect(shouldDeferPeerRefresh(PEER_LANE_USAGE_MONITOR)).toBe(false);
    expect(peerAwareDelayMs(PEER_LANE_USAGE_MONITOR, 2000)).toBe(2000);
  });

  it("halves the call rate (2x delay) when p50 is just over 2s", () => {
    recordPeerLaneSample(PEER_LANE_USAGE_MONITOR, 2100);
    recordPeerLaneSample(PEER_LANE_USAGE_MONITOR, 2500);
    expect(peerLaneP50Ms(PEER_LANE_USAGE_MONITOR)).toBeGreaterThan(PEER_LANE_SLOW_P50_MS);
    expect(peerLaneDelayMultiplier(PEER_LANE_USAGE_MONITOR)).toBe(2);
    expect(shouldDeferPeerRefresh(PEER_LANE_USAGE_MONITOR)).toBe(true);
    expect(peerAwareDelayMs(PEER_LANE_USAGE_MONITOR, 2000)).toBe(4000);
  });

  it("quadruples the delay when p50 is the 6.9s prod UM shape", () => {
    recordPeerLaneSample(PEER_LANE_USAGE_MONITOR, 6900);
    recordPeerLaneSample(PEER_LANE_USAGE_MONITOR, 7100);
    expect(peerLaneDelayMultiplier(PEER_LANE_USAGE_MONITOR)).toBe(4);
    expect(peerAwareDelayMs(PEER_LANE_USAGE_MONITOR, 2000)).toBe(8000);
  });

  it("returns to 1x after the slow-backoff window so a later probe can recover", () => {
    recordPeerLaneSample(PEER_LANE_USAGE_MONITOR, 6900);
    expect(shouldDeferPeerRefresh(PEER_LANE_USAGE_MONITOR)).toBe(true);
    expect(peerLaneDelayMultiplier(PEER_LANE_USAGE_MONITOR, Date.now() + PEER_LANE_SLOW_BACKOFF_MS + 1)).toBe(1);
    expect(shouldDeferPeerRefresh(PEER_LANE_USAGE_MONITOR, Date.now() + PEER_LANE_SLOW_BACKOFF_MS + 1)).toBe(false);
  });
});
