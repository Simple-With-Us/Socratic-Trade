"use client";

/** The header bell — ONE canonical destination for the unread count.
 *
 *  ST-4645 / audit W3: the unread count used to appear TWICE with two
 *  different destinations. The bar bell opened this quick eight-item preview
 *  panel, while the Activity destination (desktop rail item and phone tab)
 *  opened the Activity page, whose FIRST tab is the Alerts Center. Two
 *  badges, two destinations, and the preview was a strict subset of the
 *  Alerts Center — which shows up to a hundred rows with filters, search,
 *  per-row acknowledge and acknowledge-all.
 *
 *  Now the bell IS a link to the Alerts Center and the count badge rides the
 *  Activity destination, so one count has one destination. The parallel iOS
 *  lane is pointing the native bell at the same Alerts Center, so both apps
 *  point at one place.
 *
 *  Nothing was dropped: the Alerts Center carries the same notification rows
 *  (and the same acknowledge actions), and Activity's second tab is the full
 *  Notifications ledger. */

import Link from "next/link";
import { Bell } from "lucide-react";
import { unreadNotificationCount } from "@/lib/notification-history";
import type { DashboardSnapshot } from "../../dashboard-types";
import { activeConnectedAccount } from "../lib/derive";

/** The canonical destination for the unread count — the Alerts Center. */
export const ALERTS_CENTER_HREF = "/console/activity?tab=alerts";

export function NotificationInbox({ snapshot }: { snapshot: DashboardSnapshot }) {
  const activeAccountId = activeConnectedAccount(snapshot)?.id;
  const unread = unreadNotificationCount(snapshot.notifications ?? [], activeAccountId);
  return (
    <Link
      href={ALERTS_CENTER_HREF}
      title={
        unread > 0
          ? `${unread} unread alert${unread === 1 ? "" : "s"} — open the Alerts Center`
          : "Alerts Center"
      }
      aria-label={unread > 0 ? `Alerts Center, ${unread} unread` : "Alerts Center"}
      className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-control border border-[color:var(--con-line-strong)] text-[color:var(--con-muted)] transition-colors hover:border-[color:var(--con-accent)] hover:text-[color:var(--con-accent)] [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"
    >
      <Bell size={14} aria-hidden />
      {unread > 0 && (
        <span className="con-badge absolute -right-1.5 -top-1.5 min-w-4 px-1">{unread > 99 ? "99+" : unread}</span>
      )}
    </Link>
  );
}
