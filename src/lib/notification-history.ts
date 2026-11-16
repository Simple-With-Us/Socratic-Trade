import { formatNotificationDisplay } from "./dashboard-ui";
import { deliveryChannelLabel } from "./notification-delivery";
import type { ConnectedAccount, NotificationEvent } from "./types";

/** Slim, already-worded inbox row.  Same recency window as the dashboard Alert Center (100). */
export const NOTIFICATION_HISTORY_LIMIT = 100;

export type NotificationHistoryItem = {
  id: string;
  createdAt: string;
  type: string;
  title: string;
  body: string;
  read: boolean;
  status: string;
  acknowledgedAt: string | null;
  connectedAccountId?: string;
  accountLabel?: string;
  channel?: string;
};

export function inScopeNotificationEvents<T extends { connectedAccountId?: string }>(
  events: T[],
  activeAccountId?: string
): T[] {
  if (!activeAccountId) return [...events];
  return events.filter((event) => !event.connectedAccountId || event.connectedAccountId === activeAccountId);
}

export function unreadNotificationCount(
  events: Array<{ connectedAccountId?: string; acknowledgedAt?: string; read?: boolean }>,
  activeAccountId?: string
): number {
  return inScopeNotificationEvents(events, activeAccountId).filter((event) => {
    if (typeof event.read === "boolean") return !event.read;
    return !event.acknowledgedAt;
  }).length;
}

export function buildNotificationHistory(input: {
  notifications: NotificationEvent[];
  symbolMetaBySymbol?: Record<string, { companyName?: string }>;
  connectedAccounts?: ConnectedAccount[];
  limit?: number;
}): NotificationHistoryItem[] {
  const labels = Object.fromEntries(
    (input.connectedAccounts ?? []).map((account) => [account.id, account.label || account.broker])
  );
  const meta = input.symbolMetaBySymbol ?? {};
  const limit = input.limit ?? NOTIFICATION_HISTORY_LIMIT;
  return [...input.notifications]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, limit)
    .map((event) => {
      const display = formatNotificationDisplay(event, meta);
      const accountLabel = event.connectedAccountId ? labels[event.connectedAccountId] : undefined;
      return {
        id: event.id,
        createdAt: event.createdAt,
        type: event.type,
        title: display.title,
        body: display.detail,
        read: Boolean(event.acknowledgedAt),
        status: event.status,
        acknowledgedAt: event.acknowledgedAt ?? null,
        ...(event.connectedAccountId ? { connectedAccountId: event.connectedAccountId } : {}),
        ...(accountLabel ? { accountLabel } : {}),
        channel: deliveryChannelLabel(event)
      };
    });
}
