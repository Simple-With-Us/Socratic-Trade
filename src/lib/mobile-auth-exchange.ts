import crypto from "node:crypto";
import { decryptValue, encryptValue, getDb } from "./db";

const EXCHANGE_PREFIX = "mobile_auth_exchange:";
const DEFAULT_EXCHANGE_TTL_MS = 2 * 60_000;
const URL_SAFE_VALUE = /^[A-Za-z0-9_-]+$/;

interface StoredMobileAuthExchange {
  encryptedSessionToken: string;
  state: string;
  codeChallenge: string;
  expiresAt: number;
}

export interface MobileAuthExchangeInput {
  sessionToken: string;
  state: string;
  codeChallenge: string;
  now?: number;
  ttlMs?: number;
}

export interface ConsumeMobileAuthExchangeInput {
  code: string;
  state: string;
  codeVerifier: string;
  now?: number;
}

function hash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function base64UrlSha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && crypto.timingSafeEqual(leftBytes, rightBytes);
}

function exchangeKey(code: string): string {
  return `${EXCHANGE_PREFIX}${hash(code)}`;
}

export function isValidMobileAuthState(value: string | null | undefined): value is string {
  return Boolean(value && value.length >= 32 && value.length <= 128 && URL_SAFE_VALUE.test(value));
}

export function isValidPkceChallenge(value: string | null | undefined): value is string {
  return Boolean(value && value.length === 43 && URL_SAFE_VALUE.test(value));
}

export function isValidPkceVerifier(value: string | null | undefined): value is string {
  return Boolean(value && value.length >= 43 && value.length <= 128 && URL_SAFE_VALUE.test(value));
}

function parseStoredExchange(value: string): StoredMobileAuthExchange | undefined {
  try {
    const parsed = JSON.parse(value) as Partial<StoredMobileAuthExchange>;
    if (
      typeof parsed.encryptedSessionToken !== "string" ||
      typeof parsed.state !== "string" ||
      typeof parsed.codeChallenge !== "string" ||
      typeof parsed.expiresAt !== "number"
    ) {
      return undefined;
    }
    return parsed as StoredMobileAuthExchange;
  } catch {
    return undefined;
  }
}

function sweepExpiredExchanges(now: number): void {
  const database = getDb();
  const rows = database
    .prepare("SELECT key, value FROM settings WHERE key LIKE ?")
    .all(`${EXCHANGE_PREFIX}%`) as Array<{ key: string; value: string }>;
  const remove = database.prepare("DELETE FROM settings WHERE key = ?");
  const sweep = database.transaction(() => {
    for (const row of rows) {
      const stored = parseStoredExchange(row.value);
      if (!stored || stored.expiresAt <= now) remove.run(row.key);
    }
  });
  sweep();
}

/**
 * Stores a browser session behind a short-lived random code. The custom URL scheme receives only
 * this code plus the app's state; the session token remains server-side and encrypted at rest.
 */
export function issueMobileAuthExchange(input: MobileAuthExchangeInput): { code: string; expiresAt: number } {
  if (!input.sessionToken || !isValidMobileAuthState(input.state) || !isValidPkceChallenge(input.codeChallenge)) {
    throw new Error("Invalid mobile auth exchange input.");
  }

  const now = input.now ?? Date.now();
  const ttlMs = input.ttlMs ?? DEFAULT_EXCHANGE_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > 5 * 60_000) {
    throw new Error("Invalid mobile auth exchange TTL.");
  }

  sweepExpiredExchanges(now);
  const code = crypto.randomBytes(32).toString("base64url");
  const expiresAt = now + ttlMs;
  const record: StoredMobileAuthExchange = {
    encryptedSessionToken: encryptValue(input.sessionToken),
    state: input.state,
    codeChallenge: input.codeChallenge,
    expiresAt
  };
  getDb()
    .prepare(
      `INSERT INTO settings (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .run(exchangeKey(code), JSON.stringify(record), new Date(now).toISOString());
  return { code, expiresAt };
}

/**
 * Atomically verifies PKCE + state, consumes the one-time code, and returns the browser session.
 * A wrong verifier/state does not burn the code; a successful exchange can never be replayed.
 */
export function consumeMobileAuthExchange(input: ConsumeMobileAuthExchangeInput): string | undefined {
  if (
    !isValidPkceVerifier(input.codeVerifier) ||
    !isValidMobileAuthState(input.state) ||
    !input.code ||
    input.code.length !== 43 ||
    !URL_SAFE_VALUE.test(input.code)
  ) {
    return undefined;
  }

  const now = input.now ?? Date.now();
  const key = exchangeKey(input.code);
  const database = getDb();
  const consume = database.transaction(() => {
    const row = database.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    if (!row) return undefined;

    const stored = parseStoredExchange(row.value);
    if (!stored || stored.expiresAt <= now) {
      database.prepare("DELETE FROM settings WHERE key = ?").run(key);
      return undefined;
    }
    if (!safeEqual(stored.state, input.state)) return undefined;
    if (!safeEqual(stored.codeChallenge, base64UrlSha256(input.codeVerifier))) return undefined;

    const removed = database.prepare("DELETE FROM settings WHERE key = ?").run(key);
    if (removed.changes !== 1) return undefined;
    const sessionToken = decryptValue(stored.encryptedSessionToken);
    return sessionToken || undefined;
  });
  return consume();
}
