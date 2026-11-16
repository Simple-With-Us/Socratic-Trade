// db-device-tokens.ts — APNs device-token registry (table `device_push_tokens`, created by
// migration 75 in db.ts).
//
// One row per iOS device token. Invariants this module exists to hold:
//
//   * A token belongs to exactly ONE user. The token is the PRIMARY KEY and `registerDeviceToken`
//     REASSIGNS on conflict, so a shared phone whose owner signs out and a second person signs in
//     can never keep delivering the first account's alerts to that device. (Apple reissues the same
//     device token to the same app install regardless of who is signed in, so "just insert a second
//     row" would silently leak.)
//   * The APNs environment a token came from is STORED, never guessed. Device tokens are
//     environment-specific: a sandbox token is answered `400 BadDeviceToken` by the production
//     endpoint and vice versa. The send path picks the endpoint from this column.
//   * A token Apple has told us is dead (410 Unregistered / 400 BadDeviceToken) is DISABLED rather
//     than deleted, so the row still carries why and when — but it is never sent to again.
//
// Raw device tokens are credentials-adjacent: never log one in full. `maskDeviceToken` is the only
// form that may appear in audit rows, errors, or API responses.

import "server-only";
import { audit, getDb } from "./db";
import type { ApnsEnvironment, DeviceToken } from "./types";

type RawDeviceTokenRow = {
  token: string;
  user_id: string;
  environment: string;
  bundle_id: string;
  platform: string;
  created_at: string;
  last_seen_at: string;
  disabled_at: string | null;
  disabled_reason: string | null;
};

/** APNs device tokens are 32-byte hex (64 chars) today; Apple has reserved the right to lengthen
 *  them, so accept a generous hex range rather than pinning exactly 64. */
const DEVICE_TOKEN_PATTERN = /^[0-9a-f]{64,200}$/;

export function isApnsEnvironment(value: unknown): value is ApnsEnvironment {
  return value === "sandbox" || value === "production";
}

/** Normalize a client-supplied token (Apple's `Data.description` formatting varies across the
 *  Swift versions the app has shipped: spaces, angle brackets, mixed case). Returns null when the
 *  value is not a plausible device token. */
export function normalizeDeviceToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\s<>-]/g, "").toLowerCase();
  return DEVICE_TOKEN_PATTERN.test(cleaned) ? cleaned : null;
}

/** The ONLY form of a device token that may be logged, audited, or returned to a client. */
export function maskDeviceToken(token: string): string {
  if (token.length <= 12) return "****";
  return `${token.slice(0, 6)}...${token.slice(-4)}`;
}

function toDeviceToken(row: RawDeviceTokenRow): DeviceToken {
  return {
    token: row.token,
    userId: row.user_id,
    environment: isApnsEnvironment(row.environment) ? row.environment : "production",
    bundleId: row.bundle_id,
    platform: row.platform,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    disabledAt: row.disabled_at,
    disabledReason: row.disabled_reason
  };
}

/**
 * Idempotently register (or re-register) a device token for `userId`.
 *
 * On conflict the row is REASSIGNED to the calling user and re-enabled: user_id, environment,
 * bundle_id and platform are overwritten, `last_seen_at` is refreshed, and any prior
 * disabled_at/disabled_reason is cleared (a user who reinstalled or re-granted permission after a
 * 410 gets a working token again). `created_at` is preserved so the row keeps its true first-seen
 * time.
 */
