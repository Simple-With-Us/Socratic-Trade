// Outbound usage telemetry → API Usage Monitor (usage.jays.services) — server-only.
//
// Wires App B's local usage ledgers (recordLlmUsage / recordRagUsage) and its paid market-data
// call paths to the monitor's ingest endpoint (`POST /api/ingest/usage`), so the monitor can see
// providers it structurally cannot poll (Anthropic, Voyage) plus real call-volume for shared-quota
// market-data providers. Broker families (Alpaca/Tradier/Robinhood) are deliberately suppressed —
// see `usage-monitor-provider-policy.ts`.
//
// DESIGN / SAFETY:
//   - Default OFF: no-op unless BOTH `USAGE_MONITOR_BASE_URL` and `USAGE_INGEST_TOKEN` are set.
//     App B must run fully standalone when the monitor is down/unconfigured — the only visible
//     effect of an outage is a "usage-monitor" row on the admin connections-health page.
//   - Fire-and-forget + never throws: the ledger functions promise "never break the caller", so
//     everything here swallows its own errors. Cost/RAG events are queued and flushed on a short
//     debounce; high-volume market-data/broker calls are aggregated per-provider and flushed as a
//     single `requests`-count event per window (never one POST per call). Call-volume windows are
//     persisted to settings on drain and ACKed after a successful POST so a crash/outage can replay
//     them. Counts still sitting in the ~2s in-memory aggregate (not yet drained) can still be lost.
//   - Health is reported via `logApiHealth({ service: "usage-monitor" })` so the operator sees the
//     connection status without the push ever affecting trading.
//
// CONTRACT: fresh outbound events use `@jaywedgeworth22/congress-trading-shared`'s strict
// `UsageTelemetryV2EventSchema`; producer identity lives only on the v2 batch envelope.
// (`API-usage-monitor/src/lib/usage-telemetry.ts`).
// MIGRATION COMPLETE (2026-07-06): types and client are now imported from the shared package.

import { logApiHealth } from "./db-health";
import { getDb } from "./db";
import { deleteInternalSetting, setInternalSetting } from "./db-settings";
import { getGitSha } from "./git-sha";
import { PEER_LANE_USAGE_MONITOR, peerAwareDelayMs, recordPeerLaneSample } from "./peer-lane-backoff";
import { suppressUsageMonitorProvider } from "./usage-monitor-provider-policy";
import {
  aiUsageTotalTokens,
  buildAiUsage,
  createUsageTelemetryClient,
  telemetryEventClassifier,
  UsageTelemetryApiError,
  UsageTelemetryV2EventSchema,
  deriveUsageTelemetryV2IdempotencyKey,
  type AiUsage,
  type UsageTelemetryV2Event,
  type UsageTelemetryMetricType,
  type UsageTelemetryUnit,
  type UsageTelemetryBillingMode,
  type UsageTelemetryConfidence,
} from "@jaywedgeworth22/congress-trading-shared";

// Re-export shared types under the names consumers already use.
export type UsageMetricType = UsageTelemetryMetricType;
export type UsageUnit = UsageTelemetryUnit;
export type UsageBillingMode = UsageTelemetryBillingMode;
export type UsageConfidence = UsageTelemetryConfidence;
export type UsageMonitorEvent = UsageTelemetryV2Event;
type UsageMonitorDraft = Omit<UsageMonitorEvent, "eventId"> & { eventId?: string };

// ── Config (env-gated, server-only) ────────────────────────────────────────────

const SOURCE_APP = "socratic-trade";
const PROJECT = "socratic-trade";
const HEALTH_SERVICE = "usage-monitor";
const MAX_BATCH = 100; // monitor ingest caps each POST at 100 events

function trimmedEnv(name: string): string | undefined {
  const v = (process.env[name] ?? "").trim();
  return v.length > 0 ? v : undefined;
}

