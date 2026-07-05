"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, BellRing, ShieldAlert } from "lucide-react";
import { formatNotificationDisplay } from "@/lib/dashboard-ui";
import type { ConnectedAccount, NotificationEvent } from "@/lib/types";
import type { DashboardSnapshot } from "../../dashboard-types";
import { cx } from "../lib/format";
import { Ago, Card, Chip, Empty, TextInput } from "../ui/primitives";
import { SymbolButton } from "../ui/symbol-drilldown";

type AlertCenterFilter = "attention" | "deliveries" | "approvals" | "all";

type AlertCenterRow = {
  event: NotificationEvent;
  title: string;
  detail: string;
  symbol?: string;
  companyName?: string;
  accountLabel?: string;
  tone: "neg" | "warn" | "accent" | "muted";
};

function accountLabelMap(accounts: ConnectedAccount[]): Record<string, string> {
  return Object.fromEntries(accounts.map((account) => [account.id, account.label || account.broker]));
}

function inScopeNotifications(notifications: NotificationEvent[], activeAccountId?: string) {
  if (!activeAccountId) return { events: [...notifications], hiddenOtherAccount: 0 };
  const events = notifications.filter((event) => !event.connectedAccountId || event.connectedAccountId === activeAccountId);
  return { events, hiddenOtherAccount: notifications.length - events.length };
}

function alertTone(event: NotificationEvent): AlertCenterRow["tone"] {
  if (event.type === "kill_switch" || event.type === "run_failed") return "neg";
  if (event.status === "failed" || event.type === "budget_alert" || event.type === "provider_degraded") return "warn";
  if (event.type === "pending_approval") return "accent";
  return "muted";
}

function matchesFilter(event: NotificationEvent, filter: AlertCenterFilter): boolean {
  switch (filter) {
    case "attention":
      return (
        event.type === "kill_switch" ||
        event.type === "run_failed" ||
        event.type === "budget_alert" ||
        event.type === "provider_degraded" ||
        event.status === "failed"
      );
    case "deliveries":
      return event.status === "failed" || event.status === "skipped";
    case "approvals":
      return event.type === "pending_approval" || event.type === "block" || event.type === "proposal_withdrawn";
    case "all":
    default:
      return true;
  }
}

function matchesQuery(row: AlertCenterRow, query: string): boolean {
  if (!query) return true;
  const haystack = [row.title, row.detail, row.symbol, row.companyName, row.accountLabel, row.event.type]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ")
    .toLowerCase();
  return haystack.includes(query);
}

function buildRows(
  notifications: NotificationEvent[],
  symbolMetaBySymbol: DashboardSnapshot["symbolMetaBySymbol"],
  connectedAccounts: ConnectedAccount[]
): AlertCenterRow[] {
  const labels = accountLabelMap(connectedAccounts);
  return notifications
    .slice()
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .map((event) => {
      const display = formatNotificationDisplay(event, symbolMetaBySymbol);
      return {
        event,
        title: display.title,
        detail: display.detail,
        symbol: display.symbol,
        companyName: display.companyName,
        accountLabel: event.connectedAccountId ? labels[event.connectedAccountId] : undefined,
        tone: alertTone(event)
      };
    });
}

