// Outbound usage telemetry → API Usage Monitor (usage.jays.services) — server-only.
//
// Wires App B's local usage ledgers (recordLlmUsage / recordRagUsage) and its market-data /
// broker call paths to the monitor's ingest endpoint (`POST /api/ingest/usage`), so the monitor
// can see providers it structurally cannot poll (Anthropic, Voyage, Robinhood) plus real
// call-volume for the shared-quota market-data providers.
//
// DESIGN / SAFETY:
//   - Default OFF: no-op unless BOTH `USAGE_MONITOR_BASE_URL` and `USAGE_INGEST_TOKEN` are set.
//     App B must run fully standalone when the monitor is down/unconfigured — the only visible
//     effect of an outage is a "usage-monitor" row on the admin connections-health page.
//   - Fire-and-forget + never throws: the ledger functions promise "never break the caller", so
//     everything here swallows its own errors. Cost/RAG events are queued and flushed on a short
//     debounce; high-volume market-data/broker calls are aggregated per-provider and flushed as a
//     single `requests`-count event per window (never one POST per call).
//   - Health is reported via `logApiHealth({ service: "usage-monitor" })` so the operator sees the
//     connection status without the push ever affecting trading.
//
// CONTRACT: the event shape mirrors `@jaywedgeworth22/congress-trading-shared`'s
// `UsageTelemetryEventSchema` and the monitor's server-side parser
// (`API-usage-monitor/src/lib/usage-telemetry.ts`). It is hand-rolled here rather than importing
// `createUsageTelemetryClient` because the usageTelemetry export was added after this code
// was written. MIGRATION: the shared package is now at ^1.2.0 which includes `createUsageTelemetryClient`;
// swap `postBatch()` below for `createUsageTelemetryClient({ baseUrl, token }).send(events)`
// — the event shape is already the shared contract, so only the transport changes.

import { logApiHealth } from "./db-health";

// ── Contract (mirrors the shared UsageTelemetryEvent) ──────────────────────────

export type UsageMetricType = "usage" | "cost" | "quota" | "tier" | "health" | "balance" | "limit";
export type UsageUnit =
  | "request" | "call" | "token" | "credit" | "usd" | "page" | "job" | "document" | "row" | "byte";
export type UsageBillingMode = "actual" | "estimated" | "manual";
export type UsageConfidence = "actual" | "estimated" | "manual";

export interface UsageMonitorEvent {
  sourceApp: string;
  environment?: string;
  provider: string;
  service?: string;
  label?: string;
  keyRef?: string;
  billingMode?: UsageBillingMode;
  metricType?: UsageMetricType;
  quantity?: number;
  unit?: UsageUnit;
  costUsd?: number;
  requests?: number;
  confidence?: UsageConfidence;
  occurredAt?: string;
  metadata?: Record<string, string | number | boolean | null>;
}

// ── Config (env-gated, server-only) ────────────────────────────────────────────

const SOURCE_APP = "socratic-trade";
const INGEST_PATH = "/api/ingest/usage";
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

function flushDelayMs(): number {
  return numEnv("USAGE_MONITOR_FLUSH_MS", 2000);
}

function timeoutMs(): number {
  return numEnv("USAGE_MONITOR_TIMEOUT_MS", 8000);
}

// ── State (globalThis-pinned so Next.js HMR module duplication can't split it) ──

interface CallVolumeEntry {
  provider: string;
  service?: string;
  keySource?: string;
  userId?: string;
  requests: number;
  successes: number;
  failures: number;
}

interface PushState {
  queue: UsageMonitorEvent[];
  callVolume: Map<string, CallVolumeEntry>;
  flushTimer: ReturnType<typeof setTimeout> | null;
  /** Test seam: overrides global fetch when set. */
  fetchImpl: typeof fetch | null;
}

const host = globalThis as unknown as { __usageMonitorPush?: PushState };
const state: PushState =
  host.__usageMonitorPush ??
  (host.__usageMonitorPush = { queue: [], callVolume: new Map(), flushTimer: null, fetchImpl: null });

// ── Enqueue: discrete cost events (LLM / RAG) ──────────────────────────────────

/**
 * Record one LLM call's usage/cost. Called from `recordLlmUsage` AFTER the local ledger write.
 * Cost + token totals are passed in (already computed by the caller) so this module never imports
 * `llm-usage.ts` — avoids a circular import and re-computation.
 */
