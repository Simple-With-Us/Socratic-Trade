"use client";

/** Autonomy Desk — "what does Socratic Trade believe, what did it do,
 *  what evidence moved it, and how should the framework improve?" */

import { useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  Brain,
  Check,
  Database,
  GitBranch,
  MessageSquare,
  TrendingUp,
  X,
  Zap
} from "lucide-react";
import type { DashboardSnapshot, StrategyDecision } from "../dashboard-types";
import { formatSourceList, friendlySource } from "@/lib/dashboard-ui";
import type { MarketQuote, PendingProposal, SocraticDecisionCase, SocraticFrameworkProposal, TradeProposal } from "@/lib/types";
import { deriveDayPnl, deriveReality, deriveSpend, deriveStateInfo } from "./lib/derive";
import { EM_DASH, fmtExact, fmtMoney, fmtMoneyWhole, fmtPct, fmtSignedMoney, timeUntil } from "./lib/format";
import { useConsoleData } from "./lib/useConsoleData";
import { RunOnceButton } from "./components/chrome";
import { Ago, Card, Chip, Dash, Meter, SignedText, Stat } from "./ui/primitives";
import { SymbolButton } from "./ui/symbol-drilldown";

const SIDE_LABEL: Record<string, string> = { buy: "Bought", sell: "Sold", short: "Shorted", cover: "Covered" };

