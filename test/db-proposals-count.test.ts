import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { TradeProposal } from "../src/lib/types";

/** countPendingProposals — a cheap COUNT-only sibling to listPendingProposals, added so
 *  Settings > Broker connections can show a real per-account pending-proposal count for
 *  every connected account, not just the active one (per-account-visibility, lifecycle-12:
 *  brokers.tsx used to filter snapshot.pendingProposals, an array the server already scopes
 *  to the active account only, so the "Other Accounts" filter could never find a match). */

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-proposals-count-${randomUUID()}.db`)}`;
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
  entryMarketRegime: "Neutral"
};

async function seedPending(accountNumber: string, id: string) {
  const { insertProposal } = await import("../src/lib/db");
  insertProposal({
    id,
    runId: "run-1",
    accountNumber,
    proposal: baseProposal,
    decision: { approved: true, reasons: [] },
    status: "proposed"
  });
}

describe("countPendingProposals", () => {
  it("counts only the given account's proposed proposals, not another account's", async () => {
    const { countPendingProposals } = await import("../src/lib/db");
    const accountA = `ACCT-A-${randomUUID()}`;
    const accountB = `ACCT-B-${randomUUID()}`;

    await seedPending(accountA, `${accountA}-1`);
    await seedPending(accountA, `${accountA}-2`);

    expect(countPendingProposals(accountA, "local")).toBe(2);
    expect(countPendingProposals(accountB, "local")).toBe(0);
  });

  it("does not count a proposal once it leaves the proposed status", async () => {
    const { countPendingProposals, updateProposalStatus } = await import("../src/lib/db");
    const account = `ACCT-STATUS-${randomUUID()}`;
    await seedPending(account, `${account}-1`);
    expect(countPendingProposals(account, "local")).toBe(1);

    updateProposalStatus(`${account}-1`, "placed", undefined, undefined, undefined, "local");
    expect(countPendingProposals(account, "local")).toBe(0);
  });
});
