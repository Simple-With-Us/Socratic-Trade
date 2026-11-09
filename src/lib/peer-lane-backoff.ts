// Shared latency tracker for peer-app lanes (Usage Monitor, Congress.Trade).
//
// Prod 2026-08-06 (#2550): UM answered in 6.9s and CT in 11s, but ST kept calling
// at the healthy cadence (UM ~478/hr) because negative-cache backoff only fired
// on hard failures — a slow-but-200 response never widened the interval.
//
// This module is process-local, sync, and fetch-free so hot paths (knob reads,
// congress enrichment, telemetry flush) can consult it without awaiting.

export const PEER_LANE_USAGE_MONITOR = "usage-monitor";
export const PEER_LANE_CONGRESS_TRADE = "congress.trade";
export const PEER_LANE_CONGRESS_SSE = "congress.trade:sse";

/** Issue #2550: halve call rate while p50 exceeds this. */
export const PEER_LANE_SLOW_P50_MS = 2_000;
export const PEER_LANE_VERY_SLOW_P50_MS = 4_000;

/** After a slow sample, skip/widen for this long before probing again. */
export const PEER_LANE_SLOW_BACKOFF_MS = 15 * 60_000;

const SAMPLE_WINDOW = 8;

interface LaneState {
  samples: number[];
  lastAt: number;
}

interface PeerLaneHost {
  __peerLaneBackoff?: Map<string, LaneState>;
}

const host = globalThis as unknown as PeerLaneHost;

function lanes(): Map<string, LaneState> {
  return (host.__peerLaneBackoff ??= new Map());
}

function laneState(lane: string): LaneState {
  const map = lanes();
  const existing = map.get(lane);
  if (existing) return existing;
  const created: LaneState = { samples: [], lastAt: 0 };
  map.set(lane, created);
  return created;
}

/** Record one completed attempt (success or fail). Latency 0 is a valid fast call. */
export function recordPeerLaneSample(lane: string, latencyMs: number): void {
  if (!Number.isFinite(latencyMs) || latencyMs < 0) return;
  const state = laneState(lane);
  state.samples.push(latencyMs);
  if (state.samples.length > SAMPLE_WINDOW) state.samples.shift();
  state.lastAt = Date.now();
}

export function peerLaneP50Ms(lane: string): number | undefined {
  const samples = lanes().get(lane)?.samples;
  if (!samples || samples.length === 0) return undefined;
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor((sorted.length - 1) / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2;
  }
  return sorted[mid];
}

/**
 * 1 when the lane is healthy or the last sample is older than the slow-backoff
 * window (so we probe again). 2 when p50 > 2s. 4 when p50 > 4s.
 */
export function peerLaneDelayMultiplier(lane: string, now: number = Date.now()): number {
  const state = lanes().get(lane);
  if (!state || state.samples.length === 0) return 1;
  if (state.lastAt > 0 && now - state.lastAt >= PEER_LANE_SLOW_BACKOFF_MS) return 1;
  const p50 = peerLaneP50Ms(lane);
  if (p50 === undefined || p50 <= PEER_LANE_SLOW_P50_MS) return 1;
  if (p50 <= PEER_LANE_VERY_SLOW_P50_MS) return 2;
  return 4;
}

/** True when a non-forced refresh should skip the network and serve cache / fail-open. */
export function shouldDeferPeerRefresh(lane: string, now: number = Date.now()): boolean {
  return peerLaneDelayMultiplier(lane, now) > 1;
}

export function peerAwareDelayMs(lane: string, baseMs: number, now: number = Date.now()): number {
  const base = Number.isFinite(baseMs) && baseMs > 0 ? baseMs : 1;
  return Math.max(1, Math.round(base * peerLaneDelayMultiplier(lane, now)));
}

export function resetPeerLaneBackoffForTests(): void {
  lanes().clear();
}
