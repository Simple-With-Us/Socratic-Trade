// Event-driven LLM-trigger engine (Phase 0/2 of the expert-panel design — see
// docs/event-driven-llm-triggering.md for the full policy).
//
// DEFAULT OFF: with TRIGGER_ENGINE unset, the scheduler runs on the fixed interval exactly as
// before and submitMaterialEvent/broadcastMaterialEvent are no-ops. When enabled, material events
// are deduped, COALESCED over a debounce window (a storm of events → ONE run), then GATED
// (market hours + global/per-symbol cooldown + hourly/daily caps) before firing one strategy run.
//
// Defaults below are the panel's reconciled paper-mode numbers. Per-user policy fields for these
// caps are deferred (the policy schema was just migrated; env config ships first).
//
// G8(a) hard per-user/day LLM token-budget ceiling: checked at this trigger entry (fire(), just
// before runStrategyOnce) via checkLlmDailyBudget(), which sums TODAY's usage for the user from the
// ledger in llm-usage.ts. Default OFF (TRIGGER_LLM_DAILY_TOKEN_BUDGET unset => no ceiling), so
// existing behavior is byte-identical until an operator opts in.

import { audit, getDb, getPolicy, listUsers } from "./db";
import { checkLlmDailyBudget } from "./llm-budget";
import { isRunAllowedNow } from "./market-hours";
import type { TradingPolicy } from "./types";

export type TriggerMode = "interval" | "event" | "both";

export interface MaterialEvent {
  type: string; // "sec8k" | "regime" | "technical" | "insider" | "congress" | ...
  symbol?: string;
  sourceId: string; // stable id for dedup (accession, filing id, regime transition, ...)
  reason?: string;
}

interface UserTriggerRuntime {
  timer: NodeJS.Timeout | null;
}

const globalForTriggers = globalThis as unknown as {
  __triggerRuntime?: Map<string, UserTriggerRuntime>;
  __triggerFires?: Set<string>;
};
const runtimes: Map<string, UserTriggerRuntime> =
  globalForTriggers.__triggerRuntime ?? (globalForTriggers.__triggerRuntime = new Map());
const firesInFlight: Set<string> =
  globalForTriggers.__triggerFires ?? (globalForTriggers.__triggerFires = new Set());

const DURABLE_TRIGGER_STATE_KEY = "material_trigger_state_v1";
const DURABLE_TRIGGER_STATE_VERSION = 1;
const DEFAULT_TRIGGER_CLAIM_TTL_MS = 10 * 60_000;
const DEFAULT_TRIGGER_QUEUE_MAX = 5_000;
const SEC8K_DEDUP_TTL_MS = 30 * 24 * 60 * 60_000;

interface DurablePendingMaterialEvent {
  key: string;
  event: MaterialEvent;
  enqueuedAtMs: number;
  claimOwner?: string;
  claimExpiresAtMs?: number;
  retryAfterMs?: number;
}

interface DurableMaterialTriggerState {
  version: 1;
  pending: DurablePendingMaterialEvent[];
  receipts: Record<string, number>;
  lastRunMs: number;
  hourStartMs: number;
  hourCount: number;
  dayStartMs: number;
  dayCount: number;
  perSymbolMs: Record<string, number>;
}

export interface DurableMaterialTriggerStatus {
  pending: number;
  claimed: number;
  receiptCount: number;
}

// ── Config (env, with the panel's default numbers) ────────────────────────────
function envFlag(name: string, dflt = false): boolean {
  const v = String(process.env[name] ?? "").trim().toLowerCase();
  if (!v) return dflt;
  return ["1", "true", "on", "yes"].includes(v);
}
function envNum(name: string, dflt: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
}

export function triggerEngineEnabled(): boolean {
  return envFlag("TRIGGER_ENGINE", false);
}
export function triggerMode(): TriggerMode {
  const m = String(process.env.TRIGGER_MODE ?? "both").trim().toLowerCase();
  return m === "interval" || m === "event" ? m : "both";
}

// ── Per-account trigger config (policy.triggerSettings — 2026-07-28) ─────────
// Every resolution below falls back to the global env when the account has no explicit setting,
// so an unset triggerSettings is byte-identical to the pre-existing env-only behavior.

export interface AccountTriggerConfig {
  /** Effective engine on/off for this account (per-account override ?? global env). */
  enabled: boolean;
  /** Effective run mix for this account (per-account override ?? global TRIGGER_MODE). */
  mode: TriggerMode;
  /** Event-mode safety floor: run the cadence lane at least this often. Unset = never. */
  fallbackIntervalMinutes?: number;
  /** What an event-triggered run may do. Default "full" (current behavior). */
  eventRunMode: "full" | "close_only";
}

