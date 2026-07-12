// db-api-keys.ts — field-level encryption, user API keys, connected accounts,
// synthetic stops, watchlist, price alerts, notify prefs, chat turns, memory,
// and the catch-all listUsers helper.
import crypto from "crypto";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { getDb, audit } from "./db";
import type {
  AccountCapabilities,
  ChatTurn,
  ChatTurnRole,
  ConnectedAccount,
  MemoryItem,
  NotifyChannelId,
  NotifyPrefs,
  PriceAlert,
  PriceAlertOp,
  PriceAlertStatus,
  WatchlistItem
} from "./types";

// ── Field-Level Encryption ──────────────────────────────────────────────────

// Load .env.local if not already loaded (e.g. at early boot time before Next.js loads env)
if (!process.env.ENCRYPTION_KEY && process.env.NODE_ENV !== "test" && !process.env.VITEST) {
  try {
    const envPath = resolve(process.cwd(), ".env.local");
    if (existsSync(envPath)) {
      const content = readFileSync(envPath, "utf8");
      for (const line of content.split("\n")) {
        const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
        if (match) {
          let value = match[2] || "";
          if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
          if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
          process.env[match[1]] = value;
        }
      }
    }
  } catch (e) {
    // Ignore error
  }
}

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY
  ? Buffer.from(process.env.ENCRYPTION_KEY, "hex")
  : crypto.randomBytes(32); // Fallback to memory-only key if not set (keys will be lost on restart!)
const ALGORITHM = "aes-256-gcm";

/**
 * AES-256-GCM encrypt a string to the compact `iv:authTag:ciphertext` (all hex) envelope. Uses the
 * process `ENCRYPTION_KEY` (or a memory-only key when unset). Exported so other at-rest secrets
 * (e.g. Robinhood OAuth tokens in mcp-oauth.ts) reuse the SAME field-level encryption + the
 * legacy-plaintext-tolerant `decryptValue` below, rather than duplicating the crypto.
 */
export function encryptValue(text: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");
  return `${iv.toString("hex")}:${authTag}:${encrypted}`;
}

/**
 * Decrypt a value produced by `encryptValue`. Values that are NOT the 3-part `iv:tag:ct` envelope are
 * returned unchanged — the legacy-plaintext fallback that lets pre-encryption rows still load. Exported
 * for reuse by other at-rest secret stores (see encryptValue).
 */
export function decryptValue(encryptedText: string): string {
  try {
    const parts = encryptedText.split(":");
    if (parts.length !== 3) return encryptedText; // Legacy unencrypted fallback
    const iv = Buffer.from(parts[0], "hex");
    const authTag = Buffer.from(parts[1], "hex");
    const encrypted = parts[2];
    const decipher = crypto.createDecipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch (e) {
    console.error("Failed to decrypt field:", e);
    return "";
  }
}

// ── Multi-User API Key Storage ──────────────────────────────────────────────

export interface UserApiKey {
  id: string;
  userId: string;
  service: string;
  apiKey: string;
  label?: string;
  createdAt: string;
  updatedAt: string;
}

export type ApiKeySource = "user" | "env" | "none";

const API_KEY_ENV_MAP: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  xai: "XAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  mistral: "MISTRAL_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  finnhub: "FINNHUB_API_KEY",
  fmp: "FMP_API_KEY",
  alphavantage: "ALPHAVANTAGE_API_KEY",
  marketstack: "MARKETSTACK_API_KEY",
  tradier: "TRADIER_API_KEY",
  fred: "FRED_API_KEY",
  sec_edgar_user_agent: "SEC_EDGAR_USER_AGENT",
  massive: "MASSIVE_API_KEY",
  massive_s3_endpoint: "MASSIVE_S3_ENDPOINT",
  massive_bucket: "MASSIVE_BUCKET",
  massive_access_key_id: "MASSIVE_ACCESS_KEY_ID",
  massive_secret_access_key: "MASSIVE_SECRET_ACCESS_KEY",
  pinecone: "PINECONE_API_KEY",
  voyage: "VOYAGE_API_KEY",
  alpaca_paper_api_key: "ALPACA_PAPER_API_KEY",
  alpaca_paper_secret_key: "ALPACA_PAPER_SECRET_KEY",
  apify: "APIFY_API_TOKEN",
  fintechstudios: "FINTECH_STUDIOS_API_KEY",
  powerintell: "FINTECH_STUDIOS_API_KEY",
  tiingo: "TIINGO_API_KEY",
  intrinio: "INTRINIO_API_KEY",
  twelvedata: "TWELVEDATA_API_KEY",
  logodev: "LOGO_DEV_TOKEN",
  logodev_secret: "LOGO_DEV_SECRET_KEY"
};

const API_KEY_SERVICE_ALIASES: Record<string, string> = {
  alpha_vantage: "alphavantage",
  alphavantage_api_key: "alphavantage",
  finnhub_api_key: "finnhub",
  fmp_api_key: "fmp",
  openai_api_key: "openai",
  anthropic_api_key: "anthropic",
  xai_api_key: "xai",
  grok: "xai",
  grok_api_key: "xai",
  xai: "xai",
  gemini: "gemini",
  gemini_api_key: "gemini",
  google_gemini: "gemini",
  google_gemini_api_key: "gemini",
  mistral: "mistral",
  mistral_api_key: "mistral",
  deepseek: "deepseek",
  deepseek_api_key: "deepseek",
  marketstack_api_key: "marketstack",
  tradier_api_key: "tradier",
  fred_api_key: "fred",
  fintech_studios: "fintechstudios",
  fintech_studios_api_key: "fintechstudios",
  powerintell_api_key: "fintechstudios",
  power_intell: "fintechstudios",
  power_intell_api_key: "fintechstudios",
  sec_edgar: "sec_edgar_user_agent",
  sec_edgar_user_agent: "sec_edgar_user_agent",
  massive_api_key: "massive",
  pinecone_api_key: "pinecone",
  voyage_api_key: "voyage",
  alpaca_paper_api_key: "alpaca_paper_api_key",
  alpaca_paper_secret_key: "alpaca_paper_secret_key",
  apify_api_token: "apify",
  tiingo_api_key: "tiingo",
  intrinio_api_key: "intrinio",
  twelve_data: "twelvedata",
  twelve_data_api_key: "twelvedata",
  twelvedata_api_key: "twelvedata",
  logo_dev: "logodev",
  logo_dev_token: "logodev",
  logodev_token: "logodev",
  logo_dev_secret: "logodev_secret",
  logo_dev_secret_key: "logodev_secret",
  logodev_secret_key: "logodev_secret"
};