export default function ConsoleHomePage() {
  const { snapshot, refresh } = useConsoleData();
  if (!snapshot) return null;

  const reality = deriveReality(snapshot);
  const state = deriveStateInfo(snapshot.policy);
  const spend = deriveSpend(snapshot);
  const portfolio = snapshot.portfolio;
  const dayPnl = deriveDayPnl(snapshot.performance, reality.mode, portfolio?.totalMarketValue);
  const latest = snapshot.latestStrategyRun;
  const latestRow = snapshot.strategyRuns?.[0];
  const nextRun = snapshot.scheduler?.nextRunAt;
  const primaryDecision = snapshot.socratic?.decisions?.[0];
  const primaryTrace = latest?.proposals?.[0];
  const primaryProposal = primaryTrace?.proposal ?? snapshot.pendingProposals[0]?.proposal;
  const evidenceRows = deriveEvidenceRows(snapshot, latest, primaryDecision);
  const actionRows = deriveActionRows(snapshot, latest);
  const frameworkRows = deriveFrameworkRows(snapshot);

  return (
    <div className="flex flex-col gap-4">
      <section className="con-thesis-hero">
        <div className="min-w-0">
          <div className="con-card-title flex items-center gap-1.5">
            <Brain size={13} /> Live thesis
          </div>
          <h1>{deriveThesisHeadline(latest, primaryProposal, primaryDecision)}</h1>
          <p>{deriveThesisBody(latest, primaryProposal, primaryDecision)}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Chip tone={state.tone === "warn" ? "warn" : state.tone === "neg" ? "neg" : "pos"} title={state.detail}>
              {state.label}
            </Chip>
            <Chip tone={reality.tone} title={reality.clarification}>
              {reality.word} · {reality.phrase}
            </Chip>
            {primaryProposal?.tradeThesisTag && (
              <Chip tone="accent" title="The thesis bucket this reasoning is filed under for later outcome scoring.">
                {primaryProposal.tradeThesisTag}
              </Chip>
            )}
            {primaryProposal?.entryMarketRegime && (
              <Chip tone="muted" title="The regime Socratic Trade saw when it formed the thesis.">
                {primaryProposal.entryMarketRegime}
              </Chip>
            )}
          </div>
        </div>

        <div className="con-autonomy-card">
          <div className="con-card-title">Capital posture</div>
          <div className="con-num mt-1 text-[length:var(--con-fs-xxl)] font-semibold">
            {typeof spend.capNotional === "number"
              ? fmtMoneyWhole(Math.max(0, spend.capNotional - spend.usedNotional))
              : fmtMoney(portfolio?.buyingPower)}
          </div>
          <p>
            {typeof spend.capNotional === "number"
              ? `remaining opening authority today, out of ${fmtMoneyWhole(spend.capNotional)}`
              : `buying power visible to the active account`}
          </p>
          <Meter value={spend.usedNotional} max={spend.capNotional} className="mt-3" />
        </div>
      </section>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)]">
        <div className="flex flex-col gap-4">
          <Card
            title={
              <span className="flex items-center gap-1.5">
                <Zap size={13} /> Autonomous actions
              </span>
            }
            action={
              <Link href="/console/activity" className="flex items-center gap-1 text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-accent)]">
                Journal <ArrowRight size={12} />
              </Link>
            }
          >
            {actionRows.length > 0 ? (
              <div className="con-decision-list">
                {actionRows.map((row) => (
                  <DecisionRow key={row.id} row={row} />
                ))}
              </div>
            ) : (
              <p className="text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
                No recent autonomous actions are in the snapshot yet. Run Socratic Trade once to create the first
                persisted decision trace.
              </p>
            )}
          </Card>

          <Card
            title={
              <span className="flex items-center gap-1.5">
                <Database size={13} /> Evidence
              </span>
            }
            action={
              <Link href="/console/scan" className="flex items-center gap-1 text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-accent)]">
                Evidence board <ArrowRight size={12} />
              </Link>
            }
          >
            {evidenceRows.length > 0 ? (
              <div className="con-evidence-grid">
                {evidenceRows.map((row) => (
                  <EvidenceCard key={row.title} {...row} />
                ))}
              </div>
            ) : (
              <p className="text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
                No decision evidence is available yet. The next run will persist scan evidence, policy reasoning,
                retrieved evidence, and dissent per decision.
              </p>
            )}
          </Card>

          <Card
            title={
              <span className="flex items-center gap-1.5">
                <TrendingUp size={13} /> Outcome learning loop
              </span>
            }
            action={
              <Link href="/console/results" className="flex items-center gap-1 text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-accent)]">
                Outcomes <ArrowRight size={12} />
              </Link>
            }
          >
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
              <Stat
                label={reality.tone === "paper" ? "Portfolio Value · Paper" : "Portfolio Value"}
                value={fmtMoney(portfolio?.totalMarketValue)}
                sub={reality.tone === "paper" ? reality.phrase : reality.account?.label}
              />
              <div>
                <div className="con-card-title">Day P&amp;L</div>
                <div className="con-num mt-1 text-[length:var(--con-fs-xl)] font-semibold leading-tight">
                  {dayPnl ? (
                    <SignedText value={dayPnl.pnl}>
                      {fmtSignedMoney(dayPnl.pnl)} ({fmtPct(dayPnl.pct, 2, true)})
                    </SignedText>
                  ) : (
                    <Dash />
                  )}
                </div>
                <div
                  className="mt-0.5 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]"
                  title={dayPnl ? `Baseline: ${fmtMoney(dayPnl.baselineEquity)} at ${fmtExact(dayPnl.baselineAt)}` : undefined}
                >
                  {dayPnl ? "vs last snapshot before today" : "no prior-day snapshot yet"}
                </div>
              </div>
              <Stat label="Cash" value={fmtMoney(portfolio?.cash)} sub={`Buying power ${fmtMoney(portfolio?.buyingPower)}`} />
              <Stat
                label="Closed thesis samples"
                value={snapshot.thesisScorecard?.reduce((sum, t) => sum + t.trades, 0) ?? 0}
                sub="basis for future framework changes"
              />
            </div>
          </Card>
        </div>

        <aside className="flex flex-col gap-4">
          <Card
            title={
              <span className="flex items-center gap-1.5">
                <AlertTriangle size={13} /> Dissent
              </span>
            }
          >
            <div className="flex flex-col gap-2">
              {deriveDissentRows(primaryProposal, latest, primaryDecision).map((row) => (
                <EvidenceCard key={row.title} {...row} />
              ))}
            </div>
          </Card>

          <Card
            title={
              <span className="flex items-center gap-1.5">
                <MessageSquare size={13} /> Coach Socratic Trade
              </span>
            }
            action={
              <Link href="/console/assistant" className="flex items-center gap-1 text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-accent)]">
                Coach <ArrowRight size={12} />
              </Link>
            }
          >
            <div className="con-coach-box">
              <p>
                {primaryDecision?.coachNotes?.length
                  ? primaryDecision.coachNotes.at(-1)
                  : "Tell it what it overweighted, underweighted, ignored, or should refocus on. Coaching attaches to the decision case instead of disappearing into chat."}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Chip tone="muted">Refocus mandate</Chip>
                <Chip tone="muted">Critique thesis</Chip>
                <Chip tone="muted">Promote lesson</Chip>
              </div>
              <CoachNoteForm decision={primaryDecision} refresh={refresh} />
            </div>
          </Card>

          <Card
            title={
              <span className="flex items-center gap-1.5">
                <GitBranch size={13} /> Framework improvements
              </span>
            }
            action={
              <Link href="/console/strategy" className="flex items-center gap-1 text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-accent)]">
                Framework <ArrowRight size={12} />
              </Link>
            }
          >
            {(snapshot.socratic?.frameworkProposals?.length ?? 0) > 0 ? (
              <FrameworkProposalList proposals={snapshot.socratic?.frameworkProposals ?? []} refresh={refresh} />
            ) : (
              <div className="flex flex-col gap-2">
                {frameworkRows.map((row) => (
                  <EvidenceCard key={row.title} {...row} />
                ))}
              </div>
            )}
          </Card>

          <Card title="Run cadence">
            <div className="flex flex-wrap items-center gap-2">
              <div className="sm:hidden">
                <RunOnceButton snapshot={snapshot} size="sm" />
              </div>
              <Chip tone={state.tone === "warn" ? "warn" : state.tone === "neg" ? "neg" : "pos"}>{state.label}</Chip>
              {latestRow && (
                <Chip tone={latestRow.status === "failed" ? "neg" : "muted"}>
                  latest {latestRow.status} · <Ago iso={latestRow.finishedAt ?? latestRow.startedAt} />
                </Chip>
              )}
            </div>
            <div className="mt-3 border-t border-[color:var(--con-line)] pt-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
              {state.state === "active" && nextRun ? (
                <span title={fmtExact(nextRun)}>Next scheduled run {timeUntil(nextRun)} · cadence {snapshot.policy.runCadenceMinutes} min</span>
              ) : state.state === "active" ? (
                <span title={`Configured cadence: every ${snapshot.policy.runCadenceMinutes} minutes.`}>
                  Running now. Planned cadence is every {snapshot.policy.runCadenceMinutes} min; the next run time is not available in this snapshot.
                </span>
              ) : (
                <span title={`If restarted, scheduled runs use the configured cadence: every ${snapshot.policy.runCadenceMinutes} minutes.`}>
                  Not running now. If restarted, planned cadence is every {snapshot.policy.runCadenceMinutes} min.
                </span>
              )}
            </div>
          </Card>
        </aside>
      </div>
    </div>
  );
}

