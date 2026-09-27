// The learned_context store: the ONLY writer/reader of the learned_context table on behalf of the
// learning loop. It is the safety boundary between producers (chat salience, post-mortem) and the
// strategy brain.
//
// WRITE side (ingestLearned):
//   - Runs the fail-closed classifier (classify.ts) + PII gate on every candidate.
//   - tier 'fact'  → written as scope='shared' if the user's contributeShared pref is on,
//                    otherwise scope='private'. PII is always excluded upstream.
//   - tier 'risk'/'strategy-directive' → route to the pending-changes queue (autonomous/ingest)
//     or HARD-CAP drop (chat). Nothing above 'fact' is EVER written as scope='shared'.
//   - Chat-origin candidates are HARD-CAPPED at 'fact': a chat message can never produce a
//     risk-tier change; if it classifies above 'fact' it is dropped+audited.
//
// READ side (retrieveLearnedContext):
//   - READ-ONLY. Returns advisory fact strings for the prompt. Never returns numbers that feed
//     sizing/weights — its output is consumed only as a labeled DATA section in the strategy prompt.

import { randomUUID } from "crypto";
import {
  audit,
  findLiveLearnedContextBySubject,
  getStrategyPrompt,
  insertLearnedContext,
  insertPendingLearnedContext,
  listLearnedContextForDecision,
  setStrategyPrompt,
  supersedeLearnedContext
} from "../db";
import { emitDashboardEvent } from "../events";
import { getLearnedContextSharing } from "../db-settings";
import type {
  LearnedContextAccountEnvironment,
  LearnedContextCandidate,
  LearnedContextLearningScope,
  LearnedContextOrigin,
  LearnedContextPendingRow,
  LearnedContextRow,
  LearnedContextTransferState
} from "../types";
import { hasPii } from "./classify";
import {
  buildStrategyDirectiveBlock,
  containDirectiveValue,
  directiveProvenanceLabel
} from "./directive-block";
import type { PromptContainmentResult } from "../prompt-safety";
import { classifyWithSemanticGate, type SemanticGateOptions } from "./semantic-gate";
import { captureUserWriteEpoch, runWithUserWriteEpoch, type UserWriteEpoch } from "../user-write-fence";

export interface IngestLearnedResult {
  written: LearnedContextRow | null;
  /** 'pii' | 'risk_dropped' | 'chat_risk_dropped' when nothing was written and nothing was queued. */
  dropped: "pii" | "risk_dropped" | "chat_risk_dropped" | null;
  /** Set when a risk-tier autonomous/ingest candidate was routed to the confirmation queue. */
  pending: LearnedContextPendingRow | null;
  /** Convenience id of the queued pending row (mirrors `pending?.id`). */
  pendingId: string | null;
  tier: LearnedContextRow["riskTier"];
}

export interface IngestLearnedOptions extends SemanticGateOptions {
  /** Exact broker account that produced the evidence. Account-derived writes are always private. */
  connectedAccountId?: string;
  accountEnvironment?: LearnedContextAccountEnvironment;
  /** Internal override used by the transfer validator when it emits corroborated research. */
  learningScope?: Exclude<LearnedContextLearningScope, "legacy">;
  transferState?: LearnedContextTransferState;
  /** Captured before any async classifier/provider work; stale operations cannot write after deletion. */
  writeEpoch?: UserWriteEpoch;
}

