// db-rag-ingest.ts - durable, stage-aware SEC/RAG ingestion state.
//
// This module deliberately does not fetch SEC data or call Voyage/Pinecone. It is the local
// correctness boundary a separately gated worker can use: deterministic replay keys, atomic
// claims, fenced lease heartbeats, legal checkpoint transitions, bounded retries/dead letters,
// quarantine, and auditable cost/verification receipts.
import "server-only";
import crypto from "crypto";
import type Database from "better-sqlite3";
import { getDb } from "./db";

export const SEC_INGEST_CHECKPOINTS = [
  "discovered",
  "fetched",
  "validated",
  "parsed",
  "facts_extracted",
  "chunked",
  "embed_queued",
  "embedded",
  "index_queued",
  "indexed",
  "verified",
  "complete"
] as const;

export type SecIngestCheckpoint = (typeof SEC_INGEST_CHECKPOINTS)[number];
export type SecIngestJobStatus =
  | "pending"
  | "running"
  | "paused"
  | "complete"
  | "complete_with_errors"
  | "failed_terminal"
  | "canceled";
export type SecIngestTaskStatus =
  | "pending"
  | "leased"
  | "retry_wait"
  | "complete"
  | "dead_letter"
  | "quarantined"
  | "superseded";
export type SecIngestAttemptOutcome =
  | "claimed"
  | "advanced"
  | "retry_wait"
  | "dead_letter"
  | "quarantined"
  | "superseded"
  | "lease_expired";

export interface SecIngestJob {
  id: string;
  idempotencyKey: string;
  corpusRevision: string;
  universeSnapshotId?: string;
  status: SecIngestJobStatus;
  config: Record<string, unknown>;
  expectedTasks?: number;
  lastErrorType?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  intakeClosedAt?: string;
  completedAt?: string;
}

export interface SecIngestTask {
  id: string;
  jobId: string;
  taskKey: string;
  accession: string;
  cik: string;
  symbol: string;
  sequence?: number;
  documentName?: string;
  checkpoint: SecIngestCheckpoint;
  status: SecIngestTaskStatus;
  priority: number;
  ordinal: number;
  payload: Record<string, unknown>;
  totalAttempts: number;
  stageAttempts: number;
  maxStageAttempts: number;
  nextRetryAt?: string;
  leaseOwner?: string;
  leaseToken?: string;
  leaseExpiresAt?: string;
  heartbeatAt?: string;
  rawSha256?: string;
  normalizedSha256?: string;
  parserRevision?: string;
  chunkerRevision?: string;
  embedModel?: string;
  embedRevision?: string;
  indexName?: string;
  namespace?: string;
  observedBytes: number;
  observedTokens: number;
  observedChunks: number;
  observedVectors: number;
  observedWriteUnits: number;
  observedCostUsd: number;
  verification?: unknown;
  lastErrorType?: string;
  lastError?: string;
  lastErrorDetails?: unknown;
  createdAt: string;
  updatedAt: string;
}

type RawJobRow = {
  id: string;
  idempotency_key: string;
  corpus_revision: string;
  universe_snapshot_id: string | null;
  status: SecIngestJobStatus;
  config_json: string;
  expected_tasks: number | null;
  last_error_type: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  intake_closed_at: string | null;
  completed_at: string | null;
};

type RawTaskRow = {
  id: string;
  job_id: string;
  task_key: string;
  accession: string;
  cik: string;
  symbol: string;
  sequence: number | null;
  document_name: string | null;
  checkpoint: SecIngestCheckpoint;
  status: SecIngestTaskStatus;
  priority: number;
  ordinal: number;
  payload_json: string;
  total_attempts: number;
  stage_attempts: number;
  max_stage_attempts: number;
  next_retry_at: string | null;
  lease_owner: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  raw_sha256: string | null;
  normalized_sha256: string | null;
  parser_revision: string | null;
  chunker_revision: string | null;
  embed_model: string | null;
  embed_revision: string | null;
  index_name: string | null;
  namespace: string | null;
  observed_bytes: number;
  observed_tokens: number;
  observed_chunks: number;
  observed_vectors: number;
  observed_write_units: number;
  observed_cost_usd: number;
  verification_json: string | null;
  last_error_type: string | null;
  last_error: string | null;
  last_error_json: string | null;
  created_at: string;
  updated_at: string;
};

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, canonicalizeJson(child)])
  );
}

export function stableSecIngestJson(value: unknown): string {
  return JSON.stringify(canonicalizeJson(value));
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function digestKey(prefix: string, value: unknown): string {
  return `${prefix}:v1:${crypto.createHash("sha256").update(stableSecIngestJson(value)).digest("hex")}`;
}

export function buildSecIngestJobKey(input: {
  corpusRevision: string;
  universeSnapshotId?: string;
  scope: Record<string, unknown>;
}): string {
  return digestKey("sec-ingest-job", input);
}

export function buildSecIngestTaskKey(input: {
  accession: string;
  sequence?: number;
  documentName?: string;
  parserRevision?: string;
  chunkerRevision?: string;
  embedModel?: string;
  embedRevision?: string;
}): string {
  return digestKey("sec-ingest-task", input);
}

function rowToJob(row: RawJobRow): SecIngestJob {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    corpusRevision: row.corpus_revision,
    universeSnapshotId: row.universe_snapshot_id ?? undefined,
    status: row.status,
    config: parseJson(row.config_json, {}),
    expectedTasks: row.expected_tasks ?? undefined,
    lastErrorType: row.last_error_type ?? undefined,
    lastError: row.last_error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at ?? undefined,
    intakeClosedAt: row.intake_closed_at ?? undefined,
    completedAt: row.completed_at ?? undefined
  };
}

