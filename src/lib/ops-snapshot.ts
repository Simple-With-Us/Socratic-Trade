import { autonomyAuthorityWord, autonomyStatusLabel } from "./autonomy-labels";
import { getInternalSetting } from "./db-settings";
import { describeAutonomyHaltCause, effectiveAutoResumeOnBoot, type AutonomyHaltCause } from "./autonomy-halt-cause";
import { getDb, getLastStrategyRunStartedAt, latestPeerPushReceipt, listConnectedAccounts, listUsers, peekPolicy, getServiceHealthSummaries, databasePath } from "./db";
import { isPeerPushHealth, type PeerPushHealth } from "./peer-push-receipt";
import { isHardStoppedHealthSummary } from "./db-health";
import { isIntentionalOffHealthService } from "./retired-direct-vendors";
import { getTaskJournalSummary } from "./db-task-journal";
import { userHasAnyLlmCredential } from "./db-api-keys";
import { resolveLlmEndpoint } from "./llm-provider";
import { computeAccountTradingLiveness } from "./trading-liveness";
import { loadLatestEnrichmentCoverageReport } from "./db-enrichment-coverage";
import { getLastEnrichmentCoverageReport } from "./enrichment-coverage";
import { opsMarketScanRecordSummary, type OpsMarketScanRecordSummary } from "./market-scan-freshness";
import { yieldEventLoop } from "./slow-sync-guard";
import { pineconeMonthToDateWriteUnits } from "./pinecone-monthly-pace";
import { pineconeTrialState } from "./pinecone-trial-window";
import { pineconeWuExhaustedUntil } from "./pinecone-wu-breaker";
import { isWorkingOrderState } from "./broker-held-orders";
import { isLiveOrderState } from "./broker-side";
import { buildOpsWorkingOrderDetails, type OpsWorkingOrderDetail } from "./order-role-context";
import type { EquityOrder, TradingPolicy } from "./types";
import { statSync, statfsSync, readdirSync } from "fs";
import { dirname, join } from "path";
import { summarizeRoicArchiveCoverage } from "./web-sources/roic-transcripts";
import { peekRoicArtifactFileCount, refreshRoicArtifactFileCount } from "./roic-archive-artifacts";
import { readCachedStorageHygieneReport, type StorageHygieneReport } from "./sqlite-storage-hygiene";

const LITESTREAM_AGE_CACHE_MS = 60_000;
let litestreamAgeCache: { ageSeconds: number | null; expiresAt: number } | undefined;

/** Bounded walk (max depth 3) with a 60s cache — full-tree readdir was minutes on prod. */
function getLitestreamLastSyncAge(dbPath: string): number | null {
  const now = Date.now();
  if (litestreamAgeCache && litestreamAgeCache.expiresAt > now) {
    return litestreamAgeCache.ageSeconds;
  }
  const litestreamDir = `${dbPath}-litestream`;
  try {
    let newestMs = 0;
    const visit = (dir: string, depth: number) => {
      if (depth > 3) return;
      const files = readdirSync(dir);
      for (const file of files) {
        const fullPath = join(dir, file);
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          visit(fullPath, depth + 1);
        } else if (stat.mtimeMs > newestMs) {
          newestMs = stat.mtimeMs;
        }
      }
    };
    visit(litestreamDir, 0);
    const ageSeconds = newestMs === 0 ? null : Math.round((now - newestMs) / 1000);
    litestreamAgeCache = { ageSeconds, expiresAt: now + LITESTREAM_AGE_CACHE_MS };
    return ageSeconds;
  } catch {
    litestreamAgeCache = { ageSeconds: null, expiresAt: now + LITESTREAM_AGE_CACHE_MS };
    return null;
  }
}

export function resetOpsSnapshotLitestreamAgeCacheForTests(): void {
  litestreamAgeCache = undefined;
}

const OPS_AUDIT_KINDS = new Set([
  "strategy_run",
  "recoverable_issue",
  "run_skipped_score_threshold",
  "run_skipped_market_closed",
  "policy_violation_drawdown",
  "policy_violation_vol_panic",
  "policy_violation_cap_exceeded",
  "autonomy_halted_on_boot",
  // Lane h5 review round: the broker auto-pause lifecycle and the owner's boot setting, so the
  // snapshot alone can tell a pause whose probes kept failing from one a restart or a person ended.
  "broker_placement_auto_halted",
  "broker_placement_auto_resumed",
  "broker_placement_pause_owner_override",
  "auto_resume_on_boot",
  "order_placement_uncertain",
  "proposal_skipped_negative_ev",
  "order_rejected_by_broker"
]);

