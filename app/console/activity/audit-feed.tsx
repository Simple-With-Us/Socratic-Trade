"use client";

/** Audit Log — the former All unified feed, grouped by day, with a System
 *  bucket for housekeeping.  Raw JSON stays behind Raw Events. */

import { useMemo } from "react";
import { OPS_AUDIT_KINDS, type UnifiedActivitySubEvent } from "@/lib/dashboard-feed";
import { plainEnglishRunFailure } from "@/lib/strategy-run-failure";
import type { UnifiedActivityGroup } from "../../dashboard-types";
import { activeConnectedAccount } from "../lib/derive";
import { SENTENCE_GAP } from "../lib/format";
import { feedStatusLabel } from "../lib/labels";
import { useConsoleData } from "../lib/useConsoleData";
import { Ago, Chip } from "../ui/primitives";
import { DayGroups } from "./day-groups";
import { activityStatusTone } from "./status-tone";
import { AuditLogPanel } from "./audit-log";

function auditKind(e: UnifiedActivitySubEvent): string | undefined {
  if (e.type !== "audit" || !e.raw || typeof e.raw !== "object") return undefined;
  const kind = (e.raw as { kind?: unknown }).kind;
  return typeof kind === "string" ? kind : undefined;
}

function isOpsGroup(g: UnifiedActivityGroup): boolean {
  return g.events.length > 0 && g.events.every((e) => OPS_AUDIT_KINDS.has(auditKind(e) ?? ""));
}

function RawToggle({ text }: { text: string | undefined }) {
  if (!text || !text.trim().startsWith("{")) return null;
  return (
    <details className="mt-1">
      <summary className="cursor-pointer text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
        Raw Events
      </summary>
      <pre className="con-mono mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-control bg-[color:var(--con-surface-2)] p-2 text-[length:var(--con-fs-2xs)] leading-relaxed text-[color:var(--con-muted)]">
        {text}
      </pre>
    </details>
  );
}

export function AuditFeed({ groups }: { groups: UnifiedActivityGroup[] }) {
  const { snapshot } = useConsoleData();
  const activeAccountId = snapshot ? activeConnectedAccount(snapshot)?.id : undefined;
  const multiAccount = (snapshot?.connectedAccounts.length ?? 0) > 1;

  const { visible, system, hiddenOtherAccount } = useMemo(() => {
    const sorted = [...groups].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    const inScope = sorted.filter((g) => !g.connectedAccountId || g.connectedAccountId === activeAccountId);
    const hiddenOtherAccount = sorted.length - inScope.length;
    return {
      visible: inScope.filter((g) => !isOpsGroup(g)).slice(0, 60),
      system: inScope.filter(isOpsGroup).slice(0, 40),
      hiddenOtherAccount
    };
  }, [groups, activeAccountId]);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[length:var(--con-fs-sm)] leading-relaxed text-[color:var(--con-muted)]">
        The decision journal, grouped by day.{SENTENCE_GAP}Raw JSON stays behind Raw Events.
      </p>
      {hiddenOtherAccount > 0 && (
        <p className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
          {hiddenOtherAccount} event{hiddenOtherAccount === 1 ? "" : "s"} from your other accounts{" "}
          {hiddenOtherAccount === 1 ? "is" : "are"} not shown — switch the account scope to see them.
        </p>
      )}
      <DayGroups
        items={visible}
        timestamp={(g) => g.updatedAt}
        emptyText="No audit events yet."
        renderItem={(g) => <FeedGroupCard key={g.id} g={g} multiAccount={multiAccount} />}
      />
      {system.length > 0 && <SystemBucket groups={system} />}
      <details className="con-card px-4 py-3">
        <summary className="cursor-pointer font-semibold">Raw Events</summary>
        <div className="mt-3 border-t border-[color:var(--con-line)] pt-3">
          <AuditLogPanel />
        </div>
      </details>
    </div>
  );
}