/**
 * Classify + gate a single candidate. Routing:
 *   - PII                                  → drop+audit (never written/queued, any tier).
 *   - tier 'fact'                          → written as a private learned_context row.
 *   - tier 'risk'/'strategy-directive':
 *       · origin 'chat'                    → HARD-CAP: drop+audit, NEVER queued (chat can never create a
 *                                            pending risk item).
 *       · origin 'autonomous'/'ingest'     → INSERT a learned_context_pending row (status 'pending') for
 *                                            human confirmation; audit 'learned_context.pending'. Approval
 *                                            applies it SAFELY and NEVER auto-mutates numeric policy.
 *
 * ASYNC: classification now runs the two-layer gate (sync keyword classifier + templated-fact allowlist
 * + LLM semantic gate; see semantic-gate.ts). The gate is STRICTLY ADDITIVE — it can only UPGRADE a
 * keyword 'fact' → 'risk' and falls back to the keyword result on any LLM failure — so every routing
 * branch below (incl. the chat hard-cap) keeps its exact semantics. `opts.llm` is injectable for tests.
 *
 * PROVENANCE (2026-09-27): a candidate carrying `provenance: "system-postmortem"` skips the gate's LLM
 * layer inside semantic-gate.ts, so a lesson the app derived from its OWN closed trades is written to
 * the brain instead of queued for a human nobody is going to click. The keyword layer is untouched and
 * still routes risk-knob lessons to the confirmation queue below, and the PII gate above still runs
 * first. Because the write branch is where such a row lands, the bypass is recorded in the
 * `learned_context.write` audit payload (see below) so it is verifiable after the fact.
 */
