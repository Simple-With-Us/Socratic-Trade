// db-settings.ts — user/global settings, internal settings, DataPoolConsent, MarketDataDemand
// All functions depend on getDb() and audit() from "./db" (the core barrel).
import { audit } from "./db";
import { getDrizzle } from "./db/client";
import { settings, userSettings, marketDataDemands } from "./db/schema";
import { eq, like, and, lte, gt } from "drizzle-orm";
import { sql } from "drizzle-orm";

// ── Global settings (legacy/internal) ─────────────────────────────────────────

export function getSetting<T>(key: string, fallback: T): T {
  const row = getDrizzle().select().from(settings).where(eq(settings.key, key)).get();
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return row.value as unknown as T;
  }
}

export function setSetting(key: string, value: unknown): void {
  const updated_at = new Date().toISOString();
  const stringValue = JSON.stringify(value);
  getDrizzle()
    .insert(settings)
    .values({ key, value: stringValue, updated_at })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: stringValue, updated_at }
    })
    .run();
  audit("policy_change", { key, value });
}

export function getInternalSetting<T>(key: string): T | undefined {
  const row = getDrizzle().select().from(settings).where(eq(settings.key, key)).get();
  if (!row) return undefined;
  return JSON.parse(row.value) as T;
}

export function setInternalSetting(key: string, value: unknown): void {
  const updated_at = new Date().toISOString();
  const stringValue = JSON.stringify(value);
  getDrizzle()
    .insert(settings)
    .values({ key, value: stringValue, updated_at })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: stringValue, updated_at }
    })
    .run();
}

export function deleteInternalSetting(key: string): void {
  getDrizzle().delete(settings).where(eq(settings.key, key)).run();
}

/** Find the first settings row whose key matches a LIKE pattern.  Used for
 *  state-recovery during OAuth callbacks where userId is not yet in scope. */
export function findInternalSettingByKeyLike<T>(pattern: string): { key: string; value: T } | undefined {
  const row = getDrizzle().select().from(settings).where(like(settings.key, pattern)).limit(1).get();
  if (!row) return undefined;
  return { key: row.key, value: JSON.parse(row.value) as T };
}

// ── Per-user settings ──────────────────────────────────────────────────────────

export function getUserSetting<T>(userId: string, key: string, fallback: T): T {
  const row = getDrizzle().select().from(userSettings).where(and(eq(userSettings.user_id, userId), eq(userSettings.key, key))).get();
  if (!row) return fallback;
  try { return JSON.parse(row.value) as T; } catch { return row.value as unknown as T; }
}

export function setUserSetting(userId: string, key: string, value: unknown): void {
  const id = `${userId}_${key}`;
  const updated_at = new Date().toISOString();
  const stringValue = JSON.stringify(value);
  getDrizzle().insert(userSettings).values({
    id,
    user_id: userId,
    key,
    value: stringValue,
    updated_at
  }).onConflictDoUpdate({
    target: [userSettings.user_id, userSettings.key],
    set: { value: stringValue, updated_at }
  }).run();
  audit("policy_change", { userId, key, value }, userId);
}

// ── Shared market-data pool consent ───────────────────────────────────────────
// A user may opt into a reciprocal market-data pool: GENERAL market data (quotes, fundamentals,
// OHLC, news) pulled via THEIR provider keys / broker MCP is contributed to a shared cache that
// other consenting users can read, and in exchange they read data others contributed. This pools
// API spend and enriches everyone's data. SCOPE BOUNDARY: only general market data is pooled —
// a user's PERSONAL account data (positions, orders, balances, P&L, credentials) is NEVER pooled.
export interface DataPoolConsent {
  accepted: boolean;
  acceptedAt: string | null;
  version: number;
}
/** Bump when the consent terms materially change so prior acceptances must be re-confirmed. */
export const DATA_POOL_CONSENT_VERSION = 1;