function numEnv(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export function usageMonitorBaseUrl(): string | undefined {
  const base = trimmedEnv("USAGE_MONITOR_BASE_URL");
  return base ? base.replace(/\/+$/, "") : undefined;
}

export function usageMonitorToken(): string | undefined {
  return trimmedEnv("USAGE_INGEST_TOKEN");
}

/** Push is active only when BOTH the base URL and the ingest token are configured. */
export function usageMonitorEnabled(): boolean {
  return usageMonitorBaseUrl() !== undefined && usageMonitorToken() !== undefined;
}

function usageMonitorEnv(): string {
  return trimmedEnv("USAGE_MONITOR_ENV") ?? trimmedEnv("NODE_ENV") ?? "development";
}

/** Deployed commit sha, when the runtime exposes one (see `runtimeReleaseIdentity`'s env probe
 *  list) — reused as the classifier `gitSha`. `undefined` (never invents a new required env var)
 *  when none of those vars are set, e.g. local dev. */
function classifierGitSha(): string | undefined {
  return getGitSha();
}

/**
 * Classifier keys (sourceApp/environment/service/feature/keyRef/gitSha/user) as a flat string map,
 * safe to merge into a pushed event's `metadata`. Never throws — an unexpected validation failure
 * (e.g. a caller passing a blank required field) degrades to an empty object rather than dropping
 * the whole telemetry event.
 */
function classifierTelemetryMetadata(ctx: {
  service: string;
  feature?: string;
  keyRef?: string;
  userId?: string;
}): Record<string, string> {
  try {
    const metadata = telemetryEventClassifier({
      sourceApp: SOURCE_APP,
      environment: usageMonitorEnv(),
      service: ctx.service,
      feature: ctx.feature,
      keyRef: ctx.keyRef,
      gitSha: classifierGitSha(),
      user: ctx.userId,
    }) as Record<string, string>;
    // IDEMPOTENT-REPLAY STABILITY: gitSha changes on EVERY auto-deploy, and the monitor compares
    // full event metadata when deduping an idempotency key — so a replayed ledger row rebuilt
    // after a deploy collided ("Idempotency key collision", monitor 409) with the same key's
    // pre-deploy content, permanently wedging the replay watermark (prod 2026-07-28..30). Every
    // other classifier field is stable across deploys for a given ledger row; gitSha is the only
    // volatile one, so it is deliberately excluded from the pushed event metadata. The deployed
    // sha remains observable via /api/health and llm_usage-side telemetry, not here.
    delete metadata.gitSha;
    return metadata;
  } catch (err) {
    console.warn("[usage-monitor-push] classifier metadata build failed; pushing without it:", err instanceof Error ? err.message : String(err));
    return {};
  }
}

function flushDelayMs(): number {
  return peerAwareDelayMs(PEER_LANE_USAGE_MONITOR, numEnv("USAGE_MONITOR_FLUSH_MS", 2000));
}

/** Test seam: the latency-aware flush delay actually used after a sample is recorded. */
export function usageMonitorFlushDelayMs(): number {
  return flushDelayMs();
}

// ── Circuit breaker (dead-receiver protection) ──────────────────────────────────
//
// The 2026-07 API-usage-monitor outage taught us that a plain capped-retry loop still POSTs on
// every flush/replay tick forever, which is exactly the "hammer a dead endpoint" pattern that ran
// up a 200GB Render bandwidth bill. The breaker below sits in front of every real network attempt
// (postBatch + sendUsageMonitorBatch): after enough consecutive failures it fully suppresses
// delivery for a backoff window (no fetch call at all, not even a fast-failing one) and only lets a
// single "half-open" probe through once that window elapses, so a dead receiver is checked
// occasionally instead of continuously. A success at any point fully resets it.

/** Consecutive failures required before the circuit opens (suppresses delivery). */
function breakerThreshold(): number {
  return numEnv("USAGE_MONITOR_BREAKER_THRESHOLD", 3);
}

/** Initial open-circuit window once the breaker trips. */
function breakerBaseMs(): number {
  return numEnv("USAGE_MONITOR_BREAKER_BASE_MS", 30_000);
}

/** Cap on the open-circuit window — the longest we'll go between probes during a sustained outage. */
function breakerMaxMs(): number {
  return numEnv("USAGE_MONITOR_BREAKER_MAX_MS", 15 * 60_000);
}

/** Cap on total buffered (unsent) events across both queues; see trimBufferedEvents(). */
function queueMaxEvents(): number {
  return numEnv("USAGE_MONITOR_QUEUE_MAX_EVENTS", 500);
}

/** TTL for buffered events (by buffer-residency time, not occurredAt); see trimBufferedEvents(). */
function queueTtlMs(): number {
  return numEnv("USAGE_MONITOR_QUEUE_TTL_MS", 60 * 60_000);
}

/** Max distinct provider/service/key/user lanes held in the callVolume aggregate; see recordProviderCall(). */
function callVolumeMaxKeys(): number {
  return numEnv("USAGE_MONITOR_CALLVOLUME_MAX_KEYS", 2000);
}

/**
 * Per-attempt wall-clock timeout on the LIVE push (postBatch). Without this, a monitor that accepts
 * the TCP connection but never responds leaves `client.send` awaiting forever — the attempt never
 * fails, so the breaker never trips and the queue never drains. That is exactly the half-up outage
 * we just had in prod, so a bounded timeout that CONVERTS a hang into a recorded failure is load-
 * bearing, not cosmetic. (The replay lane has its own REPLAY_SEND_TIMEOUT_MS for the same reason.)
 */
function pushTimeoutMs(): number {
  return numEnv("USAGE_MONITOR_PUSH_TIMEOUT_MS", 10_000);
}

interface BreakerState {
  consecutiveFailures: number;
  /** Epoch ms until which delivery is suppressed. 0 means the circuit is closed. */
  openUntil: number;
  /** True while a single half-open probe attempt is outstanding. */
  probing: boolean;
}

/**
 * Gate every real delivery attempt through the breaker. Returns false (no attempt allowed) while
 * the circuit is open; returns true when closed, or for exactly one concurrent half-open probe once
 * the open window has elapsed. Callers that receive `true` MUST report the outcome via
 * breakerRecordResult so `probing` doesn't leak permanently true.
 */
function breakerAllowsAttempt(now: number): boolean {
  const breaker = state.breaker;
  if (breaker.openUntil === 0 || now >= breaker.openUntil) {
    if (breaker.openUntil !== 0 && breaker.probing) return false; // another probe already in flight
    if (breaker.openUntil !== 0) breaker.probing = true; // half-open: this is the one allowed probe
    return true;
  }
  return false; // circuit open: suppress the attempt entirely, no network call
}

/** Record the outcome of a delivery attempt that breakerAllowsAttempt permitted. */
function breakerRecordResult(
  ok: boolean,
  now: number,
  retryAfterSeconds: number | null = null
): void {
  const breaker = state.breaker;
  breaker.probing = false;
  if (ok) {
    breaker.consecutiveFailures = 0;
    breaker.openUntil = 0;
    return;
  }
  breaker.consecutiveFailures += 1;
  const threshold = breakerThreshold();
  // Wave H / C1: honor server Retry-After immediately (even before threshold)
  // so a 429/503 does not become a retry storm within the same second.
  if (retryAfterSeconds != null && retryAfterSeconds > 0) {
    const fromHeader = now + retryAfterSeconds * 1000;
    const exponent = Math.min(Math.max(0, breaker.consecutiveFailures - threshold), 10);
    const exponential = Math.min(breakerMaxMs(), breakerBaseMs() * 2 ** Math.max(0, exponent));
    breaker.openUntil = Math.max(fromHeader, now + Math.min(exponential, breakerMaxMs()));
    return;
  }
  if (breaker.consecutiveFailures < threshold) return; // below trip threshold: keep the normal cadence
  const exponent = Math.min(breaker.consecutiveFailures - threshold, 10);
  const backoff = Math.min(breakerMaxMs(), breakerBaseMs() * 2 ** exponent);
  breaker.openUntil = now + backoff;
}

/**
 * True when an item has sat in the in-memory buffer longer than the TTL. Deliberately keyed off
 * `receivedAt` (wall-clock time the item entered THIS process's buffer) rather than the event's
 * business `occurredAt` — a replayed/backfilled event can legitimately carry an old `occurredAt`
 * while having just arrived here, and that must not make it look stale on arrival.
 */
function isStaleBuffered(receivedAt: number, ttlMs: number, now: number): boolean {
  return now - receivedAt > ttlMs;
}

/**
 * Bound the in-memory failure buffer so a multi-day receiver outage can't grow ST's own memory
 * without limit. This is safe to trim aggressively: llm/rag/provider-dispatch events dropped here
 * are still recoverable — the durable DB-backed ledgers replay them independently via
 * usage-monitor-replay.ts. Call-volume aggregates are persisted to settings on drain and replayed
 * after a crash or monitor outage (same windowId event identity).
 */
function trimBufferedEvents(now: number): void {
  const ttlMs = queueTtlMs();
  if (ttlMs > 0) {
    state.queue = state.queue.filter((q) => !isStaleBuffered(q.receivedAt, ttlMs, now));
    state.pendingQueue = state.pendingQueue.filter((p) => !isStaleBuffered(p.receivedAt, ttlMs, now));
  }
  const maxEvents = queueMaxEvents();
  if (maxEvents <= 0) return;
  let overflow = state.pendingQueue.length + state.queue.length - maxEvents;
  if (overflow <= 0) return;
  // Prefer dropping already-failed retries over fresh, not-yet-attempted events.
  if (overflow > 0 && state.queue.length > 0) {
    const drop = Math.min(overflow, state.queue.length);
    state.queue.splice(0, drop);
    overflow -= drop;
  }
  if (overflow > 0 && state.pendingQueue.length > 0) {
    const drop = Math.min(overflow, state.pendingQueue.length);
    state.pendingQueue.splice(0, drop);
    overflow -= drop;
  }
}


// ── State (globalThis-pinned so Next.js HMR module duplication can't split it) ──

interface CallVolumeEntry {
  windowId: string;
  provider: string;
  service?: string;
  keySource?: string;
  userId?: string;
  label?: string;
  requests: number;
  successes: number;
  failures: number;
}

export const CALL_VOLUME_SETTING_PREFIX = "usage_monitor_callvolume:v1:";

export interface PersistedCallVolumeWindow {
  windowId: string;
  provider: string;
  service?: string;
  keySource?: string;
  userId?: string;
  label?: string;
  requests: number;
  successes: number;
  failures: number;
  occurredAt: string;
}

function callVolumeSettingKey(windowId: string): string {
  return `${CALL_VOLUME_SETTING_PREFIX}${windowId}`;
}

function parsePersistedCallVolumeWindow(raw: unknown): PersistedCallVolumeWindow | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const parsed = raw as Partial<PersistedCallVolumeWindow>;
  if (
    typeof parsed.windowId !== "string" ||
    typeof parsed.provider !== "string" ||
    typeof parsed.requests !== "number" ||
    typeof parsed.successes !== "number" ||
    typeof parsed.failures !== "number" ||
    typeof parsed.occurredAt !== "string"
  ) {
    return null;
  }
  return {
    windowId: parsed.windowId,
    provider: parsed.provider,
    service: typeof parsed.service === "string" ? parsed.service : undefined,
    keySource: typeof parsed.keySource === "string" ? parsed.keySource : undefined,
    userId: typeof parsed.userId === "string" ? parsed.userId : undefined,
    label: typeof parsed.label === "string" ? parsed.label : undefined,
    requests: parsed.requests,
    successes: parsed.successes,
    failures: parsed.failures,
    occurredAt: parsed.occurredAt,
  };
}

