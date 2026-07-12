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
  LearnedContextCandidate,
  LearnedContextOrigin,
  LearnedContextPendingRow,
  LearnedContextRow
} from "../types";
import { hasPii } from "./classify";
import { classifyWithSemanticGate, type SemanticGateOptions } from "./semantic-gate";

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
 */
export async function ingestLearned(
  userId: string,
  candidate: LearnedContextCandidate,
  origin: LearnedContextOrigin,
  opts: SemanticGateOptions = {}
): Promise<IngestLearnedResult> {
  // PII gate first — an SSN/card number is never written regardless of tier.
  if (hasPii(candidate.value)) {
    audit("learned_context.drop", { userId, origin, reason: "pii", subject: candidate.subject }, userId);
    return { written: null, dropped: "pii", pending: null, pendingId: null, tier: "fact" };
  }

  // Thread userId so the gate's LLM call uses this user's key + failover and is usage-attributed.
  const tier = await classifyWithSemanticGate(candidate, { ...opts, userId });

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
  const existing = findLiveLearnedContextBySubject(userId, candidate.kind, candidate.subject, symbol);
  if (existing && existing.value === candidate.value) {
    return { written: existing, dropped: null, pending: null, pendingId: null, tier };
  }

  // Determine scope: if the user has opted-in to contributing their facts to the shared pool,
  // write this row as scope='shared' (with provenance via contributorUserId). Otherwise private.
  // SAFETY: only fact-tier rows ever reach this code path — risk/strategy-directive rows are
  // routed to the pending queue above and NEVER land here.
  const { contributeShared } = getLearnedContextSharing(userId);
  const scope = contributeShared ? "shared" : "private";

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
    assertedAt: nowIso,
    supersededBy: null,
    expiresAt: null
  };
  insertLearnedContext(row);
  if (existing) supersedeLearnedContext(existing.id, row.id);
  audit(
    "learned_context.write",
    { userId, origin, kind: row.kind, subject: row.subject, symbol: row.symbol, op: existing ? "supersede" : "append" },
    userId
  );
  return { written: row, dropped: null, pending: null, pendingId: null, tier };
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
 * The `regime` argument is accepted for forward-compatibility (regime-conditioned facts) but is
 * not yet used as a filter in this slice.
 */