export async function ingestLearned(
  userId: string,
  candidate: LearnedContextCandidate,
  origin: LearnedContextOrigin,
  opts: IngestLearnedOptions = {}
): Promise<IngestLearnedResult> {
  const writeEpoch = opts.writeEpoch ?? captureUserWriteEpoch(userId);
  // PII gate first — an SSN/card number is never written regardless of tier.
  if (hasPii(candidate.value)) {
    return runWithUserWriteEpoch(userId, writeEpoch, () => {
      audit("learned_context.drop", { userId, origin, reason: "pii", subject: candidate.subject }, userId);
      return { written: null, dropped: "pii", pending: null, pendingId: null, tier: "fact" };
    });
  }

  // Thread userId so the gate's LLM call uses this user's key + failover and is usage-attributed.
  const {
    connectedAccountId,
    accountEnvironment,
    learningScope: requestedLearningScope,
    transferState: requestedTransferState,
    writeEpoch: _ignoredWriteEpoch,
    ...semanticGateOptions
  } = opts;
  void _ignoredWriteEpoch;
  const learningScope: Exclude<LearnedContextLearningScope, "legacy"> =
    requestedLearningScope ?? (connectedAccountId ? "account" : "portfolio");
  if (learningScope === "account" && !connectedAccountId) {
    throw new Error("Account-scoped learned context requires connectedAccountId");
  }
  if (learningScope !== "account" && connectedAccountId) {
    throw new Error(`${learningScope}-scoped learned context cannot carry connectedAccountId`);
  }
  const transferState: LearnedContextTransferState = requestedTransferState ?? "not_applicable";
  if (learningScope === "research" && transferState !== "validated" && transferState !== "rejected") {
    throw new Error("Research learned context must have an explicit validated or rejected transfer state");
  }

  const tier = await classifyWithSemanticGate(candidate, { ...semanticGateOptions, userId });

  return runWithUserWriteEpoch(userId, writeEpoch, () => {
    if (tier !== "fact") {
    // CHAT origin is HARD-CAPPED at 'fact' — a chat message can NEVER produce a pending risk item.
    // Preserve the audit-drop seam exactly for chat.
    if (origin === "chat") {
      audit(
        "learned_context.drop",
        { userId, origin, reason: "chat_risk_dropped", tier, subject: candidate.subject, value: candidate.value },
        userId
      );
      return { written: null, dropped: "chat_risk_dropped", pending: null, pendingId: null, tier };
    }

    // Autonomous / ingest risk-tier candidates route to the human confirmation queue instead of
    // being dropped. The queued row is NOT in the brain; it only ever applies via explicit approval.
    const pending: LearnedContextPendingRow = {
      id: randomUUID(),
      userId,
      scope: "private",
      kind: candidate.kind,
      subject: candidate.subject,
      symbol: candidate.symbol ? candidate.symbol.toUpperCase() : null,
      value: candidate.value,
      source: candidate.source ?? "inferred",
      origin,
      riskTier: tier,
      connectedAccountId: connectedAccountId ?? null,
      accountEnvironment: accountEnvironment ?? null,
      learningScope,
      transferState,
      classifierReason: `classified '${tier}' (fail-closed); queued for human confirmation`,
      createdAt: new Date().toISOString(),
      status: "pending",
      resolvedAt: null
    };
    insertPendingLearnedContext(pending);
    audit(
      "learned_context.pending",
      { userId, origin, tier, pendingId: pending.id, subject: candidate.subject, value: candidate.value },
      userId
    );
    // Push a lightweight SSE event so the dashboard badge refreshes immediately
    // instead of waiting for the next poll cycle.
    emitDashboardEvent({ type: "pending-learned-change", userId, at: new Date().toISOString(), detail: { pendingId: pending.id } });
    return { written: null, dropped: null, pending, pendingId: pending.id, tier };
    }

  const symbol = candidate.symbol ? candidate.symbol.toUpperCase() : null;
  const nowIso = new Date().toISOString();

  // Reconcile-on-write: if a live fact for this (kind, subject, symbol) exists with a different
  // value, supersede it; if identical, no-op (don't accumulate duplicates).
  const existing = findLiveLearnedContextBySubject(
    userId,
    candidate.kind,
    candidate.subject,
    symbol,
    connectedAccountId ?? null,
    learningScope
  );
  if (existing && existing.value === candidate.value) {
    return { written: existing, dropped: null, pending: null, pendingId: null, tier };
  }

  // Determine scope: if the user has opted-in to contributing their facts to the shared pool,
  // write this row as scope='shared' (with provenance via contributorUserId). Otherwise private.
  // SAFETY: only fact-tier rows ever reach this code path — risk/strategy-directive rows are
  // routed to the pending queue above and NEVER land here.
  const { contributeShared } = getLearnedContextSharing(userId);
  const scope = learningScope === "account" || learningScope === "research"
    ? "private"
    : contributeShared ? "shared" : "private";

  const row: LearnedContextRow = {
    id: randomUUID(),
    userId,
    scope,
    kind: candidate.kind,
    subject: candidate.subject,
    symbol,
    value: candidate.value,
    source: candidate.source ?? "inferred",
    origin,
    riskTier: "fact",
    confidence: candidate.confidence ?? 0.5,
    contributorUserId: userId,
    connectedAccountId: connectedAccountId ?? null,
    accountEnvironment: accountEnvironment ?? null,
    learningScope,
    transferState,
    assertedAt: nowIso,
    supersededBy: null,
    expiresAt: null
  };
  insertLearnedContext(row);
  if (existing) supersedeLearnedContext(existing.id, row.id);
  audit(
    "learned_context.write",
    {
      userId,
      origin,
      kind: row.kind,
      subject: row.subject,
      symbol: row.symbol,
      connectedAccountId: row.connectedAccountId,
      learningScope: row.learningScope,
      transferState: row.transferState,
      // Explicit producer provenance, when the producer set one. This is the audit trail for the
      // semantic gate's provenance bypass (semantic-gate.ts step 1b): a row that reached the brain
      // BECAUSE its LLM upgrade was skipped is distinguishable from one that passed the gate as a
      // fact, without needing a schema change on learned_context.
      ...(candidate.provenance ? { provenance: candidate.provenance } : {}),
      op: existing ? "supersede" : "append"
    },
    userId
  );
    return { written: row, dropped: null, pending: null, pendingId: null, tier };
  });
}

/**
 * READ-ONLY retrieval of advisory fact rows for a decision. Returns the live private fact rows
 * plus, when the user's includeShared preference is on (default true), all scope='shared' rows
 * from any contributor, formatted as advisory bullet strings for the strategy prompt's
 * `learnedContext` DATA section.
 *
 * ISOLATION GUARANTEE: a different user's PRIVATE (scope='private') row is NEVER returned to
 * this user — the listLearnedContextForDecision query only widens to scope='shared' rows, never
 * to another user's private rows.
 *
 * Regime-conditioned re-ranking (owner directive, 2026-07-23): when `regime` is supplied, rows
 * matching the current market regime get a +2 scoring boost and off-regime rows get a -1 penalty,
 * with regime labels appended for the model. Thesis tags in `thesisTags` get a +1 bonus.
 */