export interface OpsAccountSnapshot {
  connectedAccountId: string;
  label: string;
  broker: string;
  accountNumber: string | null;
  isActive: boolean;
  systemState: string;
  strategyAuthority: string;
  /** Human run/authority words.  Autopilot only when decide + active. */
  runStateLabel: string;
  authorityLabel: string;
  llmModel: string | null;
  redTeamLlmModel: string | null;
  llmProvider: string | null;
  llmKeyConfigured: boolean;
  redTeamLlmProvider: string | null;
  redTeamLlmKeyConfigured: boolean;
  policyReadError: string | null;
  lastRunStartedAt: string | null;
  // Handoff 6b.7 (trading-liveness): only populated when systemState === "active" — an
  // account that isn't running autonomously has nothing to be "live" about. See
  // trading-liveness.ts for the stale/consecutive-failure thresholds (env-overridable).
  lastCompletedRunAt: string | null;
  lastCompletedRunAgeSeconds: number | null;
  consecutiveFailedRuns: number | null;
  tradingLivenessDegraded: boolean | null;
  /** Lane h5 (board 687a5fb4): why a `halted` account is halted and whether it lifts by itself —
   *  a broker auto-pause (resumes on the next healthy probe; carries the last failed probe), a
   *  restart with autoResumeOnBoot off, the drawdown breaker, an auto-pause whose resume marker is
   *  gone, or no record.  Only the first lifts by itself.  null for every other state. */
  haltCause: AutonomyHaltCause | null;
  /** Present when `?orders=1` — broker order-list breakdown for open-vs-history diagnosis. */
  orders?: OpsOrderListSummary | null;
  /** Present when `?ordersDetail=1` — per-working-order role classification (see
   *  `order-role-context.ts`'s `buildOpsWorkingOrderDetails`): why each resting order exists (a
   *  protective stop, a bracket leg, an app-tracked entry/exit, or external) instead of just a
   *  bare open-order count. No account numbers or raw broker/client order ids. */
  ordersDetail?: OpsWorkingOrderDetail[] | null;
}

export interface OpsOrderListSummary {
  listedCount: number;
  liveCount: number;
  workingCount: number;
  doneForDayCount: number;
  topStates: Array<{ state: string; count: number }>;
  error?: string;
}

export interface OpsStrategyRunRow {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  summary: string | null;
  connectedAccountId: string | null;
  accountLabel: string | null;
  placedCount: number;
  paperCount: number;
  blockedCount: number;
  proposedCount: number;
}

export interface OpsAuditRow {
  id: string;
  createdAt: string;
  kind: string;
  connectedAccountId: string | null;
  accountLabel: string | null;
  detail: string;
}

export interface OpsUserSnapshot {
  userId: string;
  llmAnyProviderConfigured: boolean;
  /** The user's "Auto-resume on boot" setting (or the AUTONOMY_RESUME_ON_BOOT=1 override).  When
   *  false, every restart or deploy halts this user's running accounts and ends any broker
   *  auto-pause, and nothing re-arms them by itself (lane h5). */
  autoResumeOnBoot: boolean;
  /** Latest persisted market scan metadata (no scan payload). */
  marketScan: OpsMarketScanRecordSummary;
  accounts: OpsAccountSnapshot[];
  recentRuns: OpsStrategyRunRow[];
  recentAudit: OpsAuditRow[];
}

export interface OpsSnapshotSectionTimingsMs {
  total: number;
  scheduler: number;
  users: number;
  dependencies: number;
  enrichmentCoverage: number;
  roicArchive: number;
  storage: number;
  taskJournal: number;
  pineconeIngest: number;
}

export interface OpsSnapshotBuildMeta {
  cacheHit: boolean;
  cacheTtlSeconds: number;
}