export function persistCallVolumeWindows(windows: PersistedCallVolumeWindow[]): void {
  try {
    for (const window of windows) {
      setInternalSetting(callVolumeSettingKey(window.windowId), window);
    }
  } catch {
    // Unit tests and early boot can run without a migrated DB.  In-memory flush still runs.
  }
}

export function ackCallVolumeWindows(windowIds: string[]): void {
  if (windowIds.length === 0) return;
  try {
    for (const windowId of windowIds) {
      deleteInternalSetting(callVolumeSettingKey(windowId));
    }
  } catch {
    // Same no-DB path as persist.
  }
}

export function loadPersistedCallVolumeWindows(): PersistedCallVolumeWindow[] {
  try {
    const rows = getDb()
      .prepare("SELECT value FROM settings WHERE key LIKE ?")
      .all(`${CALL_VOLUME_SETTING_PREFIX}%`) as Array<{ value: string }>;
    return rows
      .map((row) => {
        try {
          return parsePersistedCallVolumeWindow(JSON.parse(row.value));
        } catch {
          return null;
        }
      })
      .filter((row): row is PersistedCallVolumeWindow => row !== null);
  } catch {
    return [];
  }
}

function callVolumeDraft(window: PersistedCallVolumeWindow): UsageMonitorDraft {
  return {
    environment: usageMonitorEnv(),
    provider: window.provider,
    service: window.service,
    project: PROJECT,
    billingMode: "actual",
    metricType: "usage",
    unit: "request",
    requests: window.requests,
    confidence: "actual",
    occurredAt: window.occurredAt,
    metadata: cleanMetadata({
      successes: window.successes,
      failures: window.failures,
      keySource: window.keySource ?? null,
      userId: window.userId ?? null,
      label: window.label ?? null,
    }),
  };
}

export async function createCallVolumeUsageMonitorEvent(
  window: PersistedCallVolumeWindow
): Promise<UsageMonitorEvent> {
  return {
    ...callVolumeDraft(window),
    eventId: await telemetryIdempotencyKey("provider-call-volume", window.windowId),
  };
}

function ackQueuedCallVolume(items: QueuedUsageEvent[]): void {
  ackCallVolumeWindows(
    items
      .filter((item) => item.kind === "provider-call-volume" && item.sourceId)
      .map((item) => item.sourceId as string)
  );
}

interface PendingUsageEvent {
  event: UsageMonitorDraft;
  kind: string;
  sourceId: string;
  /** Wall-clock arrival time in this buffer; see isStaleBuffered(). */
  receivedAt: number;
}

/** A fully resolved event retained for retry, paired with when it first entered the buffer. */
interface QueuedUsageEvent {
  event: UsageMonitorEvent;
  receivedAt: number;
  kind?: string;
  sourceId?: string;
}

interface PushState {
  version: number;
  /** New events awaiting edge-safe SHA-256 delivery identity resolution. */
  pendingQueue: PendingUsageEvent[];
  /** Fully resolved events retained verbatim across ambiguous delivery retries. */
  queue: QueuedUsageEvent[];
  callVolume: Map<string, CallVolumeEntry>;
  flushTimer: ReturnType<typeof setTimeout> | null;
  /**
   * The single in-flight live flush, or null. Serializes the SEND (not enqueues): while one flush is
   * awaiting its POST — including a hung 10s-timeout send to a half-up receiver — a second flush must
   * NOT start a concurrent send. This bounds a dead receiver to one outstanding POST before the
   * breaker records the failure and opens.
   */
  inflightFlush: Promise<void> | null;
  /** Test seam: overrides global fetch when set. */
  fetchImpl: typeof fetch | null;
  breaker: BreakerState;
}

const host = globalThis as unknown as { __usageMonitorPush?: PushState };
// v5: buffered v1 events are normalized once in memory to strict v2 fields before any retry.
// Bumping forces stale-timer cancellation and prevents an old module from sending v1 wire data.
const STATE_VERSION = 5;
const priorState = host.__usageMonitorPush;
const staleState = priorState !== undefined && priorState.version !== STATE_VERSION;
if (staleState && priorState.flushTimer) {
  // A preserved HMR timer closes over the old module implementation. Cancel it
  // before reusing the queue/map so the current flush logic owns every send.
  clearTimeout(priorState.flushTimer);
  priorState.flushTimer = null;
}
if (staleState) {
  // A carried-over in-flight promise closes over the old module; drop the marker so the new module's
  // single-flight guard isn't wedged closed forever (the old promise still self-settles harmlessly).
  priorState!.inflightFlush = null;
}
const state: PushState =
  priorState ??
  (host.__usageMonitorPush = {
    version: STATE_VERSION,
    pendingQueue: [],
    queue: [],
    callVolume: new Map(),
    flushTimer: null,
    inflightFlush: null,
    fetchImpl: null,
    breaker: { consecutiveFailures: 0, openUntil: 0, probing: false },
  });
if (priorState) normalizeRetainedQueues(priorState);
state.version = STATE_VERSION;
state.pendingQueue ??= [];
state.inflightFlush ??= null;
state.breaker ??= { consecutiveFailures: 0, openUntil: 0, probing: false };

if (
  staleState &&
  (state.pendingQueue.length > 0 || state.queue.length > 0 || state.callVolume.size > 0)
) {
  scheduleFlush();
}

/**
 * Coerce queues retained across an HMR reload into the current wrapper shapes. A pre-v4 module
 * stored `queue` as raw UsageMonitorEvent[] and `pendingQueue` entries without `receivedAt`; the
 * v4+ flush path reads `.event` / `.receivedAt` off every entry, so an un-migrated old-shape entry
 * would throw or send a shapeless payload on hot-reload. Dev-only concern, but cheap to make safe.
 * A raw event is discriminated by the absence of a nested `.event` object.
 */
function normalizeRetainedEvent(value: unknown): UsageMonitorDraft {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value as UsageMonitorDraft;
  const retained = { ...(value as Record<string, unknown>) };
  if (retained.sourceApp !== undefined && retained.sourceApp !== SOURCE_APP) {
    return retained as UsageMonitorDraft;
  }
  delete retained.sourceApp;
  if (retained.producerKeyRef === undefined && retained.keyRef !== undefined) {
    retained.producerKeyRef = retained.keyRef;
  }
  delete retained.keyRef;
  if (retained.eventId === undefined && retained.idempotencyKey !== undefined) {
    retained.eventId = retained.idempotencyKey;
  }
  delete retained.idempotencyKey;
  return retained as UsageMonitorDraft;
}

