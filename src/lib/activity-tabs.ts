/** Canonical Activity tabs for the website and the iOS Activity screen.
 *
 *  Owner 2026-08-21: order is Alerts Center, Notifications, Strategy Runs,
 *  Order Fills, Audit Log.  The former All unified feed is Audit Log.  Legacy
 *  `?tab=all` still opens Audit Log so old links keep working.
 */

export const ACTIVITY_TAB_IDS = ["alerts", "notifications", "runs", "fills", "audit"] as const;

export type ActivityTabId = (typeof ACTIVITY_TAB_IDS)[number];

export const DEFAULT_ACTIVITY_TAB: ActivityTabId = "alerts";

export const ACTIVITY_TABS: ReadonlyArray<{ id: ActivityTabId; label: string }> = [
  { id: "alerts", label: "Alerts Center" },
  { id: "notifications", label: "Notifications" },
  { id: "runs", label: "Strategy Runs" },
  { id: "fills", label: "Order Fills" },
  { id: "audit", label: "Audit Log" }
];

const TAB_ID_SET = new Set<string>(ACTIVITY_TAB_IDS);

/** Map a `?tab=` query (or iOS deep-link query) onto a canonical Activity tab. */
export function parseActivityTab(raw: string | null | undefined): ActivityTabId {
  if (!raw) return DEFAULT_ACTIVITY_TAB;
  const id = raw.trim().toLowerCase();
  if (id === "all") return "audit";
  if (TAB_ID_SET.has(id)) return id as ActivityTabId;
  return DEFAULT_ACTIVITY_TAB;
}

export function activityTabLabel(id: ActivityTabId): string {
  return ACTIVITY_TABS.find((tab) => tab.id === id)?.label ?? "Activity";
}