export function retrieveLearnedContext(
  userId: string,
  symbols: string[],
  regime?: string,
  options: { includeShared?: boolean; limit?: number; perContributorCap?: number; connectedAccountId?: string; thesisTags?: Set<string> } = {}
): string[] {
  return retrieveLearnedContextDetailed(userId, symbols, regime, options).lines;
}

/** The formatted advisory lines plus the underlying selected rows (for age receipts etc.). */
export interface RetrievedLearnedContext {
  lines: string[];
  rows: LearnedContextRow[];
}

/**
 * Same selection as retrieveLearnedContext (identical per-contributor cap + shared/private
 * isolation — retrieveLearnedContext delegates here), but also returns the selected ROWS so
 * callers can read real provenance (assertedAt for evidence-age receipts) without re-querying.
 *
 * Regime-conditioned re-ranking: rows matching the current market regime get a +2 scoring boost;
 * off-regime rows get -1. Thesis tags in `thesisTags` get a +1 bonus. Off-regime rows are
 * labeled so the model can discount them. Sorting is score desc, then recency as tiebreaker.
 */
export function retrieveLearnedContextDetailed(
  userId: string,
  symbols: string[],
  regime?: string,
  options: { includeShared?: boolean; limit?: number; perContributorCap?: number; connectedAccountId?: string; thesisTags?: Set<string> } = {}
): RetrievedLearnedContext {
  const limit = options.limit ?? 12;
  const perContributorCap = options.perContributorCap ?? 6;
  // When options.includeShared is explicitly supplied (e.g. from tests), use it; otherwise
  // read the user's persistent preference (default: includeShared=true).
  const includeShared = options.includeShared !== undefined
    ? options.includeShared
    : getLearnedContextSharing(userId).includeShared;
  const rows = listLearnedContextForDecision(userId, symbols, includeShared, options.connectedAccountId);

  // Regime-conditioned scoring
  const conditioningScore = (row: LearnedContextRow, currentRegime?: string, thesisTags?: Set<string>): number => {
    let score = 0;
    if (currentRegime && row.regime) {
      score += row.regime === currentRegime ? 2 : -1;
    }
    if (row.thesisTag && thesisTags?.has(row.thesisTag)) {
      score += 1;
    }
    return score;
  };

  // Sort by score descending, recency as tiebreaker within same score
  const sorted = [...rows].sort((a, b) => {
    const scoreA = conditioningScore(a, regime, options.thesisTags);
    const scoreB = conditioningScore(b, regime, options.thesisTags);
    if (scoreB !== scoreA) return scoreB - scoreA;
    return b.assertedAt.localeCompare(a.assertedAt);
  });

  // Per-contributor cap so one prolific source can't crowd out the rest (matters once shared rows
  // are enabled; harmless for the private-only slice).
  const perContributor = new Map<string, number>();
  const selected: LearnedContextRow[] = [];
  for (const row of sorted) {
    const key = row.contributorUserId ?? row.userId;
    const used = perContributor.get(key) ?? 0;
    if (used >= perContributorCap) continue;
    perContributor.set(key, used + 1);
    selected.push(row);
    if (selected.length >= limit) break;
  }

  return { lines: selected.map((row) => formatLearnedContextLine(row, regime)), rows: selected };
}

/**
 * One advisory bullet per fact, now carrying compact INLINE PROVENANCE (CR-H prompt-safety lane,
 * 2026-07-05): `- [SYM] subject: value [origin=chat source=owner-chat asserted=2026-07-01 conf=0.8]`.
 * The model can weigh a fresh, low-confidence chat-origin assertion differently from an old,
 * high-confidence ingested fact — previously all four fields were dropped here. Only fields that
 * actually exist are emitted; lines stay single-line and compact.
 *
 * Off-regime labeling (2026-07-23): when the row's regime differs from the current regime,
 * appends ` [learned in ${row.regime} regime]` so the model can discount it.
 */
