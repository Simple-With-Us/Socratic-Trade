import { normalizeSymbol } from "./money";
import type { RedTeamDebateResult } from "./red-team";
import type { RetrievedChunk } from "./vector-db";
import type {
  MarketQuote,
  MarketQuoteSummary,
  MarketScan,
  PolicyDecision,
  Portfolio,
  ReviewedOrder,
  SocraticDecisionCase,
  SocraticDecisionStatus,
  SocraticEvidenceItem,
  SocraticFrameworkProposal,
  SocraticRagAttribution,
  StrategyAuthority,
  TradeProposal,
  TradingPolicy
} from "./types";

export interface SocraticOverrideResolution {
  requested: boolean;
  applied: boolean;
  routeToHuman: boolean;
  conflicts: string[];
  hardReasons: string[];
  decision: PolicyDecision;
}

const OVERRIDEABLE_PATTERNS = [
  "System is halted.",
  "System is close-only.",
  "Allowed universe is required.",
  "is not in the allowed universe",
  "orders are not permitted",
  "Extended-hours orders are disabled.",
  "entry_drift:",
  "staleness_gate:",
  "exceeds the maximum order limit",
  "leaves less than",
  "Daily notional limit",
  "Hourly notional limit",
  "Daily opening-order count limit",
  "ADV cap",
  "crisis/inverted-regime cap",
  "maxShortExposurePct",
  "Projected total short exposure",
  "Projected gross exposure",
  "Projected net exposure",
  "Projected portfolio beta",
  "Projected",
  "Stop-loss rule blocks adding",
  "Take-profit rule blocks adding",
  "Cannot average up on short"
];

const HARD_PATTERNS = [
  "No Robinhood account is selected.",
  "not tradable",
  "buying power",
  "Sell quantity exceeds",
  "Cover quantity exceeds",
  "exit must specify",
  "margin_minimum:",
  "wash-sale",
  "wash sale",
  "Fractional or dollar-based orders must be regular-hours only.",
  "connected account does not support short selling",
  "short-selling is disabled",
  "Short proposals must carry a mandatory stop-loss",
  "broker",
  "PERMANENTLY",
  "Bracket orders require"
];

function reasonMatches(reason: string, patterns: string[]): boolean {
  const lower = reason.toLowerCase();
  return patterns.some((pattern) => lower.includes(pattern.toLowerCase()));
}

function overrideableReason(reason: string): boolean {
  if (reasonMatches(reason, HARD_PATTERNS)) return false;
  return reasonMatches(reason, OVERRIDEABLE_PATTERNS);
}

export function resolveSocraticOverride(input: {
  proposal: TradeProposal;
  policy: TradingPolicy;
  portfolio: Portfolio;
  estimatedNotional?: number;
  decision: PolicyDecision;
}): SocraticOverrideResolution {
  const { proposal, policy, decision } = input;
  const requested = proposal.autonomyOverride?.requested === true;
  if (!requested || decision.approved) {
    return { requested, applied: false, routeToHuman: false, conflicts: [], hardReasons: [], decision };
  }

  const isOpening = proposal.side === "buy" || proposal.side === "short";
  const mode = policy.socraticOverrideMode ?? "off";
  if (!isOpening || mode === "off" || !proposal.autonomyOverride?.thesis?.trim()) {
    return { requested, applied: false, routeToHuman: false, conflicts: [], hardReasons: decision.reasons, decision };
  }

  const conflicts = decision.reasons.filter(overrideableReason);
  const hardReasons = decision.reasons.filter((reason) => !overrideableReason(reason));
  const nav = input.portfolio.totalMarketValue;
  const overrideCapPct = policy.socraticOverrideMaxPctOfNav;
  const overrideCap = overrideCapPct != null && overrideCapPct > 0 && nav > 0 ? (overrideCapPct / 100) * nav : Infinity;
  const notional = input.estimatedNotional ?? proposal.dollarAmount ?? 0;
  const withinOverrideCap = !Number.isFinite(overrideCap) || notional <= overrideCap;

  if (hardReasons.length > 0 || conflicts.length === 0 || !withinOverrideCap) {
    const capReason =
      withinOverrideCap || !Number.isFinite(overrideCap)
        ? undefined
        : `Socratic override request exceeded override cap: $${notional.toFixed(2)} > $${overrideCap.toFixed(2)}.`;
    return {
      requested,
      applied: false,
      routeToHuman: false,
      conflicts,
      hardReasons: capReason ? [...hardReasons, capReason] : hardReasons,
      decision
    };
  }

  const override = {
    applied: true,
    mode: mode as "propose" | "execute",
    conflicts,
    thesis: proposal.autonomyOverride.thesis,
    ...(proposal.autonomyOverride.invalidation ? { invalidation: proposal.autonomyOverride.invalidation } : {}),
    ...(typeof proposal.autonomyOverride.cashDeploymentPct === "number"
      ? { cashDeploymentPct: proposal.autonomyOverride.cashDeploymentPct }
      : {})
  };
  return {
    requested,
    applied: true,
    routeToHuman: mode === "propose",
    conflicts,
    hardReasons: [],
    decision: {
      ...decision,
      approved: true,
      reasons: [`Socratic override applied over owner preference gate(s): ${conflicts.join(" | ")}`],
      socraticOverride: override
    }
  };
}