function normalizeRetainedQueues(prior: PushState): void {
  const now = Date.now();
  if (Array.isArray(prior.queue)) {
    prior.queue = prior.queue.map((entry) => {
      const wrapper = entry as Partial<QueuedUsageEvent>;
      if (wrapper && typeof wrapper.event === "object" && wrapper.event !== null) {
        return {
          event: normalizeRetainedEvent(wrapper.event) as UsageMonitorEvent,
          receivedAt: typeof wrapper.receivedAt === "number" ? wrapper.receivedAt : now,
          kind: typeof wrapper.kind === "string" ? wrapper.kind : undefined,
          sourceId: typeof wrapper.sourceId === "string" ? wrapper.sourceId : undefined,
        };
      }
      // Old shape: `entry` IS the raw event.
      return {
        event: normalizeRetainedEvent(entry) as UsageMonitorEvent,
        receivedAt: now,
      };
    });
  }
  if (Array.isArray(prior.pendingQueue)) {
    prior.pendingQueue = prior.pendingQueue.map((entry) => ({
      ...entry,
      event: normalizeRetainedEvent(entry.event),
      receivedAt: typeof entry.receivedAt === "number" ? entry.receivedAt : now,
    }));
  }
}

// ── Enqueue: discrete cost events (LLM / RAG) ──────────────────────────────────

/**
 * Record one LLM call's usage/cost. Called from `recordLlmUsage` AFTER the local ledger write.
 * Cost + token totals are passed in (already computed by the caller) so this module never imports
 * `llm-usage.ts` — avoids a circular import and re-computation.
 */
export interface LlmUsageMonitorEntry {
  /** Stable ID of the local llm_usage row backing this delivery. */
  sourceEventId?: string;
  /** Stable timestamp persisted on the same local ledger row. */
  occurredAt?: string;
  provider: string;
  model?: string;
  context?: string;
  userId: string;
  keySource: string;
  keyRef?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  /** Where `costUsd` came from: the transport's own `usage.cost` (`billed`) or the price table
   *  (`estimated`).  Mirrors the ledger's `cost_source` column. */
  costSource?: string | null;
  /** Prompt tokens served from the provider's prompt cache (a subset of `promptTokens`). */
  cachedPromptTokens?: number;
  /** Prompt tokens written to the provider's prompt cache, any TTL (a subset of `promptTokens`). */
  cacheCreationTokens?: number;
  /** The 1-hour-TTL share of `cacheCreationTokens`. */
  cacheCreation1hTokens?: number;
  /** The reasoning share of `completionTokens` (informational; already inside it). */
  reasoningTokens?: number;
  /** The model the provider says served the call (response `model`). */
  servedModel?: string;
  /** Wall-clock latency of the call (or whole chat run), from the ledger `latency_ms` column. */
  latencyMs?: number;
  /** Outcome of the call (ledger `status`): success / error / timeout / canceled. */
  status?: string;
  /** Provider requests this row covers when more than one (a chat tool loop); absent = one. */
  requestCount?: number;
  /** OpenRouter's generation id for this call (see `providerRequestIdFromPayload` in llm-usage.ts).
   *  Undefined for every non-OpenRouter provider. */
  providerRequestId?: string;
}

const LLM_AI_HARNESS = "socratic-trade";
/** The local CLI broker bills against the operator's subscription, not per token. */
const SUBSCRIPTION_KEY_REF = "code-cli";

function finiteCount(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}

/** The ledger-derived canonical `ai` block, or undefined when it cannot be built.  Pure and
 *  deterministic in the ledger row: live delivery and `usage-monitor-replay.ts` pass the same
 *  fields, so the same row always yields the same block (the monitor 409s on a changed replay). */
function llmAiUsage(entry: LlmUsageMonitorEntry, costSource: "billed" | "estimated" | undefined): AiUsage | undefined {
  try {
    const prompt = finiteCount(entry.promptTokens);
    const completion = finiteCount(entry.completionTokens);
    // The ledger's prompt figure is the FULL prompt (cache reads and writes included); the canonical
    // `input` bucket is the uncached remainder.  Clamp like the cost estimator so a malformed
    // provider block can never make the buckets sum to more than prompt + completion.
    const cacheRead = prompt === undefined ? undefined : Math.min(finiteCount(entry.cachedPromptTokens) ?? 0, prompt) || undefined;
    const cacheWriteTotal =
      prompt === undefined ? undefined : Math.min(finiteCount(entry.cacheCreationTokens) ?? 0, prompt - (cacheRead ?? 0)) || undefined;
    const cacheWrite1h = cacheWriteTotal === undefined ? undefined : Math.min(finiteCount(entry.cacheCreation1hTokens) ?? 0, cacheWriteTotal) || undefined;
    const cacheWrite5m = cacheWriteTotal === undefined ? undefined : cacheWriteTotal - (cacheWrite1h ?? 0) || undefined;
    const tokens = {
      ...(prompt !== undefined ? { input: prompt - (cacheRead ?? 0) - (cacheWriteTotal ?? 0) } : {}),
      ...(completion !== undefined ? { output: completion } : {}),
      ...(cacheRead !== undefined ? { cacheRead } : {}),
      ...(cacheWrite5m !== undefined ? { cacheWrite5m } : {}),
      ...(cacheWrite1h !== undefined ? { cacheWrite1h } : {}),
      ...(finiteCount(entry.reasoningTokens) !== undefined ? { reasoning: Math.min(finiteCount(entry.reasoningTokens)!, completion ?? Number.MAX_SAFE_INTEGER) } : {}),
    };
    return buildAiUsage({
      tokens,
      requestedModel: entry.model?.slice(0, 160),
      servedModel: entry.servedModel?.slice(0, 160),
      harness: LLM_AI_HARNESS,
      durationMs: finiteCount(entry.latencyMs),
      billingMode: entry.keyRef === SUBSCRIPTION_KEY_REF ? "subscription" : "payg",
      costSource,
    });
  } catch {
    // Telemetry never throws, and a replay builder that threw would wedge the watermark.
    return undefined;
  }
}

function llmUsageEvent(entry: LlmUsageMonitorEntry): UsageMonitorDraft {
  const hasCost = typeof entry.costUsd === "number" && Number.isFinite(entry.costUsd);
  const costSource = entry.costSource === "billed" || entry.costSource === "estimated" ? entry.costSource : undefined;
  // OpenRouter's `usage.cost` is the provider's own charge, so it is `actual`; a price-table
  // figure stays `estimated`.  A cost-less row is still an estimate (UM derives its price).
  const billed = hasCost && costSource === "billed";
  const ai = llmAiUsage(entry, hasCost ? costSource : undefined);
  const aiTotal = ai?.tokens ? aiUsageTotalTokens(ai.tokens) : undefined;
  const requestCount = finiteCount(entry.requestCount);
  return {
    environment: usageMonitorEnv(),
    provider: entry.provider,
    service: "llm",
    project: PROJECT,
    label: entry.context,
    producerKeyRef: entry.keyRef,
    billingMode: billed ? "actual" : "estimated",
    metricType: hasCost ? "cost" : "usage",
    // Doc rule: quantity is the sum of the billed ai buckets, which equals the ledger total.
    quantity: aiTotal !== undefined && aiTotal > 0 ? aiTotal : entry.totalTokens,
    unit: "token",
    costUsd: hasCost ? entry.costUsd : undefined,
    // A chat tool loop is one ledger row covering several model calls; saying so keeps the run's
    // total duration out of the monitor's per-request view (ai-usage-schema.md).
    requests: requestCount !== undefined && requestCount > 1 ? requestCount : 1,
    confidence: billed ? "actual" : "estimated",
    occurredAt: entry.occurredAt ?? new Date().toISOString(),
    providerRequestId: entry.providerRequestId,
    metadata: cleanMetadata({
      model: entry.model ?? null,
      context: entry.context ?? null,
      userId: entry.userId,
      keySource: entry.keySource,
      promptTokens: entry.promptTokens ?? null,
      completionTokens: entry.completionTokens ?? null,
      // Legacy token keys the monitor still maps when `ai` is absent (ai-usage-metadata.ts); kept
      // alongside the typed block for the migration.  `cacheWriteTokens` is the 5-minute share and
      // `cacheWriteOneHourTokens` the 1-hour share, matching the monitor's own subtraction.
      cachedTokens: ai?.tokens?.cacheRead,
      cacheWriteTokens: ai?.tokens?.cacheWrite5m,
      cacheWriteOneHourTokens: ai?.tokens?.cacheWrite1h,
      reasoningTokens: ai?.tokens?.reasoning,
      latencyMs: finiteCount(entry.latencyMs),
      status: entry.status,
      costSource: hasCost ? costSource : undefined,
      servedModel: entry.servedModel,
      ...classifierTelemetryMetadata({ service: "llm", feature: entry.context, keyRef: entry.keyRef, userId: entry.userId }),
    }),
    ai,
  };
}

