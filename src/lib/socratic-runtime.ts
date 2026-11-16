import { createHash } from "crypto";
import { normalizeSymbol } from "./money";
import { isHardGateReason } from "./policy";
import { stableRagEvidenceRef, type PromptRagCandidate } from "./rag/evidence-consumption";
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

/**
 * Owner guardrail philosophy (2026-07-05): a policy block is overridable by the agent's logged
 * `autonomyOverride` thesis UNLESS it is a hard gate — the account boundary or a physical / broker /
 * regulatory / accounting impossibility. This is a DENYLIST (overridable-by-default), inverted from the
 * former hand-maintained allowlist so a new risk-preference gate is overridable automatically instead
 * of silently un-overridable. The hard/preference split is the single source of truth in the risk
 * engine (policy.isHardGateReason), co-located with the gates that produce the reasons.
 */
function overrideableReason(reason: string): boolean {
  return !isHardGateReason(reason);
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

export function ragEvidenceIdentityFromChunk(
  symbol: string,
  chunk: RetrievedChunk
): Omit<PromptRagCandidate, "serializedText" | "text"> {
  const metadata = chunk.metadata ?? {};
  return {
    ...(chunk.id ? { chunkId: chunk.id } : {}),
    symbol: normalizeSymbol(symbol),
    ...(chunk.source ? { source: chunk.source } : {}),
    ...(chunk.doc_type ? { docType: chunk.doc_type } : {}),
    ...(typeof metadata.accession === "string" ? { accession: metadata.accession } : {}),
    ...(chunk.section ? { section: chunk.section } : {}),
    ...(typeof metadata.chunk_ordinal === "number"
      ? { ordinal: metadata.chunk_ordinal }
      : typeof metadata.ordinal === "number"
        ? { ordinal: metadata.ordinal }
        : {}),
    ...(typeof metadata.content_hash === "string" ? { contentHash: metadata.content_hash } : {}),
    ...(typeof metadata.vector_namespace === "string" ? { vectorNamespace: metadata.vector_namespace } : {}),
    ...(chunk.scope ? { scope: chunk.scope } : {}),
    ...(typeof metadata.tenant_scope === "string" ? { tenantScope: metadata.tenant_scope } : {}),
    ...(chunk.section ? { title: chunk.section } : {}),
    ...(chunk.url ? { url: chunk.url } : {}),
    ...(chunk.as_of ? { publishedAt: chunk.as_of } : {}),
    ...(typeof chunk.score === "number" ? { score: chunk.score } : {}),
    ...(typeof chunk.relevanceScore === "number" ? { relevanceScore: chunk.relevanceScore } : {})
  };
}

export function ragAttributionsFromChunks(symbol: string, query: string, chunks: RetrievedChunk[]): SocraticRagAttribution[] {
  return chunks.map((chunk) => ({
    symbol: normalizeSymbol(symbol),
    evidenceRef: stableRagEvidenceRef(ragEvidenceIdentityFromChunk(symbol, chunk)),
    queryHash: createHash("sha256").update(query, "utf8").digest("hex").slice(0, 24),
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
    // Distinguish "Bear rejected AND blocked" from "Bear rejected but OVERRIDDEN & executed": an
    // overridden veto is advisory (a logged rationale let the opening proceed), so it reads as a
    // warning, not a hard negative, and the title says so.
    const overridden = overrideResolution?.applied === true;
    rows.push({
      kind: "red_team",
      title: proposal.redTeamVerdict.rejected
        ? overridden
          ? "Red Team rejection (overridden)"
          : "Red Team rejection"
        : "Red Team objection",
      summary: overridden
        ? `${proposal.redTeamVerdict.reason} — overridden by a logged autonomy thesis; trade allowed to proceed.`
        : proposal.redTeamVerdict.reason,
      source: proposal.redTeamVerdict.model,
      symbol: normalizeSymbol(proposal.symbol),
      tone: proposal.redTeamVerdict.rejected && !overridden ? "negative" : "warning",
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
  if (proposal.autonomyOverride?.invalidation) {
    rows.push({
      kind: "override",
      title: "Invalidation condition",
      summary: proposal.autonomyOverride.invalidation,
      symbol: normalizeSymbol(proposal.symbol),
      tone: "neutral"
    });
  }
  return rows.slice(0, 6);
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
  /** Run-level advisory receipts appended to the evidence list (e.g. kind 'safety'
   * prompt-injection / evidence-age items from src/lib/prompt-safety.ts). */
  extraEvidence?: SocraticEvidenceItem[];
  /** Typed retrieval-status receipt for this run (typed-retrieval-status, 2026-07-06) — see
   * `SocraticDecisionCase.ragRetrievalStatus`. Persistence only, never rendered. */
  ragRetrievalStatus?: { symbol: string; status: string; reason?: string }[];
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
    ...(input.proposal.greenTeamRationale ? { greenTeamRationale: input.proposal.greenTeamRationale } : {}),
    ...(input.proposal.sizingSnapshot ? { sizingSnapshot: input.proposal.sizingSnapshot } : {}),
    action: formatAction(input.proposal, notional),
    thesisTag: input.proposal.tradeThesisTag,
    regime: input.proposal.entryMarketRegime,
    ...(typeof input.proposal.confidenceScore === "number" ? { confidenceScore: input.proposal.confidenceScore } : {}),
    ...(typeof notional === "number" ? { notional } : {}),
    ...(input.proposal.proposedByModel ? { model: input.proposal.proposedByModel } : {}),
    ...(input.proposal.redTeamVerdict ? { redTeamVerdict: input.proposal.redTeamVerdict } : {}),
    policyDecision: input.decision,
    evidence: [
      ...evidenceForDecision({
        proposal: input.proposal,
        status: input.status,
        decision: input.decision,
        marketScan: input.marketScan,
        ragAttributions,
        notional,
        overrideResolution: input.overrideResolution
      }),
      // Appended AFTER the per-proposal evidence (which is capped at 8) so safety receipts are
      // never crowded out by candidate/market rows.
      //
      // This ordering is DELIBERATE and safety-load-bearing, not incidental: kind-'safety' items
      // (prompt-injection / evidence-age receipts from src/lib/prompt-safety.ts) land at the TAIL
      // of this array. Downstream summarizers that feed the RAG/lesson-learning prompts take a
      // fixed-size PREFIX slice — socratic-memory.ts summarizeEvidence does .slice(0, 5) and
      // outcome-engine.ts's lesson pass does decisionCase.evidence.slice(0, 6) — so as long as a
      // case has >5/>6 proposal-evidence rows ahead of them, the tail-appended safety items are
      // excluded from what gets summarized back into memory/lessons. Do NOT reorder extraEvidence
      // to the front (or otherwise make it appear before the slice cutoff): that would let a
      // detected injection attempt's own excerpt text ride into the RAG/lesson corpus, creating a
      // detection -> memory -> re-detection feedback loop where the scanner's receipts become
      // future "learned" input. Keep safety receipts append-only and tail-positioned.
      ...(input.extraEvidence ?? [])
    ],
    ragAttributions: ragAttributions.filter((row) => normalizeSymbol(row.symbol) === normalizeSymbol(input.proposal.symbol)),
    ...(input.ragRetrievalStatus && input.ragRetrievalStatus.length > 0 ? { ragRetrievalStatus: input.ragRetrievalStatus } : {}),
    dissent: dissentForDecision(input.proposal, input.decision, input.overrideResolution),
    ...(override ? { autonomyOverride: override } : {}),
    lessons: [
      input.status === "placed" || input.status === "filled" ? "Track realized outcome against the stated thesis and invalidation note." : "",
      input.status === "blocked" && input.proposal.autonomyOverride?.requested ? "Override request did not clear the hard/preference split; review classifier or mandate." : "",
      input.overrideResolution?.applied ? "Owner preference gate was explicitly overridden; measure whether the autonomy judgment improved returns." : ""
    ].filter(Boolean),
    coachNotes: []
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
  if (status === "placed" || status === "paper") return "placed";
  if (status === "filled") return "filled";
  if (status === "proposed") return "proposed";
  if (status === "placing") return "placing";
  if (status === "blocked") return "blocked";
  if (status === "rejected" || status === "rejected_by_red_team") return "rejected";
  if (status === "rejected_by_broker") return "rejected_by_broker";
  if (status === "not_placed" || status === "placing_failed") return "not_placed";
  if (status === "expired") return "expired";
  if (status === "withdrawn") return "withdrawn";
  if (status === "error" || status === "failed") return "error";
  return "planned";
}