function rowToTask(row: RawTaskRow): SecIngestTask {
  return {
    id: row.id,
    jobId: row.job_id,
    taskKey: row.task_key,
    accession: row.accession,
    cik: row.cik,
    symbol: row.symbol,
    sequence: row.sequence ?? undefined,
    documentName: row.document_name ?? undefined,
    checkpoint: row.checkpoint,
    status: row.status,
    priority: row.priority,
    ordinal: row.ordinal,
    payload: parseJson(row.payload_json, {}),
    totalAttempts: row.total_attempts,
    stageAttempts: row.stage_attempts,
    maxStageAttempts: row.max_stage_attempts,
    nextRetryAt: row.next_retry_at ?? undefined,
    leaseOwner: row.lease_owner ?? undefined,
    leaseToken: row.lease_token ?? undefined,
    leaseExpiresAt: row.lease_expires_at ?? undefined,
    heartbeatAt: row.heartbeat_at ?? undefined,
    rawSha256: row.raw_sha256 ?? undefined,
    normalizedSha256: row.normalized_sha256 ?? undefined,
    parserRevision: row.parser_revision ?? undefined,
    chunkerRevision: row.chunker_revision ?? undefined,
    embedModel: row.embed_model ?? undefined,
    embedRevision: row.embed_revision ?? undefined,
    indexName: row.index_name ?? undefined,
    namespace: row.namespace ?? undefined,
    observedBytes: row.observed_bytes,
    observedTokens: row.observed_tokens,
    observedChunks: row.observed_chunks,
    observedVectors: row.observed_vectors,
    observedWriteUnits: row.observed_write_units,
    observedCostUsd: row.observed_cost_usd,
    verification: parseJson<unknown>(row.verification_json, undefined),
    lastErrorType: row.last_error_type ?? undefined,
    lastError: row.last_error ?? undefined,
    lastErrorDetails: parseJson<unknown>(row.last_error_json, undefined),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function getSecIngestJob(id: string): SecIngestJob | null {
  const row = getDb().prepare("SELECT * FROM sec_ingest_jobs WHERE id = ?").get(id) as RawJobRow | undefined;
  return row ? rowToJob(row) : null;
}

export function getSecIngestTask(id: string): SecIngestTask | null {
  const row = getDb().prepare("SELECT * FROM sec_ingest_tasks WHERE id = ?").get(id) as RawTaskRow | undefined;
  return row ? rowToTask(row) : null;
}

export function createSecIngestJob(input: {
  id?: string;
  idempotencyKey: string;
  corpusRevision: string;
  universeSnapshotId?: string;
  config?: Record<string, unknown>;
  expectedTasks?: number;
  now?: string;
}): SecIngestJob {
  if (!input.idempotencyKey.trim()) throw new Error("SEC ingest job idempotencyKey is required");
  if (!input.corpusRevision.trim()) throw new Error("SEC ingest job corpusRevision is required");
  if (input.expectedTasks !== undefined && (!Number.isInteger(input.expectedTasks) || input.expectedTasks < 0)) {
    throw new Error("SEC ingest job expectedTasks must be a non-negative integer");
  }
  const database = getDb();
  const id = input.id ?? crypto.randomUUID();
  const now = input.now ?? new Date().toISOString();
  const configJson = stableSecIngestJson(input.config ?? {});
  database
    .prepare(
      `INSERT INTO sec_ingest_jobs (
        id, idempotency_key, corpus_revision, universe_snapshot_id, status, config_json,
        expected_tasks, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)
      ON CONFLICT(idempotency_key) DO NOTHING`
    )
    .run(
      id,
      input.idempotencyKey,
      input.corpusRevision,
      input.universeSnapshotId ?? null,
      configJson,
      input.expectedTasks ?? null,
      now,
      now
    );
  const row = database
    .prepare("SELECT * FROM sec_ingest_jobs WHERE idempotency_key = ?")
    .get(input.idempotencyKey) as RawJobRow;
  const immutableMatch =
    row.corpus_revision === input.corpusRevision &&
    row.universe_snapshot_id === (input.universeSnapshotId ?? null) &&
    row.config_json === configJson &&
    (input.expectedTasks === undefined || row.expected_tasks === input.expectedTasks);
  if (!immutableMatch) {
    throw new Error(`SEC ingest job replay conflict for idempotency key ${input.idempotencyKey}`);
  }
  return rowToJob(row);
}

const JOB_TRANSITIONS: Record<SecIngestJobStatus, readonly SecIngestJobStatus[]> = {
  pending: ["running", "failed_terminal", "canceled"],
  // Completion is intentionally absent. Only reconcileSecIngestJob may close a running job,
  // after intake is sealed and its exact task count is terminal.
  running: ["paused", "failed_terminal", "canceled"],
  paused: ["running", "failed_terminal", "canceled"],
  complete: [],
  complete_with_errors: [],
  failed_terminal: [],
  canceled: []
};

export function transitionSecIngestJob(
  id: string,
  next: SecIngestJobStatus,
  options: { expected?: SecIngestJobStatus; now?: string } = {}
): boolean {
  const database = getDb();
  const now = options.now ?? new Date().toISOString();
  const transition = database.transaction(() => {
    const row = database.prepare("SELECT status FROM sec_ingest_jobs WHERE id = ?").get(id) as
      | { status: SecIngestJobStatus }
      | undefined;
    if (!row || (options.expected && row.status !== options.expected)) return false;
    if (row.status === next) return true;
    if (!JOB_TRANSITIONS[row.status].includes(next)) return false;
    const terminal = ["complete", "complete_with_errors", "failed_terminal", "canceled"].includes(next);
    const info = database
      .prepare(
        `UPDATE sec_ingest_jobs
         SET status = ?, updated_at = ?,
             started_at = CASE WHEN ? = 'running' THEN COALESCE(started_at, ?) ELSE started_at END,
             completed_at = CASE WHEN ? THEN ? ELSE completed_at END
         WHERE id = ? AND status = ?`
      )
      .run(next, now, next, now, terminal ? 1 : 0, now, id, row.status);
    return info.changes === 1;
  });
  return transition.immediate() as boolean;
}

export function sealSecIngestJobIntake(id: string, expectedTasks?: number, now = new Date().toISOString()): boolean {
  if (expectedTasks !== undefined && (!Number.isInteger(expectedTasks) || expectedTasks < 0)) {
    throw new Error("SEC ingest job expectedTasks must be a non-negative integer");
  }
  const database = getDb();
  const seal = database.transaction(() => {
    const job = database
      .prepare("SELECT status, intake_closed_at, expected_tasks FROM sec_ingest_jobs WHERE id = ?")
      .get(id) as { status: SecIngestJobStatus; intake_closed_at: string | null; expected_tasks: number | null } | undefined;
    if (!job || !["pending", "running", "paused"].includes(job.status)) return false;
    const taskCount = (database.prepare("SELECT COUNT(*) AS n FROM sec_ingest_tasks WHERE job_id = ?").get(id) as { n: number }).n;
    // Freeze the originally promised task count: if the job already has an
    // expected_tasks bound and the caller passes a different explicit count,
    // reject it rather than silently rewriting the contract.
    if (job.expected_tasks !== null && expectedTasks !== undefined && expectedTasks !== job.expected_tasks) return false;
    const finalExpected = expectedTasks ?? job.expected_tasks ?? taskCount;
    if (finalExpected !== taskCount) return false;
    if (job.intake_closed_at) return job.expected_tasks === finalExpected;
    const info = database
      .prepare(
        "UPDATE sec_ingest_jobs SET expected_tasks = ?, intake_closed_at = ?, updated_at = ? WHERE id = ? AND intake_closed_at IS NULL"
      )
      .run(finalExpected, now, now, id);
    return info.changes === 1;
  });
  return seal.immediate() as boolean;
}

export function failSecIngestJobTerminal(
  id: string,
  errorType: string,
  error: string,
  now = new Date().toISOString()
): boolean {
  const info = getDb()
    .prepare(
      `UPDATE sec_ingest_jobs
       SET status = 'failed_terminal', last_error_type = ?, last_error = ?, updated_at = ?, completed_at = ?
       WHERE id = ? AND status IN ('pending', 'running', 'paused')`
    )
    .run(errorType, error, now, now, id);
  return info.changes === 1;
}

export function enqueueSecIngestTask(input: {
  id?: string;
  jobId: string;
  taskKey?: string;
  accession: string;
  cik?: string;
  symbol?: string;
  sequence?: number;
  documentName?: string;
  priority?: number;
  ordinal?: number;
  payload?: Record<string, unknown>;
  maxStageAttempts?: number;
  parserRevision?: string;
  chunkerRevision?: string;
  embedModel?: string;
  embedRevision?: string;
  now?: string;
}): { inserted: boolean; task: SecIngestTask } {
  if (!input.accession.trim()) throw new Error("SEC ingest task accession is required");
  const maxStageAttempts = input.maxStageAttempts ?? 6;
  if (!Number.isInteger(maxStageAttempts) || maxStageAttempts < 1) {
    throw new Error("SEC ingest task maxStageAttempts must be a positive integer");
  }
  const priority = input.priority ?? 0;
  if (!Number.isFinite(priority) || !Number.isInteger(priority)) {
    throw new Error("SEC ingest task priority must be a finite integer");
  }
  const ordinal = input.ordinal ?? 0;
  if (!Number.isFinite(ordinal) || !Number.isInteger(ordinal) || ordinal < 0) {
    throw new Error("SEC ingest task ordinal must be a non-negative finite integer");
  }
  const payloadJson = stableSecIngestJson(input.payload ?? {});
  const taskKey =
    input.taskKey ??
    buildSecIngestTaskKey({
      accession: input.accession,
      sequence: input.sequence,
      documentName: input.documentName,
      parserRevision: input.parserRevision,
      chunkerRevision: input.chunkerRevision,
      embedModel: input.embedModel,
      embedRevision: input.embedRevision
    });
  const database = getDb();
  const id = input.id ?? crypto.randomUUID();
  const now = input.now ?? new Date().toISOString();
  const insert = database.transaction(() => {
    const job = database
      .prepare("SELECT status, intake_closed_at FROM sec_ingest_jobs WHERE id = ?")
      .get(input.jobId) as { status: SecIngestJobStatus; intake_closed_at: string | null } | undefined;
    if (!job) throw new Error(`Unknown SEC ingest job ${input.jobId}`);
    if (job.intake_closed_at) throw new Error(`SEC ingest job ${input.jobId} intake is closed`);
    if (!["pending", "running", "paused"].includes(job.status)) {
      throw new Error(`SEC ingest job ${input.jobId} cannot accept tasks while ${job.status}`);
    }
    const info = database
      .prepare(
        `INSERT INTO sec_ingest_tasks (
          id, job_id, task_key, accession, cik, symbol, sequence, document_name,
          checkpoint, status, priority, ordinal, payload_json, max_stage_attempts,
          parser_revision, chunker_revision, embed_model, embed_revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'discovered', 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(job_id, task_key) DO NOTHING`
      )
      .run(
        id,
        input.jobId,
        taskKey,
        input.accession,
        input.cik ?? "",
        input.symbol ?? "",
        input.sequence ?? null,
        input.documentName ?? null,
        priority,
        ordinal,
        payloadJson,
        maxStageAttempts,
        input.parserRevision ?? null,
        input.chunkerRevision ?? null,
        input.embedModel ?? null,
        input.embedRevision ?? null,
        now,
        now
      );
    const row = database
      .prepare("SELECT * FROM sec_ingest_tasks WHERE job_id = ? AND task_key = ?")
      .get(input.jobId, taskKey) as RawTaskRow;
    const immutableMatch =
      row.accession === input.accession &&
      row.cik === (input.cik ?? "") &&
      row.symbol === (input.symbol ?? "") &&
      row.sequence === (input.sequence ?? null) &&
      row.document_name === (input.documentName ?? null) &&
      row.priority === priority &&
      row.ordinal === ordinal &&
      row.payload_json === payloadJson &&
      row.max_stage_attempts === maxStageAttempts &&
      row.parser_revision === (input.parserRevision ?? null) &&
      row.chunker_revision === (input.chunkerRevision ?? null) &&
      row.embed_model === (input.embedModel ?? null) &&
      row.embed_revision === (input.embedRevision ?? null);
    if (!immutableMatch) throw new Error(`SEC ingest task replay conflict for task key ${taskKey}`);
    return { inserted: info.changes === 1, task: rowToTask(row) };
  });
  return insert.immediate() as { inserted: boolean; task: SecIngestTask };
}

function boundedLeaseMs(value: number | undefined): number {
  const parsed = Number.isFinite(value) ? Math.floor(value!) : 5 * 60_000;
  return Math.max(1_000, Math.min(60 * 60_000, parsed));
}

/** Shared per-candidate claim body: retire an expired lease (dead-lettering a task whose stage
 *  attempt budget is spent), then lease the row to `owner` and open a fresh attempt receipt. Shared
 *  by the per-job claim and the cross-job round-robin claim so both keep IDENTICAL lease-expiry
 *  and attempt-accounting discipline. Returns the claimed task, or null when the row was retired
 *  or lost the race. Runs inside the caller's claim transaction. */
function claimSecIngestCandidate(
  database: Database.Database,
  candidate: RawTaskRow,
  ctx: { owner: string; nowIso: string; leaseExpiresAt: string }
): SecIngestTask | null {
  if (candidate.status === "leased" && candidate.lease_token) {
    const attemptsExhausted = candidate.stage_attempts >= candidate.max_stage_attempts;
    const expiredAttempt = database
      .prepare(
        `UPDATE sec_ingest_task_attempts
         SET outcome = ?, finished_at = ?,
             error_type = CASE WHEN ? THEN 'lease_attempts_exhausted' ELSE error_type END,
             error = CASE WHEN ? THEN 'worker lease expired after the stage attempt budget was exhausted' ELSE error END
         WHERE task_id = ? AND lease_token = ? AND outcome = 'claimed'`
      )
      .run(
        attemptsExhausted ? "dead_letter" : "lease_expired",
        ctx.nowIso,
        attemptsExhausted ? 1 : 0,
        attemptsExhausted ? 1 : 0,
        candidate.id,
        candidate.lease_token
      );
    if (expiredAttempt.changes !== 1) {
      throw new Error("Expired SEC ingest claim has no matching attempt receipt");
    }
    if (attemptsExhausted) {
      const terminal = database
        .prepare(
          `UPDATE sec_ingest_tasks
           SET status = 'dead_letter', next_retry_at = NULL,
               lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
               last_error_type = 'lease_attempts_exhausted',
               last_error = 'worker lease expired after the stage attempt budget was exhausted',
               last_error_json = ?, updated_at = ?
           WHERE id = ? AND status = 'leased' AND lease_token = ? AND lease_expires_at <= ?`
        )
        .run(
          stableSecIngestJson({
            checkpoint: candidate.checkpoint,
            stageAttempts: candidate.stage_attempts,
            maxStageAttempts: candidate.max_stage_attempts
          }),
          ctx.nowIso,
          candidate.id,
          candidate.lease_token,
          ctx.nowIso
        );
      if (terminal.changes !== 1) throw new Error("Expired SEC ingest claim could not be dead-lettered");
      database.prepare("UPDATE sec_ingest_jobs SET updated_at = ? WHERE id = ?").run(ctx.nowIso, candidate.job_id);
      return null;
    }
  }
  const leaseToken = crypto.randomUUID();
  const info = database
    .prepare(
      `UPDATE sec_ingest_tasks
       SET status = 'leased', lease_owner = ?, lease_token = ?, lease_expires_at = ?,
           heartbeat_at = ?, next_retry_at = NULL, total_attempts = total_attempts + 1,
           stage_attempts = stage_attempts + 1, updated_at = ?
       WHERE id = ?
         AND EXISTS (SELECT 1 FROM sec_ingest_jobs WHERE id = sec_ingest_tasks.job_id AND status = 'running')
         AND (
           status = 'pending'
           OR (status = 'retry_wait' AND next_retry_at <= ?)
           OR (status = 'leased' AND lease_expires_at <= ?)
         )`
    )
    .run(
      ctx.owner,
      leaseToken,
      ctx.leaseExpiresAt,
      ctx.nowIso,
      ctx.nowIso,
      candidate.id,
      ctx.nowIso,
      ctx.nowIso
    );
  if (info.changes !== 1) return null;
  const row = database.prepare("SELECT * FROM sec_ingest_tasks WHERE id = ?").get(candidate.id) as RawTaskRow;
  database
    .prepare(
      `INSERT INTO sec_ingest_task_attempts (
        task_id, attempt_no, checkpoint, lease_owner, lease_token,
        started_at, heartbeat_at, outcome
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'claimed')`
    )
    .run(row.id, row.total_attempts, row.checkpoint, ctx.owner, leaseToken, ctx.nowIso, ctx.nowIso);
  return rowToTask(row);
}

function claimLimit(options: { limit?: number }): number {
  if (
    options.limit !== undefined &&
    (!Number.isFinite(options.limit) || !Number.isInteger(options.limit) || options.limit < 1)
  ) {
    throw new Error("SEC ingest task claim limit must be a positive finite integer");
  }
  return Math.min(200, options.limit ?? 20);
}

export function claimSecIngestTasks(
  jobId: string,
  options: { owner: string; limit?: number; leaseMs?: number; now?: Date }
): SecIngestTask[] {
  if (!options.owner.trim()) throw new Error("SEC ingest task claim owner is required");
  const database = getDb();
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const leaseExpiresAt = new Date(now.getTime() + boundedLeaseMs(options.leaseMs)).toISOString();
  const limit = claimLimit(options);
  const claim = database.transaction((): SecIngestTask[] => {
    const candidates = database
      .prepare(
        `SELECT t.* FROM sec_ingest_tasks t
         JOIN sec_ingest_jobs j ON j.id = t.job_id
         WHERE t.job_id = ? AND j.status = 'running' AND (
           t.status = 'pending'
           OR (t.status = 'retry_wait' AND t.next_retry_at <= ?)
           OR (t.status = 'leased' AND t.lease_expires_at <= ?)
         )
         ORDER BY t.priority DESC, t.ordinal ASC, t.created_at ASC, t.id ASC
         LIMIT ?`
      )
      .all(jobId, nowIso, nowIso, limit) as RawTaskRow[];
    const claimed: SecIngestTask[] = [];
    for (const candidate of candidates) {
      const task = claimSecIngestCandidate(database, candidate, {
        owner: options.owner,
        nowIso,
        leaseExpiresAt
      });
      if (task) claimed.push(task);
    }
    return claimed;
  });
  // Fatal database/schema errors must surface. The transaction itself is the fail-closed boundary:
  // it rolls every partial claim back, while the thrown error stops a worker that cannot prove its
  // durable state instead of disguising infrastructure failure as an empty queue.
  return claim.immediate() as SecIngestTask[];
}

/**
 * Cross-job round-robin claim — the worker's production claim path.
 *
 * The per-job claim (`claimSecIngestTasks`) cannot express fairness: the worker used to loop
 * `SELECT id FROM sec_ingest_jobs WHERE status='running'` (no ORDER BY, so DB order) and hand the
 * whole per-tick budget to the FIRST job that had candidates. With ~500 running jobs, issuer #1
 * consumed all 5 slots every tick and every other issuer sat at `discovered` forever (2,156
 * tasks pending since 2026-08-10).
 *
 * This claim takes `perJobLimit` candidates from EVERY running job (ranked by the same
 * priority/ordinal/age order the per-job claim uses), then orders that union globally by
 * priority DESC then age and takes `limit`. The per-job ceiling is a fairness bound: no job
 * can take more than its share of a tick no matter how much pending work it has, and a job with
 * a huge backlog cannot starve the rest of the queue. If the fair window comes back SHORT — a
 * lone job is the only thing with work left, so there is nobody to starve — the claim tops the
 * tick up from the same global order without the ceiling, because throughput should not be
 * sacrificed when fairness has nothing to protect.
 *
 * Ordering is priority first (money-path overlay from sec-ingest-priority), then age, so the
 * oldest work still wins within a priority band. Default `perJobLimit` is half the tick budget
 * (rounded up), which keeps the claim global while still letting one job use spare slots when
 * nothing else is claimable.
 */
export function claimSecIngestTasksAcrossJobs(
  options: { owner: string; limit?: number; perJobLimit?: number; leaseMs?: number; now?: Date }
): SecIngestTask[] {
  if (!options.owner.trim()) throw new Error("SEC ingest task claim owner is required");
  const database = getDb();
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const leaseExpiresAt = new Date(now.getTime() + boundedLeaseMs(options.leaseMs)).toISOString();
  const limit = claimLimit(options);
  const perJobLimit =
    options.perJobLimit !== undefined
      ? Math.max(1, Math.min(limit, Math.floor(options.perJobLimit)))
      : Math.max(1, Math.ceil(limit / 2));
  const claim = database.transaction((): SecIngestTask[] => {
    // One row per (job, rank) window: rn <= perJobLimit is each job's own top slice, so the
    // per-job ceiling is applied by the database, not by a JavaScript loop over 500 jobs.
    const fairWindow = database.prepare(
      `SELECT t.* FROM (
         SELECT t.*, ROW_NUMBER() OVER (
           PARTITION BY t.job_id
           ORDER BY t.priority DESC, t.ordinal ASC, t.created_at ASC, t.id ASC
         ) AS job_rank
         FROM sec_ingest_tasks t
         JOIN sec_ingest_jobs j ON j.id = t.job_id
         WHERE j.status = 'running' AND (
           t.status = 'pending'
           OR (t.status = 'retry_wait' AND t.next_retry_at <= ?)
           OR (t.status = 'leased' AND t.lease_expires_at <= ?)
         )
       ) t
       WHERE t.job_rank <= ?
       ORDER BY t.priority DESC, t.created_at ASC, t.id ASC
       LIMIT ?`
    );
    // Same order, no ceiling — only read when the fair window could not fill the tick.
    const fairFill = database.prepare(
      `SELECT t.* FROM sec_ingest_tasks t
       JOIN sec_ingest_jobs j ON j.id = t.job_id
       WHERE j.status = 'running' AND (
         t.status = 'pending'
         OR (t.status = 'retry_wait' AND t.next_retry_at <= ?)
         OR (t.status = 'leased' AND t.lease_expires_at <= ?)
       )
       ORDER BY t.priority DESC, t.created_at ASC, t.id ASC
       LIMIT ?`
    );
    const claimed: SecIngestTask[] = [];
    const consume = (candidates: RawTaskRow[]) => {
      for (const candidate of candidates) {
        if (claimed.length >= limit) break;
        const task = claimSecIngestCandidate(database, candidate, {
          owner: options.owner,
          nowIso,
          leaseExpiresAt
        });
        if (task) claimed.push(task);
      }
    };
    consume(fairWindow.all(nowIso, nowIso, perJobLimit, limit) as RawTaskRow[]);
    if (claimed.length < limit) {
      consume(fairFill.all(nowIso, nowIso, limit - claimed.length) as RawTaskRow[]);
    }
    return claimed;
  });
  // Same fail-closed boundary as the per-job claim: a partial claim must roll back, and a
  // database/schema failure must surface instead of looking like an empty queue.
  return claim.immediate() as SecIngestTask[];
}

/**
 * Re-lease ONE already-advanced task for its next checkpoint stage, in the same process.
 *
 * `advanceSecIngestTask` deliberately RELEASES the lease (it sets status back to `pending` and
 * clears the lease columns) because a checkpoint is a durable handoff point: a crash between
 * stages is recoverable by any worker. That handoff is what made one document cost 11 separate
 * claim→process→advance cycles (5 tasks/tick, 5s tick, serialized tickInFlight ⇒ 11x less
 * throughput than the cap implied). When the worker stays inside one process it must re-acquire
 * the lease between stages, and it must do so through the SAME accounting as a tick claim:
 * a new attempt receipt, `total_attempts` bumped, `stage_attempts` re-armed at 1 (advance
 * already reset it to 0), and the job must still be `running`.
 *
 * Returns the freshly leased task, or null when the task is no longer claimable — a completed
 * task, a job that left `running`, or a concurrent claim. Callers treat null as "stop; the
 * durable state is authoritative".
 */
export function reclaimSecIngestTaskForStage(input: {
  taskId: string;
  owner: string;
  leaseMs?: number;
  now?: Date;
}): SecIngestTask | null {
  if (!input.owner.trim()) throw new Error("SEC ingest task claim owner is required");
  const database = getDb();
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const leaseExpiresAt = new Date(now.getTime() + boundedLeaseMs(input.leaseMs)).toISOString();
  const reclaim = database.transaction((): SecIngestTask | null => {
    const candidate = database
      .prepare(
        `SELECT t.* FROM sec_ingest_tasks t
         JOIN sec_ingest_jobs j ON j.id = t.job_id
         WHERE t.id = ? AND j.status = 'running' AND (
           t.status = 'pending'
           OR (t.status = 'retry_wait' AND t.next_retry_at <= ?)
         )`
      )
      .get(input.taskId, nowIso) as RawTaskRow | undefined;
    if (!candidate) return null;
    return claimSecIngestCandidate(database, candidate, {
      owner: input.owner,
      nowIso,
      leaseExpiresAt
    });
  });
  return reclaim.immediate() as SecIngestTask | null;
}

export function heartbeatSecIngestTask(input: {
  taskId: string;
  owner: string;
  leaseToken: string;
  leaseMs?: number;
  now?: Date;
}): boolean {
  const database = getDb();
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const nextExpiry = new Date(now.getTime() + boundedLeaseMs(input.leaseMs)).toISOString();
  const heartbeat = database.transaction(() => {
    const info = database
      .prepare(
        `UPDATE sec_ingest_tasks SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND status = 'leased' AND lease_owner = ? AND lease_token = ?
           AND lease_expires_at > ?
           AND EXISTS (
             SELECT 1 FROM sec_ingest_jobs
             WHERE id = sec_ingest_tasks.job_id AND status = 'running'
           )`
      )
      .run(nowIso, nextExpiry, nowIso, input.taskId, input.owner, input.leaseToken, nowIso);
    if (info.changes !== 1) return false;
    const attempt = database
      .prepare(
        `UPDATE sec_ingest_task_attempts SET heartbeat_at = ?
         WHERE task_id = ? AND lease_token = ? AND lease_owner = ? AND outcome = 'claimed'`
      )
      .run(nowIso, input.taskId, input.leaseToken, input.owner);
    if (attempt.changes !== 1) throw new Error("SEC ingest claim has no matching attempt receipt");
    return true;
  });
  return heartbeat.immediate() as boolean;
}

function isDirectCheckpointTransition(from: SecIngestCheckpoint, to: SecIngestCheckpoint): boolean {
  return SEC_INGEST_CHECKPOINTS.indexOf(to) === SEC_INGEST_CHECKPOINTS.indexOf(from) + 1;
}

type StageObservations = {
  bytes?: number;
  tokens?: number;
  chunks?: number;
  vectors?: number;
  writeUnits?: number;
  costUsd?: number;
};

const SEC_INGEST_SHA256_RE = /^[a-f0-9]{64}$/;

function optionalSha256(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (!SEC_INGEST_SHA256_RE.test(value)) {
    throw new Error(`SEC ingest ${field} must be 64 lowercase hexadecimal characters`);
  }
  return value;
}

function requiredTerminalReason(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`SEC ingest terminal ${field} must be non-empty`);
  }
  return value.trim();
}

