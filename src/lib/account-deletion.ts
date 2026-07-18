import crypto from "crypto";
import { getDb, reconcileStaleProviderDispatches } from "./db";
import { clearMcpOAuthForUser } from "./mcp-oauth";
import {
  OPERATION_LEASE_GROUPS,
  assertOperationLeaseOwnership,
  runWithOperationLease,
  throwIfOperationLeaseCancelled
} from "./operation-lease";
import {
  assertCurrentAccountIdentity,
  countActiveUserOperations,
  markAccountIdentityDeleted,
  markUserDeletionCompleted,
  markUserDeletionPrepared
} from "./user-write-fence";
import { userIdForEmail } from "./auth/identity";

export const ACCOUNT_DELETE_PHRASE = "DELETE MY ACCOUNT";
export const LOCAL_OPERATOR_DELETE_PHRASE = "DELETE LOCAL OPERATOR ACCOUNT";

// G9(b) audit (2026-07-01): cross-checked against every table's FULLY-MIGRATED runtime schema
// (several tables — strategy_runs, trade_proposals, strategy_profiles, portfolio_snapshots,
// fill_events, notification_events, audit_events, api_health_log — only gain user_id via an ALTER
// TABLE in db.ts migrate(), not their original CREATE TABLE, so a static grep of CREATE TABLE alone
// would miss them). Four tables were found user-scoped but MISSING from this list and have been
// added: api_health_log, mobile_commands, rag_usage, take_profit_trims. See
// test/account-deletion-coverage.test.ts, which queries sqlite_master + PRAGMA table_info at runtime
// so a future new user-scoped db-*.ts table can't silently escape deletion again — keep it green.
const DELETE_TABLES_BY_USER_ID = [
  "user_api_keys",
  "connected_accounts",
  "strategy_profiles",
  "account_strategy_state",
  "strategy_runs",
  "trade_proposals",
  "portfolio_snapshots",
  "fill_events",
  "notification_events",
  "user_settings",
  "skipped_candidate_counterfactuals",
  "counterfactual_learning_watermarks",
  "learning_mutations",
  "market_data_demands",
  "user_watchlist",
  "price_alerts",
  "notification_prefs",
  "chat_turns",
  "llm_usage",
  "user_memory",
  "learned_context_pending",
  "socratic_decisions",
  "socratic_framework_proposals",
  "synthetic_trailing_stops",
  "broker_protective_stops",
  "audit_events",
  // Added by the G9(b) coverage cross-check (2026-07-01) — previously missing:
  "api_health_log",
  "mobile_commands",
  "rag_usage",
  "take_profit_trims",
  // Added 2026-07-05: due_jobs (src/lib/db-jobs.ts) is user-scoped (nullable user_id — system-wide
  // jobs have none, matching the generic loop's `WHERE user_id = ?` no-op for those rows).
  "due_jobs",
  // Added 2026-07-10: position_stop_plans (src/lib/db-api-keys.ts) — per-position stop-plan rows,
  // user-scoped like take_profit_trims.
  "position_stop_plans",
  // Added 2026-07-11: strategy_tuning_reviews (src/lib/db-tuning-reviews.ts) — persisted AI
  // strategy-review results, user-scoped.
  "strategy_tuning_reviews",
  "order_replacements",
  // Added 2026-07-14: managed-vector receipts and durable provider dispatch/usage telemetry are
  // explicitly user-scoped. Delete the usage outbox before its attempt row so this remains safe if
  // a future migration adds the natural foreign key between them.
  "provider_usage_outbox",
  "provider_dispatch_attempts",
  "vector_ingest_commits",
  // Licensed transcript derivatives and exact private-vector provider receipts are user-scoped.
  // They must survive until provider-first vector erasure succeeds, then leave in the same local
  // deletion transaction as the decision/chat rows they describe.
  "fmp_transcript_derived_provider_work",
  "fmp_transcript_derived_artifacts",
  // Added 2026-07-15: retrieval-usefulness aggregates + per-decision credit ledger
  // (src/lib/db-retrieval-usefulness.ts) — user-scoped learning telemetry.
  "retrieval_usefulness_stats",
  "retrieval_usefulness_credited",
  // Added 2026-07-16: pending_bracket_teardowns (src/lib/db.ts) — queued bracket sibling-leg
  // teardowns are user-scoped like position_stop_plans.
  "pending_bracket_teardowns",
  // Added 2026-07-16: position_stop_plan_open_brackets (src/lib/db.ts) — tracked, not-yet-torn-down
  // bracket orders are user-scoped like pending_bracket_teardowns.
  "position_stop_plan_open_brackets",
  // Added 2026-07-18: option_alert_reservations (src/lib/db.ts) — atomic option-alert dedupe claims
  // are user-scoped (user_id column) like notification_events.
  "option_alert_reservations"
] as const;

