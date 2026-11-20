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

  it("collapses same-UTC-day pre/post snapshots to the post-run row (Central-midnight straddle), preserving runId", async () => {
    // Production pipeline truth behind the run-alignment pure-function tests: a run whose
    // pre-run and post-run snapshots share one UTC day (a Central-midnight straddle:
    // 2026-01-04T05:55Z = Jan 3 23:55 CST, 06:01Z = Jan 4 00:01 CST) delivers ONLY the
    // post-run point to curve consumers. Inference-level tests must therefore treat the
    // two-snapshot straddle as pure-function scope, not a loader-deliverable shape.
    const db = await import("../src/lib/db");
    const acct = `STRADDLE-${randomUUID().slice(0, 8)}`;
    const base = {
      accountNumber: acct,
      source: "live" as const,
      equity: 100_000,
      cash: 60_000,
      buyingPower: 60_000,
      positionsValue: 40_000,
      positions: []
    };
    db.insertPortfolioSnapshot({ ...base, runId: "run-B", createdAt: "2026-01-04T05:55:00.000Z" });
    db.insertPortfolioSnapshot({ ...base, runId: "run-B", createdAt: "2026-01-04T06:01:00.000Z" });
    db.insertPortfolioSnapshot({ ...base, runId: "run-C", createdAt: "2026-01-05T20:00:00.000Z" });

    const daily = db.listDailyPortfolioSnapshots(acct, "live", "local");
    expect(daily).toHaveLength(2);
    expect(daily[0].createdAt).toBe("2026-01-04T06:01:00.000Z"); // post-run point wins the UTC day
    expect(daily[0].runId).toBe("run-B"); // run identity survives the selection
    expect(daily[1].createdAt).toBe("2026-01-05T20:00:00.000Z");
    expect(daily[1].runId).toBe("run-C");
  });
});
