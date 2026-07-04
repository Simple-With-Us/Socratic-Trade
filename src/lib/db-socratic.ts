// db-socratic.ts — durable Socratic decision case files, coaching, and framework proposals.
import crypto from "crypto";
import { audit, getDb } from "./db";
import type {
  OrderSide,
  PolicyDecision,
  SocraticDecisionCase,
  SocraticDecisionStatus,
  SocraticEvidenceItem,
  SocraticFrameworkProposal,
  SocraticFrameworkProposalStatus,
  SocraticRagAttribution,
  StrategyAuthority,
  TradeProposal
} from "./types";

type DecisionRow = {
  id: string;
  user_id: string;
  connected_account_id: string | null;
  run_id: string | null;
  proposal_id: string | null;
  account_number: string | null;
  symbol: string | null;
  side: string | null;
  status: string;
  authority: string;
  thesis: string;
  rationale: string;
  action: string;
  thesis_tag: string | null;
  regime: string | null;
  confidence_score: number | null;
  notional: number | null;
  model: string | null;
  red_team: string | null;
  policy_decision: string | null;
  evidence: string;
  rag_attributions: string;
  dissent: string;
  outcome: string | null;
  autonomy_override: string | null;
  lessons: string;
  coach_notes: string;
  socratic_ext: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * Socratic first-class case fields (w3-schema-dissent, 2026-07-05) — persisted together in ONE
 * JSON column (`socratic_decisions.socratic_ext`) instead of nine new columns: they always travel
 * as a unit from the proposal, and a single column keeps the migration additive and
 * merge-friendly. `debateTranscript` inside it is IMMUTABLE by contract: it is written once at
 * debate time and every later upsert round-trips it unchanged (regression-tested).
 */
type SocraticCaseExt = Pick<
  SocraticDecisionCase,
  | "belief"
  | "iMayBeWrongIf"
  | "reversalTriggers"
  | "evidenceRefs"
  | "usedEvidence"
  | "strongestCounterRead"
  | "reviewNotes"
  | "debateTranscript"
  | "wouldReconsiderIf"
>;

function socraticExtJson(input: SocraticCaseExt): string | null {
  const ext: SocraticCaseExt = {
    ...(input.belief ? { belief: input.belief } : {}),
    ...(input.iMayBeWrongIf?.length ? { iMayBeWrongIf: input.iMayBeWrongIf } : {}),
    ...(input.reversalTriggers?.length ? { reversalTriggers: input.reversalTriggers } : {}),
    ...(input.evidenceRefs?.length ? { evidenceRefs: input.evidenceRefs } : {}),
    ...(input.usedEvidence?.length ? { usedEvidence: input.usedEvidence } : {}),
    ...(input.strongestCounterRead ? { strongestCounterRead: input.strongestCounterRead } : {}),
    ...(input.reviewNotes?.length ? { reviewNotes: input.reviewNotes } : {}),
    ...(input.debateTranscript ? { debateTranscript: input.debateTranscript } : {}),
    ...(input.wouldReconsiderIf ? { wouldReconsiderIf: input.wouldReconsiderIf } : {})
  };
  return Object.keys(ext).length > 0 ? JSON.stringify(ext) : null;
}

type FrameworkRow = {
  id: string;
  user_id: string;
  connected_account_id: string | null;
  decision_id: string | null;
  run_id: string | null;
  status: string;
  priority: string;
  subsystem: string;
  title: string;
  rationale: string;
  proposed_change: string;
  evidence: string;
  owner_response: string | null;
  created_at: string;
  updated_at: string;
};

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function rowToDecision(row: DecisionRow): SocraticDecisionCase {
  return {
    id: row.id,
    userId: row.user_id,
    ...(row.connected_account_id ? { connectedAccountId: row.connected_account_id } : {}),
    ...(row.run_id ? { runId: row.run_id } : {}),
    ...(row.proposal_id ? { proposalId: row.proposal_id } : {}),
    ...(row.account_number ? { accountNumber: row.account_number } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.symbol ? { symbol: row.symbol } : {}),
    ...(row.side ? { side: row.side as OrderSide } : {}),
    status: row.status as SocraticDecisionStatus,
    authority: row.authority as StrategyAuthority,
    thesis: row.thesis,
    rationale: row.rationale,
    action: row.action,
    ...(row.thesis_tag ? { thesisTag: row.thesis_tag } : {}),
    ...(row.regime ? { regime: row.regime } : {}),
    ...(row.confidence_score != null ? { confidenceScore: row.confidence_score } : {}),
    ...(row.notional != null ? { notional: row.notional } : {}),
    ...(row.model ? { model: row.model } : {}),
    ...(row.red_team ? { redTeamVerdict: parseJson<TradeProposal["redTeamVerdict"] | undefined>(row.red_team, undefined) } : {}),
    ...(row.policy_decision ? { policyDecision: parseJson<PolicyDecision | undefined>(row.policy_decision, undefined) } : {}),
    evidence: parseJson<SocraticEvidenceItem[]>(row.evidence, []),
    ragAttributions: parseJson<SocraticRagAttribution[]>(row.rag_attributions, []),
    dissent: parseJson<SocraticEvidenceItem[]>(row.dissent, []),
    ...(row.outcome ? { outcome: parseJson<SocraticDecisionCase["outcome"] | undefined>(row.outcome, undefined) } : {}),
    ...(row.autonomy_override
      ? { autonomyOverride: parseJson<SocraticDecisionCase["autonomyOverride"] | undefined>(row.autonomy_override, undefined) }
      : {}),
    lessons: parseJson<string[]>(row.lessons, []),
    coachNotes: parseJson<string[]>(row.coach_notes, []),
    ...(row.socratic_ext ? parseJson<SocraticCaseExt>(row.socratic_ext, {}) : {})
  };
}

function rowToFramework(row: FrameworkRow): SocraticFrameworkProposal {
  return {
    id: row.id,
    userId: row.user_id,
    ...(row.connected_account_id ? { connectedAccountId: row.connected_account_id } : {}),
    ...(row.decision_id ? { decisionId: row.decision_id } : {}),
    ...(row.run_id ? { runId: row.run_id } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    status: row.status as SocraticFrameworkProposalStatus,
    priority: row.priority as SocraticFrameworkProposal["priority"],
    subsystem: row.subsystem as SocraticFrameworkProposal["subsystem"],
    title: row.title,
    rationale: row.rationale,
    proposedChange: row.proposed_change,
    evidence: parseJson<SocraticEvidenceItem[]>(row.evidence, []),
    ...(row.owner_response ? { ownerResponse: row.owner_response } : {})
  };
}

export function upsertSocraticDecisionCase(input: {
  id?: string;
  userId?: string;
  connectedAccountId?: string;
  runId?: string;
  proposalId?: string;
  accountNumber?: string;
  symbol?: string;
  side?: OrderSide;
  status: SocraticDecisionStatus;
  authority: StrategyAuthority;
  thesis: string;
  rationale: string;
  action: string;
  thesisTag?: string;
  regime?: string;
  confidenceScore?: number;
  notional?: number;
  model?: string;
  redTeamVerdict?: TradeProposal["redTeamVerdict"];
  policyDecision?: PolicyDecision;
  evidence?: SocraticEvidenceItem[];
  ragAttributions?: SocraticRagAttribution[];
  dissent?: SocraticEvidenceItem[];
  outcome?: SocraticDecisionCase["outcome"];
  autonomyOverride?: SocraticDecisionCase["autonomyOverride"];
  lessons?: string[];
  coachNotes?: string[];
  belief?: string;
  iMayBeWrongIf?: SocraticDecisionCase["iMayBeWrongIf"];
  reversalTriggers?: SocraticDecisionCase["reversalTriggers"];
  evidenceRefs?: SocraticDecisionCase["evidenceRefs"];
  usedEvidence?: SocraticDecisionCase["usedEvidence"];
  strongestCounterRead?: string;
  reviewNotes?: SocraticDecisionCase["reviewNotes"];
  debateTranscript?: SocraticDecisionCase["debateTranscript"];
  wouldReconsiderIf?: string;
}): string {
  const now = new Date().toISOString();
  const id = input.id ?? input.proposalId ?? crypto.randomUUID();
  getDb()
    .prepare(
      `INSERT INTO socratic_decisions (
        id, user_id, connected_account_id, run_id, proposal_id, account_number, symbol, side, status,
        authority, thesis, rationale, action, thesis_tag, regime, confidence_score, notional, model,
        red_team, policy_decision, evidence, rag_attributions, dissent, outcome, autonomy_override,
        lessons, coach_notes, socratic_ext, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        connected_account_id = excluded.connected_account_id,
        run_id = excluded.run_id,
        proposal_id = excluded.proposal_id,
        account_number = excluded.account_number,
        symbol = excluded.symbol,
        side = excluded.side,
        status = excluded.status,
        authority = excluded.authority,
        thesis = excluded.thesis,
        rationale = excluded.rationale,
        action = excluded.action,
        thesis_tag = excluded.thesis_tag,
        regime = excluded.regime,
        confidence_score = excluded.confidence_score,
        notional = excluded.notional,
        model = excluded.model,
        red_team = excluded.red_team,
        policy_decision = excluded.policy_decision,
        evidence = excluded.evidence,
        rag_attributions = excluded.rag_attributions,
        dissent = excluded.dissent,
        outcome = excluded.outcome,
        autonomy_override = excluded.autonomy_override,
        lessons = excluded.lessons,
        coach_notes = excluded.coach_notes,
        socratic_ext = excluded.socratic_ext,
        updated_at = excluded.updated_at`
    )
    .run(
      id,
      input.userId ?? "local",
      input.connectedAccountId ?? null,
      input.runId ?? null,
      input.proposalId ?? null,
      input.accountNumber ?? null,
      input.symbol ?? null,
      input.side ?? null,
      input.status,
      input.authority,
      input.thesis,
      input.rationale,
      input.action,
      input.thesisTag ?? null,
      input.regime ?? null,
      input.confidenceScore ?? null,
      input.notional ?? null,
      input.model ?? null,
      input.redTeamVerdict ? JSON.stringify(input.redTeamVerdict) : null,
      input.policyDecision ? JSON.stringify(input.policyDecision) : null,
      JSON.stringify(input.evidence ?? []),
      JSON.stringify(input.ragAttributions ?? []),
      JSON.stringify(input.dissent ?? []),
      input.outcome ? JSON.stringify(input.outcome) : null,
      input.autonomyOverride ? JSON.stringify(input.autonomyOverride) : null,
      JSON.stringify(input.lessons ?? []),
      JSON.stringify(input.coachNotes ?? []),
      socraticExtJson(input),
      now,
      now
    );
  return id;
}

export function listSocraticDecisionCases(
  userId: string = "local",
  opts: { limit?: number; connectedAccountId?: string; runId?: string } = {}
): SocraticDecisionCase[] {
  const limit = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 50)));
  const clauses = ["user_id = ?"];
  const args: unknown[] = [userId];
  if (opts.connectedAccountId) {
    clauses.push("connected_account_id = ?");
    args.push(opts.connectedAccountId);
  }
  if (opts.runId) {
    clauses.push("run_id = ?");
    args.push(opts.runId);
  }
  args.push(limit);
  const rows = getDb()
    .prepare(`SELECT * FROM socratic_decisions WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT ?`)
    .all(...args) as DecisionRow[];
  return rows.map(rowToDecision);
}