export function applySocraticOverrideSizing(proposal: TradeProposal, policy: TradingPolicy, portfolio: Portfolio): TradeProposal {
  if (proposal.autonomyOverride?.requested !== true) return proposal;
  if (proposal.side !== "buy" && proposal.side !== "short") return proposal;
  const pct = proposal.autonomyOverride.cashDeploymentPct;
  if (typeof pct !== "number" || !Number.isFinite(pct) || pct <= 0) return proposal;

  const cappedPct = Math.max(0, Math.min(100, pct));
  const requestedBase = proposal.side === "buy" ? portfolio.buyingPower : portfolio.totalMarketValue;
  const requestedNotional = Math.floor((cappedPct / 100) * Math.max(0, requestedBase));
  const overrideCapPct = policy.socraticOverrideMaxPctOfNav;
  const overrideCap =
    overrideCapPct != null && overrideCapPct > 0 && portfolio.totalMarketValue > 0
      ? Math.floor((overrideCapPct / 100) * portfolio.totalMarketValue)
      : Infinity;
  const target = Math.min(requestedNotional, overrideCap);
  const current = proposal.dollarAmount ?? 0;
  if (!Number.isFinite(target) || target <= current || target <= 0) return proposal;

  return {
    ...proposal,
    dollarAmount: target,
    quantity: undefined,
    rationale:
      proposal.rationale +
      `\n\n[Socratic override sizing] Requested ${cappedPct}% deployment; raised advised notional to $${target.toLocaleString("en-US")} before policy review.`
  };
}

/** Human-readable one-liner for an ADVISORY Red Team suggested change (receipt text — never applied). */
export function describeSuggestedChange(change: { sizeMultiplier?: number; stopPrice?: number; limitPrice?: number }): string {
  const parts: string[] = [];
  if (typeof change.sizeMultiplier === "number") parts.push(`size x${change.sizeMultiplier}`);
  if (typeof change.stopPrice === "number") parts.push(`stop $${change.stopPrice}`);
  if (typeof change.limitPrice === "number") parts.push(`limit $${change.limitPrice}`);
  return parts.length > 0 ? parts.join(", ") : "no concrete change stated";
}

/**
 * Apply an approval-time Red Team debate result to a proposal WITHOUT mutating its rationale
 * (composite review A/medium: the old "Red Team Debate Survived:" appends corrupted the exact
 * thesis text that gets embedded for retrieval). Persists three receipts:
 *   1. the FULL structured verdict on `redTeamVerdict` (verdict/keyRisks/invalidationTriggers/
 *      suggestedChange/wouldApproveIf/confidence — composite review A/B high);
 *   2. survived-notes + the ADVISORY suggestedChange annotation on the separate `reviewNotes`
 *      field — suggestedChange is a receipt for the owner, NEVER auto-applied to size/stop/limit;
 *   3. the immutable `debateTranscript` (bull thesis, full bear response, trigger, model+tokens
 *      per side), written once here and never mutated afterward.
 */
