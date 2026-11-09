import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-account-scope-${randomUUID()}.db`)}`;
});

describe("account scoping (T14)", () => {
  it("scopes a missing/blank account number to a consistent bucket, isolated from named accounts", async () => {
    const { insertProposal, dailyExecutionStats, notionalInLastMinutes } = await import("../src/lib/db");
    const user = `t14-${randomUUID()}`;
    insertProposal({ id: randomUUID(), runId: "r", accountNumber: "", proposal: { side: "buy", dollarAmount: 10 }, decision: {}, status: "placed", estimatedNotional: 10, userId: user });
    insertProposal({ id: randomUUID(), runId: "r", accountNumber: "ACCT-X", proposal: { side: "buy", dollarAmount: 99 }, decision: {}, status: "placed", estimatedNotional: 99, userId: user });

    // The unassigned (empty) scope sees only its own proposal, never the named account.
    const unassigned = dailyExecutionStats("", new Date(), user);
    expect(unassigned.orderCount).toBe(1);
    expect(unassigned.notional).toBe(10);
    // A blank/whitespace read normalizes to the SAME bucket as the empty write (this is the fix —
    // without consistent scoping, "   " would query a different account_number and find nothing).
    expect(dailyExecutionStats("   ", new Date(), user).notional).toBe(10);
    // A named account is fully isolated.
    const acctX = dailyExecutionStats("ACCT-X", new Date(), user);
    expect(acctX.orderCount).toBe(1);
    expect(acctX.notional).toBe(99);
    // The rolling hourly window mirrors the same scoping.
    expect(notionalInLastMinutes("", 60, new Date(), user).notional).toBe(10);
  });

  it("can read the latest strategy-run audit for one connected account without cross-account bleed", async () => {
    const { audit, latestAuditByKind } = await import("../src/lib/db");
    const user = `audit-scope-${randomUUID()}`;
    const accountA = randomUUID();
    const accountB = randomUUID();

    audit("strategy_run", { runId: "run-a", status: "failed", summary: "Account Mismatch", accountNumber: "A" }, user, accountA);
    audit("strategy_run", { runId: "run-b", status: "completed", summary: "ok", accountNumber: "B" }, user, accountB);

    expect((latestAuditByKind("strategy_run", user, accountA)?.payload as { runId?: string }).runId).toBe("run-a");
    expect((latestAuditByKind("strategy_run", user, accountB)?.payload as { runId?: string }).runId).toBe("run-b");
  });
});