function formatLearnedContextLine(row: LearnedContextRow, currentRegime?: string): string {
  const sym = row.symbol ? `[${row.symbol}] ` : "";
  const prov: string[] = [];
  if (row.origin) prov.push(`origin=${row.origin}`);
  if (row.source) prov.push(`source=${row.source}`);
  const day = typeof row.assertedAt === "string" ? row.assertedAt.slice(0, 10) : "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(day)) prov.push(`asserted=${day}`);
  if (typeof row.confidence === "number" && Number.isFinite(row.confidence)) {
    prov.push(`conf=${Number(row.confidence.toFixed(2))}`);
  }
  prov.push(`scope=${row.learningScope}`);
  if (row.accountEnvironment) prov.push(`environment=${row.accountEnvironment}`);
  if (row.transferState !== "not_applicable") prov.push(`transfer=${row.transferState}`);
  if (row.regime) prov.push(`regime=${row.regime}`);
  let line = `- ${sym}${row.subject}: ${row.value}${prov.length > 0 ? ` [${prov.join(" ")}]` : ""}`;
  if (currentRegime && row.regime && row.regime !== currentRegime) {
    line += ` [learned in ${row.regime} regime]`;
  }
  return line;
}

// ── Pending-queue APPROVAL (safety-critical) ────────────────────────────────────
// THE LINE WE DO NOT CROSS: an approval NEVER auto-derives or auto-writes a numeric policy change.
// setPolicy / validatePolicy stay reachable ONLY via the explicit human PUT /api/policy. Nothing in
// this section imports or calls setPolicy. Any real numeric risk-limit change remains a separate
// manual action the human takes in Risk settings.

// The prompt TRUST BOUNDARY for directive blocks lives in ./directive-block (a pure leaf shared
// with the console preview, so what the owner is shown is byte-identical to what actually lands).
export { isOwnerAuthoredLearnedSource } from "./directive-block";

/**
 * APPEND an attributed AI-LEARNED block to the strategy prompt, idempotent by id. If a block with the
 * same id already exists it is REPLACED in place (re-approve never duplicates); otherwise the new block
 * is appended after a blank-line separator. This is approved guidance TEXT — it does NOT touch numeric
 * policy limits. Exported for direct unit testing of the merge invariant.
 */
/**
 * TRUST BOUNDARY AT THE SINK.  This is the only function that writes a learned directive into the
 * always-trusted strategy prompt, so containment and provenance happen HERE rather than in the
 * caller.  An earlier shape took a pre-formatted `provenance` string and trusted the caller to have
 * run `containDirectiveValue` first — which is the same "one caller must remember two helpers in
 * the right order" hazard this cluster exists to remove.  `source` is required; owner-authored text
 * is still passed through byte-for-byte (see `containDirectiveValue`).  The containment result is
 * returned so the caller can audit it, never so the caller can decide whether to apply it.
 */
export function mergeStrategyDirectiveBlock(
  currentPrompt: string,
  id: string,
  rawValue: string,
  dateIso: string,
  source: string | null | undefined,
  origin?: string | null
): { prompt: string; contained: PromptContainmentResult | null } {
  const { value, contained } = containDirectiveValue(rawValue, source);
  const block = buildStrategyDirectiveBlock(id, value, dateIso, directiveProvenanceLabel(source, origin));
  // Match an existing block for THIS id (any prior date) so re-approval replaces, not duplicates.
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const existingBlock = new RegExp(`<!-- AI-LEARNED ${escapedId} [^>]*-->[\\s\\S]*?<!-- /AI-LEARNED -->`);
  if (existingBlock.test(currentPrompt)) {
    return { prompt: currentPrompt.replace(existingBlock, block), contained };
  }
  return { prompt: `${currentPrompt}\n\n${block}`, contained };
}

