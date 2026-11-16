"use client";

import { useMemo, useState } from "react";
import { formatNotificationDisplay } from "@/lib/dashboard-ui";
import {
  DELIVERY_CHANNEL_FILTERS,
  deliveryChannelLabel,
  matchesDeliveryChannelFilter,
  type DeliveryChannelFilter
} from "@/lib/notification-delivery";
import type { ConnectedAccount, NotificationEvent } from "@/lib/types";
import type { DashboardSnapshot } from "../../dashboard-types";
import { cx, SENTENCE_GAP } from "../lib/format";
import { notificationStatusLabel } from "../lib/labels";
import { Ago, Chip } from "../ui/primitives";
import { DayGroups } from "./day-groups";
import { activityStatusTone } from "./status-tone";

function accountLabelMap(accounts: ConnectedAccount[]): Record<string, string> {
  return Object.fromEntries(accounts.map((account) => [account.id, account.label || account.broker]));
}

export function NotificationsLedger({
  notifications,
  connectedAccounts,
  symbolMetaBySymbol,
  activeAccountId
}: {
  notifications: NotificationEvent[];
  connectedAccounts: ConnectedAccount[];
  symbolMetaBySymbol: DashboardSnapshot["symbolMetaBySymbol"];
  activeAccountId?: string;
}) {
  const [channel, setChannel] = useState<DeliveryChannelFilter>("all");
  const labels = useMemo(() => accountLabelMap(connectedAccounts), [connectedAccounts]);
  const scoped = useMemo(() => {
    if (!activeAccountId) return notifications;
    return notifications.filter((event) => !event.connectedAccountId || event.connectedAccountId === activeAccountId);
  }, [notifications, activeAccountId]);
  const visible = useMemo(
    () => scoped.filter((event) => matchesDeliveryChannelFilter(event, channel)),
    [scoped, channel]
  );

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[length:var(--con-fs-sm)] leading-relaxed text-[color:var(--con-muted)]">
        Every send this app made.{SENTENCE_GAP}Push, email, SMS, or Pushover.
      </p>
      <div className="flex flex-wrap gap-1" role="group" aria-label="Filter by channel">
        {DELIVERY_CHANNEL_FILTERS.map((filter) => (
          <button
            key={filter.id}
            type="button"
            onClick={() => setChannel(filter.id)}
            className={cx(
              "min-h-11 rounded-control px-3 text-[length:var(--con-fs-xs)] font-semibold",
              channel === filter.id
                ? "bg-[color:var(--con-accent-soft)] text-[color:var(--con-accent)]"
                : "text-[color:var(--con-muted)] hover:text-[color:var(--con-fg)]"
            )}
          >
            {filter.label}
          </button>
        ))}
      </div>
      <DayGroups
        items={visible}
        timestamp={(event) => event.createdAt}
        emptyText={channel === "all" ? "No delivery records yet." : "No matching events."}
        renderItem={(event) => {
          const display = formatNotificationDisplay(event, symbolMetaBySymbol ?? {});
          const account = event.connectedAccountId ? labels[event.connectedAccountId] : undefined;
          return (
            <div key={event.id} className="con-card flex flex-col gap-2 px-4 py-3">
              <div className="flex flex-wrap items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-[color:var(--con-fg)]">{display.title}</p>
                  <p className="mt-1 text-[length:var(--con-fs-sm)] leading-relaxed text-[color:var(--con-muted)]">
                    {display.detail}
                  </p>
                </div>
                <Chip tone={activityStatusTone(event.status)}>{notificationStatusLabel(event.status)}</Chip>
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                <span>{deliveryChannelLabel(event)}</span>
                {account ? <span>{account}</span> : null}
                <span className="ml-auto">
                  <Ago iso={event.createdAt} />
                </span>
              </div>
            </div>
          );
        }}
      />
    </div>
  );
}