export function pushLlmUsage(entry: LlmUsageMonitorEntry): void {
  if (!usageMonitorEnabled()) return;
  try {
    enqueuePending(llmUsageEvent(entry), "llm", entry.sourceEventId);
  } catch {
    /* telemetry must never break the caller */
  }
}

/** Build the exact deterministic event used to replay one persisted llm_usage row. */
export async function createLlmUsageMonitorEvent(
  entry: LlmUsageMonitorEntry & { sourceEventId: string; occurredAt: string }
): Promise<UsageMonitorEvent> {
  return {
    ...llmUsageEvent(entry),
    eventId: await telemetryIdempotencyKey("llm", entry.sourceEventId),
  };
}

/**
 * Record one RAG (Voyage / Pinecone) op's usage/cost. Called from `recordRagUsage` after the local
 * ledger write. Cost is passed in (already computed by the caller).
 */
export interface RagUsageMonitorEntry {
  /** Stable ID of the local rag_usage row backing this delivery. */
  sourceEventId?: string;
  /** Stable timestamp persisted on the same local ledger row. */
  occurredAt?: string;
  provider: string;
  operation: string;
  model?: string;
  userId: string;
  tokensIn?: number;
  tokensOut?: number;
  batchCount?: number;
  costUsd?: number;
  /** OpenRouter's generation id for this call (embed/rerank via `baai/bge-m3`/`cohere/rerank-v3.5`).
   *  Undefined for Voyage/SiliconFlow/Pinecone — see `providerRequestIdFromPayload` in llm-usage.ts. */
  providerRequestId?: string;
}

function ragUsageEvent(entry: RagUsageMonitorEntry): UsageMonitorDraft {
  const hasCost = typeof entry.costUsd === "number" && Number.isFinite(entry.costUsd);
  const isPinecone = entry.provider === "pinecone";
  const quantity = isPinecone
    ? (entry.tokensIn ?? 0)
    : (entry.tokensIn ?? 0) + (entry.tokensOut ?? 0);
  // Voyage embed/rerank quantities are token estimates. Pinecone query/upsert quantities are
  // Read/Write Units in tokensIn, with records kept separately in metadata.
  const unit: UsageUnit = isPinecone ? "credit" : "token";
  return {
    environment: usageMonitorEnv(),
    provider: entry.provider,
    service: "rag",
    project: PROJECT,
    label: entry.operation,
    producerKeyRef: undefined, // RAG keys are app-funded; no per-attached-key fingerprint today
    billingMode: "estimated",
    metricType: hasCost ? "cost" : "usage",
    quantity: quantity > 0 ? quantity : undefined,
    unit,
    costUsd: hasCost ? entry.costUsd : undefined,
    requests: 1,
    confidence: "estimated",
    occurredAt: entry.occurredAt ?? new Date().toISOString(),
    providerRequestId: entry.providerRequestId,
    metadata: cleanMetadata({
      model: entry.model ?? null,
      operation: entry.operation,
      userId: entry.userId,
      batchCount: entry.batchCount ?? null,
      recordCount: isPinecone ? entry.tokensOut ?? null : null,
      // Voyage/SiliconFlow bypass OpenRouter entirely (no request-side trace enrichment is
      // possible), so this is the ONLY place their classifier context is ever recorded — sourced
      // locally, never inferred from the provider response.
      ...classifierTelemetryMetadata({ service: "rag", feature: entry.operation, userId: entry.userId }),
    }),
  };
}

export function pushRagUsage(entry: RagUsageMonitorEntry): void {
  if (!usageMonitorEnabled()) return;
  try {
    enqueuePending(ragUsageEvent(entry), "rag", entry.sourceEventId);
  } catch {
    /* telemetry must never break the caller */
  }
}

/** Build the exact deterministic event used to replay one persisted rag_usage row. */
export async function createRagUsageMonitorEvent(
  entry: RagUsageMonitorEntry & { sourceEventId: string; occurredAt: string }
): Promise<UsageMonitorEvent> {
  return {
    ...ragUsageEvent(entry),
    eventId: await telemetryIdempotencyKey("rag", entry.sourceEventId),
  };
}

/** Build the exact deterministic event for one crash-durable provider dispatch outcome. */
export async function createProviderDispatchUsageMonitorEvent(entry: {
  sourceEventId: string;
  occurredAt: string;
  provider: string;
  operation: string;
  credentialRef: string;
  userId: string;
  outcome: "succeeded" | "failed" | "unknown";
  requests?: number;
  estimatedCostUsd?: number;
  actualCostUsd?: number;
}): Promise<UsageMonitorEvent | null> {
  // Retired broker families are never admitted to the monitor (live or replay). Callers treat
  // null as "skip this row" while still advancing durable watermarks past it.
  if (suppressUsageMonitorProvider(entry.provider)) return null;
  // INVARIANT: the ledger lanes (pushLlmUsage/pushRagUsage, service "llm"/"rag") are the single
  // external cost authority for every provider they cover — dispatch (service "provider-dispatch")
  // is a quota/request-volume signal only, for every provider, always. entry.estimatedCostUsd /
  // entry.actualCostUsd above still drive the LOCAL per-credential daily cost-cap fuse
  // (reserveProviderDispatch's maxEstimatedCostUsdPer24h check in db-provider-dispatch.ts) and must
  // stay real there — but they must never be threaded into the event pushed to the monitor below.
  // The monitor's receiver sums cost by provider name only (it ignores `service`), so a non-zero
  // costUsd here would double-count spend the ledger lane already reported for the same call.
  return {
    environment: usageMonitorEnv(),
    provider: entry.provider,
    service: "provider-dispatch",
    project: PROJECT,
    label: entry.operation,
    producerKeyRef: entry.credentialRef,
    billingMode: "estimated",
    metricType: "usage",
    unit: "request",
    requests: entry.requests ?? 1,
    confidence: entry.outcome === "unknown" ? "estimated" : "actual",
    occurredAt: entry.occurredAt,
    metadata: cleanMetadata({
      operation: entry.operation,
      userId: entry.userId,
      outcome: entry.outcome,
      unknownOutcome: entry.outcome === "unknown",
    }),
    eventId: await telemetryIdempotencyKey("provider-dispatch", entry.sourceEventId),
  };
}