export function getSocraticDecisionCase(id: string, userId: string = "local"): SocraticDecisionCase | undefined {
  const row = getDb().prepare("SELECT * FROM socratic_decisions WHERE id = ? AND user_id = ?").get(id, userId) as DecisionRow | undefined;
  return row ? rowToDecision(row) : undefined;
}

export function appendSocraticDecisionCoachNote(id: string, note: string, userId: string = "local"): SocraticDecisionCase | undefined {
  const existing = getSocraticDecisionCase(id, userId);
  if (!existing) return undefined;
  const coachNotes = [...existing.coachNotes, note.trim()].filter(Boolean).slice(-20);
  upsertSocraticDecisionCase({ ...existing, userId, coachNotes });
  audit("socratic_decision_coached", { decisionId: id, note }, userId, existing.connectedAccountId);
  const updated = getSocraticDecisionCase(id, userId);
  // Re-index the vector-memory case doc so the appended note is actually retrievable at decision
  // time, not frozen at "coach_notes: none" the way it was written at creation
  // (indexSocraticDecisionMemory previously ran exactly once, at strategy.ts's original upsert).
  // The doc's dedupKeyPrefix ("socratic-decision") + stable id/contextId make this an in-place
  // upsert, not a duplicate vector. Dynamic import avoids a module cycle: socratic-memory ->
  // vector-db -> ./db (this barrel) -> db-socratic. Fire-and-forget + non-fatal, matching every
  // other indexSocraticDecisionMemory call site.
  if (updated) {
    void import("./socratic-memory")
      .then(({ indexSocraticDecisionMemory }) => indexSocraticDecisionMemory(updated))
      .catch((err) => {
        console.warn("[db-socratic] re-index after coach note failed:", err instanceof Error ? err.message : String(err));
      });
  }
  return updated;
}