export function pushLlmUsage(entry: {
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
}): void {
  if (!usageMonitorEnabled()) return;
  try {
    const hasCost = typeof entry.costUsd === "number" && Number.isFinite(entry.costUsd);
    enqueue({
      sourceApp: SOURCE_APP,
      environment: usageMonitorEnv(),
      provider: entry.provider,
      service: "llm",
      label: entry.context,
      keyRef: entry.keyRef,
      billingMode: "estimated",
      metricType: hasCost ? "cost" : "usage",
      quantity: entry.totalTokens,
      unit: "token",
      costUsd: hasCost ? entry.costUsd : undefined,
      requests: 1,
      confidence: "estimated",
      occurredAt: new Date().toISOString(),
      metadata: cleanMetadata({
        model: entry.model ?? null,
        context: entry.context ?? null,
        userId: entry.userId,
        keySource: entry.keySource,
        promptTokens: entry.promptTokens ?? null,
        completionTokens: entry.completionTokens ?? null,
      }),
    });
  } catch {
    /* telemetry must never break the caller */
  }
}

/**
 * Record one RAG (Voyage / Pinecone) op's usage/cost. Called from `recordRagUsage` after the local
 * ledger write. Cost is passed in (already computed by the caller).
 */
export function pushRagUsage(entry: {
  provider: string;
  operation: string;
  model?: string;
  userId: string;
  tokensIn?: number;
  tokensOut?: number;
  batchCount?: number;
  costUsd?: number;
}): void {
  if (!usageMonitorEnabled()) return;
  try {
    const hasCost = typeof entry.costUsd === "number" && Number.isFinite(entry.costUsd);
    const isPinecone = entry.provider === "pinecone";
    const quantity = isPinecone ? (entry.tokensIn ?? 0) : (entry.tokensIn ?? 0) + (entry.tokensOut ?? 0);
    // Voyage embed/rerank quantities are token estimates. Pinecone query/upsert quantities are
    // Read/Write Units in tokensIn, with records kept separately in metadata.
    const unit: UsageUnit = isPinecone ? "credit" : "token";
    enqueue({
      sourceApp: SOURCE_APP,
      environment: usageMonitorEnv(),
      provider: entry.provider,
      service: "rag",
      label: entry.operation,
      keyRef: undefined, // RAG keys are app-funded; no per-attached-key fingerprint today
      billingMode: "estimated",
      metricType: hasCost ? "cost" : "usage",
      quantity: quantity > 0 ? quantity : undefined,
      unit,
      costUsd: hasCost ? entry.costUsd : undefined,
      requests: 1,
      confidence: "estimated",
      occurredAt: new Date().toISOString(),
      metadata: cleanMetadata({
        model: entry.model ?? null,
        operation: entry.operation,
        userId: entry.userId,
        batchCount: entry.batchCount ?? null,
        recordCount: isPinecone ? entry.tokensOut ?? null : null,
      }),
    });
  } catch {
    /* telemetry must never break the caller */
  }
}

/**
 * Record broker account balances and limits.
 */
export function pushBrokerBalance(entry: {
  provider: string;
  userId: string;
  accountNumber: string;
  cash?: number;
  buyingPower?: number;
  equity?: number;
}): void {
  if (!usageMonitorEnabled()) return;
  try {
    const occurredAt = new Date().toISOString();
    if (typeof entry.cash === "number") {
      enqueue({
        sourceApp: SOURCE_APP,
        environment: usageMonitorEnv(),
        provider: entry.provider,
        service: "broker",
        billingMode: "actual",
        metricType: "balance",
        quantity: entry.cash,
        unit: "usd",
        confidence: "actual",
        occurredAt,
        metadata: cleanMetadata({
          userId: entry.userId,
          accountNumber: entry.accountNumber,
          metric: "cash"
        }),
      });
    }
    if (typeof entry.buyingPower === "number") {
      enqueue({
        sourceApp: SOURCE_APP,
        environment: usageMonitorEnv(),
        provider: entry.provider,
        service: "broker",
        billingMode: "actual",
        metricType: "limit",
        quantity: entry.buyingPower,
        unit: "usd",
        confidence: "actual",
        occurredAt,
        metadata: cleanMetadata({
          userId: entry.userId,
          accountNumber: entry.accountNumber,
          metric: "buyingPower"
        }),
      });
    }
    if (typeof entry.equity === "number") {
      enqueue({
        sourceApp: SOURCE_APP,
        environment: usageMonitorEnv(),
        provider: entry.provider,
        service: "broker",
        billingMode: "actual",
        metricType: "balance",
        quantity: entry.equity,
        unit: "usd",
        confidence: "actual",
        occurredAt,
        metadata: cleanMetadata({
          userId: entry.userId,
          accountNumber: entry.accountNumber,
          metric: "equity"
        }),
      });
    }
  } catch {
    /* telemetry must never break the caller */
  }
}