export interface OpsRoicArchiveCoverage {
  transcriptsWithContent: number;
  symbolsWithContent: number;
  symbolsAtDepth: number;
  symbolsPartial: number;
  artifactFiles: number;
  archiveDepth: number;
  cursorPhase: string | null;
  cursorRemaining: number;
  lastCompleteAt: string | null;
  lastAttemptAt: string | null;
  universeSize: number;
  universeUncovered: number;
  thinSymbols: Array<{ symbol: string; count: number }>;
}

export interface OpsSnapshot {
  asOf: string;
  /** Wall-clock section timings for the build that produced this snapshot (diagnostics only). */
  timingsMs?: OpsSnapshotSectionTimingsMs;
  buildMeta?: OpsSnapshotBuildMeta;
  schedulerLastTick: string | null;
  schedulerAgeSeconds: number | null;
  /** ROIC Individual local archive (SQLite + artifacts).  No vendor HTTP. */
  roicArchive?: OpsRoicArchiveCoverage | null;
  dependencies?: Record<string, { ok: boolean; reason?: string | null; lastFailure?: string | null }>;
  storage?: Record<string, any> | null;
  /** Last storage-hygiene pass (table sizes, dry-run or live reclaim, checkpoint).  Cached.
   *  The snapshot route does not walk dbstat. */
  storageHygiene?: StorageHygieneReport | null;
  /** Last CascadingEnrichmentProvider coverage summary (filled / source / missing), if any scan has run. */
  enrichmentCoverage?: {
    asOf: string;
    symbolCount: number;
    missingFields: string[];
    partialFieldCount: number;
    contributingSources: string[];
    topSources: Array<{ source: string; wins: number }>;
    providerFailureCount: number;
  } | null;
  /** Task brain: per-lane aggregates from the unified task_journal cron ledger (24h lookback). */
  taskJournal?: import("./db-task-journal").TaskJournalLaneSummary[];
  /** Latest Congress.Trade -> Socratic-Trade push receipt.  Null until the first inbound push. */
  congressInboundPush?: {
    pushId: string | null;
    health: PeerPushHealth;
    deliveredAt: string | null;
    consumedAt: string | null;
    receivedAt: string;
  } | null;
  /** App-recorded Pinecone write fuse + trial window.  Not Pinecone's bill. */
  pineconeIngest?: {
    monthToDateWriteUnits: number;
    wuExhaustedUntil: string | null;
    trial: {
      active: boolean;
      phase: string;
      mode: string;
      remainingUsd: number;
      spentUsd: number;
      remainingDays: number;
      effectiveDailyWriteUnits: number;
      effectiveTextsPerDay: number;
      localMtdUntrusted: boolean;
    };
  };
  users: OpsUserSnapshot[];
}

function accountLabelById(userId: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const account of listConnectedAccounts(userId)) {
    map.set(account.id, account.label || account.broker);
  }
  return map;
}

/** Pure breakdown of a broker order list — used by ops `?orders=1` and unit tests.
 *  `listedCount` is whatever getEquityOrders returned (Alpaca pages status:"all").
 *  `liveCount` uses isLiveOrderState; `workingCount` uses isWorkingOrderState (excludes
 *  terminal done_for_day). A large gap between listedCount and liveCount with high
 *  doneForDayCount is the historical "300+ pending" inflation pattern. */
export function summarizeBrokerOrderList(orders: EquityOrder[]): OpsOrderListSummary {
  const byState = new Map<string, number>();
  let liveCount = 0;
  let workingCount = 0;
  let doneForDayCount = 0;
  for (const order of orders) {
    const state = String(order.state ?? "").trim().toLowerCase() || "(empty)";
    byState.set(state, (byState.get(state) ?? 0) + 1);
    if (isLiveOrderState(state)) liveCount += 1;
    if (isWorkingOrderState(state)) workingCount += 1;
    if (state === "done_for_day") doneForDayCount += 1;
  }
  const topStates = [...byState.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 12)
    .map(([state, count]) => ({ state, count }));
  return {
    listedCount: orders.length,
    liveCount,
    workingCount,
    doneForDayCount,
    topStates
  };
}

