"use client";

import { useMemo } from "react";
import type { RecentProposal, StrategyRunRow } from "@/lib/types";
import { isStrategyRunSkipStatus, strategyRunStatusLabel } from "@/lib/strategy-run-status";
import { plainEnglishRunFailure } from "@/lib/strategy-run-failure";
import { realityForMode } from "../lib/derive";
import { EM_DASH, SENTENCE_GAP, fmtMoney, fmtPct, fmtQty } from "../lib/format";
import { feedStatusLabel } from "../lib/labels";
import { Ago, Chip, SignedText, Tooltip } from "../ui/primitives";
import { SymbolButton } from "../ui/symbol-drilldown";
import { DayGroups } from "./day-groups";
import { activityStatusTone } from "./status-tone";

function runDuration(run: StrategyRunRow): string {
  if (!run.finishedAt) return EM_DASH;
  const ms = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return EM_DASH;
  return ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`;
}

const SIDE_LABEL: Record<string, string> = { buy: "BUY", sell: "SELL", short: "SHORT", cover: "COVER" };

export function StrategyRunsList({
  runs,
  recentProposals,
  accountLabelById
}: {
  runs: StrategyRunRow[];
  recentProposals: RecentProposal[];
  accountLabelById?: Record<string, string>;
}) {
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
    <div className="flex flex-col gap-4">
      <p className="text-[length:var(--con-fs-sm)] leading-relaxed text-[color:var(--con-muted)]">
        Each evaluation of the account, newest first.
      </p>
    <DayGroups
      items={runs}
      timestamp={(r) => r.startedAt}
      emptyText="No strategy runs yet."
      renderItem={(run) => {
        const proposals = byRun.get(run.id) ?? [];
        const failure =
          run.status === "failed"
            ? plainEnglishRunFailure({ status: run.status, summary: run.summary })
            : null;
        const accountLabel = run.connectedAccountId ? accountLabelById?.[run.connectedAccountId] : undefined;
        return (
          <details key={run.id} className="con-card con-disclosure px-4 py-1">
            <summary>
              <span className="min-w-0 flex-1">
                <span className="block font-semibold text-[color:var(--con-fg)]">Strategy Run</span>
                <span className="block text-[length:var(--con-fs-xs)] font-normal text-[color:var(--con-faint)]">
                  Started <Ago iso={run.startedAt} />
                  {run.finishedAt ? <> · Completed <Ago iso={run.finishedAt} /></> : null}
                  {" · "}Duration {runDuration(run)}
                  {accountLabel ? <> · {accountLabel}</> : null}
                </span>
                <span className="con-num mt-0.5 block text-[length:var(--con-fs-xs)] font-normal text-[color:var(--con-faint)]">
                  {run.proposedCount} proposed · {run.placedCount} placed
                  {run.paperCount > 0 ? ` · ${run.paperCount} paper` : ""} · {run.blockedCount} blocked
                </span>
              </span>
              <Chip
                tone={
                  run.status === "failed"
                    ? "neg"
                    : run.status === "running"
                      ? "accent"
                      : isStrategyRunSkipStatus(run.status)
                        ? "warn"
                        : "pos"
                }
              >
                {strategyRunStatusLabel(run.status, run.summary)}
              </Chip>
            </summary>
            <div className="border-t border-[color:var(--con-line)] py-3">
              {failure && (
                <p className="mb-3 text-[length:var(--con-fs-sm)] leading-relaxed text-[color:var(--con-neg)]">
                  <span className="font-semibold">Failure.{SENTENCE_GAP}</span>
                  {failure}
                </p>
              )}
              {!failure && run.summary && (
                <p className="mb-2 text-[length:var(--con-fs-sm)] leading-relaxed text-[color:var(--con-muted)]">
                  {run.summary}
                </p>
              )}
              {run.status === "completed" && run.totalCount === 0 && (
                <p className="mb-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                  No candidate cleared the bar this run — deliberate hold after a full evaluation.
                </p>
              )}
              {isStrategyRunSkipStatus(run.status) && (
                <p className="mb-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-warn)]">
                  Pre-decision skip — not a successful evaluation.{SENTENCE_GAP}
                  {strategyRunStatusLabel(run.status, run.summary)}.
                </p>
              )}
              <details className="mt-1">
                <summary className="cursor-pointer text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-muted)]">
                  Run Details
                </summary>
                <div className="mt-2">
                  {proposals.length > 0 ? (
                    <ul className="flex flex-col gap-2">
                      {proposals.map((p) => {
                        const r = realityForMode(p.executionMode);
                        return (
                          <li
                            key={p.id}
                            className="rounded-control border border-[color:var(--con-line)] p-2.5 text-[length:var(--con-fs-xs)]"
                          >
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-[length:var(--con-fs-sm)] font-bold">
                                {SIDE_LABEL[p.proposal.side] ?? p.proposal.side}{" "}
                                <SymbolButton symbol={p.proposal.symbol} />
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
                              <Chip tone={activityStatusTone(p.status)}>{feedStatusLabel(p.status)}</Chip>
                              <Chip tone={r.tone}>{r.word}</Chip>
                              {typeof p.performanceSinceProposalPct === "number" && (
                                <Tooltip content={`Raw side-adjusted move since the proposal's reference price, not benchmark-relative.${SENTENCE_GAP}For a rejected idea this is the counterfactual; SPY comparison lives in Results.`}>
                                  <span>
                                    <SignedText value={p.performanceSinceProposalPct}>
                                      since: {fmtPct(p.performanceSinceProposalPct, 2, true)}
                                    </SignedText>
                                  </span>
                                </Tooltip>
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
            </div>
          </details>
        );
      }}
    />
    </div>
  );
}