export function annotateProposalWithDebate(
  proposal: TradeProposal,
  result: RedTeamDebateResult,
  trigger?: NonNullable<TradeProposal["redTeamVerdict"]>["trigger"]
): void {
  proposal.redTeamVerdict = {
    rejected: result.rejected,
    available: result.available,
    reason: result.reason,
    ...(result.model ? { model: result.model } : {}),
    ...(trigger ? { trigger } : {}),
    ...(result.verdict ? { verdict: result.verdict } : {}),
    ...(result.keyRisks && result.keyRisks.length > 0 ? { keyRisks: result.keyRisks } : {}),
    ...(result.invalidationTriggers && result.invalidationTriggers.length > 0 ? { invalidationTriggers: result.invalidationTriggers } : {}),
    ...(result.suggestedChange !== undefined ? { suggestedChange: result.suggestedChange } : {}),
    ...(result.wouldApproveIf ? { wouldApproveIf: result.wouldApproveIf } : {}),
    ...(typeof result.confidence === "number" ? { confidence: result.confidence } : {})
  };
  if (!result.available) return;
  proposal.debateTranscript = {
    bullThesis: proposal.rationale,
    ...(proposal.belief ? { bullBelief: proposal.belief } : {}),
    bearResponse: result.reason,
    ...(trigger ? { trigger } : {}),
    sides: [
      { role: "bull", ...(proposal.proposedByModel ? { model: proposal.proposedByModel } : {}) },
      {
        role: "bear",
        ...(result.model ? { model: result.model } : {}),
        ...(typeof result.usage?.promptTokens === "number" ? { promptTokens: result.usage.promptTokens } : {}),
        ...(typeof result.usage?.completionTokens === "number" ? { completionTokens: result.usage.completionTokens } : {})
      }
    ],
    at: new Date().toISOString()
  };
  if (!result.rejected) {
    const notes = [...(proposal.reviewNotes ?? [])];
    notes.push(`Red Team debate survived${result.verdict === "approve_with_changes" ? " (approve_with_changes)" : ""}: ${result.reason}`);
    if (result.suggestedChange && Object.keys(result.suggestedChange).length > 0) {
      notes.push(`Red Team suggested change (ADVISORY receipt — not applied): ${describeSuggestedChange(result.suggestedChange)}`);
    }
    proposal.reviewNotes = notes;
  }
}

/**
 * Non-actions as first-class case files (composite review A/high): per-symbol "passed" cases from
 * the Bull's passedOn[] and a run-level "waited" case when a run proposes nothing. Ids are
 * deterministic per run (idempotent re-upserts, no crypto dependency in this leaf module).
 */
export function buildSocraticNonActionCase(input: {
  id?: string;
  userId: string;
  connectedAccountId?: string;
  runId: string;
  accountNumber?: string;
  kind: "passed" | "waited";
  symbol?: string;
  reason: string;
  wouldReconsiderIf?: string;
  regime?: string;
  authority: StrategyAuthority;
}): Omit<SocraticDecisionCase, "createdAt" | "updatedAt"> {
  const symbol = input.symbol ? normalizeSymbol(input.symbol) : undefined;
  return {
    id: input.id ?? `${input.runId}:${input.kind}${symbol ? `:${symbol}` : ""}`,
    userId: input.userId,
    ...(input.connectedAccountId ? { connectedAccountId: input.connectedAccountId } : {}),
    runId: input.runId,
    ...(input.accountNumber ? { accountNumber: input.accountNumber } : {}),
    ...(symbol ? { symbol } : {}),
    status: input.kind,
    authority: input.authority,
    thesis: input.kind === "passed" ? `Deliberately passed on ${symbol}` : "Deliberately waited — no trades this run",
    rationale: input.reason,
    action: input.kind === "passed" ? `PASSED ${symbol}` : "WAITED",
    ...(input.regime ? { regime: input.regime } : {}),
    evidence: [
      {
        kind: "learning",
        title: input.kind === "passed" ? "Pass reason" : "Wait reason",
        summary: input.reason,
        ...(symbol ? { symbol } : {}),
        tone: "neutral"
      }
    ],
    ragAttributions: [],
    dissent: [],
    lessons: [],
    coachNotes: [],
    ...(input.wouldReconsiderIf ? { wouldReconsiderIf: input.wouldReconsiderIf } : {})
  };
}

