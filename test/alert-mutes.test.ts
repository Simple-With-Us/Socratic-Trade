// Per-condition Alert Center mutes (#2555): key/expiry purity, user_settings persistence,
// and the derive-level rendering splits (mute filtering + provider_degraded rollup).
// A mute is RENDERING-only — detection, recording, and delivery are untouched — so these
// tests exercise exactly the layers the feature is allowed to touch.

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { NotificationEvent } from "../src/lib/types";
import {
  activeAlertMutes,
  alertConditionKey,
  isAlertMuted,
  ALERT_MUTE_DURATION_MS
} from "../src/lib/alert-mutes";

// Temp SQLite — set BEFORE any module import that touches db
beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-alert-mutes-${randomUUID()}.db`)}`;
});

function event(overrides: Partial<NotificationEvent> & { id: string }): NotificationEvent {
  return {
    createdAt: "2026-08-06T12:00:00.000Z",
    type: "provider_degraded",
    title: "pinecone connection failed",
    status: "sent",
    payload: {},
    ...overrides
  };
}

describe("alertConditionKey / expiry helpers", () => {
  it("keys a condition on (type, account, title) — ack state and payload never split a condition", () => {
    const a = event({ id: "a" });
    const acked = event({ id: "b", acknowledgedAt: "2026-08-06T13:00:00.000Z", payload: { anything: 1 } });
    expect(alertConditionKey(a)).toBe(alertConditionKey(acked));
    expect(alertConditionKey(event({ id: "c", title: "fmp connection failed" }))).not.toBe(alertConditionKey(a));
    expect(alertConditionKey(event({ id: "d", connectedAccountId: "acct-2" }))).not.toBe(alertConditionKey(a));
  });

  it("activeAlertMutes / isAlertMuted honor expiry and garbage values", () => {
    const now = Date.parse("2026-08-06T12:00:00.000Z");
    const key = alertConditionKey(event({ id: "a" }));
    const live = { [key]: new Date(now + 3600_000).toISOString() };
    const expired = { [key]: new Date(now - 1).toISOString() };
    const garbage = { [key]: "not-a-date" };
    expect(Object.keys(activeAlertMutes(live, now))).toEqual([key]);
    expect(Object.keys(activeAlertMutes(expired, now))).toEqual([]);
    expect(Object.keys(activeAlertMutes(garbage, now))).toEqual([]);
    expect(isAlertMuted(event({ id: "a" }), live, now)).toBe(true);
    expect(isAlertMuted(event({ id: "a" }), expired, now)).toBe(false);
    expect(isAlertMuted(event({ id: "x", title: "other" }), live, now)).toBe(false);
  });
});

describe("mute persistence (user_settings KV)", () => {
  it("persists a 24h mute, survives re-read, is reversible, and prunes expired entries on write", async () => {
    const { getAlertMutes, setAlertMute } = await import("../src/lib/db");
    const userId = `u-${randomUUID()}`;
    const now = Date.parse("2026-08-06T12:00:00.000Z");
    const key = alertConditionKey(event({ id: "a" }));

    // Mute → persisted with a 24h expiry, readable on a fresh read.
    const afterMute = setAlertMute(userId, key, true, now);
    expect(Date.parse(afterMute[key]!)).toBe(now + ALERT_MUTE_DURATION_MS);
    expect(getAlertMutes(userId, now)).toMatchObject({ [key]: afterMute[key] });

    // Still active 23h in; expired (and filtered from reads) at 25h.
    expect(Object.keys(getAlertMutes(userId, now + 23 * 3600_000))).toEqual([key]);
    expect(Object.keys(getAlertMutes(userId, now + 25 * 3600_000))).toEqual([]);

    // Reversible: unmute clears it immediately.
    setAlertMute(userId, key, true, now);
    const afterUnmute = setAlertMute(userId, key, false, now + 1000);
    expect(afterUnmute[key]).toBeUndefined();
    expect(Object.keys(getAlertMutes(userId, now + 1000))).toEqual([]);

    // Expired entries are pruned when a later write happens.
    setAlertMute(userId, "stale-condition", true, now - 2 * ALERT_MUTE_DURATION_MS);
    const other = alertConditionKey(event({ id: "b", title: "fmp connection failed" }));
    const afterSecond = setAlertMute(userId, other, true, now);
    expect(afterSecond["stale-condition"]).toBeUndefined();
    expect(Object.keys(afterSecond)).toEqual([other]);
  });

  it("scopes mutes per user", async () => {
    const { getAlertMutes, setAlertMute } = await import("../src/lib/db");
    const now = Date.parse("2026-08-06T12:00:00.000Z");
    const userA = `u-${randomUUID()}`;
    const userB = `u-${randomUUID()}`;
    setAlertMute(userA, "cond", true, now);
    expect(Object.keys(getAlertMutes(userA, now))).toEqual(["cond"]);
    expect(Object.keys(getAlertMutes(userB, now))).toEqual([]);
  });
});

describe("Alert Center derive: mute split + provider rollup", () => {
  async function loadComponentModule() {
    return import("../app/console/components/alert-center");
  }

  it("splitMutedAlertRows hides muted conditions from the active list but keeps them countable", async () => {
    const { buildRows, splitMutedAlertRows } = await loadComponentModule();
    const now = Date.parse("2026-08-06T12:00:00.000Z");
    const events = [
      event({ id: "p1" }),
      event({ id: "p2", title: "fmp connection failed" }),
      event({ id: "r1", type: "run_failed", title: "Strategy run failed", status: "failed" })
    ];
    const rows = buildRows(events, {}, []);
    const muteKey = alertConditionKey(events[0]!);
    const mutes = { [muteKey]: new Date(now + 3600_000).toISOString() };

    const { active, muted } = splitMutedAlertRows(rows, mutes, now);
    expect(muted).toHaveLength(1);
    expect(muted[0]!.event.id).toBe("p1");
    expect(active.map((row) => row.event.id).sort()).toEqual(["p2", "r1"]);

    // Expired mute → everything back automatically.
    const lapsed = splitMutedAlertRows(rows, mutes, now + 25 * 3600_000);
    expect(lapsed.muted).toHaveLength(0);
    expect(lapsed.active).toHaveLength(3);
  });

  it("partitionProviderRollup absorbs every provider_degraded incident and nothing else", async () => {
    const { buildRows, partitionProviderRollup } = await loadComponentModule();
    const events = [
      event({ id: "p1", title: "pinecone connection failed" }),
      event({ id: "p2", title: "fmp connection failed" }),
      event({ id: "p3", title: "pinecone connection failed", createdAt: "2026-08-06T11:00:00.000Z" }), // repeat → same incident
      event({ id: "r1", type: "run_failed", title: "Strategy run failed", status: "failed" }),
      event({ id: "k1", type: "kill_switch", title: "Kill switch triggered" })
    ];
    const rows = buildRows(events, {}, []);
    const { provider, rest } = partitionProviderRollup(rows);
    // Two provider LANES (pinecone repeats collapse into one incident first), two real items.
    expect(provider).toHaveLength(2);
    expect(provider.every((row) => row.event.type === "provider_degraded")).toBe(true);
    expect(rest.map((row) => row.event.type).sort()).toEqual(["kill_switch", "run_failed"]);
  });
});