function keyRowToApiKey(row: {
  id: string;
  user_id: string;
  service: string;
  api_key: string;
  label: string | null;
  created_at: string;
  updated_at: string;
}): UserApiKey {
  return {
    id: row.id,
    userId: row.user_id,
    service: row.service,
    apiKey: decryptValue(row.api_key),
    label: row.label ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function normalizeApiKeyService(service: string): string {
  const normalized = service.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return API_KEY_SERVICE_ALIASES[normalized] ?? normalized;
}

export function apiKeyEnvVarForService(service: string): string | undefined {
  const canonical = normalizeApiKeyService(service);
  return API_KEY_ENV_MAP[canonical];
}

export function listSupportedApiKeyServices(): string[] {
  return Object.keys(API_KEY_ENV_MAP);
}

export function getUserApiKey(userId: string, service: string): UserApiKey | undefined {
  const canonical = normalizeApiKeyService(service);
  const statement = getDb().prepare("SELECT id, user_id, service, api_key, label, created_at, updated_at FROM user_api_keys WHERE user_id = ? AND service = ?");
  const row =
    (statement.get(userId, canonical) as { id: string; user_id: string; service: string; api_key: string; label: string | null; created_at: string; updated_at: string } | undefined) ??
    (canonical !== service
      ? (statement.get(userId, service) as { id: string; user_id: string; service: string; api_key: string; label: string | null; created_at: string; updated_at: string } | undefined)
      : undefined);
  if (!row) return undefined;
  return keyRowToApiKey(row);
}

export function listUserApiKeys(userId: string): UserApiKey[] {
  const rows = getDb()
    .prepare("SELECT id, user_id, service, api_key, label, created_at, updated_at FROM user_api_keys WHERE user_id = ? ORDER BY service")
    .all(userId) as Array<{ id: string; user_id: string; service: string; api_key: string; label: string | null; created_at: string; updated_at: string }>;
  return rows.map(keyRowToApiKey);
}

export function upsertUserApiKey(userId: string, service: string, apiKey: string, label?: string): UserApiKey {
  const canonical = normalizeApiKeyService(service);
  const now = new Date().toISOString();
  const id = `${userId}_${canonical}`;
  const encryptedKey = encryptValue(apiKey);
  getDb()
    .prepare(
      `INSERT INTO user_api_keys (id, user_id, service, api_key, label, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, service) DO UPDATE SET api_key = excluded.api_key, label = excluded.label, updated_at = excluded.updated_at`
    )
    .run(id, userId, canonical, encryptedKey, label ?? null, now, now);
  return { id, userId, service: canonical, apiKey, label, createdAt: now, updatedAt: now };
}

export function deleteUserApiKey(userId: string, service: string): void {
  const canonical = normalizeApiKeyService(service);
  const db = getDb();
  db.prepare("DELETE FROM user_api_keys WHERE user_id = ? AND service = ?").run(userId, canonical);
  if (canonical !== service) {
    db.prepare("DELETE FROM user_api_keys WHERE user_id = ? AND service = ?").run(userId, service);
  }
}

// ── Credential tiers (multi-user key resolution) ────────────────────────────
//
// The app behaves multi-user with a default `local` operator user. Tier decides whether the env
// fallback is a GLOBAL fallback (operator-funded shared resource) or operator-only (a credential a
// non-`local` user must not borrow):
//
//   per-user-only         → env serves ONLY `local` (and no-userId background callers, which map
//                           to `local`). A non-`local` user with no stored key fails closed. This
//                           is reserved for isolation/cost-critical credentials: BROKER keys
//                           (trades execute under an account) and LLM keys (operator-funded spend;
//                           LLM additionally gets a gated operator failover — see
//                           resolveLlmCredential). It is also the safe DEFAULT for any unlisted
//                           service, so a newly-added credential fails closed rather than leaking.
//   shared-operator-infra → env stays a GLOBAL fallback for everyone, because the resource is
//                           operator-funded and non-personal: MARKET DATA (public quotes/bars/
//                           fundamentals — cached in a shared tier benefiting all; a user's own key
//                           still overrides and stays private/pooled), the RAG corpus, the macro
//                           feed, the congressional scraper, notifications. Per-user keys here add
//                           onboarding friction for no isolation benefit.
//
// Bootstrap secrets (ENCRYPTION_KEY, DATABASE_URL, Sentry/Langfuse, webhook/admin tokens, RH OAuth
// app config) never flow through this resolver — they are read directly at startup.
export type CredTier = "per-user-only" | "shared-operator-infra";

export const LOCAL_USER = "local";

// Per-user-only (env = `local` operator only): the LLM keys (openai, anthropic, xai, gemini,
// mistral), alpaca_paper_api_key, alpaca_paper_secret_key — and any UNLISTED service (the
// fail-closed default). Everything below is operator-funded shared infrastructure where env is a
// justified global fallback for all users.
const API_KEY_TIER: Record<string, CredTier> = {
  // Market data — public, operator-funded, shared cache (a user's own key still wins + stays private).
  finnhub: "shared-operator-infra",
  fmp: "shared-operator-infra",
  alphavantage: "shared-operator-infra",
  marketstack: "shared-operator-infra",
  tradier: "shared-operator-infra",
  massive: "shared-operator-infra",
  massive_s3_endpoint: "shared-operator-infra",
  massive_bucket: "shared-operator-infra",
  massive_access_key_id: "shared-operator-infra",
  massive_secret_access_key: "shared-operator-infra",
  fintechstudios: "shared-operator-infra",
  // Macro / corpus / scraper / app-level infra.
  fred: "shared-operator-infra", // free public macro data; one uniform regime signal for all
  apify: "shared-operator-infra", // ~$0.003/day congressional scraper; House coverage benefits all
  pinecone: "shared-operator-infra", // shared operator-ingested SEC corpus; isolation is the query namespace
  voyage: "shared-operator-infra", // embeds the shared corpus; same economic model as pinecone
  sec_edgar_user_agent: "shared-operator-infra", // a UA string SEC requires, not a secret; one per app
  tiingo: "shared-operator-infra",
  intrinio: "shared-operator-infra",
  twelvedata: "shared-operator-infra",
  logodev: "shared-operator-infra",
  logodev_secret: "shared-operator-infra"
};

export function credTierForService(service: string): CredTier {
  return API_KEY_TIER[normalizeApiKeyService(service)] ?? "per-user-only";
}

export function resolveApiKeyWithSource(service: string, userId?: string): { key?: string; source: ApiKeySource; envVar?: string; service: string } {
  const canonical = normalizeApiKeyService(service);
  const envVar = apiKeyEnvVarForService(canonical);

  // 1. A per-user stored key always wins.
  if (userId) {
    const userKey = getUserApiKey(userId, canonical);
    if (userKey?.apiKey) return { key: userKey.apiKey, source: "user", envVar, service: canonical };
  }

  const envKey = envVar ? process.env[envVar] : undefined;

  // 2. shared-operator-infra: env is a global fallback for ANY user (incl. no-userId background).
  if (credTierForService(canonical) === "shared-operator-infra") {
    if (envKey) return { key: envKey, source: "env", envVar, service: canonical };
    return { source: "none", envVar, service: canonical };
  }

  // 3. per-user-only: NO env fallback for anyone — not even `local`. The operator's own env
  //    broker/LLM keys are migrated into the `local` per-user store at boot
  //    (migrateLocalEnvCredentials), so `local` resolves from the store like every other user.
  //    No stored key → fail closed. (`local` is the primary user, not a privileged operator.)
  return { source: "none", envVar, service: canonical };
}

/**
 * Resolves the API key for a given service, checking per-user storage first, then the env
 * fallback — global for shared-operator-infra services, `local`-only for per-user-only ones.
 */
export function resolveApiKey(service: string, userId?: string): string | undefined {
  return resolveApiKeyWithSource(service, userId).key;
}

function rankConnectedAlpacaAccounts(
  accounts: ReturnType<typeof listConnectedAccounts>
): ReturnType<typeof listConnectedAccounts> {
  const ranked = [
    accounts.find((a) => a.isActive && a.environment === "live"),
    accounts.find((a) => a.isActive),
    accounts.find((a) => a.environment === "live"),
    accounts.find((a) => a.environment === "paper"),
    ...accounts
  ];
  const seen = new Set<string>();
  return ranked.filter((account): account is NonNullable<(typeof ranked)[number]> => {
    if (!account || seen.has(account.id)) return false;
    seen.add(account.id);
    return true;
  });
}

function resolveConnectedAlpacaMarketData(userId: string, requireSecret = true): { apiKey: string; secretKey?: string } | undefined {
  const alpacaAccs = listConnectedAccounts(userId).filter((a) => a.broker === "alpaca");
  if (alpacaAccs.length === 0) return undefined;

  for (const account of rankConnectedAlpacaAccounts(alpacaAccs)) {
    const detailed = getConnectedAccount(account.id, userId);
    if (!detailed?.apiKey || (requireSecret && !detailed.apiSecret)) continue;
    return { apiKey: detailed.apiKey, secretKey: detailed.apiSecret };
  }
  return undefined;
}

/**
 * Resolve Alpaca credentials for MARKET DATA (snapshots/news) — NOT trading. A user with their own
 * Alpaca key gets their individual data (private/pooled, source "user"); otherwise the operator's
 * paper key (`local` store → env) serves as the SHARED market-data source (source "env" → shared
 * cache) for background refreshes and tenants without their own key. Alpaca market data is identical
 * for paper and live accounts, so the operator's paper key is a fine shared source.
 *
 * SECURITY: the trading gateway (`alpaca.ts`) does NOT use this — it resolves Alpaca strictly
 * per-user (`resolveApiKey`, per-user-only tier) so no one ever TRADES on the operator's account.
 * This helper exposes the operator's key only for read-only market-data endpoints.
 */
export function resolveAlpacaMarketData(userId?: string): { apiKey?: string; secretKey?: string; source: ApiKeySource } {
  let userKeyOnly: { apiKey: string; secretKey?: string; source: ApiKeySource } | undefined;

  if (userId) {
    const connected = resolveConnectedAlpacaMarketData(userId);
    if (connected) return { ...connected, source: "user" };

    const connectedKeyOnly = resolveConnectedAlpacaMarketData(userId, false);
    if (connectedKeyOnly) userKeyOnly = { ...connectedKeyOnly, source: "user" };

    const own = getUserApiKey(userId, "alpaca_paper_api_key")?.apiKey;
    const ownSecret = getUserApiKey(userId, "alpaca_paper_secret_key")?.apiKey;
    if (own && ownSecret) return { apiKey: own, secretKey: ownSecret, source: "user" };
    if (own && !userKeyOnly) userKeyOnly = { apiKey: own, source: "user" };
  }

  const localConnected = resolveConnectedAlpacaMarketData(LOCAL_USER);
  if (localConnected) return { ...localConnected, source: "env" };
  const localConnectedKeyOnly = resolveConnectedAlpacaMarketData(LOCAL_USER, false);

  const opKey = getUserApiKey(LOCAL_USER, "alpaca_paper_api_key")?.apiKey ?? process.env.ALPACA_PAPER_API_KEY?.trim();
  const opSecret = getUserApiKey(LOCAL_USER, "alpaca_paper_secret_key")?.apiKey ?? process.env.ALPACA_PAPER_SECRET_KEY?.trim();
  if (userKeyOnly) return userKeyOnly;
  if (localConnectedKeyOnly) return { ...localConnectedKeyOnly, source: "env" };
  if (opKey && opSecret) return { apiKey: opKey, secretKey: opSecret, source: "env" };
  if (opKey) return { apiKey: opKey, source: "env" };
  return { source: "none" };
}

/**
 * Resolve Alpaca credentials for the process-level background WebSocket stream workers
 * (news, trade_updates — see src/lib/streams/alpaca-*-stream.ts). These are single
 * long-lived connections keyed to the `local` operator, not a per-request user, so they need
 * the environment (paper vs live) alongside the key/secret to pick the right WS host — unlike
 * resolveAlpacaMarketData, which only serves read-only market-data REST calls where paper vs
 * live doesn't matter.
 *
 * Prefers connected Alpaca accounts (the modern, actively-maintained credential store —
 * same one Settings -> Accounts writes to) over the legacy standalone
 * `alpaca_paper_api_key`/`alpaca_paper_secret_key` user-API-key pair, which is not updated by
 * the connected-accounts UI and can silently go stale (confirmed in production: the legacy
 * pair was last touched 2026-06-22, while the account's real key was rotated 2026-06-29).
 */
export function resolveAlpacaStreamAccount(
  userId: string = "local"
): { apiKey: string; apiSecret?: string; environment: "paper" | "live" } | undefined {
  const alpacaAccounts = rankConnectedAlpacaAccounts(listConnectedAccounts(userId).filter((account) => account.broker === "alpaca"));
  for (const account of alpacaAccounts) {
    const detailed = getConnectedAccount(account.id, userId);
    if (detailed?.apiKey) {
      return { apiKey: detailed.apiKey, apiSecret: detailed.apiSecret, environment: detailed.environment === "live" ? "live" : "paper" };
    }
  }
  const legacyKey = getUserApiKey(userId, "alpaca_paper_api_key")?.apiKey ?? (userId === LOCAL_USER ? process.env.ALPACA_PAPER_API_KEY?.trim() : undefined);
  const legacySecret = getUserApiKey(userId, "alpaca_paper_secret_key")?.apiKey ?? (userId === LOCAL_USER ? process.env.ALPACA_PAPER_SECRET_KEY?.trim() : undefined);
  if (legacyKey) return { apiKey: legacyKey, apiSecret: legacySecret, environment: "paper" };
  return undefined;
}

// ── LLM credential resolution (per-user-first, operator-funded failover) ─────
//
// LLM keys (openai/anthropic) are per-user-only in the generic resolver above, so `local` keeps
// using the env key and non-`local` users never silently borrow it there. But the owner wants a
// flag-gated OPERATOR-FUNDED FAILOVER: when a real tenant has no LLM key of their own, fall back
// to the operator's env key so the app still works for them — for now (the operator may disable
// this later). Because that means a tenant spends the operator's budget, the failover is paired
// with per-user usage tracking (see llm-usage.ts): every call records who spent and on whose key.
export type LlmKeySource = "user" | "operator" | "none";

/** Whether the operator's env LLM key may serve non-`local` tenants as a failover (default on). */
export function llmOperatorFallbackEnabled(): boolean {
  const envVal = process.env.LLM_OPERATOR_FALLBACK;
  if (envVal !== undefined) {
    const v = envVal.trim().toLowerCase();
    return v === "1" || v === "true" || v === "yes" || v === "on";
  }
  return process.env.NODE_ENV === "test";
}

/**
 * A stable, non-reversible fingerprint of an API key — `sha256(key)` truncated. Lets the usage
 * ledger measure usage per distinct ATTACHED key without ever storing the secret. Returns undefined
 * for an empty key.
 */
export function keyFingerprint(key: string | undefined): string | undefined {
  if (!key) return undefined;
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
}

/**
 * Resolve an LLM provider key for a user. `source` distinguishes the user's own key from the
 * operator-funded failover, and `keyRef` is the non-secret fingerprint of the resolved key so the
 * caller can attribute usage/cost PER ATTACHED key. A non-`local` tenant only reaches the env key
 * when the failover is enabled.
 */
export function resolveLlmCredential(service: "openai" | "anthropic" | "xai" | "gemini" | "mistral" | "deepseek", userId?: string): { key?: string; source: LlmKeySource; keyRef?: string } {
  const canonical = normalizeApiKeyService(service);
  if (userId) {
    const userKey = getUserApiKey(userId, canonical);
    if (userKey?.apiKey) return { key: userKey.apiKey, source: "user", keyRef: keyFingerprint(userKey.apiKey) };
  }
  // Operator-funded failover for ANY user (flag-gated). `local`'s own env key is migrated into its
  // per-user store at boot, so `local` resolves "user" above; this serves users without their own
  // key. No `local` special case — when the failover is off, everyone (incl. `local`) needs a key.
  if (!llmOperatorFallbackEnabled()) return { source: "none" };
  const envVar = apiKeyEnvVarForService(canonical);
  const envKey = envVar ? process.env[envVar] : undefined;
  return envKey ? { key: envKey, source: "operator", keyRef: keyFingerprint(envKey) } : { source: "none" };
}

/** Every LLM provider `resolveLlmCredential` understands. The single source of truth for "is an LLM connected". */
export const LLM_PROVIDER_SERVICES = ["openai", "anthropic", "xai", "gemini", "mistral", "deepseek"] as const;
export type LlmProviderService = (typeof LLM_PROVIDER_SERVICES)[number];

/**
 * True when AT LEAST ONE supported LLM provider resolves a usable credential for this user — their own
 * per-user key OR the operator-funded failover (see resolveLlmCredential). This is the gate for the two
 * LLM-driven actions (strategy session + chat): when it returns false the app must error rather than
 * silently degrade to a rule-based stub. Mirrors the same check the `/api/chat/providers` route exposes.
 */
export function userHasAnyLlmCredential(userId?: string): boolean {
  return LLM_PROVIDER_SERVICES.some((service) => Boolean(resolveLlmCredential(service, userId).key));
}

// Per-user-only credentials whose env values belong to the primary (`local`) operator. At boot we
// migrate them into `local`'s per-user key store so there is NO special `local` env branch in the
// resolvers above — every user, `local` included, resolves broker/LLM keys from the per-user store.
const LOCAL_ENV_MIGRATION_SERVICES = ["openai", "anthropic", "xai", "gemini", "mistral", "deepseek", "alpaca_paper_api_key", "alpaca_paper_secret_key"] as const;

/**
 * One-time, idempotent migration of the operator's env broker/LLM keys into the `local` user's
 * per-user key store. Safe to call repeatedly (only seeds a service `local` doesn't already have a
 * key for) and on every boot. Returns which services were seeded. Call from the server boot hook,
 * NOT the hot resolver path. Shared-tier keys (market data, RAG, macro) are NOT migrated — they stay
 * a global env fallback for all users.
 */
export function migrateLocalEnvCredentials(): { migrated: string[] } {
  const migrated: string[] = [];
  for (const svc of LOCAL_ENV_MIGRATION_SERVICES) {
    const envVar = API_KEY_ENV_MAP[svc];
    const envVal = envVar ? process.env[envVar]?.trim() : undefined;
    if (envVal && !getUserApiKey(LOCAL_USER, svc)?.apiKey) {
      try {
        upsertUserApiKey(LOCAL_USER, svc, envVal, "migrated from env");
        migrated.push(svc);
      } catch {
        /* best-effort */
      }
    }
  }
  return { migrated };
}

// ── Connected accounts ──────────────────────────────────────────────────────

function parseCapabilities(raw: unknown): AccountCapabilities | undefined {
  if (!raw || typeof raw !== "string") return undefined;
  try { return JSON.parse(raw) as AccountCapabilities; } catch { return undefined; }
}

export function listConnectedAccounts(userId: string = "local"): ConnectedAccount[] {
  const rows = getDb()
    .prepare("SELECT * FROM connected_accounts WHERE user_id = ? ORDER BY created_at ASC")
    .all(userId) as Record<string, unknown>[];
  return rows.map(r => ({
    id: String(r.id),
    userId: String(r.user_id),
    broker: String(r.broker) as "alpaca" | "robinhood" | "test",
    environment: String(r.environment) as "live" | "paper",
    accountNumber: r.account_number != null ? String(r.account_number) : undefined,
    label: String(r.label),
    taxationType: r.taxation_type != null ? (String(r.taxation_type) as ConnectedAccount["taxationType"]) : undefined,
    baseUrl: r.base_url != null ? String(r.base_url) : undefined,
    capabilities: parseCapabilities(r.capabilities),
    isActive: r.is_active === 1,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at)
  }));
}

const TEST_ACCOUNT_LABEL = "Test Account - Local Mock Paper Account";

// Creates a connected "Test" broker account (broker: "test", environment: "paper") backed by
// TestBrokerGateway (real quotes, deterministic simulated fills). This is TEST INFRASTRUCTURE for
// the unit-test suite to exercise the normal broker execution path without hitting real Alpaca/
// Robinhood — call it from test setup. The production app does NOT call this: an account is an
// account, and with none connected the app correctly reports "no account" rather than defaulting
// to a fake broker.
export function ensureTestAccount(userId: string = "local"): void {
  const accounts = listConnectedAccounts(userId);
  if (accounts.some((a) => a.broker === "test")) return;
  upsertConnectedAccount({
    id: `test-${userId}`,
    userId,
    broker: "test",
    environment: "paper",
    accountNumber: "TEST",
    label: TEST_ACCOUNT_LABEL,
    isActive: false
  });
}

export function getActiveConnectedAccount(userId: string = "local"): ConnectedAccount | undefined {
  const row = getDb()
    .prepare("SELECT * FROM connected_accounts WHERE user_id = ? AND is_active = 1 LIMIT 1")
    .get(userId) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    id: String(row.id),
    userId: String(row.user_id),
    broker: String(row.broker) as "alpaca" | "robinhood" | "test",
    environment: String(row.environment) as "live" | "paper",
    accountNumber: row.account_number != null ? String(row.account_number) : undefined,
    label: String(row.label),
    taxationType: row.taxation_type != null ? (String(row.taxation_type) as ConnectedAccount["taxationType"]) : undefined,
    apiKey: row.api_key ? decryptValue(String(row.api_key)) : undefined,
    apiSecret: row.api_secret ? decryptValue(String(row.api_secret)) : undefined,
    baseUrl: row.base_url != null ? String(row.base_url) : undefined,
    capabilities: parseCapabilities(row.capabilities),
    isActive: row.is_active === 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

// Fetch a specific connected account by id (scoped to the owning user), with decrypted
// keys — used by the scheduler to run a non-active account autonomously.
export function getConnectedAccount(id: string, userId: string = "local"): ConnectedAccount | undefined {
  const row = getDb()
    .prepare("SELECT * FROM connected_accounts WHERE id = ? AND user_id = ? LIMIT 1")
    .get(id, userId) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    id: String(row.id),
    userId: String(row.user_id),
    broker: String(row.broker) as "alpaca" | "robinhood" | "test",
    environment: String(row.environment) as "live" | "paper",
    accountNumber: row.account_number != null ? String(row.account_number) : undefined,
    label: String(row.label),
    taxationType: row.taxation_type != null ? (String(row.taxation_type) as ConnectedAccount["taxationType"]) : undefined,
    apiKey: row.api_key ? decryptValue(String(row.api_key)) : undefined,
    apiSecret: row.api_secret ? decryptValue(String(row.api_secret)) : undefined,
    baseUrl: row.base_url != null ? String(row.base_url) : undefined,
    capabilities: parseCapabilities(row.capabilities),
    isActive: row.is_active === 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

// Insert or update a connected account. The `ON CONFLICT(id) DO UPDATE ... WHERE user_id = excluded.user_id`
// guard makes the UPDATE branch a no-op when the existing row belongs to a DIFFERENT user, so a caller
// who supplies someone else's account `id` (e.g. the deterministic `test-<userId>` id, derivable from a
// known email) can neither overwrite that row's broker/key fields nor hijack it — the conflicting write
// silently does nothing. Creates with a fresh id are unaffected; legitimate same-user edits still apply.
export function upsertConnectedAccount(account: Omit<ConnectedAccount, "createdAt" | "updatedAt">): void {
  const now = new Date().toISOString();
  const encryptedApiKey = account.apiKey?.trim() ? encryptValue(account.apiKey.trim()) : null;
  const encryptedApiSecret = account.apiSecret?.trim() ? encryptValue(account.apiSecret.trim()) : null;
  const database = getDb();
  database.transaction(() => {
    if (account.isActive) {
      database.prepare("UPDATE connected_accounts SET is_active = 0 WHERE user_id = ?").run(account.userId);
    }
    const capabilitiesJson = account.capabilities ? JSON.stringify(account.capabilities) : null;
    database
      .prepare(
        `INSERT INTO connected_accounts (id, user_id, broker, environment, account_number, label, api_key, api_secret, taxation_type, base_url, capabilities, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
          broker = excluded.broker,
          environment = excluded.environment,
          account_number = excluded.account_number,
          label = excluded.label,
          api_key = COALESCE(excluded.api_key, connected_accounts.api_key),
          api_secret = COALESCE(excluded.api_secret, connected_accounts.api_secret),
          taxation_type = COALESCE(excluded.taxation_type, connected_accounts.taxation_type),
          base_url = COALESCE(excluded.base_url, connected_accounts.base_url),
          capabilities = COALESCE(excluded.capabilities, connected_accounts.capabilities),
          is_active = excluded.is_active,
          updated_at = excluded.updated_at
         WHERE connected_accounts.user_id = excluded.user_id`
      )
      .run(
        account.id,
        account.userId,
        account.broker,
        account.environment,
        account.accountNumber ?? null,
        account.label,
        encryptedApiKey,
        encryptedApiSecret,
        account.taxationType ?? null,
        account.baseUrl ?? null,
        capabilitiesJson,
        account.isActive ? 1 : 0,
        now,
        now
      );

  })();
}

export function setActiveConnectedAccount(id: string, userId: string = "local"): void {
  const db = getDb();
  db.transaction(() => {
    const exists = db.prepare("SELECT id FROM connected_accounts WHERE id = ? AND user_id = ?").get(id, userId);
    if (!exists) throw new Error("Connected account not found.");
    db.prepare("UPDATE connected_accounts SET is_active = 0 WHERE user_id = ?").run(userId);
    db.prepare("UPDATE connected_accounts SET is_active = 1 WHERE id = ? AND user_id = ?").run(id, userId);
  })();
}

export function deleteConnectedAccount(id: string, userId: string = "local"): boolean {
  const database = getDb();
  const row = database
    .prepare("SELECT account_number FROM connected_accounts WHERE id = ? AND user_id = ?")
    .get(id, userId) as { account_number: string | null } | undefined;
  if (!row) return false;
  const acct = row.account_number;
  // Delete the account and purge its trading records in one transaction, so removing an account never
  // leaves orphaned fills/snapshots/proposals/stops still feeding P&L or exposure for an account that
  // no longer exists. Account-delete is an explicit user action — its broker-scoped history goes with it.
  const run = database.transaction(() => {
    const result = database.prepare("DELETE FROM connected_accounts WHERE id = ? AND user_id = ?").run(id, userId);
    if (acct) {
      for (const table of ["fill_events", "portfolio_snapshots", "trade_proposals", "synthetic_trailing_stops", "broker_protective_stops"]) {
        database.prepare(`DELETE FROM ${table} WHERE account_number = ? AND user_id = ?`).run(acct, userId);
      }
    }
    // Purge the account's per-account isolated state, keyed by connected_account_id (= this id):
    // live strategy state, run history, performance-learning rows, audit/notification trail.
    for (const table of [
      "account_strategy_state",
      "strategy_runs",
      "skipped_candidate_counterfactuals",
      "counterfactual_learning_watermarks",
      "learning_mutations",
      "audit_events",
      "notification_events"
    ]) {
      database.prepare(`DELETE FROM ${table} WHERE connected_account_id = ? AND user_id = ?`).run(id, userId);
    }
    // Release this account's run lock if held (in-memory scheduler state clears on next restart).
    database.prepare("DELETE FROM settings WHERE key = ?").run(`strategy_run_lock:${userId}:${id}`);
    return result.changes > 0;
  });
  return run();
}

// ── Synthetic trailing stops (R2 scaffolding) ──────────────────────────────────
export interface SyntheticTrailingStop {
  id: string;
  userId: string;
  accountNumber: string;
  symbol: string;
  side: "long" | "short";
  quantity: number;
  entryPrice: number;
  /** Highest price since entry for a long (lowest for a short) — the trail anchor. */
  extremePrice: number;
  trailPercent?: number;
  trailAmount?: number;
  status: "active" | "triggered" | "cancelled";
  lastPrice?: number;
  createdAt: string;
  updatedAt: string;
}

function mapSyntheticStop(r: Record<string, unknown>): SyntheticTrailingStop {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    accountNumber: String(r.account_number),
    symbol: String(r.symbol),
    side: String(r.side) as "long" | "short",
    quantity: Number(r.quantity),
    entryPrice: Number(r.entry_price),
    extremePrice: Number(r.extreme_price),
    trailPercent: r.trail_percent != null ? Number(r.trail_percent) : undefined,
    trailAmount: r.trail_amount != null ? Number(r.trail_amount) : undefined,
    status: String(r.status) as SyntheticTrailingStop["status"],
    lastPrice: r.last_price != null ? Number(r.last_price) : undefined,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at)
  };
}

export function upsertSyntheticStop(stop: Omit<SyntheticTrailingStop, "createdAt" | "updatedAt"> & { createdAt?: string }): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO synthetic_trailing_stops (id, user_id, account_number, symbol, side, quantity, entry_price, extreme_price, trail_percent, trail_amount, status, last_price, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, account_number, symbol) DO UPDATE SET
        side = excluded.side,
        quantity = excluded.quantity,
        entry_price = excluded.entry_price,
        extreme_price = excluded.extreme_price,
        trail_percent = excluded.trail_percent,
        trail_amount = excluded.trail_amount,
        status = excluded.status,
        last_price = excluded.last_price,
        updated_at = excluded.updated_at`
    )
    .run(
      stop.id, stop.userId, stop.accountNumber, stop.symbol, stop.side, stop.quantity,
      stop.entryPrice, stop.extremePrice, stop.trailPercent ?? null, stop.trailAmount ?? null,
      stop.status, stop.lastPrice ?? null, stop.createdAt ?? now, now
    );
}

export function listSyntheticStops(accountNumber: string, userId: string = "local", status: SyntheticTrailingStop["status"] = "active"): SyntheticTrailingStop[] {
  const rows = getDb()
    .prepare("SELECT * FROM synthetic_trailing_stops WHERE user_id = ? AND account_number = ? AND status = ? ORDER BY created_at ASC")
    .all(userId, accountNumber, status) as Record<string, unknown>[];
  return rows.map(mapSyntheticStop);
}

export function deleteSyntheticStop(id: string, userId: string = "local"): void {
  getDb().prepare("DELETE FROM synthetic_trailing_stops WHERE id = ? AND user_id = ?").run(id, userId);
}

/**
 * Atomic compare-and-swap claim of an active synthetic stop.
 */
export function claimSyntheticStop(id: string, userId: string = "local"): boolean {
  const info = getDb()
    .prepare("UPDATE synthetic_trailing_stops SET status = 'triggered', updated_at = ? WHERE id = ? AND user_id = ? AND status = 'active'")
    .run(new Date().toISOString(), id, userId);
  return info.changes === 1;
}

/** Re-arm a claimed stop after a failed placement so it can retry on a later tick. */
export function revertSyntheticStopClaim(id: string, userId: string = "local"): void {
  getDb()
    .prepare("UPDATE synthetic_trailing_stops SET status = 'active', updated_at = ? WHERE id = ? AND user_id = ? AND status = 'triggered'")
    .run(new Date().toISOString(), id, userId);
}

/** Purge stops whose position no longer exists (size hit 0). `liveSymbols` must be upper-cased. */
export function purgeSyntheticStops(accountNumber: string, liveSymbols: Set<string>, userId: string = "local"): number {
  let purged = 0;
  for (const stop of listSyntheticStops(accountNumber, userId)) {
    if (!liveSymbols.has(stop.symbol.toUpperCase())) {
      deleteSyntheticStop(stop.id, userId);
      purged++;
    }
  }
  return purged;
}

// ── Broker-held protective stops (Robinhood) ──────────────────────────────────

export interface BrokerProtectiveStop {
  id: string;
  userId: string;
  accountNumber: string;
  symbol: string;
  brokerOrderId: string;
  quantity: number;
  stopPrice: number;
  status: string;
  createdAt: string;
  updatedAt: string;
}

function mapBrokerProtectiveStop(r: Record<string, unknown>): BrokerProtectiveStop {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    accountNumber: String(r.account_number),
    symbol: String(r.symbol),
    brokerOrderId: String(r.broker_order_id),
    quantity: Number(r.quantity),
    stopPrice: Number(r.stop_price),
    status: String(r.status),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at)
  };
}

export function upsertBrokerProtectiveStop(stop: Omit<BrokerProtectiveStop, "createdAt" | "updatedAt"> & { createdAt?: string }): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO broker_protective_stops (id, user_id, account_number, symbol, broker_order_id, quantity, stop_price, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, account_number, symbol) DO UPDATE SET
        broker_order_id = excluded.broker_order_id,
        quantity = excluded.quantity,
        stop_price = excluded.stop_price,
        status = excluded.status,
        updated_at = excluded.updated_at`
    )
    .run(
      stop.id, stop.userId, stop.accountNumber, stop.symbol, stop.brokerOrderId,
      stop.quantity, stop.stopPrice, stop.status, stop.createdAt ?? now, now
    );
}

