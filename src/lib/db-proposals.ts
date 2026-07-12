// db-proposals.ts — trade proposal CRUD
import { getDb } from "./db";
import { scopeAccount } from "./db-execution";
import type {
  ExecutionMode,
  PendingProposal,
  PolicyDecision,
  RecentProposal,
  ReviewedOrder,
  TradeProposal
} from "./types";

export function listPendingProposals(accountNumber: string, userId: string = "local"): PendingProposal[] {
  type RawRow = {
    id: string;
    created_at: string;
    proposal: string;
    decision: string;
    review: string | null;
    estimated_notional: number | null;
    last_revalidated_at: string | null;
    revalidation_note: string | null;
    account_number: string;
    execution_mode: string | null;
  };
  const rows = getDb()
    .prepare(
      "SELECT id, created_at, proposal, decision, review, estimated_notional, last_revalidated_at, revalidation_note, account_number, execution_mode FROM trade_proposals WHERE account_number = ? AND user_id = ? AND status = 'proposed' ORDER BY created_at DESC"
    )
    .all(scopeAccount(accountNumber), userId) as RawRow[];

  return rows.map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    proposal: JSON.parse(r.proposal) as TradeProposal,
    decision: JSON.parse(r.decision) as PolicyDecision,
    review: r.review ? (JSON.parse(r.review) as ReviewedOrder) : undefined,
    estimatedNotional: r.estimated_notional ?? undefined,
    lastRevalidatedAt: r.last_revalidated_at ?? undefined,
    revalidationNote: r.revalidation_note ?? undefined,
    accountNumber: r.account_number,
    executionMode: r.execution_mode ? (r.execution_mode as ExecutionMode) : undefined
  }));
}

export function listRecentProposals(accountNumber: string, limit: number = 100, userId: string = "local"): RecentProposal[] {
  type RawRow = {
    id: string;
    run_id: string;
    account_number: string;
    created_at: string;
    proposal: string;
    decision: string;
    review: string | null;
    estimated_notional: number | null;
    status: string;
    execution_mode: string | null;
    error_message: string | null;
  };
  const cappedLimit = Math.max(1, Math.min(200, Math.floor(limit)));
  const rows = getDb()
    .prepare(
      "SELECT id, run_id, account_number, created_at, proposal, decision, review, estimated_notional, status, execution_mode, error_message FROM trade_proposals WHERE account_number = ? AND user_id = ? ORDER BY created_at DESC LIMIT ?"
    )
    .all(scopeAccount(accountNumber), userId, cappedLimit) as RawRow[];

  return rows.map((r) => ({
    id: r.id,
    runId: r.run_id,
    accountNumber: r.account_number,
    createdAt: r.created_at,
    proposal: JSON.parse(r.proposal) as TradeProposal,
    decision: JSON.parse(r.decision) as PolicyDecision,
    review: r.review ? (JSON.parse(r.review) as ReviewedOrder) : undefined,
    estimatedNotional: r.estimated_notional ?? undefined,
    status: r.status,
    executionMode: r.execution_mode ? (r.execution_mode as ExecutionMode) : undefined,
    errorMessage: r.error_message ?? undefined
  }));
}

/**
 * Stamp a still-pending proposal as re-validated by a strategy run's LLM "does this still
 * stand?" pass. Only touches the staleness columns — status stays "proposed".
 */
export function markProposalRevalidated(
  id: string,
  input: { at: string; note?: string },
  userId: string = "local"
): void {
  getDb()
    .prepare(
      "UPDATE trade_proposals SET last_revalidated_at = ?, revalidation_note = COALESCE(?, revalidation_note) WHERE id = ? AND user_id = ? AND status = 'proposed'"
    )
    .run(input.at, input.note ?? null, id, userId);
}

export function getProposal(id: string, userId: string = "local"):
  | {
      id: string;
      runId: string;
      accountNumber: string;
      createdAt: string;
      proposal: TradeProposal;
      decision: PolicyDecision;
      review?: ReviewedOrder;
      estimatedNotional?: number;
      status: string;
      tradeThesisTag?: string;
      entryMarketRegime?: string;
      executionMode?: ExecutionMode;
    }
  | undefined {
  type RawRow = {
    id: string;
    run_id: string;
    account_number: string;
    created_at: string;
    proposal: string;
    decision: string;
    review: string | null;
    estimated_notional: number | null;
    status: string;
    trade_thesis_tag: string | null;
    entry_market_regime: string | null;
    execution_mode: string | null;
  };
  const row = getDb()
    .prepare("SELECT id, run_id, account_number, created_at, proposal, decision, review, estimated_notional, status, trade_thesis_tag, entry_market_regime, execution_mode FROM trade_proposals WHERE id = ? AND user_id = ?")
    .get(id, userId) as RawRow | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    runId: row.run_id,
    accountNumber: row.account_number,
    createdAt: row.created_at,
    proposal: JSON.parse(row.proposal) as TradeProposal,
    decision: JSON.parse(row.decision) as PolicyDecision,
    review: row.review ? (JSON.parse(row.review) as ReviewedOrder) : undefined,
    estimatedNotional: row.estimated_notional ?? undefined,
    status: row.status,
    tradeThesisTag: row.trade_thesis_tag ?? undefined,
    entryMarketRegime: row.entry_market_regime ?? undefined,
    executionMode: row.execution_mode ? (row.execution_mode as ExecutionMode) : undefined
  };
}

