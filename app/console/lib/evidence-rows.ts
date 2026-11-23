/** Defensive helpers for console evidence rows built from persisted snapshot shapes.
 *
 *  Audit-backed `latestScan` / strategy-run marketScan payloads are not guaranteed to be a full
 *  `MarketScan`. Historical or truncated rows can be truthy objects missing `topCandidates` (or
 *  carrying compact prompt keys). The home dashboard used to call `.slice` on that field and
 *  white-screen the whole console (`undefined is not an object (evaluating 'r.topCandidates.slice')`).
 */

import { formatSourceList, friendlySource } from "@/lib/dashboard-ui";
import type { MarketQuote, SocraticDecisionCase, TradeProposal } from "@/lib/types";
import type { DashboardSnapshot, StrategyDecision } from "../../dashboard-types";
import { approveProposal, ConsoleApiError, LiveConfirmationRequiredError, rejectProposal } from "./api";
import { toastForApproveResult } from "./approval-honesty";
import { fmtPct } from "./format";
import { plainLabel } from "./labels";
import { redTeamFailureMeta } from "./red-team";
import { isSuccessfulApprovalResult } from "./thesis";

export type DecisionRowData = {
  id: string;
  symbol: string;
  verb: string;
  size: string;
  status: string;
  rationale: string;
  href?: string;
  title?: string;
  confidence?: number;
  at?: string;
  approvable?: boolean;
  proposal?: TradeProposal;
  decision?: SocraticDecisionCase;
};

export interface ProposalRowActionState {
  busy: "approve" | "reject" | null;
  liveConfirm: string | null;
  confirmText: string;
}

export function createProposalRowHandlers({
  row,
  state,
  confirmRef,
  getConfirmState,
  inFlightRef,
  setState,
  refresh,
  toast,
  onClose
}: {
  row: DecisionRowData;
  state?: ProposalRowActionState;
  confirmRef?: { current: { liveConfirm: string | null; confirmText: string } };
  getConfirmState?: () => { liveConfirm: string | null; confirmText: string };
  inFlightRef?: { current: boolean };
  setState: (updater: (prev: ProposalRowActionState) => ProposalRowActionState) => void;
  refresh: () => void;
  toast: { push: (tone: "pos" | "warn" | "neg" | "info", title: string, detail?: string) => void };
  onClose: () => void;
}) {
  let localInFlight = false;
  const lock = () => {
    if (inFlightRef) {
      if (inFlightRef.current) return false;
      inFlightRef.current = true;
      return true;
    }
    if (localInFlight) return false;
    localInFlight = true;
    return true;
  };
  const unlock = () => {
    if (inFlightRef) inFlightRef.current = false;
    localInFlight = false;
  };

  const handleClose = () => {
    unlock();
    onClose();
    setState((s) => ({ ...s, liveConfirm: null, confirmText: "" }));
  };

  const handleApprove = async () => {
    if (!lock()) return;
    setState((s) => ({ ...s, busy: "approve" }));
    try {
      const confirmState = confirmRef
        ? confirmRef.current
        : getConfirmState
          ? getConfirmState()
          : { liveConfirm: state?.liveConfirm ?? null, confirmText: state?.confirmText ?? "" };
      const confirmBody = confirmState.liveConfirm
        ? {
            proposalId: row.id,
            executionMode: "broker/live" as const,
            typedText: confirmState.confirmText.trim().toUpperCase()
          }
        : undefined;
      const res = await approveProposal(row.id, confirmBody);
      const side = (row.proposal?.side ?? row.verb ?? "buy").toLowerCase();
      const outcome = toastForApproveResult({
        status: res.status,
        reasons: res.reasons,
        symbol: row.symbol,
        side
      });
      toast.push(outcome.tone, outcome.title, outcome.detail);
      setState((s) => ({ ...s, liveConfirm: null, confirmText: "" }));
      if (isSuccessfulApprovalResult(res.status)) {
        onClose();
      }
      refresh();
    } catch (e: unknown) {
      if (e instanceof LiveConfirmationRequiredError) {
        setState((s) => ({ ...s, liveConfirm: e.expectedText, confirmText: "" }));
      } else {
        const msg = e instanceof ConsoleApiError ? e.message : e instanceof Error ? e.message : String(e);
        toast.push("neg", "Approval failed", msg);
      }
    } finally {
      unlock();
      setState((s) => ({ ...s, busy: null }));
    }
  };

  const handleReject = async () => {
    if (!lock()) return;
    setState((s) => ({ ...s, busy: "reject" }));
    try {
      await rejectProposal(row.id);
      onClose();
      setState((s) => ({ ...s, liveConfirm: null, confirmText: "" }));
      refresh();
      toast.push(
        "info",
        `Rejected ${row.symbol}`,
        "The idea keeps being scored\u00A0— you'll see how it does after you passed."
      );
    } catch (e: unknown) {
      const msg = e instanceof ConsoleApiError ? e.message : e instanceof Error ? e.message : String(e);
      toast.push("neg", "Rejection failed", msg);
    } finally {
      unlock();
      setState((s) => ({ ...s, busy: null }));
    }
  };

  return { handleApprove, handleReject, handleClose };
}

export type EvidenceRow = {
  title: string;
  meta: string;
  metaTitle?: string;
  body: string;
  symbol?: string;
  quote?: MarketQuote;
  tone?: "pos" | "warn" | "neg" | "accent";
};

