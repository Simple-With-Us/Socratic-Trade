import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// Item 2 (Chat A): trade_proposals carries a nullable prompt_version stamped with STRATEGY_PROMPT_VERSION.

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-promptver-${randomUUID()}.db`)}`;
});

const proposalBody = (symbol: string, tag: string) => ({
  symbol,
  side: "buy" as const,
  type: "market" as const,
  timeInForce: "gfd" as const,
  marketHours: "regular_hours" as const,
  referencePrice: 100,
  rationale: "t",
  tradeThesisTag: tag,
  entryMarketRegime: "Neutral (Normal Volatility)"
});

describe("trade_proposals.prompt_version (Chat A item 2)", () => {
  it("insertProposal persists a non-null prompt_version equal to STRATEGY_PROMPT_VERSION", async () => {
    const { insertProposal, getDb } = await import("../src/lib/db");
    const { STRATEGY_PROMPT_VERSION } = await import("../src/lib/strategy-prompts");
    const id = randomUUID();
    insertProposal({
      id,
      runId: "run-pv",
      accountNumber: "PV",
      proposal: proposalBody("AAPL", "Momentum-Breakout"),
      decision: { approved: true, reasons: [] },
      status: "proposed",
      promptVersion: STRATEGY_PROMPT_VERSION
    });
    const row = getDb().prepare("SELECT prompt_version FROM trade_proposals WHERE id = ?").get(id) as { prompt_version: string | null };
    expect(row.prompt_version).toBe(STRATEGY_PROMPT_VERSION);
    expect(row.prompt_version).toBeTruthy();
  });

  it("omitting promptVersion stores NULL (the column is nullable — legacy rows stay null)", async () => {
    const { insertProposal, getDb } = await import("../src/lib/db");
    const id = randomUUID();
    insertProposal({
      id,
      runId: "run-pv2",
      accountNumber: "PV",
      proposal: proposalBody("MSFT", "Value-Quality"),
      decision: { approved: true, reasons: [] },
      status: "proposed"
    });
    const row = getDb().prepare("SELECT prompt_version FROM trade_proposals WHERE id = ?").get(id) as { prompt_version: string | null };
    expect(row.prompt_version).toBeNull();
  });
});