export function resolveAccountTriggerConfig(policy: Pick<TradingPolicy, "triggerSettings" | "runCadenceMinutes">): AccountTriggerConfig {
  const settings = policy.triggerSettings;
  return {
    enabled: settings?.enabled ?? triggerEngineEnabled(),
    mode: settings?.mode ?? triggerMode(),
    fallbackIntervalMinutes:
      typeof settings?.fallbackIntervalMinutes === "number" && settings.fallbackIntervalMinutes > 0
        ? settings.fallbackIntervalMinutes
        : undefined,
    eventRunMode: settings?.eventRunMode === "close_only" ? "close_only" : "full"
  };
}

export interface CadenceLaneDecision {
  /** Whether the fixed-interval cadence lane runs for this account at all. */
  run: boolean;
  /** The cadence to use when it runs (the fallback interval when in event mode with one set). */
  cadenceMinutes: number;
}

/**
 * Pure cadence-lane decision for the scheduler. The lane runs when: the engine is disabled for
 * the account (pure interval — the current default behavior), OR the effective mode includes
 * interval ("interval"/"both"), OR the effective mode is "event" AND a fallbackIntervalMinutes
 * floor is set (then that floor, not runCadenceMinutes, is the cadence).
 */
export function cadenceLaneDecision(policy: Pick<TradingPolicy, "triggerSettings" | "runCadenceMinutes">): CadenceLaneDecision {
  const config = resolveAccountTriggerConfig(policy);
  const base = policy.runCadenceMinutes ?? 60;
  if (!config.enabled) return { run: true, cadenceMinutes: base };
  if (config.mode !== "event") return { run: true, cadenceMinutes: base };
  if (config.fallbackIntervalMinutes !== undefined) return { run: true, cadenceMinutes: config.fallbackIntervalMinutes };
  return { run: false, cadenceMinutes: base };
}
const debounceMs = () => envNum("TRIGGER_DEBOUNCE_MS", 90_000);
const maxDebounceMs = () => envNum("TRIGGER_MAX_DEBOUNCE_MS", 300_000);
const maxBatch = () => Math.max(1, Math.floor(envNum("TRIGGER_MAX_BATCH", 25)));
const globalCooldownMs = () => envNum("TRIGGER_GLOBAL_COOLDOWN_SEC", 300) * 1000;
const perSymbolCooldownMs = () => envNum("TRIGGER_PER_SYMBOL_COOLDOWN_SEC", 1800) * 1000;
const maxRunsPerHour = () => envNum("TRIGGER_MAX_RUNS_PER_HOUR", 6);
const maxRunsPerDay = () => envNum("TRIGGER_MAX_RUNS_PER_DAY", 24);
const dedupTtlMs = () => envNum("TRIGGER_DEDUP_TTL_SEC", 86_400) * 1000;
const triggerClaimTtlMs = () => Math.max(1_000, envNum("TRIGGER_CLAIM_TTL_MS", DEFAULT_TRIGGER_CLAIM_TTL_MS));
const triggerQueueMax = () => Math.max(1, Math.floor(envNum("TRIGGER_QUEUE_MAX", DEFAULT_TRIGGER_QUEUE_MAX)));

type TriggerDatabase = ReturnType<typeof getDb>;

function runtimeFor(userId: string): UserTriggerRuntime {
  let runtime = runtimes.get(userId);
  if (!runtime) {
    runtime = { timer: null };
    runtimes.set(userId, runtime);
  }
  return runtime;
}

function emptyDurableState(): DurableMaterialTriggerState {
  return {
    version: DURABLE_TRIGGER_STATE_VERSION,
    pending: [],
    receipts: {},
    lastRunMs: 0,
    hourStartMs: 0,
    hourCount: 0,
    dayStartMs: 0,
    dayCount: 0,
    perSymbolMs: {}
  };
}

