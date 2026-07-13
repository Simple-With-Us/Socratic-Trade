"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, BellRing, Check, CheckCheck, ShieldAlert } from "lucide-react";
import { formatNotificationDisplay } from "@/lib/dashboard-ui";
import type { ConnectedAccount, NotificationEvent } from "@/lib/types";
import type { DashboardSnapshot } from "../../dashboard-types";
import { acknowledgeAllAttention, acknowledgeNotifications, ConsoleApiError } from "../lib/api";
import { cx } from "../lib/format";
import { notificationStatusLabel, notificationTypeLabel } from "../lib/labels";
import { useConsoleData } from "../lib/useConsoleData";
import { usePersistedState } from "../lib/usePersistedState";
import { Ago, Btn, Card, Chip, Empty, TextInput } from "../ui/primitives";
import { SymbolButton } from "../ui/symbol-drilldown";
import { useToast } from "../ui/toast";

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

/** Exported (only) for direct unit testing — see test/notification-lifecycle.test.ts, which imports
 *  this pure function without rendering the component (same idiom as test/console-sheet.test.tsx). */
export function matchesFilter(event: NotificationEvent, filter: AlertCenterFilter): boolean {
  switch (filter) {
    case "attention":
      // Acknowledged rows drop out of Attention (that's the point of acknowledging) but remain
      // visible under "All" — the "all" case below is unconditional on acknowledgedAt.
      return (
        !event.acknowledgedAt &&
        (event.type === "kill_switch" ||
          event.type === "run_failed" ||
          event.type === "budget_alert" ||
          event.type === "provider_degraded" ||
          event.status === "failed")
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
  const [filter, setFilter] = usePersistedState<AlertCenterFilter>("console:alerts:filter", "attention");
  const [query, setQuery] = useState("");
  const [ackingIds, setAckingIds] = useState<Set<string>>(new Set());
  const [bulkAcking, setBulkAcking] = useState(false);
  const { refresh } = useConsoleData();
  const toast = useToast();
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

  const filters: Array<{ id: AlertCenterFilter; label: string; count: number; hint: string }> = [
    {
      id: "attention",
      label: "Attention",
      count: summary.attention,
      hint: "Events that likely need you: kill switch, failed runs, budget alerts, degraded providers, failed deliveries."
    },
    { id: "deliveries", label: "Deliveries", count: summary.deliveries, hint: "Notification deliveries that failed or were skipped." },
    { id: "approvals", label: "Approvals", count: summary.approvals, hint: "Pending approvals, policy blocks, and withdrawn proposals." },
    { id: "all", label: "All", count: summary.total, hint: "Every alert in the current account scope." }
  ];

  const acknowledgeOne = async (id: string) => {
    setAckingIds((prev) => new Set(prev).add(id));
    try {
      await acknowledgeNotifications([id]);
      await refresh();
    } catch (error) {
      toast.push("neg", "Could not acknowledge alert", error instanceof ConsoleApiError ? error.message : String(error));
    } finally {
      setAckingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const acknowledgeAllVisible = async () => {
    setBulkAcking(true);
    try {
      // Scope the bulk ack to the account this view is actually filtered to (inScopeNotifications
      // above) — without this, "Acknowledge all" would also silently ack unacknowledged rows from
      // the user's OTHER connected accounts, which never appeared in this list at all.
      const result = await acknowledgeAllAttention(activeAccountId);
      await refresh();
      toast.push("pos", `Acknowledged ${result.acknowledged} alert${result.acknowledged === 1 ? "" : "s"}`);
    } catch (error) {
      toast.push("neg", "Could not acknowledge alerts", error instanceof ConsoleApiError ? error.message : String(error));
    } finally {
      setBulkAcking(false);
    }
  };

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

        {/* Wrapping pill row instead of a fixed 4-column tile grid: the uppercase tile headings
            clipped ("DELIVERIE…") in narrow rails. Pills wrap to any width, use sentence case,
            and signal the selected state with aria-pressed + weight, not color alone. */}
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Alert filters">
          {filters.map((item) => {
            const selected = filter === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setFilter(item.id)}
                aria-pressed={selected}
                title={item.hint}
                className={cx(
                  "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[length:var(--con-fs-xs)] transition-colors [@media(pointer:coarse)]:min-h-11",
                  selected
                    ? "border-[color:var(--con-accent)] bg-[color:var(--con-accent-soft)] font-bold text-[color:var(--con-accent)]"
                    : "border-[color:var(--con-line)] bg-[color:var(--con-surface-2)] font-semibold text-[color:var(--con-muted)] hover:border-[color:var(--con-line-strong)]"
                )}
              >
                {item.label}
                <span className="con-num font-semibold" aria-label={`${item.count} alerts`}>
                  {item.count}
                </span>
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2">
          <TextInput
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter alerts by symbol, title, account, or type"
            aria-label="Filter alerts"
            className="flex-1"
          />
          {filter === "attention" && summary.attention > 0 && (
            <Btn variant="outline" size="sm" disabled={bulkAcking} onClick={() => void acknowledgeAllVisible()} title="Acknowledge every alert currently in Attention">
              <CheckCheck size={13} /> Acknowledge all
            </Btn>
          )}
        </div>

        {visibleRows.length === 0 ? (
          <Empty>No alerts match this filter.</Empty>
        ) : (
          <div className="flex flex-col gap-2">
            {visibleRows.map((row) => {
              const acknowledged = Boolean(row.event.acknowledgedAt);
              const acking = ackingIds.has(row.event.id);
              return (
                <article
                  key={row.event.id}
                  className={cx(
                    "rounded-lg border border-[color:var(--con-line)] bg-[color:var(--con-surface-2)] px-3 py-3",
                    acknowledged && "opacity-60"
                  )}
                >
                  <div className="flex flex-wrap items-start gap-2">
                    <Chip tone={acknowledged ? "muted" : row.tone}>{notificationTypeLabel(row.event.type)}</Chip>
                    <Chip
                      tone={row.event.status === "failed" ? "neg" : row.event.status === "sent" ? "pos" : "muted"}
                    >
                      {notificationStatusLabel(row.event.status)}
                    </Chip>
                    {row.symbol && <SymbolButton symbol={row.symbol} showLogo={false} className="text-[length:var(--con-fs-xs)]" />}
                    <div className="ml-auto flex items-center gap-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                      <Ago iso={row.event.createdAt} />
                      {!acknowledged && (
                        <Btn
                          variant="ghost"
                          size="sm"
                          disabled={acking}
                          onClick={() => void acknowledgeOne(row.event.id)}
                          title="Acknowledge — clears this from Attention, stays visible under All"
                          aria-label="Acknowledge alert"
                        >
                          <Check size={13} />
                        </Btn>
                      )}
                    </div>
                  </div>
                  <div className="mt-2 flex items-start gap-2">
                    {!acknowledged && row.tone === "neg" ? (
                      <ShieldAlert size={14} className="mt-0.5 shrink-0 text-[color:var(--con-neg)]" />
                    ) : !acknowledged && row.tone === "warn" ? (
                      <AlertTriangle size={14} className="mt-0.5 shrink-0 text-[color:var(--con-warn)]" />
                    ) : null}
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-[color:var(--con-fg)]">{row.title}</p>
                      <p className="mt-0.5 text-[length:var(--con-fs-xs)] leading-relaxed text-[color:var(--con-muted)]">{row.detail}</p>
                      {(row.accountLabel || row.companyName || acknowledged) && (
                        <p className="mt-1 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                          {[
                            row.accountLabel ? `Account ${row.accountLabel}` : undefined,
                            row.companyName,
                            acknowledged ? "Acknowledged" : undefined
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                          {acknowledged && row.event.acknowledgedAt && (
                            <>
                              {" "}
                              <Ago iso={row.event.acknowledgedAt} />
                            </>
                          )}
                        </p>
                      )}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </Card>
  );
}
