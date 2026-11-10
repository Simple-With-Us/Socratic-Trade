import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-daily-snaps-${randomUUID()}.db`)}`;
});

describe("listDailyPortfolioSnapshots", () => {
  it("keeps the last snapshot of each calendar day and drops intra-day duplicates", async () => {
    const db = await import("../src/lib/db");
    const acct = `DAILY-${randomUUID().slice(0, 8)}`;
    db.insertPortfolioSnapshot({
      accountNumber: acct,
      source: "live",
      equity: 100_000,
      cash: 100_000,
      buyingPower: 100_000,
      positionsValue: 0,
      positions: [],
      createdAt: "2026-01-02T14:00:00.000Z"
    });
    db.insertPortfolioSnapshot({
      accountNumber: acct,
      source: "live",
      equity: 101_000,
      cash: 101_000,
      buyingPower: 101_000,
      positionsValue: 0,
      positions: [],
      createdAt: "2026-01-02T20:00:00.000Z"
    });
    db.insertPortfolioSnapshot({
      accountNumber: acct,
      source: "live",
      equity: 102_000,
      cash: 52_000,
      buyingPower: 52_000,
      positionsValue: 50_000,
      positions: [],
      createdAt: "2026-01-05T16:00:00.000Z"
    });

    const daily = db.listDailyPortfolioSnapshots(acct, "live", "local");
    expect(daily).toHaveLength(2);
    expect(daily[0].createdAt).toBe("2026-01-02T20:00:00.000Z");
    expect(daily[0].equity).toBe(101_000);
    expect(daily[1].createdAt).toBe("2026-01-05T16:00:00.000Z");
    expect(daily[1].equity).toBe(102_000);

    const newest100 = db.listPortfolioSnapshots(acct, "live", 100, "local");
    expect(newest100).toHaveLength(3);
  });
});
