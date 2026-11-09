import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { recordRejectedProposalCounterfactual } from "../src/lib/counterfactual-learning";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-rejcf-${randomUUID()}.db`)}`;
});

describe("recordRejectedProposalCounterfactual", () => {
  it("inserts a pending counterfactual for a rejected proposal and is idempotent", async () => {
    const { getDb } = await import("../src/lib/db");
    const inserted = recordRejectedProposalCounterfactual({
      userId: "local",
      runId: "run-1",
      symbol: "AAPL",
      refPrice: 200,
      createdAt: "2026-06-20T15:00:00.000Z",
      regime: "Risk-On (Low Volatility)"
    });
    expect(inserted).toBe(true);

    const row = getDb()
      .prepare("SELECT symbol, ref_price, status, regime, horizon_days FROM skipped_candidate_counterfactuals WHERE user_id = ? AND run_id = ?")
      .get("local", "run-1") as { symbol: string; ref_price: number; status: string; regime: string; horizon_days: number } | undefined;
    expect(row).toBeTruthy();
    expect(row!.symbol).toBe("AAPL");
    expect(row!.ref_price).toBe(200);
    expect(row!.status).toBe("pending");
    expect(row!.regime).toBe("Risk-On (Low Volatility)");

    // INSERT OR IGNORE → a duplicate (same user/run/symbol/horizon) does not double-count.
    const again = recordRejectedProposalCounterfactual({
      userId: "local",
      runId: "run-1",
      symbol: "AAPL",
      refPrice: 200,
      createdAt: "2026-06-20T15:00:00.000Z"
    });
    expect(again).toBe(false);

    const count = getDb()
      .prepare("SELECT COUNT(*) AS n FROM skipped_candidate_counterfactuals WHERE user_id = ? AND run_id = ? AND symbol = ?")
      .get("local", "run-1", "AAPL") as { n: number };
    expect(count.n).toBe(1);
  });

  it("returns false without a usable reference price (no fabricated anchor)", () => {
    expect(recordRejectedProposalCounterfactual({ userId: "local", runId: "run-2", symbol: "MSFT", refPrice: undefined, createdAt: "2026-06-20T15:00:00.000Z" })).toBe(false);
    expect(recordRejectedProposalCounterfactual({ userId: "local", runId: "run-3", symbol: "MSFT", refPrice: 0, createdAt: "2026-06-20T15:00:00.000Z" })).toBe(false);
  });

  it("anchors the trading-day horizon to the MARKET day, not the UTC day, for after-hours vetoes", async () => {
    const { getDb } = await import("../src/lib/db");
    // Monday 2026-01-05 19:30 ET stored as 2026-01-06T00:30Z — the UTC date is already Tuesday.
    // Five TRADING days after the MARKET day (Mon Jan 5) = Jan 6, 7, 8, 9, 12 → Mon 2026-01-12.
    // The old UTC anchoring counted from Tue Jan 6 → Jan 13, delaying maturation one session.
    const inserted = recordRejectedProposalCounterfactual({
      userId: "local",
      runId: "run-afterhours",
      symbol: "NVDA",
      refPrice: 500,
      createdAt: "2026-01-06T00:30:00.000Z",
      horizonDays: 5
    });
    expect(inserted).toBe(true);
    const row = getDb()
      .prepare("SELECT target_date FROM skipped_candidate_counterfactuals WHERE user_id = ? AND run_id = ?")
      .get("local", "run-afterhours") as { target_date: string } | undefined;
    expect(row?.target_date).toBe("2026-01-12");
  });

  it("a later richer insert BACKFILLS evidence onto an early bare veto row (never preempted, never re-priced)", async () => {
    const { getDb, insertSkippedCounterfactualCandidate } = await import("../src/lib/db");
    // 1. Bear-veto early insert: regime only (what recordRejectedProposalCounterfactual writes).
    expect(
      insertSkippedCounterfactualCandidate({
        userId: "local",
        runId: "run-backfill",
        symbol: "AMD",
        snapshotAt: "2026-06-20T15:00:00.000Z",
        refPrice: 150,
        horizonDays: 5,
        targetDate: "2026-06-26",
        regime: "Risk-On"
      })
    ).toBe(true);
    // 2. The run's signal_snapshot ingestion arrives with the full evidence for the same key.
    expect(
      insertSkippedCounterfactualCandidate({
        userId: "local",
        runId: "run-backfill",
        symbol: "AMD",
        snapshotAt: "2026-06-20T15:05:00.000Z",
        refPrice: 999, // must NOT re-price the row — first write stays authoritative
        horizonDays: 5,
        targetDate: "2026-06-26",
        score: 82,
        sector: "Technology",
        regime: "SHOULD-NOT-OVERWRITE",
        dominantFactor: "momentum",
        bulletins: ["Earnings beat"]
      })
    ).toBe(false); // still reports "not newly inserted" — no double-count
    const row = getDb()
      .prepare("SELECT ref_price, score, sector, regime, dominant_factor, bulletins FROM skipped_candidate_counterfactuals WHERE user_id = ? AND run_id = ?")
      .get("local", "run-backfill") as { ref_price: number; score: number | null; sector: string | null; regime: string | null; dominant_factor: string | null; bulletins: string | null };
    expect(row.ref_price).toBe(150); // first write wins for pricing
    expect(row.score).toBe(82); // NULL evidence backfilled
    expect(row.sector).toBe("Technology");
    expect(row.regime).toBe("Risk-On"); // existing evidence never overwritten
    expect(row.dominant_factor).toBe("momentum");
    expect(JSON.parse(row.bulletins ?? "[]")).toEqual(["Earnings beat"]);
  });
});