type DecisionRowData = {
  id: string;
  symbol: string;
  verb: string;
  size: string;
  status: string;
  rationale: string;
  href?: string;
  title?: string;
  confidence?: number;
};

type EvidenceRow = {
  title: string;
  meta: string;
  metaTitle?: string;
  body: string;
  tone?: "pos" | "warn" | "neg" | "accent";
};

function deriveThesisHeadline(latest: StrategyDecision | undefined, proposal: TradeProposal | undefined, decision?: SocraticDecisionCase): string {
  if (decision?.thesis) {
    return `Market thesis: ${formatMarketThesis(decision.thesis, decision.symbol)}`;
  }
  if (proposal?.tradeThesisTag) {
    return `Market thesis: ${formatMarketThesis(proposal.tradeThesisTag, proposal.symbol)}`;
  }
  if (latest?.summary) return "Latest run completed; Socratic Trade is holding its current posture.";
  return "Waiting for the next market thesis.";
}

function deriveThesisBody(latest: StrategyDecision | undefined, proposal: TradeProposal | undefined, decision?: SocraticDecisionCase): string {
  if (decision?.rationale) {
    const expression = decision.symbol ? `Current expression: ${decision.side ? `${decision.side.toUpperCase()} ` : ""}${decision.symbol}. ` : "";
    return `${expression}${decision.rationale}`;
  }
  if (proposal?.rationale) {
    return `Current expression: ${proposal.side.toUpperCase()} ${proposal.symbol}. ${proposal.rationale}`;
  }
  if (latest?.summary) return latest.summary;
  return "Run Socratic Trade to form a thesis from the current market, portfolio, evidence, and remembered outcomes.";
}