export function getDataPoolConsent(userId: string = "local"): DataPoolConsent {
  return getUserSetting<DataPoolConsent>(userId, "data_pool_consent", { accepted: false, acceptedAt: null, version: 0 });
}

export function setDataPoolConsent(userId: string, accepted: boolean): DataPoolConsent {
  const record: DataPoolConsent = {
    accepted,
    acceptedAt: accepted ? new Date().toISOString() : null,
    version: DATA_POOL_CONSENT_VERSION
  };
  setUserSetting(userId, "data_pool_consent", record);
  audit("data_pool_consent", { userId, accepted, version: DATA_POOL_CONSENT_VERSION }, userId);
  return record;
}

/** True only when the user has accepted the CURRENT consent version (re-prompt on a version bump). */
export function hasDataPoolConsent(userId: string = "local"): boolean {
  const c = getDataPoolConsent(userId);
  return c.accepted === true && (c.version ?? 0) >= DATA_POOL_CONSENT_VERSION;
}

// ── Learned-context sharing preferences ──────────────────────────────────────
// Two independent opt-in/out flags stored as user_settings:
//   includeShared   (default TRUE)  — the user benefits from the shared fact pool.
//   contributeShared (default TRUE)  — the user contributes their own fact-tier learnings back.
//
// Only FACT-tier learned_context rows are ever eligible to become scope='shared'.
// Risk / strategy-directive rows never reach this path (they go to the pending queue).
// PII is already excluded upstream before ingestLearned is called.
export interface LearnedContextSharingPrefs {
  /** Read shared facts written by other opted-in users. Default true. */
  includeShared: boolean;
  /** Contribute this user's own learned facts to the shared pool. Default true. */
  contributeShared: boolean;
}

const LEARNED_CONTEXT_SHARING_KEY = "learned_context_sharing";

export function getLearnedContextSharing(userId: string): LearnedContextSharingPrefs {
  return getUserSetting<LearnedContextSharingPrefs>(userId, LEARNED_CONTEXT_SHARING_KEY, {
    includeShared: true,
    contributeShared: true
  });
}

export function setLearnedContextSharing(userId: string, prefs: Partial<LearnedContextSharingPrefs>): LearnedContextSharingPrefs {
  const current = getLearnedContextSharing(userId);
  const next: LearnedContextSharingPrefs = { ...current, ...prefs };
  setUserSetting(userId, LEARNED_CONTEXT_SHARING_KEY, next);
  return next;
}

// ── Market-data demand queue ───────────────────────────────────────────────────

export type MarketDataDemandKind = "history";

export interface MarketDataDemandFill {
  kind: MarketDataDemandKind;
  symbol: string;
  pendingUserCount: number;
  oldestRequestedAt: string;
  latestRequestedAt: string;
  fulfilledAt: string;
}

function marketDataDemandTtlMs(): number {
  const parsed = Number(process.env.MARKET_DATA_PENDING_TTL_MS ?? 30 * 60_000);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30 * 60_000;
}

function normalizeDemandSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function isoFromNow(now: number | string | Date): string {
  if (typeof now === "string") return now;
  return new Date(now).toISOString();
}

function pruneExpiredMarketDataDemands(nowIso: string): void {
  getDrizzle().update(marketDataDemands)
    .set({ status: 'expired' })
    .where(and(eq(marketDataDemands.status, 'pending'), lte(marketDataDemands.expires_at, nowIso)))
    .run();
}