function nonNegativeNumber(value: number | undefined, field: string, integer: boolean): number {
  const resolved = value ?? 0;
  if (!Number.isFinite(resolved) || resolved < 0 || (integer && !Number.isInteger(resolved))) {
    throw new Error(`SEC ingest ${field} must be a non-negative ${integer ? "integer" : "number"}`);
  }
  return resolved;
}

export function advanceSecIngestTask(input: {
  taskId: string;
  owner: string;
  leaseToken: string;
  expectedCheckpoint: SecIngestCheckpoint;
  nextCheckpoint: SecIngestCheckpoint;
  rawSha256?: string;
  normalizedSha256?: string;
  parserRevision?: string;
  chunkerRevision?: string;
  embedModel?: string;
  embedRevision?: string;
  indexName?: string;
  namespace?: string;
  observations?: StageObservations;
  verification?: unknown;
  receipt?: Record<string, unknown>;
  now?: Date;
}): boolean {
  if (!isDirectCheckpointTransition(input.expectedCheckpoint, input.nextCheckpoint)) return false;
  if (input.nextCheckpoint === "complete" && (input.verification === undefined || input.verification === null)) {
    return false;
  }
  const observations = input.observations ?? {};
  const bytes = nonNegativeNumber(observations.bytes, "observed bytes", true);
  const tokens = nonNegativeNumber(observations.tokens, "observed tokens", true);
  const chunks = nonNegativeNumber(observations.chunks, "observed chunks", true);
  const vectors = nonNegativeNumber(observations.vectors, "observed vectors", true);
  const writeUnits = nonNegativeNumber(observations.writeUnits, "observed write units", true);
  const costUsd = nonNegativeNumber(observations.costUsd, "observed cost", false);
  const rawSha256 = optionalSha256(input.rawSha256, "rawSha256");
  const normalizedSha256 = optionalSha256(input.normalizedSha256, "normalizedSha256");
  const database = getDb();
  const nowIso = (input.now ?? new Date()).toISOString();
  const nextStatus: SecIngestTaskStatus = input.nextCheckpoint === "complete" ? "complete" : "pending";
  // The checkpoint is authoritative state, never caller metadata. Spread the caller receipt first
  // so a reserved `checkpoint` key cannot falsify the durable attempt receipt.
  const receiptJson = stableSecIngestJson({ ...(input.receipt ?? {}), checkpoint: input.nextCheckpoint });
  const advance = database.transaction(() => {
    const identity = database
      .prepare(
        `SELECT parser_revision, chunker_revision, embed_model, embed_revision,
                raw_sha256, normalized_sha256
         FROM sec_ingest_tasks WHERE id = ?`
      )
      .get(input.taskId) as Pick<
        RawTaskRow,
        "parser_revision" | "chunker_revision" | "embed_model" | "embed_revision" |
        "raw_sha256" | "normalized_sha256"
      > | undefined;
    if (!identity) return false;
    const identityMatches =
      (input.parserRevision === undefined || input.parserRevision === identity.parser_revision) &&
      (input.chunkerRevision === undefined || input.chunkerRevision === identity.chunker_revision) &&
      (input.embedModel === undefined || input.embedModel === identity.embed_model) &&
      (input.embedRevision === undefined || input.embedRevision === identity.embed_revision) &&
      (rawSha256 === undefined || identity.raw_sha256 === null || rawSha256 === identity.raw_sha256) &&
      (normalizedSha256 === undefined || identity.normalized_sha256 === null || normalizedSha256 === identity.normalized_sha256);
    if (!identityMatches) return false;
    const info = database
      .prepare(
        `UPDATE sec_ingest_tasks SET
           checkpoint = ?, status = ?, stage_attempts = 0, next_retry_at = NULL,
           lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
           raw_sha256 = COALESCE(raw_sha256, ?),
           normalized_sha256 = COALESCE(normalized_sha256, ?),
           index_name = COALESCE(?, index_name), namespace = COALESCE(?, namespace),
           observed_bytes = observed_bytes + ?, observed_tokens = observed_tokens + ?,
           observed_chunks = observed_chunks + ?, observed_vectors = observed_vectors + ?,
           observed_write_units = observed_write_units + ?, observed_cost_usd = observed_cost_usd + ?,
           verification_json = COALESCE(?, verification_json),
           last_error_type = NULL, last_error = NULL, last_error_json = NULL, updated_at = ?
         WHERE id = ? AND checkpoint = ? AND status = 'leased'
           AND lease_owner = ? AND lease_token = ? AND lease_expires_at > ?
           AND EXISTS (
             SELECT 1 FROM sec_ingest_jobs
             WHERE id = sec_ingest_tasks.job_id AND status = 'running'
           )`
      )
      .run(
        input.nextCheckpoint,
        nextStatus,
        rawSha256 ?? null,
        normalizedSha256 ?? null,
        input.indexName ?? null,
        input.namespace ?? null,
        bytes,
        tokens,
        chunks,
        vectors,
        writeUnits,
        costUsd,
        input.verification === undefined ? null : stableSecIngestJson(input.verification),
        nowIso,
        input.taskId,
        input.expectedCheckpoint,
        input.owner,
        input.leaseToken,
        nowIso
      );
    if (info.changes !== 1) return false;
    const attempt = database
      .prepare(
        `UPDATE sec_ingest_task_attempts
         SET outcome = 'advanced', finished_at = ?, receipt_json = ?
         WHERE task_id = ? AND lease_token = ? AND lease_owner = ? AND outcome = 'claimed'`
      )
      .run(nowIso, receiptJson, input.taskId, input.leaseToken, input.owner);
    if (attempt.changes !== 1) throw new Error("SEC ingest claim has no matching attempt receipt");
    database.prepare("UPDATE sec_ingest_jobs SET updated_at = ? WHERE id = (SELECT job_id FROM sec_ingest_tasks WHERE id = ?)").run(nowIso, input.taskId);
    return true;
  });
  return advance.immediate() as boolean;
}

