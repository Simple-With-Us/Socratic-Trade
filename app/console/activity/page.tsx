"use client";

/** Activity — the append-only story: runs (expandable to what each proposed /
 *  blocked, straight from the persisted records), fills, and notification
 *  events, grouped chronologically. Uses only what the snapshot actually
 *  provides — no invented data. */

import { useMemo, useState } from "react";
import type { FillEvent, RecentProposal, StrategyRunRow } from "@/lib/types";
import { OPS_AUDIT_KINDS, type UnifiedActivitySubEvent } from "@/lib/dashboard-feed";
import type { UnifiedActivityGroup } from "../../dashboard-types";
import { activeConnectedAccount, realityForMode } from "../lib/derive";
import { cx, dayKey, fmtDay, fmtMoney, fmtPct, fmtQty, EM_DASH } from "../lib/format";
import { useConsoleData } from "../lib/useConsoleData";
import { AlertCenter } from "../components/alert-center";
import { Ago, Card, Chip, Empty, SignedText, type ChipTone } from "../ui/primitives";
import { SymbolButton } from "../ui/symbol-drilldown";

type Tab = "all" | "runs" | "fills" | "alerts";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "all", label: "All" },
  { id: "runs", label: "Runs" },
  { id: "fills", label: "Fills" },
  { id: "alerts", label: "Alert center" }
];

export default function ActivityPage() {
  const { snapshot } = useConsoleData();
  const [tab, setTab] = useState<Tab>("all");
  if (!snapshot) return null;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-[length:var(--con-fs-lg)] font-bold">Activity</h1>
        <div className="flex gap-1 rounded-lg border border-[color:var(--con-line)] bg-[color:var(--con-surface)] p-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={cx(
                "rounded-md px-3 py-1 text-[length:var(--con-fs-xs)] font-semibold transition-colors",
                tab === t.id
                  ? "bg-[color:var(--con-accent-soft)] text-[color:var(--con-accent)]"
                  : "text-[color:var(--con-muted)] hover:text-[color:var(--con-fg)]"
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {tab === "all" && <UnifiedFeed groups={snapshot.unifiedFeed ?? []} />}
      {tab === "runs" && <RunsList runs={snapshot.strategyRuns ?? []} recentProposals={snapshot.recentProposals ?? []} />}
      {tab === "fills" && <FillsList fills={snapshot.performance?.fills ?? []} />}
      {tab === "alerts" && (
        <AlertCenter
          notifications={snapshot.notifications ?? []}
          connectedAccounts={snapshot.connectedAccounts}
          symbolMetaBySymbol={snapshot.symbolMetaBySymbol}
          activeAccountId={activeConnectedAccount(snapshot)?.id}
          maxItems={100}
        />
      )}
    </div>
  );
}

// ── All (unified feed) ───────────────────────────────────────────────────────

const STATUS_TONE: Record<string, ChipTone> = {
  placed: "pos",
  filled: "pos",
  paper: "pos",
  completed: "pos",
  proposed: "accent",
  pending: "accent",
  blocked: "warn",
  withdrawn: "muted",
  expired: "muted",
  rejected: "muted",
  rejected_by_broker: "neg",
  placing_failed: "neg",
  pending_reconciliation: "warn",
  failed: "neg",
  sent: "pos",
  skipped: "muted"
};

function statusTone(status: string | undefined): ChipTone {
  if (!status) return "muted";
  return STATUS_TONE[status.toLowerCase()] ?? "muted";
}

function DayGroups<T>({
  items,
  timestamp,
  renderItem,
  emptyText
}: {
  items: T[];
  timestamp: (item: T) => string;
  renderItem: (item: T) => React.ReactNode;
  emptyText: string;
}) {
  const groups = useMemo(() => {
    const byDay = new Map<string, T[]>();
    for (const item of items) {
      const key = dayKey(timestamp(item));
      const list = byDay.get(key) ?? [];
      list.push(item);
      byDay.set(key, list);
    }
    return [...byDay.entries()];
  }, [items, timestamp]);

  if (items.length === 0) return <Card><Empty>{emptyText}</Empty></Card>;

  return (
    <div className="flex flex-col gap-4">
      {groups.map(([key, list]) => (
        <div key={key}>
          <div className="con-card-title mb-2 pl-1">{fmtDay(timestamp(list[0]))}</div>
          <div className="flex flex-col gap-2">{list.map(renderItem)}</div>
        </div>
      ))}
    </div>
  );
}

function auditKind(e: UnifiedActivitySubEvent): string | undefined {
  if (e.type !== "audit" || !e.raw || typeof e.raw !== "object") return undefined;
  const kind = (e.raw as { kind?: unknown }).kind;
  return typeof kind === "string" ? kind : undefined;
}

/** Pure-ops group: every sub-event is a background/housekeeping audit event
 *  (web-source refreshes, daily share batches). Collapsed into "System". */