function formatMarketThesis(raw: string, symbol?: string | null): string {
  const trimmed = raw.trim();
  const symbolPrefix = symbol ? new RegExp(`^${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[:\\-]\\s*`, "i") : null;
  const withoutSymbol = symbolPrefix ? trimmed.replace(symbolPrefix, "") : trimmed;
  return withoutSymbol
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b[a-z]/g, (char) => char.toUpperCase());
}

function deriveActionRows(snapshot: DashboardSnapshot, latest: StrategyDecision | undefined): DecisionRowData[] {
  const persisted = snapshot.socratic?.decisions?.slice(0, 5).map(decisionFromSocratic) ?? [];
  if (persisted.length > 0) return persisted;
  const latestRows =
    latest?.proposals
      ?.slice(0, 5)
      .map((item) => decisionFromProposal(`${latest.runId}-${item.proposal.symbol}-${item.status}`, item.proposal, item.status, item.reasons)) ??
    [];
  if (latestRows.length > 0) return latestRows;
  return snapshot.pendingProposals.slice(0, 5).map((pending) => decisionFromPending(pending));
}

function decisionFromSocratic(decision: SocraticDecisionCase): DecisionRowData {
  const reasons = decision.policyDecision?.reasons ?? [];
  const rationale = decision.policyDecision?.socraticOverride?.applied
    ? `${decision.rationale} Override: ${decision.policyDecision.socraticOverride.thesis}`
    : decision.rationale;
  return {
    id: decision.id,
    symbol: decision.symbol ?? "Portfolio",
    verb: decision.side ? SIDE_LABEL[decision.side] ?? decision.side : "Observed",
    size: decision.notional ? fmtMoney(decision.notional) : EM_DASH,
    status: decision.status,
    rationale: withBlockReasons(rationale, decision.status, reasons),
    href: `/console/decisions/${encodeURIComponent(decision.id)}`,
    title: reasons.length > 0 ? `Policy reasons:\n${reasons.join("\n")}` : undefined,
    confidence: decision.confidenceScore
  };
}

function decisionFromProposal(id: string, proposal: TradeProposal, status: string, reasons: string[] = []): DecisionRowData {
  return {
    id,
    symbol: proposal.symbol,
    verb: SIDE_LABEL[proposal.side] ?? proposal.side,
    size: proposal.dollarAmount ? fmtMoney(proposal.dollarAmount) : proposal.quantity ? `${proposal.quantity} sh` : EM_DASH,
    status,
    rationale: withBlockReasons(proposal.rationale, status, reasons),
    title: reasons.length > 0 ? `Policy reasons:\n${reasons.join("\n")}` : undefined,
    confidence: proposal.confidenceScore
  };
}

function decisionFromPending(pending: PendingProposal): DecisionRowData {
  const proposal = pending.proposal;
  return {
    ...decisionFromProposal(pending.id, proposal, "pending"),
    size: pending.estimatedNotional ? fmtMoney(pending.estimatedNotional) : proposal.dollarAmount ? fmtMoney(proposal.dollarAmount) : EM_DASH
  };
}