export function listBrokerProtectiveStops(accountNumber: string, userId: string = "local"): BrokerProtectiveStop[] {
  const rows = getDb()
    .prepare("SELECT * FROM broker_protective_stops WHERE user_id = ? AND account_number = ? AND status = 'resting' ORDER BY created_at ASC")
    .all(userId, accountNumber) as Record<string, unknown>[];
  return rows.map(mapBrokerProtectiveStop);
}

export function deleteBrokerProtectiveStop(id: string, userId: string = "local"): void {
  getDb().prepare("DELETE FROM broker_protective_stops WHERE id = ? AND user_id = ?").run(id, userId);
}

// ── listUsers ────────────────────────────────────────────────────────────────

export function listUsers(): string[] {
  const rows = getDb()
    .prepare(
      `SELECT user_id FROM user_settings
       UNION
       SELECT user_id FROM strategy_profiles
       UNION
       SELECT user_id FROM user_api_keys
       UNION
       SELECT user_id FROM connected_accounts
       UNION
       SELECT user_id FROM user_watchlist
       UNION
       SELECT user_id FROM price_alerts`
    )
    .all() as Array<{ user_id: string }>;
  const users = rows.map((r) => r.user_id).filter(Boolean);
  return users.length > 0 ? Array.from(new Set(users)) : ["local"];
}