export function recordMarketDataDemand(input: {
  kind: MarketDataDemandKind;
  symbol: string;
  userId?: string;
  now?: number | string | Date;
  ttlMs?: number;
}): void {
  const kind = input.kind;
  const symbol = normalizeDemandSymbol(input.symbol);
  if (!symbol) return;
  const userId = input.userId ?? "local";
  const nowIso = isoFromNow(input.now ?? new Date());
  const ttlMs = Number.isFinite(input.ttlMs) && input.ttlMs! > 0 ? input.ttlMs! : marketDataDemandTtlMs();
  const expiresAt = new Date(Date.parse(nowIso) + ttlMs).toISOString();
  const id = `${kind}:${symbol}:${userId}`;
  
  pruneExpiredMarketDataDemands(nowIso);
  
  // Note: ON CONFLICT DO UPDATE SET requested_at = CASE ... END is somewhat complex in Drizzle.
  // We can use sql\`\` operator to achieve the same result.
  getDrizzle().insert(marketDataDemands).values({
    id,
    kind,
    symbol,
    user_id: userId,
    status: 'pending',
    requested_at: nowIso,
    last_requested_at: nowIso,
    fulfilled_at: null,
    expires_at: expiresAt
  }).onConflictDoUpdate({
    target: [marketDataDemands.kind, marketDataDemands.symbol, marketDataDemands.user_id],
    set: {
      status: 'pending',
      requested_at: sql`CASE WHEN market_data_demands.status = 'pending' THEN market_data_demands.requested_at ELSE ${nowIso} END`,
      last_requested_at: nowIso,
      fulfilled_at: null,
      expires_at: expiresAt
    }
  }).run();
}

export function fulfillMarketDataDemand(input: {
  kind: MarketDataDemandKind;
  symbol: string;
  now?: number | string | Date;
}): MarketDataDemandFill | undefined {
  const kind = input.kind;
  const symbol = normalizeDemandSymbol(input.symbol);
  if (!symbol) return undefined;
  const fulfilledAt = isoFromNow(input.now ?? new Date());
  pruneExpiredMarketDataDemands(fulfilledAt);
  
  const rows = getDrizzle()
    .select({ user_id: marketDataDemands.user_id, requested_at: marketDataDemands.requested_at, last_requested_at: marketDataDemands.last_requested_at })
    .from(marketDataDemands)
    .where(and(
      eq(marketDataDemands.kind, kind),
      eq(marketDataDemands.symbol, symbol),
      eq(marketDataDemands.status, 'pending'),
      gt(marketDataDemands.expires_at, fulfilledAt)
    ))
    .all();

  if (rows.length === 0) return undefined;

  getDrizzle()
    .update(marketDataDemands)
    .set({ status: 'fulfilled', fulfilled_at: fulfilledAt })
    .where(and(
      eq(marketDataDemands.kind, kind),
      eq(marketDataDemands.symbol, symbol),
      eq(marketDataDemands.status, 'pending'),
      gt(marketDataDemands.expires_at, fulfilledAt)
    ))
    .run();

  return {
    kind,
    symbol,
    pendingUserCount: new Set(rows.map((row) => row.user_id)).size,
    oldestRequestedAt: rows.reduce((min, row) => (row.requested_at < min ? row.requested_at : min), rows[0].requested_at),
    latestRequestedAt: rows.reduce((max, row) => (row.last_requested_at > max ? row.last_requested_at : max), rows[0].last_requested_at),
    fulfilledAt
  };
}

export function clearMarketDataDemandsForTests(): void {
  getDrizzle().delete(marketDataDemands).run();
}

// ── Per-user auto-resume-on-boot ─────────────────────────────────────────────
// Replaces the blunt AUTONOMY_RESUME_ON_BOOT env var with a per-user toggle
// stored in user_settings. When enabled, the user's accounts auto-resume on
// server boot; when disabled (default), they stay halted.

const AUTO_RESUME_ON_BOOT_KEY = "auto_resume_on_boot";

export function getAutoResumeOnBoot(userId: string): boolean {
  return getUserSetting<boolean>(userId, AUTO_RESUME_ON_BOOT_KEY, false);
}

export function setAutoResumeOnBoot(userId: string, enabled: boolean): void {
  setUserSetting(userId, AUTO_RESUME_ON_BOOT_KEY, enabled);
  audit("auto_resume_on_boot", { userId, enabled }, userId);
}