function deriveEvidenceRows(snapshot: DashboardSnapshot, latest: StrategyDecision | undefined, decision?: SocraticDecisionCase): EvidenceRow[] {
  const rows: EvidenceRow[] = [];
  if (decision) {
    for (const item of decision.evidence.slice(0, 5)) {
      const source = evidenceSourceLabel(item.source);
      rows.push({
        title: item.title,
        meta: [plainLabel(item.kind), source].filter(Boolean).join(" · "),
        metaTitle: source ? `Source: ${source}` : undefined,
        body: item.summary,
        tone: toneFromSocratic(item.tone)
      });
    }
    for (const rag of decision.ragAttributions.slice(0, 2)) {
      const source = evidenceSourceLabel(rag.source);
      rows.push({
        title: rag.docType ? `Retrieved ${plainLabel(rag.docType)}` : "Retrieved evidence",
        meta: [source, rag.score != null ? `score ${rag.score.toFixed(2)}` : rag.symbol].filter(Boolean).join(" · "),
        metaTitle: source ? `Source: ${source}` : undefined,
        body: rag.contribution,
        tone: "accent"
      });
    }
    if (rows.length > 0) return rows.slice(0, 6);
  }
  const scan = latest?.marketScan;
  if (scan) {
    const sources = formatSourceList(scan.source);
    rows.push({
      title: "Market scan",
      meta: `${scan.returnedQuotes}/${scan.scannedSymbols} quotes${sources ? ` · ${sources}` : ""}`,
      metaTitle: sources ? `Quote sources: ${sources}` : "Quote sources were not recorded for this scan.",
      body:
        typeof scan.breadthPct === "number"
          ? `Market breadth was ${fmtPct(scan.breadthPct, 1)} when the thesis was formed.`
          : "The latest thesis links to a captured scan, with source attribution preserved.",
      tone: "accent"
    });
    for (const candidate of scan.topCandidates.slice(0, 3)) rows.push(evidenceFromCandidate(candidate));
  }

  const proposal = latest?.proposals?.[0]?.proposal ?? snapshot.pendingProposals[0]?.proposal;
  if (proposal?.proposedByModel) {
    rows.push({
      title: "Model attribution",
      meta: proposal.proposedByModel,
      body: "The proposal stores the model that actually generated it, so later outcome review can score models instead of guessing.",
      tone: "pos"
    });
  }
  if (proposal?.redTeamVerdict?.available) {
    rows.push({
      title: "Adversarial review",
      meta: proposal.redTeamVerdict.model ?? "red team",
      body: proposal.redTeamVerdict.reason,
      tone: proposal.redTeamVerdict.rejected ? "neg" : "warn"
    });
  }
  return rows.slice(0, 6);
}

function evidenceFromCandidate(candidate: MarketQuote): EvidenceRow {
  const bullet = candidate.evidenceBulletins?.[0] ?? candidate.headlines?.[0];
  const sources = sourceListFromQuote(candidate) || evidenceSourceLabel(candidate.provider);
  return {
    title: candidate.symbol,
    meta: `score ${Math.round(candidate.score)}${sources ? ` · ${sources}` : ""}`,
    metaTitle: sources ? `Data sources: ${sources}` : undefined,
    body:
      bullet ??
      `${candidate.companyName ?? candidate.symbol} was in the latest candidate set with ${fmtPct(candidate.intradayChangePct, 2, true)} intraday change.`,
    tone: candidate.intradayChangePct < 0 ? "warn" : "pos"
  };
}