// ── Watchlist ────────────────────────────────────────────────────────────────

type RawWatchlistRow = { symbol: string; added_at: string };

export function addWatchlistSymbol(userId: string, symbol: string): WatchlistItem {
  const addedAt = new Date().toISOString();
  getDb()
    .prepare("INSERT OR IGNORE INTO user_watchlist (user_id, symbol, added_at) VALUES (?, ?, ?)")
    .run(userId, symbol, addedAt);
  const row = getDb()
    .prepare("SELECT symbol, added_at FROM user_watchlist WHERE user_id = ? AND symbol = ?")
    .get(userId, symbol) as RawWatchlistRow;
  return { symbol: row.symbol, addedAt: row.added_at };
}

export function removeWatchlistSymbol(userId: string, symbol: string): boolean {
  const result = getDb().prepare("DELETE FROM user_watchlist WHERE user_id = ? AND symbol = ?").run(userId, symbol);
  return result.changes > 0;
}

export function listWatchlistSymbols(userId: string): WatchlistItem[] {
  const rows = getDb()
    .prepare("SELECT symbol, added_at FROM user_watchlist WHERE user_id = ? ORDER BY symbol ASC")
    .all(userId) as RawWatchlistRow[];
  return rows.map((row) => ({ symbol: row.symbol, addedAt: row.added_at }));
}

