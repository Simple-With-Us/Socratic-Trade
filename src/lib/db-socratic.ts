// db-socratic.ts — durable Socratic decision case files, coaching, and framework proposals.
import "server-only";
import crypto from "crypto";
import { audit, getDb } from "./db";
import { mergeHorizonRows } from "./outcome-horizons";
import type {
  OrderSide,
  PolicyDecision,
  SocraticDecisionCase,
  SocraticDecisionStatus,
  SocraticEvidenceItem,
  SocraticFrameworkProposal,
  SocraticFrameworkAiReview,
  SocraticFrameworkOwnerVerb,
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
  green_team_rationale: string | null;
  sizing_snapshot: string | null;
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
  created_at: string;
  updated_at: string;
};

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
  owner_verb: string | null;
  owner_response: string | null;
  ai_review: string | null;
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
    ...(row.green_team_rationale ? { greenTeamRationale: row.green_team_rationale } : {}),
    ...(row.sizing_snapshot
      ? { sizingSnapshot: parseJson<SocraticDecisionCase["sizingSnapshot"] | undefined>(row.sizing_snapshot, undefined) }
      : {}),
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
    coachNotes: parseJson<string[]>(row.coach_notes, [])
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
    ...(row.owner_verb ? { ownerVerb: row.owner_verb as SocraticFrameworkOwnerVerb } : {}),
    ...(row.owner_response ? { ownerResponse: row.owner_response } : {}),
    ...(row.ai_review ? { aiReview: parseJson<SocraticFrameworkAiReview | undefined>(row.ai_review, undefined) } : {})
  };
}

function updateDecisionLifecycle(
  existing: SocraticDecisionCase,
  userId: string,
  patch: Partial<Pick<SocraticDecisionCase, "coachNotes" | "lessons">>
): SocraticDecisionCase | undefined {
  upsertSocraticDecisionCase({
    ...existing,
    userId,
    coachNotes: patch.coachNotes ?? existing.coachNotes,
    lessons: patch.lessons ?? existing.lessons
  });
  return getSocraticDecisionCase(existing.id, userId);
}

// Live in-row coach-note window. Notes beyond this cap age off into
// socratic_coach_note_archive (migration 53) instead of being silently dropped.
const COACH_NOTES_LIVE_CAP = 20;

/**
 * Shared core for both coach-note append paths (appendSocraticDecisionCoachNote and
 * attachSocraticDecisionCoachPrimitives). Archives any note(s) that age off the live window and
 * persists the live row in ONE db.transaction so a crash between the two writes can never lose a
 * note — it either has not yet aged off (still in the live row) or has already been archived
 * (row committed) before the live row commits alongside it. `extraPatch.lessons`, when supplied,
 * is written atomically with the coach-note update (used by attachSocraticDecisionCoachPrimitives'
 * lesson-promotion path) so that path performs exactly one write instead of two.
 *
 * `noteOrdinal` is a unique, monotone-going-forward per-decision ordinal used only to give the
 * new note's vector doc a stable, collision-free accession — NOT a historical index (pre-port
 * note history is unknowable, per the migration-53 comment in db.ts).
 */
