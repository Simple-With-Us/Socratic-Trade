import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sweepPortfolioSnapshots, insertPortfolioSnapshot } from "../src/lib/db-fills";
import { getDb } from "../src/lib/db";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-portfoliosnap-${randomUUID()}.db`)}`;
});

beforeEach(() => {
  getDb().prepare("DELETE FROM portfolio_snapshots").run();
});

function seedSnapshots(count: number, daysAgoFn: (i: number) => number) {
  for (let i = 0; i < count; i++) {
    insertPortfolioSnapshot({
      userId: "local",
      accountNumber: "ACC1",
      source: "paper",
      executionMode: "broker/paper",
      equity: 100_000 + i,
      cash: 50_000,
      buyingPower: 50_000,
      positionsValue: 50_000,
      positions: [],
      createdAt: new Date(Date.now() - daysAgoFn(i) * 24 * 3600_000).toISOString(),
    });
  }
}

describe("sweepPortfolioSnapshots", () => {
  it("does not delete snapshots by age (forever retention)", () => {
    seedSnapshots(12, () => 100);
    expect(sweepPortfolioSnapshots(new Date(), 90, 5)).toBe(0);
    expect(sweepPortfolioSnapshots(new Date(), 90, 100)).toBe(0);
    expect((getDb().prepare("SELECT count(*) c FROM portfolio_snapshots").get() as { c: number }).c).toBe(12);
  });

  it("creates idx_audit_events_kind_created (migration 90) on open", () => {
    const idx = getDb()
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_audit_events_kind_created'"
      )
      .get();
    expect(idx).toBeDefined();
    expect((idx as { name: string }).name).toBe("idx_audit_events_kind_created");
  });
});
