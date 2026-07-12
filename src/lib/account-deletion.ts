import crypto from "crypto";
import { getDb, getPolicy, releaseStrategyLock, setPolicy } from "./db";
import { clearMcpOAuthForUser } from "./mcp-oauth";

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
  "due_jobs"
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

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function countTable(table: DeleteTable, userId: string): number {
  const row = getDb().prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE user_id = ?`).get(userId) as { count: number };
  return row.count;
}

function countLearnedContext(userId: string): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS count FROM learned_context WHERE user_id = ? OR contributor_user_id = ?")
    .get(userId, userId) as { count: number };
  return row.count;
}

function countUserSettingsRows(userId: string): number {
  const exactKeys = [`strategy_run_lock:${userId}`, `robinhood_mcp_oauth_token:${userId}`, `llm_budget_reservation:${userId}`];
  const exactCount = getDb()
    .prepare(`SELECT COUNT(*) AS count FROM settings WHERE key IN (${exactKeys.map(() => "?").join(",")})`)
    .get(...exactKeys) as { count: number };
  const stateCount = getDb()
    .prepare("SELECT COUNT(*) AS count FROM settings WHERE key LIKE ? ESCAPE '\\'")
    .get(`robinhood_mcp_oauth_state:${escapeLike(userId)}:%`) as { count: number };
  return exactCount.count + stateCount.count;
}

function latestPreparedRequest(userId: string): { id: string; requested_at: string } | undefined {
  return getDb()
    .prepare(
      `SELECT id, requested_at
       FROM account_deletion_requests
       WHERE user_id = ? AND status = 'prepared'
       ORDER BY requested_at DESC
       LIMIT 1`
    )
    .get(userId) as { id: string; requested_at: string } | undefined;
}

export function getAccountDeletionBlockers(userId: string): AccountDeletionBlockers {
  const db = getDb();
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
  return {
    runningStrategyRuns: runningStrategyRuns.count,
    placingProposals: placingProposals.count,
    pendingReconciliationFills: pendingReconciliationFills.count,
    activeMobileCommands: activeMobileCommands.count
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
  const db = getDb();
  const now = new Date().toISOString();
  const policy = getPolicy(input.userId);
  if (policy.systemState !== "halted") {
    setPolicy({ ...policy, systemState: "halted" }, input.userId);
  }
  releaseStrategyLock(input.userId);
  db.transaction(() => {
    db.prepare("UPDATE account_deletion_requests SET status = 'cancelled' WHERE user_id = ? AND status = 'prepared'").run(input.userId);
    db.prepare(
      `INSERT INTO account_deletion_requests (id, user_id, email, requested_at, status)
       VALUES (?, ?, ?, ?, 'prepared')`
    ).run(crypto.randomUUID(), input.userId, input.email ? normalizeEmail(input.email) : null, now);
  })();
  return getAccountDeletionPreview(input);
}

function requireBoolean(value: unknown, label: string): void {
  if (value !== true) throw new Error(`${label} must be acknowledged.`);
}

function subjectHash(userId: string, email?: string): string {
  const secret = process.env.ACCOUNT_DELETION_AUDIT_SALT || process.env.ENCRYPTION_KEY || "socratic-trade-account-deletion";
  return crypto.createHmac("sha256", secret).update(`${userId}:${normalizeEmail(email)}`).digest("hex");
}

export function confirmAndDeleteAccount(input: {
  userId: string;
  email?: string;
  body: AccountDeletionConfirmation;
}): { ok: true; counts: Record<string, number>; logoutUrl: string } {
  const email = normalizeEmail(input.email);
  if (!email) throw new Error("A verified sign-in email is required before account deletion.");
  if (!latestPreparedRequest(input.userId)) throw new Error("Prepare account deletion first.");
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
    blockers.runningStrategyRuns + blockers.placingProposals + blockers.pendingReconciliationFills + blockers.activeMobileCommands;
  if (blockerCount > 0) {
    throw Object.assign(new Error("Account deletion is blocked by in-flight trading activity."), { status: 409, blockers });
  }

  const db = getDb();
  const counts = getAccountDeletionCounts(input.userId);
  const completedAt = new Date().toISOString();
  const schemaVersion = Number(db.pragma("user_version", { simple: true })) || 0;

  db.transaction(() => {
    db.prepare(
      `INSERT INTO account_deletion_audit (id, subject_hash, requested_at, completed_at, counts_json, schema_version)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      crypto.randomUUID(),
      subjectHash(input.userId, email),
      latestPreparedRequest(input.userId)?.requested_at ?? completedAt,
      completedAt,
      JSON.stringify(counts),
      schemaVersion
    );

    for (const table of DELETE_TABLES_BY_USER_ID) {
      db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(input.userId);
    }
    db.prepare("DELETE FROM learned_context WHERE user_id = ? OR contributor_user_id = ?").run(input.userId, input.userId);
    // Remove the user's run lock AND every per-account run lock (strategy_run_lock:<user>:<account>).
    db.prepare("DELETE FROM settings WHERE key = ? OR key LIKE ?").run(`strategy_run_lock:${input.userId}`, `strategy_run_lock:${input.userId}:%`);
    // Remove the user's LLM budget reservation row (llm_budget_reservation:<user>).
    db.prepare("DELETE FROM settings WHERE key = ?").run(`llm_budget_reservation:${input.userId}`);
    db.prepare("DELETE FROM account_deletion_requests WHERE user_id = ?").run(input.userId);
  })();

  clearMcpOAuthForUser(input.userId);
  return { ok: true, counts, logoutUrl: "/logout" };
}