function deriveDissentRows(proposal: TradeProposal | undefined, latest: StrategyDecision | undefined, decision?: SocraticDecisionCase): EvidenceRow[] {
  const rows: EvidenceRow[] = [];
  if (decision?.dissent?.length) {
    return decision.dissent.slice(0, 4).map((item) => ({
      title: item.title,
      meta: [item.kind, item.source].filter(Boolean).join(" · "),
      body: item.summary,
      tone: toneFromSocratic(item.tone)
    }));
  }
  if (proposal?.redTeamVerdict?.available) {
    rows.push({
      title: "Red-team objection",
      meta: proposal.redTeamVerdict.rejected ? "critical" : "survived",
      body: proposal.redTeamVerdict.reason,
      tone: proposal.redTeamVerdict.rejected ? "neg" : "warn"
    });
  }
  const reasons = latest?.proposals?.[0]?.reasons ?? [];
  for (const reason of reasons.slice(0, 2)) {
    rows.push({ title: "Policy note", meta: "gate output", body: reason, tone: "warn" });
  }
  if (rows.length === 0) {
    rows.push({
      title: "No dissent recorded",
      meta: "current decision",
      body: "No red-team, policy, or invalidation counterargument has been attached to the latest decision yet.",
      tone: "accent"
    });
  }
  return rows.slice(0, 3);
}

function deriveFrameworkRows(snapshot: DashboardSnapshot): EvidenceRow[] {
  const proposals = snapshot.socratic?.frameworkProposals ?? [];
  if (proposals.length > 0) return proposals.slice(0, 5).map(frameworkToEvidenceRow);
  const rows: EvidenceRow[] = [];
  const topThesis = [...(snapshot.thesisScorecard ?? [])].sort((a, b) => b.trades - a.trades)[0];
  if (topThesis) {
    rows.push({
      title: topThesis.thesisTag,
      meta: `${topThesis.trades} closed · ${fmtPct(topThesis.winRate, 1)} win rate`,
      metaTitle: "Raw realized return for closed lots in this thesis bucket, not benchmark-relative. The SPY comparison lives on Results.",
      body: `Raw average return ${fmtPct(topThesis.avgReturnPct, 2, true)}. Socratic Trade should use this as earned evidence before changing sizing or thesis weight.`,
      tone: topThesis.avgReturnPct >= 0 ? "pos" : "warn"
    });
  }
  const topRegime = [...(snapshot.regimeScorecard ?? [])].sort((a, b) => b.trades - a.trades)[0];
  if (topRegime) {
    rows.push({
      title: topRegime.regime,
      meta: `${topRegime.trades} closed in regime`,
      metaTitle: "Raw realized return for closed lots opened in this regime, not benchmark-relative. The SPY comparison lives on Results.",
      body: `Raw regime average return ${fmtPct(topRegime.avgReturnPct, 2, true)}. Use this to challenge or support future regime-specific autonomy.`,
      tone: topRegime.avgReturnPct >= 0 ? "pos" : "warn"
    });
  }
  return rows;
}

function frameworkToEvidenceRow(proposal: SocraticFrameworkProposal): EvidenceRow {
  return {
    title: proposal.title,
    meta: `${proposal.status} · ${proposal.subsystem} · ${proposal.priority}`,
    body: proposal.proposedChange,
    tone: proposal.priority === "high" ? "warn" : proposal.status === "accepted" || proposal.status === "applied" ? "pos" : "accent"
  };
}

function toneFromSocratic(tone: string | undefined): EvidenceRow["tone"] {
  if (tone === "positive") return "pos";
  if (tone === "negative") return "neg";
  if (tone === "warning") return "warn";
  return "accent";
}

