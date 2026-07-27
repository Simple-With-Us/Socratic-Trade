import { getInternalSetting } from "./db-settings";
import { getDb, getLastStrategyRunStartedAt, listConnectedAccounts, listUsers, peekPolicy, getServiceHealthSummaries, databasePath } from "./db";
import { userHasAnyLlmCredential } from "./db-api-keys";
import { resolveLlmEndpoint } from "./llm-provider";
import { computeAccountTradingLiveness } from "./trading-liveness";
import { getLastEnrichmentCoverageReport } from "./enrichment-coverage";
import { statSync, statfsSync, readdirSync } from "fs";
import { dirname, join } from "path";

function getLitestreamLastSyncAge(dbPath: string): number | null {
  const litestreamDir = `${dbPath}-litestream`;
  try {
    let newestMs = 0;
    const findNewest = (dir: string) => {
      const files = readdirSync(dir);
      for (const file of files) {
        const fullPath = join(dir, file);
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          findNewest(fullPath);
        } else {
          if (stat.mtimeMs > newestMs) {
            newestMs = stat.mtimeMs;
          }
        }
      }
    };
    findNewest(litestreamDir);
    if (newestMs === 0) return null;
    return Math.round((Date.now() - newestMs) / 1000);
  } catch {
    return null;
  }
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
  accounts: OpsAccountSnapshot[];
  recentRuns: OpsStrategyRunRow[];
  recentAudit: OpsAuditRow[];
}

export interface OpsSnapshot {
  asOf: string;
  schedulerLastTick: string | null;
  schedulerAgeSeconds: number | null;
  dependencies?: Record<string, { ok: boolean; reason?: string | null; lastFailure?: string | null }>;
  storage?: Record<string, any> | null;
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
  users: OpsUserSnapshot[];
}

function accountLabelById(userId: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const account of listConnectedAccounts(userId)) {
    map.set(account.id, account.label || account.broker);
  }
  return map;
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

function listOpsStrategyRuns(userId: string, limit: number, labels: Map<string, string>): OpsStrategyRunRow[] {
  type Raw = {
    id: string;
    started_at: string;
    finished_at: string | null;
    status: string;
    summary: string | null;
    connected_account_id: string | null;
    placed_count: number;
    paper_count: number;
    blocked_count: number;
    proposed_count: number;
  };
  const rows = getDb()
    .prepare(
      `SELECT
        sr.id,
        sr.started_at,
        sr.finished_at,
        sr.status,
        sr.summary,
        sr.connected_account_id,
        COUNT(CASE WHEN tp.status IN ('placed', 'filled') THEN 1 END) AS placed_count,
        COUNT(CASE WHEN tp.status = 'paper' THEN 1 END) AS paper_count,
        COUNT(CASE WHEN tp.status = 'blocked' THEN 1 END) AS blocked_count,
        COUNT(CASE WHEN tp.status = 'proposed' THEN 1 END) AS proposed_count
       FROM strategy_runs sr
       LEFT JOIN trade_proposals tp ON tp.run_id = sr.id
       WHERE sr.user_id = ?
       GROUP BY sr.id
       ORDER BY sr.started_at DESC
       LIMIT ?`
    )
    .all(userId, limit) as Raw[];

  return rows.map((row) => ({
    id: row.id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status,
    summary: row.summary,
    connectedAccountId: row.connected_account_id,
    accountLabel: row.connected_account_id ? labels.get(row.connected_account_id) ?? null : null,
    placedCount: row.placed_count,
    paperCount: row.paper_count,
    blockedCount: row.blocked_count,
    proposedCount: row.proposed_count
  }));
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

export function buildOpsSnapshot(input: { runsPerUser?: number; auditPerUser?: number } = {}): OpsSnapshot {
  const runsPerUser = input.runsPerUser ?? 20;
  const auditPerUser = input.auditPerUser ?? 40;
  const lastTick = getInternalSetting<string>("scheduler:lastTick");
  const tickMs = lastTick ? Date.parse(lastTick) : Number.NaN;

  const users: OpsUserSnapshot[] = [];
  for (const userId of listUsers()) {
    const labels = accountLabelById(userId);
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
          tradingLivenessDegraded: liveness?.degraded ?? null
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
          tradingLivenessDegraded: null
        };
      }
    });

    users.push({
      userId,
      llmAnyProviderConfigured: userHasAnyLlmCredential(userId),
      accounts,
      recentRuns: listOpsStrategyRuns(userId, runsPerUser, labels),
      recentAudit: listOpsAudit(userId, auditPerUser, labels)
    });
  }

  const dependencies: Record<string, { ok: boolean; reason?: string | null; lastFailure?: string | null }> = {};
  try {
    const summaries = getServiceHealthSummaries();
    for (const summary of summaries) {
      const isGlobal = summary.keySource === "env" || summary.keySource === "none" || summary.keySource === null;
      if (isGlobal) {
        dependencies[summary.service] = {
          ok: !summary.stoppedWorking,
          reason: summary.stoppedReason,
          lastFailure: summary.lastFailureError
        };
      }
    }
  } catch {}

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

  let enrichmentCoverage: OpsSnapshot["enrichmentCoverage"] = null;
  try {
    const report = getLastEnrichmentCoverageReport();
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

  return {
    asOf: new Date().toISOString(),
    schedulerLastTick: lastTick ?? null,
    schedulerAgeSeconds: Number.isFinite(tickMs) ? Math.round((Date.now() - tickMs) / 1000) : null,
    dependencies,
    storage,
    enrichmentCoverage,
    users
  };
}