function isOpsGroup(g: UnifiedActivityGroup): boolean {
  return g.events.length > 0 && g.events.every((e) => OPS_AUDIT_KINDS.has(auditKind(e) ?? ""));
}

/** Raw payloads never render inline — they live behind an explicit toggle. */
function RawToggle({ text }: { text: string | undefined }) {
  if (!text || !text.trim().startsWith("{")) return null;
  return (
    <details className="mt-1">
      <summary className="cursor-pointer text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">raw data</summary>
      <pre className="con-mono mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md bg-[color:var(--con-surface-2)] p-2 text-[10px] leading-relaxed text-[color:var(--con-muted)]">
        {text}
      </pre>
    </details>
  );
}

function UnifiedFeed({ groups }: { groups: UnifiedActivityGroup[] }) {
  const { snapshot } = useConsoleData();
  const activeAccountId = snapshot ? activeConnectedAccount(snapshot)?.id : undefined;
  const multiAccount = (snapshot?.connectedAccounts.length ?? 0) > 1;

  const { visible, system, hiddenOtherAccount } = useMemo(() => {
    const sorted = [...groups].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    // Account scoping (#10): a group tagged with a DIFFERENT account never renders in
    // this account's feed. Untagged groups stay visible (fills/orders are already
    // account-scoped server-side; legacy audit/notification rows are labeled unknown).
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
      {hiddenOtherAccount > 0 && (
        <p className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
          {hiddenOtherAccount} event{hiddenOtherAccount === 1 ? "" : "s"} from your other accounts{" "}
          {hiddenOtherAccount === 1 ? "is" : "are"} not shown — switch the account scope to see them.
        </p>
      )}
      <DayGroups
        items={visible}
        timestamp={(g) => g.updatedAt}
        emptyText="Nothing has happened yet. Run the strategy once and its story starts here."
        renderItem={(g) => <FeedGroupCard key={g.id} g={g} multiAccount={multiAccount} />}
      />
      {system.length > 0 && <SystemBucket groups={system} />}
    </div>
  );
}

function FeedGroupCard({ g, multiAccount }: { g: UnifiedActivityGroup; multiAccount: boolean }) {
  // De-duplication (#8): the summary line already shows title + detail, so the body
  // must not repeat them — no fullText echo, and no sub-row that just restates the card.
  const subEvents = g.events.filter((e) => !(e.title === g.title && e.detail === g.detail));
  const bodyText = g.fullText && g.fullText !== g.detail && !g.fullText.trim().startsWith("{") ? g.fullText : null;
  return (
    <details className="con-card con-disclosure px-4">
      <summary>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-semibold text-[color:var(--con-fg)]">{g.title}</span>
          <span className="block truncate text-[length:var(--con-fs-xs)] font-normal text-[color:var(--con-faint)]">
            {g.detail}
          </span>
        </span>
        {g.status && <Chip tone={statusTone(g.status)}>{g.status}</Chip>}
        <span className="text-[length:var(--con-fs-xs)] font-normal text-[color:var(--con-faint)]">
          <Ago iso={g.updatedAt} />
        </span>
      </summary>
      <div className="border-t border-[color:var(--con-line)] py-2">
        {bodyText && <p className="mb-2 text-[length:var(--con-fs-sm)] leading-relaxed text-[color:var(--con-muted)]">{bodyText}</p>}
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

/** Collapsed "System" bucket (#9/#11): background data refreshes and housekeeping,
 *  humanized one line each, raw JSON behind an explicit toggle. */
function SystemBucket({ groups }: { groups: UnifiedActivityGroup[] }) {
  return (
    <details className="con-card con-disclosure px-4">
      <summary>
        <span className="min-w-0 flex-1">
          <span className="block font-semibold text-[color:var(--con-fg)]">System</span>
          <span className="block truncate text-[length:var(--con-fs-xs)] font-normal text-[color:var(--con-faint)]">
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

// ── Runs ─────────────────────────────────────────────────────────────────────

function runDuration(run: StrategyRunRow): string {
  if (!run.finishedAt) return EM_DASH;
  const ms = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return EM_DASH;
  return ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`;
}

const SIDE_LABEL: Record<string, string> = { buy: "BUY", sell: "SELL", short: "SHORT", cover: "COVER" };

function RunsList({ runs, recentProposals }: { runs: StrategyRunRow[]; recentProposals: RecentProposal[] }) {
  const byRun = useMemo(() => {
    const map = new Map<string, RecentProposal[]>();
    for (const p of recentProposals) {
      const list = map.get(p.runId) ?? [];
      list.push(p);
      map.set(p.runId, list);
    }
    return map;
  }, [recentProposals]);

  return (
    <DayGroups
      items={runs}
      timestamp={(r) => r.startedAt}
      emptyText="No strategy runs yet."
      renderItem={(run) => {
        const proposals = byRun.get(run.id) ?? [];
        return (
          <details key={run.id} className="con-card con-disclosure px-4">
            <summary>
              <span className="min-w-0 flex-1">
                <span className="block font-semibold text-[color:var(--con-fg)]">
                  Run · <Ago iso={run.startedAt} /> · {runDuration(run)}
                </span>
                <span className="con-num block text-[length:var(--con-fs-xs)] font-normal text-[color:var(--con-faint)]">
                  {run.proposedCount} proposed · {run.placedCount} placed · {run.paperCount} simulated · {run.blockedCount} blocked
                </span>
              </span>
              <Chip tone={run.status === "failed" ? "neg" : run.status === "running" ? "accent" : "pos"}>{run.status}</Chip>
            </summary>
            <div className="border-t border-[color:var(--con-line)] py-2">
              {run.summary && <p className="mb-2 text-[length:var(--con-fs-sm)] leading-relaxed text-[color:var(--con-muted)]">{run.summary}</p>}
              {run.status === "completed" && run.totalCount === 0 && (
                <p className="mb-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                  Did nothing on purpose — no candidate cleared the bar this run.
                </p>
              )}
              {proposals.length > 0 ? (
                <ul className="flex flex-col gap-2">
                  {proposals.map((p) => {
                    const r = realityForMode(p.executionMode);
                    return (
                      <li key={p.id} className="rounded-lg border border-[color:var(--con-line)] p-2.5 text-[length:var(--con-fs-xs)]">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[length:var(--con-fs-sm)] font-bold">
                            {SIDE_LABEL[p.proposal.side] ?? p.proposal.side} <SymbolButton symbol={p.proposal.symbol} showLogo={false} />
                          </span>
                          <span className="con-num text-[color:var(--con-muted)]">
                            {typeof p.estimatedNotional === "number"
                              ? `~${fmtMoney(p.estimatedNotional)}`
                              : typeof p.proposal.dollarAmount === "number"
                                ? `~${fmtMoney(p.proposal.dollarAmount)}`
                                : typeof p.proposal.quantity === "number"
                                  ? `${fmtQty(p.proposal.quantity)} sh`
                                  : EM_DASH}
                          </span>
                          <Chip tone={statusTone(p.status)}>{p.status}</Chip>
                          <Chip tone={r.tone}>{r.word}</Chip>
                          {typeof p.performanceSinceProposalPct === "number" && (
                            <span title="Raw side-adjusted move since the proposal's reference price, not benchmark-relative. For a rejected idea this is the counterfactual; SPY comparison lives in Results.">
                              <SignedText value={p.performanceSinceProposalPct}>
                                since: {fmtPct(p.performanceSinceProposalPct, 2, true)}
                              </SignedText>
                            </span>
                          )}
                        </div>
                        <p className="mt-1 leading-relaxed text-[color:var(--con-muted)]">{p.proposal.rationale}</p>
                        {p.decision.reasons.length > 0 && (
                          <ul className="mt-1 list-disc pl-4 text-[color:var(--con-warn)]">
                            {p.decision.reasons.map((reason, i) => (
                              <li key={i}>{reason}</li>
                            ))}
                          </ul>
                        )}
                        {p.errorMessage && <p className="mt-1 text-[color:var(--con-neg)]">{p.errorMessage}</p>}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                  No per-proposal records retained for this run.
                </p>
              )}
            </div>
          </details>
        );
      }}
    />
  );
}

// ── Fills ────────────────────────────────────────────────────────────────────

function FillsList({ fills }: { fills: FillEvent[] }) {
  const sorted = useMemo(
    () => [...fills].sort((a, b) => new Date(b.filledAt).getTime() - new Date(a.filledAt).getTime()).slice(0, 100),
    [fills]
  );
  return (
    <DayGroups
      items={sorted}
      timestamp={(f) => f.filledAt}
      emptyText="No fills yet."
      renderItem={(f) => {
        const r = realityForMode(f.executionMode ?? (f.source === "live" ? "broker/live" : undefined));
        return (
          <div key={f.id} className="con-card flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-[length:var(--con-fs-sm)]">
            <span className="font-bold">
              {SIDE_LABEL[f.side] ?? f.side} <SymbolButton symbol={f.symbol} showLogo={false} />
            </span>
            <span className="con-num text-[color:var(--con-muted)]">
              {fmtQty(f.quantity)} @ {fmtMoney(f.price)} = {fmtMoney(f.notional)}
            </span>
            <Chip tone={r.tone} title={r.clarification}>
              {r.word}
            </Chip>
            {f.status !== "filled" && (
              <Chip tone={statusTone(f.status)} title="Recorded intent awaiting broker-truth reconciliation — it cannot double-place.">
                {f.status}
              </Chip>
            )}
            <span className="ml-auto text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
              <Ago iso={f.filledAt} />
            </span>
          </div>
        );
      }}
    />
  );
}