export function ragAttributionsFromChunks(symbol: string, query: string, chunks: RetrievedChunk[]): SocraticRagAttribution[] {
  return chunks.slice(0, 5).map((chunk) => ({
    symbol: normalizeSymbol(symbol),
    query,
    ...(chunk.id ? { chunkId: chunk.id } : {}),
    ...(chunk.source ? { source: chunk.source } : {}),
    ...(chunk.doc_type ? { docType: chunk.doc_type } : {}),
    ...(chunk.section ? { title: chunk.section } : {}),
    ...(chunk.url ? { url: chunk.url } : {}),
    ...(chunk.as_of ? { publishedAt: chunk.as_of } : {}),
    ...(typeof chunk.score === "number" ? { score: chunk.score } : {}),
    ...(typeof chunk.relevanceScore === "number" ? { relevanceScore: chunk.relevanceScore } : {}),
    text: chunk.text.slice(0, 900),
    contribution: `Retrieved context for ${normalizeSymbol(symbol)} (${chunk.doc_type ?? "context"}) with score ${
      typeof chunk.score === "number" ? chunk.score.toFixed(2) : "n/a"
    }.`
  }));
}

function candidateForProposal(proposal: TradeProposal, marketScan?: MarketScan): MarketQuote | MarketQuoteSummary | undefined {
  const symbol = normalizeSymbol(proposal.symbol);
  return (
    marketScan?.quotesBySymbol[symbol] ??
    marketScan?.topCandidates.find((candidate) => normalizeSymbol(candidate.symbol) === symbol)
  );
}

function formatAction(proposal: TradeProposal, notional?: number): string {
  const size =
    typeof notional === "number" && Number.isFinite(notional) && notional > 0
      ? `$${Math.round(notional).toLocaleString("en-US")}`
      : proposal.dollarAmount
        ? `$${Math.round(proposal.dollarAmount).toLocaleString("en-US")}`
        : proposal.quantity
          ? `${proposal.quantity} sh`
          : "unsized";
  return `${proposal.side.toUpperCase()} ${normalizeSymbol(proposal.symbol)} ${size}`;
}

function evidenceForDecision(input: {
  proposal: TradeProposal;
  status: SocraticDecisionStatus;
  decision: PolicyDecision;
  marketScan?: MarketScan;
  ragAttributions: SocraticRagAttribution[];
  notional?: number;
  overrideResolution?: SocraticOverrideResolution;
}): SocraticEvidenceItem[] {
  const { proposal, decision } = input;
  const candidate = candidateForProposal(proposal, input.marketScan);
  const rows: SocraticEvidenceItem[] = [];
  rows.push({
    kind: "policy",
    title: `${input.status[0].toUpperCase()}${input.status.slice(1)} decision`,
    summary: decision.approved
      ? `Policy approved ${formatAction(proposal, input.notional)}.`
      : `Policy blocked ${formatAction(proposal, input.notional)}: ${decision.reasons.join(" | ")}`,
    symbol: normalizeSymbol(proposal.symbol),
    tone: decision.approved ? "positive" : "warning",
    data: decision
  });
  if (candidate) {
    const intradayChangePct = typeof candidate.intradayChangePct === "number" ? candidate.intradayChangePct : 0;
    rows.push({
      kind: "candidate",
      title: `${normalizeSymbol(proposal.symbol)} scan evidence`,
      summary:
        candidate.evidenceBulletins?.[0] ??
        candidate.headlines?.[0] ??
        `${candidate.companyName ?? normalizeSymbol(proposal.symbol)} scored ${Math.round(candidate.score)} with ${intradayChangePct.toFixed(2)}% intraday change.`,
      source: "provider" in candidate ? candidate.provider : candidate.sources?.price,
      symbol: normalizeSymbol(proposal.symbol),
      score: candidate.score,
      tone: intradayChangePct >= 0 ? "positive" : "warning",
      data: candidate
    });
  }
  for (const rag of input.ragAttributions.filter((row) => normalizeSymbol(row.symbol) === normalizeSymbol(proposal.symbol)).slice(0, 3)) {
    rows.push({
      kind: "rag",
      title: rag.source ?? rag.docType ?? "Retrieved context",
      summary: rag.contribution,
      source: rag.url ?? rag.source,
      symbol: rag.symbol,
      score: rag.score,
      tone: "neutral",
      data: rag
    });
  }
  if (input.overrideResolution?.applied) {
    rows.push({
      kind: "override",
      title: "Socratic override",
      summary: proposal.autonomyOverride?.thesis ?? "Socratic Trade overrode owner preference gates.",
      symbol: normalizeSymbol(proposal.symbol),
      tone: "positive",
      data: input.overrideResolution
    });
  }
  return rows.slice(0, 8);
}