function FeedGroupCard({ g, multiAccount }: { g: UnifiedActivityGroup; multiAccount: boolean }) {
  const subEvents = g.events.filter((e) => !(e.title === g.title && e.detail === g.detail));
  const bodyText = g.fullText && g.fullText !== g.detail && !g.fullText.trim().startsWith("{") ? g.fullText : null;
  const failure =
    g.status === "failed"
      ? plainEnglishRunFailure({ status: g.status, summary: g.detail, payload: undefined })
      : null;
  return (
    <details className="con-card con-disclosure px-4 py-1">
      <summary>
        <span className="min-w-0 flex-1">
          <span className="block font-semibold text-[color:var(--con-fg)]">{g.title}</span>
          <span className="block text-[length:var(--con-fs-xs)] font-normal leading-relaxed text-[color:var(--con-faint)]">
            {g.detail}
          </span>
        </span>
        {g.status && <Chip tone={activityStatusTone(g.status)}>{feedStatusLabel(g.status)}</Chip>}
        <span className="text-[length:var(--con-fs-xs)] font-normal text-[color:var(--con-faint)]">
          <Ago iso={g.updatedAt} />
        </span>
      </summary>
      <div className="border-t border-[color:var(--con-line)] py-3">
        {failure && failure !== g.detail && (
          <p className="mb-2 text-[length:var(--con-fs-sm)] leading-relaxed text-[color:var(--con-neg)]">
            <span className="font-semibold">Failure.{SENTENCE_GAP}</span>
            {failure}
          </p>
        )}
        {bodyText && (
          <p className="mb-2 text-[length:var(--con-fs-sm)] leading-relaxed text-[color:var(--con-muted)]">{bodyText}</p>
        )}
        {subEvents.length > 0 && (
          <ul className="flex flex-col gap-1.5">
            {subEvents.map((e) => (
              <li key={e.id} className="flex items-start gap-2 text-[length:var(--con-fs-xs)]">
                <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--con-faint)]" />
                <span className="min-w-0 flex-1">
                  <span className="font-semibold">{e.title}</span>{" "}
                  <span className="text-[color:var(--con-muted)]">{e.detail}</span>
                  {e.error && <span className="text-[color:var(--con-neg)]"> — {e.error}</span>}
                  {e.fullText && e.fullText !== e.detail && <RawToggle text={e.fullText} />}
                </span>
                <span className="shrink-0 text-[color:var(--con-faint)]">
                  <Ago iso={e.createdAt} />
                </span>
              </li>
            ))}
          </ul>
        )}
        {subEvents.length === 0 && g.events.length === 0 && (
          <p className="py-1 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">No sub-events recorded.</p>
        )}
        <RawToggle text={g.fullText !== g.detail ? g.fullText : undefined} />
        {g.accountLabel ? (
          <p className="mt-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">Account: {g.accountLabel}</p>
        ) : multiAccount && !g.events.some((e) => e.type === "fill" || e.type === "order") ? (
          <p className="mt-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
            Account: unknown — recorded without an account tag, so it may concern any of your accounts.
          </p>
        ) : null}
      </div>
    </details>
  );
}

function SystemBucket({ groups }: { groups: UnifiedActivityGroup[] }) {
  return (
    <details className="con-card con-disclosure px-4">
      <summary>
        <span className="min-w-0 flex-1">
          <span className="block font-semibold text-[color:var(--con-fg)]">System</span>
          <span className="block text-[length:var(--con-fs-xs)] font-normal text-[color:var(--con-faint)]">
            {groups.length} background event{groups.length === 1 ? "" : "s"} — data refreshes and housekeeping, no
            account decisions
          </span>
        </span>
      </summary>
      <ul className="flex flex-col gap-1.5 border-t border-[color:var(--con-line)] py-2">
        {groups.map((g) => (
          <li key={g.id} className="flex items-start gap-2 text-[length:var(--con-fs-xs)]">
            <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--con-faint)]" />
            <span className="min-w-0 flex-1">
              <span className="font-semibold">{g.title}</span>{" "}
              <span className="text-[color:var(--con-muted)]">{g.detail}</span>
              <RawToggle text={g.fullText !== g.detail ? g.fullText : undefined} />
            </span>
            <span className="shrink-0 text-[color:var(--con-faint)]">
              <Ago iso={g.updatedAt} />
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}
