// soft-archive.ts — OD-7 weekly soft-archive sweep (owner-approved 2026-11-25).
//
// The ONLY writer of `archived_at` on vector_doc_lifecycle rows. It grades each live
// episodic lifecycle row with the SAME credited outcome history retrieval already trusts,
// read PER DOCUMENT (docIdStatsFor, the grading-mode-aware per-doc selection): a strong
// held document must never be archived because its TYPE's aggregate hit rate dropped, so
// kind-level aggregates are deliberately NOT used for an individual archive decision. A
// doc is archived only when shouldSoftArchive agrees:
//   - recencyScore under the 0.15 floor (~2.7 half-lives old; for the 45-day
//     socratic-decision / experience half-lives that is ~123 days), AND
//   - the capped blend under its 0.25 floor, which WITHOUT a fabricated per-doc
//     similarity can only happen for KNOWN LOSERS: the credited outcome hit rate
//     (importance) stands in as the semantic-proxy term, so blended < 0.25 requires
//     importance <= 25 with at least SOFT_ARCHIVE_MIN_SAMPLES credited matured
//     decisions.
// A doc with no credited history of ITS OWN (neutral importance 50), a lesson, a
// coach-note, or a younger doc is never archived. The read-side exclusion lives in
// experience-memory.ts.
//
// Never throws: the scheduler lane treats any failure as a skipped pass, exactly like the
// retrieval-usefulness join.
import "server-only";
import { audit } from "./db";
import { archiveVectorDocs, listLiveVectorDocLifecycle } from "./db-memory-lifecycle";
import {
  ageDaysSince,
  blendedScore,
  docImportance,
  halfLifeDaysFor,
  recencyScore,
  shouldSoftArchive
} from "./memory-decay";
import { docIdStatsFor, USEFULNESS_MIN_SAMPLES } from "./retrieval-usefulness";
import { getInternalSetting, setInternalSetting } from "./db-settings";

/** One UTC watermark per user, weekly: the sweep is cheap SQLite-only work but a whole-lifecycle
 * scan has no business running more often than decay actually moves. */
export const SOFT_ARCHIVE_LAST_RUN_KEY_PREFIX = "soft_archive:lastRunDate";
export const SOFT_ARCHIVE_INTERVAL_DAYS = 7;
/** Credited-outcome evidence floor for an archive decision. Under this, docImportance is
 * treated as the neutral 50 (never archived), matching the weighting nudge's neutral prior. */
export const SOFT_ARCHIVE_MIN_SAMPLES = USEFULNESS_MIN_SAMPLES;

export interface SoftArchiveRowDecision {
  vectorId: string;
  docType: string;
  ageDays: number;
  recency: number;
  importance: number;
  blended: number;
  decision: "archive" | "keep";
  keepReason:
    | "type-exempt"
    | "young"
    | "no-credited-evidence"
    | "positive-evidence"
    | "blend-above-floor"
    | "archived";
}

export interface SoftArchivePlan {
  userId: string;
  scanned: number;
  archiveIds: string[];
  archives: SoftArchiveRowDecision[];
  counts: Record<SoftArchiveRowDecision["keepReason"], number>;
}

export interface EvidenceForKind {
  samples: number;
  wins: number;
  losses: number;
}

/**
 * Archive-side blend. The retrieval-path blendedScore expects a live similarity score; the
 * offline sweep has none and must not synthesize one, so the credited outcome hit rate is the
 * only outcome-derived relevance evidence there is, and it stands in for the semantic term.
 * `docIdStatsFor` serves the same mode/horizon selection the retrieval nudge reads, applied
 * to the document's OWN credited rows, so an archived doc was graded exactly as retrieval
 * graded it.
 */
export function softArchiveComposite(importance: number, recency: number): number {
  return blendedScore(importance / 100, recency, importance);
}

function emptyCounts(): Record<SoftArchiveRowDecision["keepReason"], number> {
  return {
    "type-exempt": 0,
    young: 0,
    "no-credited-evidence": 0,
    "positive-evidence": 0,
    "blend-above-floor": 0,
    archived: 0
  };
}

