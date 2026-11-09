import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { TradeProposal } from "../src/lib/types";

// Audit fix (2026-07-10): trade_proposals.trade_thesis_tag / entry_market_regime were 0/714
// populated while the same tags existed inside the proposal JSON blob (543/714 rows). These tests
// cover: (a) insertProposal deriving the columns from the proposal object when not passed
// explicitly, (b) explicit args still winning over the proposal object, (c) the migrate()-style
// backfill recovering legacy NULL-column rows, and (d) getProposal's JS-side fallback for legacy
// rows that predate any backfill.
beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-thesis-tag-${randomUUID()}.db`)}`;
});

const baseProposal: TradeProposal = {
  symbol: "AAPL",
  side: "buy",
  type: "market",
  dollarAmount: 100,
  timeInForce: "gfd",
  marketHours: "regular_hours",
  rationale: "Momentum breakout on volume.",
  tradeThesisTag: "Momentum-Breakout",
  entryMarketRegime: "Risk-On"
};

/** Raw row shape as persisted in trade_proposals, for direct-SQL assertions/inserts. */
type RawProposalRow = {
  trade_thesis_tag: string | null;
  entry_market_regime: string | null;
};

describe("insertProposal thesis-tag derivation", () => {
  it("derives trade_thesis_tag/entry_market_regime from the proposal object when not passed explicitly", async () => {
    const { getDb, insertProposal } = await import("../src/lib/db");
    const id = `derive-${randomUUID()}`;
    insertProposal({
      id,
      runId: "run-1",
      accountNumber: "DERIVE-ACCT",
      proposal: baseProposal,
      decision: { approved: true, reasons: [] },
      status: "proposed"
      // tradeThesisTag / entryMarketRegime deliberately omitted
    });

    const row = getDb()
      .prepare("SELECT trade_thesis_tag, entry_market_regime FROM trade_proposals WHERE id = ?")
      .get(id) as RawProposalRow;
    expect(row.trade_thesis_tag).toBe("Momentum-Breakout");
    expect(row.entry_market_regime).toBe("Risk-On");
  });

  it("prefers explicit tradeThesisTag/entryMarketRegime args over the proposal object", async () => {
    const { getDb, insertProposal } = await import("../src/lib/db");
    const id = `explicit-${randomUUID()}`;
    insertProposal({
      id,
      runId: "run-1",
      accountNumber: "EXPLICIT-ACCT",
      proposal: baseProposal,
      decision: { approved: true, reasons: [] },
      status: "proposed",
      tradeThesisTag: "Value-Reversion",
      entryMarketRegime: "Risk-Off"
    });

    const row = getDb()
      .prepare("SELECT trade_thesis_tag, entry_market_regime FROM trade_proposals WHERE id = ?")
      .get(id) as RawProposalRow;
    expect(row.trade_thesis_tag).toBe("Value-Reversion");
    expect(row.entry_market_regime).toBe("Risk-Off");
  });

  it("leaves both columns NULL when neither the args nor the proposal object supply a tag", async () => {
    const { getDb, insertProposal } = await import("../src/lib/db");
    const id = `untagged-${randomUUID()}`;
    const { tradeThesisTag: _tag, entryMarketRegime: _regime, ...untaggedProposal } = baseProposal;
    insertProposal({
      id,
      runId: "run-1",
      accountNumber: "UNTAGGED-ACCT",
      proposal: untaggedProposal,
      decision: { approved: true, reasons: [] },
      status: "proposed"
    });

    const row = getDb()
      .prepare("SELECT trade_thesis_tag, entry_market_regime FROM trade_proposals WHERE id = ?")
      .get(id) as RawProposalRow;
    expect(row.trade_thesis_tag).toBeNull();
    expect(row.entry_market_regime).toBeNull();
  });
});

