// audit-prune.ts — daily scheduler watermark for housekeeping (2026-10-15: no row deletes).
//
// Jay policy: audit_events, provider observability tables, portfolio_snapshots,
// task_journal, and other durable logs are kept forever.  Age-based DELETE paths
// were removed from this lane.  Transient embed_stage rows are cleared only after
// successful Pinecone delivery (`deleteStagedEmbeddings` in db-embed-stage.ts), not
// by calendar retention here.
//
// The scheduler still calls `runAuditPruneYieldingIfDue` once per day so the
// watermark and journal lane stay stable; counts in `AuditPruneResult` are always zero.

import { getInternalSetting, setInternalSetting } from "./db-settings";

/** @deprecated Retention buckets removed 2026-10-15; kept for importers/tests that reference kind lists. */
export const AUDIT_PRUNE_OBSERVABILITY_KINDS: readonly string[] = [
  "broker_protective_stop_skipped",
  "fill_reconciliation_pending_price",
  "rag_retrieval_stage_trace",
  "rag_retrieval_quality",
  "disclosure_rag_embed",
  "signal_snapshot",
  "candidates_considered",
  "usage_budget_status",
  "synthetic_stop_skipped_resting_exit",
  "socratic_outcome_recorded",
  "strategy_rag_prompt_consumption",
  "strategy_evidence_pack",
  "strategy_source_coverage",
  "r2_usage.check",
  "r2_usage.digest"
];

/** @deprecated All audit kinds are retained forever from the prune lane (2026-10-15). */
export const AUDIT_PRUNE_NEVER_PRUNED_KINDS: readonly string[] = [
  "proposal_rejected_by_red_team",
  "red_team_veto_override_requested",
  "red_team_veto_overridden",
  "socratic_override_applied",
  "llm_call_latency",
  // Past-decision analysis. The settings key reflection_summary:<account> keeps
  // only the latest blob. This audit row is the history of what was decided,
  // why, and the lesson. Do not age-delete it.
  "post_mortem_reflection"
];

/** @deprecated Age-based retention removed 2026-10-15. */
export const AUDIT_PRUNE_OBSERVABILITY_DAYS = 14;
/** @deprecated Age-based retention removed 2026-10-15. */
export const AUDIT_PRUNE_DEFAULT_DAYS = 90;
/** @deprecated Age-based retention removed 2026-10-15. */
export const AUDIT_PRUNE_PROVIDER_DAYS = 14;
export const AUDIT_PRUNE_BATCH_LIMIT = 50_000;
export const AUDIT_PRUNE_YIELD_STEP = 500;

const LAST_RUN_KEY = "auditprune:lastRunAt";
const INTERVAL_MS = 24 * 3600_000;

export interface AuditPruneResult {
  auditObservability: number;
  auditDefault: number;
  providerDispatch: number;
  providerOutbox: number;
  embedStageExpired: number;
  embedStageCapPruned: number;
  portfolioSnapshotsPruned: number;
}

function emptyAuditPruneResult(): AuditPruneResult {
  return {
    auditObservability: 0,
    auditDefault: 0,
    providerDispatch: 0,
    providerOutbox: 0,
    embedStageExpired: 0,
    embedStageCapPruned: 0,
    portfolioSnapshotsPruned: 0
  };
}

export function pruneAuditEvents(_now: Date = new Date(), _batchLimit: number = AUDIT_PRUNE_BATCH_LIMIT): AuditPruneResult {
  return emptyAuditPruneResult();
}

export async function pruneAuditEventsYielding(
  _now: Date = new Date(),
  _batchLimit: number = AUDIT_PRUNE_BATCH_LIMIT,
  _yieldFn?: () => Promise<void>
): Promise<AuditPruneResult> {
  return emptyAuditPruneResult();
}

export function isAuditPruneDue(now: number = Date.now()): boolean {
  const last = getInternalSetting<string>(LAST_RUN_KEY);
  if (!last) return true;
  const lastMs = Date.parse(last);
  if (!Number.isFinite(lastMs)) return true;
  return now - lastMs >= INTERVAL_MS;
}

export function runAuditPruneIfDue(now: number = Date.now()): AuditPruneResult | null {
  try {
    if (!isAuditPruneDue(now)) return null;
    setInternalSetting(LAST_RUN_KEY, new Date(now).toISOString());
    return pruneAuditEvents(new Date(now));
  } catch (err) {
    console.error("[audit-prune] prune error:", err);
    return null;
  }
}

export async function runAuditPruneYieldingIfDue(now: number = Date.now()): Promise<AuditPruneResult | null> {
  try {
    if (!isAuditPruneDue(now)) return null;
    setInternalSetting(LAST_RUN_KEY, new Date(now).toISOString());
    return await pruneAuditEventsYielding(new Date(now));
  } catch (err) {
    console.error("[audit-prune] prune error:", err);
    return null;
  }
}