function parseDurableState(raw: string | undefined): DurableMaterialTriggerState {
  if (!raw) return emptyDurableState();
  let value: Partial<DurableMaterialTriggerState>;
  try {
    value = JSON.parse(raw) as Partial<DurableMaterialTriggerState>;
  } catch (error) {
    throw new Error("Durable material-trigger state is invalid JSON.", { cause: error });
  }
  if (value.version !== DURABLE_TRIGGER_STATE_VERSION || !Array.isArray(value.pending)) {
    throw new Error("Durable material-trigger state has an unsupported shape.");
  }
  return {
    ...emptyDurableState(),
    ...value,
    version: DURABLE_TRIGGER_STATE_VERSION,
    pending: value.pending.filter((row): row is DurablePendingMaterialEvent => Boolean(
      row && typeof row.key === "string" && row.key &&
      typeof row.enqueuedAtMs === "number" && Number.isFinite(row.enqueuedAtMs) &&
      row.event && typeof row.event.type === "string" && typeof row.event.sourceId === "string"
    )),
    receipts: value.receipts && typeof value.receipts === "object" ? value.receipts : {},
    perSymbolMs: value.perSymbolMs && typeof value.perSymbolMs === "object" ? value.perSymbolMs : {}
  };
}

function readDurableState(database: TriggerDatabase, userId: string): DurableMaterialTriggerState {
  const row = database
    .prepare("SELECT value FROM user_settings WHERE user_id = ? AND key = ?")
    .get(userId, DURABLE_TRIGGER_STATE_KEY) as { value: string } | undefined;
  return parseDurableState(row?.value);
}

function writeDurableState(
  database: TriggerDatabase,
  userId: string,
  state: DurableMaterialTriggerState,
  nowMs: number
): void {
  database.prepare(
    "INSERT INTO user_settings (id, user_id, key, value, updated_at) VALUES (?, ?, ?, ?, ?) " +
    "ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).run(
    `${userId}:${DURABLE_TRIGGER_STATE_KEY}`,
    userId,
    DURABLE_TRIGGER_STATE_KEY,
    JSON.stringify(state),
    new Date(nowMs).toISOString()
  );
}

function eventKey(event: MaterialEvent): string {
  return `${event.type}:${event.symbol ?? "*"}:${event.sourceId}`;
}

function eventReceiptTtlMs(event: MaterialEvent): number {
  return event.type === "sec8k" ? Math.max(dedupTtlMs(), SEC8K_DEDUP_TTL_MS) : dedupTtlMs();
}

function pruneDurableReceipts(state: DurableMaterialTriggerState, nowMs: number): void {
  for (const [key, expiresAtMs] of Object.entries(state.receipts)) {
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) delete state.receipts[key];
  }
}

/**
 * Caller-owned transaction seam used by SEC discovery: no nested BEGIN is opened, so dataset,
 * RAG queues, and every per-user trigger inbox either commit together or all roll back.
 */
export function enqueueMaterialEventsForUsersTx(
  database: TriggerDatabase,
  userIds: string[],
  events: MaterialEvent[],
  nowMs: number = Date.now()
): number {
  if (events.length === 0 || userIds.length === 0) return 0;
  let inserted = 0;
  for (const userId of [...new Set(userIds)]) {
    const state = readDurableState(database, userId);
    pruneDurableReceipts(state, nowMs);
    const pendingKeys = new Set(state.pending.map((row) => row.key));
    let changed = false;
    for (const event of events) {
      const key = eventKey(event);
      if (pendingKeys.has(key) || (state.receipts[key] ?? 0) > nowMs) continue;
      if (state.pending.length >= triggerQueueMax()) {
        throw new Error(`Durable material-trigger queue is full for user ${userId}.`);
      }
      state.pending.push({ key, event, enqueuedAtMs: nowMs });
      pendingKeys.add(key);
      changed = true;
      inserted += 1;
    }
    if (changed) writeDurableState(database, userId, state, nowMs);
  }
  return inserted;
}

function enqueueMaterialEvents(userIds: string[], events: MaterialEvent[], nowMs: number): number {
  const database = getDb();
  return database.transaction(() =>
    enqueueMaterialEventsForUsersTx(database, userIds, events, nowMs)
  ).immediate() as number;
}

/** Active-account fanout snapshot used by global producers before their atomic enqueue. */
export function eligibleMaterialTriggerUserIds(): string[] {
  if (!triggerEngineEnabled() || triggerMode() === "interval") return [];
  return listUsers().filter((userId) => {
    const policy = getPolicy(userId);
    // Per-account opt-out (2026-07-28): an explicit triggerSettings.enabled === false keeps this
    // account out of the event lane entirely; unset follows the global env exactly as before.
    if (policy.triggerSettings?.enabled === false) return false;
    return policy.systemState === "active" && Boolean(policy.accountNumber);
  });
}

