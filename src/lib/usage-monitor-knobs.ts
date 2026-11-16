// Subscription -> knob lane: reads the API Usage Monitor's `GET /api/subscriptions` (per-provider
// `knobEnv`/`freeTierKnobEnv` maps, see docs/rollouts/2026-07-10-subscription-knob-linkage.md on
// the monitor side) and exposes a flat, SYNC env-var-name -> value map so provider-rate-limit.ts's
// (otherwise-sync) env resolution can consult "what plan am I actually on" without ever awaiting a
// network call on a hot path.
//
// DESIGN:
//   - Env-gated on the SAME base URL as the rest of the usage-monitor integration
//     (USAGE_MONITOR_BASE_URL); additionally gated on USAGE_MONITOR_KNOBS_ENABLED, which defaults
//     ON whenever the base URL is configured (advisory-tier per the owner's guardrail philosophy —
//     "on by default once wired, one flag to fully disable").
//   - SYNC getter (`getUsageMonitorKnobsCached`) backed by an in-process cache: it returns the
//     last-known merged map immediately and, when that cache is missing or stale (>= 1h by
//     default), kicks off a fire-and-forget background refresh. The CALLER that triggered the
//     refresh does NOT see the fresh values — the next call does. This is required because every
//     consumer (resolveProviderLimiterConfig / resolveProviderQuota) is itself synchronous.
//   - FAIL-OPEN: a monitor outage/error during refresh leaves the last-known map untouched (never
//     throws into a caller, never resets to empty on failure) — a transient UM outage must not
//     suddenly un-apply a subscription's knobs mid-run.
//   - Selection per subscription row: `status === "active"` uses that row's own `knobEnv` (the
//     purchased plan's override); anything else (paused/canceled/considering — i.e. "lapsed" from
//     this app's point of view) uses the provider's `freeTierKnobEnv` baseline instead. A provider
//     with multiple subscription rows (e.g. an `active` plan alongside a `considering` candidate)
//     is merged in array order, so the active row's real knobs always win over a same-provider
//     freeTierKnobEnv contributed by another row for that provider.
//   - globalThis-pinned (like usage-budget.ts's cache) so HMR can't split the cache/refresh-guard
//     across module instances.

import { logApiHealth } from "./db-health";
import {
  PEER_LANE_SLOW_P50_MS,
  PEER_LANE_USAGE_MONITOR,
  peerLaneP50Ms,
  recordPeerLaneSample,
  shouldDeferPeerRefresh,
} from "./peer-lane-backoff";
import { usageMonitorBaseUrl, usageMonitorToken } from "./usage-monitor-push";

function flagOff(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  return v === "0" || v === "false" || v === "no" || v === "off";
}

function numEnv(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** Default ON once a base URL is configured — set USAGE_MONITOR_KNOBS_ENABLED=off to disable just
 *  this lane (e.g. while diagnosing a bad knob value) without touching the budget/push wiring. */
export function usageMonitorKnobsEnabled(): boolean {
  if (!usageMonitorBaseUrl()) return false;
  return !flagOff(process.env.USAGE_MONITOR_KNOBS_ENABLED);
}

/** Same read-token convention as usage-budget.ts's budgetReadToken: a dedicated USAGE_READ_TOKEN
 *  wins, else the ingest token — mirrors the monitor's own GET /api/subscriptions auth (see its
 *  route.ts doc comment). */
function knobsReadToken(): string | undefined {
  const read = (process.env.USAGE_READ_TOKEN ?? "").trim();
  return read.length > 0 ? read : usageMonitorToken();
}

/** How stale the cache may get before a call triggers a background refresh. */
function ttlMs(): number {
  return numEnv("USAGE_MONITOR_KNOBS_TTL_MS", 60 * 60_000); // 1h, per spec
}

function timeoutMs(): number {
  // 8000, not the original 2500 (2026-08-12) — same reasoning as usage-budget.ts's timeoutMs:
  // a cross-internet read whose failure is fail-open, sharing the "usage-monitor" health lane, and
  // matching the 8000 the health-lane re-probe already uses against this host.
  return numEnv("USAGE_MONITOR_KNOBS_TIMEOUT_MS", 8000);
}

// ── Response parsing ─────────────────────────────────────────────────────────────

interface RawSubscription {
  status?: unknown;
  knobEnv?: unknown;
  freeTierKnobEnv?: unknown;
  provider?: unknown;
}

function isStringRecord(v: unknown): v is Record<string, string> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).every((x) => typeof x === "string");
}