function dissentForDecision(proposal: TradeProposal, decision: PolicyDecision, overrideResolution?: SocraticOverrideResolution): SocraticEvidenceItem[] {
  const rows: SocraticEvidenceItem[] = [];
  if (proposal.redTeamVerdict?.available) {
    rows.push({
      kind: "red_team",
      title: proposal.redTeamVerdict.rejected ? "Red Team rejection" : "Red Team objection",
      summary: proposal.redTeamVerdict.reason,
      source: proposal.redTeamVerdict.model,
      symbol: normalizeSymbol(proposal.symbol),
      tone: proposal.redTeamVerdict.rejected ? "negative" : "warning",
      data: proposal.redTeamVerdict
    });
  }
  const hardReasons = overrideResolution?.hardReasons ?? [];
  for (const reason of hardReasons.length > 0 ? hardReasons : decision.reasons.slice(0, 3)) {
    rows.push({
      kind: "policy",
      title: hardReasons.includes(reason) ? "Hard refusal" : "Policy counterargument",
      summary: reason,
      symbol: normalizeSymbol(proposal.symbol),
      tone: "warning"
    });
  }
  // Deliberate self-dissent (composite review B/medium strongestCounterRead) + the Red Team's
  // keyed risks (structured verdict) — receipts-first: the case's Dissent block should show every
  // opposing read that was on the table, not just the boolean outcome.
  if (proposal.strongestCounterRead) {
    rows.push({
      kind: "red_team",
      title: "Strongest counter-read (Bull self-dissent)",
      summary: proposal.strongestCounterRead,
      symbol: normalizeSymbol(proposal.symbol),
      tone: "warning"
    });
  }
  for (const risk of proposal.redTeamVerdict?.keyRisks?.slice(0, 3) ?? []) {
    rows.push({
      kind: "red_team",
      title: "Red Team key risk",
      summary: risk,
      symbol: normalizeSymbol(proposal.symbol),
      tone: "warning"
    });
  }
  if (proposal.autonomyOverride?.invalidation) {
    rows.push({
      kind: "override",
      title: "Invalidation condition",
      summary: proposal.autonomyOverride.invalidation,
      symbol: normalizeSymbol(proposal.symbol),
      tone: "neutral"
    });
  }
  return rows.slice(0, 8);
}

export function buildSocraticDecisionCase(input: {
  id?: string;
  userId: string;
  connectedAccountId?: string;
  runId: string;
  proposalId: string;
  accountNumber?: string;
  proposal: TradeProposal;
  status: SocraticDecisionStatus;
  authority: StrategyAuthority;
  decision: PolicyDecision;
  review?: ReviewedOrder;
  marketScan?: MarketScan;
  ragAttributions?: SocraticRagAttribution[];
  overrideResolution?: SocraticOverrideResolution;
}): Omit<SocraticDecisionCase, "createdAt" | "updatedAt"> {
  const ragAttributions = input.ragAttributions ?? [];
  const notional = input.review?.estimatedNotional ?? input.proposal.dollarAmount;
  const override = input.proposal.autonomyOverride
    ? {
        ...input.proposal.autonomyOverride,
        applied: input.overrideResolution?.applied === true,
        conflicts: input.overrideResolution?.conflicts ?? input.proposal.autonomyOverride.preferenceConflicts ?? []
      }
    : undefined;
  return {
    id: input.id ?? input.proposalId,
    userId: input.userId,
    ...(input.connectedAccountId ? { connectedAccountId: input.connectedAccountId } : {}),
    runId: input.runId,
    proposalId: input.proposalId,
    ...(input.accountNumber ? { accountNumber: input.accountNumber } : {}),
    symbol: normalizeSymbol(input.proposal.symbol),
    side: input.proposal.side,
    status: input.status,
    authority: input.authority,
    thesis: input.proposal.tradeThesisTag,
    rationale: input.proposal.rationale,
    action: formatAction(input.proposal, notional),
    thesisTag: input.proposal.tradeThesisTag,
    regime: input.proposal.entryMarketRegime,
    ...(typeof input.proposal.confidenceScore === "number" ? { confidenceScore: input.proposal.confidenceScore } : {}),
    ...(typeof notional === "number" ? { notional } : {}),
    ...(input.proposal.proposedByModel ? { model: input.proposal.proposedByModel } : {}),
    ...(input.proposal.redTeamVerdict ? { redTeamVerdict: input.proposal.redTeamVerdict } : {}),
    policyDecision: input.decision,
    evidence: evidenceForDecision({
      proposal: input.proposal,
      status: input.status,
      decision: input.decision,
      marketScan: input.marketScan,
      ragAttributions,
      notional,
      overrideResolution: input.overrideResolution
    }),
    ragAttributions: ragAttributions.filter((row) => normalizeSymbol(row.symbol) === normalizeSymbol(input.proposal.symbol)),
    dissent: dissentForDecision(input.proposal, input.decision, input.overrideResolution),
    ...(override ? { autonomyOverride: override } : {}),
    lessons: [
      input.status === "placed" ? "Track realized outcome against the stated thesis and invalidation note." : "",
      input.status === "blocked" && input.proposal.autonomyOverride?.requested ? "Override request did not clear the hard/preference split; review classifier or mandate." : "",
      input.overrideResolution?.applied ? "Owner preference gate was explicitly overridden; measure whether the autonomy judgment improved returns." : ""
    ].filter(Boolean),
    coachNotes: [],
    // Socratic first-class fields (composite review B/high): thread every field the schemas
    // round-trip onto the case so it persists (socratic_ext) and reaches the memory vector text.
    ...(input.proposal.belief ? { belief: input.proposal.belief } : {}),
    ...(input.proposal.iMayBeWrongIf?.length ? { iMayBeWrongIf: input.proposal.iMayBeWrongIf } : {}),
    ...(input.proposal.reversalTriggers?.length ? { reversalTriggers: input.proposal.reversalTriggers } : {}),
    ...(input.proposal.evidenceRefs?.length ? { evidenceRefs: input.proposal.evidenceRefs } : {}),
    ...(input.proposal.usedEvidence?.length ? { usedEvidence: input.proposal.usedEvidence } : {}),
    ...(input.proposal.strongestCounterRead ? { strongestCounterRead: input.proposal.strongestCounterRead } : {}),
    ...(input.proposal.reviewNotes?.length ? { reviewNotes: input.proposal.reviewNotes } : {}),
    ...(input.proposal.debateTranscript ? { debateTranscript: input.proposal.debateTranscript } : {})
  };
}

