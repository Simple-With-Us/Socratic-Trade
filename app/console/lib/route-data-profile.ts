/** How fresh each console route's data has to be (ST-4642 / audit #5).
 *
 *  The console polls ONE endpoint — GET /api/dashboard — and that endpoint
 *  returns the whole `DashboardSnapshot`: positions, orders, audit feed,
 *  unified feed, strategy runs, the latest scan, the weekly digest, web
 *  sources. Every route polled it every 15 seconds, and every SSE push
 *  re-polled it, EVEN on routes that display none of that — Settings shows
 *  notification preferences, Strategy shows the prompt and the profiles,
 *  Connections shows the broker accounts.
 *
 *  This module says, per route, two things:
 *
 *   1. which SSE event types can actually change what the route shows (so an
 *      irrelevant push does not trigger a full-payload refetch), and
 *   2. how often the route is polled.
 *
 *  Both are chosen so that NO SCREEN DISPLAYS DIFFERENT DATA because of
 *  them. The event filter only drops `market-data` on routes that show no
 *  market data at all; every other event type (a proposal arriving, an order
 *  filling, the run finishing, a dirty policy write) still refreshes
 *  everywhere, so the chrome's pending-proposal badge and the notification
 *  counts stay exactly as live as they were. The poll interval changes only
 *  HOW SOON an out-of-band change appears on a route whose data the user
 *  changes through explicit mutations — those call `refresh()` directly, so
 *  they are still immediate.
 *
 *  Pure module, no React: the rules are unit-tested (test/console-route-data-profile.test.ts). */

/** Every event type the console's SSE stream delivers (see useConsoleData.tsx). */
export const CONSOLE_STREAM_EVENT_TYPES = [
  "ready",
  "run-complete",
  "order",
  "proposal",
  "dirty",
  "market-data",
  "pending-learned-change"
] as const;

export type ConsoleStreamEventType = (typeof CONSOLE_STREAM_EVENT_TYPES)[number];

/** Events that can change what ANY route shows. A route that displays no
 *  market data may ignore `market-data` and nothing else. */
const NON_MARKET_EVENTS: readonly ConsoleStreamEventType[] = [
  "ready",
  "run-complete",
  "order",
  "proposal",
  "dirty",
  "pending-learned-change"
];

/** Poll cadence for a route that shows live market data. */
export const FULL_ROUTE_POLL_MS = 15_000;

/** Poll cadence for a route that shows no market data. Half the requests of
 *  the full profile; still well inside "the owner sees their own change at
 *  once", because every mutation on those routes calls `refresh()` itself. */
export const LIGHT_ROUTE_POLL_MS = 30_000;

export interface RouteDataProfile {
  /** SSE event types that can change what this route displays. */
  relevantEvents: ReadonlySet<string>;
  /** How often this route's data is polled, in ms. */
  pollMs: number;
}

const FULL_EVENTS: ReadonlySet<string> = new Set(CONSOLE_STREAM_EVENT_TYPES);
const LIGHT_EVENTS: ReadonlySet<string> = new Set(NON_MARKET_EVENTS);

/** Routes that display NO market data — no positions, no prices, no equity, no
 *  scan, no fills.
 *
 *  Deliberately a short, verified list, not a heuristic:
 *   - `/console/settings`  — notification preferences, the policy, the user.
 *   - `/console/strategy`  — the strategy prompt, the profiles, the policy.
 *   - `/console/connections` — broker accounts and per-account state.
 *   - `/console/lessons`   — learning surfaces (they read no snapshot at all).
 *   - `/console/decisions`  — the decision log, labelled per account.
 *
 *  `/console/guardrails` is deliberately NOT here: it reads `snapshot.positions`
 *  and `snapshot.portfolio` for the unmanaged-shorts notice, so market data
 *  genuinely can change what it shows. `/console/activity`, `/console/orders`,
 *  `/console/approvals`, `/console/scan`, `/console/watchlist`, `/console/macro`
 *  and `/console/results` all display prices or fills. */
const LIGHT_ROUTES: readonly string[] = [
  "/console/settings",
  "/console/strategy",
  "/console/connections",
  "/console/lessons",
  "/console/decisions"
];

/** `/console/settings/anything` is still the settings route. */
export function normalizeConsoleRoute(pathname: string | null | undefined): string {
  if (!pathname) return "";
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

/** True when the route is one that displays no market data. */
export function isLightDataRoute(pathname: string | null | undefined): boolean {
  const route = normalizeConsoleRoute(pathname);
  return LIGHT_ROUTES.some((light) => route === light || route.startsWith(`${light}/`));
}

/** The data profile for the route on screen. */
export function routeDataProfile(pathname: string | null | undefined): RouteDataProfile {
  if (isLightDataRoute(pathname)) {
    return { relevantEvents: LIGHT_EVENTS, pollMs: LIGHT_ROUTE_POLL_MS };
  }
  return { relevantEvents: FULL_EVENTS, pollMs: FULL_ROUTE_POLL_MS };
}
