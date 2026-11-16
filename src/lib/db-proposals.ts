// db-proposals.ts — trade proposal CRUD
import "server-only";
import { audit, getDb } from "./db";
import { scopeAccount } from "./db-execution";
import { canonicalModelId } from "./model-identity";
import { normalizeSymbol } from "./money";
import type {
  DecisionStep,
  ExecutionMode,
  OrderSide,
  PendingProposal,
  PolicyDecision,
  RecentProposal,
  ReviewedOrder,
  SocraticDecisionCase,
  SocraticDecisionStatus,
  SocraticEvidenceItem,
  TradeProposal
} from "./types";

const DECISION_STEPS: ReadonlySet<string> = new Set<DecisionStep>([
  "proposed",
  "red_team_reject",
  "override_requested",
  "override_applied",
  "human_approved",
  "final"
]);

/**
 * Pure structural check of a scorecard decision chain: every step must be a known DecisionStep,
 * consecutive steps must change, and "override_applied" requires a PRECEDING "override_requested".
 * Persistence NEVER rejects a proposal over its chain — a malformed one logs an audit receipt
 * (auditMalformedDecisionChain below) and the proposal is stored as-is.
 */
export function validateDecisionChain(chain: unknown): { ok: boolean; problems: string[] } {
  if (chain === undefined) return { ok: true, problems: [] };
  if (!Array.isArray(chain)) return { ok: false, problems: ["not_an_array"] };
  const problems: string[] = [];
  let sawOverrideRequested = false;
  for (let i = 0; i < chain.length; i++) {
    const step = chain[i];
    if (typeof step !== "string" || !DECISION_STEPS.has(step)) {
      problems.push(`unknown_step:${String(step)}`);
      continue;
    }
    if (i > 0 && chain[i - 1] === step) problems.push(`repeated_step:${step}`);
    if (step === "override_requested") sawOverrideRequested = true;
    if (step === "override_applied" && !sawOverrideRequested) problems.push("override_applied_without_request");
  }
  return { ok: problems.length === 0, problems };
}

/** Receipt (never a block): a malformed decision chain reached persistence. Best-effort — an
 * audit failure must never fail the proposal write it accompanies. */
function auditMalformedDecisionChain(proposalId: string, proposal: unknown, userId: string): void {
  const chain = (proposal as { scorecard?: { decisionChain?: unknown } } | null | undefined)?.scorecard?.decisionChain;
  if (chain === undefined) return;
  const verdict = validateDecisionChain(chain);
  if (verdict.ok) return;
  try {
    audit("proposal_decision_chain_malformed", { proposalId, chain, problems: verdict.problems }, userId);
  } catch {
    // receipts never fail the write
  }
}

/**
 * Thesis-tag split-brain fallback (2026-07-10 audit fix): `trade_thesis_tag` / `entry_market_regime`
 * are dedicated columns, but historically insertProposal left them NULL while the same values were
 * already embedded on the `proposal` object. Every reader that surfaces these fields falls back to
 * extracting them off the (already-parsed) proposal payload so a NULL column doesn't hide data that
 * exists right next to it. `parsedProposal` is untyped on purpose -- callers pass either the raw
 * pre-JSON.stringify object (insertProposal) or the JSON.parse'd row (readers), neither of which is
 * safely assignable to `TradeProposal` at this point.
 */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function proposalTagFallbacks(parsedProposal: unknown): { tradeThesisTag?: string; entryMarketRegime?: string } {
  const record = parsedProposal as { tradeThesisTag?: unknown; entryMarketRegime?: unknown } | null | undefined;
  return {
    tradeThesisTag: nonEmptyString(record?.tradeThesisTag),
    entryMarketRegime: nonEmptyString(record?.entryMarketRegime)
  };
}

/** Extract+normalize the symbol off the (already-parsed) proposal object for the dedicated
 *  `symbol` column (see db.ts migration 72) — mirrors proposalTagFallbacks' derivation shape. */
