import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * The four measurement gaps the 2026-09-25 trading-performance review named as rank 3 of its
 * Improvement Plan ("Grade trades on round trips, add an unattributed row to model attribution,
 * break the funnel out per proposing model, and itemize broker-rejection reasons").
 *
 * Each test pins the specific failure the review reported, so a future change that reintroduces
 * the old behaviour fails here rather than silently flattering a scorecard again.
 */

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `ops-perf-measurement-${randomUUID()}.db`)}`;
});

const daysAgo = (now: number, n: number) => new Date(now - n * 24 * 60 * 60 * 1000).toISOString();

describe("ops performance — round-trip grading (review rank 3, part 1)", () => {
  it("grades a scaled-out position as ONE round trip, not one per exit", async () => {
    const db = await import("../src/lib/db");
    const userId = `rt-user-${randomUUID()}`;
    const accountId = `rt-acct-${randomUUID()}`;
    const accountNumber = `RT-${randomUUID()}`;
    db.upsertConnectedAccount({ id: accountId, userId, broker: "alpaca", environment: "paper", accountNumber, label: "RT", isActive: true });
    db.setPolicy({ ...db.getPolicy(userId, accountId), systemState: "active", strategyAuthority: "decide" }, userId, accountId);

    const now = Date.now();
    const fill = (symbol: string, side: "buy" | "sell", quantity: number, price: number, at: string) =>
      db.insertFillEvent({ accountNumber, source: "paper", symbol, side, quantity, price, notional: quantity * price, status: "filled", userId, filledAt: at });

    // Position A: opened 10, trimmed 2 (+40) then 2 (+40), remainder stopped out (-12). Net +68.
    fill("AAAA", "buy", 10, 100, daysAgo(now, 10));
    fill("AAAA", "sell", 2, 120, daysAgo(now, 6));
    fill("AAAA", "sell", 2, 120, daysAgo(now, 5));
    fill("AAAA", "sell", 6, 98, daysAgo(now, 4));
    // Position B: a single clean exit, -50.
    fill("BBBB", "buy", 10, 100, daysAgo(now, 9));
    fill("BBBB", "sell", 10, 95, daysAgo(now, 3));

    const { buildOpsPerformanceSnapshot } = await import("../src/lib/ops-performance");
    const snapshot = await buildOpsPerformanceSnapshot({ connectedAccountId: accountId, days: 30 });
    const account = snapshot.accounts[0];
    expect(account.error).toBeUndefined();

    // Per-EXIT grading (the pre-existing `tradeStats`) sees four closes and calls it 4 trades.
    expect(account.tradeStats.tradeCount).toBe(4);

    // Round-trip grading sees the two POSITIONS those four exits belonged to.
    expect(account.roundTripStats.tradeCount).toBe(2);
    expect(account.roundTripStats.lotsGraded).toBe(4);
    expect(account.roundTripStats.incompleteRoundTrips).toBe(0);
    // One winner (A: 40 + 40 - 12 = +68) and one loser (B: -50).
    expect(account.roundTripStats.winRate).toBeCloseTo(50, 1);
    expect(account.roundTripStats.expectancyUsd).toBeCloseTo((68 - 50) / 2, 2);
  });

  it("excludes a still-partly-open position and counts it, rather than grading it early", async () => {
    const db = await import("../src/lib/db");
    const userId = `rt-open-user-${randomUUID()}`;
    const accountId = `rt-open-acct-${randomUUID()}`;
    const accountNumber = `RTO-${randomUUID()}`;
    db.upsertConnectedAccount({ id: accountId, userId, broker: "alpaca", environment: "paper", accountNumber, label: "RT Open", isActive: true });
    db.setPolicy({ ...db.getPolicy(userId, accountId), systemState: "active", strategyAuthority: "decide" }, userId, accountId);

    const now = Date.now();
    // Opened 10, only 4 ever sold — 6 shares still open, so the trade is not over.
    db.insertFillEvent({ accountNumber, source: "paper", symbol: "CCCC", side: "buy", quantity: 10, price: 100, notional: 1000, status: "filled", userId, filledAt: daysAgo(now, 8) });
    db.insertFillEvent({ accountNumber, source: "paper", symbol: "CCCC", side: "sell", quantity: 4, price: 120, notional: 480, status: "filled", userId, filledAt: daysAgo(now, 2) });

    const { buildOpsPerformanceSnapshot } = await import("../src/lib/ops-performance");
    const account = (await buildOpsPerformanceSnapshot({ connectedAccountId: accountId, days: 30 })).accounts[0];

    // The per-exit view is happy to grade that +80 trim as a completed win.
    expect(account.tradeStats.tradeCount).toBe(1);
    // Round-trip grading refuses to, and says so instead of dropping it.
    expect(account.roundTripStats.tradeCount).toBe(0);
    expect(account.roundTripStats.incompleteRoundTrips).toBe(1);
    expect(account.roundTripStats.lotsGraded).toBe(0);
  });
});

describe("ops performance — unattributed model bucket (review rank 3, part 2)", () => {
  it("reports unstamped lots as an explicit bucket instead of dropping them", async () => {
    const db = await import("../src/lib/db");
    const userId = `unattr-user-${randomUUID()}`;
    const accountId = `unattr-acct-${randomUUID()}`;
    const accountNumber = `UA-${randomUUID()}`;
    db.upsertConnectedAccount({ id: accountId, userId, broker: "alpaca", environment: "paper", accountNumber, label: "Unattributed", isActive: true });
    db.setPolicy({ ...db.getPolicy(userId, accountId), systemState: "active", strategyAuthority: "decide" }, userId, accountId);

    const now = Date.now();
    // Stamped winner.
    db.insertFillEvent({ accountNumber, source: "paper", symbol: "DDDD", side: "buy", quantity: 1, price: 100, notional: 100, status: "filled", userId, filledAt: daysAgo(now, 5), raw: { proposal: { proposedByModel: "gpt-5.5" } } });
    db.insertFillEvent({ accountNumber, source: "paper", symbol: "DDDD", side: "sell", quantity: 1, price: 120, notional: 120, status: "filled", userId, filledAt: daysAgo(now, 4) });
    // Unstamped winner — the review's finding was that this bucket was collectively the
    // PROFITABLE one, and that dropping it made every model comparison read better than it was.
    db.insertFillEvent({ accountNumber, source: "paper", symbol: "EEEE", side: "buy", quantity: 1, price: 100, notional: 100, status: "filled", userId, filledAt: daysAgo(now, 5) });
    db.insertFillEvent({ accountNumber, source: "paper", symbol: "EEEE", side: "sell", quantity: 1, price: 130, notional: 130, status: "filled", userId, filledAt: daysAgo(now, 3) });

    const { buildOpsPerformanceSnapshot } = await import("../src/lib/ops-performance");
    const account = (await buildOpsPerformanceSnapshot({ connectedAccountId: accountId, days: 30 })).accounts[0];

    const unstamped = account.modelAttribution.find((m) => m.model === "unattributed");
    expect(unstamped).toBeDefined();
    expect(unstamped!.trades).toBe(1);
    expect(unstamped!.totalPnlUsd).toBeCloseTo(30, 2);

    // And the stamped model is still its own row — the bucket is additive, not a replacement.
    const stamped = account.modelAttribution.find((m) => m.model !== "unattributed");
    expect(stamped).toBeDefined();
    expect(stamped!.totalPnlUsd).toBeCloseTo(20, 2);
    // Every closed lot is now attributed to exactly one row.
    const totalTrades = account.modelAttribution.reduce((s, m) => s + m.trades, 0);
    expect(totalTrades).toBe(2);
  });
});

describe("ops performance — funnel by proposing model (review rank 3, part 3)", () => {
  it("breaks status counts out per model and still agrees with the global totals", async () => {
    const db = await import("../src/lib/db");
    const userId = `funnel-user-${randomUUID()}`;
    const accountId = `funnel-acct-${randomUUID()}`;
    const accountNumber = `FN-${randomUUID()}`;
    db.upsertConnectedAccount({ id: accountId, userId, broker: "alpaca", environment: "paper", accountNumber, label: "Funnel", isActive: true });
    db.setPolicy({ ...db.getPolicy(userId, accountId), systemState: "active", strategyAuthority: "decide" }, userId, accountId);

    const insert = (model: string | undefined, status: string) =>
      db.insertProposal({
        id: randomUUID(),
        userId,
        runId: randomUUID(),
        accountNumber,
        proposal: {
          symbol: "FFFF",
          side: "buy",
          type: "market",
          dollarAmount: 100,
          timeInForce: "gfd",
          marketHours: "regular_hours",
          rationale: "test",
          ...(model ? { proposedByModel: model } : {})
        },
        decision: { approved: true, reasons: [] },
        status
      });

    insert("gpt-5.5", "placed");
    insert("gpt-5.5", "placed");
    insert("gpt-5.5", "blocked");
    insert("grok-build-0.1", "placed");
    insert("grok-build-0.1", "rejected_by_broker");
    insert(undefined, "placed"); // no stamp -> unattributed

    const { buildOpsPerformanceSnapshot } = await import("../src/lib/ops-performance");
    const account = (await buildOpsPerformanceSnapshot({ connectedAccountId: accountId, days: 30 })).accounts[0];
    const funnel = account.proposalFunnel;

    const placed = funnel.counts.find((c) => c.status === "placed")?.count;
    expect(placed).toBe(4);

    const byModel = new Map(funnel.byModel.map((m) => [m.model, m.counts]));
    expect(byModel.get("gpt-5.5")?.find((c) => c.status === "placed")?.count).toBe(2);
    expect(byModel.get("gpt-5.5")?.find((c) => c.status === "blocked")?.count).toBe(1);
    expect(byModel.get("grok-build-0.1")?.find((c) => c.status === "rejected_by_broker")?.count).toBe(1);
    // An unstamped proposal is visible, not dropped.
    expect(byModel.get("unattributed")?.find((c) => c.status === "placed")?.count).toBe(1);

    // The per-model breakdown must sum EXACTLY to the global counts — they come from one scan.
    const summed = new Map<string, number>();
    for (const m of funnel.byModel) for (const c of m.counts) summed.set(c.status, (summed.get(c.status) ?? 0) + c.count);
    expect(summed.get("placed")).toBe(4);
    expect(summed.get("blocked")).toBe(1);
    expect(summed.get("rejected_by_broker")).toBe(1);
  });
});

describe("ops performance — broker rejection reasons (review rank 3, part 4)", () => {
  it("itemises broker rejections and merges the same refusal across HTTP status codes", async () => {
    const db = await import("../src/lib/db");
    const userId = `rej-user-${randomUUID()}`;
    const accountId = `rej-acct-${randomUUID()}`;
    const accountNumber = `RJ-${randomUUID()}`;
    db.upsertConnectedAccount({ id: accountId, userId, broker: "alpaca", environment: "paper", accountNumber, label: "Rejections", isActive: true });
    db.setPolicy({ ...db.getPolicy(userId, accountId), systemState: "active", strategyAuthority: "decide" }, userId, accountId);

    const proposalId = randomUUID();
    db.insertProposal({
      id: proposalId,
      userId,
      runId: randomUUID(),
      accountNumber,
      proposal: { symbol: "GGGG", side: "buy", type: "market", dollarAmount: 100, timeInForce: "gfd", marketHours: "regular_hours", rationale: "test" },
      decision: { approved: true, reasons: [] },
      status: "rejected_by_broker"
    });

    // The same underlying refusal arriving with two different transport status codes — the review
    // counted these as separate unexplained rows.
    db.audit("order_rejected_by_broker", { proposalId, symbol: "GGGG", side: "buy", reason: "HTTP 422: bracket orders must be entry orders" }, userId, accountId);
    db.audit("order_rejected_by_broker", { proposalId, symbol: "GGGG", side: "buy", reason: "HTTP 400: bracket orders must be entry orders" }, userId, accountId);
    // A genuinely different cause must stay its own bucket.
    db.audit("order_rejected_by_broker", { proposalId, symbol: "GGGG", side: "buy", reason: "HTTP 422: market orders require no stop or limit price" }, userId, accountId);

    const { buildOpsPerformanceSnapshot } = await import("../src/lib/ops-performance");
    const funnel = (await buildOpsPerformanceSnapshot({ connectedAccountId: accountId, days: 30 })).accounts[0].proposalFunnel;

    expect(funnel.brokerRejectionReasons[0]).toEqual({ reason: "bracket orders must be entry orders", count: 2 });
    expect(funnel.brokerRejectionReasons.map((r) => r.reason)).toContain("market orders require no stop or limit price");
  });

  it("falls back to the broker's own state when no reason string was recorded", async () => {
    const db = await import("../src/lib/db");
    const userId = `rej2-user-${randomUUID()}`;
    const accountId = `rej2-acct-${randomUUID()}`;
    const accountNumber = `RJ2-${randomUUID()}`;
    db.upsertConnectedAccount({ id: accountId, userId, broker: "alpaca", environment: "paper", accountNumber, label: "Rejections 2", isActive: true });
    db.setPolicy({ ...db.getPolicy(userId, accountId), systemState: "active", strategyAuthority: "decide" }, userId, accountId);

    const proposalId = randomUUID();
    db.insertProposal({
      id: proposalId,
      userId,
      runId: randomUUID(),
      accountNumber,
      proposal: { symbol: "HHHH", side: "buy", type: "market", dollarAmount: 100, timeInForce: "gfd", marketHours: "regular_hours", rationale: "test" },
      decision: { approved: true, reasons: [] },
      status: "rejected_by_broker"
    });
    // The reconcile path (strategy-execution.ts) records no `reason`, only the broker's state.
    db.audit("order_rejected_by_broker", { proposalId, symbol: "HHHH", side: "buy", orderId: "o1", brokerState: "canceled" }, userId, accountId);

    const { buildOpsPerformanceSnapshot } = await import("../src/lib/ops-performance");
    const funnel = (await buildOpsPerformanceSnapshot({ connectedAccountId: accountId, days: 30 })).accounts[0].proposalFunnel;
    expect(funnel.brokerRejectionReasons).toEqual([{ reason: "broker state: canceled", count: 1 }]);
  });
});
