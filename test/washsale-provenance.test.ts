/**
 * PR #8 — per-symbol wash-sale provenance: a locked symbol carries the contributing account and
 * the clear date (binding loss exit + 30 days), so the Approvals card can name the culprit
 * without weakening the authoritative enforcement gate (the Set-returning helpers are unchanged).
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const WASH_WINDOW_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-washsale-prov-${randomUUID()}.db`)}`;
});

describe("wash-sale provenance (PR #8)", () => {
  const now = new Date("2026-06-30T00:00:00.000Z");

  it("records the contributing account and clear date per locked symbol", async () => {
    const db = await import("../src/lib/db");
    const { getUserWashSaleLockProvenance, getUserWashSaleLockedSymbols } = await import("../src/lib/tax");
    const u = `user-${randomUUID()}`;
    db.upsertConnectedAccount({ id: `r-${randomUUID()}`, userId: u, broker: "alpaca", environment: "paper", accountNumber: "REAL", label: "Robinhood", taxationType: "taxable", isActive: true });
    const exit = "2026-06-24T14:30:00.000Z";
    db.insertFillEvent({ userId: u, accountNumber: "REAL", source: "paper", symbol: "AAPL", side: "buy", quantity: 1, price: 100, notional: 100, status: "filled", filledAt: "2026-06-20T14:30:00.000Z" });
    db.insertFillEvent({ userId: u, accountNumber: "REAL", source: "paper", symbol: "AAPL", side: "sell", quantity: 1, price: 90, notional: 90, status: "filled", filledAt: exit });

    const prov = getUserWashSaleLockProvenance(u, now);
    const aapl = prov.get("AAPL");
    expect(aapl).toBeDefined();
    expect(aapl?.account).toBe("REAL");
    expect(aapl?.clearDate.getTime()).toBe(new Date(exit).getTime() + WASH_WINDOW_DAYS * MS_PER_DAY);

    // The Set the enforcement gate consumes is exactly the provenance map's keys (no drift).
    expect([...getUserWashSaleLockedSymbols(u, now)].sort()).toEqual([...prov.keys()].sort());
  });

  it("keeps the BINDING (latest) loss's clear date when two losses lock the same symbol", async () => {
    const db = await import("../src/lib/db");
    const { getUserWashSaleLockProvenance } = await import("../src/lib/tax");
    const u = `user-${randomUUID()}`;
    db.upsertConnectedAccount({ id: `r-${randomUUID()}`, userId: u, broker: "alpaca", environment: "paper", accountNumber: "REAL", label: "Taxable", taxationType: "taxable", isActive: true });
    // Two AAPL round-trips at a loss; the later exit binds the clear date.
    db.insertFillEvent({ userId: u, accountNumber: "REAL", source: "paper", symbol: "AAPL", side: "buy", quantity: 1, price: 100, notional: 100, status: "filled", filledAt: "2026-06-05T14:30:00.000Z" });
    db.insertFillEvent({ userId: u, accountNumber: "REAL", source: "paper", symbol: "AAPL", side: "sell", quantity: 1, price: 90, notional: 90, status: "filled", filledAt: "2026-06-10T14:30:00.000Z" });
    db.insertFillEvent({ userId: u, accountNumber: "REAL", source: "paper", symbol: "AAPL", side: "buy", quantity: 1, price: 100, notional: 100, status: "filled", filledAt: "2026-06-18T14:30:00.000Z" });
    const laterExit = "2026-06-26T14:30:00.000Z";
    db.insertFillEvent({ userId: u, accountNumber: "REAL", source: "paper", symbol: "AAPL", side: "sell", quantity: 1, price: 90, notional: 90, status: "filled", filledAt: laterExit });

    const aapl = getUserWashSaleLockProvenance(u, now).get("AAPL");
    expect(aapl?.clearDate.getTime()).toBe(new Date(laterExit).getTime() + WASH_WINDOW_DAYS * MS_PER_DAY);
    // lossUsd SUMS across contributing lots (a rebuy washes all of them): $10 + $10.
    expect(aapl?.lossUsd).toBeCloseTo(20);
  });

  it("carries the disallowed lossUsd so ask/auto handling can price the forfeited deduction", async () => {
    const db = await import("../src/lib/db");
    const { getUserWashSaleLockProvenance } = await import("../src/lib/tax");
    const u = `user-${randomUUID()}`;
    db.upsertConnectedAccount({ id: `r-${randomUUID()}`, userId: u, broker: "alpaca", environment: "paper", accountNumber: "REAL", label: "Taxable", taxationType: "taxable", isActive: true });
    // One MSFT round-trip: buy @200, sell @150 => $50 in-window loss.
    db.insertFillEvent({ userId: u, accountNumber: "REAL", source: "paper", symbol: "MSFT", side: "buy", quantity: 2, price: 200, notional: 400, status: "filled", filledAt: "2026-06-15T14:30:00.000Z" });
    db.insertFillEvent({ userId: u, accountNumber: "REAL", source: "paper", symbol: "MSFT", side: "sell", quantity: 2, price: 150, notional: 300, status: "filled", filledAt: "2026-06-24T14:30:00.000Z" });

    const msft = getUserWashSaleLockProvenance(u, now).get("MSFT");
    expect(msft?.lossUsd).toBeCloseTo(100); // 2 shares × $50
    expect(msft?.account).toBe("REAL");
  });
});