export function computeSecIngestRetryDelayMs(
  stageAttempts: number,
  options: {
    baseBackoffMs?: number;
    maxBackoffMs?: number;
    retryAfterMs?: number;
    jitterRatio?: number;
    random?: () => number;
  } = {}
): number {
  const maxSafeDelayMs = 30 * 24 * 60 * 60_000;
  const rawBase = options.baseBackoffMs;
  const rawMax = options.maxBackoffMs;
  const base = Math.max(1_000, Math.min(maxSafeDelayMs, Math.floor(Number.isFinite(rawBase) ? rawBase! : 30_000)));
  const max = Math.max(base, Math.min(maxSafeDelayMs, Math.floor(Number.isFinite(rawMax) ? rawMax! : 6 * 60 * 60_000)));
  const safeAttempts = Number.isFinite(stageAttempts) ? Math.floor(stageAttempts) : 1;
  const exponent = Math.max(0, Math.min(20, safeAttempts - 1));
  const exponential = Math.min(max, base * 2 ** exponent);
  const rawJitterRatio = options.jitterRatio;
  const jitterRatio = Math.max(0, Math.min(1, Number.isFinite(rawJitterRatio) ? rawJitterRatio! : 0.2));
  const randomSample = (options.random ?? Math.random)();
  const random = Math.max(0, Math.min(1, Number.isFinite(randomSample) ? randomSample : 0.5));
  const jittered = exponential * (1 - jitterRatio + 2 * jitterRatio * random);
  const retryAfter =
    options.retryAfterMs !== undefined && Number.isFinite(options.retryAfterMs) && options.retryAfterMs > 0
      ? Math.min(maxSafeDelayMs, Math.floor(options.retryAfterMs))
      : 0;
  // The exponential cap controls our own backoff. Retry-After can exceed that config cap, but an
  // operational 30-day ceiling prevents malformed/extreme finite values from overflowing Date.
  return Math.max(retryAfter, Math.min(max, Math.round(jittered)));
}