function DecisionRow({ row }: { row: DecisionRowData }) {
  return (
    <article className="con-decision-row" title={row.title}>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          {row.symbol === "Portfolio" ? <strong>{row.symbol}</strong> : <SymbolButton symbol={row.symbol} showLogo={false} />}
          <span>{row.verb}</span>
          <Chip tone={row.status === "blocked" || row.status === "failed" ? "warn" : row.status === "pending" ? "accent" : "pos"}>{row.status}</Chip>
        </div>
        <p>{row.rationale}</p>
      </div>
      <div className="text-right">
        <div className="con-num font-semibold">{row.size}</div>
        {typeof row.confidence === "number" && <div className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">conf {row.confidence}</div>}
        {row.href && (
          <Link href={row.href} className="mt-1 inline-flex text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-accent)]">
            Trace
          </Link>
        )}
      </div>
    </article>
  );
}

function EvidenceCard({ title, meta, metaTitle, body, tone = "accent" }: EvidenceRow) {
  return (
    <article className={`con-evidence-card con-evidence-${tone}`}>
      <div className="flex items-start justify-between gap-3">
        <strong>{title}</strong>
        <span title={metaTitle}>{meta}</span>
      </div>
      <p>{body}</p>
    </article>
  );
}

function withBlockReasons(rationale: string, status: string, reasons: string[]): string {
  if (reasons.length === 0) return rationale;
  if (!/blocked|failed|rejected|skipped/i.test(status)) return rationale;
  return `${rationale} Blocked because: ${reasons.slice(0, 3).join(" ")}${reasons.length > 3 ? " ..." : ""}`;
}

function evidenceSourceLabel(source?: string | null): string {
  if (!source) return "";
  return formatSourceList(source) || friendlySource(source);
}

function sourceListFromQuote(candidate: MarketQuote): string {
  const sources = Object.values(candidate.sources ?? {}).filter(Boolean);
  if (candidate.provider) sources.unshift(candidate.provider);
  return formatSourceList(sources.join("+"));
}

function plainLabel(raw?: string | null): string {
  if (!raw) return "";
  return raw
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function CoachNoteForm({ decision, refresh }: { decision?: SocraticDecisionCase; refresh: () => Promise<void> }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  if (!decision) return null;
  return (
    <form
      className="mt-3 flex flex-col gap-2"
      onSubmit={async (event) => {
        event.preventDefault();
        const trimmed = note.trim();
        if (!trimmed) return;
        setBusy(true);
        setMessage(null);
        try {
          const res = await fetch(`/api/socratic/decisions/${encodeURIComponent(decision.id)}/coach`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ note: trimmed })
          });
          if (!res.ok) throw new Error(await res.text());
          setNote("");
          setMessage("Saved.");
          await refresh();
        } catch (error) {
          setMessage(error instanceof Error ? error.message : "Could not save note.");
        } finally {
          setBusy(false);
        }
      }}
    >
      <textarea
        className="con-textarea"
        rows={3}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        placeholder="What should Socratic Trade learn from this decision?"
      />
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" className="con-btn con-btn-primary con-btn-sm" disabled={busy || !note.trim()}>
          <MessageSquare size={14} /> Save note
        </button>
        {message && <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">{message}</span>}
      </div>
    </form>
  );
}

function FrameworkProposalList({ proposals, refresh }: { proposals: SocraticFrameworkProposal[]; refresh: () => Promise<void> }) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const update = async (proposal: SocraticFrameworkProposal, status: "accepted" | "rejected" | "applied") => {
    setBusyId(proposal.id);
    setMessage(null);
    try {
      const res = await fetch(`/api/socratic/framework/${encodeURIComponent(proposal.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status })
      });
      if (!res.ok) throw new Error(await res.text());
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not update proposal.");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {proposals.slice(0, 5).map((proposal) => (
        <article key={proposal.id} className="con-evidence-card con-evidence-accent">
          <div className="flex items-start justify-between gap-3">
            <strong>{proposal.title}</strong>
            <span>{proposal.status}</span>
          </div>
          <p>{proposal.proposedChange}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className="con-btn con-btn-pos con-btn-sm"
              disabled={busyId === proposal.id || proposal.status !== "pending"}
              onClick={() => void update(proposal, "accepted")}
            >
              <Check size={14} /> Accept
            </button>
            <button
              type="button"
              className="con-btn con-btn-outline con-btn-sm"
              disabled={busyId === proposal.id || proposal.status === "applied"}
              onClick={() => void update(proposal, "applied")}
            >
              <GitBranch size={14} /> Applied
            </button>
            <button
              type="button"
              className="con-btn con-btn-danger-outline con-btn-sm"
              disabled={busyId === proposal.id || proposal.status !== "pending"}
              onClick={() => void update(proposal, "rejected")}
            >
              <X size={14} /> Reject
            </button>
          </div>
        </article>
      ))}
      {message && <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">{message}</span>}
    </div>
  );
}