// ── Price alerts ─────────────────────────────────────────────────────────────

type RawPriceAlertRow = {
  id: string;
  user_id: string;
  symbol: string;
  op: string;
  price: number;
  note: string;
  status: string;
  created_at: string;
  triggered_at: string | null;
  triggered_price: number | null;
};

function mapPriceAlert(row: RawPriceAlertRow): PriceAlert {
  return {
    id: row.id,
    userId: row.user_id,
    symbol: row.symbol,
    op: row.op as PriceAlertOp,
    price: row.price,
    note: row.note,
    status: row.status as PriceAlertStatus,
    createdAt: row.created_at,
    triggeredAt: row.triggered_at,
    triggeredPrice: row.triggered_price
  };
}

export function createPriceAlert(alert: PriceAlert): PriceAlert {
  getDb()
    .prepare(
      `INSERT INTO price_alerts
       (id, user_id, symbol, op, price, note, status, created_at, triggered_at, triggered_price)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      alert.id,
      alert.userId,
      alert.symbol,
      alert.op,
      alert.price,
      alert.note,
      alert.status,
      alert.createdAt,
      alert.triggeredAt,
      alert.triggeredPrice
    );
  return alert;
}

export function listPriceAlerts(userId: string, status: "all" | "armed" | "triggered" = "all"): PriceAlert[] {
  const rows =
    status === "all"
      ? (getDb()
          .prepare("SELECT * FROM price_alerts WHERE user_id = ? ORDER BY created_at DESC")
          .all(userId) as RawPriceAlertRow[])
      : (getDb()
          .prepare("SELECT * FROM price_alerts WHERE user_id = ? AND status = ? ORDER BY created_at DESC")
          .all(userId, status) as RawPriceAlertRow[]);
  return rows.map(mapPriceAlert);
}

export function listArmedPriceAlerts(userId: string): PriceAlert[] {
  return listPriceAlerts(userId, "armed");
}

export function deletePriceAlert(userId: string, id: string): boolean {
  const result = getDb().prepare("DELETE FROM price_alerts WHERE id = ? AND user_id = ?").run(id, userId);
  return result.changes > 0;
}

export function markPriceAlertTriggered(id: string, userId: string, triggeredPrice: number): PriceAlert | null {
  const triggeredAt = new Date().toISOString();
  const result = getDb()
    .prepare(
      `UPDATE price_alerts
       SET status = 'triggered', triggered_at = ?, triggered_price = ?
       WHERE id = ? AND user_id = ? AND status = 'armed'`
    )
    .run(triggeredAt, triggeredPrice, id, userId);
  if (result.changes === 0) return null;
  const row = getDb().prepare("SELECT * FROM price_alerts WHERE id = ? AND user_id = ?").get(id, userId) as RawPriceAlertRow | undefined;
  return row ? mapPriceAlert(row) : null;
}

// ── Notification preferences ──────────────────────────────────────────────────

const NOTIFY_CHANNEL_IDS: readonly NotifyChannelId[] = ["push", "webhook", "email", "sms"];

function isNotifyChannelId(value: unknown): value is NotifyChannelId {
  return typeof value === "string" && (NOTIFY_CHANNEL_IDS as readonly string[]).includes(value);
}

export function getNotifyPrefs(userId: string = "local"): NotifyPrefs {
  const row = getDb().prepare("SELECT * FROM notification_prefs WHERE user_id = ?").get(userId) as
    | { user_id: string; channels: string; push_target: string; webhook_url: string; email: string; phone: string; updated_at: string | null }
    | undefined;
  if (!row) {
    return { userId, channels: [], pushTarget: "", webhookUrl: "", email: "", phone: "", updatedAt: null };
  }
  let channels: NotifyChannelId[] = [];
  try {
    const parsed = JSON.parse(row.channels) as unknown;
    if (Array.isArray(parsed)) channels = parsed.filter(isNotifyChannelId);
  } catch {
    channels = [];
  }
  return {
    userId: row.user_id,
    channels,
    pushTarget: row.push_target,
    webhookUrl: row.webhook_url,
    email: row.email,
    phone: row.phone,
    updatedAt: row.updated_at
  };
}

export function setNotifyPrefs(
  userId: string,
  partial: { channels?: unknown; pushTarget?: unknown; webhookUrl?: unknown; email?: unknown; phone?: unknown }
): NotifyPrefs {
  const next: NotifyPrefs = { ...getNotifyPrefs(userId), userId };
  if (Array.isArray(partial.channels)) {
    next.channels = [...new Set(partial.channels.filter(isNotifyChannelId))];
  }
  if (typeof partial.pushTarget === "string") next.pushTarget = partial.pushTarget.trim();
  if (typeof partial.webhookUrl === "string") next.webhookUrl = partial.webhookUrl.trim();
  if (typeof partial.email === "string") next.email = partial.email.trim();
  if (typeof partial.phone === "string") next.phone = partial.phone.trim();
  next.updatedAt = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO notification_prefs (user_id, channels, push_target, webhook_url, email, phone, updated_at)
       VALUES (@userId, @channels, @pushTarget, @webhookUrl, @email, @phone, @updatedAt)
       ON CONFLICT(user_id) DO UPDATE SET
         channels = excluded.channels, push_target = excluded.push_target, webhook_url = excluded.webhook_url,
         email = excluded.email, phone = excluded.phone, updated_at = excluded.updated_at`
    )
    .run({
      userId,
      channels: JSON.stringify(next.channels),
      pushTarget: next.pushTarget,
      webhookUrl: next.webhookUrl,
      email: next.email,
      phone: next.phone,
      updatedAt: next.updatedAt
    });
  audit("notify.prefs.set", { userId, channels: next.channels }, userId);
  return next;
}