/**
 * Decision cases the outcome engine still owes an outcome: statuses that map to a measurable
 * forward path (placed -> fills/closed lots; blocked/rejected -> counterfactual refPrice), whose
 * outcome is absent or still 'open', and which were not re-measured more recently than
 * `measuredBefore` (bounded recheck cadence). Oldest first so long-owed cases mature first.
 */
export function listSocraticDecisionCasesNeedingOutcome(
  userId: string = "local",
  opts: { limit?: number; measuredBefore?: string; connectedAccountId?: string } = {}
): SocraticDecisionCase[] {
  const limit = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 25)));
  const measuredBefore = opts.measuredBefore ?? new Date().toISOString();
  const clauses = [
    "user_id = ?",
    "status IN ('placed', 'blocked', 'rejected')",
    "(outcome IS NULL OR (json_extract(outcome, '$.status') = 'open' AND COALESCE(json_extract(outcome, '$.measuredAt'), '') <= ?))"
  ];
  const args: unknown[] = [userId, measuredBefore];
  if (opts.connectedAccountId) {
    clauses.push("connected_account_id = ?");
    args.push(opts.connectedAccountId);
  }
  args.push(limit);
  const rows = getDb()
    .prepare(`SELECT * FROM socratic_decisions WHERE ${clauses.join(" AND ")} ORDER BY created_at ASC LIMIT ?`)
    .all(...args) as DecisionRow[];
  return rows.map(rowToDecision);
}

