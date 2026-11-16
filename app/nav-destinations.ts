// Navigation destination vocabulary + the mapping layer over the existing
// WorkspaceTab / FeedTab values (NAV_V2 PR #2).
//
// This introduces the redesign's destination nouns as a *mapping* over today's
// tab ids so later PRs can re-point a destination's panel without a second
// localStorage migration. Panels do not move in this PR: rendering stays driven
// by WorkspaceTab / FeedTab and is byte-identical with the flag on or off. The
// load-bearing, risk-carrying piece here is the one-time additive-write shim
// (`migrateNavKeysToDestinations`) — it touches 100% of returning users, so it
// is pure and unit-tested in isolation.
//
// See docs/settings-navigation-redesign/spec/08-delivery-plan-prs-and-tests.md
// (PR #2) and spec/09-copy-deck.md.

// ── Existing tab unions (moved here from dashboard-client so the mapping + its
//    tests share one source of truth) ──────────────────────────────────────────
export type WorkspaceTab =
  | "decision"
  | "assistant"
  | "market"
  | "macro"
  | "performance"
  | "tax"
  | "strategy";

export type FeedTab = "activity" | "runs" | "notifications" | "audit";

// ── New destination vocabulary (the six verb destinations + feed sub-log) ──────
export type DestinationTab =
  | "dashboard"
  | "approvals"
  | "scan"
  | "strategy"
  | "guardrails"
  | "results";

export type FeedDestination = "activity" | "runs" | "alert-history" | "audit";

// ── localStorage keys ─────────────────────────────────────────────────────────
// Legacy keys (unchanged; still authoritative for rendering this release).
export const WORKSPACE_TAB_KEY = "dashboard-workspace-tab";
export const FEED_TAB_KEY = "dashboard-feed-tab";
// New destination keys the shim seeds (delete of legacy keys deferred one release).
export const NAV_DESTINATION_KEY = "dashboard-destination";
export const FEED_DESTINATION_KEY = "dashboard-feed-destination";

// ── Type guards (legacy ids stay valid as redirect aliases through migration) ──
export function isWorkspaceTab(value: unknown): value is WorkspaceTab {
  return (
    value === "decision" ||
    value === "assistant" ||
    value === "market" ||
    value === "macro" ||
    value === "performance" ||
    value === "tax" ||
    value === "strategy"
  );
}

export function isFeedTab(value: unknown): value is FeedTab {
  return value === "activity" || value === "runs" || value === "notifications" || value === "audit";
}

export function isDestinationTab(value: unknown): value is DestinationTab {
  return (
    value === "dashboard" ||
    value === "approvals" ||
    value === "scan" ||
    value === "strategy" ||
    value === "guardrails" ||
    value === "results"
  );
}

export function isFeedDestination(value: unknown): value is FeedDestination {
  return value === "activity" || value === "runs" || value === "alert-history" || value === "audit";
}

// ── Forward mapping: current tab → destination (per spec §PR #2) ───────────────
// decision/macro → dashboard · market → scan · performance/tax → results ·
// strategy → strategy · assistant → dashboard (Assistant is an overlay in the
// new model, not a destination; fold to dashboard for persistence).
const WORKSPACE_TAB_TO_DESTINATION: Record<WorkspaceTab, DestinationTab> = {
  decision: "dashboard",
  assistant: "dashboard",
  market: "scan",
  macro: "dashboard",
  performance: "results",
  tax: "results",
  strategy: "strategy"
};

// feed: notifications → alert-history (retired noun); rest pass through.
const FEED_TAB_TO_DESTINATION: Record<FeedTab, FeedDestination> = {
  activity: "activity",
  runs: "runs",
  notifications: "alert-history",
  audit: "audit"
};