// ── Aggregate: market-data call-volume ─────────────────────────────────────────

/**
 * Count one external market-data API call. Called from the central `fetchWithRetry` wrapper
 * (`data-providers.ts`). This is on a hot path, so it only mutates an in-memory per-provider
 * counter — the counts are flushed as a single aggregated `requests`-count event per provider per
 * window (never one POST per call). Retired broker families are suppressed at admission.
 */
export function recordProviderCall(
  provider: string,
  opts: { service?: string; ok?: boolean; keySource?: string; userId?: string; label?: string } = {}
): void {
  if (!usageMonitorEnabled()) return;
  // Never re-count the telemetry channel's own health calls (would loop).
  if (provider === HEALTH_SERVICE) return;
  // Retired broker families (Alpaca/Tradier/Robinhood and their subproviders) stay in trading/health
  // but never enter the Usage Monitor feed.
  if (suppressUsageMonitorProvider(provider)) return;
  try {
    const label = opts.label?.trim() || undefined;
    // Key by credential lane + optional usage label so a peer-serving miss (congress-read)
    // is not conflated with this app's own Massive spend.
    const key = [provider, opts.service ?? "", opts.keySource ?? "", opts.userId ?? "", label ?? ""].join("|");
    const existing = state.callVolume.get(key);
    if (!existing) {
      // Bound distinct lanes: callVolume is drained each flush, but while the breaker is open the
      // next flush can be up to breakerMaxMs away, and high-cardinality per-user market-data keys
      // could otherwise accumulate one entry per user for that whole window. Evict oldest-inserted
      // lanes (Map keeps insertion order) to make room — a dropped aggregate is best-effort
      // telemetry, and the durable ledgers don't depend on it.
      const maxKeys = callVolumeMaxKeys();
      while (maxKeys > 0 && state.callVolume.size >= maxKeys) {
        const oldest = state.callVolume.keys().next().value;
        if (oldest === undefined) break;
        state.callVolume.delete(oldest);
      }
    }
    const entry =
      existing ??
      {
        windowId: randomDeliveryId(),
        provider,
        service: opts.service,
        keySource: opts.keySource,
        userId: opts.userId,
        label,
        requests: 0,
        successes: 0,
        failures: 0,
      };
    entry.requests += 1;
    if (opts.ok === true) entry.successes += 1;
    else if (opts.ok === false) entry.failures += 1;
    state.callVolume.set(key, entry);
    scheduleFlush();
  } catch {
    /* telemetry must never break the caller */
  }
}

// ── Queue / flush plumbing ─────────────────────────────────────────────────────

function enqueuePending(
  event: UsageMonitorDraft,
  kind: string,
  sourceId?: string
): void {
  state.pendingQueue.push({
    event,
    kind,
    sourceId: sourceId?.trim() || randomDeliveryId(),
    receivedAt: Date.now(),
  });
  trimBufferedEvents(Date.now());
  scheduleFlush();
}

function scheduleFlush(delayMs = flushDelayMs()): void {
  if (state.flushTimer) return;
  const timer = setTimeout(() => {
    state.flushTimer = null;
    void flushUsageMonitor();
  }, delayMs);
  // Don't keep the process alive just for a pending telemetry flush.
  (timer as { unref?: () => void }).unref?.();
  state.flushTimer = timer;
}

function drainCallVolume(now: string): PendingUsageEvent[] {
  const events: PendingUsageEvent[] = [];
  const persisted: PersistedCallVolumeWindow[] = [];
  for (const entry of state.callVolume.values()) {
    if (entry.requests <= 0) continue;
    // Defense in depth: never flush a retired family even if a stale HMR map entry slipped in.
    if (suppressUsageMonitorProvider(entry.provider)) continue;
    const windowId = entry.windowId || randomDeliveryId();
    const window: PersistedCallVolumeWindow = {
      windowId,
      provider: entry.provider,
      service: entry.service,
      keySource: entry.keySource,
      userId: entry.userId,
      label: entry.label,
      requests: entry.requests,
      successes: entry.successes,
      failures: entry.failures,
      occurredAt: now,
    };
    persisted.push(window);
    events.push({
      kind: "provider-call-volume",
      sourceId: windowId,
      receivedAt: Date.now(),
      event: callVolumeDraft(window),
    });
  }
  persistCallVolumeWindows(persisted);
  state.callVolume.clear();
  return events;
}

async function resolvePendingEvents(
  pending: PendingUsageEvent[]
): Promise<QueuedUsageEvent[]> {
  return Promise.all(
    pending.map(async ({ event, kind, sourceId, receivedAt }) => ({
      event: {
        ...event,
        eventId: await telemetryIdempotencyKey(kind, sourceId),
      },
      receivedAt,
      kind,
      sourceId,
    }))
  );
}

/**
 * Flush all buffered events (discrete cost events + aggregated call-volume) to the monitor. Batched
 * at MAX_BATCH per POST. Never throws. Exported for tests and internal scheduling.
 *
 * Single-flight wrapper: only ONE live flush's SEND may be outstanding at a time. If a flush is
 * already in flight (e.g. awaiting a hung 10s-timeout POST to a half-up receiver), this does NOT
 * start a second concurrent send — it re-arms the timer so events buffered in the meantime are
 * picked up once the current send settles. Net: at most one outstanding POST before the breaker
 * decision, so a dead receiver can't accumulate a burst of concurrent hanging requests. Enqueues are
 * unaffected — they still just buffer; only the SEND is serialized, and the finally-clear plus the
 * bounded send timeout guarantee no deadlock.
 */
export async function flushUsageMonitor(): Promise<void> {
  if (state.inflightFlush) {
    // A send is already outstanding — defer instead of starting a concurrent one. Re-arm so the
    // events buffered during this window flush after the current send settles.
    scheduleFlush();
    return;
  }
  const work = flushUsageMonitorOnce();
  state.inflightFlush = work;
  try {
    await work;
  } finally {
    state.inflightFlush = null;
  }
}