type DeleteTable = (typeof DELETE_TABLES_BY_USER_ID)[number];

/** Test-only read view of the deletion table list (avoids re-exporting it as public API surface). */
export const DELETE_TABLES_BY_USER_ID_FOR_TEST: readonly string[] = DELETE_TABLES_BY_USER_ID;

export interface AccountDeletionConnectedAccountPreview {
  id: string;
  label: string;
  broker: string;
  environment: string;
  accountNumber?: string;
  isActive: boolean;
}

export interface AccountDeletionBlockers {
  runningStrategyRuns: number;
  placingProposals: number;
  pendingReconciliationFills: number;
  /**
   * In-flight mobile commands (status 'queued'/'running'). `confirmAndDeleteAccount` sweeps the
   * `mobile_commands` table, so a command already claimed by a worker (status 'running') could keep
   * mutating policy/watchlists — or try to finish against a row that was just deleted — if we deleted
   * mid-flight. Counted as a blocker so deletion waits until the command drains, matching the
   * running-strategy-run / placing-proposal / pending-fill blockers.
   */
  activeMobileCommands: number;
  /**
   * Non-terminal order-replacement state-machine rows. If deletion proceeds while a
   * replacement is in-flight (order canceled but replacement not yet placed, or replacement
   * submitted but not confirmed), the row is deleted and the maintenance pump can no longer
   * complete the replacement — the broker order would be canceled without the intended
   * market exit. Counted as a blocker so deletion waits for the row to reach a terminal
   * status first.
   */
  activeReplacements: number;
  /** Provider calls already reserved/dispatched before the prepared-deletion admission fence. */
  activeProviderDispatches: number;
  /** Chat/learning/other claimed user writes admitted before the prepared epoch fence. */
  activeUserOperations: number;
}

export interface AccountDeletionPreview {
  userId: string;
  email?: string;
  isLocalOperatorAccount: boolean;
  prepared: boolean;
  requestedAt?: string;
  connectedAccounts: AccountDeletionConnectedAccountPreview[];
  blockers: AccountDeletionBlockers;
  counts: Record<string, number>;
}

export interface AccountDeletionConfirmation {
  typedEmail?: unknown;
  typedPhrase?: unknown;
  localOperatorPhrase?: unknown;
  deleteAppData?: unknown;
  deleteBrokerConnections?: unknown;
  understandBrokerPositionsRemain?: unknown;
  understandProviderRevocation?: unknown;
  understandCanSignInAgain?: unknown;
  confirmLocalOperator?: unknown;
}