export function AlertCenter({
  notifications,
  connectedAccounts,
  symbolMetaBySymbol,
  activeAccountId,
  title = "Alert center",
  maxItems
}: {
  notifications: NotificationEvent[];
  connectedAccounts: ConnectedAccount[];
  symbolMetaBySymbol: DashboardSnapshot["symbolMetaBySymbol"];
  activeAccountId?: string;
  title?: string;
  maxItems?: number;
}) {
  const [filter, setFilter] = useState<AlertCenterFilter>("attention");
  const [query, setQuery] = useState("");
  const { events, hiddenOtherAccount } = useMemo(
    () => inScopeNotifications(notifications, activeAccountId),
    [notifications, activeAccountId]
  );
  const rows = useMemo(
    () => buildRows(events, symbolMetaBySymbol, connectedAccounts),
    [events, symbolMetaBySymbol, connectedAccounts]
  );
  const normalizedQuery = query.trim().toLowerCase();
  const visibleRows = useMemo(() => {
    const filtered = rows.filter((row) => matchesFilter(row.event, filter) && matchesQuery(row, normalizedQuery));
    return typeof maxItems === "number" ? filtered.slice(0, maxItems) : filtered;
  }, [rows, filter, normalizedQuery, maxItems]);

  const summary = useMemo(
    () => ({
      attention: rows.filter((row) => matchesFilter(row.event, "attention")).length,
      deliveries: rows.filter((row) => matchesFilter(row.event, "deliveries")).length,
      approvals: rows.filter((row) => matchesFilter(row.event, "approvals")).length,
      total: rows.length
    }),
    [rows]
  );

  const filters: Array<{ id: AlertCenterFilter; label: string; count: number }> = [
    { id: "attention", label: "Attention", count: summary.attention },
    { id: "deliveries", label: "Deliveries", count: summary.deliveries },
    { id: "approvals", label: "Approvals", count: summary.approvals },
    { id: "all", label: "All", count: summary.total }
  ];

  return (
    <Card
      title={
        <span className="flex items-center gap-1.5">
          <BellRing size={13} /> {title}
        </span>
      }
    >
      <div className="flex flex-col gap-3">
        {hiddenOtherAccount > 0 && (
          <p className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
            {hiddenOtherAccount} alert{hiddenOtherAccount === 1 ? "" : "s"} from your other accounts{" "}
            {hiddenOtherAccount === 1 ? "is" : "are"} hidden by the current account scope.
          </p>
        )}

        <div className="grid gap-2 sm:grid-cols-4">
          {filters.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setFilter(item.id)}
              className={cx(
                "rounded-lg border px-3 py-2 text-left transition-colors",
                filter === item.id
                  ? "border-[color:var(--con-accent)] bg-[color:var(--con-accent-soft)]"
                  : "border-[color:var(--con-line)] bg-[color:var(--con-surface-2)] hover:border-[color:var(--con-line-strong)]"
              )}
            >
              <div className="con-card-title">{item.label}</div>
              <div className="con-num mt-1 text-[length:var(--con-fs-lg)] font-semibold">{item.count}</div>
            </button>
          ))}
        </div>

        <TextInput
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter alerts by symbol, title, account, or type"
          aria-label="Filter alerts"
        />

        {visibleRows.length === 0 ? (
          <Empty>No alerts match this filter.</Empty>
        ) : (
          <div className="flex flex-col gap-2">
            {visibleRows.map((row) => (
              <article key={row.event.id} className="rounded-lg border border-[color:var(--con-line)] bg-[color:var(--con-surface-2)] px-3 py-3">
                <div className="flex flex-wrap items-start gap-2">
                  <Chip tone={row.tone}>{row.event.type}</Chip>
                  <Chip
                    tone={row.event.status === "failed" ? "neg" : row.event.status === "sent" ? "pos" : "muted"}
                  >
                    {row.event.status}
                  </Chip>
                  {row.symbol && <SymbolButton symbol={row.symbol} showLogo={false} className="text-[length:var(--con-fs-xs)]" />}
                  <div className="ml-auto text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                    <Ago iso={row.event.createdAt} />
                  </div>
                </div>
                <div className="mt-2 flex items-start gap-2">
                  {row.tone === "neg" ? (
                    <ShieldAlert size={14} className="mt-0.5 shrink-0 text-[color:var(--con-neg)]" />
                  ) : row.tone === "warn" ? (
                    <AlertTriangle size={14} className="mt-0.5 shrink-0 text-[color:var(--con-warn)]" />
                  ) : null}
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-[color:var(--con-fg)]">{row.title}</p>
                    <p className="mt-0.5 text-[length:var(--con-fs-xs)] leading-relaxed text-[color:var(--con-muted)]">{row.detail}</p>
                    {(row.accountLabel || row.companyName) && (
                      <p className="mt-1 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                        {[row.accountLabel ? `Account ${row.accountLabel}` : undefined, row.companyName].filter(Boolean).join(" · ")}
                      </p>
                    )}
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}