/** Safe top-candidate list for evidence UI. Never throws on partial scan shapes. */
export function safeTopCandidates(scan: { topCandidates?: unknown } | null | undefined): MarketQuote[] {
  if (!scan || !Array.isArray(scan.topCandidates)) return [];
  return scan.topCandidates.filter(
    (candidate): candidate is MarketQuote =>
      Boolean(
        candidate &&
          typeof candidate === "object" &&
          typeof (candidate as MarketQuote).symbol === "string" &&
          (candidate as MarketQuote).symbol.trim().length > 0
      )
  );
}

export function evidenceSourceLabel(source?: string | null): string {
  if (!source) return "";
  return formatSourceList(source) || friendlySource(source);
}

export function evidenceKindLabel(kind?: string | null): string {
  if (!kind) return "Evidence";
  return plainLabel(kind);
}

export function toneFromSocratic(tone: string | undefined): EvidenceRow["tone"] {
  if (tone === "positive") return "pos";
  if (tone === "negative") return "neg";
  if (tone === "warning") return "warn";
  return "accent";
}

export function sourceListFromQuote(candidate: MarketQuote): string {
  const sources = Object.values(candidate.sources ?? {}).filter(Boolean);
  if (candidate.provider) sources.unshift(candidate.provider);
  return formatSourceList(sources.join("+"));
}

export function evidenceFromCandidate(candidate: MarketQuote): EvidenceRow {
  const bullet = candidate.evidenceBulletins?.[0] ?? candidate.headlines?.[0];
  const sources = sourceListFromQuote(candidate) || evidenceSourceLabel(candidate.provider);
  const score = typeof candidate.score === "number" && Number.isFinite(candidate.score) ? candidate.score : 0;
  const changePct =
    typeof candidate.intradayChangePct === "number" && Number.isFinite(candidate.intradayChangePct)
      ? candidate.intradayChangePct
      : 0;
  return {
    title: candidate.symbol,
    symbol: candidate.symbol,
    quote: candidate,
    meta: `score ${Math.round(score)}${sources ? ` · ${sources}` : ""}`,
    metaTitle: sources ? `Data sources: ${sources}` : undefined,
    body:
      bullet ??
      `${candidate.companyName ?? candidate.symbol} was in the latest candidate set with ${fmtPct(changePct, 2, true)} intraday change.`,
    tone: changePct < 0 ? "warn" : "pos"
  };
}

function proposalAttributionRows(p?: TradeProposal): EvidenceRow[] {
  const extra: EvidenceRow[] = [];
  if (p?.proposedByModel) {
    extra.push({
      title: "Model attribution",
      meta: p.proposedByModel,
      body: "The proposal stores the model that actually generated it, so later outcome review can score models instead of guessing.",
      tone: "pos"
    });
  }
  if (p?.redTeamVerdict) {
    const verdict = p.redTeamVerdict;
    if (verdict.available) {
      extra.push({
        title: "Adversarial review",
        meta: verdict.model ?? "red team",
        body: verdict.reason,
        tone: verdict.rejected ? "neg" : "warn"
      });
    } else {
      const failure = redTeamFailureMeta(verdict.failureKind);
      extra.push({
        title: "Adversarial review FAILED",
        meta: [verdict.model, failure.label].filter(Boolean).join(" · ") || failure.label,
        metaTitle: failure.title,
        body: verdict.reason,
        tone: "warn"
      });
    }
  }
  return extra;
}

export function deriveEvidenceRows(
  snapshot: DashboardSnapshot,
  latest: StrategyDecision | undefined,
  decision?: SocraticDecisionCase,
  proposal?: TradeProposal
): EvidenceRow[] {
  const p = proposal ?? latest?.proposals?.[0]?.proposal ?? snapshot.pendingProposals[0]?.proposal;
  const extra = proposalAttributionRows(p);
  const rows: EvidenceRow[] = [];
  if (decision) {
    // Persisted decision cases can predate evidence/rag arrays or arrive partial from older rows.
    for (const item of (decision.evidence ?? []).slice(0, 5)) {
      const source = evidenceSourceLabel(item.source);
      rows.push({
        title: item.title,
        meta: [evidenceKindLabel(item.kind), source].filter(Boolean).join(" · "),
        metaTitle: source ? `Source: ${source}` : undefined,
        body: item.summary,
        tone: toneFromSocratic(item.tone)
      });
    }
    for (const rag of (decision.ragAttributions ?? []).slice(0, 2)) {
      if (rows.some((r) => r.body === rag.contribution)) continue;
      const source = evidenceSourceLabel(rag.source);
      rows.push({
        title: rag.docType ? `Retrieved ${plainLabel(rag.docType)}` : "Retrieved evidence",
        meta: [source, rag.score != null ? `score ${rag.score.toFixed(2)}` : rag.symbol].filter(Boolean).join(" · "),
        metaTitle: source ? `Source: ${source}` : undefined,
        body: rag.contribution,
        tone: "accent"
      });
    }
    if (rows.length > 0) {
      return [...rows.slice(0, Math.max(0, 6 - extra.length)), ...extra].slice(0, 6);
    }
  }
  const scan = snapshot.latestScan;
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
    // latestScan can be a truthy partial audit shape without topCandidates (strategy_run /
    // market_scan history). Never call .slice on a missing array — that white-screened /console.
    for (const candidate of safeTopCandidates(scan).slice(0, 3)) rows.push(evidenceFromCandidate(candidate));
  }

  return [...rows.slice(0, Math.max(0, 6 - extra.length)), ...extra].slice(0, 6);
}