// ── Reverse mapping: destination → the WorkspaceTab it renders today ───────────
// Canonical panel per destination. `approvals` and `guardrails` have no distinct
// panel yet (they split out in later PRs); they resolve to the nearest current
// panel so the renderer can always answer "which panel does this destination
// show right now" without a gap.
const DESTINATION_TO_WORKSPACE_TAB: Record<DestinationTab, WorkspaceTab> = {
  dashboard: "decision",
  approvals: "decision",
  scan: "market",
  strategy: "strategy",
  guardrails: "strategy",
  results: "performance"
};

export function workspaceTabToDestination(tab: WorkspaceTab): DestinationTab {
  return WORKSPACE_TAB_TO_DESTINATION[tab];
}

export function feedTabToDestination(tab: FeedTab): FeedDestination {
  return FEED_TAB_TO_DESTINATION[tab];
}

// Renderer resolution: given a destination, which current panel renders.
export function destinationToWorkspaceTab(destination: DestinationTab): WorkspaceTab {
  return DESTINATION_TO_WORKSPACE_TAB[destination];
}

// ── NAV_V2 flag (env default + localStorage runtime override) ──────────────────
// The env var must be NEXT_PUBLIC_-prefixed to reach the client bundle. The
// localStorage override ("nav-v2") wins so the redesign can be toggled per-browser
// without a rebuild. Default: off (dark launch).
export const NAV_V2_OVERRIDE_KEY = "nav-v2";

function coerceFlag(raw: string | null | undefined): boolean | undefined {
  if (raw == null) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "on" || v === "true" || v === "yes") return true;
  if (v === "0" || v === "off" || v === "false" || v === "no") return false;
  return undefined;
}

export function isNavV2Enabled(storage?: Pick<Storage, "getItem"> | null): boolean {
  try {
    const override = coerceFlag(storage?.getItem(NAV_V2_OVERRIDE_KEY));
    if (override !== undefined) return override;
  } catch {
    /* ignore storage failures — fall through to env default */
  }
  return coerceFlag(process.env.NEXT_PUBLIC_NAV_V2) ?? false;
}

// STRATEGY_CONSOLIDATION (NAV_V2 PR #6) — dedicated sub-flag for the highest-risk
// TuningCard de-duplication. Off by default; when on, the twin TuningCard render
// site in the Strategy Studio modal is suppressed so a single instance renders.
// A bad merge is a flag flip, not a revert.
export const STRATEGY_CONSOLIDATION_OVERRIDE_KEY = "strategy-consolidation";

export function isStrategyConsolidationEnabled(storage?: Pick<Storage, "getItem"> | null): boolean {
  try {
    const override = coerceFlag(storage?.getItem(STRATEGY_CONSOLIDATION_OVERRIDE_KEY));
    if (override !== undefined) return override;
  } catch {
    /* ignore storage failures — fall through to env default */
  }
  return coerceFlag(process.env.NEXT_PUBLIC_STRATEGY_CONSOLIDATION) ?? false;
}

// ── One-time migration shim (flag-INDEPENDENT, additive-write, idempotent) ─────
// Runs on every client mount but only writes a destination key when it is absent
// and the matching legacy key holds a valid value. Legacy keys are left intact
// (a flag-off render path still reads them; their deletion is a later cleanup
// PR). Re-running is a no-op once the new keys exist. Returns whether it wrote.
type NavStorage = Pick<Storage, "getItem" | "setItem">;

export function migrateNavKeysToDestinations(storage: NavStorage): boolean {
  let wrote = false;
  try {
    if (storage.getItem(NAV_DESTINATION_KEY) == null) {
      const ws = storage.getItem(WORKSPACE_TAB_KEY);
      if (isWorkspaceTab(ws)) {
        storage.setItem(NAV_DESTINATION_KEY, workspaceTabToDestination(ws));
        wrote = true;
      }
    }
    if (storage.getItem(FEED_DESTINATION_KEY) == null) {
      const feed = storage.getItem(FEED_TAB_KEY);
      if (isFeedTab(feed)) {
        storage.setItem(FEED_DESTINATION_KEY, feedTabToDestination(feed));
        wrote = true;
      }
    }
  } catch {
    /* ignore storage failures — the legacy keys still drive rendering */
  }
  return wrote;
}