/**
 * Apply an APPROVED pending row per its tier. Safety-critical — see the header above.
 *   - 'strategy-directive' → APPEND an attributed, idempotent AI-LEARNED block to the strategy prompt
 *     via setStrategyPrompt (append-not-replace; re-approve replaces just that id's block). The block
 *     always carries a provenance line, and its value is containment-scanned UNLESS the owner typed
 *     it themselves (isOwnerAuthoredLearnedSource) — owner text is never altered.
 *   - 'risk'               → PROMOTE to an advisory learned_context row via insertLearnedContext
 *     (scope 'private', riskTier 'risk', origin preserved). It becomes soft DATA the LLM reads; the
 *     human approval IS the gate. NEVER calls setPolicy.
 * The caller is responsible for the status transition + 'learned_context.approve' audit so ownership
 * is enforced once at the route layer.
 */
export function applyApprovedPending(pending: LearnedContextPendingRow, assertedAt: string = new Date().toISOString()): void {
  if (pending.riskTier === "strategy-directive") {
    // Read AND write the prompt of the account this directive was queued against — the same
    // pending.connectedAccountId the risk-tier branch below persists. Omitting it made both calls
    // resolve to whichever account was active in the console at approval time, so the daily
    // learning review (a RUN, src/lib/learning-review.ts) could append account A's approved
    // directive onto account B's strategy prompt. A null id is a genuinely user-level directive
    // and keeps the existing active-account behavior.
    const accountId = pending.connectedAccountId ?? undefined;
    const current = getStrategyPrompt(pending.userId, accountId);
    // TRUST BOUNDARY: the owner's own words go in untouched. Anything else is scanned first, so a
    // hijack idiom carried in from a fetched page or an LLM paraphrase becomes an explicit
    // quarantine marker instead of a line the model reads as owner intent.  The scan itself lives
    // inside mergeStrategyDirectiveBlock so no caller can skip it; this call site only audits.
    const { prompt: merged, contained } = mergeStrategyDirectiveBlock(
      current,
      pending.id,
      pending.value,
      assertedAt,
      pending.source,
      pending.origin
    );
    if (contained && contained.status !== "clean") {
      audit(
        "learned_context.directive_contained",
        {
          userId: pending.userId,
          pendingId: pending.id,
          source: pending.source,
          origin: pending.origin,
          status: contained.status,
          patterns: contained.findings.map((finding) => finding.pattern),
          quarantined: contained.quarantinedExcerpts.map((excerpt) => excerpt.excerpt)
        },
        pending.userId,
        accountId
      );
    }
    setStrategyPrompt(merged, pending.userId, accountId);
    return;
  }

  // tier 'risk' → advisory promote. Lives in the learned_context store as soft DATA only.
  // assertedAt is caller-controllable: the daily learning review passes its run-start timestamp
  // (the same value it persists as lastReviewedAt) so a row it JUST approved is stamped at ==
  // lastReviewedAt and excluded by evaluateLearningReviewTrigger's strict `> lastReviewedAt` — it
  // is not miscounted as a brand-new lesson the next day and does not re-trigger a review of
  // content it just reviewed. The human approve route omits the arg and gets the real approval
  // time (a human-approved lesson has NOT been through the review board, so it SHOULD trigger one).
  const row: LearnedContextRow = {
    id: randomUUID(),
    userId: pending.userId,
    scope: "private",
    kind: pending.kind,
    subject: pending.subject,
    symbol: pending.symbol ? pending.symbol.toUpperCase() : null,
    value: pending.value,
    source: pending.source,
    origin: pending.origin,
    riskTier: "risk",
    confidence: 0.5,
    contributorUserId: pending.userId,
    connectedAccountId: pending.connectedAccountId,
    accountEnvironment: pending.accountEnvironment,
    learningScope: pending.learningScope,
    transferState: pending.transferState,
    assertedAt,
    supersededBy: null,
    expiresAt: null
  };
  insertLearnedContext(row);
}