function deriveProposalSymbol(parsedProposal: unknown): string | undefined {
  const record = parsedProposal as { symbol?: unknown } | null | undefined;
  const raw = nonEmptyString(record?.symbol);
  return raw ? normalizeSymbol(raw) : undefined;
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** Keep the case-file lifecycle as specific as the durable proposal ledger. Collapsing broker
 * rejection, unconfirmed placement, expiry, and human rejection into one generic state made the
 * console and the embedded memory tell materially different stories about what actually happened. */
function socraticStatusFromProposalStatus(status: string): SocraticDecisionStatus {
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

function proposalAction(proposal: TradeProposal, notional?: number): string {
  const size =
    typeof notional === "number" && Number.isFinite(notional) && notional > 0
      ? `$${Math.round(notional).toLocaleString("en-US")}`
      : proposal.dollarAmount
        ? `$${Math.round(proposal.dollarAmount).toLocaleString("en-US")}`
        : proposal.quantity
          ? `${proposal.quantity} sh`
          : "unsized";
  return `${proposal.side.toUpperCase()} ${proposal.symbol.toUpperCase()} ${size}`;
}

function lifecycleEvidence(input: {
  status: SocraticDecisionStatus;
  action: string;
  decision: PolicyDecision;
  errorMessage?: string;
  symbol: string;
}): SocraticEvidenceItem {
  const reasons = input.decision.reasons.filter(Boolean).join(" | ");
  const error = input.errorMessage?.trim();
  const suffix = error ? `: ${error}` : "";
  switch (input.status) {
    case "placed":
      return { kind: "policy", title: "Order placed", summary: `${input.action} was submitted and confirmed by the broker.`, symbol: input.symbol, tone: "positive", data: input.decision };
    case "filled":
      return { kind: "policy", title: "Order filled", summary: `${input.action} was filled by the broker.`, symbol: input.symbol, tone: "positive", data: input.decision };
    case "placing":
      return { kind: "policy", title: "Placement pending confirmation", summary: `${input.action} was submitted, but broker acceptance is not yet confirmed${suffix}.`, symbol: input.symbol, tone: "warning", data: input.decision };
    case "proposed":
      return { kind: "policy", title: "Awaiting approval", summary: `${input.action} has not been placed and is waiting for a human decision.`, symbol: input.symbol, tone: "warning", data: input.decision };
    case "blocked":
      return { kind: "policy", title: "Blocked before placement", summary: `Deterministic checks blocked ${input.action}${reasons ? `: ${reasons}` : suffix}.`, symbol: input.symbol, tone: "negative", data: input.decision };
    case "rejected":
      return { kind: "policy", title: "Rejected before placement", summary: `${input.action} was declined before any broker placement.`, symbol: input.symbol, tone: "negative", data: input.decision };
    case "rejected_by_broker":
      return { kind: "policy", title: "Rejected by broker", summary: `The broker declined ${input.action}${suffix}.`, symbol: input.symbol, tone: "negative", data: input.decision };
    case "not_placed":
      return { kind: "policy", title: "Order not placed", summary: `No broker order was confirmed for ${input.action}${suffix}.`, symbol: input.symbol, tone: "negative", data: input.decision };
    case "expired":
      return { kind: "policy", title: "Proposal expired", summary: `${input.action} aged out before placement.`, symbol: input.symbol, tone: "warning", data: input.decision };
    case "withdrawn":
      return { kind: "policy", title: "Proposal withdrawn", summary: `${input.action} was withdrawn by the strategy before placement.`, symbol: input.symbol, tone: "warning", data: input.decision };
    case "error":
      return { kind: "policy", title: "Placement failed", summary: `${input.action} was not confirmed as placed${suffix}.`, symbol: input.symbol, tone: "negative", data: input.decision };
    default:
      return { kind: "policy", title: "Decision recorded", summary: `${input.action} was recorded without a terminal placement outcome.`, symbol: input.symbol, tone: "neutral", data: input.decision };
  }
}

type SocraticLifecycleRow = {
  id: string;
  evidence: string;
  dissent: string;
  autonomy_override: string | null;
};

type ProposalLifecycleRow = {
  status: string;
  proposal: string;
  decision: string;
  review: string | null;
  estimated_notional: number | null;
  error_message: string | null;
};

/** Synchronize the already-created Socratic case inside the SAME SQLite transaction as each
 * proposal transition. This prevents a case from remaining "proposed" after a human approval,
 * broker decline, crash recovery, expiry, or withdrawal. It also refreshes execution-time sizing
 * and Red/policy receipts when the order JSON changed after generation. */
function syncSocraticDecisionLifecycle(
  database: ReturnType<typeof getDb>,
  proposalId: string,
  userId: string
): string | undefined {
  const existing = database
    .prepare("SELECT id, evidence, dissent, autonomy_override FROM socratic_decisions WHERE user_id = ? AND (id = ? OR proposal_id = ?) ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END LIMIT 1")
    .get(userId, proposalId, proposalId, proposalId) as SocraticLifecycleRow | undefined;
  if (!existing) return undefined;
  const row = database
    .prepare("SELECT status, proposal, decision, review, estimated_notional, error_message FROM trade_proposals WHERE id = ? AND user_id = ?")
    .get(proposalId, userId) as ProposalLifecycleRow | undefined;
  if (!row) return undefined;

  const proposal = parseJson<TradeProposal | undefined>(row.proposal, undefined);
  const decision = parseJson<PolicyDecision | undefined>(row.decision, undefined);
  if (!proposal || !decision) return undefined;
  const review = parseJson<ReviewedOrder | undefined>(row.review, undefined);
  const status = socraticStatusFromProposalStatus(row.status);
  const notional = row.estimated_notional ?? review?.estimatedNotional ?? proposal.dollarAmount;
  const action = proposalAction(proposal, notional);
  const priorEvidence = parseJson<SocraticEvidenceItem[]>(existing.evidence, []);
  const evidence = [
    lifecycleEvidence({
      status,
      action,
      decision,
      ...(row.error_message ? { errorMessage: row.error_message } : {}),
      symbol: proposal.symbol.toUpperCase()
    }),
    ...priorEvidence.filter((item) => item.kind !== "policy")
  ].slice(0, 8);

  const priorDissent = parseJson<SocraticEvidenceItem[]>(existing.dissent, []);
  const preservedDissent = priorDissent.filter((item) => item.kind !== "red_team" && item.kind !== "policy");
  const dissent: SocraticEvidenceItem[] = [];
  if (proposal.redTeamVerdict?.available) {
    const overridden =
      decision.socraticOverride?.applied === true || proposal.redTeamVerdict.humanOverrideApplied === true;
    dissent.push({
      kind: "red_team",
      title: proposal.redTeamVerdict.rejected
        ? overridden
          ? "Red Team rejection (overridden)"
          : "Red Team rejection"
        : "Red Team review",
      summary: proposal.redTeamVerdict.reason,
      source: proposal.redTeamVerdict.model,
      symbol: proposal.symbol.toUpperCase(),
      tone: proposal.redTeamVerdict.rejected && !overridden ? "negative" : "warning",
      data: proposal.redTeamVerdict
    });
  }
  if (!decision.approved) {
    for (const reason of decision.reasons.filter(Boolean).slice(0, 3)) {
      dissent.push({ kind: "policy", title: "Policy refusal", summary: reason, symbol: proposal.symbol.toUpperCase(), tone: "warning" });
    }
  }
  dissent.push(...preservedDissent);

  const priorOverride = parseJson<SocraticDecisionCase["autonomyOverride"] | undefined>(existing.autonomy_override, undefined);
  const autonomyOverride = proposal.autonomyOverride || priorOverride
    ? {
        ...(priorOverride ?? {}),
        ...(proposal.autonomyOverride ?? {}),
        applied: decision.socraticOverride?.applied === true,
        conflicts: decision.socraticOverride?.conflicts ?? priorOverride?.conflicts ?? proposal.autonomyOverride?.preferenceConflicts ?? []
      }
    : undefined;

  const info = database
    .prepare(
      `UPDATE socratic_decisions SET
         status = ?, rationale = ?, green_team_rationale = COALESCE(?, green_team_rationale),
         sizing_snapshot = COALESCE(?, sizing_snapshot), action = ?, notional = COALESCE(?, notional),
         red_team = COALESCE(?, red_team), policy_decision = ?, evidence = ?, dissent = ?,
         autonomy_override = COALESCE(?, autonomy_override), updated_at = ?
       WHERE id = ? AND user_id = ?`
    )
    .run(
      status,
      proposal.rationale,
      proposal.greenTeamRationale ?? null,
      proposal.sizingSnapshot ? JSON.stringify(proposal.sizingSnapshot) : null,
      action,
      notional ?? null,
      proposal.redTeamVerdict ? JSON.stringify(proposal.redTeamVerdict) : null,
      JSON.stringify(decision),
      JSON.stringify(evidence),
      JSON.stringify(dissent.slice(0, 6)),
      autonomyOverride ? JSON.stringify(autonomyOverride) : null,
      new Date().toISOString(),
      existing.id,
      userId
    );
  return info.changes === 1 ? existing.id : undefined;
}

function reindexSocraticDecisionAfterLifecycleSync(decisionId: string | undefined, userId: string): void {
  if (!decisionId) return;
  void import("./db-socratic")
    .then(async ({ getSocraticDecisionCase }) => {
      const decision = getSocraticDecisionCase(decisionId, userId);
      if (!decision) return;
      const { indexSocraticDecisionMemory } = await import("./socratic-memory");
      await indexSocraticDecisionMemory(decision);
    })
    .catch((error) => {
      console.warn("[db-proposals] Socratic lifecycle re-index failed:", error instanceof Error ? error.message : String(error));
    });
}

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

/** Cheap COUNT-only sibling to listPendingProposals — used for per-account pending-proposal
 *  chips (Settings > Broker connections' "Other Accounts" rows) where the caller only needs a
 *  number, not the full proposal/decision JSON blobs, for potentially several connected
 *  accounts on every dashboard snapshot. */
export function countPendingProposals(accountNumber: string, userId: string = "local"): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM trade_proposals WHERE account_number = ? AND user_id = ? AND status = 'proposed'")
    .get(scopeAccount(accountNumber), userId) as { n: number };
  return row.n;
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
  const parsedProposal = JSON.parse(row.proposal) as TradeProposal;
  const fallback = proposalTagFallbacks(parsedProposal);
  return {
    id: row.id,
    runId: row.run_id,
    accountNumber: row.account_number,
    createdAt: row.created_at,
    proposal: parsedProposal,
    decision: JSON.parse(row.decision) as PolicyDecision,
    review: row.review ? (JSON.parse(row.review) as ReviewedOrder) : undefined,
    estimatedNotional: row.estimated_notional ?? undefined,
    status: row.status,
    tradeThesisTag: row.trade_thesis_tag ?? fallback.tradeThesisTag ?? undefined,
    entryMarketRegime: row.entry_market_regime ?? fallback.entryMarketRegime ?? undefined,
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
    const parsedProposal = JSON.parse(row.proposal) as TradeProposal;
    const fallback = proposalTagFallbacks(parsedProposal);
    result.set(row.id, {
      id: row.id,
      runId: row.run_id,
      accountNumber: row.account_number,
      createdAt: row.created_at,
      proposal: parsedProposal,
      decision: JSON.parse(row.decision) as PolicyDecision,
      review: row.review ? (JSON.parse(row.review) as ReviewedOrder) : undefined,
      estimatedNotional: row.estimated_notional ?? undefined,
      status: row.status,
      tradeThesisTag: row.trade_thesis_tag ?? fallback.tradeThesisTag ?? undefined,
      entryMarketRegime: row.entry_market_regime ?? fallback.entryMarketRegime ?? undefined,
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
  const database = getDb();
  const syncedDecisionId = database.transaction(() => {
    const info = database
      .prepare(
        "UPDATE trade_proposals SET status = ?, order_id = COALESCE(?, order_id), review = COALESCE(?, review), estimated_notional = COALESCE(?, estimated_notional), ref_id = COALESCE(?, ref_id), error_message = COALESCE(?, error_message), decision = COALESCE(?, decision), placed_at = CASE WHEN ? IN ('placed', 'filled', 'paper', 'placing') THEN COALESCE(placed_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) ELSE placed_at END WHERE id = ? AND user_id = ?"
      )
      .run(
        status,
        orderId ?? null,
        review ? JSON.stringify(review) : null,
        estimatedNotional ?? null,
        refId ?? null,
        errorMessage ?? null,
        decision ? JSON.stringify(decision) : null,
        status,
        id,
        userId
      );
    return info.changes === 1 ? syncSocraticDecisionLifecycle(database, id, userId) : undefined;
  })();
  reindexSocraticDecisionAfterLifecycleSync(syncedDecisionId, userId);
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
  opts: {
    review?: ReviewedOrder;
    estimatedNotional?: number;
    refId?: string;
    executionMode?: ExecutionMode;
    proposal?: TradeProposal;
    decision?: PolicyDecision;
    /** Called inside the claim transaction only when the proposal has no durable Socratic case.
     * The callback must synchronously insert that case or the claim fails closed. */
    createSocraticDecisionCase?: () => void;
  } = {}
): boolean {
  // `proposal` lets the approval path persist EXECUTION-TIME sizing (a broker-minimum bump, an
  // approval-time protective-exit reprice) into the row before placement. Crash-recovery
  // (flagStalePlacingIntents) books fills from this stored JSON, so it must reflect the order
  // actually sent to the broker, not the original ask — and Recent/Activity hydrate from it too.
  const database = getDb();
  if (opts.proposal) auditMalformedDecisionChain(id, opts.proposal, userId);
  const rollbackLostFallbackClaim = new Error("proposal claim lost after fallback case creation");
  let result: { claimed: boolean; decisionId: string | undefined };
  try {
    result = database.transaction(() => {
      // BEGIN IMMEDIATE (invoked below) makes the proposal-state check, optional legacy-case repair,
      // and CAS one write-locked unit across processes. Never create a proposed case for a row that
      // already expired, was rejected, or was claimed elsewhere.
      const pendingProposal = database
        .prepare("SELECT id FROM trade_proposals WHERE id = ? AND user_id = ? AND status = 'proposed' LIMIT 1")
        .get(id, userId) as { id: string } | undefined;
      if (!pendingProposal) return { claimed: false, decisionId: undefined };
      const anyDecisionCase = database
        .prepare("SELECT id FROM socratic_decisions WHERE user_id = ? AND (id = ? OR proposal_id = ?) LIMIT 1")
        .get(userId, id, id) as { id: string } | undefined;
      let createdFallbackCase = false;
      if (!anyDecisionCase && opts.createSocraticDecisionCase) {
        opts.createSocraticDecisionCase();
        createdFallbackCase = true;
      }
      const decisionCase = database
        .prepare("SELECT id FROM socratic_decisions WHERE user_id = ? AND (id = ? OR proposal_id = ?) AND status = 'proposed' LIMIT 1")
        .get(userId, id, id) as { id: string } | undefined;
      if (!decisionCase) {
        if (createdFallbackCase) throw rollbackLostFallbackClaim;
        return { claimed: false, decisionId: undefined };
      }
      const info = database
        .prepare(
          "UPDATE trade_proposals SET status = ?, review = COALESCE(?, review), estimated_notional = COALESCE(?, estimated_notional), ref_id = COALESCE(?, ref_id), execution_mode = COALESCE(?, execution_mode), proposal = COALESCE(?, proposal), decision = COALESCE(?, decision), placed_at = CASE WHEN ? IN ('placed', 'filled', 'paper', 'placing') THEN COALESCE(placed_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) ELSE placed_at END WHERE id = ? AND user_id = ? AND status = 'proposed' AND EXISTS (SELECT 1 FROM socratic_decisions sd WHERE sd.user_id = trade_proposals.user_id AND (sd.id = trade_proposals.id OR sd.proposal_id = trade_proposals.id) AND sd.status = 'proposed')"
        )
        .run(
          toStatus,
          opts.review ? JSON.stringify(opts.review) : null,
          opts.estimatedNotional ?? null,
          opts.refId ?? null,
          opts.executionMode ?? null,
          opts.proposal ? JSON.stringify(opts.proposal) : null,
          opts.decision ? JSON.stringify(opts.decision) : null,
          toStatus,
          id,
          userId
        );
      if (info.changes !== 1 && createdFallbackCase) throw rollbackLostFallbackClaim;
      return {
        claimed: info.changes === 1,
        decisionId: info.changes === 1 ? syncSocraticDecisionLifecycle(database, id, userId) : undefined
      };
    }).immediate();
  } catch (error) {
    if (error === rollbackLostFallbackClaim) return false;
    throw error;
  }
  reindexSocraticDecisionAfterLifecycleSync(result.decisionId, userId);
  return result.claimed;
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
  const database = getDb();
  const result = database.transaction(() => {
    const info = database
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
    return {
      transitioned: info.changes === 1,
      decisionId: info.changes === 1 ? syncSocraticDecisionLifecycle(database, id, userId) : undefined
    };
  })();
  reindexSocraticDecisionAfterLifecycleSync(result.decisionId, userId);
  return result.transitioned;
}

/**
 * Persist an APPROVAL-TIME repriced order back onto a still-pending proposal row, so
 * Recent/Activity and getProposal show the order the broker actually received (or will receive on
 * re-approval) rather than the stale generation-time price the reprice replaced. Atomic CAS on
 * status='proposed' (same shape as claimProposalForExecution): a card that expired or was rejected
 * while the approval was in flight is never rewritten — the caller must treat `false` as
 * "no longer pending" and stop. `estimatedNotional` refreshes alongside the JSON so a live typed
 * confirmation re-check matches the repriced order, COALESCE-kept when the caller cannot estimate
 * (e.g. a degrade to a market order with no fresh limit price).
 */
export function updatePendingProposalReprice(
  id: string,
  input: {
    proposal: TradeProposal;
    estimatedNotional?: number;
    review?: ReviewedOrder;
    decision?: PolicyDecision;
  },
  userId: string = "local"
): boolean {
  const database = getDb();
  const result = database.transaction(() => {
    const info = database
      .prepare(
        "UPDATE trade_proposals SET proposal = ?, estimated_notional = COALESCE(?, estimated_notional), review = COALESCE(?, review), decision = COALESCE(?, decision) WHERE id = ? AND user_id = ? AND status = 'proposed'"
      )
      .run(
        JSON.stringify(input.proposal),
        input.estimatedNotional ?? null,
        input.review ? JSON.stringify(input.review) : null,
        input.decision ? JSON.stringify(input.decision) : null,
        id,
        userId
      );
    return {
      updated: info.changes === 1,
      decisionId: info.changes === 1 ? syncSocraticDecisionLifecycle(database, id, userId) : undefined
    };
  })();
  reindexSocraticDecisionAfterLifecycleSync(result.decisionId, userId);
  return result.updated;
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

/** Aggregate health of the adversarial-review lane (#2552): of the proposals in the window that
 *  CARRY a redTeamVerdict, how many recorded a failed review (`available: false`)? 4-of-5 failed
 *  reviews in one batch is a model/config problem nobody sees per-card — this is the ownable
 *  aggregate. User-wide on purpose: critic failures are an infrastructure/model condition, not an
 *  account condition. Proposals with NO verdict (review never triggered) are excluded from the
 *  denominator — they are not failures. */
export interface RedTeamCriticFailureStats {
  windowDays: number;
  /** Proposals in the window carrying any redTeamVerdict (ran OR failed). */
  reviews: number;
  /** Of those, verdicts with available === false. */
  failures: number;
  failureRatePct: number;
  /** failureKind → count, for the tooltip ("malformed_response: 3"). */
  byKind: Record<string, number>;
  /** Most common (model, kind) attribution among failures, when one exists. */
  topFailure?: { model?: string; kind: string; count: number };
}

export function getRedTeamCriticFailureStats(userId: string = "local", windowDays = 30): RedTeamCriticFailureStats {
  const sinceIso = new Date(Date.now() - windowDays * 24 * 3600_000).toISOString();
  const rows = getDb()
    .prepare("SELECT proposal FROM trade_proposals WHERE user_id = ? AND created_at >= ?")
    .all(userId, sinceIso) as Array<{ proposal: string }>;
  let reviews = 0;
  let failures = 0;
  const byKind: Record<string, number> = {};
  const byAttribution = new Map<string, { model?: string; kind: string; count: number }>();
  for (const row of rows) {
    let verdict: { available?: boolean; failureKind?: string; model?: string } | undefined;
    try {
      verdict = (JSON.parse(row.proposal) as { redTeamVerdict?: typeof verdict }).redTeamVerdict;
    } catch {
      continue;
    }
    if (!verdict || typeof verdict !== "object" || typeof verdict.available !== "boolean") continue;
    reviews += 1;
    if (verdict.available) continue;
    failures += 1;
    const kind = typeof verdict.failureKind === "string" && verdict.failureKind ? verdict.failureKind : "unavailable";
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    const model = typeof verdict.model === "string" && verdict.model.trim() ? canonicalModelId(verdict.model) || undefined : undefined;
    const attributionKey = `${model ?? ""}|${kind}`;
    const entry = byAttribution.get(attributionKey) ?? { model, kind, count: 0 };
    entry.count += 1;
    byAttribution.set(attributionKey, entry);
  }
  let topFailure: RedTeamCriticFailureStats["topFailure"];
  for (const entry of byAttribution.values()) {
    if (!topFailure || entry.count > topFailure.count) topFailure = entry;
  }
  return {
    windowDays,
    reviews,
    failures,
    failureRatePct: reviews > 0 ? Number(((failures / reviews) * 100).toFixed(1)) : 0,
    byKind,
    ...(topFailure ? { topFailure } : {})
  };
}

/** Idempotency for chat-drafted proposals: one draft/runId remains one proposal across its entire
 * lifecycle, including retries racing approval or arriving after a fill. */
export function findProposalIdByRunId(runId: string, userId: string = "local"): string | null {
  const row = getDb()
    .prepare("SELECT id FROM trade_proposals WHERE run_id = ? AND user_id = ? ORDER BY created_at ASC LIMIT 1")
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
  // Provenance lets the approval-time re-anchor (src/lib/approval-reprice.ts) distinguish a
  // genuine decision-time quote (reprice-eligible, even when the limit equals it exactly) from
  // this function's defensive copy of the limit price (a hard price — never repriced). Without
  // it, equality is the only heuristic and genuine at-market limits would wrongly stay stale.
  if (Number.isFinite(ref) && ref > 0) {
    return p.referencePriceProvenance ? proposal : { ...p, referencePriceProvenance: "provided" };
  }
  const fallback = Number(p.limitPrice) || Number(p.stopPrice);
  if (Number.isFinite(fallback) && fallback > 0) {
    return { ...p, referencePrice: fallback, referencePriceProvenance: "limit-fallback" };
  }
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
  // input.proposal arrives as `unknown` (it's whatever the caller assembled), but the LLM/strategy
  // path routinely stamps tradeThesisTag/entryMarketRegime directly on the proposal object without
  // threading them through as separate insertProposal args. Fall back to extracting them from the
  // proposal object itself so the dedicated columns (which the learning loop's SQL reads) don't stay
  // NULL forever while the same data sits unread inside the `proposal` blob.
  const { tradeThesisTag: derivedThesisTag, entryMarketRegime: derivedRegime } = proposalTagFallbacks(input.proposal);
  const symbol = deriveProposalSymbol(input.proposal);
  auditMalformedDecisionChain(input.id, input.proposal, input.userId ?? "local");

  getDb()
    .prepare(
      "INSERT INTO trade_proposals (id, user_id, run_id, account_number, created_at, proposal, decision, review, estimated_notional, ref_id, order_id, status, trade_thesis_tag, entry_market_regime, execution_mode, prompt_version, symbol) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
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
      input.tradeThesisTag ?? derivedThesisTag ?? null,
      input.entryMarketRegime ?? derivedRegime ?? null,
      input.executionMode ?? null,
      input.promptVersion ?? null,
      symbol ?? null
    );
}

/** One row of a symbol's proposal trajectory (watchlist digest lesson: digest — src/lib/report-context.ts).
 *  Deliberately narrower than TradeProposal: only what a trajectory table/summary needs to render. */
export interface SymbolProposalTrajectoryRow {
  id: string;
  createdAt: string;
  /** The proposal's terminal/current lifecycle status (trade_proposals.status — e.g. "placed",
   *  "blocked", "proposed"), NOT the PolicyDecision JSON blob. Format with feedStatusLabel
   *  (dashboard-ui.ts) for display. */
  decision: string;
  side: OrderSide;
  tradeThesisTag?: string;
  entryMarketRegime?: string;
  confidenceScore?: number;
  referencePrice?: number;
}

/**
 * Recent proposals for one symbol, newest first — the per-symbol lookback the watchlist digest
 * (and any future per-symbol history view) needs without scanning every proposal's JSON blob.
 * `accountNumber` narrows to one account when given; omitted, it spans every account the user has
 * (a symbol digest is inherently cross-account). `excludeRunId` drops one run's own rows — for a
 * caller building "history before this run" mid-strategy-tick without its own just-inserted
 * proposal leaking into its own trajectory.
 */
export function listProposalsBySymbol(input: {
  symbol: string;
  accountNumber?: string;
  userId?: string;
  limit?: number;
  excludeRunId?: string;
}): SymbolProposalTrajectoryRow[] {
  const symbol = normalizeSymbol(input.symbol);
  const userId = input.userId ?? "local";
  const limit = Math.max(1, Math.min(200, Math.floor(input.limit ?? 5)));

  const conditions = ["symbol = ?", "user_id = ?"];
  const params: Array<string | number> = [symbol, userId];
  if (input.accountNumber !== undefined) {
    conditions.push("account_number = ?");
    params.push(scopeAccount(input.accountNumber));
  }
  if (input.excludeRunId) {
    conditions.push("run_id != ?");
    params.push(input.excludeRunId);
  }
  params.push(limit);

  type RawRow = {
    id: string;
    created_at: string;
    status: string;
    proposal: string;
    trade_thesis_tag: string | null;
    entry_market_regime: string | null;
  };
  const rows = getDb()
    .prepare(
      `SELECT id, created_at, status, proposal, trade_thesis_tag, entry_market_regime FROM trade_proposals WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT ?`
    )
    .all(...params) as RawRow[];

  return rows.map((r) => {
    const parsedProposal = parseJson<Partial<TradeProposal>>(r.proposal, {});
    const fallback = proposalTagFallbacks(parsedProposal);
    return {
      id: r.id,
      createdAt: r.created_at,
      decision: r.status,
      side: (parsedProposal.side ?? "buy") as OrderSide,
      tradeThesisTag: r.trade_thesis_tag ?? fallback.tradeThesisTag ?? undefined,
      entryMarketRegime: r.entry_market_regime ?? fallback.entryMarketRegime ?? undefined,
      confidenceScore: typeof parsedProposal.confidenceScore === "number" ? parsedProposal.confidenceScore : undefined,
      referencePrice: typeof parsedProposal.referencePrice === "number" ? parsedProposal.referencePrice : undefined
    };
  });
}