function applyCoachNoteAppend(
  existing: SocraticDecisionCase,
  cleanedNote: string,
  userId: string,
  extraPatch: Partial<Pick<SocraticDecisionCase, "lessons">> = {}
): {
  coachNotes: string[];
  archivedCount: number;
  noteOrdinal: number;
  appendedAt: string;
  firstArchivedSeq?: number;
  lastArchivedSeq?: number;
} {
  const database = getDb();
  const appendedAt = new Date().toISOString();
  return database.transaction(() => {
    const archiveCountBefore = (
      database
        .prepare("SELECT COUNT(*) AS count FROM socratic_coach_note_archive WHERE user_id = ? AND decision_id = ?")
        .get(userId, existing.id) as { count: number }
    ).count;
    const noteOrdinal = archiveCountBefore + existing.coachNotes.length;
    const nextAll = [...existing.coachNotes, cleanedNote].filter(Boolean);
    const overflowCount = Math.max(0, nextAll.length - COACH_NOTES_LIVE_CAP);
    const overflow = nextAll.slice(0, overflowCount);
    const coachNotes = nextAll.slice(-COACH_NOTES_LIVE_CAP);

    let firstArchivedSeq: number | undefined;
    let lastArchivedSeq: number | undefined;
    const insertArchive = database.prepare(
      `INSERT INTO socratic_coach_note_archive (id, user_id, decision_id, connected_account_id, note, note_seq, archived_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    overflow.forEach((noteText, index) => {
      const seq = archiveCountBefore + index;
      if (firstArchivedSeq === undefined) firstArchivedSeq = seq;
      lastArchivedSeq = seq;
      insertArchive.run(crypto.randomUUID(), userId, existing.id, existing.connectedAccountId ?? null, noteText, seq, appendedAt);
    });

    // Same transaction as the archive inserts above — see function doc comment.
    upsertSocraticDecisionCase({
      ...existing,
      userId,
      coachNotes,
      lessons: extraPatch.lessons ?? existing.lessons
    });

    return { coachNotes, archivedCount: overflow.length, noteOrdinal, appendedAt, firstArchivedSeq, lastArchivedSeq };
  })();
}

function reindexDecisionMemory(updated: SocraticDecisionCase, mode: "await" | "fire-and-forget"): Promise<void> | void {
  const run = async () => {
    const { indexSocraticDecisionMemory } = await import("./socratic-memory");
    await indexSocraticDecisionMemory(updated);
  };
  if (mode === "await") {
    return run().catch((err) => {
      console.warn("[db-socratic] lifecycle re-index failed:", err instanceof Error ? err.message : String(err));
    });
  }
  void run().catch((err) => {
    console.warn("[db-socratic] lifecycle re-index failed:", err instanceof Error ? err.message : String(err));
  });
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
  greenTeamRationale?: string;
  sizingSnapshot?: SocraticDecisionCase["sizingSnapshot"];
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
}): string {
  const now = new Date().toISOString();
  const id = input.id ?? input.proposalId ?? crypto.randomUUID();
  getDb()
    .prepare(
      `INSERT INTO socratic_decisions (
        id, user_id, connected_account_id, run_id, proposal_id, account_number, symbol, side, status,
        authority, thesis, rationale, green_team_rationale, sizing_snapshot, action, thesis_tag, regime,
        confidence_score, notional, model, red_team, policy_decision, evidence, rag_attributions,
        dissent, outcome, autonomy_override, lessons, coach_notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        green_team_rationale = excluded.green_team_rationale,
        sizing_snapshot = excluded.sizing_snapshot,
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
      input.greenTeamRationale ?? null,
      input.sizingSnapshot ? JSON.stringify(input.sizingSnapshot) : null,
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
    .prepare(`SELECT * FROM socratic_decisions WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
    .all(...args) as DecisionRow[];
  return rows.map(rowToDecision);
}

export function getSocraticDecisionCase(id: string, userId: string = "local"): SocraticDecisionCase | undefined {
  const row = getDb().prepare("SELECT * FROM socratic_decisions WHERE id = ? AND user_id = ?").get(id, userId) as DecisionRow | undefined;
  return row ? rowToDecision(row) : undefined;
}

/** Accuracy-breaker feed (src/lib/accuracy-breaker.ts, docs/oss-lessons.md §8): the account's most
 *  recent matured DECISIVE outcomes (won/lost/flat) on REAL decisions only — placed/filled rows.
 *  Counterfactual outcomes of blocked/rejected proposals are excluded by decision status: avoiding
 *  a bad trade is a good call, not a miss, so counting those as losses would corrupt the streak.
 *  "unknown"/"unresolvable" terminals are excluded too (not decisive evidence either way). Newest
 *  first, by outcome.measuredAt (falling back to updated_at). */
export function listRecentDecisiveOutcomeStatuses(
  userId: string = "local",
  connectedAccountId?: string,
  limit: number = 50
): Array<{ status: "won" | "lost" | "flat"; measuredAt?: string }> {
  const capped = Math.max(1, Math.min(200, Math.floor(limit)));
  const clauses = ["user_id = ?", "status IN ('placed', 'filled')", "json_extract(outcome, '$.status') IN ('won', 'lost', 'flat')"];
  const args: unknown[] = [userId];
  if (connectedAccountId) {
    clauses.push("connected_account_id = ?");
    args.push(connectedAccountId);
  }
  args.push(capped);
  const rows = getDb()
    .prepare(
      `SELECT json_extract(outcome, '$.status') AS status, json_extract(outcome, '$.measuredAt') AS measured_at
       FROM socratic_decisions
       WHERE ${clauses.join(" AND ")}
       ORDER BY COALESCE(json_extract(outcome, '$.measuredAt'), updated_at) DESC, rowid DESC
       LIMIT ?`
    )
    .all(...args) as Array<{ status: "won" | "lost" | "flat"; measured_at: string | null }>;
  return rows.map((row) => ({ status: row.status, measuredAt: row.measured_at ?? undefined }));
}

export function appendSocraticDecisionCoachNote(id: string, note: string, userId: string = "local"): SocraticDecisionCase | undefined {
  const existing = getSocraticDecisionCase(id, userId);
  if (!existing) return undefined;
  const cleanedNote = note.trim();
  const { archivedCount, noteOrdinal, appendedAt, firstArchivedSeq, lastArchivedSeq } = applyCoachNoteAppend(existing, cleanedNote, userId);
  const updated = getSocraticDecisionCase(id, userId);
  audit("socratic_decision_coached", { decisionId: id, note }, userId, existing.connectedAccountId);
  if (archivedCount > 0) {
    audit(
      "socratic_decision_coach_notes_archived",
      { decisionId: id, count: archivedCount, firstNoteSeq: firstArchivedSeq, lastNoteSeq: lastArchivedSeq },
      userId,
      existing.connectedAccountId
    );
  }
  if (updated) {
    // An empty/whitespace-only note is a no-op append (the .filter(Boolean) inside
    // applyCoachNoteAppend drops it) — skip archive/vector emission for it entirely and fall back
    // to the plain re-index, matching the pre-port behavior of this edge case.
    if (cleanedNote) {
      // Sequential, not Promise.all: a verified vi.mock concurrent-dynamic-import race in the old
      // branch's test harness means these two dynamic imports/awaits must never run concurrently.
      void (async () => {
        await reindexDecisionMemory(updated, "await");
        const { indexCoachNoteMemory } = await import("./socratic-memory");
        await indexCoachNoteMemory(updated, cleanedNote, noteOrdinal, appendedAt);
      })().catch((err) => {
        console.warn("[db-socratic] coach-note vector write degraded:", err instanceof Error ? err.message : String(err));
        audit(
          "socratic_vector_write_degraded",
          { docType: "coach-note", decisionId: id, reason: String(err instanceof Error ? err.message : err) },
          userId,
          existing.connectedAccountId
        );
      });
    } else {
      reindexDecisionMemory(updated, "fire-and-forget");
    }
  }
  return updated;
}

export async function attachSocraticDecisionCoachPrimitives(
  id: string,
  input: {
    note: string;
    promoteTo?: "lesson" | "framework";
    lessonText?: string;
    framework?: Pick<SocraticFrameworkProposal, "priority" | "subsystem" | "title" | "rationale" | "proposedChange">;
  },
  userId: string = "local"
): Promise<{ decision: SocraticDecisionCase; frameworkProposal?: SocraticFrameworkProposal; promotedLesson?: string } | undefined> {
  const existing = getSocraticDecisionCase(id, userId);
  if (!existing) return undefined;
  const cleanedNote = input.note.trim();
  if (!cleanedNote) return undefined;
  const lessonCandidate = (input.lessonText ?? cleanedNote).trim();
  // Newly-added test: the array-dedup below makes this the correct "is this actually new" check —
  // re-promoting text already present in decision.lessons must not re-emit a lesson vector.
  const isNewLesson = input.promoteTo === "lesson" && Boolean(lessonCandidate) && !existing.lessons.includes(lessonCandidate);
  const promotedLesson =
    input.promoteTo === "lesson" && lessonCandidate
      ? [...existing.lessons, lessonCandidate].filter((value, index, list) => Boolean(value) && list.indexOf(value) === index).slice(-12)
      : existing.lessons;
  const { archivedCount, noteOrdinal, appendedAt, firstArchivedSeq, lastArchivedSeq } = applyCoachNoteAppend(existing, cleanedNote, userId, {
    lessons: promotedLesson
  });
  const updated = getSocraticDecisionCase(id, userId);
  if (!updated) return undefined;
  audit("socratic_decision_coached", { decisionId: id, note: cleanedNote }, userId, existing.connectedAccountId);
  if (archivedCount > 0) {
    audit(
      "socratic_decision_coach_notes_archived",
      { decisionId: id, count: archivedCount, firstNoteSeq: firstArchivedSeq, lastNoteSeq: lastArchivedSeq },
      userId,
      existing.connectedAccountId
    );
  }
  if (input.promoteTo === "lesson" && lessonCandidate) {
    audit("socratic_decision_coach_promoted", { decisionId: id, kind: "lesson", lesson: lessonCandidate }, userId, existing.connectedAccountId);
  }
  let frameworkProposal: SocraticFrameworkProposal | undefined;
  if (input.promoteTo === "framework") {
    const frameworkInput = input.framework;
    const frameworkId = createSocraticFrameworkProposal({
      userId,
      connectedAccountId: existing.connectedAccountId,
      decisionId: existing.id,
      runId: existing.runId,
      priority: frameworkInput?.priority ?? "medium",
      subsystem: frameworkInput?.subsystem ?? "coaching",
      title: frameworkInput?.title?.trim() || `Coach follow-up for ${existing.symbol ?? existing.thesis ?? "decision"}`,
      rationale: frameworkInput?.rationale?.trim() || cleanedNote,
      proposedChange: frameworkInput?.proposedChange?.trim() || cleanedNote,
      evidence: existing.evidence.filter((item) => item.kind === "learning" || item.kind === "framework" || item.kind === "override").slice(0, 6)
    });
    frameworkProposal = getSocraticFrameworkProposal(frameworkId, userId);
    audit("socratic_decision_coach_promoted", { decisionId: id, kind: "framework", frameworkProposalId: frameworkId }, userId, existing.connectedAccountId);
  }
  await reindexDecisionMemory(updated, "await");
  const { indexCoachNoteMemory, indexPromotedLessonMemory } = await import("./socratic-memory");
  try {
    await indexCoachNoteMemory(updated, cleanedNote, noteOrdinal, appendedAt);
  } catch (err) {
    console.warn("[db-socratic] coach-note vector write degraded:", err instanceof Error ? err.message : String(err));
    audit(
      "socratic_vector_write_degraded",
      { docType: "coach-note", decisionId: id, reason: String(err instanceof Error ? err.message : err) },
      userId,
      existing.connectedAccountId
    );
  }
  if (isNewLesson) {
    try {
      await indexPromotedLessonMemory(updated, lessonCandidate);
    } catch (err) {
      console.warn("[db-socratic] lesson vector write degraded:", err instanceof Error ? err.message : String(err));
      audit(
        "socratic_vector_write_degraded",
        { docType: "lesson", decisionId: id, reason: String(err instanceof Error ? err.message : err) },
        userId,
        existing.connectedAccountId
      );
    }
  }
  return {
    decision: updated,
    ...(frameworkProposal ? { frameworkProposal } : {}),
    ...(input.promoteTo === "lesson" && lessonCandidate ? { promotedLesson: lessonCandidate } : {})
  };
}

/**
 * Decision cases the outcome engine still owes an outcome: statuses that map to a measurable
 * forward path (placed -> fills/closed lots; blocked/rejected -> counterfactual refPrice), whose
 * outcome is absent or still 'open', and which were not re-measured more recently than
 * `measuredBefore` (bounded recheck cadence). Oldest first so long-owed cases mature first.
 */
/**
 * User-scoped read of coach notes that aged off the live window (migration 53). Cross-user ids
 * (a decision belonging to a different user) return an empty array — never another user's notes.
 */
export function listArchivedCoachNotes(
  decisionId: string,
  userId: string = "local"
): Array<{ id: string; note: string; noteSeq: number; archivedAt: string; connectedAccountId?: string }> {
  const rows = getDb()
    .prepare(
      `SELECT id, note, note_seq, archived_at, connected_account_id
       FROM socratic_coach_note_archive
       WHERE user_id = ? AND decision_id = ?
       ORDER BY note_seq ASC`
    )
    .all(userId, decisionId) as Array<{
      id: string;
      note: string;
      note_seq: number;
      archived_at: string;
      connected_account_id: string | null;
    }>;
  return rows.map((row) => ({
    id: row.id,
    note: row.note,
    noteSeq: row.note_seq,
    archivedAt: row.archived_at,
    ...(row.connected_account_id ? { connectedAccountId: row.connected_account_id } : {})
  }));
}

export function listSocraticDecisionCasesNeedingOutcome(
  userId: string = "local",
  opts: { limit?: number; measuredBefore?: string; connectedAccountId?: string } = {}
): SocraticDecisionCase[] {
  const limit = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 25)));
  const measuredBefore = opts.measuredBefore ?? new Date().toISOString();
  const clauses = [
    "user_id = ?",
    "status IN ('placed', 'blocked', 'rejected', 'filled', 'rejected_by_broker')",
    "(outcome IS NULL OR (json_extract(outcome, '$.status') = 'open' AND COALESCE(json_extract(outcome, '$.measuredAt'), '') <= ?))"
  ];
  const args: unknown[] = [userId, measuredBefore];
  if (opts.connectedAccountId) {
    clauses.push("connected_account_id = ?");
    args.push(opts.connectedAccountId);
  }
  args.push(limit);
  const rows = getDb()
    .prepare(`SELECT * FROM socratic_decisions WHERE ${clauses.join(" AND ")} ORDER BY created_at ASC, rowid ASC LIMIT ?`)
    .all(...args) as DecisionRow[];
  return rows.map(rowToDecision);
}

/**
 * Outcome-engine write path: persist a case's (possibly still-'open') outcome, emit the per-case
 * receipt, and re-index the vector-memory doc so retrieval sees the matured outcome instead of
 * "outcome: pending" frozen at creation. Same fire-and-forget/lifecycle-hook pattern as
 * appendSocraticDecisionCoachNote. Returns the updated case, or undefined when the id is unknown.
 *
 * Lost-update guard: `outcome.outcomes` may have been built from a pass-start snapshot held across
 * awaits (measureCase in outcome-engine.ts), so a worker-sampled 15m/1h row written concurrently
 * (drainDueIntradaySampleJobs) could otherwise be erased by this stale write. Re-merge against the
 * FRESH `existing` row read just above right before persisting — mergeHorizonRows' existing-terminal-
 * wins semantics make this idempotent/first-writer-wins regardless of write order.
 */
export async function writeSocraticDecisionOutcome(
  id: string,
  outcome: NonNullable<SocraticDecisionCase["outcome"]>,
  userId: string = "local"
): Promise<SocraticDecisionCase | undefined> {
  const existing = getSocraticDecisionCase(id, userId);
  if (!existing) return undefined;
  const mergedOutcome = { ...outcome, outcomes: mergeHorizonRows(existing.outcome?.outcomes, outcome.outcomes) };
  upsertSocraticDecisionCase({ ...existing, userId, outcome: mergedOutcome });
  const resolvedHorizons = mergedOutcome.outcomes.filter((row) => row.resolution === "ok").length;
  audit(
    "socratic_outcome_recorded",
    {
      decisionId: id,
      status: mergedOutcome.status,
      returnPct: mergedOutcome.returnPct,
      pnlUsd: mergedOutcome.pnlUsd,
      horizons: mergedOutcome.outcomes,
      coverage: `${resolvedHorizons}/${mergedOutcome.outcomes.length} horizons resolved`
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
      const { indexSocraticDecisionMemory, indexLessonMemory } = await import("./socratic-memory");
      await indexSocraticDecisionMemory(updated);
      await Promise.all(
        cleaned.map((lesson, lessonIndex) => indexLessonMemory({ decision: updated, lesson, lessonIndex }))
      );
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
  const clauses = ["user_id = ?", "status IN ('placed', 'filled', 'blocked', 'rejected', 'rejected_by_broker')"];
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
  opts: { limit?: number; status?: SocraticFrameworkProposalStatus; connectedAccountId?: string; unreviewedOnly?: boolean } = {}
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
  // Only rows the batched reviewer hasn't touched yet — lets it page through a backlog
  // larger than any single fetch window instead of re-loading the newest already-reviewed rows.
  if (opts.unreviewedOnly) {
    clauses.push("ai_review IS NULL");
  }
  args.push(limit);
  const rows = getDb()
    .prepare(`SELECT * FROM socratic_framework_proposals WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
    .all(...args) as FrameworkRow[];
  return rows.map(rowToFramework);
}

export function getSocraticFrameworkProposal(id: string, userId: string = "local"): SocraticFrameworkProposal | undefined {
  const row = getDb().prepare("SELECT * FROM socratic_framework_proposals WHERE id = ? AND user_id = ?").get(id, userId) as FrameworkRow | undefined;
  return row ? rowToFramework(row) : undefined;
}

export function updateSocraticFrameworkProposalStatus(
  id: string,
  status: SocraticFrameworkProposalStatus,
  userId: string = "local",
  ownerResponse?: string,
  ownerVerb?: SocraticFrameworkOwnerVerb
): SocraticFrameworkProposal | undefined {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      "UPDATE socratic_framework_proposals SET status = ?, owner_verb = COALESCE(?, owner_verb), owner_response = COALESCE(?, owner_response), updated_at = ? WHERE id = ? AND user_id = ?"
    )
    .run(status, ownerVerb ?? null, ownerResponse ?? null, now, id, userId);
  const row = getDb().prepare("SELECT * FROM socratic_framework_proposals WHERE id = ? AND user_id = ?").get(id, userId) as FrameworkRow | undefined;
  if (!row) return undefined;
  const framework = rowToFramework(row);
  audit("socratic_framework_proposal_resolved", { id, status, ownerVerb, ownerResponse }, userId, framework.connectedAccountId);
  return framework;
}

/** Attach (or clear) the advisory AI review on a proposal. Does NOT change status or
 *  owner verb — the owner still decides. Pass `null` to clear. Scoped to the user. */
export function setSocraticFrameworkProposalAiReview(
  id: string,
  userId: string,
  review: SocraticFrameworkAiReview | null
): SocraticFrameworkProposal | undefined {
  const now = new Date().toISOString();
  getDb()
    .prepare("UPDATE socratic_framework_proposals SET ai_review = ?, updated_at = ? WHERE id = ? AND user_id = ?")
    .run(review ? JSON.stringify(review) : null, now, id, userId);
  const row = getDb().prepare("SELECT * FROM socratic_framework_proposals WHERE id = ? AND user_id = ?").get(id, userId) as FrameworkRow | undefined;
  return row ? rowToFramework(row) : undefined;
}