async function flushUsageMonitorOnce(): Promise<void> {
  if (state.flushTimer) {
    clearTimeout(state.flushTimer);
    state.flushTimer = null;
  }
  if (!usageMonitorEnabled()) {
    // Drop anything buffered while disabled so it can't leak later if the env is toggled mid-process.
    state.pendingQueue.length = 0;
    state.queue.length = 0;
    state.callVolume.clear();
    return;
  }

  // Trim by TTL/cap at flush entry, not only on enqueue: an event can age past its TTL while sitting
  // in the buffer with no new telemetry arriving, and must be dropped BEFORE it reaches the send path.
  trimBufferedEvents(Date.now());

  const now = new Date().toISOString();
  const unresolved = state.pendingQueue
    .splice(0, state.pendingQueue.length)
    .concat(drainCallVolume(now));
  let resolved: QueuedUsageEvent[];
  try {
    resolved = await resolvePendingEvents(unresolved);
  } catch {
    // Web Crypto is expected in every supported runtime. If it is temporarily
    // unavailable, retain the original descriptors rather than sending events
    // without their stable delivery identity.
    state.pendingQueue.unshift(...unresolved);
    trimBufferedEvents(Date.now());
    scheduleFlush();
    return;
  }
  const all = state.queue.splice(0, state.queue.length).concat(resolved);
  if (all.length === 0) return;

  // Quarantine schema-invalid (poison) events OUT of the buffer before sending: client.send parses
  // the batch before any fetch, so a poison event's ZodError would otherwise be caught as a delivery
  // failure and falsely trip the breaker — and re-fail on every flush forever. A local bad-data error
  // is not "receiver down". Drop them (best-effort log) and only ever send/re-queue valid events.
  const pending: QueuedUsageEvent[] = [];
  let poisonCount = 0;
  for (const q of all) {
    if (isDeliverableEvent(q.event)) pending.push(q);
    else poisonCount += 1;
  }
  warnPoisonDropped(poisonCount, "live-push");
  if (pending.length === 0) return;

  for (let i = 0; i < pending.length; i += MAX_BATCH) {
    const batch = pending.slice(i, i + MAX_BATCH);
    const result = await postBatch(batch.map((q) => q.event));
    if (result.ok) {
      ackQueuedCallVolume(batch);
      continue;
    }
    if (result.collisionKey) {
      // The monitor already holds a distinct event under this key.  Re-sending the
      // colliding row 409s the whole remaining batch forever and paints the
      // usage-monitor lane STOPPED (prod 2026-08-13: 36 repeats of one key in 2h).
      // Drop only the named row — same contract as the durable replay lane — and
      // retry the rest.  A 409 is proof the receiver is up, not an outage.
      const remaining: QueuedUsageEvent[] = [];
      const acked: QueuedUsageEvent[] = [];
      for (const q of pending.slice(i)) {
        const key = await usageMonitorV2IdempotencyKey(q.event.eventId);
        if (key === result.collisionKey) acked.push(q);
        else remaining.push(q);
      }
      ackQueuedCallVolume(acked);
      if (remaining.length > 0) {
        state.queue.unshift(...remaining);
        trimBufferedEvents(Date.now());
        scheduleFlush(flushDelayMs());
      }
      return;
    }
    // Keep the exact event objects — including explicit key + occurredAt —
    // so an ambiguous accepted-then-disconnected response retries safely. Only deliverable events
    // are re-queued (poison was already dropped above), so a bad-data event can't re-fail forever.
    state.queue.unshift(...pending.slice(i));
    trimBufferedEvents(Date.now());
    // While the breaker is open, wait out its window instead of retrying on the short flush
    // cadence — that's the suppression that stops a dead receiver from being hammered.
    const now = Date.now();
    const delay = state.breaker.openUntil > now ? state.breaker.openUntil - now : flushDelayMs();
    scheduleFlush(delay);
    return;
  }
}

/**
 * Record the `usage-monitor` connection result for the admin health page. BOTH the live-push
 * (postBatch) and durable-replay (sendUsageMonitorBatch) lanes call this, so the health row reflects
 * reality no matter which lane actually talked to the monitor. Without this in the replay lane, a
 * replay-first failure would open the shared breaker and then suppress every later postBatch attempt
 * for the whole backoff window — leaving the health row "healthy"/stale even though the monitor is
 * down (the very stale-observability bug this incident was about). `logApiHealth` already swallows
 * its own errors, but keep this best-effort so it can never break a fire-and-forget caller.
 */
function recordUsageMonitorHealth(ok: boolean, startedAt: number, err?: unknown): void {
  try {
    const errorText = ok ? undefined : err instanceof Error ? err.message : String(err);
    // Expected receiver limits (429/503/timeouts during half-up outages) are soft so the
    // usage-monitor lane does not paint red STOPPED forever while the local breaker already
    // backs off pushes. Auth/schema/config errors stay hard.
    const soft =
      !ok &&
      !!errorText &&
      (/\bHTTP 429\b|\bHTTP 503\b|\brate limit|\btoo many requests|\bECONNRESET\b|\bETIMEDOUT\b|\babort(?:ed|ion)?\b|\btimeout\b|\bIdempotency key collision\b/i.test(
        errorText
      ) ||
        (typeof err === "object" &&
          err != null &&
          "status" in err &&
          (Number((err as { status?: unknown }).status) === 429 ||
            Number((err as { status?: unknown }).status) === 503 ||
            Number((err as { status?: unknown }).status) === 409)));
    const latencyMs = Date.now() - startedAt;
    recordPeerLaneSample(PEER_LANE_USAGE_MONITOR, latencyMs);
    logApiHealth({
      service: HEALTH_SERVICE,
      ok,
      latencyMs,
      ...(errorText ? { errorText } : {}),
      soft,
    });
  } catch {
    /* health recording is best-effort; never break the caller/replay path */
  }
}

/**
 * True when an event passes the strict shared v2 event schema — i.e. it is safe to hand to
 * `client.send`, which parses the batch BEFORE any fetch. An event that fails here (e.g. a NaN /
 * Infinity `quantity` that slipped past an admission guard) would throw a ZodError before the
 * network is ever touched. That is a LOCAL data bug, not a receiver outage, so we must never let it
 * reach the send path where its throw would be misread as a delivery failure and trip the breaker.
 */
function isDeliverableEvent(event: UsageMonitorEvent): boolean {
  return UsageTelemetryV2EventSchema.safeParse(event).success;
}

/** Best-effort visibility for dropped poison events; never throws. */
function warnPoisonDropped(count: number, lane: string): void {
  if (count <= 0) return;
  try {
    console.warn(
      `[usage-monitor-push] dropped ${count} schema-invalid telemetry event(s) from ${lane} ` +
        `(local validation failure — not a receiver outage; breaker untouched)`
    );
  } catch {
    /* logging is best-effort */
  }
}

/** A schema-valid v2 ACK can still report a partial batch; never treat that as durable success. */
function requireCompleteAck(
  ack: { received: number; rejected: number },
  expectedCount: number
): void {
  if (ack.received !== expectedCount || ack.rejected !== 0) {
    throw new Error(
      `Usage monitor acknowledged only part of the batch ` +
        `(sent=${expectedCount}, received=${ack.received}, rejected=${ack.rejected})`
    );
  }
}

type PostBatchResult = { ok: true } | { ok: false; collisionKey?: string };

async function postBatch(events: UsageMonitorEvent[]): Promise<PostBatchResult> {
  const baseUrl = usageMonitorBaseUrl();
  const token = usageMonitorToken();
  if (events.length === 0) return { ok: true };
  if (!baseUrl || !token) return { ok: false };
  if (!breakerAllowsAttempt(Date.now())) return { ok: false }; // circuit open: no network call

  const fetchImpl = state.fetchImpl ?? fetch;
  const start = Date.now();
  // Bound the attempt: a monitor that accepts the connection but never responds would otherwise
  // leave client.send awaiting forever, so the attempt never records a failure and the breaker
  // never trips — the half-up outage. AbortSignal converts that hang into a recorded failure.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), pushTimeoutMs());
  try {
    const client = createUsageTelemetryClient({
      baseUrl,
      token,
      producerId: SOURCE_APP,
      fetchImpl: (input, init) => fetchImpl(input, { ...init, signal: controller.signal }),
    });
    const ack = await client.send(events);
    requireCompleteAck(ack, events.length);
    recordUsageMonitorHealth(true, start);
    breakerRecordResult(true, Date.now());
    return { ok: true };
  } catch (err) {
    const collisionKey = usageMonitorCollisionKeyFromError(err);
    if (collisionKey) {
      // Receiver is up and already stored this identity.  Do not trip the
      // outage breaker or paint the usage-monitor lane STOPPED.
      recordUsageMonitorHealth(true, start);
      breakerRecordResult(true, Date.now());
      return { ok: false, collisionKey };
    }
    recordUsageMonitorHealth(false, start, err);
    const retryAfter =
      err && typeof err === "object" && "retryAfterSeconds" in err
        ? Number((err as { retryAfterSeconds?: unknown }).retryAfterSeconds)
        : null;
    breakerRecordResult(
      false,
      Date.now(),
      Number.isFinite(retryAfter) && retryAfter != null && retryAfter >= 0 ? retryAfter : null
    );
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Max wall-clock for a single replay POST. Prevents a hung connection from permanently blocking the
 * replay interval (which uses an inFlight promise guard — the promise would never settle otherwise).
 */
const REPLAY_SEND_TIMEOUT_MS = 30_000;

/**
 * Extract the monitor-side idempotency key named in a 409 idempotency_conflict message
 * (`Idempotency key collision for "<key>". ...`). Null when the error isn't that contract.
 */
export function usageMonitorCollisionKeyFromError(err: unknown): string | null {
  if (!(err instanceof UsageTelemetryApiError) || err.code !== "idempotency_conflict") return null;
  const match = /Idempotency key collision for "([^"]+)"/.exec(err.message);
  return match ? match[1] : null;
}