// ── Chat turns ────────────────────────────────────────────────────────────────

interface RawChatTurnRow {
  id: string;
  user_id: string;
  role: string;
  text: string;
  citations: string;
  intent: string | null;
  redacted: number;
  model: string | null;
  client_turn_id: string | null;
  created_at: string;
}

function mapChatTurn(row: RawChatTurnRow): ChatTurn {
  let citations: string[] = [];
  try {
    const parsed = JSON.parse(row.citations) as unknown;
    if (Array.isArray(parsed)) citations = parsed.filter((c): c is string => typeof c === "string");
  } catch {
    citations = [];
  }
  const role: ChatTurnRole = row.role === "assistant" ? "assistant" : "user";
  return {
    id: row.id,
    userId: row.user_id,
    role,
    text: row.text,
    citations,
    intent: row.intent,
    redacted: row.redacted === 1,
    model: row.model ?? null,
    clientTurnId: row.client_turn_id ?? null,
    createdAt: row.created_at
  };
}

export function insertChatTurn(turn: ChatTurn): ChatTurn {
  getDb()
    .prepare(
      "INSERT INTO chat_turns (id, user_id, role, text, citations, intent, redacted, model, client_turn_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(turn.id, turn.userId, turn.role, turn.text, JSON.stringify(turn.citations), turn.intent ?? null, turn.redacted ? 1 : 0, turn.model ?? null, turn.clientTurnId ?? null, turn.createdAt);
  return turn;
}

/** Per-user idempotency lookup: the turn previously recorded with this client-generated id, if any. */
export function findChatTurnByClientId(userId: string, clientTurnId: string): ChatTurn | null {
  const row = getDb()
    .prepare("SELECT * FROM chat_turns WHERE user_id = ? AND client_turn_id = ? ORDER BY created_at ASC, rowid ASC LIMIT 1")
    .get(userId, clientTurnId) as RawChatTurnRow | undefined;
  return row ? mapChatTurn(row) : null;
}

export function listChatTurns(userId: string, limit: number = 100): ChatTurn[] {
  const rows = getDb()
    .prepare("SELECT * FROM chat_turns WHERE user_id = ? ORDER BY created_at ASC, rowid ASC")
    .all(userId) as RawChatTurnRow[];
  const mapped = rows.map(mapChatTurn);
  return limit > 0 && mapped.length > limit ? mapped.slice(mapped.length - limit) : mapped;
}

/** Keep only the most recent `keep` turns for a user (FIFO cap); returns rows deleted. */
export function trimChatTurns(userId: string, keep: number): number {
  return getDb()
    .prepare(
      `DELETE FROM chat_turns WHERE user_id = ? AND id NOT IN (
         SELECT id FROM chat_turns WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?
       )`
    )
    .run(userId, userId, keep).changes;
}

export function clearChatTurns(userId: string): number {
  return getDb().prepare("DELETE FROM chat_turns WHERE user_id = ?").run(userId).changes;
}

// ── Memory ────────────────────────────────────────────────────────────────────

interface RawMemoryRow {
  id: string;
  user_id: string;
  kind: string;
  subject: string;
  value: string;
  source: string;
  confidence: number;
  hard: number;
  asserted_at: string;
  superseded_by: string | null;
}

function mapMemory(row: RawMemoryRow): MemoryItem {
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind as MemoryItem["kind"],
    subject: row.subject,
    value: row.value,
    source: row.source,
    confidence: row.confidence,
    hard: row.hard === 1,
    assertedAt: row.asserted_at,
    supersededBy: row.superseded_by
  };
}