export function getDurableMaterialTriggerStatus(userId: string): DurableMaterialTriggerStatus {
  const state = readDurableState(getDb(), userId);
  const nowMs = Date.now();
  return {
    pending: state.pending.length,
    claimed: state.pending.filter((row) => (row.claimExpiresAtMs ?? 0) > nowMs).length,
    receiptCount: Object.values(state.receipts).filter((expiresAtMs) => expiresAtMs > nowMs).length
  };
}

export function hasDurableMaterialTriggerWork(): boolean {
  const rows = getDb()
    .prepare("SELECT value FROM user_settings WHERE key = ?")
    .all(DURABLE_TRIGGER_STATE_KEY) as Array<{ value: string }>;
  return rows.some((row) => parseDurableState(row.value).pending.length > 0);
}

function scheduleDurableUser(userId: string, nowMs: number = Date.now()): void {
  const runtime = runtimeFor(userId);
  const state = readDurableState(getDb(), userId);
  if (state.pending.length === 0) {
    if (runtime.timer) clearTimeout(runtime.timer);
    runtime.timer = null;
    return;
  }
  if (firesInFlight.has(userId)) return;
  const liveClaimExpiries = state.pending
    .map((row) => row.claimExpiresAtMs ?? 0)
    .filter((expiresAtMs) => expiresAtMs > nowMs);
  const eligible = state.pending.filter((row) =>
    (row.claimExpiresAtMs ?? 0) <= nowMs && (row.retryAfterMs ?? 0) <= nowMs
  );
  let dueAt: number;
  if (liveClaimExpiries.length > 0) {
    dueAt = Math.min(...liveClaimExpiries);
  } else if (eligible.length === 0) {
    dueAt = Math.min(...state.pending.map((row) => Math.max(nowMs + 1, row.retryAfterMs ?? nowMs + 1)));
  } else {
    const firstEnqueuedAt = Math.min(...eligible.map((row) => row.enqueuedAtMs));
    const lastEnqueuedAt = Math.max(...eligible.map((row) => row.enqueuedAtMs));
    dueAt = eligible.length >= maxBatch()
    ? nowMs
    : Math.min(lastEnqueuedAt + debounceMs(), firstEnqueuedAt + maxDebounceMs());
  }
  if (runtime.timer) clearTimeout(runtime.timer);
  const delay = Math.max(0, dueAt - nowMs);
  runtime.timer = setTimeout(() => {
    runtime.timer = null;
    void fire(userId);
  }, delay);
  runtime.timer.unref?.();
}

/** Recovery entrypoint: persisted inboxes, not timers, are authoritative after a restart. */
export function drainMaterialEventQueue(): void {
  const rows = getDb()
    .prepare("SELECT user_id FROM user_settings WHERE key = ?")
    .all(DURABLE_TRIGGER_STATE_KEY) as Array<{ user_id: string }>;
  for (const row of rows) scheduleDurableUser(row.user_id);
}

/** Submit a material event for one user. No-op unless the engine is on and mode allows events. */
export function submitMaterialEvent(userId: string, event: MaterialEvent): void {
  if (!triggerEngineEnabled() || triggerMode() === "interval") return;
  enqueueMaterialEvents([userId], [event], Date.now());
  scheduleDurableUser(userId);
}

/** Fan a global material event out through durable per-user inboxes before scheduling. */
export function broadcastMaterialEvent(event: MaterialEvent): void {
  const userIds = eligibleMaterialTriggerUserIds();
  if (userIds.length === 0) return;
  enqueueMaterialEvents(userIds, [event], Date.now());
  for (const userId of userIds) scheduleDurableUser(userId);
}

// checkLlmDailyBudget now lives in ./llm-budget (so runStrategyOnce can enforce it as the single
// choke point without a strategy↔triggers cycle). Re-exported here for existing importers
// (scheduler, tests) that reference it via ./triggers.
export { checkLlmDailyBudget };
export type { LlmBudgetDecision } from "./llm-budget";

function rollWindows(state: DurableMaterialTriggerState, nowMs: number): void {
  if (nowMs - state.hourStartMs >= 3_600_000) {
    state.hourStartMs = nowMs;
    state.hourCount = 0;
  }
  if (nowMs - state.dayStartMs >= 86_400_000) {
    state.dayStartMs = nowMs;
    state.dayCount = 0;
  }
}

interface ClaimedMaterialBatch {
  owner: string;
  events: MaterialEvent[];
  keys: string[];
}