export interface SecIngestFailureResult {
  applied: boolean;
  status?: SecIngestTaskStatus;
  nextRetryAt?: string;
}

export function failSecIngestTask(input: {
  taskId: string;
  owner: string;
  leaseToken: string;
  retryable: boolean;
  errorType: string;
  error: string;
  errorDetails?: unknown;
  receipt?: Record<string, unknown>;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  retryAfterMs?: number;
  jitterRatio?: number;
  random?: () => number;
  now?: Date;
}): SecIngestFailureResult {
  const errorType = requiredTerminalReason(input.errorType, "errorType");
  const error = requiredTerminalReason(input.error, "error");
  const database = getDb();
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const fail = database.transaction((): SecIngestFailureResult => {
    const row = database
      .prepare(
        `SELECT t.* FROM sec_ingest_tasks t
         JOIN sec_ingest_jobs j ON j.id = t.job_id
         WHERE t.id = ? AND j.status = 'running' AND t.status = 'leased'
           AND t.lease_owner = ? AND t.lease_token = ? AND t.lease_expires_at > ?`
      )
      .get(input.taskId, input.owner, input.leaseToken, nowIso) as RawTaskRow | undefined;
    if (!row) return { applied: false };
    const willRetry = input.retryable && row.stage_attempts < row.max_stage_attempts;
    const status: SecIngestTaskStatus = willRetry ? "retry_wait" : "dead_letter";
    const delayMs = willRetry
      ? computeSecIngestRetryDelayMs(row.stage_attempts, {
          baseBackoffMs: input.baseBackoffMs,
          maxBackoffMs: input.maxBackoffMs,
          retryAfterMs: input.retryAfterMs,
          jitterRatio: input.jitterRatio,
          random: input.random
        })
      : 0;
    const nextRetryAt = willRetry ? new Date(now.getTime() + delayMs).toISOString() : undefined;
    const errorJson = input.errorDetails === undefined ? null : stableSecIngestJson(input.errorDetails);
    const info = database
      .prepare(
        `UPDATE sec_ingest_tasks SET status = ?, next_retry_at = ?,
           lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
           last_error_type = ?, last_error = ?, last_error_json = ?, updated_at = ?
         WHERE id = ? AND status = 'leased' AND lease_owner = ? AND lease_token = ?`
      )
      .run(
        status,
        nextRetryAt ?? null,
        errorType,
        error,
        errorJson,
        nowIso,
        input.taskId,
        input.owner,
        input.leaseToken
      );
    if (info.changes !== 1) return { applied: false };
    const attempt = database
      .prepare(
        `UPDATE sec_ingest_task_attempts
         SET outcome = ?, finished_at = ?, error_type = ?, error = ?, receipt_json = ?
         WHERE task_id = ? AND lease_token = ? AND lease_owner = ? AND outcome = 'claimed'`
      )
      .run(
        status,
        nowIso,
        errorType,
        error,
        input.receipt === undefined ? null : stableSecIngestJson(input.receipt),
        input.taskId,
        input.leaseToken,
        input.owner
      );
    if (attempt.changes !== 1) throw new Error("SEC ingest claim has no matching attempt receipt");
    database.prepare("UPDATE sec_ingest_jobs SET updated_at = ? WHERE id = ?").run(nowIso, row.job_id);
    return { applied: true, status, nextRetryAt };
  });
  return fail.immediate() as SecIngestFailureResult;
}

