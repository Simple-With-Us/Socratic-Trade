import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import {
  getDb,
  setPolicy,
  reserveOptionAlert,
  releaseOptionAlertReservation
} from "../src/lib/db";
import { checkAndDispatchOptionAlerts } from "../src/lib/notifications";
import type { OptionPosition } from "../src/lib/types";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `option-alert-dedupe-${randomUUID()}.db`)}`;
  getDb();
});

beforeEach(() => {
  getDb().prepare("DELETE FROM notification_events").run();
  getDb().prepare("DELETE FROM audit_events").run();
  getDb().prepare("DELETE FROM option_alert_reservations").run();
  // option_alert enabled so the dispatch actually attempts delivery (and records an event row).
  setPolicy({
    ...DEFAULT_POLICY,
    notificationSettings: { ...DEFAULT_POLICY.notificationSettings, enabledEvents: ["option_alert"], webhookUrl: "" }
  }, "local");
});

// A gateway stub — checkAndDispatchOptionAlerts only calls getEquityQuotes when an option expires
// within 3 days; far-future expiries never touch it, so only the "appearance" alert fires.
const stubGateway = {} as any;

function optionPos(symbol: string): OptionPosition {
  return {
    symbol,
    underlyingSymbol: symbol.slice(0, 4),
    expirationDate: "2099-01-01",
    optionType: "call",
    strikePrice: 100,
    quantity: 1,
    averageCost: 2.5,
    marketValue: 250
  };
}

function optionAlertRows(symbol: string, alertType: string): number {
  return (
    getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM notification_events
         WHERE type = 'option_alert'
           AND json_extract(payload, '$.symbol') = ?
           AND json_extract(payload, '$.alertType') = ?`
      )
      .get(symbol, alertType) as { n: number }
  ).n;
}

describe("option-alert atomic reservation (finding 4)", () => {
  it("reserveOptionAlert is a single-winner claim; release re-opens it", () => {
    expect(reserveOptionAlert("local", "acct-1", "AAPL240101C00100000", "appearance")).toBe(true);
    // Second concurrent claim for the same (account, symbol, alertType) loses.
    expect(reserveOptionAlert("local", "acct-1", "AAPL240101C00100000", "appearance")).toBe(false);
    // A DIFFERENT alertType / account / symbol is an independent claim.
    expect(reserveOptionAlert("local", "acct-1", "AAPL240101C00100000", "expiry")).toBe(true);
    expect(reserveOptionAlert("local", "acct-2", "AAPL240101C00100000", "appearance")).toBe(true);
    // Releasing re-opens the original claim for a later cycle (skipped/failed-send semantics).
    releaseOptionAlertReservation("local", "acct-1", "AAPL240101C00100000", "appearance");
    expect(reserveOptionAlert("local", "acct-1", "AAPL240101C00100000", "appearance")).toBe(true);
  });

  it("reclaims an ABANDONED reservation older than the TTL (crash between claim and delivery) — Codex PR #1738", () => {
    // A process that claimed the alert then died before recording status='sent' or releasing leaves an
    // orphaned reservation with an OLD created_at. Without reclaim it would suppress this alert forever.
    const staleTs = new Date(Date.now() - 11 * 60 * 1000).toISOString(); // older than the 10-min TTL
    getDb()
      .prepare(
        `INSERT INTO option_alert_reservations (user_id, connected_account_id, symbol, alert_type, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run("local", "acct-stale", "NVDA240101C00100000", "appearance", staleTs);
    // The stale claim is reclaimed — the new claim wins.
    expect(reserveOptionAlert("local", "acct-stale", "NVDA240101C00100000", "appearance")).toBe(true);
    // ...and the reclaimed claim is now fresh, so a concurrent second claim still loses (the
    // single-winner guard is intact — reclaim didn't weaken it).
    expect(reserveOptionAlert("local", "acct-stale", "NVDA240101C00100000", "appearance")).toBe(false);

    // A FRESH reservation is NOT reclaimable — the TTL only frees genuinely abandoned claims.
    expect(reserveOptionAlert("local", "acct-fresh", "NVDA240101C00100000", "appearance")).toBe(true);
    expect(reserveOptionAlert("local", "acct-fresh", "NVDA240101C00100000", "appearance")).toBe(false);
  });

  it("two CONCURRENT dispatches deliver the same appearance alert only ONCE", async () => {
    const sym = "TSLA240101C00100000";
    const options = [optionPos(sym)];
    // Fire both dispatches concurrently against the same option — the pre-fix read-then-send would
    // let both pass the in-memory `sentAlerts` check and both deliver. The atomic reservation lets
    // exactly one win.
    await Promise.all([
      checkAndDispatchOptionAlerts("local", "acct-x", "ACCT-X", options, stubGateway),
      checkAndDispatchOptionAlerts("local", "acct-x", "ACCT-X", options, stubGateway)
    ]);
    expect(optionAlertRows(sym, "appearance")).toBe(1);
  });
});