function claimMaterialBatch(userId: string, nowMs: number): ClaimedMaterialBatch | undefined {
  const database = getDb();
  return database.transaction(() => {
    const state = readDurableState(database, userId);
    let changed = false;
    for (const row of state.pending) {
      if (row.claimOwner && (row.claimExpiresAtMs ?? 0) <= nowMs) {
        delete row.claimOwner;
        delete row.claimExpiresAtMs;
        changed = true;
      }
    }
    if (state.pending.some((row) => row.claimOwner && (row.claimExpiresAtMs ?? 0) > nowMs)) {
      if (changed) writeDurableState(database, userId, state, nowMs);
      return undefined;
    }
    // FIFO is the durable array order. Claim at most one configured batch so a recovered inbox
    // cannot turn a 5,000-event backlog into one unbounded strategy run; settlement reschedules the
    // untouched tail immediately when it still satisfies the threshold.
    const eligible = state.pending
      .filter((row) => (row.retryAfterMs ?? 0) <= nowMs)
      .slice(0, maxBatch());
    if (eligible.length === 0) {
      if (changed) writeDurableState(database, userId, state, nowMs);
      return undefined;
    }
    const owner = `${process.pid}:${globalThis.crypto.randomUUID()}`;
    const expiresAtMs = nowMs + triggerClaimTtlMs();
    const keys = new Set(eligible.map((row) => row.key));
    for (const row of state.pending) {
      if (!keys.has(row.key)) continue;
      row.claimOwner = owner;
      row.claimExpiresAtMs = expiresAtMs;
    }
    writeDurableState(database, userId, state, nowMs);
    return {
      owner,
      events: eligible.map((row) => row.event),
      keys: eligible.map((row) => row.key)
    };
  }).immediate() as ClaimedMaterialBatch | undefined;
}

function renewMaterialBatch(userId: string, batch: ClaimedMaterialBatch, nowMs: number): boolean {
  const database = getDb();
  return database.transaction(() => {
    const state = readDurableState(database, userId);
    const wanted = new Set(batch.keys);
    const rows = state.pending.filter((row) => wanted.has(row.key));
    if (rows.length !== wanted.size || rows.some((row) => row.claimOwner !== batch.owner)) return false;
    const expiresAtMs = nowMs + triggerClaimTtlMs();
    for (const row of rows) row.claimExpiresAtMs = expiresAtMs;
    writeDurableState(database, userId, state, nowMs);
    return true;
  }).immediate() as boolean;
}

function settleMaterialBatch(
  userId: string,
  batch: ClaimedMaterialBatch,
  nowMs: number,
  outcome: "completed" | "suppressed" | "retry"
): boolean {
  const database = getDb();
  return database.transaction(() => {
    const state = readDurableState(database, userId);
    const wanted = new Set(batch.keys);
    const rows = state.pending.filter((row) => wanted.has(row.key));
    if (rows.length !== wanted.size || rows.some((row) => row.claimOwner !== batch.owner)) return false;
    if (outcome === "retry") {
      const retryAfterMs = nowMs + Math.max(1_000, envNum("TRIGGER_RETRY_DELAY_MS", 60_000));
      for (const row of rows) {
        delete row.claimOwner;
        delete row.claimExpiresAtMs;
        row.retryAfterMs = retryAfterMs;
      }
    } else {
      state.pending = state.pending.filter((row) => !wanted.has(row.key));
      for (const row of rows) {
        state.receipts[row.key] = nowMs + eventReceiptTtlMs(row.event);
      }
      if (outcome === "completed") {
        rollWindows(state, nowMs);
        state.lastRunMs = nowMs;
        state.hourCount += 1;
        state.dayCount += 1;
        for (const row of rows) {
          if (row.event.symbol) state.perSymbolMs[row.event.symbol] = nowMs;
        }
      }
    }
    pruneDurableReceipts(state, nowMs);
    writeDurableState(database, userId, state, nowMs);
    return true;
  }).immediate() as boolean;
}