function sanitizeAuditDetail(kind: string, payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const p = payload as Record<string, unknown>;
  if (kind === "strategy_run") {
    const status = typeof p.status === "string" ? p.status : "unknown";
    const summary = typeof p.summary === "string" ? p.summary : "";
    const proposals = Array.isArray(p.proposals) ? p.proposals.length : 0;
    return [status, summary, proposals > 0 ? `${proposals} proposal(s)` : ""].filter(Boolean).join(" · ");
  }
  if (kind === "recoverable_issue") {
    const message = typeof p.message === "string" ? p.message : "";
    const fallback = typeof p.fallback === "string" ? p.fallback : "";
    const operation = typeof p.operation === "string" ? p.operation : "";
    return [operation, message, fallback ? `fallback: ${fallback}` : ""].filter(Boolean).join(" · ");
  }
  const reason = typeof p.reason === "string" ? p.reason : "";
  const summary = typeof p.summary === "string" ? p.summary : "";
  const message = typeof p.message === "string" ? p.message : "";
  const error = typeof p.error === "string" ? p.error : "";
  const note = typeof p.note === "string" ? p.note : "";
  const semantic = reason || summary || message || error || note;
  if (!semantic) return JSON.stringify(p).slice(0, 500);
  // append key identifiers so failure rows link back to the proposal/order
  const ids: string[] = [];
  if (typeof p.refId === "string" && p.refId) ids.push(`refId=${p.refId}`);
  if (typeof p.proposalId === "string" && p.proposalId) ids.push(`proposalId=${p.proposalId}`);
  if (typeof p.symbol === "string" && p.symbol) ids.push(`symbol=${p.symbol}`);
  if (typeof p.runId === "string" && p.runId) ids.push(`runId=${p.runId}`);
  return ids.length > 0 ? `${semantic} (${ids.join(" ")})` : semantic;
}

type StrategyRunListRow = {
  id: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  summary: string | null;
  connected_account_id: string | null;
};

type ProposalCountRow = {
  run_id: string;
  placed_count: number;
  paper_count: number;
  blocked_count: number;
  proposed_count: number;
};

function proposalCountsByRunId(runIds: string[]): Map<string, ProposalCountRow> {
  const map = new Map<string, ProposalCountRow>();
  if (runIds.length === 0) return map;
  const placeholders = runIds.map(() => "?").join(", ");
  const rows = getDb()
    .prepare(
      `SELECT run_id,
        SUM(CASE WHEN status IN ('placed', 'filled') THEN 1 ELSE 0 END) AS placed_count,
        SUM(CASE WHEN status = 'paper' THEN 1 ELSE 0 END) AS paper_count,
        SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) AS blocked_count,
        SUM(CASE WHEN status = 'proposed' THEN 1 ELSE 0 END) AS proposed_count
       FROM trade_proposals
       WHERE run_id IN (${placeholders})
       GROUP BY run_id`
    )
    .all(...runIds) as ProposalCountRow[];
  for (const row of rows) {
    map.set(row.run_id, row);
  }
  return map;
}

function listOpsStrategyRuns(userId: string, limit: number, labels: Map<string, string>): OpsStrategyRunRow[] {
  const rows = getDb()
    .prepare(
      `SELECT id, started_at, finished_at, status, summary, connected_account_id
       FROM strategy_runs
       WHERE user_id = ?
       ORDER BY started_at DESC
       LIMIT ?`
    )
    .all(userId, limit) as StrategyRunListRow[];

  const counts = proposalCountsByRunId(rows.map((row) => row.id));
  const zeroCounts = { placed_count: 0, paper_count: 0, blocked_count: 0, proposed_count: 0 };

  return rows.map((row) => {
    const c = counts.get(row.id) ?? zeroCounts;
    return {
      id: row.id,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      status: row.status,
      summary: row.summary,
      connectedAccountId: row.connected_account_id,
      accountLabel: row.connected_account_id ? labels.get(row.connected_account_id) ?? null : null,
      placedCount: c.placed_count,
      paperCount: c.paper_count,
      blockedCount: c.blocked_count,
      proposedCount: c.proposed_count
    };
  });
}