/**
 * Outcome-engine write path: persist a case's (possibly still-'open') outcome, emit the per-case
 * receipt, and re-index the vector-memory doc so retrieval sees the matured outcome instead of
 * "outcome: pending" frozen at creation. Same fire-and-forget/lifecycle-hook pattern as
 * appendSocraticDecisionCoachNote. Returns the updated case, or undefined when the id is unknown.
 */
export async function writeSocraticDecisionOutcome(
  id: string,
  outcome: NonNullable<SocraticDecisionCase["outcome"]>,
  userId: string = "local"
): Promise<SocraticDecisionCase | undefined> {
  const existing = getSocraticDecisionCase(id, userId);
  if (!existing) return undefined;
  upsertSocraticDecisionCase({ ...existing, userId, outcome });
  const resolvedHorizons = outcome.outcomes.filter((row) => row.resolution === "ok").length;
  audit(
    "socratic_outcome_recorded",
    {
      decisionId: id,
      status: outcome.status,
      returnPct: outcome.returnPct,
      pnlUsd: outcome.pnlUsd,
      horizons: outcome.outcomes,
      coverage: `${resolvedHorizons}/${outcome.outcomes.length} horizons resolved`
    },
    userId,
    existing.connectedAccountId
  );
  const updated = getSocraticDecisionCase(id, userId);
  if (updated) {
    // AWAITED (unlike the interactive coach-note append): the caller is a background job, so a
    // deterministic re-index costs nothing and guarantees retrieval sees the matured outcome.
    // Still non-fatal — an indexing failure never loses the persisted outcome row.
    try {
      const { indexSocraticDecisionMemory } = await import("./socratic-memory");
      await indexSocraticDecisionMemory(updated);
    } catch (err) {
      console.warn("[db-socratic] re-index after outcome write failed:", err instanceof Error ? err.message : String(err));
    }
  }
  return updated;
}

/**
 * Outcome-engine lessons write path: replace the creation-time template lessons with the real
 * post-mortem lessons, receipt it, and re-index (lifecycle hook) so the lessons are retrievable.
 */
export async function writeSocraticDecisionLessons(id: string, lessons: string[], userId: string = "local"): Promise<SocraticDecisionCase | undefined> {
  const existing = getSocraticDecisionCase(id, userId);
  if (!existing) return undefined;
  const cleaned = lessons.map((lesson) => lesson.trim()).filter(Boolean).slice(0, 8);
  if (cleaned.length === 0) return existing;
  upsertSocraticDecisionCase({ ...existing, userId, lessons: cleaned });
  audit("socratic_decision_lessons_written", { decisionId: id, lessons: cleaned }, userId, existing.connectedAccountId);
  const updated = getSocraticDecisionCase(id, userId);
  if (updated) {
    // AWAITED for the same reason as writeSocraticDecisionOutcome; non-fatal on failure.
    try {
      const { indexSocraticDecisionMemory } = await import("./socratic-memory");
      await indexSocraticDecisionMemory(updated);
    } catch (err) {
      console.warn("[db-socratic] re-index after lessons write failed:", err instanceof Error ? err.message : String(err));
    }
  }
  return updated;
}

/** Outcome coverage across measurable decision cases (kill-survivorship disclosure): unresolvable
 * cases stay in the denominator, and the disclosure string is stamped on maturation receipts. */
export interface SocraticOutcomeCoverage {
  totalMeasurable: number;
  resolved: number;
  open: number;
  unresolvable: number;
  /** resolved / (resolved + unresolvable) as a %, 0 when nothing terminal yet. */
  resolvedPct: number;
  disclosure: string;
}