function normalizeEmail(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function countTable(table: DeleteTable, userId: string): number {
  if (table === "vector_ingest_commits") {
    const selector = vectorCommitDeletionSelector(userId);
    const row = getDb().prepare(`SELECT COUNT(*) AS count FROM vector_ingest_commits WHERE ${selector.where}`)
      .get(...selector.bindings) as { count: number };
    return row.count;
  }
  const row = getDb().prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE user_id = ?`).get(userId) as { count: number };
  return row.count;
}

function privateVectorTenantScopes(userId: string): [string, string] {
  return [
    `private:${crypto.createHash("sha256").update(userId, "utf8").digest("hex")}`,
    `private:${userId}`
  ];
}

function vectorCommitDeletionSelector(userId: string): { where: string; bindings: string[] } {
  if (userId !== "local") return { where: "user_id = ?", bindings: [userId] };
  const scopes = privateVectorTenantScopes(userId);
  return {
    where: "user_id = ? AND tenant_scope IN (?, ?)",
    bindings: [userId, ...scopes]
  };
}

function countLearnedContext(userId: string): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS count FROM learned_context WHERE user_id = ? OR contributor_user_id = ?")
    .get(userId, userId) as { count: number };
  return row.count;
}

function countUserSettingsRows(userId: string): number {
  const row = getDb().prepare(`
    SELECT COUNT(*) AS count
    FROM settings
    WHERE account_setting_matches_subject(key, account_subject_token(?)) = 1
  `).get(userId) as { count: number };
  return row.count;
}

function latestPreparedRequest(userId: string): { id: string; requested_at: string } | undefined {
  return getDb()
    .prepare(
      `SELECT id, requested_at
       FROM account_deletion_requests
       WHERE user_id = ? AND status = 'prepared'
       ORDER BY requested_at DESC, rowid DESC
       LIMIT 1`
    )
    .get(userId) as { id: string; requested_at: string } | undefined;
}

export function getAccountDeletionBlockers(userId: string): AccountDeletionBlockers {
  const db = getDb();
  // Release only proven-undispatched reservations and classify expired dispatched ownership as
  // unknown. Unknown stale owners remain blockers until an operator explicitly attests the prior
  // process is gone; elapsed time alone is not authority to erase external provider state.
  reconcileStaleProviderDispatches(new Date().toISOString(), 5 * 60_000, userId);
  const runningStrategyRuns = db
    .prepare("SELECT COUNT(*) AS count FROM strategy_runs WHERE user_id = ? AND status = 'running'")
    .get(userId) as { count: number };
  const placingProposals = db
    .prepare("SELECT COUNT(*) AS count FROM trade_proposals WHERE user_id = ? AND status = 'placing'")
    .get(userId) as { count: number };
  const pendingReconciliationFills = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM fill_events
       WHERE user_id = ?
         AND status = 'pending_reconciliation'
         AND broker_order_id IS NOT NULL
         AND (source = 'live' OR execution_mode IN ('broker/paper', 'broker/live'))`
    )
    .get(userId) as { count: number };
  const activeMobileCommands = db
    .prepare("SELECT COUNT(*) AS count FROM mobile_commands WHERE user_id = ? AND status IN ('queued','running')")
    .get(userId) as { count: number };
  const activeReplacements = db
    .prepare("SELECT COUNT(*) AS count FROM order_replacements WHERE user_id = ? AND status IN ('cancel_requested', 'cancel_confirmed', 'replacement_claiming', 'replacement_submitted')")
    .get(userId) as { count: number };
  const activeProviderDispatches = db
    .prepare(`
      SELECT COUNT(*) AS count
      FROM provider_dispatch_attempts
      WHERE user_id = ? AND (
        status IN ('reserved','dispatched') OR
        (status = 'unknown' AND outcome_code = 'stale-owner-unresolved')
      )
    `)
    .get(userId) as { count: number };
  const activeUserOperations = countActiveUserOperations(userId);
  return {
    runningStrategyRuns: runningStrategyRuns.count,
    placingProposals: placingProposals.count,
    pendingReconciliationFills: pendingReconciliationFills.count,
    activeMobileCommands: activeMobileCommands.count,
    activeReplacements: activeReplacements.count,
    activeProviderDispatches: activeProviderDispatches.count,
    activeUserOperations
  };
}

export function getAccountDeletionCounts(userId: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of DELETE_TABLES_BY_USER_ID) counts[table] = countTable(table, userId);
  counts.learned_context = countLearnedContext(userId);
  counts.settings = countUserSettingsRows(userId);
  return counts;
}

