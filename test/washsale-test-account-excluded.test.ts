/**
 * PR #8 — [WASH-SALE] a simulated (Test) loss must NEVER lock a real taxable account. Test/sim
 * accounts trade fake money with no tax consequence, so they are excluded from wash-sale
 * contribution; a loss in a REAL taxable account still locks the symbol across all accounts.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-washsale-test-excl-${randomUUID()}.db`)}`;
});

function recordLoss(db: typeof import("../src/lib/db"), userId: string, accountNumber: string, symbol: string) {
  db.insertFillEvent({ userId, accountNumber, source: "paper", symbol, side: "buy", quantity: 1, price: 100, notional: 100, status: "filled", filledAt: "2026-06-20T14:30:00.000Z" });
  db.insertFillEvent({ userId, accountNumber, source: "paper", symbol, side: "sell", quantity: 1, price: 90, notional: 90, status: "filled", filledAt: "2026-06-25T14:30:00.000Z" });
}

describe("Test account excluded from wash-sale contribution (PR #8)", () => {
  const now = new Date("2026-06-30T00:00:00.000Z"); // within 30d of the losses

  it("a Test-account loss does NOT lock the symbol", async () => {
    const db = await import("../src/lib/db");
    const { getUserWashSaleLockedSymbols } = await import("../src/lib/tax");
    const u = `user-${randomUUID()}`;
    db.upsertConnectedAccount({ id: `t-${randomUUID()}`, userId: u, broker: "test", environment: "paper", accountNumber: "SIM", label: "Sim", taxationType: "taxable", isActive: true });
    recordLoss(db, u, "SIM", "AAPL");

    expect(getUserWashSaleLockedSymbols(u, now).has("AAPL")).toBe(false);
  });

  it("a REAL taxable-account loss DOES lock the symbol (enforcement preserved)", async () => {
    const db = await import("../src/lib/db");
    const { getUserWashSaleLockedSymbols } = await import("../src/lib/tax");
    const u = `user-${randomUUID()}`;
    db.upsertConnectedAccount({ id: `r-${randomUUID()}`, userId: u, broker: "alpaca", environment: "paper", accountNumber: "REAL", label: "Taxable", taxationType: "taxable", isActive: true });
    recordLoss(db, u, "REAL", "MSFT");

    expect(getUserWashSaleLockedSymbols(u, now).has("MSFT")).toBe(true);
  });

  it("with both a Test and a real account, only the real account's symbol locks", async () => {
    const db = await import("../src/lib/db");
    const { getUserWashSaleLockedSymbols } = await import("../src/lib/tax");
    const u = `user-${randomUUID()}`;
    db.upsertConnectedAccount({ id: `t2-${randomUUID()}`, userId: u, broker: "test", environment: "paper", accountNumber: "SIM", label: "Sim", taxationType: "taxable", isActive: true });
    db.upsertConnectedAccount({ id: `r2-${randomUUID()}`, userId: u, broker: "alpaca", environment: "paper", accountNumber: "REAL", label: "Taxable", taxationType: "taxable", isActive: false });
    recordLoss(db, u, "SIM", "TSLA"); // simulated loss — must NOT lock
    recordLoss(db, u, "REAL", "NVDA"); // real loss — must lock

    const locked = getUserWashSaleLockedSymbols(u, now);
    expect(locked.has("NVDA")).toBe(true);
    expect(locked.has("TSLA")).toBe(false);
  });
});