export function insertMemory(item: MemoryItem): MemoryItem {
  getDb()
    .prepare(
      "INSERT INTO user_memory (id, user_id, kind, subject, value, source, confidence, hard, asserted_at, superseded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(item.id, item.userId, item.kind, item.subject, item.value, item.source, item.confidence, item.hard ? 1 : 0, item.assertedAt, item.supersededBy);
  return item;
}

export function findLiveMemoryBySubject(userId: string, kind: string, subject: string): MemoryItem | null {
  const row = getDb()
    .prepare(
      "SELECT * FROM user_memory WHERE user_id = ? AND kind = ? AND subject = ? AND superseded_by IS NULL ORDER BY asserted_at DESC LIMIT 1"
    )
    .get(userId, kind, subject) as RawMemoryRow | undefined;
  return row ? mapMemory(row) : null;
}

export function listLiveMemory(userId: string): MemoryItem[] {
  const rows = getDb()
    .prepare("SELECT * FROM user_memory WHERE user_id = ? AND superseded_by IS NULL ORDER BY asserted_at DESC")
    .all(userId) as RawMemoryRow[];
  return rows.map(mapMemory);
}

export function supersedeMemory(oldId: string, newId: string): void {
  getDb().prepare("UPDATE user_memory SET superseded_by = ? WHERE id = ?").run(newId, oldId);
}

export function touchMemory(id: string, assertedAt: string, confidence: number): MemoryItem | null {
  getDb().prepare("UPDATE user_memory SET asserted_at = ?, confidence = ? WHERE id = ?").run(assertedAt, confidence, id);
  const row = getDb().prepare("SELECT * FROM user_memory WHERE id = ?").get(id) as RawMemoryRow | undefined;
  return row ? mapMemory(row) : null;
}

export function deleteMemory(userId: string, id: string): boolean {
  return getDb().prepare("DELETE FROM user_memory WHERE id = ? AND user_id = ?").run(id, userId).changes > 0;
}

// ── Take-profit trim ratchet ────────────────────────────────────────────────
// Monotonic "band" already trimmed per open profitable position, so a partial take-profit trims once
// per take-profit band instead of laddering out every run. See take_profit_trims (db.ts migrate()).

export interface TakeProfitTrimBand {
  /** Highest take-profit band already trimmed for the lot. */
  band: number;
  /** Position cost basis when the band was recorded — ratchet resets when the live basis differs (rebuy). */
  avgCost: number;
}

/** Map of symbol → {band, avgCost} of the highest already-trimmed take-profit band (empty when none). */
export function getTakeProfitTrimBands(accountNumber: string, userId: string = "local"): Record<string, TakeProfitTrimBand> {
  const rows = getDb()
    .prepare("SELECT symbol, band, avg_cost FROM take_profit_trims WHERE user_id = ? AND account_number = ?")
    .all(userId, accountNumber) as Array<{ symbol: string; band: number; avg_cost: number }>;
  const out: Record<string, TakeProfitTrimBand> = {};
  for (const r of rows) out[r.symbol] = { band: Number(r.band) || 0, avgCost: Number(r.avg_cost) || 0 };
  return out;
}

/** Record (upsert) the highest take-profit band trimmed for a position lot (band + its cost basis). */
export function recordTakeProfitTrimBand(
  accountNumber: string,
  symbol: string,
  band: number,
  avgCost: number,
  userId: string = "local",
  now: string = new Date().toISOString()
): void {
  getDb()
    .prepare(
      `INSERT INTO take_profit_trims (user_id, account_number, symbol, band, avg_cost, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, account_number, symbol)
       DO UPDATE SET band = excluded.band, avg_cost = excluded.avg_cost, updated_at = excluded.updated_at`
    )
    .run(userId, accountNumber, symbol, Math.max(0, Math.floor(band)), Number.isFinite(avgCost) ? avgCost : 0, now);
}

/** Clear ratchet state for the given symbols (e.g. positions that have closed). No-op on empty input. */
export function clearTakeProfitTrimBands(accountNumber: string, symbols: string[], userId: string = "local"): void {
  if (symbols.length === 0) return;
  const placeholders = symbols.map(() => "?").join(",");
  getDb()
    .prepare(`DELETE FROM take_profit_trims WHERE user_id = ? AND account_number = ? AND symbol IN (${placeholders})`)
    .run(userId, accountNumber, ...symbols);
}