export function getAccountDeletionPreview(input: { userId: string; email?: string }): AccountDeletionPreview {
  const db = getDb();
  const prepared = latestPreparedRequest(input.userId);
  const connectedAccounts = db
    .prepare(
      `SELECT id, label, broker, environment, account_number, is_active
       FROM connected_accounts
       WHERE user_id = ?
       ORDER BY is_active DESC, created_at ASC`
    )
    .all(input.userId) as Array<{
    id: string;
    label: string;
    broker: string;
    environment: string;
    account_number: string | null;
    is_active: number;
  }>;
  return {
    userId: input.userId,
    ...(input.email ? { email: normalizeEmail(input.email) } : {}),
    isLocalOperatorAccount: input.userId === "local",
    prepared: Boolean(prepared),
    ...(prepared ? { requestedAt: prepared.requested_at } : {}),
    connectedAccounts: connectedAccounts.map((row) => ({
      id: row.id,
      label: row.label,
      broker: row.broker,
      environment: row.environment,
      ...(row.account_number ? { accountNumber: row.account_number } : {}),
      isActive: row.is_active === 1
    })),
    blockers: getAccountDeletionBlockers(input.userId),
    counts: getAccountDeletionCounts(input.userId)
  };
}

export function prepareAccountDeletion(input: { userId: string; email?: string }): AccountDeletionPreview {
  if (input.email) assertCurrentAccountIdentity(userIdForEmail(input.email), input.userId);
  const db = getDb();
  const now = new Date().toISOString();
  const requestId = crypto.randomUUID();
  db.transaction(() => {
    // Halt every account, not only whichever account is active in the UI. Do this before installing
    // the write fence but in the same IMMEDIATE transaction: after commit no scheduler can observe
    // an autonomous sibling account without also observing the prepared tombstone.
    const states = db.prepare(`
      SELECT connected_account_id, policy
      FROM account_strategy_state
      WHERE user_id = ?
    `).all(input.userId) as Array<{ connected_account_id: string; policy: string }>;
    const haltState = db.prepare(`
      UPDATE account_strategy_state
      SET policy = ?, system_state = 'halted', updated_at = ?
      WHERE user_id = ? AND connected_account_id = ?
    `);
    for (const state of states) {
      const policy = JSON.parse(state.policy) as Record<string, unknown>;
      haltState.run(JSON.stringify({ ...policy, systemState: "halted" }), now, input.userId, state.connected_account_id);
    }
    db.prepare("UPDATE account_deletion_requests SET status = 'cancelled' WHERE user_id = ? AND status = 'prepared'").run(input.userId);
    db.prepare(
      `INSERT INTO account_deletion_requests (id, user_id, email, requested_at, status)
       VALUES (?, ?, ?, ?, 'prepared')`
    ).run(requestId, input.userId, input.email ? normalizeEmail(input.email) : null, now);
    markUserDeletionPrepared(db, input.userId, requestId, now);
  }).immediate();
  return getAccountDeletionPreview(input);
}

function requireBoolean(value: unknown, label: string): void {
  if (value !== true) throw new Error(`${label} must be acknowledged.`);
}

function subjectHash(userId: string, email?: string): string {
  const secret = process.env.ACCOUNT_DELETION_AUDIT_SALT || process.env.ENCRYPTION_KEY || "socratic-trade-account-deletion";
  return crypto.createHmac("sha256", secret).update(`${userId}:${normalizeEmail(email)}`).digest("hex");
}