export function registerDeviceToken(input: {
  userId: string;
  token: string;
  environment: ApnsEnvironment;
  bundleId: string;
  platform?: string;
}): DeviceToken {
  const now = new Date().toISOString();
  const platform = input.platform?.trim() || "ios";
  const previous = getDb()
    .prepare("SELECT user_id FROM device_push_tokens WHERE token = ?")
    .get(input.token) as { user_id: string } | undefined;

  getDb()
    .prepare(
      `INSERT INTO device_push_tokens
         (token, user_id, environment, bundle_id, platform, created_at, last_seen_at, disabled_at, disabled_reason)
       VALUES (@token, @userId, @environment, @bundleId, @platform, @now, @now, NULL, NULL)
       ON CONFLICT(token) DO UPDATE SET
         user_id = excluded.user_id,
         environment = excluded.environment,
         bundle_id = excluded.bundle_id,
         platform = excluded.platform,
         last_seen_at = excluded.last_seen_at,
         disabled_at = NULL,
         disabled_reason = NULL`
    )
    .run({
      token: input.token,
      userId: input.userId,
      environment: input.environment,
      bundleId: input.bundleId,
      platform,
      now
    });

  const reassignedFrom = previous && previous.user_id !== input.userId ? previous.user_id : undefined;
  audit(
    "push.device.registered",
    {
      userId: input.userId,
      token: maskDeviceToken(input.token),
      environment: input.environment,
      bundleId: input.bundleId,
      platform,
      ...(reassignedFrom ? { reassignedFrom } : {})
    },
    input.userId
  );

  return getDeviceToken(input.token)!;
}

export function getDeviceToken(token: string): DeviceToken | undefined {
  const row = getDb().prepare("SELECT * FROM device_push_tokens WHERE token = ?").get(token) as
    | RawDeviceTokenRow
    | undefined;
  return row ? toDeviceToken(row) : undefined;
}

/** Every live token for a user, newest-registered last. Disabled tokens are excluded. */
export function listActiveDeviceTokens(userId: string): DeviceToken[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM device_push_tokens WHERE user_id = ? AND disabled_at IS NULL ORDER BY created_at ASC, token ASC"
    )
    .all(userId) as RawDeviceTokenRow[];
  return rows.map(toDeviceToken);
}

export function countActiveDeviceTokens(userId: string): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM device_push_tokens WHERE user_id = ? AND disabled_at IS NULL")
    .get(userId) as { n: number } | undefined;
  return row?.n ?? 0;
}

/**
 * Retire a token Apple told us is dead (410 Unregistered / 400 BadDeviceToken) — or that the user
 * signed out of. Kept as a disabled row (not deleted) so the reason survives for diagnosis.
 * Returns true when a live row was actually disabled.
 */
export function disableDeviceToken(token: string, reason: string): boolean {
  const now = new Date().toISOString();
  const owner = getDb().prepare("SELECT user_id FROM device_push_tokens WHERE token = ?").get(token) as
    | { user_id: string }
    | undefined;
  const result = getDb()
    .prepare("UPDATE device_push_tokens SET disabled_at = ?, disabled_reason = ? WHERE token = ? AND disabled_at IS NULL")
    .run(now, reason.slice(0, 200), token);
  const changed = result.changes > 0;
  if (changed) {
    audit(
      "push.device.disabled",
      { userId: owner?.user_id, token: maskDeviceToken(token), reason: reason.slice(0, 200) },
      owner?.user_id
    );
  }
  return changed;
}

/**
 * Explicit unregister (sign-out). Scoped to `userId` on purpose: a client may only retire a token
 * that currently belongs to it, so one account can never disable another account's device.
 * Returns true when a live row owned by this user was disabled.
 */
export function unregisterDeviceToken(userId: string, token: string): boolean {
  const owner = getDb().prepare("SELECT user_id FROM device_push_tokens WHERE token = ?").get(token) as
    | { user_id: string }
    | undefined;
  if (!owner || owner.user_id !== userId) return false;
  return disableDeviceToken(token, "unregistered by client");
}

/** Refresh last_seen_at after a successful send, so a stale-device sweep has real signal later. */
export function touchDeviceToken(token: string): void {
  try {
    getDb()
      .prepare("UPDATE device_push_tokens SET last_seen_at = ? WHERE token = ?")
      .run(new Date().toISOString(), token);
  } catch {
    // Best-effort bookkeeping — never let it affect delivery.
  }
}