export function frameworkProposalFromDecision(decision: SocraticDecisionCase): Omit<SocraticFrameworkProposal, "id" | "createdAt" | "updatedAt" | "status"> | undefined {
  if (decision.autonomyOverride?.applied) {
    return {
      userId: decision.userId,
      ...(decision.connectedAccountId ? { connectedAccountId: decision.connectedAccountId } : {}),
      decisionId: decision.id,
      ...(decision.runId ? { runId: decision.runId } : {}),
      priority: "high",
      subsystem: "risk",
      title: `Review overridden ${decision.symbol ?? "symbol"} gate`,
      rationale: `Socratic Trade overrode: ${decision.autonomyOverride.conflicts.join(" | ")}`,
      proposedChange:
        "Score this override after the position matures. If it outperforms the blocked baseline, relax the matching preference gate for similar regimes; if it fails, tighten the override classifier.",
      evidence: decision.evidence.filter((item) => item.kind === "override" || item.kind === "policy" || item.kind === "candidate")
    };
  }
  if (decision.autonomyOverride?.requested && decision.status === "blocked") {
    return {
      userId: decision.userId,
      ...(decision.connectedAccountId ? { connectedAccountId: decision.connectedAccountId } : {}),
      decisionId: decision.id,
      ...(decision.runId ? { runId: decision.runId } : {}),
      priority: "medium",
      subsystem: "risk",
      title: `Blocked override request for ${decision.symbol ?? "symbol"}`,
      rationale: "The agent asked to override but the decision still hit a hard or unclassified refusal.",
      proposedChange:
        "Audit whether the refusal was truly non-overridable. If it was merely an owner preference, add it to the Socratic override allowlist; otherwise keep it hard and update the prompt to stop asking.",
      evidence: [...decision.dissent, ...decision.evidence].slice(0, 6)
    };
  }
  return undefined;
}

export function socraticStatusFromProposalStatus(status: string): SocraticDecisionStatus {
  if (status === "placed") return "placed";
  if (status === "proposed") return "proposed";
  if (status === "blocked") return "blocked";
  if (status === "rejected" || status === "rejected_by_broker") return "rejected";
  if (status === "error" || status === "placing_failed") return "error";
  // Wave-3 schema & dissent statuses: Red-Team/deterministic vetoes and non-action case files.
  if (status === "vetoed") return "vetoed";
  if (status === "waited") return "waited";
  if (status === "passed") return "passed";
  return "planned";
}