/**
 * Cleanly PARK a leased task until a known future instant (e.g. the monthly Pinecone
 * write-unit breaker expiry) — a deferral, not a failure. Differences from failSecIngestTask:
 * - `next_retry_at` is set to the caller's instant (clamped to [now+60s, now+35d]) instead of
 *   an exponential backoff, so the queue does not grind retries against a quota that cannot
 *   recover before that instant.
 * - The stage attempt the claim consumed is REFUNDED (stage_attempts - 1): waiting out an
 *   exhausted provider quota must never march a healthy task toward dead_letter.
 *   `total_attempts` is deliberately NOT refunded — attempt receipts key on it
 *   (UNIQUE(task_id, attempt_no)) and history should stay honest.
 * Same fencing as failSecIngestTask: owner + lease token + unexpired lease + running job.
 * The attempt receipt closes with outcome 'retry_wait' carrying the defer reason.
 */
export function deferSecIngestTask(input: {
  taskId: string;
  owner: string;
  leaseToken: string;
  /** ISO instant the task becomes claimable again. */
  deferUntil: string;
  reasonType: string;
  reason: string;
  receipt?: Record<string, unknown>;
  now?: Date;
}): SecIngestFailureResult {
  const reasonType = requiredTerminalReason(input.reasonType, "reasonType");
  const reason = requiredTerminalReason(input.reason, "reason");
  const database = getDb();
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const parsed = Date.parse(input.deferUntil);
  const minMs = now.getTime() + 60_000;
  const maxMs = now.getTime() + 35 * 24 * 60 * 60_000;
  const clampedMs = Number.isFinite(parsed) ? Math.min(maxMs, Math.max(minMs, parsed)) : minMs;
  const nextRetryAt = new Date(clampedMs).toISOString();
  const defer = database.transaction((): SecIngestFailureResult => {
    const row = database
      .prepare(
        `SELECT t.* FROM sec_ingest_tasks t
         JOIN sec_ingest_jobs j ON j.id = t.job_id
         WHERE t.id = ? AND j.status = 'running' AND t.status = 'leased'
           AND t.lease_owner = ? AND t.lease_token = ? AND t.lease_expires_at > ?`
      )
      .get(input.taskId, input.owner, input.leaseToken, nowIso) as RawTaskRow | undefined;
    if (!row) return { applied: false };
    const info = database
      .prepare(
        `UPDATE sec_ingest_tasks SET status = 'retry_wait', next_retry_at = ?,
           stage_attempts = CASE WHEN stage_attempts > 0 THEN stage_attempts - 1 ELSE 0 END,
           lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
           last_error_type = ?, last_error = ?, last_error_json = NULL, updated_at = ?
         WHERE id = ? AND status = 'leased' AND lease_owner = ? AND lease_token = ?`
      )
      .run(nextRetryAt, reasonType, reason, nowIso, input.taskId, input.owner, input.leaseToken);
    if (info.changes !== 1) return { applied: false };
    const attempt = database
      .prepare(
        `UPDATE sec_ingest_task_attempts
         SET outcome = 'retry_wait', finished_at = ?, error_type = ?, error = ?, receipt_json = ?
         WHERE task_id = ? AND lease_token = ? AND lease_owner = ? AND outcome = 'claimed'`
      )
      .run(
        nowIso,
        reasonType,
        reason,
        input.receipt === undefined ? null : stableSecIngestJson(input.receipt),
        input.taskId,
        input.leaseToken,
        input.owner
      );
    if (attempt.changes !== 1) throw new Error("SEC ingest claim has no matching attempt receipt");
    database.prepare("UPDATE sec_ingest_jobs SET updated_at = ? WHERE id = ?").run(nowIso, row.job_id);
    return { applied: true, status: "retry_wait", nextRetryAt };
  });
  return defer.immediate() as SecIngestFailureResult;
}