export async function confirmAndDeleteAccount(input: {
  userId: string;
  email?: string;
  body: AccountDeletionConfirmation;
}): Promise<{ ok: true; counts: Record<string, number>; logoutUrl: string }> {
  const email = normalizeEmail(input.email);
  if (!email) throw new Error("A verified sign-in email is required before account deletion.");
  assertCurrentAccountIdentity(userIdForEmail(email), input.userId);
  const preparedRequest = latestPreparedRequest(input.userId);
  if (!preparedRequest) throw new Error("Prepare account deletion first.");
  if (normalizeEmail(String(input.body.typedEmail ?? "")) !== email) throw new Error("Typed email does not match the signed-in account.");
  if (String(input.body.typedPhrase ?? "").trim() !== ACCOUNT_DELETE_PHRASE) throw new Error(`Type ${ACCOUNT_DELETE_PHRASE} to confirm.`);
  requireBoolean(input.body.deleteAppData, "Deleting app data");
  requireBoolean(input.body.deleteBrokerConnections, "Deleting broker/API connections from this app");
  requireBoolean(input.body.understandBrokerPositionsRemain, "Broker positions and open orders remaining outside this app");
  requireBoolean(input.body.understandProviderRevocation, "Provider access revocation");
  requireBoolean(input.body.understandCanSignInAgain, "Fresh sign-in after deletion");

  if (input.userId === "local") {
    requireBoolean(input.body.confirmLocalOperator, "Local operator account deletion");
    if (String(input.body.localOperatorPhrase ?? "").trim() !== LOCAL_OPERATOR_DELETE_PHRASE) {
      throw new Error(`Type ${LOCAL_OPERATOR_DELETE_PHRASE} to delete the local operator account.`);
    }
  }

  const blockers = getAccountDeletionBlockers(input.userId);
  const blockerCount =
    blockers.runningStrategyRuns + blockers.placingProposals + blockers.pendingReconciliationFills +
    blockers.activeMobileCommands + blockers.activeReplacements + blockers.activeProviderDispatches +
    blockers.activeUserOperations;
  if (blockerCount > 0) {
    throw Object.assign(new Error("Account deletion is blocked by in-flight trading activity."), { status: 409, blockers });
  }

  const guarded = await runWithOperationLease(
    { group: OPERATION_LEASE_GROUPS.RAG_REINDEX, operation: `account-private-vector-purge:${input.userId}` },
    async (claim, signal) => {
      const assertLease = () => {
        throwIfOperationLeaseCancelled(signal);
        assertOperationLeaseOwnership(claim);
      };
      assertLease();
      const { purgePrivateVectorRecordsForUser } = await import("./vector-db");
      const providerPurge = await purgePrivateVectorRecordsForUser({
        userId: input.userId,
        accountDeletionRequestId: preparedRequest.id,
        maxScanned: 1_000_000,
        leaseGuard: { signal, assertOwnership: assertLease }
      });
      assertLease();

      // Re-check every non-RAG blocker after the provider await. The durable prepared request
      // prevents new provider reservations, and this lease prevents a concurrent vector writer.
      const refreshedBlockers = getAccountDeletionBlockers(input.userId);
      const refreshedCount =
        refreshedBlockers.runningStrategyRuns + refreshedBlockers.placingProposals +
        refreshedBlockers.pendingReconciliationFills + refreshedBlockers.activeMobileCommands +
        refreshedBlockers.activeReplacements + refreshedBlockers.activeProviderDispatches +
        refreshedBlockers.activeUserOperations;
      if (refreshedCount > 0) {
        throw Object.assign(new Error("Account deletion is blocked by in-flight activity after provider purge."), {
          status: 409,
          blockers: refreshedBlockers
        });
      }

      // Revoke app-held OAuth material while the durable prepared request and write fence still
      // exist. A crash/throw leaves a retry handle instead of silently stranding live credentials.
      clearMcpOAuthForUser(input.userId);
      assertLease();

      const db = getDb();
      const counts = getAccountDeletionCounts(input.userId);
      const completedAt = new Date().toISOString();
      const schemaVersion = Number(db.pragma("user_version", { simple: true })) || 0;
      const vectorCommitSelector = vectorCommitDeletionSelector(input.userId);
      // A prior attempt may have deleted provider vectors and then crashed before this transaction.
      // In that case provider inventory correctly returns no metadata on retry, so recover every
      // locally durable private content hash before deleting its occurrence receipts.
      const localPrivateContentHashes = db.prepare(`
        SELECT DISTINCT content_hash
        FROM chunk_occurrences
        WHERE commit_id IN (
          SELECT id FROM vector_ingest_commits WHERE ${vectorCommitSelector.where}
        )
      `).all(...vectorCommitSelector.bindings) as Array<{ content_hash: string }>;
      const contentHashesToDelete = new Set([
        ...providerPurge.contentHashes,
        ...localPrivateContentHashes.map((row) => row.content_hash)
      ]);
      assertLease();

      db.transaction(() => {
        assertLease();
        // Hold the SQLite writer lock while checking one final time. Operational drainers may move
        // already-admitted rows while deletion is prepared, so an out-of-transaction check leaves a
        // query-to-delete race around irreversible broker operations (notably replacement_claiming).
        const finalBlockers = getAccountDeletionBlockers(input.userId);
        const finalBlockerCount =
          finalBlockers.runningStrategyRuns + finalBlockers.placingProposals +
          finalBlockers.pendingReconciliationFills + finalBlockers.activeMobileCommands +
          finalBlockers.activeReplacements + finalBlockers.activeProviderDispatches +
          finalBlockers.activeUserOperations;
        if (finalBlockerCount > 0) {
          throw Object.assign(new Error("Account deletion is blocked by in-flight activity at commit."), {
            status: 409,
            blockers: finalBlockers
          });
        }
        db.prepare(
          `INSERT INTO account_deletion_audit (id, subject_hash, requested_at, completed_at, counts_json, schema_version)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(
          crypto.randomUUID(),
          subjectHash(input.userId, email),
          preparedRequest.requested_at,
          completedAt,
          JSON.stringify({ ...counts, provider_vectors: providerPurge.deleted }),
          schemaVersion
        );

        // Public/shared corpus is application data, not personal account data. Delete only exact
        // private generations; otherwise deleting the local operator would orphan every shared SEC
        // vector in Pinecone and break relational receipt validation for later users.
        const privateCommitWhere = `SELECT id FROM vector_ingest_commits WHERE ${vectorCommitSelector.where}`;
        for (const table of [
          "vector_document_heads",
          "vector_reconcile_observations",
          "vector_document_versions",
          "chunk_occurrences"
        ]) {
          db.prepare(`DELETE FROM ${table} WHERE commit_id IN (${privateCommitWhere})`)
            .run(...vectorCommitSelector.bindings);
        }
        for (const contentHash of contentHashesToDelete) {
          // Content hashes are globally deduplicated. A private and shared occurrence can point at
          // the same row, so remove source text only after the subject's occurrences are gone and
          // no preserved occurrence still references it.
          db.prepare(`
            DELETE FROM document_chunks
            WHERE content_hash = ?
              AND NOT EXISTS (
                SELECT 1 FROM chunk_occurrences WHERE chunk_occurrences.content_hash = document_chunks.content_hash
              )
          `).run(contentHash);
        }

        for (const table of DELETE_TABLES_BY_USER_ID) {
          if (table === "vector_ingest_commits") continue;
          db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(input.userId);
        }
        db.prepare(`DELETE FROM vector_ingest_commits WHERE ${vectorCommitSelector.where}`)
          .run(...vectorCommitSelector.bindings);
        for (const tenantScope of privateVectorTenantScopes(input.userId)) {
          db.prepare("DELETE FROM vector_private_namespace_manifests WHERE tenant_scope = ?").run(tenantScope);
        }
        db.prepare("DELETE FROM learned_context WHERE user_id = ? OR contributor_user_id = ?").run(input.userId, input.userId);
        // Sweep every account-owned row in the global settings table using the same canonical
        // ownership matcher that enforces the prepared/completed write fence.
        db.prepare(`
          DELETE FROM settings
          WHERE account_setting_matches_subject(key, account_subject_token(?)) = 1
        `).run(input.userId);
        markUserDeletionCompleted(db, input.userId, preparedRequest.id, completedAt);
        markAccountIdentityDeleted(db, userIdForEmail(email), input.userId, completedAt);
        db.prepare("DELETE FROM account_deletion_requests WHERE user_id = ?").run(input.userId);
      }).immediate();
      assertLease();
      return { counts };
    }
  );
  if (!guarded.acquired) {
    throw Object.assign(new Error("Account deletion is waiting for active RAG work to finish."), {
      status: 409,
      operationLease: guarded.busy
    });
  }
  return { ok: true, counts: guarded.value.counts, logoutUrl: "/logout" };
}