describe("legacy-row backfill", () => {
  it("recovers NULL columns from proposal JSON via the migrate()-style backfill statements", async () => {
    const { getDb } = await import("../src/lib/db");
    const db = getDb();
    const id = `legacy-backfill-${randomUUID()}`;
    // Simulate a pre-fix row: dedicated columns NULL, tags only inside the proposal JSON blob.
    db.prepare(
      "INSERT INTO trade_proposals (id, user_id, run_id, account_number, created_at, proposal, decision, status, trade_thesis_tag, entry_market_regime) VALUES (?, 'local', ?, ?, ?, ?, ?, ?, NULL, NULL)"
    ).run(id, "run-1", "LEGACY-ACCT", new Date().toISOString(), JSON.stringify(baseProposal), JSON.stringify({ approved: true, reasons: [] }), "filled");

    let row = db.prepare("SELECT trade_thesis_tag, entry_market_regime FROM trade_proposals WHERE id = ?").get(id) as RawProposalRow;
    expect(row.trade_thesis_tag).toBeNull();
    expect(row.entry_market_regime).toBeNull();

    // The exact backfill statements added to migrate() in db.ts.
    db.exec(
      "UPDATE trade_proposals SET trade_thesis_tag = json_extract(proposal, '$.tradeThesisTag') WHERE trade_thesis_tag IS NULL AND json_extract(proposal, '$.tradeThesisTag') IS NOT NULL"
    );
    db.exec(
      "UPDATE trade_proposals SET entry_market_regime = json_extract(proposal, '$.entryMarketRegime') WHERE entry_market_regime IS NULL AND json_extract(proposal, '$.entryMarketRegime') IS NOT NULL"
    );

    row = db.prepare("SELECT trade_thesis_tag, entry_market_regime FROM trade_proposals WHERE id = ?").get(id) as RawProposalRow;
    expect(row.trade_thesis_tag).toBe("Momentum-Breakout");
    expect(row.entry_market_regime).toBe("Risk-On");
  });

  it("is idempotent: re-running the backfill against an already-populated column is a no-op", async () => {
    const { getDb, insertProposal } = await import("../src/lib/db");
    const db = getDb();
    const id = `idempotent-${randomUUID()}`;
    insertProposal({
      id,
      runId: "run-1",
      accountNumber: "IDEMPOTENT-ACCT",
      proposal: baseProposal,
      decision: { approved: true, reasons: [] },
      status: "proposed",
      tradeThesisTag: "Explicit-Wins",
      entryMarketRegime: "Explicit-Regime"
    });

    db.exec(
      "UPDATE trade_proposals SET trade_thesis_tag = json_extract(proposal, '$.tradeThesisTag') WHERE trade_thesis_tag IS NULL AND json_extract(proposal, '$.tradeThesisTag') IS NOT NULL"
    );
    db.exec(
      "UPDATE trade_proposals SET entry_market_regime = json_extract(proposal, '$.entryMarketRegime') WHERE entry_market_regime IS NULL AND json_extract(proposal, '$.entryMarketRegime') IS NOT NULL"
    );

    const row = db.prepare("SELECT trade_thesis_tag, entry_market_regime FROM trade_proposals WHERE id = ?").get(id) as RawProposalRow;
    expect(row.trade_thesis_tag).toBe("Explicit-Wins");
    expect(row.entry_market_regime).toBe("Explicit-Regime");
  });
});

describe("getProposal legacy fallback", () => {
  it("returns the tag/regime for a legacy row whose columns are still NULL", async () => {
    const { getDb, getProposal } = await import("../src/lib/db");
    const db = getDb();
    const id = `legacy-getproposal-${randomUUID()}`;
    db.prepare(
      "INSERT INTO trade_proposals (id, user_id, run_id, account_number, created_at, proposal, decision, status, trade_thesis_tag, entry_market_regime) VALUES (?, 'local', ?, ?, ?, ?, ?, ?, NULL, NULL)"
    ).run(id, "run-1", "LEGACY-GETPROPOSAL-ACCT", new Date().toISOString(), JSON.stringify(baseProposal), JSON.stringify({ approved: true, reasons: [] }), "filled");

    const proposal = getProposal(id);
    expect(proposal?.tradeThesisTag).toBe("Momentum-Breakout");
    expect(proposal?.entryMarketRegime).toBe("Risk-On");
  });

  it("getProposalsByIds also falls back to the proposal JSON for legacy NULL-column rows", async () => {
    const { getDb, getProposalsByIds } = await import("../src/lib/db");
    const db = getDb();
    const id = `legacy-batch-${randomUUID()}`;
    db.prepare(
      "INSERT INTO trade_proposals (id, user_id, run_id, account_number, created_at, proposal, decision, status, trade_thesis_tag, entry_market_regime) VALUES (?, 'local', ?, ?, ?, ?, ?, ?, NULL, NULL)"
    ).run(id, "run-1", "LEGACY-BATCH-ACCT", new Date().toISOString(), JSON.stringify(baseProposal), JSON.stringify({ approved: true, reasons: [] }), "filled");

    const result = getProposalsByIds([id]);
    const proposal = result.get(id);
    expect(proposal?.tradeThesisTag).toBe("Momentum-Breakout");
    expect(proposal?.entryMarketRegime).toBe("Risk-On");
  });
});