/**
 * Park a leased task so the next tick can reclaim it immediately and continue
 * in-stage work (FTS mirror slices).  Unlike `deferSecIngestTask` this does
 * NOT clamp retry to now+60s — a 933-chunk filing is ~47 slices, and a 60s
 * pause between them would add ~47 minutes of idle queue time.
 *
 * Stage attempt is refunded (same reason as defer): slice-yields must not
 * march a healthy filing toward dead_letter (`max_stage_attempts` is 6).
 * Attempt outcome stays `retry_wait` (existing CHECK); the receipt carries
 * the durable FTS offset.
 */
export function releaseSecIngestTaskForResume(input: {
  taskId: string;
  owner: string;
  leaseToken: string;
  reasonType: string;
  reason: string;
  receipt?: Record<string, unknown>;
  now?: Date;
}): SecIngestFailureResult {
  const reasonType = requiredTerminalReason(input.reasonType, "reasonType");
  const reason = requiredTerminalReason(input.reason, "reason");
  const database = getDb();
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const release = database.transaction((): SecIngestFailureResult => {
    const row = database
      .prepare(
        `SELECT t.* FROM sec_ingest_tasks t
         JOIN sec_ingest_jobs j ON j.id = t.job_id
         WHERE t.id = ? AND j.status = 'running' AND t.status = 'leased'
           AND t.lease_owner = ? AND t.lease_token = ? AND t.lease_expires_at > ?`
      )
      .get(input.taskId, input.owner, input.leaseToken, nowIso) as RawTaskRow | undefined;
    if (!row) return { applied: false };
    const info = database
      .prepare(
        `UPDATE sec_ingest_tasks SET status = 'retry_wait', next_retry_at = ?,
           stage_attempts = CASE WHEN stage_attempts > 0 THEN stage_attempts - 1 ELSE 0 END,
           lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
           last_error_type = ?, last_error = ?, last_error_json = NULL, updated_at = ?
         WHERE id = ? AND status = 'leased' AND lease_owner = ? AND lease_token = ?`
      )
      .run(nowIso, reasonType, reason, nowIso, input.taskId, input.owner, input.leaseToken);
    if (info.changes !== 1) return { applied: false };
    const attempt = database
      .prepare(
        `UPDATE sec_ingest_task_attempts
         SET outcome = 'retry_wait', finished_at = ?, error_type = ?, error = ?, receipt_json = ?
         WHERE task_id = ? AND lease_token = ? AND lease_owner = ? AND outcome = 'claimed'`
      )
      .run(
        nowIso,
        reasonType,
        reason,
        input.receipt === undefined ? null : stableSecIngestJson(input.receipt),
        input.taskId,
        input.leaseToken,
        input.owner
      );
    if (attempt.changes !== 1) throw new Error("SEC ingest claim has no matching attempt receipt");
    database.prepare("UPDATE sec_ingest_jobs SET updated_at = ? WHERE id = ?").run(nowIso, row.job_id);
    return { applied: true, status: "retry_wait", nextRetryAt: nowIso };
  });
  return release.immediate() as SecIngestFailureResult;
}

/**
 * Operator requeue: put dead-lettered tasks back in play with a fresh stage-attempt budget and
 * reopen their `complete_with_errors` jobs so the worker will claim them again. For recovery
 * after an infra-level cause (EDGAR access block, a since-fixed bug) buried healthy filings —
 * dead-letter is meant for per-task poison, not for fleet-wide outages. Optionally scoped by
 * jobIds and/or a LIKE pattern on last_error_type.
 */