// ── Aggregate: market-data / broker call-volume ────────────────────────────────

/**
 * Count one external market-data or broker API call. Called from the central `fetchWithRetry`
 * wrapper (`data-providers.ts`) and the broker choke points (`alpaca.ts`, `robinhood.ts`). This is
 * on a hot path, so it only mutates an in-memory per-provider counter — the counts are flushed as a
 * single aggregated `requests`-count event per provider per window (never one POST per call).
 */
export function recordProviderCall(
  provider: string,
  opts: { service?: string; ok?: boolean; keySource?: string; userId?: string } = {}
): void {
  if (!usageMonitorEnabled()) return;
  // Never re-count the telemetry channel's own health calls (would loop).
  if (provider === HEALTH_SERVICE) return;
  try {
    // Key by credential lane too, so a user's own market-data key isn't conflated with shared/
    // operator quota in the monitor.
    const key = [provider, opts.service ?? "", opts.keySource ?? "", opts.userId ?? ""].join("|");
    const entry =
      state.callVolume.get(key) ??
      { provider, service: opts.service, keySource: opts.keySource, userId: opts.userId, requests: 0, successes: 0, failures: 0 };
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

function enqueue(event: UsageMonitorEvent): void {
  state.queue.push(event);
  scheduleFlush();
}

function scheduleFlush(): void {
  if (state.flushTimer) return;
  const timer = setTimeout(() => {
    state.flushTimer = null;
    void flushUsageMonitor();
  }, flushDelayMs());
  // Don't keep the process alive just for a pending telemetry flush.
  (timer as { unref?: () => void }).unref?.();
  state.flushTimer = timer;
}

function drainCallVolume(now: string): UsageMonitorEvent[] {
  const events: UsageMonitorEvent[] = [];
  for (const entry of state.callVolume.values()) {
    if (entry.requests <= 0) continue;
    events.push({
      sourceApp: SOURCE_APP,
      environment: usageMonitorEnv(),
      provider: entry.provider,
      service: entry.service,
      billingMode: "actual",
      metricType: "usage",
      unit: "request",
      requests: entry.requests,
      confidence: "actual",
      occurredAt: now,
      metadata: cleanMetadata({
        successes: entry.successes,
        failures: entry.failures,
        keySource: entry.keySource ?? null,
        userId: entry.userId ?? null,
      }),
    });
  }
  state.callVolume.clear();
  return events;
}

/**
 * Flush all buffered events (discrete cost events + aggregated call-volume) to the monitor. Batched
 * at MAX_BATCH per POST. Never throws. Exported for tests and internal scheduling.
 */
export async function flushUsageMonitor(): Promise<void> {
  if (state.flushTimer) {
    clearTimeout(state.flushTimer);
    state.flushTimer = null;
  }
  if (!usageMonitorEnabled()) {
    // Drop anything buffered while disabled so it can't leak later if the env is toggled mid-process.
    state.queue.length = 0;
    state.callVolume.clear();
    return;
  }

  const now = new Date().toISOString();
  const pending = state.queue.splice(0, state.queue.length).concat(drainCallVolume(now));
  if (pending.length === 0) return;

  for (let i = 0; i < pending.length; i += MAX_BATCH) {
    await postBatch(pending.slice(i, i + MAX_BATCH));
  }
}

async function postBatch(events: UsageMonitorEvent[]): Promise<void> {
  const baseUrl = usageMonitorBaseUrl();
  const token = usageMonitorToken();
  if (!baseUrl || !token || events.length === 0) return;

  const fetchImpl = state.fetchImpl ?? fetch;
  const url = `${baseUrl}${INGEST_PATH}`;
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ events }),
      signal: controller.signal,
      cache: "no-store",
    });
    logApiHealth({
      service: HEALTH_SERVICE,
      ok: res.ok,
      latencyMs: Date.now() - start,
      errorText: res.ok ? undefined : `HTTP ${res.status}`,
    });
  } catch (err) {
    logApiHealth({
      service: HEALTH_SERVICE,
      ok: false,
      latencyMs: Date.now() - start,
      errorText: err instanceof Error ? err.message : String(err),
    });
  } finally {
    clearTimeout(timer);
  }
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
  state.queue.length = 0;
  state.callVolume.clear();
  state.fetchImpl = null;
}
