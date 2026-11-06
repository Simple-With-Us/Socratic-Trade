// Crash-durable replay of Socratic-Trade's local usage ledgers into API Usage Monitor.
//
// LLM live writes still enqueue immediately through usage-monitor-push.ts.  RAG and provider-dispatch
// rows are NOT live-pushed: this worker is their only path, as one summed row per closed window
// (see "Windowed rollup lanes" below).  For the LLM ledger this worker closes the
// durability gap left by a process crash: it reconstructs events from llm_usage using
// each row's existing ID + timestamp, and advances an ordered settings-table watermark only after
// the monitor acknowledges the batch. Once a lane has ACKed its first strict-v2 row, every run
// inclusively re-sends the prior watermark row, so a crash between remote acknowledgement and the
// local watermark write is harmless (the receiver dedupes the deterministic v2 identity).

import {
  audit,
  getDb,
  reconcileStaleProviderDispatches,
} from "./db";
import {
  ackCallVolumeWindows,
  createCallVolumeUsageMonitorEvent,
  createLlmUsageMonitorEvent,
  createProviderDispatchRollupUsageMonitorEvent,
  createRagRollupUsageMonitorEvent,
  loadPersistedCallVolumeWindows,
  sendUsageMonitorBatch,
  usageMonitorEnabled,
  usageMonitorV2IdempotencyKey,
  type UsageMonitorEvent,
} from "./usage-monitor-push";

const REPLAY_INTERVAL_MS = 60_000;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES_PER_LEDGER = 10;

export const USAGE_MONITOR_REPLAY_WATERMARK_KEYS = {
  llm: "usage_monitor_replay:llm_usage:watermark:v1",
  rag: "usage_monitor_replay:rag_usage:watermark:v1",
  provider: "usage_monitor_replay:provider_usage_outbox:watermark:v1",
} as const;

export const USAGE_MONITOR_REPLAY_V2_CUTOVER_KEYS = {
  llm: "usage_monitor_replay:llm_usage:strict_v2_cutover:v1",
  rag: "usage_monitor_replay:rag_usage:strict_v2_cutover:v1",
  provider: "usage_monitor_replay:provider_usage_outbox:strict_v2_cutover:v1",
} as const;

interface ReplayCursor {
  createdAt: string;
  id: string;
}

interface LlmUsageLedgerRow {
  id: string;
  user_id: string;
  provider: string;
  model: string | null;
  context: string;
  key_source: string;
  key_ref: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  cost_usd: number | null;
  cost_source: string | null;
  latency_ms: number | null;
  status: string | null;
  cached_prompt_tokens: number | null;
  cache_creation_tokens: number | null;
  cache_creation_1h_tokens: number | null;
  reasoning_tokens: number | null;
  served_model: string | null;
  request_count: number | null;
  created_at: string;
}

interface LedgerReplayResult {
  sent: number;
  complete: boolean;
  failed: boolean;
}

export interface UsageMonitorReplayResult {
  configured: boolean;
  llm: LedgerReplayResult;
  rag: LedgerReplayResult;
  provider: LedgerReplayResult;
  /** Settings-backed call-volume windows drained after a crash (not a ledger watermark). */
  callVolume: LedgerReplayResult;
}

export interface UsageMonitorReplayOptions {
  /** Test seam: the clock used to decide which rollup windows are closed. */
  nowMs?: number;
  /** Test/maintenance override of the rollup window width (default 10 minutes). */
  rollupWindowMs?: number;
  /** Test/maintenance override of the grace after a window ends before it is sent (default 60 s). */
  rollupGraceMs?: number;
  /** Test/maintenance override; production uses the ingest contract's 100-event maximum. */
  pageSize?: number;
  /** Bounds one startup/interval pass so a large historical ledger drains without a request burst. */
  maxPagesPerLedger?: number;
}

interface ReplayState {
  version: number;
  timer: ReturnType<typeof setInterval> | null;
  inFlight: Promise<UsageMonitorReplayResult> | null;
}

const replayHost = globalThis as unknown as { __usageMonitorReplay?: ReplayState };
// Bump when replay semantics change so HMR cannot retain an older timer/in-flight worker across an
// identity migration. v3 installs the atomic direct-v2 cutover before any replay/producer work.
const REPLAY_STATE_VERSION = 3;
const priorReplayState = replayHost.__usageMonitorReplay;
if (priorReplayState && priorReplayState.version !== REPLAY_STATE_VERSION && priorReplayState.timer) {
  clearInterval(priorReplayState.timer);
}
const replayState: ReplayState =
  priorReplayState && priorReplayState.version === REPLAY_STATE_VERSION
    ? priorReplayState
    : (replayHost.__usageMonitorReplay = {
        version: REPLAY_STATE_VERSION,
        timer: null,
        inFlight: null,
      });

function positiveInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return fallback;
  return Math.min(value, maximum);
}

function emptyLedgerResult(): LedgerReplayResult {
  return { sent: 0, complete: true, failed: false };
}

function parseCursor(raw: string | undefined): ReplayCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ReplayCursor>;
    if (
      typeof parsed.createdAt !== "string" || parsed.createdAt.length === 0 ||
      typeof parsed.id !== "string" || parsed.id.length === 0 ||
      !Number.isFinite(Date.parse(parsed.createdAt)) ||
      new Date(parsed.createdAt).toISOString() !== parsed.createdAt
    ) return null;
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    return null;
  }
}

function compareCursors(a: ReplayCursor, b: ReplayCursor): number {
  if (a.createdAt < b.createdAt) return -1;
  if (a.createdAt > b.createdAt) return 1;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

function readWatermark(key: string): ReplayCursor | null {
  const row = getDb()
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return parseCursor(row?.value);
}

type ReplayLane = keyof typeof USAGE_MONITOR_REPLAY_WATERMARK_KEYS;
type V2CutoverState = "v2-seeded" | "v2-active";
type PreparedV2Cutover = V2CutoverState | "invalid";

const REPLAY_TABLES: Record<ReplayLane, string> = {
  llm: "llm_usage",
  rag: "rag_usage",
  provider: "provider_usage_outbox",
};

function skippedPreV2RowsKey(v2CutoverKey: string): string {
  return `${v2CutoverKey}:pre_v2_rows_skipped`;
}

function countRowsAfterCursor(table: string, cursor: ReplayCursor | null): number {
  if (!cursor) {
    const row = getDb().prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
    return row.count;
  }
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS count FROM ${table} WHERE ` +
      "created_at > ? OR (created_at = ? AND id > ?)"
    )
    .get(cursor.createdAt, cursor.createdAt, cursor.id) as { count: number };
  return row.count;
}

/**
 * One atomic direct-v2 cutover for all ledgers, before any await or producer reconciliation.
 * Existing rows are intentionally not replayed across the identity boundary: most were already
 * live-pushed under v1, and the owner accepted bounded loss of any unacknowledged remainder in
 * preference to duplicate money. The skipped-row count is retained as a durable rollout receipt.
 */
function prepareV2ReplayCutovers(): Record<ReplayLane, PreparedV2Cutover> {
  const database = getDb();
  const prepared = {} as Record<ReplayLane, PreparedV2Cutover>;
  const prepare = database.transaction(() => {
    const now = new Date().toISOString();
    const snapshots = {} as Record<ReplayLane, {
      marker: string | undefined;
      watermark: ReplayCursor | null;
      invalid: boolean;
    }>;

    // Validate every lane first. If even one seed candidate is corrupt, the transaction performs
    // zero cutover writes so it cannot leave a partially initialized cross-ledger boundary.
    for (const lane of Object.keys(REPLAY_TABLES) as ReplayLane[]) {
      const watermarkKey = USAGE_MONITOR_REPLAY_WATERMARK_KEYS[lane];
      const cutoverKey = USAGE_MONITOR_REPLAY_V2_CUTOVER_KEYS[lane];
      const markerRow = database
        .prepare("SELECT value FROM settings WHERE key = ?")
        .get(cutoverKey) as { value: string } | undefined;
      const watermarkRow = database
        .prepare("SELECT value FROM settings WHERE key = ?")
        .get(watermarkKey) as { value: string } | undefined;
      const watermark = parseCursor(watermarkRow?.value);
      const corruptWatermark = Boolean(watermarkRow && !watermark);
      const marker = markerRow?.value;
      const invalidMarker = marker !== undefined && marker !== "v2-active" && marker !== "v2-seeded";
      const seededWithoutCursor = marker === "v2-seeded" && !watermark;
      snapshots[lane] = {
        marker,
        watermark,
        invalid: corruptWatermark || invalidMarker || seededWithoutCursor,
      };
    }

    if ((Object.values(snapshots) as Array<{ invalid: boolean }>).some((lane) => lane.invalid)) {
      for (const lane of Object.keys(REPLAY_TABLES) as ReplayLane[]) {
        const snapshot = snapshots[lane];
        prepared[lane] = !snapshot.invalid &&
          (snapshot.marker === "v2-active" || snapshot.marker === "v2-seeded")
          ? snapshot.marker
          : "invalid";
      }
      return;
    }

    for (const lane of Object.keys(REPLAY_TABLES) as ReplayLane[]) {
      const watermarkKey = USAGE_MONITOR_REPLAY_WATERMARK_KEYS[lane];
      const cutoverKey = USAGE_MONITOR_REPLAY_V2_CUTOVER_KEYS[lane];
      const snapshot = snapshots[lane];
      if (snapshot.marker === "v2-active" || snapshot.marker === "v2-seeded") {
        prepared[lane] = snapshot.marker;
        continue;
      }

      const priorCursor = snapshot.watermark;
      const highWatermark = latestCursor(REPLAY_TABLES[lane]);
      const seededCursor = !priorCursor
        ? highWatermark
        : !highWatermark || compareCursors(priorCursor, highWatermark) >= 0
          ? priorCursor
          : highWatermark;
      if (seededCursor) {
        database
          .prepare(
            "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) " +
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
          )
          .run(watermarkKey, JSON.stringify(seededCursor), now);
      }
      const state: V2CutoverState = seededCursor ? "v2-seeded" : "v2-active";
      database
        .prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
        .run(cutoverKey, state, now);
      database
        .prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
        .run(
          skippedPreV2RowsKey(cutoverKey),
          String(countRowsAfterCursor(REPLAY_TABLES[lane], priorCursor)),
          now
        );
      prepared[lane] = state;
    }
  });
  prepare.immediate();
  return prepared;
}

/** Monotonic BEGIN IMMEDIATE update prevents overlapping app processes from regressing a cursor. */
function advanceWatermark(
  key: string,
  v2CutoverKey: string,
  candidate: ReplayCursor
): ReplayCursor {
  const database = getDb();
  const advance = database.transaction((): ReplayCursor => {
    const row = database
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(key) as { value: string } | undefined;
    const current = parseCursor(row?.value);
    const now = new Date().toISOString();
    const result = current && compareCursors(current, candidate) >= 0 ? current : candidate;
    if (result === candidate) {
      database
        .prepare(
          "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
        )
        .run(key, JSON.stringify(candidate), now);
    }
    database
      .prepare(
        "INSERT INTO settings (key, value, updated_at) VALUES (?, 'v2-active', ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
      )
      .run(v2CutoverKey, now);
    return result;
  });
  return advance.immediate() as ReplayCursor;
}

function cursorClause(inclusive: boolean): string {
  return inclusive
    ? "created_at > ? OR (created_at = ? AND id >= ?)"
    : "created_at > ? OR (created_at = ? AND id > ?)";
}

function upperBoundClause(): string {
  return "created_at < ? OR (created_at = ? AND id <= ?)";
}

function latestCursor(table: string): ReplayCursor | null {
  const row = getDb()
    .prepare(
      `SELECT id, created_at AS createdAt FROM ${table} ` +
        "ORDER BY created_at DESC, id DESC LIMIT 1"
    )
    .get() as ReplayCursor | undefined;
  return row ?? null;
}

function readLlmRows(
  cursor: ReplayCursor | null,
  inclusive: boolean,
  limit: number,
  upperBound: ReplayCursor | null = null
): LlmUsageLedgerRow[] {
  const columns =
    "id, user_id, provider, model, context, key_source, key_ref, prompt_tokens, " +
    "completion_tokens, total_tokens, cost_usd, cost_source, latency_ms, status, " +
    "cached_prompt_tokens, cache_creation_tokens, cache_creation_1h_tokens, reasoning_tokens, " +
    "served_model, request_count, created_at";
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (cursor) {
    clauses.push(`(${cursorClause(inclusive)})`);
    params.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  if (upperBound) {
    clauses.push(`(${upperBoundClause()})`);
    params.push(upperBound.createdAt, upperBound.createdAt, upperBound.id);
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  return getDb()
    .prepare(`SELECT ${columns} FROM llm_usage${where} ORDER BY created_at ASC, id ASC LIMIT ?`)
    .all(...params, limit) as LlmUsageLedgerRow[];
}

function optionalFinite(value: number | null): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** One ledger row paired with the exact event built from it, so a monitor-named collision key
 *  can be mapped back to the precise row to skip. */
interface RowEventPair<Row> {
  row: Row;
  event: UsageMonitorEvent;
}

async function llmEvents(rows: LlmUsageLedgerRow[]): Promise<RowEventPair<LlmUsageLedgerRow>[]> {
  return Promise.all(
    rows.map(async (row) => ({
      row,
      event: await createLlmUsageMonitorEvent({
        sourceEventId: row.id,
        occurredAt: row.created_at,
        provider: row.provider,
        model: row.model ?? undefined,
        context: row.context,
        userId: row.user_id,
        keySource: row.key_source,
        keyRef: row.key_ref ?? undefined,
        promptTokens: optionalFinite(row.prompt_tokens),
        completionTokens: optionalFinite(row.completion_tokens),
        totalTokens: optionalFinite(row.total_tokens),
        costUsd: optionalFinite(row.cost_usd),
        costSource: row.cost_source,
        cachedPromptTokens: optionalFinite(row.cached_prompt_tokens),
        cacheCreationTokens: optionalFinite(row.cache_creation_tokens),
        cacheCreation1hTokens: optionalFinite(row.cache_creation_1h_tokens),
        reasoningTokens: optionalFinite(row.reasoning_tokens),
        servedModel: row.served_model ?? undefined,
        latencyMs: optionalFinite(row.latency_ms),
        status: row.status ?? undefined,
        requestCount: optionalFinite(row.request_count),
      })
    }))
  );
}

// ── Windowed rollup lanes (rag, provider-dispatch) ──────────────────────────────
//
// These two ledgers were sent one monitor row per ledger row, by the live push AND this replay
// (same key, so the second send was a counted duplicate), and made up 86% of Socratic-Trade's
// ~9,600 rows/day.  They now reach the monitor only here, as ONE summed row per closed window
// and group.  Every numeric field is additive and every categorical field is constant inside a
// group, so totals are exact.  A window is sent only after it has ended plus a grace period, from
// the durable ledger, so it is immutable: the same window always rebuilds the byte-identical event
// (same key, same content) and a crash between the ACK and the watermark write is harmless.  The
// monitor 409s a changed resend, so a window is never re-sent with different totals.

const DEFAULT_ROLLUP_WINDOW_MS = 10 * 60_000;
const DEFAULT_ROLLUP_GRACE_MS = 60_000;
const MAX_ROLLUP_WINDOWS_PER_PASS = 12;
const MAX_EVENTS_PER_POST = 100;

/** Self-hosted Qdrant rows carry no cost and a record count mislabelled as tokens: not reported. */
const ROLLUP_EXCLUDED_RAG_PROVIDERS = ["qdrant"] as const;

function rollupMs(override: number | undefined, envName: string, fallback: number): number {
  if (typeof override === "number" && Number.isFinite(override) && override > 0) return Math.floor(override);
  const fromEnv = Number(process.env[envName]);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? Math.floor(fromEnv) : fallback;
}

function rollupRoleKey(lane: "rag"): string {
  return `usage_monitor_replay:${REPLAY_TABLES[lane]}:rollup_cutover:v1`;
}

/**
 * First start of the RAG rollup: rag rows were live-pushed per-row, so rows already delivered must
 * not be counted again inside a first window; seed the watermark to the newest existing row.  Same
 * bounded-loss trade the v2 identity cutover made (owner-accepted), preferred to duplicate totals.
 * Runs synchronously right after the v2 cutover and BEFORE any await, so rows written while the LLM
 * replay awaits the network are not swallowed by a later seed.  The provider-dispatch lane is NOT
 * seeded: it never had a live push, so rows past its old watermark were never delivered and the
 * rollup is their first (and only) copy.  This assumes the old build has stopped (Coolify stops the
 * old container before starting the new one); an old process still live-pushing rag rows would be
 * double counted for the overlap.
 */
function prepareRollupCutover(lane: "rag"): void {
  const database = getDb();
  const watermarkKey = USAGE_MONITOR_REPLAY_WATERMARK_KEYS[lane];
  const markerKey = rollupRoleKey(lane);
  database.transaction(() => {
    const marker = database.prepare("SELECT value FROM settings WHERE key = ?").get(markerKey);
    if (marker) return;
    const now = new Date().toISOString();
    const high = latestCursor(REPLAY_TABLES[lane]);
    const current = readWatermark(watermarkKey);
    if (high && (!current || compareCursors(current, high) < 0)) {
      database
        .prepare(
          "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
        )
        .run(watermarkKey, JSON.stringify(high), now);
    }
    database
      .prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, 'rollup-active', ?)")
      .run(markerKey, now);
  }).immediate();
}

function afterCursorSql(cursor: ReplayCursor | null): { sql: string; params: string[] } {
  return cursor
    ? { sql: " AND (created_at > ? OR (created_at = ? AND id > ?))", params: [cursor.createdAt, cursor.createdAt, cursor.id] }
    : { sql: "", params: [] };
}

function firstRowAfter(table: string, cursor: ReplayCursor | null): ReplayCursor | null {
  const after = afterCursorSql(cursor);
  const row = getDb()
    .prepare(`SELECT id, created_at AS createdAt FROM ${table} WHERE 1=1${after.sql} ORDER BY created_at ASC, id ASC LIMIT 1`)
    .get(...after.params) as ReplayCursor | undefined;
  return row ?? null;
}

function lastRowInWindow(table: string, startIso: string, endIso: string, cursor: ReplayCursor | null): ReplayCursor | null {
  const after = afterCursorSql(cursor);
  const row = getDb()
    .prepare(
      `SELECT id, created_at AS createdAt FROM ${table} WHERE created_at >= ? AND created_at < ?${after.sql} ` +
      "ORDER BY created_at DESC, id DESC LIMIT 1"
    )
    .get(startIso, endIso, ...after.params) as ReplayCursor | undefined;
  return row ?? null;
}

interface RagRollupGroup {
  provider: string;
  operation: string;
  user_id: string;
  model: string | null;
  rows: number;
  tokens_in: number;
  tokens_out: number;
  batch_count: number;
  cost_usd: number | null;
}

async function ragWindowEvents(startIso: string, endIso: string, cursor: ReplayCursor | null): Promise<UsageMonitorEvent[]> {
  const after = afterCursorSql(cursor);
  const excluded = ROLLUP_EXCLUDED_RAG_PROVIDERS.map(() => "?").join(", ");
  const groups = getDb()
    .prepare(
      "SELECT provider, operation, user_id, model, COUNT(*) AS rows, " +
      "SUM(COALESCE(tokens_in, 0)) AS tokens_in, SUM(COALESCE(tokens_out, 0)) AS tokens_out, " +
      "SUM(COALESCE(batch_count, 0)) AS batch_count, SUM(cost_est_usd) AS cost_usd " +
      `FROM rag_usage WHERE created_at >= ? AND created_at < ? AND provider NOT IN (${excluded})${after.sql} ` +
      "GROUP BY provider, operation, user_id, model " +
      "ORDER BY provider, operation, user_id, COALESCE(model, '')"
    )
    .all(startIso, endIso, ...ROLLUP_EXCLUDED_RAG_PROVIDERS, ...after.params) as RagRollupGroup[];
  return Promise.all(
    groups.map((group) =>
      createRagRollupUsageMonitorEvent({
        windowStart: startIso,
        windowEnd: endIso,
        requests: group.rows,
        provider: group.provider,
        operation: group.operation,
        model: group.model ?? undefined,
        userId: group.user_id,
        tokensIn: group.tokens_in,
        tokensOut: group.tokens_out,
        batchCount: group.batch_count,
        costUsd: optionalFinite(group.cost_usd),
      })
    )
  );
}

interface ProviderRollupGroup {
  provider: string;
  operation: string;
  credential_ref: string;
  user_id: string;
  outcome: "succeeded" | "failed" | "unknown";
  units: number;
}

async function providerWindowEvents(startIso: string, endIso: string, cursor: ReplayCursor | null): Promise<UsageMonitorEvent[]> {
  const after = afterCursorSql(cursor);
  const groups = getDb()
    .prepare(
      "SELECT provider, operation, credential_ref, user_id, outcome, SUM(COALESCE(requests, 1)) AS units " +
      `FROM provider_usage_outbox WHERE created_at >= ? AND created_at < ?${after.sql} ` +
      "GROUP BY provider, operation, credential_ref, user_id, outcome " +
      "ORDER BY provider, operation, credential_ref, user_id, outcome"
    )
    .all(startIso, endIso, ...after.params) as ProviderRollupGroup[];
  // Retired provider families return null; they are dropped here but the watermark still advances.
  const built = await Promise.all(
    groups.map((group) =>
      createProviderDispatchRollupUsageMonitorEvent({
        windowStart: startIso,
        windowEnd: endIso,
        provider: group.provider,
        operation: group.operation,
        credentialRef: group.credential_ref,
        userId: group.user_id,
        outcome: group.outcome,
        requests: group.units,
      })
    )
  );
  return built.filter((event): event is UsageMonitorEvent => event !== null);
}

/** Send one window's events (chunked to the ingest cap), skipping a key the monitor already holds. */
async function sendWindowEvents(events: UsageMonitorEvent[], watermarkKey: string, windowStart: string): Promise<boolean> {
  for (let offset = 0; offset < events.length; offset += MAX_EVENTS_PER_POST) {
    const pending = events
      .slice(offset, offset + MAX_EVENTS_PER_POST)
      .map((event) => ({ row: { id: event.eventId, created_at: windowStart }, event }));
    let collisionSkips = 0;
    for (;;) {
      let collisionKey: string | null = null;
      const acknowledged = await sendUsageMonitorBatch(
        pending.map((pair) => pair.event),
        { onIdempotencyCollision: (key) => { collisionKey = key; } }
      );
      if (acknowledged) break;
      if (!collisionKey || collisionSkips >= MAX_COLLISION_SKIPS_PER_PAGE) return false;
      const index = await findCollisionPairIndex(pending, collisionKey);
      if (index === -1) return false;
      const [skipped] = pending.splice(index, 1);
      collisionSkips += 1;
      console.warn(
        `[usage-monitor-replay] skipping rollup ${skipped.row.id} (${watermarkKey}): ` +
        `monitor already holds idempotency key ${collisionKey} (prior-delivery collision).`
      );
      audit(
        "usage_monitor_replay_collision_skip",
        { watermarkKey, rowId: skipped.row.id, rowCreatedAt: windowStart, idempotencyKey: collisionKey },
        "local"
      );
      if (pending.length === 0) break;
    }
  }
  return true;
}

async function replayRolledLane(input: {
  table: string;
  watermarkKey: string;
  v2CutoverKey: string;
  cutoverState: PreparedV2Cutover;
  nowMs: number;
  windowMs: number;
  graceMs: number;
  buildEvents: (startIso: string, endIso: string, cursor: ReplayCursor | null) => Promise<UsageMonitorEvent[]>;
}): Promise<LedgerReplayResult> {
  let sent = 0;
  try {
    if (input.cutoverState === "invalid") return { sent: 0, complete: false, failed: true };
    let cursor = readWatermark(input.watermarkKey);
    for (let windows = 0; windows < MAX_ROLLUP_WINDOWS_PER_PASS; windows += 1) {
      const first = firstRowAfter(input.table, cursor);
      if (!first) return { sent, complete: true, failed: false };
      const startMs = Math.floor(Date.parse(first.createdAt) / input.windowMs) * input.windowMs;
      const endMs = startMs + input.windowMs;
      // Still open (or inside the grace): nothing later can be closed either, and sending it now
      // would freeze totals that late rows could still change.
      if (input.nowMs < endMs + input.graceMs) return { sent, complete: true, failed: false };
      const startIso = new Date(startMs).toISOString();
      const endIso = new Date(endMs).toISOString();
      const last = lastRowInWindow(input.table, startIso, endIso, cursor);
      if (!last) return { sent, complete: true, failed: false };
      const events = await input.buildEvents(startIso, endIso, cursor);
      if (!(await sendWindowEvents(events, input.watermarkKey, startIso))) {
        return { sent, complete: false, failed: true };
      }
      cursor = advanceWatermark(input.watermarkKey, input.v2CutoverKey, last);
      sent += events.length;
    }
    return { sent, complete: false, failed: false };
  } catch {
    return { sent, complete: false, failed: true };
  }
}

/**
 * Bound on collision-skip retries within one page: each 409 names exactly one key, so a page
 * with several poison rows needs one resend per poison row. Beyond this cap the pass fails and
 * the next interval continues — the skip is audited per row, never silent.
 */
const MAX_COLLISION_SKIPS_PER_PAGE = 25;

/** Index of the pair whose event the monitor named in a 409 collision, or -1 when none matches. */
async function findCollisionPairIndex<Row>(
  pairs: RowEventPair<Row>[],
  collisionKey: string
): Promise<number> {
  const keys = await Promise.all(pairs.map((pair) => usageMonitorV2IdempotencyKey(pair.event.eventId)));
  return keys.findIndex((key) => key === collisionKey);
}

async function replayLedger<Row extends { id: string; created_at: string }>(input: {
  watermarkKey: string;
  v2CutoverKey: string;
  cutoverState: PreparedV2Cutover;
  pageSize: number;
  maxPages: number;
  readRows: (
    cursor: ReplayCursor | null,
    inclusive: boolean,
    limit: number,
    upperBound?: ReplayCursor | null
  ) => Row[];
  toEvents: (rows: Row[]) => Promise<RowEventPair<Row>[]>;
}): Promise<LedgerReplayResult> {
  let sent = 0;
  try {
    if (input.cutoverState === "invalid") {
      return { sent: 0, complete: false, failed: true };
    }
    let cursor = readWatermark(input.watermarkKey);
    // A seeded cursor points at a row intentionally skipped across the v1 -> v2 identity boundary.
    // Keep it exclusive until a newer strict-v2 ACK moves the marker to v2-active; after that,
    // inclusive overlap is the normal crash-safe v2 retry behavior.
    let inclusive = cursor !== null && input.cutoverState === "v2-active";

    for (let page = 0; page < input.maxPages; page += 1) {
      const rows = input.readRows(cursor, inclusive, input.pageSize);
      inclusive = false;
      if (rows.length === 0) {
        return { sent, complete: true, failed: false };
      }

      const pending = await input.toEvents(rows);
      // IDEMPOTENCY-COLLISION SELF-HEAL (prod incident 2026-07-28..30): the monitor answers a
      // batch containing a key it already holds with DIFFERENT content by 409-ing the WHOLE
      // batch. Pre-gitSha-strip events (see usage-monitor-push.ts) collide after every deploy,
      // which wedged the watermark behind one row and starved every newer row behind it. When
      // the monitor names the colliding key, that row's usage is already recorded monitor-side
      // (the collision IS proof of prior delivery), so skip exactly that row — audited — and
      // resend the rest instead of failing the page forever.
      let acknowledged = false;
      let collisionSkips = 0;
      for (;;) {
        let collisionKey: string | null = null;
        acknowledged = await sendUsageMonitorBatch(
          pending.map((pair) => pair.event),
          { onIdempotencyCollision: (key) => { collisionKey = key; } }
        );
        if (acknowledged) break;
        if (!collisionKey || collisionSkips >= MAX_COLLISION_SKIPS_PER_PAGE) {
          return { sent, complete: false, failed: true };
        }
        const index = await findCollisionPairIndex(pending, collisionKey);
        if (index === -1) {
          // The named key isn't in this page — nothing safe to skip; fail the pass as before.
          return { sent, complete: false, failed: true };
        }
        const [skipped] = pending.splice(index, 1);
        collisionSkips += 1;
        console.warn(
          `[usage-monitor-replay] skipping ledger row ${skipped.row.id} (${input.watermarkKey}): ` +
          `monitor already holds idempotency key ${collisionKey} (prior-delivery collision).`
        );
        audit(
          "usage_monitor_replay_collision_skip",
          {
            watermarkKey: input.watermarkKey,
            rowId: skipped.row.id,
            rowCreatedAt: skipped.row.created_at,
            idempotencyKey: collisionKey
          },
          "local"
        );
        if (pending.length === 0) {
          // Every row in the page was already monitor-side: treat the page as acknowledged so
          // the watermark advances past it.
          acknowledged = true;
          break;
        }
      }

      const last = rows.at(-1)!;
      cursor = advanceWatermark(input.watermarkKey, input.v2CutoverKey, {
        createdAt: last.created_at,
        id: last.id,
      });
      sent += rows.length;

      if (rows.length < input.pageSize) {
        return { sent, complete: true, failed: false };
      }
    }
    return { sent, complete: false, failed: false };
  } catch {
    // Replay is maintenance telemetry: a DB/crypto/network failure must never fail app startup.
    return { sent, complete: false, failed: true };
  }
}

async function executeUsageMonitorReplay(
  options: UsageMonitorReplayOptions
): Promise<UsageMonitorReplayResult> {
  if (!usageMonitorEnabled()) {
    return {
      configured: false,
      llm: emptyLedgerResult(),
      rag: emptyLedgerResult(),
      provider: emptyLedgerResult(),
      callVolume: emptyLedgerResult(),
    };
  }

  let cutovers: Record<ReplayLane, PreparedV2Cutover>;
  try {
    // This synchronous BEGIN IMMEDIATE is deliberately the first DB action in the configured lane.
    // All three identity boundaries exist before reconciliation, event construction, or network I/O.
    cutovers = prepareV2ReplayCutovers();
    prepareRollupCutover("rag");
  } catch {
    const failed = { sent: 0, complete: false, failed: true };
    return { configured: true, llm: failed, rag: failed, provider: failed, callVolume: failed };
  }

  // A prior process may have died after dispatch but before observing the provider outcome. Keep
  // the call in usage truth as `unknown`; never guess success/failure or silently release quota.
  reconcileStaleProviderDispatches();

  const pageSize = positiveInteger(options.pageSize, DEFAULT_PAGE_SIZE, DEFAULT_PAGE_SIZE);
  const maxPages = positiveInteger(options.maxPagesPerLedger, DEFAULT_MAX_PAGES_PER_LEDGER, 1_000);
  const llm = await replayLedger<LlmUsageLedgerRow>({
    watermarkKey: USAGE_MONITOR_REPLAY_WATERMARK_KEYS.llm,
    v2CutoverKey: USAGE_MONITOR_REPLAY_V2_CUTOVER_KEYS.llm,
    cutoverState: cutovers.llm,
    pageSize,
    maxPages,
    readRows: readLlmRows,
    toEvents: llmEvents,
  });
  const nowMs = typeof options.nowMs === "number" && Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const windowMs = rollupMs(options.rollupWindowMs, "USAGE_MONITOR_ROLLUP_WINDOW_MS", DEFAULT_ROLLUP_WINDOW_MS);
  const graceMs = rollupMs(options.rollupGraceMs, "USAGE_MONITOR_ROLLUP_GRACE_MS", DEFAULT_ROLLUP_GRACE_MS);
  let rag: LedgerReplayResult;
  let provider: LedgerReplayResult;
  try {
    rag = await replayRolledLane({
      table: REPLAY_TABLES.rag,
      watermarkKey: USAGE_MONITOR_REPLAY_WATERMARK_KEYS.rag,
      v2CutoverKey: USAGE_MONITOR_REPLAY_V2_CUTOVER_KEYS.rag,
      cutoverState: cutovers.rag,
      nowMs,
      windowMs,
      graceMs,
      buildEvents: ragWindowEvents,
    });
    provider = await replayRolledLane({
      table: REPLAY_TABLES.provider,
      watermarkKey: USAGE_MONITOR_REPLAY_WATERMARK_KEYS.provider,
      v2CutoverKey: USAGE_MONITOR_REPLAY_V2_CUTOVER_KEYS.provider,
      cutoverState: cutovers.provider,
      nowMs,
      windowMs,
      graceMs,
      buildEvents: providerWindowEvents,
    });
  } catch {
    const failed = { sent: 0, complete: false, failed: true };
    rag = failed;
    provider = failed;
  }
  const callVolume = await replayCallVolume();
  return { configured: true, llm, rag, provider, callVolume };
}

async function replayCallVolume(): Promise<LedgerReplayResult> {
  const windows = loadPersistedCallVolumeWindows();
  if (windows.length === 0) return emptyLedgerResult();
  try {
    const events = await Promise.all(windows.map((window) => createCallVolumeUsageMonitorEvent(window)));
    const ok = await sendUsageMonitorBatch(events);
    if (!ok) return { sent: 0, complete: false, failed: true };
    ackCallVolumeWindows(windows.map((window) => window.windowId));
    return { sent: windows.length, complete: true, failed: false };
  } catch {
    return { sent: 0, complete: false, failed: true };
  }
}

/** Run one bounded replay pass. Concurrent callers share the same in-process promise. */
export function runUsageMonitorReplay(
  options: UsageMonitorReplayOptions = {}
): Promise<UsageMonitorReplayResult> {
  if (replayState.inFlight) return replayState.inFlight;
  const task = executeUsageMonitorReplay(options);
  replayState.inFlight = task;
  void task.then(
    () => {
      if (replayState.inFlight === task) replayState.inFlight = null;
    },
    () => {
      if (replayState.inFlight === task) replayState.inFlight = null;
    }
  );
  return task;
}

/** Start an immediate pass plus a one-minute unref'd maintenance interval. */
export function startUsageMonitorReplay(): void {
  if (!usageMonitorEnabled() || replayState.timer) return;
  void runUsageMonitorReplay();
  const timer = setInterval(() => {
    void runUsageMonitorReplay();
  }, REPLAY_INTERVAL_MS);
  timer.unref?.();
  replayState.timer = timer;
}

/** Test seam: stop the interval after any awaited replay pass. */
export function __resetUsageMonitorReplayState(): void {
  if (replayState.timer) clearInterval(replayState.timer);
  replayState.timer = null;
  replayState.inFlight = null;
}
