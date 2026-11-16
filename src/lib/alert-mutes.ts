// alert-mutes.ts — per-condition Alert Center mutes (#2555): pure helpers.
//
// A mute silences ONE alert condition's rows in the Alert Center RENDERING for 24 hours.
// Advisory-philosophy compatible by construction: it changes NOTHING about detection,
// recording, or delivery (NOTIFICATION_REPEAT_DEDUP_MS already governs sends) — the rows
// keep being written and stay reachable behind a visible "muted N" count, and every mute
// is reversible from the same surface. Persistence lives in db-settings.ts
// (getAlertMutes/setAlertMute, user_settings KV); this module stays dependency-free so the
// client Alert Center can import the key/expiry logic directly.

import type { NotificationEvent } from "./types";

/** conditionKey → mutedUntil ISO timestamp. */
export type AlertMuteMap = Record<string, string>;

export const ALERT_MUTE_SETTING_KEY = "alertConditionMutes";
export const ALERT_MUTE_DURATION_MS = 24 * 3600_000;

/**
 * The condition a mute applies to: (type, account, title) — the same fingerprint the Alert
 * Center's incident grouping keys repeats on (see incidentKey in
 * app/console/components/alert-center.tsx), minus the acknowledged flag: muting a condition
 * must cover both its open and its acked rows.
 */
export function alertConditionKey(event: Pick<NotificationEvent, "type" | "connectedAccountId" | "title">): string {
  return [event.type, event.connectedAccountId ?? "", event.title].join(" ");
}

/** The subset of `mutes` still in force at `nowMs`. */
export function activeAlertMutes(mutes: AlertMuteMap, nowMs: number): AlertMuteMap {
  const active: AlertMuteMap = {};
  for (const [key, until] of Object.entries(mutes ?? {})) {
    if (typeof until !== "string") continue;
    const untilMs = Date.parse(until);
    if (Number.isFinite(untilMs) && untilMs > nowMs) active[key] = until;
  }
  return active;
}

/** Whether one event's condition is muted at `nowMs`. */
export function isAlertMuted(
  event: Pick<NotificationEvent, "type" | "connectedAccountId" | "title">,
  mutes: AlertMuteMap,
  nowMs: number
): boolean {
  const until = mutes?.[alertConditionKey(event)];
  if (typeof until !== "string") return false;
  const untilMs = Date.parse(until);
  return Number.isFinite(untilMs) && untilMs > nowMs;
}