async function fire(userId: string): Promise<void> {
  if (firesInFlight.has(userId)) return;
  firesInFlight.add(userId);
  const runtime = runtimeFor(userId);
  if (runtime.timer) {
    clearTimeout(runtime.timer);
    runtime.timer = null;
  }
  let batch: ClaimedMaterialBatch | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  try {
    batch = claimMaterialBatch(userId, Date.now());
    if (!batch) return;
    const decision = admitRun(userId, batch.events);
    if (!decision.ok) {
      settleMaterialBatch(userId, batch, Date.now(), "suppressed");
      audit("trigger_suppressed", {
        userId,
        reason: decision.reason,
        events: batch.events.length,
        types: distinctTypes(batch.events)
      }, userId);
      return;
    }

    // NOTE: the daily LLM budget ceiling is enforced INSIDE runStrategyOnce (after its non-LLM
    // risk breakers + reconciliation, before proposal generation), so we always enter the run.
    // Per-account event run scope (2026-07-28): eventRunMode "close_only" runs the strategy with a
    // RUN-SCOPED close_only policy clone (never persisted — see runStrategyOnce's runStateOverride);
    // unset/"full" is byte-identical to before.
    const eventRunMode = resolveAccountTriggerConfig(getPolicy(userId)).eventRunMode;
    audit("trigger_run", {
      userId,
      events: batch.events.length,
      types: distinctTypes(batch.events),
      reason: "event",
      eventRunMode
    }, userId);
    heartbeat = setInterval(() => {
      if (!batch || !renewMaterialBatch(userId, batch, Date.now())) {
        if (heartbeat) clearInterval(heartbeat);
      }
    }, Math.max(500, Math.floor(triggerClaimTtlMs() / 3)));
    heartbeat.unref?.();
    const { runStrategyOnce } = await import("./strategy");
    // Byte-identical invocation for the default path: the options argument is passed ONLY when an
    // override is active, so existing callers/tests asserting runStrategyOnce(userId) are unaffected.
    const strategyResult = eventRunMode === "close_only"
      ? await runStrategyOnce(userId, { runStateOverride: "close_only" })
      : await runStrategyOnce(userId);
    if (!strategyResult || strategyResult.status !== "completed") {
      throw new Error(strategyResult?.summary || "Material-trigger strategy run did not complete.");
    }
    if (!settleMaterialBatch(userId, batch, Date.now(), "completed")) {
      throw new Error("Material-trigger claim was lost before completion could be recorded.");
    }
    // Note: autonomous weight tuning is intentionally NOT hosted here. It runs on a separate, much-slower
    // cadence under the scheduler's single-leader gate (see auto-tune-scheduler.ts + scheduler.ts); the
    // event-driven path fires on material events and would apply weights at the wrong (event) frequency.
  } catch (err) {
    if (batch) settleMaterialBatch(userId, batch, Date.now(), "retry");
    console.error("[triggers] event-driven run error:", err);
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    firesInFlight.delete(userId);
    scheduleDurableUser(userId);
  }
}

/** Gate a candidate run. Exported so a diagnostic route can preview the decision. */
export function admitRun(userId: string, batch: MaterialEvent[]): { ok: boolean; reason?: string } {
  if (!triggerEngineEnabled()) return { ok: false, reason: "engine_off" };
  if (triggerMode() === "interval") return { ok: false, reason: "mode_interval" };
  const policy = getPolicy(userId);
  if (policy.triggerSettings?.enabled === false) return { ok: false, reason: "account_triggers_disabled" };
  if (policy.systemState !== "active") return { ok: false, reason: "system_not_active" };
  if (!policy.accountNumber) return { ok: false, reason: "no_account" };
  if (!isRunAllowedNow(policy.runDuringExtendedHours)) return { ok: false, reason: "market_closed" };

  const state = readDurableState(getDb(), userId);
  const now = Date.now();
  rollWindows(state, now);
  if (now - state.lastRunMs < globalCooldownMs()) return { ok: false, reason: "global_cooldown" };
  if (state.hourCount >= maxRunsPerHour()) return { ok: false, reason: "hourly_cap" };
  if (state.dayCount >= maxRunsPerDay()) return { ok: false, reason: "daily_cap" };
  // Suppress only if EVERY event's symbol is still in its per-symbol cooldown.
  const hasFresh = batch.some((e) => !e.symbol || now - (state.perSymbolMs[e.symbol] ?? 0) >= perSymbolCooldownMs());
  if (!hasFresh) return { ok: false, reason: "per_symbol_cooldown" };
  return { ok: true };
}

function distinctTypes(batch: MaterialEvent[]): string[] {
  return Array.from(new Set(batch.map((e) => e.type)));
}

export function resetTriggersForTesting(): void {
  for (const [userId, runtime] of runtimes.entries()) {
    if (runtime.timer) {
      clearTimeout(runtime.timer);
      runtime.timer = null;
    }
  }
  runtimes.clear();
  firesInFlight.clear();
}