export function retrieveLearnedContext(
  userId: string,
  symbols: string[],
  _regime?: string,
  options: { includeShared?: boolean; limit?: number; perContributorCap?: number } = {}
): string[] {
  return retrieveLearnedContextDetailed(userId, symbols, _regime, options).lines;
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
 */
export function retrieveLearnedContextDetailed(
  userId: string,
  symbols: string[],
  _regime?: string,
  options: { includeShared?: boolean; limit?: number; perContributorCap?: number } = {}
): RetrievedLearnedContext {
  const limit = options.limit ?? 12;
  const perContributorCap = options.perContributorCap ?? 6;
  // When options.includeShared is explicitly supplied (e.g. from tests), use it; otherwise
  // read the user's persistent preference (default: includeShared=true).
  const includeShared = options.includeShared !== undefined
    ? options.includeShared
    : getLearnedContextSharing(userId).includeShared;
  const rows = listLearnedContextForDecision(userId, symbols, includeShared);

  // Per-contributor cap so one prolific source can't crowd out the rest (matters once shared rows
  // are enabled; harmless for the private-only slice).
  const perContributor = new Map<string, number>();
  const selected: LearnedContextRow[] = [];
  for (const row of rows.sort((a, b) => b.assertedAt.localeCompare(a.assertedAt))) {
    const key = row.contributorUserId ?? row.userId;
    const used = perContributor.get(key) ?? 0;
    if (used >= perContributorCap) continue;
    perContributor.set(key, used + 1);
    selected.push(row);
    if (selected.length >= limit) break;
  }

  return { lines: selected.map(formatLearnedContextLine), rows: selected };
}

/**
 * One advisory bullet per fact, now carrying compact INLINE PROVENANCE (CR-H prompt-safety lane,
 * 2026-07-05): `- [SYM] subject: value [origin=chat source=owner-chat asserted=2026-07-01 conf=0.8]`.
 * The model can weigh a fresh, low-confidence chat-origin assertion differently from an old,
 * high-confidence ingested fact — previously all four fields were dropped here. Only fields that
 * actually exist are emitted; lines stay single-line and compact.
 */
function formatLearnedContextLine(row: LearnedContextRow): string {
  const sym = row.symbol ? `[${row.symbol}] ` : "";
  const prov: string[] = [];
  if (row.origin) prov.push(`origin=${row.origin}`);
  if (row.source) prov.push(`source=${row.source}`);
  const day = typeof row.assertedAt === "string" ? row.assertedAt.slice(0, 10) : "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(day)) prov.push(`asserted=${day}`);
  if (typeof row.confidence === "number" && Number.isFinite(row.confidence)) {
    prov.push(`conf=${Number(row.confidence.toFixed(2))}`);
  }
  return `- ${sym}${row.subject}: ${row.value}${prov.length > 0 ? ` [${prov.join(" ")}]` : ""}`;
}

// ── Pending-queue APPROVAL (safety-critical) ────────────────────────────────────
// THE LINE WE DO NOT CROSS: an approval NEVER auto-derives or auto-writes a numeric policy change.
// setPolicy / validatePolicy stay reachable ONLY via the explicit human PUT /api/policy. Nothing in
// this section imports or calls setPolicy. Any real numeric risk-limit change remains a separate
// manual action the human takes in Risk settings.

/**
 * Build the delimited, attributed AI-LEARNED block for an approved strategy-directive. The block is
 * keyed by the pending row's id so re-approval is idempotent (replace-in-place, never duplicate).
 */
function buildLearnedBlock(id: string, value: string, dateIso: string): string {
  const day = dateIso.slice(0, 10); // YYYY-MM-DD
  return `<!-- AI-LEARNED ${id} ${day} -->\n${value}\n<!-- /AI-LEARNED -->`;
}

/**
 * APPEND an attributed AI-LEARNED block to the strategy prompt, idempotent by id. If a block with the
 * same id already exists it is REPLACED in place (re-approve never duplicates); otherwise the new block
 * is appended after a blank-line separator. This is approved guidance TEXT — it does NOT touch numeric
 * policy limits. Exported for direct unit testing of the merge invariant.
 */
export function mergeStrategyDirectiveBlock(currentPrompt: string, id: string, value: string, dateIso: string): string {
  const block = buildLearnedBlock(id, value, dateIso);
  // Match an existing block for THIS id (any prior date) so re-approval replaces, not duplicates.
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const existingBlock = new RegExp(`<!-- AI-LEARNED ${escapedId} [^>]*-->[\\s\\S]*?<!-- /AI-LEARNED -->`);
  if (existingBlock.test(currentPrompt)) {
    return currentPrompt.replace(existingBlock, block);
  }
  return `${currentPrompt}\n\n${block}`;
}

/**
 * Apply an APPROVED pending row per its tier. Safety-critical — see the header above.
 *   - 'strategy-directive' → APPEND an attributed, idempotent AI-LEARNED block to the strategy prompt
 *     via setStrategyPrompt (append-not-replace; re-approve replaces just that id's block).
 *   - 'risk'               → PROMOTE to an advisory learned_context row via insertLearnedContext
 *     (scope 'private', riskTier 'risk', origin preserved). It becomes soft DATA the LLM reads; the
 *     human approval IS the gate. NEVER calls setPolicy.
 * The caller is responsible for the status transition + 'learned_context.approve' audit so ownership
 * is enforced once at the route layer.
 */
export function applyApprovedPending(pending: LearnedContextPendingRow): void {
  if (pending.riskTier === "strategy-directive") {
    const current = getStrategyPrompt(pending.userId);
    const merged = mergeStrategyDirectiveBlock(current, pending.id, pending.value, new Date().toISOString());
    setStrategyPrompt(merged, pending.userId);
    return;
  }

  // tier 'risk' → advisory promote. Lives in the learned_context store as soft DATA only.
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
    assertedAt: new Date().toISOString(),
    supersededBy: null,
    expiresAt: null
  };
  insertLearnedContext(row);
}
