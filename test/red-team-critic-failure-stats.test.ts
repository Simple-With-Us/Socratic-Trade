// #2552: aggregate critic-health stat — failed adversarial reviews / attempted reviews over a
// trailing window, derived from persisted proposals' redTeamVerdict fields. 4-of-5 failures in
// one batch is a model/config problem nobody sees per-card; this is the ownable aggregate.

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-critic-failure-${randomUUID()}.db`)}`;
});

function proposalWith(verdict?: Record<string, unknown>) {
  return {
    symbol: "T",
    side: "buy",
    type: "market",
    timeInForce: "gfd",
    marketHours: "regular_hours",
    rationale: "test",
    tradeThesisTag: "test",
    entryMarketRegime: "test",
    referencePrice: 20,
    ...(verdict ? { redTeamVerdict: verdict } : {})
  };
}

describe("getRedTeamCriticFailureStats", () => {
  it("counts failures over attempted reviews, attributes the top failure, and excludes review-less/old/foreign rows", async () => {
    const { insertProposal, getRedTeamCriticFailureStats, getDb } = await import("../src/lib/db");
    const userId = `u-${randomUUID()}`;
    const insert = (id: string, verdict?: Record<string, unknown>) =>
      insertProposal({
        userId,
        id,
        runId: `run-${id}`,
        accountNumber: "A1",
        proposal: proposalWith(verdict),
        decision: { approved: true, reasons: [] },
        status: "proposed"
      });

    insert("ok-1", { available: true, rejected: false, verdict: "approve", reason: "fine", model: "openai/gpt-5.2" });
    insert("fail-1", { available: false, rejected: false, reason: "malformed", failureKind: "malformed_response", model: "deepseek-chat" });
    insert("fail-2", { available: false, rejected: false, reason: "malformed", failureKind: "malformed_response", model: "deepseek-chat" });
    insert("fail-3", { available: false, rejected: false, reason: "timeout", failureKind: "timeout" });
    insert("no-review"); // below every trigger — NOT part of the denominator
    // A failure outside the window must not count: backdate it 40 days.
    insert("fail-old", { available: false, rejected: false, reason: "old", failureKind: "provider_error" });
    getDb()
      .prepare("UPDATE trade_proposals SET created_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 40 * 24 * 3600_000).toISOString(), "fail-old");
    // Another user's failure never leaks in.
    insertProposal({
      userId: `other-${randomUUID()}`,
      id: "foreign-fail",
      runId: "run-foreign",
      accountNumber: "A1",
      proposal: proposalWith({ available: false, rejected: false, reason: "x", failureKind: "timeout" }),
      decision: { approved: true, reasons: [] },
      status: "proposed"
    });

    const stats = getRedTeamCriticFailureStats(userId);
    expect(stats.windowDays).toBe(30);
    expect(stats.reviews).toBe(4); // ok-1 + fail-1..3; no-review and fail-old excluded
    expect(stats.failures).toBe(3);
    expect(stats.failureRatePct).toBe(75);
    expect(stats.byKind).toEqual({ malformed_response: 2, timeout: 1 });
    expect(stats.topFailure).toEqual({ model: "deepseek-flash-latest", kind: "malformed_response", count: 2 });
  });

  it("returns a zero-rate result when no reviews were attempted", async () => {
    const { getRedTeamCriticFailureStats } = await import("../src/lib/db");
    const stats = getRedTeamCriticFailureStats(`empty-${randomUUID()}`);
    expect(stats.reviews).toBe(0);
    expect(stats.failures).toBe(0);
    expect(stats.failureRatePct).toBe(0);
    expect(stats.topFailure).toBeUndefined();
  });
});
