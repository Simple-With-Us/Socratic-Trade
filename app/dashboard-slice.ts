/** Server-side `fields=` slice for `GET /api/dashboard` (W13 / ST-4689, absorbing the
 *  ST-4667 item).
 *
 *  The console polls ONE endpoint and that endpoint returns the whole
 *  `DashboardSnapshot` — positions, orders, feeds, the scan, the weekly digest, web
 *  sources, the macro board.  A caller that only needs a few sections can now ask:
 *
 *      GET /api/dashboard?fields=policy,accounts,pendingProposals
 *
 *  and the route returns exactly those fields (plus the always-included correctness
 *  flags below).  Unknown names are reported, never silently dropped, so a typo is
 *  visible to the caller instead of looking like a deployment-version difference.
 *
 *  This is a wire-size optimization, not a projection: every included value is the
 *  same object the full snapshot ships, and the server cache still stores the whole
 *  snapshot (the slice happens after the coalesced read).
 *
 *  Pure module, no React and no DB: the rules are unit-tested
 *  (test/web-batch-2.test.ts).  The console's shared poll keeps requesting the full
 *  payload, because its chrome reads a wide subset of the snapshot on every route;
 *  the parameter serves narrow callers (scripts, diagnostics, and a future per-route
 *  client profile). */

import type { DashboardSnapshot } from "./dashboard-types";

/** Every top-level `DashboardSnapshot` field.  Keep in sync with the interface — the
 *  compile-time guard below fails the build when a field is added and not listed. */
export const DASHBOARD_SNAPSHOT_FIELDS = [
  "partialData",
  "partialReason",
  "currentUser",
  "llmConfigured",
  "policy",
  "strategyPrompt",
  "accounts",
  "accountReadiness",
  "connectedAccounts",
  "connectedAccountPolicies",
  "connectedAccountPendingCounts",
  "portfolio",
  "portfolioReadError",
  "positions",
  "options",
  "symbolMetaBySymbol",
  "stopPlanBySymbol",
  "livePortfolio",
  "livePositions",
  "liveOptions",
  "paperPortfolio",
  "paperPositions",
  "paperOptions",
  "orders",
  "orderPriceFallbacks",
  "audit",
  "auditFeed",
  "unifiedFeed",
  "latestStrategyRun",
  "latestScan",
  "priceDelay",
  "weeklyMarketDigest",
  "dailyStats",
  "strategyRuns",
  "pendingProposals",
  "recentProposals",
  "performance",
  "thesisScorecard",
  "regimeScorecard",
  "redTeamEfficacy",
  "tax",
  "profiles",
  "activeProfile",
  "notifications",
  "notificationStatus",
  "scheduler",
  "webSources",
  "robinhoodMcpConnected",
  "autoResumeOnBoot",
  "haltCause",
  "socratic",
  "smartMoney",
  "marketSession",
  "macroBoard",
  "consent"
] as const;

export type DashboardSnapshotField = keyof DashboardSnapshot;

/** Compile-time completeness guard: adding a DashboardSnapshot field without adding it to
 *  DASHBOARD_SNAPSHOT_FIELDS makes this type `false`, and the exported const below then
 *  fails to typecheck. */
type MissingDashboardField = Exclude<DashboardSnapshotField, (typeof DASHBOARD_SNAPSHOT_FIELDS)[number]>;
export type DashboardFieldListComplete = [MissingDashboardField] extends [never] ? true : false;
export const DASHBOARD_FIELD_LIST_IS_COMPLETE: DashboardFieldListComplete = true;

/** Fields a slice always carries, even when the caller did not name them: two are the
 *  snapshot's honest-partial markers and one is the first-use consent gate state.  A
 *  narrowed response that hid them would let a client render a complete-looking screen
 *  from partial data, or skip the legal/data-pool gate. */
export const DASHBOARD_SLICE_ALWAYS_INCLUDED = ["partialData", "partialReason", "consent"] as const;

const FIELD_SET: ReadonlySet<string> = new Set(DASHBOARD_SNAPSHOT_FIELDS);

export interface DashboardFieldSelection {
  /** `null` means "return the whole snapshot" (no `fields=` parameter, or an empty one). */
  fields: ReadonlySet<DashboardSnapshotField> | null;
  /** Names that are not DashboardSnapshot fields, deduped and sorted. */
  unknown: string[];
}

/** Parse the `fields` query parameter(s).
 *
 *  Accepts a comma-separated list and/or a repeated parameter — `?fields=a,b` and
 *  `?fields=a&fields=b` mean the same thing.  Names are trimmed; case is significant
 *  (the wire names are camelCase).  Empty entries are ignored, so a trailing comma is
 *  harmless.  When the parameter is present but carries nothing usable, the selection
 *  is `null` — an empty slice that quietly returned `{}` would be worse than the full
 *  payload for every caller. */
export function parseDashboardFields(rawValues: readonly string[] | null | undefined): DashboardFieldSelection {
  if (!rawValues || rawValues.length === 0) return { fields: null, unknown: [] };

  const selected = new Set<DashboardSnapshotField>();
  const unknown = new Set<string>();
  for (const raw of rawValues) {
    for (const token of String(raw).split(",")) {
      const name = token.trim();
      if (!name) continue;
      if (FIELD_SET.has(name)) selected.add(name as DashboardSnapshotField);
      else unknown.add(name);
    }
  }

  return {
    fields: selected.size > 0 ? selected : null,
    unknown: [...unknown].sort()
  };
}

/** Return the requested top-level fields (plus DASHBOARD_SLICE_ALWAYS_INCLUDED).
 *
 *  Iterating the snapshot's own keys means an optional field the snapshot does not carry
 *  is omitted rather than sent as an explicit `undefined` key, matching what the full
 *  payload would have contained.  Field order follows the snapshot's own insertion order,
 *  not the query, so responses stay byte-stable for a given request set. */
export function sliceDashboardSnapshot(
  snapshot: DashboardSnapshot,
  fields: ReadonlySet<DashboardSnapshotField>
): Partial<DashboardSnapshot> {
  const always = new Set<string>(DASHBOARD_SLICE_ALWAYS_INCLUDED);
  const out: Record<string, unknown> = {};
  const source = snapshot as unknown as Record<string, unknown>;
  for (const name of Object.keys(source)) {
    if (!fields.has(name as DashboardSnapshotField) && !always.has(name)) continue;
    out[name] = source[name];
  }
  // Always-included fields the snapshot lacks entirely (older payloads) stay absent,
  // except the two partial markers, which are meaningful as explicit falsy values.
  if (!("partialData" in out)) out.partialData = false;
  return out as Partial<DashboardSnapshot>;
}