/** Pure classification of one lifecycle row. Exported for tests. */
export function decideSoftArchiveRow(input: {
  vectorId: string;
  docType: string;
  firstSeenAt: string;
  nowMs: number;
  stat?: EvidenceForKind;
}): SoftArchiveRowDecision {
  const docType = String(input.docType ?? "").trim().toLowerCase();
  const keep = (keepReason: SoftArchiveRowDecision["keepReason"]): SoftArchiveRowDecision => ({
    vectorId: input.vectorId,
    docType,
    ageDays: 0,
    recency: 1,
    importance: 50,
    blended: 1,
    decision: "keep",
    keepReason
  });
  if (docType === "lesson" || docType === "coach-note") return keep("type-exempt");
  const ageDays = ageDaysSince(input.firstSeenAt, input.nowMs);
  if (ageDays < 90) return keep("young");
  const recency = recencyScore(ageDays, halfLifeDaysFor(docType));
  const stat = input.stat;
  const samples = stat && Number.isFinite(stat.samples) ? stat.samples : 0;
  if (!stat || samples < SOFT_ARCHIVE_MIN_SAMPLES) return keep("no-credited-evidence");
  if (recency >= 0.15) return keep("young");
  const importance = docImportance(stat);
  if (importance > 25) return keep("positive-evidence");
  const blended = softArchiveComposite(importance, recency);
  if (!shouldSoftArchive({ recency, blended, ageDays, docType })) return keep("blend-above-floor");
  return {
    vectorId: input.vectorId,
    docType,
    ageDays,
    recency,
    importance,
    blended,
    decision: "archive",
    keepReason: "archived"
  };
}

/** Read-only plan for one user. Never archives; callers apply the plan with archiveVectorDocs. */
export function planSoftArchiveForUser(
  userId: string,
  nowMs: number = Date.now()
): SoftArchivePlan {
  const rows = listLiveVectorDocLifecycle(userId);
  let perDocEvidence: Map<string, EvidenceForKind>;
  try {
    perDocEvidence = docIdStatsFor(userId, nowMs);
  } catch {
    // Fail open: no evidence map -> every doc is neutral-importance and nothing archives.
    perDocEvidence = new Map();
  }
  const counts = emptyCounts();
  const archives: SoftArchiveRowDecision[] = [];
  for (const row of rows) {
    const decision = decideSoftArchiveRow({
      vectorId: row.vectorId,
      docType: row.docType,
      firstSeenAt: row.firstSeenAt,
      nowMs,
      // PER-DOCUMENT evidence only (Kody 4701841567): a strong held document must never be
      // archived on its TYPE's aggregate weakness. A doc without its own credited rows reads
      // as no-credited-evidence, which can never pass the archive floors.
      stat: perDocEvidence.get(row.vectorId)
    });
    if (decision.decision === "archive") archives.push(decision);
    else counts[decision.keepReason] += 1;
  }
  return {
    userId,
    scanned: rows.length,
    archiveIds: archives.map((row) => row.vectorId),
    archives,
    counts
  };
}

export interface SoftArchiveRunResult {
  userId: string;
  scanned: number;
  archived: number;
  failureCount: number;
  firstError?: string;
}

const DAY_MS = 86_400_000;

/**
 * Scheduler entry point: once per SOFT_ARCHIVE_INTERVAL_DAYS per user (same self-guarded
 * watermark style as runRetrievalUsefulnessJoinIfDue). Archives the planned ids, audits the
 * receipt, and returns a count-shaped result. Never throws.
 */
export function runSoftArchiveIfDue(
  userId: string,
  now: number = Date.now()
): SoftArchiveRunResult | undefined {
  try {
    const key = `${SOFT_ARCHIVE_LAST_RUN_KEY_PREFIX}:${userId}`;
    const lastMs = Number(getInternalSetting<number>(key) ?? 0);
    if (lastMs > 0 && now - lastMs < SOFT_ARCHIVE_INTERVAL_DAYS * DAY_MS) return undefined;
    const plan = planSoftArchiveForUser(userId, now);
    let archived = 0;
    if (plan.archiveIds.length > 0) {
      const written = archiveVectorDocs(userId, plan.archiveIds, new Date(now).toISOString());
      archived = Number.isFinite(written) ? written : plan.archiveIds.length;
    }
    setInternalSetting(key, now);
    audit("soft_archive_sweep", {
      userId,
      scanned: plan.scanned,
      planned: plan.archiveIds.length,
      archived,
      keepCounts: plan.counts
    });
    return { userId, scanned: plan.scanned, archived, failureCount: 0 };
  } catch (err) {
    console.warn(
      `[soft-archive] sweep failed for ${userId}:`,
      err instanceof Error ? err.message : String(err)
    );
    return undefined;
  }
}