/**
 * The monitor's canonical v2 persistence key for one of OUR events — needed by the replay lane
 * to map a 409 collision key back to the exact ledger row the monitor already holds.
 */
export async function usageMonitorV2IdempotencyKey(eventId: string): Promise<string> {
  return deriveUsageTelemetryV2IdempotencyKey({ producerId: SOURCE_APP, eventId });
}

/**
 * Send a caller-owned batch and report whether the monitor acknowledged it. Unlike the live
 * in-memory queue, this does not retain failed events: durable callers keep their ledger cursor
 * unchanged and reconstruct the exact same idempotent payload on the next pass.
 *
 * Applies an AbortSignal timeout so that a connection stall cannot permanently block the caller
 * (the replay worker's inFlight guard is never cleared if the POST promise never settles).
 *
 * `onIdempotencyCollision` fires (synchronously, before the false return) when the monitor
 * rejects the whole batch with a 409 idempotency_conflict, with the exact key it named — the
 * durable caller can then skip THAT row (the monitor already holds an event under the key) and
 * resend the rest instead of wedging its watermark behind one poison row forever.
 */
async function sendReplayBatch(
  events: UsageMonitorEvent[],
  options?: { onIdempotencyCollision?: (idempotencyKey: string) => void }
): Promise<boolean> {
  if (events.length === 0) return true;
  if (!usageMonitorEnabled()) return false;

  const baseUrl = usageMonitorBaseUrl();
  const token = usageMonitorToken();
  if (!baseUrl || !token) return false;

  // Drop schema-invalid (poison) events before the breaker check / fetch: client.send validates the
  // batch before any network call, so a poison event is a LOCAL data bug, not a receiver outage —
  // it must not trip the breaker. Reporting the delivery as acknowledged (return true when nothing
  // valid remains) lets the durable caller advance its watermark past the bad row instead of
  // re-failing it forever.
  const deliverable = events.filter(isDeliverableEvent);
  warnPoisonDropped(events.length - deliverable.length, "replay");
  if (deliverable.length === 0) return true;

  // Shares the live-push breaker: the replay interval fires every 60s regardless, but while the
  // circuit is open this returns false immediately with no fetch call, so replay's fixed cadence
  // can't turn into a second continuous hammer on top of the live queue's own backoff.
  if (!breakerAllowsAttempt(Date.now())) return false;

  const fetchImpl = state.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REPLAY_SEND_TIMEOUT_MS);
  const start = Date.now();

  try {
    const client = createUsageTelemetryClient({
      baseUrl,
      token,
      producerId: SOURCE_APP,
      fetchImpl: (input, init) =>
        fetchImpl(input, { ...init, signal: controller.signal }),
    });
    const ack = await client.send(deliverable);
    requireCompleteAck(ack, deliverable.length);
    // Record health from the replay lane too — if replay is the first/only lane talking to a down
    // monitor, this is what keeps the admin health row truthful instead of stale-healthy while the
    // shared breaker (below) suppresses the live-push lane's own health writes.
    recordUsageMonitorHealth(true, start);
    breakerRecordResult(true, Date.now());
    return true;
  } catch (err) {
    recordUsageMonitorHealth(false, start, err);
    const collisionKey = usageMonitorCollisionKeyFromError(err);
    if (collisionKey && options?.onIdempotencyCollision) {
      try {
        options.onIdempotencyCollision(collisionKey);
      } catch {
        /* the collision hint is best-effort; the false return still signals failure */
      }
    }
    const retryAfter =
      err && typeof err === "object" && "retryAfterSeconds" in err
        ? Number((err as { retryAfterSeconds?: unknown }).retryAfterSeconds)
        : null;
    breakerRecordResult(
      false,
      Date.now(),
      Number.isFinite(retryAfter) && retryAfter != null && retryAfter >= 0 ? retryAfter : null
    );
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function sendUsageMonitorBatch(
  events: UsageMonitorEvent[],
  options?: { onIdempotencyCollision?: (idempotencyKey: string) => void }
): Promise<boolean> {
  return sendReplayBatch(events, options);
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Drop null/undefined-ish values so the monitor's 50-key/500-char metadata cap isn't wasted. */
function cleanMetadata(
  raw: Record<string, string | number | boolean | null | undefined>
): Record<string, string | number | boolean | null> | undefined {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Delivery identity, separate from the shared five-field fallback. Source-ledger
 * IDs make discrete events stable; a UUID allocated once per aggregate window
 * makes same-flush provider lanes unique even though they share occurredAt.
 */
async function telemetryIdempotencyKey(
  kind: string,
  sourceId: string | undefined = randomDeliveryId()
): Promise<string> {
  const normalizedSourceId = sourceId?.trim() || randomDeliveryId();
  const encoded = new TextEncoder().encode(`${kind}\0${normalizedSourceId}`);
  const bytes = new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", encoded)
  );
  const digest = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  return `${SOURCE_APP}:${kind}:${digest}`;
}

function randomDeliveryId(): string {
  return globalThis.crypto.randomUUID();
}

// ── Test seams ─────────────────────────────────────────────────────────────────

/** Inject a fetch stub for tests. Pass null to restore the real fetch. */
export function __setUsageMonitorFetch(fetchImpl: typeof fetch | null): void {
  state.fetchImpl = fetchImpl;
}

/** Clear all buffered state (tests). */
export function __resetUsageMonitorState(): void {
  if (state.flushTimer) {
    clearTimeout(state.flushTimer);
    state.flushTimer = null;
  }
  state.pendingQueue.length = 0;
  state.queue.length = 0;
  state.callVolume.clear();
  state.fetchImpl = null;
  state.inflightFlush = null;
  state.breaker = { consecutiveFailures: 0, openUntil: 0, probing: false };
}

/** Test seam: inspect breaker + buffered-queue state without reaching into globalThis. */
export function __usageMonitorDebugState(): {
  breaker: { consecutiveFailures: number; openUntil: number; probing: boolean };
  queueDepth: number;
  callVolumeKeys: number;
} {
  return {
    breaker: { ...state.breaker },
    queueDepth: state.pendingQueue.length + state.queue.length,
    callVolumeKeys: state.callVolume.size,
  };
}
