// Peer-app database contention surfaced through api-health (prod 2026-09-30, ST-3988).
//
// Congress.Trade (App A) returns HTTP 200 import bodies with ok:false and per-row errors such as
// `D1 batch error: SQLITE_BUSY: database is locked`. Socratic-Trade logs those as congress-share
// health failures. They are NOT a broken ST↔CT connection and NOT local data/app.db contention —
// but the generic SQLite substring matcher in local-db-fault.ts treated them as LOCAL faults, and
// when they slipped past that guard they still paged as "<service> connection failed" (PagerDuty
// #313).
//
// This module classifies those peer-originated write-contention shapes and routes them to an
// honest warning lane (Sentry `peer-db-contention`, no operator push).

import { audit, getInternalSetting, setInternalSetting } from "./db";

/** Lanes where an HTTP/import error may carry App A / Congress.Trade D1 or SQLite text. */
export const PEER_UPSTREAM_DB_LANES = new Set([
  "congress-share",
  "congress.trade",
  "congress.trade:sse"
]);

const PEER_DB_SQLITE_IN_BODY =
  /(?:\bD1\b.*\bSQLITE_(?:BUSY|LOCKED)\b|\bSQLITE_(?:BUSY|LOCKED)\b.*\bD1\b|\bD1 batch error\b|database is locked)/i;

/** Prefix for api_health_log rows that must not hard-STOP a lane or page as connection failed. */
export const HEALTH_PEER_DB_CONTENTION_PREFIX = "[peer-db-contention] ";

export const PEER_DB_FAULT_WARNING_TYPE = "peer database contention";

export const PEER_DB_FAULT_WINDOW_MS = 6 * 60 * 60_000;
export const PEER_DB_FAULT_ADVISORY_THRESHOLD = 5;
export const PEER_DB_FAULT_WINDOW_KEY = "peerDbFault:window";
export const PEER_DB_FAULT_AUDIT_HOUR_KEY = "peerDbFault:lastAuditHour";

interface PeerDbFaultWindow {
  startedAt: string;
  count: number;
  advised: boolean;
}

function readWindow(nowMs: number): PeerDbFaultWindow {
  const stored = getInternalSetting<Partial<PeerDbFaultWindow>>(PEER_DB_FAULT_WINDOW_KEY);
  const startedAtMs = stored?.startedAt ? Date.parse(stored.startedAt) : Number.NaN;
  const fresh =
    Number.isFinite(startedAtMs) &&
    startedAtMs <= nowMs &&
    nowMs - startedAtMs < PEER_DB_FAULT_WINDOW_MS;
  if (!fresh) return { startedAt: new Date(nowMs).toISOString(), count: 0, advised: false };
  return {
    startedAt: stored!.startedAt!,
    count: typeof stored?.count === "number" && Number.isFinite(stored.count) ? stored.count : 0,
    advised: stored?.advised === true
  };
}

/**
 * True when `message` is a Congress.Trade / App A database write-contention symptom relayed through
 * a peer health lane — not local SQLite and not a transport outage.
 */
export function isPeerUpstreamDbFaultMessage(
  message: string | null | undefined,
  service: string
): boolean {
  if (!message || !PEER_UPSTREAM_DB_LANES.has(service)) return false;
  const text = message.trim();
  if (!text) return false;
  if (text.startsWith(HEALTH_PEER_DB_CONTENTION_PREFIX)) return true;
  if (/App A reported/i.test(text) && PEER_DB_SQLITE_IN_BODY.test(text)) return true;
  if (/\bD1 batch error\b/i.test(text)) return true;
  if (/\bHTTP 5\d\d\b/i.test(text) && PEER_DB_SQLITE_IN_BODY.test(text)) return true;
  return false;
}

/** Stamp peer-db rows at the log site when the body error is already known. */
export function formatPeerDbHealthErrorText(errorText: string): string {
  if (errorText.startsWith(HEALTH_PEER_DB_CONTENTION_PREFIX)) return errorText;
  return `${HEALTH_PEER_DB_CONTENTION_PREFIX}${errorText}`;
}

export interface PeerDbFaultInput {
  lane: string;
  operation: string;
  message: string;
  userId?: string;
}

export async function notePeerUpstreamDbFault(
  input: PeerDbFaultInput,
  nowMs: number = Date.now()
): Promise<{ count: number; advised: boolean }> {
  let result = { count: 0, advised: false };
  try {
    const window = readWindow(nowMs);
    const count = window.count + 1;
    const shouldAdvise = !window.advised && count >= PEER_DB_FAULT_ADVISORY_THRESHOLD;
    const next: PeerDbFaultWindow = {
      startedAt: window.startedAt,
      count,
      advised: window.advised || shouldAdvise
    };
    setInternalSetting(PEER_DB_FAULT_WINDOW_KEY, next);
    result = { count, advised: shouldAdvise };

    const hour = new Date(nowMs).toISOString().slice(0, 13);
    if (getInternalSetting<string>(PEER_DB_FAULT_AUDIT_HOUR_KEY) !== hour) {
      setInternalSetting(PEER_DB_FAULT_AUDIT_HOUR_KEY, hour);
      audit(
        "peer_db_contention",
        {
          lane: input.lane,
          operation: input.operation,
          reason: input.message.slice(0, 400),
          windowStartedAt: window.startedAt,
          windowCount: count
        },
        input.userId ?? "local"
      );
    }
    console.warn(
      `[peer-db-fault] ${input.lane} "${input.operation}" saw App A write contention ` +
        `(${input.message.slice(0, 120)}) — ST connection is not broken (${count} in this window).`
    );

    if (shouldAdvise) {
      const { alertStorageWarning } = await import("./db-health");
      await alertStorageWarning(
        PEER_DB_FAULT_WARNING_TYPE,
        `Congress.Trade reported database write contention ${count} times in the last ` +
          `${Math.round(PEER_DB_FAULT_WINDOW_MS / 3_600_000)}h on the ${input.lane} "${input.operation}" ` +
          `path (latest: "${input.message.slice(0, 160)}"). This is App A D1/SQLite contention, not a ` +
          "broken congress-share connection on Socratic-Trade."
      );
    }
  } catch {
    // Reporting must never throw.
  }
  return result;
}