type ProposalRow = NonNullable<ReturnType<typeof getProposal>>;

/**
 * Batch variant of `getProposal`: resolve many proposal ids for a user in a SINGLE
 * `WHERE id IN (...)` query, returning a Map keyed by id. Replaces the per-row point queries the
 * dashboard feed builders otherwise issue (one prepared-statement round trip per audit row + fill).
 * Ids not found (or belonging to another user) are simply absent from the Map — identical to
 * `getProposal` returning undefined per-id. Row parsing mirrors `getProposal` exactly.
 */
export function getProposalsByIds(ids: string[], userId: string = "local"): Map<string, ProposalRow> {
  const result = new Map<string, ProposalRow>();
  const distinct = Array.from(new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0)));
  if (distinct.length === 0) return result;
  type RawRow = {
    id: string;
    run_id: string;
    account_number: string;
    created_at: string;
    proposal: string;
    decision: string;
    review: string | null;
    estimated_notional: number | null;
    status: string;
    trade_thesis_tag: string | null;
    entry_market_regime: string | null;
    execution_mode: string | null;
  };
  const placeholders = distinct.map(() => "?").join(", ");
  const rows = getDb()
    .prepare(
      `SELECT id, run_id, account_number, created_at, proposal, decision, review, estimated_notional, status, trade_thesis_tag, entry_market_regime, execution_mode FROM trade_proposals WHERE user_id = ? AND id IN (${placeholders})`
    )
    .all(userId, ...distinct) as RawRow[];
  for (const row of rows) {
    result.set(row.id, {
      id: row.id,
      runId: row.run_id,
      accountNumber: row.account_number,
      createdAt: row.created_at,
      proposal: JSON.parse(row.proposal) as TradeProposal,
      decision: JSON.parse(row.decision) as PolicyDecision,
      review: row.review ? (JSON.parse(row.review) as ReviewedOrder) : undefined,
      estimatedNotional: row.estimated_notional ?? undefined,
      status: row.status,
      tradeThesisTag: row.trade_thesis_tag ?? undefined,
      entryMarketRegime: row.entry_market_regime ?? undefined,
      executionMode: row.execution_mode ? (row.execution_mode as ExecutionMode) : undefined
    });
  }
  return result;
}

export function updateProposalStatus(
  id: string,
  status: string,
  orderId?: string,
  review?: ReviewedOrder,
  estimatedNotional?: number,
  userId: string = "local",
  refId?: string,
  errorMessage?: string,
  decision?: PolicyDecision
): void {
  getDb()
    .prepare(
      "UPDATE trade_proposals SET status = ?, order_id = COALESCE(?, order_id), review = COALESCE(?, review), estimated_notional = COALESCE(?, estimated_notional), ref_id = COALESCE(?, ref_id), error_message = COALESCE(?, error_message), decision = COALESCE(?, decision) WHERE id = ? AND user_id = ?"
    )
    .run(
      status,
      orderId ?? null,
      review ? JSON.stringify(review) : null,
      estimatedNotional ?? null,
      refId ?? null,
      errorMessage ?? null,
      decision ? JSON.stringify(decision) : null,
      id,
      userId
    );
}

/**
 * Atomic compare-and-swap claim of a still-pending proposal for execution.
 * Transitions status 'proposed' -> `toStatus` in a single synchronous UPDATE and
 * returns true ONLY for the caller that won the race. This is the guard that
 * prevents two concurrent approvals (double-click, two tabs, the from-draft flow,
 * or a scheduled run racing a manual approve) from both reaching placeEquityOrder
 * and doubling a real position. better-sqlite3 statements are synchronous and
 * atomic, so exactly one concurrent caller sees `changes === 1`.
 */
export function claimProposalForExecution(
  id: string,
  toStatus: string,
  userId: string = "local",
  opts: { review?: ReviewedOrder; estimatedNotional?: number; refId?: string; executionMode?: ExecutionMode } = {}
): boolean {
  const info = getDb()
    .prepare(
      "UPDATE trade_proposals SET status = ?, review = COALESCE(?, review), estimated_notional = COALESCE(?, estimated_notional), ref_id = COALESCE(?, ref_id), execution_mode = COALESCE(?, execution_mode) WHERE id = ? AND user_id = ? AND status = 'proposed'"
    )
    .run(
      toStatus,
      opts.review ? JSON.stringify(opts.review) : null,
      opts.estimatedNotional ?? null,
      opts.refId ?? null,
      opts.executionMode ?? null,
      id,
      userId
    );
  return info.changes === 1;
}