function listOpsAudit(userId: string, limit: number, labels: Map<string, string>): OpsAuditRow[] {
  const placeholders = Array.from(OPS_AUDIT_KINDS).map(() => "?").join(", ");
  const rows = getDb()
    .prepare(
      `SELECT id, connected_account_id, created_at, kind, payload
       FROM audit_events
       WHERE user_id = ? AND kind IN (${placeholders})
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(userId, ...Array.from(OPS_AUDIT_KINDS), limit) as Array<{
    id: string;
    connected_account_id: string | null;
    created_at: string;
    kind: string;
    payload: string;
  }>;

  return rows.map((row) => {
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      payload = {};
    }
    return {
      id: row.id,
      createdAt: row.created_at,
      kind: row.kind,
      connectedAccountId: row.connected_account_id,
      accountLabel: row.connected_account_id ? labels.get(row.connected_account_id) ?? null : null,
      detail: sanitizeAuditDetail(row.kind, payload)
    };
  });
}

/** Diagnostics must never fail the snapshot: a cause lookup that throws reads as "unknown" (null). */
function safeHaltCause(userId: string, connectedAccountId: string, accountNumber: string | undefined, systemState: TradingPolicy["systemState"]): AutonomyHaltCause | null {
  try {
    return describeAutonomyHaltCause({ userId, connectedAccountId, accountNumber, systemState });
  } catch {
    return null;
  }
}

function safeAutoResumeOnBoot(userId: string): boolean {
  try {
    return effectiveAutoResumeOnBoot(userId);
  } catch {
    return process.env.AUTONOMY_RESUME_ON_BOOT === "1";
  }
}

export type BuildOpsSnapshotInput = { runsPerUser?: number; auditPerUser?: number };

function sectionMs(started: number): number {
  return Date.now() - started;
}

export async function buildOpsSnapshot(input: BuildOpsSnapshotInput = {}): Promise<OpsSnapshot> {
  const runsPerUser = input.runsPerUser ?? 20;
  const auditPerUser = input.auditPerUser ?? 40;
  const buildStarted = Date.now();
  const timings: OpsSnapshotSectionTimingsMs = {
    total: 0,
    scheduler: 0,
    users: 0,
    dependencies: 0,
    enrichmentCoverage: 0,
    roicArchive: 0,
    storage: 0,
    taskJournal: 0,
    pineconeIngest: 0
  };

  const schedulerStarted = Date.now();
  const lastTick = getInternalSetting<string>("scheduler:lastTick");
  const tickMs = lastTick ? Date.parse(lastTick) : Number.NaN;
  timings.scheduler = sectionMs(schedulerStarted);

  const usersStarted = Date.now();
  const users: OpsUserSnapshot[] = [];
  for (const userId of listUsers()) {
    const labels = accountLabelById(userId);
    const marketScan = opsMarketScanRecordSummary(userId);
    const accounts: OpsAccountSnapshot[] = listConnectedAccounts(userId).map((account) => {
      try {
        const policy = peekPolicy(userId, account.id);
        const greenEndpoint = resolveLlmEndpoint(policy, userId);
        // R16 (single-adversary consolidation): resolve Red with role:"red" — the SAME resolution the
        // strategy path uses — so these diagnostics can never report Red as "configured" (via the old
        // treat-Red-as-Green trick + its former default fallback) while the run path fails closed on a
        // blank/unkeyed Red model. An unset Red now resolves to model "" with no key.
        const redEndpoint = resolveLlmEndpoint(policy, userId, "https://api.openai.com/v1/chat/completions", "red");
        // Handoff 6b.7: only an actively-autonomous account has a meaningful trading-liveness
        // reading — a halted/close_only/liquidating account not completing runs is expected, not
        // degraded.
        const liveness =
          policy.systemState === "active"
            ? computeAccountTradingLiveness(userId, account.id, account.label || account.broker)
            : null;
        return {
          connectedAccountId: account.id,
          label: account.label || account.broker,
          broker: account.broker,
          accountNumber: account.accountNumber ?? null,
          isActive: account.isActive,
          systemState: policy.systemState,
          strategyAuthority: policy.strategyAuthority,
          runStateLabel: autonomyStatusLabel(policy.systemState, policy.strategyAuthority),
          authorityLabel: autonomyAuthorityWord(policy.strategyAuthority),
          llmModel: policy.llmModel ?? null,
          redTeamLlmModel: policy.redTeamLlmModel ?? null,
          llmProvider: greenEndpoint.provider,
          llmKeyConfigured: Boolean(greenEndpoint.key),
          // With NO model chosen the endpoint's provider/key are meaningless (resolution falls
          // through to the OpenAI branch on model "") — report them null/false so the snapshot says
          // "unconfigured", matching the strategy path's fail-closed treatment, instead of leaking
          // the fall-through provider's key state as if a Red reviewer were configured.
          redTeamLlmProvider: redEndpoint.model ? redEndpoint.provider : null,
          redTeamLlmKeyConfigured: Boolean(redEndpoint.model && redEndpoint.key),
          policyReadError: null,
          lastRunStartedAt: getLastStrategyRunStartedAt(userId, account.id),
          lastCompletedRunAt: liveness?.lastCompletedRunAt ?? null,
          lastCompletedRunAgeSeconds: liveness?.lastCompletedRunAgeSeconds ?? null,
          consecutiveFailedRuns: liveness?.consecutiveFailedRuns ?? null,
          tradingLivenessDegraded: liveness?.degraded ?? null,
          haltCause: safeHaltCause(userId, account.id, policy.accountNumber, policy.systemState)
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          connectedAccountId: account.id,
          label: account.label || account.broker,
          broker: account.broker,
          accountNumber: account.accountNumber ?? null,
          isActive: account.isActive,
          systemState: "unknown",
          strategyAuthority: "unknown",
          runStateLabel: "Stopped",
          authorityLabel: "Ask-first",
          llmModel: null,
          redTeamLlmModel: null,
          llmProvider: null,
          llmKeyConfigured: false,
          redTeamLlmProvider: null,
          redTeamLlmKeyConfigured: false,
          policyReadError: message,
          lastRunStartedAt: getLastStrategyRunStartedAt(userId, account.id),
          lastCompletedRunAt: null,
          lastCompletedRunAgeSeconds: null,
          consecutiveFailedRuns: null,
          tradingLivenessDegraded: null,
          haltCause: null
        };
      }
    });

    users.push({
      userId,
      llmAnyProviderConfigured: userHasAnyLlmCredential(userId),
      autoResumeOnBoot: safeAutoResumeOnBoot(userId),
      marketScan,
      accounts,
      recentRuns: listOpsStrategyRuns(userId, runsPerUser, labels),
      recentAudit: listOpsAudit(userId, auditPerUser, labels)
    });
    await yieldEventLoop();
  }
  timings.users = sectionMs(usersStarted);

  const dependenciesStarted = Date.now();
  const dependencies: Record<string, { ok: boolean; reason?: string | null; lastFailure?: string | null }> = {};
  try {
    const summaries = getServiceHealthSummaries();
    for (const summary of summaries) {
      const isGlobal = summary.keySource === "env" || summary.keySource === "none" || summary.keySource === null;
      if (!isGlobal) continue;
      if (summary.intentionalOff || isIntentionalOffHealthService(summary.service)) continue;
      dependencies[summary.service] = {
        // Hard 5-streak only.  Soft 429 / "no success this hour" is degraded, not down.
        ok: !isHardStoppedHealthSummary(summary),
        reason: summary.stoppedReason,
        lastFailure: summary.lastFailureError
      };
    }
  } catch {}
  timings.dependencies = sectionMs(dependenciesStarted);

  const pineconeStarted = Date.now();
  let pineconeIngest: OpsSnapshot["pineconeIngest"];
  try {
    const mtd = pineconeMonthToDateWriteUnits();
    const trial = pineconeTrialState(Date.now(), mtd);
    pineconeIngest = {
      monthToDateWriteUnits: mtd,
      wuExhaustedUntil: pineconeWuExhaustedUntil(),
      trial: {
        active: trial.active,
        phase: trial.phase,
        mode: trial.mode,
        remainingUsd: trial.remainingUsd,
        spentUsd: trial.spentUsd,
        remainingDays: trial.remainingDays,
        effectiveDailyWriteUnits: trial.effectiveDailyWriteUnits,
        effectiveTextsPerDay: trial.effectiveTextsPerDay,
        localMtdUntrusted: trial.localMtdUntrusted
      }
    };
  } catch {
    pineconeIngest = undefined;
  }
  timings.pineconeIngest = sectionMs(pineconeStarted);

  const storageStarted = Date.now();
  let storage: Record<string, unknown> | null = null;
  try {
    const dbPath = databasePath();
    const walPath = `${dbPath}-wal`;
    const dbDir = dirname(dbPath);

    let dbSizeBytes = 0;
    try {
      dbSizeBytes = statSync(dbPath).size;
    } catch {}

    let walSizeBytes = 0;
    try {
      walSizeBytes = statSync(walPath).size;
    } catch {}

    let freeBytes = 0;
    let totalBytes = 0;
    try {
      const stats = statfsSync(dbDir);
      freeBytes = stats.bavail * stats.bsize;
      totalBytes = stats.blocks * stats.bsize;
    } catch {}

    const litestreamAgeSeconds = getLitestreamLastSyncAge(dbPath);

    storage = {
      dbSizeBytes,
      walSizeBytes,
      freeBytes,
      totalBytes,
      litestreamAgeSeconds
    };
  } catch {}
  timings.storage = sectionMs(storageStarted);

  let storageHygiene: StorageHygieneReport | null = null;
  try {
    storageHygiene = readCachedStorageHygieneReport();
  } catch {
    storageHygiene = null;
  }

  const coverageStarted = Date.now();
  let enrichmentCoverage: OpsSnapshot["enrichmentCoverage"] = null;
  try {
    const report = getLastEnrichmentCoverageReport() ?? loadLatestEnrichmentCoverageReport();
    if (report) {
      enrichmentCoverage = {
        asOf: report.asOf,
        symbolCount: report.symbolCount,
        missingFields: report.missingFields,
        partialFieldCount: report.partialFields.length,
        contributingSources: report.contributingSources,
        topSources: Object.entries(report.sourceWinTotals)
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, 12)
          .map(([source, wins]) => ({ source, wins })),
        providerFailureCount: report.providerFailures.reduce((sum, row) => sum + row.failureCount, 0)
      };
    }
  } catch {
    enrichmentCoverage = null;
  }
  timings.enrichmentCoverage = sectionMs(coverageStarted);

  const roicStarted = Date.now();
  let roicArchive: OpsRoicArchiveCoverage | null = null;
  try {
    // The directory walk yields off this request.  The snapshot reports the last
    // finished count (0 until the first walk completes) instead of readdirSync.
    void refreshRoicArtifactFileCount();
    roicArchive = summarizeRoicArchiveCoverage({
      artifactFiles: peekRoicArtifactFileCount() ?? 0
    });
  } catch {
    roicArchive = null;
  }
  timings.roicArchive = sectionMs(roicStarted);

  const taskJournalStarted = Date.now();
  const taskJournal = getTaskJournalSummary(new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString(), {
    skipLastStatus: true
  });
  timings.taskJournal = sectionMs(taskJournalStarted);
  timings.total = sectionMs(buildStarted);

  let congressInboundPush: OpsSnapshot["congressInboundPush"] = null;
  try {
    const latest = latestPeerPushReceipt();
    if (latest && isPeerPushHealth(latest.health)) {
      congressInboundPush = {
        pushId: latest.pushId.startsWith("missing:") ? null : latest.pushId,
        health: latest.health,
        deliveredAt: latest.deliveredAt,
        consumedAt: latest.consumedAt,
        receivedAt: latest.receivedAt,
      };
    }
  } catch {
    congressInboundPush = null;
  }

  return {
    asOf: new Date().toISOString(),
    timingsMs: timings,
    congressInboundPush,
    schedulerLastTick: lastTick ?? null,
    schedulerAgeSeconds: Number.isFinite(tickMs) ? Math.round((Date.now() - tickMs) / 1000) : null,
    dependencies,
    storage,
    storageHygiene,
    enrichmentCoverage,
    roicArchive,
    taskJournal,
    pineconeIngest,
    users
  };
}

const OPS_SNAPSHOT_CACHE_TTL_MS = 45_000;

type OpsSnapshotCacheEntry = { expiresAt: number; value: OpsSnapshot };
const opsSnapshotCache = new Map<string, OpsSnapshotCacheEntry>();
const opsSnapshotInFlight = new Map<string, Promise<OpsSnapshot>>();

function opsSnapshotCacheKey(input: BuildOpsSnapshotInput): string {
  return `${input.runsPerUser ?? 20}\0${input.auditPerUser ?? 40}`;
}

/** Caller-owned snapshot.  `attachOpsOrderSummaries` assigns `account.orders` on the
 *  object it receives.  A shallow copy of the cache entry still shares `users[]`, so
 *  each return copies users and accounts before anyone can mutate them. */
function opsSnapshotForCaller(snapshot: OpsSnapshot, buildMeta: OpsSnapshotBuildMeta): OpsSnapshot {
  return {
    ...snapshot,
    buildMeta: { ...buildMeta },
    users: snapshot.users.map((user) => ({
      ...user,
      accounts: user.accounts.map((account) => ({ ...account }))
    }))
  };
}

/** Cached wrapper — 45s TTL, single-flight per (runs, audit) limits prod hammering. */
export async function getOrBuildOpsSnapshot(input: BuildOpsSnapshotInput = {}): Promise<OpsSnapshot> {
  const key = opsSnapshotCacheKey(input);
  const now = Date.now();
  const ttlSeconds = Math.round(OPS_SNAPSHOT_CACHE_TTL_MS / 1_000);
  const hit = opsSnapshotCache.get(key);
  if (hit && hit.expiresAt > now) {
    return opsSnapshotForCaller(hit.value, { cacheHit: true, cacheTtlSeconds: ttlSeconds });
  }

  let pending = opsSnapshotInFlight.get(key);
  if (!pending) {
    pending = (async () => {
      try {
        const value = await buildOpsSnapshot(input);
        const withMeta: OpsSnapshot = {
          ...value,
          buildMeta: { cacheHit: false, cacheTtlSeconds: ttlSeconds }
        };
        opsSnapshotCache.set(key, { expiresAt: Date.now() + OPS_SNAPSHOT_CACHE_TTL_MS, value: withMeta });
        return withMeta;
      } finally {
        opsSnapshotInFlight.delete(key);
      }
    })();
    opsSnapshotInFlight.set(key, pending);
  }

  const built = await pending;
  return opsSnapshotForCaller(built, built.buildMeta ?? { cacheHit: false, cacheTtlSeconds: ttlSeconds });
}

export function resetOpsSnapshotCacheForTests(): void {
  opsSnapshotCache.clear();
  opsSnapshotInFlight.clear();
  resetOpsSnapshotLitestreamAgeCacheForTests();
}

const DEFAULT_ORDERS_TIMEOUT_MS = 8_000;

/** Best-effort: attach per-account broker order-list summaries (for open-vs-history diagnosis).
 *  Never throws — failures land in `orders.error`. Opt-in from `/api/ops/snapshot?orders=1`.
 *  `includeDetail` (opt-in from `?ordersDetail=1`) additionally attaches `account.ordersDetail`
 *  — see `order-role-context.ts`'s `buildOpsWorkingOrderDetails`; counts in `account.orders` are
 *  unaffected either way. */
export async function attachOpsOrderSummaries(
  snapshot: OpsSnapshot,
  input: { timeoutMs?: number; includeDetail?: boolean } = {}
): Promise<OpsSnapshot> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_ORDERS_TIMEOUT_MS;
  const includeDetail = input.includeDetail ?? false;
  const { getBrokerGateway } = await import("./broker");

  for (const user of snapshot.users) {
    for (const account of user.accounts) {
      if (!account.accountNumber || account.policyReadError) {
        account.orders = null;
        if (includeDetail) account.ordersDetail = null;
        continue;
      }
      try {
        const policy = peekPolicy(user.userId, account.connectedAccountId);
        if (!policy.accountNumber) {
          account.orders = null;
          if (includeDetail) account.ordersDetail = null;
          continue;
        }
        const gateway = getBrokerGateway(policy, user.userId);
        const orders = await Promise.race([
          gateway.getEquityOrders(policy.accountNumber),
          new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error(`getEquityOrders timed out after ${timeoutMs}ms`)), timeoutMs);
          })
        ]);
        account.orders = summarizeBrokerOrderList(orders);
        if (includeDetail) {
          account.ordersDetail = buildOpsWorkingOrderDetails(orders, user.userId, policy.accountNumber);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        account.orders = {
          listedCount: 0,
          liveCount: 0,
          workingCount: 0,
          doneForDayCount: 0,
          topStates: [],
          error: message.slice(0, 400)
        };
        if (includeDetail) account.ordersDetail = null;
      }
    }
  }
  return snapshot;
}