/**
 * Merge every subscription row's EFFECTIVE knob map into one flat env-var-name -> value map.
 * `active` uses the row's own `knobEnv` (the purchased plan); anything else falls back to the
 * provider's `freeTierKnobEnv` baseline. Rows are merged in response order (Object.assign — later
 * entries win a key collision), so a genuinely `active` row for a provider always supersedes any
 * `considering`/`paused` row's freeTierKnobEnv contribution for that same provider, regardless of
 * array position, ONLY if it is merged after — callers get the monitor's own ordering
 * (`[{status:"asc"}, {nextRenewalAt:"asc"}]`), which does not guarantee active-last, so this is
 * best-effort like the rest of this advisory-tier lane, not a guaranteed precedence.
 */
function mergeKnobMap(subscriptions: unknown): Record<string, string> {
  const merged: Record<string, string> = {};
  if (!Array.isArray(subscriptions)) return merged;
  for (const raw of subscriptions as RawSubscription[]) {
    if (!raw || typeof raw !== "object") continue;
    const active = raw.status === "active";
    const source = active ? raw.knobEnv : raw.freeTierKnobEnv;
    if (isStringRecord(source)) Object.assign(merged, source);
  }
  return merged;
}

async function fetchKnobMap(fetchImpl: typeof fetch = fetch): Promise<Record<string, string> | null> {
  const baseUrl = usageMonitorBaseUrl();
  const token = knobsReadToken();
  if (!baseUrl || !token) return null;
  const url = `${baseUrl}/api/subscriptions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  const start = Date.now();
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
      cache: "no-store",
    });
    // Shares the "usage-monitor" health lane with usage-budget.ts's budget-status reads — both
    // are read-surfaces against the same monitor host, so one connections-health row covers both.
    const latencyMs = Date.now() - start;
    recordPeerLaneSample(PEER_LANE_USAGE_MONITOR, latencyMs);
    logApiHealth({
      service: "usage-monitor",
      ok: res.ok,
      latencyMs,
      errorText: res.ok ? undefined : `subscriptions HTTP ${res.status}`,
    });
    if (!res.ok) return null;
    const json = await res.json().catch(() => null);
    return mergeKnobMap(json);
  } catch (err) {
    // Soft: fail-open (returns null; callers fall back to the cached/default knob map), so an
    // abort or network blip changes no behavior and must not page at level=error. Still ok=0.
    const latencyMs = Date.now() - start;
    recordPeerLaneSample(PEER_LANE_USAGE_MONITOR, latencyMs);
    logApiHealth({
      service: "usage-monitor",
      ok: false,
      latencyMs,
      errorText: err instanceof Error ? err.message : String(err),
      soft: true,
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── In-process cache (globalThis-pinned so HMR can't split it) ──────────────────

interface KnobsCacheHost {
  __usageMonitorKnobsCache?: { map: Record<string, string>; fetchedAt: number };
  __usageMonitorKnobsRefreshing?: boolean;
  __usageMonitorKnobsLastFailureAt?: number;
  __usageMonitorKnobsLastSlowAt?: number;
}
const cacheHost = globalThis as unknown as KnobsCacheHost;

/** After a failed refresh, do not re-attempt for this long. Without it a dead/unreachable
 *  monitor made EVERY knob read re-enter triggerRefresh — one fetch plus one sync
 *  logApiHealth DB transaction per provider admission, thousands of times during a full scan
 *  (an amplifier in the 2026-08-02 prod wedge). Widened 2026-08-17 (#2550) from 5m — a
 *  7s-latency sink was still being probed on the old cadence after each success. */
export const KNOBS_FAILURE_BACKOFF_MS = 15 * 60_000;

/** Slow-but-200 responses (#2550) never stamped the failure marker. Same window as a
 *  hard failure so a 6.9s success halves+ the refresh rate instead of looking healthy. */
export const KNOBS_SLOW_BACKOFF_MS = 15 * 60_000;

/** Fire-and-forget refresh; never throws; fail-open — a failed/null refresh leaves whatever is
 *  already cached untouched (negative result stamps a failure marker for the backoff above).
 *  Guarded so overlapping stale reads don't pile up parallel refreshes. */
function triggerRefresh(fetchImpl?: typeof fetch): void {
  if (cacheHost.__usageMonitorKnobsRefreshing) return;
  cacheHost.__usageMonitorKnobsRefreshing = true;
  void fetchKnobMap(fetchImpl)
    .then((map) => {
      if (map) {
        cacheHost.__usageMonitorKnobsCache = { map, fetchedAt: Date.now() };
        cacheHost.__usageMonitorKnobsLastFailureAt = undefined;
        const p50 = peerLaneP50Ms(PEER_LANE_USAGE_MONITOR);
        cacheHost.__usageMonitorKnobsLastSlowAt =
          p50 !== undefined && p50 > PEER_LANE_SLOW_P50_MS ? Date.now() : undefined;
      } else {
        cacheHost.__usageMonitorKnobsLastFailureAt = Date.now();
      }
    })
    .catch(() => {
      cacheHost.__usageMonitorKnobsLastFailureAt = Date.now();
    })
    .finally(() => {
      cacheHost.__usageMonitorKnobsRefreshing = false;
    });
}

/**
 * Sync getter: the last-known merged knob map (env-var-name -> value), or `{}` when never
 * successfully fetched or the lane is disabled/unconfigured. Never blocks, never throws.
 *
 * When enabled and the cache is missing or stale (>= USAGE_MONITOR_KNOBS_TTL_MS, default 1h),
 * kicks off a background refresh and returns whatever is cached RIGHT NOW (stale-while-revalidate)
 * — the freshened map becomes visible on a LATER call, never this one, because every caller here
 * (provider-rate-limit.ts's resolveProviderLimiterConfig/resolveProviderQuota) is itself sync and
 * must not block on a network round trip.
 */
export function getUsageMonitorKnobsCached(opts: { fetchImpl?: typeof fetch } = {}): Record<string, string> {
  if (!usageMonitorKnobsEnabled()) return {};
  const cached = cacheHost.__usageMonitorKnobsCache;
  const now = Date.now();
  const failedAt = cacheHost.__usageMonitorKnobsLastFailureAt;
  const slowAt = cacheHost.__usageMonitorKnobsLastSlowAt;
  const inFailureBackoff = failedAt !== undefined && now - failedAt < KNOBS_FAILURE_BACKOFF_MS;
  const inSlowBackoff = slowAt !== undefined && now - slowAt < KNOBS_SLOW_BACKOFF_MS;
  const deferSlowLane = shouldDeferPeerRefresh(PEER_LANE_USAGE_MONITOR, now);
  if ((!cached || now - cached.fetchedAt >= ttlMs()) && !inFailureBackoff && !inSlowBackoff && !deferSlowLane) {
    triggerRefresh(opts.fetchImpl);
  }
  return cached?.map ?? {};
}


/** Look up one env-var name in the cached knob map and parse it as a finite number, mirroring how
 *  provider-rate-limit.ts's finiteEnvNumber treats process.env — undefined when absent, blank, or
 *  non-numeric. */
export function usageMonitorKnobNumber(name: string, opts: { fetchImpl?: typeof fetch } = {}): number | undefined {
  const raw = getUsageMonitorKnobsCached(opts)[name];
  if (raw === undefined || raw === "") return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Test-only: force the in-process cache (and refresh-in-flight guard) back to empty so tests
 *  don't leak state across runs — mirrors the reset helpers other durable/in-process caches in
 *  this codebase expose (e.g. provider-rate-limit.ts's resetProviderRateLimiterState). */
export function resetUsageMonitorKnobsCacheForTests(): void {
  delete cacheHost.__usageMonitorKnobsCache;
  delete cacheHost.__usageMonitorKnobsRefreshing;
  delete cacheHost.__usageMonitorKnobsLastFailureAt;
  delete cacheHost.__usageMonitorKnobsLastSlowAt;
}