export function getSocraticOutcomeCoverage(userId: string = "local", connectedAccountId?: string): SocraticOutcomeCoverage {
  const clauses = ["user_id = ?", "status IN ('placed', 'blocked', 'rejected')"];
  const args: unknown[] = [userId];
  if (connectedAccountId) {
    clauses.push("connected_account_id = ?");
    args.push(connectedAccountId);
  }
  const rows = getDb()
    .prepare(
      `SELECT COALESCE(json_extract(outcome, '$.status'), 'unmeasured') AS outcome_status, COUNT(*) AS n
       FROM socratic_decisions WHERE ${clauses.join(" AND ")} GROUP BY outcome_status`
    )
    .all(...args) as Array<{ outcome_status: string; n: number }>;
  const count = (...statuses: string[]) => rows.filter((r) => statuses.includes(r.outcome_status)).reduce((sum, r) => sum + r.n, 0);
  const resolved = count("won", "lost", "flat", "unknown");
  const open = count("open", "unmeasured");
  const unresolvable = count("unresolvable");
  const terminal = resolved + unresolvable;
  const resolvedPct = terminal > 0 ? Number(((resolved / terminal) * 100).toFixed(1)) : 0;
  const disclosure =
    terminal > 0
      ? `${resolved}/${terminal} resolved (${resolvedPct}%)${unresolvable > 0 ? ` — ${unresolvable} unresolvable; may be survivor-biased` : ""}${open > 0 ? `; ${open} still maturing` : ""}`
      : `0 resolved${open > 0 ? `; ${open} still maturing` : ""}`;
  return { totalMeasurable: resolved + open + unresolvable, resolved, open, unresolvable, resolvedPct, disclosure };
}

export function createSocraticFrameworkProposal(input: {
  userId?: string;
  connectedAccountId?: string;
  decisionId?: string;
  runId?: string;
  priority?: SocraticFrameworkProposal["priority"];
  subsystem: SocraticFrameworkProposal["subsystem"];
  title: string;
  rationale: string;
  proposedChange: string;
  evidence?: SocraticEvidenceItem[];
}): string {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  getDb()
    .prepare(
      `INSERT INTO socratic_framework_proposals (
        id, user_id, connected_account_id, decision_id, run_id, status, priority, subsystem,
        title, rationale, proposed_change, evidence, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      input.userId ?? "local",
      input.connectedAccountId ?? null,
      input.decisionId ?? null,
      input.runId ?? null,
      input.priority ?? "medium",
      input.subsystem,
      input.title,
      input.rationale,
      input.proposedChange,
      JSON.stringify(input.evidence ?? []),
      now,
      now
    );
  audit("socratic_framework_proposal_created", { id, title: input.title, subsystem: input.subsystem }, input.userId ?? "local", input.connectedAccountId);
  return id;
}

export function listSocraticFrameworkProposals(
  userId: string = "local",
  opts: { limit?: number; status?: SocraticFrameworkProposalStatus; connectedAccountId?: string } = {}
): SocraticFrameworkProposal[] {
  const limit = Math.max(1, Math.min(100, Math.floor(opts.limit ?? 25)));
  const clauses = ["user_id = ?"];
  const args: unknown[] = [userId];
  if (opts.status) {
    clauses.push("status = ?");
    args.push(opts.status);
  }
  if (opts.connectedAccountId) {
    clauses.push("connected_account_id = ?");
    args.push(opts.connectedAccountId);
  }
  args.push(limit);
  const rows = getDb()
    .prepare(`SELECT * FROM socratic_framework_proposals WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT ?`)
    .all(...args) as FrameworkRow[];
  return rows.map(rowToFramework);
}

export function updateSocraticFrameworkProposalStatus(
  id: string,
  status: SocraticFrameworkProposalStatus,
  userId: string = "local",
  ownerResponse?: string
): SocraticFrameworkProposal | undefined {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      "UPDATE socratic_framework_proposals SET status = ?, owner_response = COALESCE(?, owner_response), updated_at = ? WHERE id = ? AND user_id = ?"
    )
    .run(status, ownerResponse ?? null, now, id, userId);
  const row = getDb().prepare("SELECT * FROM socratic_framework_proposals WHERE id = ? AND user_id = ?").get(id, userId) as FrameworkRow | undefined;
  if (!row) return undefined;
  const framework = rowToFramework(row);
  audit("socratic_framework_proposal_resolved", { id, status, ownerResponse }, userId, framework.connectedAccountId);
  return framework;
}