/**
 * Guarded status write for the approval gate's REFUSAL paths: applies only while the row is
 * still pending (atomic `status = 'proposed'` CAS, same shape as claimProposalForExecution)
 * and returns false when the row left the pending state while the approval was in flight —
 * expired by the scheduler or rejected in another tab. Without this guard the wash-sale
 * re-escalation path (toStatus 'proposed', fresh tokens in `decision`) could RESURRECT a
 * withdrawn card, and a refusal (toStatus 'blocked') could overwrite an owner's rejection.
 */
export function transitionProposalIfPending(
  id: string,
  toStatus: string,
  userId: string = "local",
  opts: { review?: ReviewedOrder; estimatedNotional?: number; decision?: PolicyDecision } = {}
): boolean {
  const info = getDb()
    .prepare(
      "UPDATE trade_proposals SET status = ?, review = COALESCE(?, review), estimated_notional = COALESCE(?, estimated_notional), decision = COALESCE(?, decision) WHERE id = ? AND user_id = ? AND status = 'proposed'"
    )
    .run(
      toStatus,
      opts.review ? JSON.stringify(opts.review) : null,
      opts.estimatedNotional ?? null,
      opts.decision ? JSON.stringify(opts.decision) : null,
      id,
      userId
    );
  return info.changes === 1;
}

/**
 * Crash-recovery support: "placing" rows older than the cutoff. A "placing" row is an
 * order-placement INTENT written just before the broker call; it normally flips to "placed"
 * (or "placing_failed") synchronously. One that lingers means a prior run died mid-placement,
 * so the order's true state is unknown and must be surfaced for reconciliation.
 */
export function listStalePlacingProposals(
  accountNumber: string,
  olderThanIso: string,
  userId: string = "local"
): Array<{ id: string; refId: string | null; proposal: unknown; createdAt: string; executionMode?: ExecutionMode }> {
  const rows = getDb()
    .prepare(
      "SELECT id, ref_id as refId, proposal, created_at as createdAt, execution_mode as executionMode FROM trade_proposals WHERE account_number = ? AND user_id = ? AND status = 'placing' AND created_at < ?"
    )
    .all(scopeAccount(accountNumber), userId, olderThanIso) as Array<{ id: string; refId: string | null; proposal: string; createdAt: string; executionMode: string | null }>;
  return rows.map((r) => ({
    id: r.id,
    refId: r.refId,
    proposal: JSON.parse(r.proposal),
    createdAt: r.createdAt,
    executionMode: r.executionMode ? (r.executionMode as ExecutionMode) : undefined
  }));
}

/** Idempotency for chat-drafted proposals: the id of an existing still-`proposed` row for a runId. */
export function findProposedIdByRunId(runId: string, userId: string = "local"): string | null {
  const row = getDb()
    .prepare("SELECT id FROM trade_proposals WHERE run_id = ? AND user_id = ? AND status = 'proposed' ORDER BY created_at DESC LIMIT 1")
    .get(runId, userId) as { id: string } | undefined;
  return row?.id ?? null;
}

/**
 * Guarantee a positive `referencePrice` entry-anchor on the stored proposal so the entry-drift guard,
 * counterfactual learning, and the "performance since proposal" readout always have something to
 * measure from. enrichOpeningProposal already sets it from the live market price on the main path;
 * this is a defensive fallback (limit → stop) for any path that didn't.
 */
function ensureReferencePrice(proposal: unknown): unknown {
  if (!proposal || typeof proposal !== "object") return proposal;
  const p = proposal as Record<string, unknown>;
  const ref = Number(p.referencePrice);
  if (Number.isFinite(ref) && ref > 0) return proposal;
  const fallback = Number(p.limitPrice) || Number(p.stopPrice);
  if (Number.isFinite(fallback) && fallback > 0) return { ...p, referencePrice: fallback };
  return proposal;
}

export function insertProposal(input: {
  userId?: string;
  id: string;
  runId: string;
  accountNumber: string;
  proposal: unknown;
  decision: unknown;
  review?: unknown;
  estimatedNotional?: number;
  refId?: string;
  orderId?: string;
  status: string;
  tradeThesisTag?: string;
  entryMarketRegime?: string;
  executionMode?: ExecutionMode;
  /** The versioned strategy prompt (STRATEGY_PROMPT_VERSION) that produced this proposal. */
  promptVersion?: string;
}): void {
  getDb()
    .prepare(
      "INSERT INTO trade_proposals (id, user_id, run_id, account_number, created_at, proposal, decision, review, estimated_notional, ref_id, order_id, status, trade_thesis_tag, entry_market_regime, execution_mode, prompt_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      input.id,
      input.userId ?? "local",
      input.runId,
      scopeAccount(input.accountNumber),
      new Date().toISOString(),
      JSON.stringify(ensureReferencePrice(input.proposal)),
      JSON.stringify(input.decision),
      input.review ? JSON.stringify(input.review) : null,
      input.estimatedNotional ?? null,
      input.refId ?? null,
      input.orderId ?? null,
      input.status,
      input.tradeThesisTag ?? null,
      input.entryMarketRegime ?? null,
      input.executionMode ?? null,
      input.promptVersion ?? null
    );
}