export function requeueSecIngestDeadLetters(
  options: { jobIds?: string[]; errorTypeLike?: string; errorLike?: string; now?: Date } = {}
): { requeuedTasks: number; reopenedJobs: number } {
  const database = getDb();
  const nowIso = (options.now ?? new Date()).toISOString();
  const run = database.transaction(() => {
    const params: unknown[] = [];
    let where = "status = 'dead_letter'";
    if (options.jobIds && options.jobIds.length > 0) {
      where += ` AND job_id IN (${options.jobIds.map(() => "?").join(",")})`;
      params.push(...options.jobIds);
    }
    if (options.errorTypeLike) {
      where += " AND COALESCE(last_error_type, '') LIKE ?";
      params.push(options.errorTypeLike);
    }
    if (options.errorLike) {
      where += " AND COALESCE(last_error, '') LIKE ?";
      params.push(options.errorLike);
    }
    const jobRows = database
      .prepare(`SELECT DISTINCT job_id FROM sec_ingest_tasks WHERE ${where}`)
      .all(...params) as Array<{ job_id: string }>;
    const info = database
      .prepare(
        `UPDATE sec_ingest_tasks
         SET status = 'retry_wait', stage_attempts = 0, next_retry_at = ?,
             lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
             updated_at = ?
         WHERE ${where}`
      )
      .run(nowIso, nowIso, ...params);
    let reopenedJobs = 0;
    for (const row of jobRows) {
      // complete_with_errors is terminal in JOB_TRANSITIONS by design (nothing may silently
      // reopen a closed job). Requeue is the one deliberate operator exception, so it updates
      // directly rather than widening the shared transition map for every caller.
      const reopened = database
        .prepare(
          `UPDATE sec_ingest_jobs SET status = 'running', completed_at = NULL, updated_at = ?
           WHERE id = ? AND status = 'complete_with_errors'`
        )
        .run(nowIso, row.job_id);
      reopenedJobs += reopened.changes;
    }
    return { requeuedTasks: info.changes, reopenedJobs };
  });
  return run.immediate() as { requeuedTasks: number; reopenedJobs: number };
}

export function terminalizeSecIngestTask(input: {
  taskId: string;
  owner: string;
  leaseToken: string;
  status: "dead_letter" | "quarantined" | "superseded";
  reasonType: string;
  reason: string;
  details?: unknown;
  receipt?: Record<string, unknown>;
  now?: Date;
}): boolean {
  const reasonType = requiredTerminalReason(input.reasonType, "reasonType");
  const reason = requiredTerminalReason(input.reason, "reason");
  const database = getDb();
  const nowIso = (input.now ?? new Date()).toISOString();
  const terminalize = database.transaction(() => {
    const info = database
      .prepare(
        `UPDATE sec_ingest_tasks SET status = ?, next_retry_at = NULL,
           lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
           last_error_type = ?, last_error = ?, last_error_json = ?, updated_at = ?
         WHERE id = ? AND status = 'leased' AND lease_owner = ? AND lease_token = ?
           AND lease_expires_at > ?
           AND EXISTS (
             SELECT 1 FROM sec_ingest_jobs
             WHERE id = sec_ingest_tasks.job_id AND status = 'running'
           )`
      )
      .run(
        input.status,
        reasonType,
        reason,
        input.details === undefined ? null : stableSecIngestJson(input.details),
        nowIso,
        input.taskId,
        input.owner,
        input.leaseToken,
        nowIso
      );
    if (info.changes !== 1) return false;
    const attempt = database
      .prepare(
        `UPDATE sec_ingest_task_attempts
         SET outcome = ?, finished_at = ?, error_type = ?, error = ?, receipt_json = ?
         WHERE task_id = ? AND lease_token = ? AND lease_owner = ? AND outcome = 'claimed'`
      )
      .run(
        input.status,
        nowIso,
        reasonType,
        reason,
        input.receipt === undefined ? null : stableSecIngestJson(input.receipt),
        input.taskId,
        input.leaseToken,
        input.owner
      );
    if (attempt.changes !== 1) throw new Error("SEC ingest claim has no matching attempt receipt");
    database.prepare("UPDATE sec_ingest_jobs SET updated_at = ? WHERE id = (SELECT job_id FROM sec_ingest_tasks WHERE id = ?)").run(nowIso, input.taskId);
    return true;
  });
  return terminalize.immediate() as boolean;
}

export interface SecIngestJobReceipt {
  job: SecIngestJob;
  totalTasks: number;
  byStatus: Record<SecIngestTaskStatus, number>;
  observedBytes: number;
  observedTokens: number;
  observedChunks: number;
  observedVectors: number;
  observedWriteUnits: number;
  observedCostUsd: number;
}

export function getSecIngestJobReceipt(jobId: string): SecIngestJobReceipt | null {
  const job = getSecIngestJob(jobId);
  if (!job) return null;
  const byStatus: Record<SecIngestTaskStatus, number> = {
    pending: 0,
    leased: 0,
    retry_wait: 0,
    complete: 0,
    dead_letter: 0,
    quarantined: 0,
    superseded: 0
  };
  const rows = getDb()
    .prepare("SELECT status, COUNT(*) AS n FROM sec_ingest_tasks WHERE job_id = ? GROUP BY status")
    .all(jobId) as Array<{ status: SecIngestTaskStatus; n: number }>;
  for (const row of rows) byStatus[row.status] = row.n;
  const totals = getDb()
    .prepare(
      `SELECT COUNT(*) AS total_tasks,
              COALESCE(SUM(observed_bytes), 0) AS observed_bytes,
              COALESCE(SUM(observed_tokens), 0) AS observed_tokens,
              COALESCE(SUM(observed_chunks), 0) AS observed_chunks,
              COALESCE(SUM(observed_vectors), 0) AS observed_vectors,
              COALESCE(SUM(observed_write_units), 0) AS observed_write_units,
              COALESCE(SUM(observed_cost_usd), 0) AS observed_cost_usd
       FROM sec_ingest_tasks WHERE job_id = ?`
    )
    .get(jobId) as {
    total_tasks: number;
    observed_bytes: number;
    observed_tokens: number;
    observed_chunks: number;
    observed_vectors: number;
    observed_write_units: number;
    observed_cost_usd: number;
  };
  return {
    job,
    totalTasks: totals.total_tasks,
    byStatus,
    observedBytes: totals.observed_bytes,
    observedTokens: totals.observed_tokens,
    observedChunks: totals.observed_chunks,
    observedVectors: totals.observed_vectors,
    observedWriteUnits: totals.observed_write_units,
    observedCostUsd: totals.observed_cost_usd
  };
}

export function reconcileSecIngestJob(jobId: string, now = new Date().toISOString()): SecIngestJobStatus | null {
  const database = getDb();
  const reconcile = database.transaction((): SecIngestJobStatus | null => {
    const receipt = getSecIngestJobReceipt(jobId);
    if (!receipt) return null;
    if (receipt.job.status !== "running") return receipt.job.status;
    if (!receipt.job.intakeClosedAt) return receipt.job.status;
    if (receipt.job.expectedTasks !== receipt.totalTasks) return receipt.job.status;
    const active = receipt.byStatus.pending + receipt.byStatus.leased + receipt.byStatus.retry_wait;
    if (active > 0) return receipt.job.status;
    const hasErrors = receipt.byStatus.dead_letter > 0 || receipt.byStatus.quarantined > 0;
    const next: SecIngestJobStatus = hasErrors ? "complete_with_errors" : "complete";
    const info = database
      .prepare(
        `UPDATE sec_ingest_jobs SET status = ?, updated_at = ?, completed_at = ?
         WHERE id = ? AND status = 'running' AND intake_closed_at IS NOT NULL`
      )
      .run(next, now, now, jobId);
    return info.changes === 1 ? next : receipt.job.status;
  });
  return reconcile.immediate() as SecIngestJobStatus | null;
}
