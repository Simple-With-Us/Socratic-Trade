// Server-backed Auth.js session records (ST-2599). JWTs carry `sid`; decode consults this table.

import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { getDrizzle } from "./db/client";
import { authSessions } from "./db/schema";
import {
  SESSION_ABSOLUTE_MAX_AGE_SEC,
  SESSION_SLIDING_MAX_AGE_SEC,
} from "./auth/session-policy";

export type AuthServerSession = {
  id: string;
  userId: string;
  createdAt: string;
  absoluteExpiresAt: string;
  revokedAt: string | null;
  lastSeenAt: string;
};

function toRow(row: typeof authSessions.$inferSelect): AuthServerSession {
  return {
    id: row.id,
    userId: row.user_id,
    createdAt: row.created_at,
    absoluteExpiresAt: row.absolute_expires_at,
    revokedAt: row.revoked_at,
    lastSeenAt: row.last_seen_at,
  };
}

export function slidingMaxAgeSeconds(absoluteExpiresAtIso: string, nowMs: number = Date.now()): number {
  const absoluteRemaining = Math.floor((new Date(absoluteExpiresAtIso).getTime() - nowMs) / 1000);
  if (absoluteRemaining <= 0) return 0;
  return Math.min(SESSION_SLIDING_MAX_AGE_SEC, absoluteRemaining);
}

export function createAuthServerSession(userId: string, nowMs: number = Date.now()): AuthServerSession {
  const now = new Date(nowMs).toISOString();
  const absoluteExpiresAt = new Date(nowMs + SESSION_ABSOLUTE_MAX_AGE_SEC * 1000).toISOString();
  const id = randomUUID();
  getDrizzle()
    .insert(authSessions)
    .values({
      id,
      user_id: userId,
      created_at: now,
      absolute_expires_at: absoluteExpiresAt,
      revoked_at: null,
      last_seen_at: now,
    })
    .run();
  return {
    id,
    userId,
    createdAt: now,
    absoluteExpiresAt,
    revokedAt: null,
    lastSeenAt: now,
  };
}

export function getAuthServerSession(sessionId: string): AuthServerSession | null {
  const row = getDrizzle()
    .select()
    .from(authSessions)
    .where(eq(authSessions.id, sessionId))
    .get();
  return row ? toRow(row) : null;
}

export function isAuthServerSessionActive(
  sessionId: string,
  nowMs: number = Date.now()
): boolean {
  const session = getAuthServerSession(sessionId);
  if (!session || session.revokedAt) return false;
  return new Date(session.absoluteExpiresAt).getTime() > nowMs;
}

const SESSION_LAST_SEEN_TOUCH_THROTTLE_MS = 5 * 60_000;

export function touchAuthServerSession(sessionId: string, nowMs: number = Date.now()): AuthServerSession | null {
  const existing = getAuthServerSession(sessionId);
  if (!existing || existing.revokedAt) return null;
  if (new Date(existing.absoluteExpiresAt).getTime() <= nowMs) return null;
  const lastSeenMs = new Date(existing.lastSeenAt).getTime();
  if (nowMs - lastSeenMs < SESSION_LAST_SEEN_TOUCH_THROTTLE_MS) {
    return existing;
  }
  const now = new Date(nowMs).toISOString();
  getDrizzle()
    .update(authSessions)
    .set({ last_seen_at: now })
    .where(and(eq(authSessions.id, sessionId), isNull(authSessions.revoked_at)))
    .run();
  return { ...existing, lastSeenAt: now };
}

export function revokeAuthServerSession(sessionId: string, nowMs: number = Date.now()): boolean {
  const now = new Date(nowMs).toISOString();
  const result = getDrizzle()
    .update(authSessions)
    .set({ revoked_at: now })
    .where(and(eq(authSessions.id, sessionId), isNull(authSessions.revoked_at)))
    .run();
  return result.changes > 0;
}

export function revokeAllAuthServerSessionsForUser(userId: string, nowMs: number = Date.now()): number {
  const now = new Date(nowMs).toISOString();
  const result = getDrizzle()
    .update(authSessions)
    .set({ revoked_at: now })
    .where(and(eq(authSessions.user_id, userId), isNull(authSessions.revoked_at)))
    .run();
  return result.changes;
}

export function absoluteExpUnixSeconds(absoluteExpiresAtIso: string): number {
  return Math.floor(new Date(absoluteExpiresAtIso).getTime() / 1000);
}
