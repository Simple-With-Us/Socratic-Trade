import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { OHLCBar } from "../src/lib/indicators";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-oe-due-jobs-${randomUUID()}.db`)}`;
});

// Capture vector-memory re-index calls without Pinecone/Voyage credentials.
vi.mock("../src/lib/vector-db", () => ({
  managedVectorLedgerAuthority: vi.fn(),
  getCurrentVectorProviderAuthority: vi.fn(),
  storeContexts: async (documents: Array<{ text: string }>) => ({ attempted: documents.length, indexed: documents.length })
}));

function makeFetchOHLC(bySymbol: Record<string, OHLCBar[] | null>) {
  return async (symbol: string): Promise<OHLCBar[] | null> => bySymbol[symbol] ?? null;
}

describe("durable due-jobs: intraday horizon sampling", () => {
  it("enqueues 15m/1h due-jobs with correct dedupe keys when a PLACED decision's fill basis is established", async () => {
    const userId = `oe-dj-placed-${randomUUID()}`;
    const { insertFillEvent, upsertSocraticDecisionCase, getDb } = await import("../src/lib/db");
    const { matureSocraticDecisionOutcomes } = await import("../src/lib/outcome-engine");

    upsertSocraticDecisionCase({
      id: "prop-1",
      userId,
      runId: "run-1",
      proposalId: "prop-1",
      accountNumber: "acct",
      symbol: "AAPL",
      side: "buy",
      status: "placed",
      authority: "decide",
      thesis: "Momentum",
      rationale: "Breakout with volume.",
      action: "BUY AAPL $1000",
      thesisTag: "Momentum",
      regime: "Risk-On"
    });
    insertFillEvent({
      userId,
      proposalId: "prop-1",
      runId: "run-1",
      accountNumber: "acct",
      source: "paper",
      symbol: "AAPL",
      side: "buy",
      quantity: 10,
      price: 100,
      notional: 1000,
      status: "filled",
      filledAt: "2026-06-10T14:30:00.000Z"
    });

    const now = Date.parse("2026-06-10T15:00:00.000Z"); // 30m after fill — before either horizon is due
    await matureSocraticDecisionOutcomes(userId, {
      now,
      fetchOHLC: makeFetchOHLC({}),
      fetchQuote: async () => undefined
    });

    const rows = getDb()
      .prepare("SELECT job_type, dedupe_key, due_at, not_after, payload FROM due_jobs WHERE job_type = 'sample_intraday_horizon' ORDER BY due_at ASC")
      .all() as Array<{ job_type: string; dedupe_key: string; due_at: string; not_after: string; payload: string }>;

    expect(rows).toHaveLength(2);
    expect(rows[0].dedupe_key).toBe("decision:prop-1:15m");
    expect(rows[1].dedupe_key).toBe("decision:prop-1:1h");
    expect(rows[0].due_at).toBe("2026-06-10T14:45:00.000Z"); // fill + 15m
    expect(rows[1].due_at).toBe("2026-06-10T15:30:00.000Z"); // fill + 1h
    const payload0 = JSON.parse(rows[0].payload);
    expect(payload0).toMatchObject({ caseKind: "decision", caseId: "prop-1", symbol: "AAPL", horizon: "15m", basisPrice: 100, side: "buy" });

    // Re-measuring (still not due) must not create duplicate rows — dedupe holds.
    await matureSocraticDecisionOutcomes(userId, {
      now: now + 60_000,
      fetchOHLC: makeFetchOHLC({}),
      fetchQuote: async () => undefined
    });
    const countAfter = getDb().prepare("SELECT COUNT(*) AS n FROM due_jobs WHERE job_type = 'sample_intraday_horizon'").get() as { n: number };
    expect(countAfter.n).toBe(2);
  });

  it("enqueues due-jobs for a skipped-candidate counterfactual at insert time (basis known immediately)", async () => {
    const userId = `oe-dj-cf-${randomUUID()}`;
    const { recordRejectedProposalCounterfactual } = await import("../src/lib/counterfactual-learning");
    const { getDb, skippedCounterfactualId } = await import("../src/lib/db");

    const inserted = recordRejectedProposalCounterfactual({
      userId,
      runId: "run-cf-1",
      symbol: "MSFT",
      refPrice: 300,
      createdAt: "2026-06-20T15:00:00.000Z"
    });
    expect(inserted).toBe(true);

    const caseId = skippedCounterfactualId(userId, "run-cf-1", "MSFT", 5);
    const rows = getDb()
      .prepare("SELECT dedupe_key, payload FROM due_jobs WHERE job_type = 'sample_intraday_horizon' AND user_id = ? ORDER BY due_at ASC")
      .all(userId) as Array<{ dedupe_key: string; payload: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].dedupe_key).toBe(`counterfactual:${caseId}:15m`);
    expect(rows[1].dedupe_key).toBe(`counterfactual:${caseId}:1h`);
    const payload = JSON.parse(rows[0].payload);
    expect(payload).toMatchObject({ caseKind: "counterfactual", caseId, symbol: "MSFT", basisPrice: 300 });
  });

  it("drainDueIntradaySampleJobs samples a mocked quote and writes the same SocraticOutcomeHorizonRow shape the inline path writes", async () => {
    const userId = `oe-dj-drain-${randomUUID()}`;
    const { insertFillEvent, upsertSocraticDecisionCase, getSocraticDecisionCase } = await import("../src/lib/db");
    const { matureSocraticDecisionOutcomes, drainDueIntradaySampleJobs } = await import("../src/lib/outcome-engine");

    upsertSocraticDecisionCase({
      id: "prop-drain",
      userId,
      runId: "run-drain",
      proposalId: "prop-drain",
      accountNumber: "acct",
      symbol: "AAPL",
      side: "buy",
      status: "placed",
      authority: "decide",
      thesis: "Momentum",
      rationale: "Breakout with volume.",
      action: "BUY AAPL $1000",
      thesisTag: "Momentum",
      regime: "Risk-On"
    });
    insertFillEvent({
      userId,
      proposalId: "prop-drain",
      runId: "run-drain",
      accountNumber: "acct",
      source: "paper",
      symbol: "AAPL",
      side: "buy",
      quantity: 10,
      price: 100,
      notional: 1000,
      status: "filled",
      filledAt: "2027-01-11T14:30:00.000Z"
    });

    const fillMs = Date.parse("2027-01-11T14:30:00.000Z");
    // Establish the basis + enqueue the due-jobs (worker path only from here on — inline path
    // stays cold since fetchQuote returns undefined and the window isn't sampled inline here).
    await matureSocraticDecisionOutcomes(userId, {
      now: fillMs + 60_000,
      fetchOHLC: makeFetchOHLC({}),
      fetchQuote: async () => undefined
    });

    // Drain at fill+16m: the 15m job is due; sample a mocked quote of 103. drainDueIntradaySampleJobs
    // claims globally by job_type (exactly like the real scheduler's fire-and-forget drain call), so
    // other tests' still-pending due-jobs may also be drained in the same pass — assert on THIS
    // case's own row rather than the aggregate counts, which are not test-isolated by construction.
    const drainNow = fillMs + 16 * 60_000;
    const result = await drainDueIntradaySampleJobs(drainNow, { fetchQuote: async () => 103 });
    expect(result.drained).toBeGreaterThanOrEqual(1);
    expect(result.erroredRetried).toBe(0);

    const updated = getSocraticDecisionCase("prop-drain", userId);
    const row15m = updated?.outcome?.outcomes.find((r) => r.horizon === "15m");
    expect(row15m?.resolution).toBe("ok");
    expect(row15m?.returnPct).toBe(3); // (103-100)/100 * 100
    expect(row15m?.priceBasis).toContain("fill->live_quote");
  });

  it("a job whose lease expired before completion is retried (reclaimed) by a later drain pass", async () => {
    const userId = `oe-dj-lease-${randomUUID()}`;
    const { insertFillEvent, upsertSocraticDecisionCase, getDb } = await import("../src/lib/db");
    const { matureSocraticDecisionOutcomes, drainDueIntradaySampleJobs } = await import("../src/lib/outcome-engine");

    upsertSocraticDecisionCase({
      id: "prop-lease",
      userId,
      runId: "run-lease",
      proposalId: "prop-lease",
      accountNumber: "acct",
      symbol: "AAPL",
      side: "buy",
      status: "placed",
      authority: "decide",
      thesis: "Momentum",
      rationale: "Breakout with volume.",
      action: "BUY AAPL $1000",
      thesisTag: "Momentum",
      regime: "Risk-On"
    });
    insertFillEvent({
      userId,
      proposalId: "prop-lease",
      runId: "run-lease",
      accountNumber: "acct",
      source: "paper",
      symbol: "AAPL",
      side: "buy",
      quantity: 10,
      price: 100,
      notional: 1000,
      status: "filled",
      filledAt: "2026-06-10T14:30:00.000Z"
    });

    const fillMs = Date.parse("2026-06-10T14:30:00.000Z");
    await matureSocraticDecisionOutcomes(userId, {
      now: fillMs + 60_000,
      fetchOHLC: makeFetchOHLC({}),
      fetchQuote: async () => undefined
    });

    // Manually claim the 15m job with a short lease to simulate a worker that grabbed it and crashed
    // (a real drain call would complete it; we bypass that by claiming directly at the DB layer).
    const { claimDueJobs } = await import("../src/lib/db");
    const claimed = claimDueJobs("sample_intraday_horizon", { claimant: "crashed-worker", leaseMs: 1000, now: new Date(fillMs + 16 * 60_000) });
    expect(claimed.length).toBeGreaterThanOrEqual(1);
    const claimedRow = getDb().prepare("SELECT status FROM due_jobs WHERE id = ?").get(claimed[0].id) as { status: string };
    expect(claimedRow.status).toBe("claimed");

    // Drain again well after the short lease expired — should reclaim + complete it.
    const result = await drainDueIntradaySampleJobs(fillMs + 20 * 60_000, { fetchQuote: async () => 105 });
    expect(result.drained).toBeGreaterThanOrEqual(1);
    const done = getDb().prepare("SELECT status FROM due_jobs WHERE id = ?").get(claimed[0].id) as { status: string };
    expect(done.status).toBe("done");
  });

  it("no double horizon row when both the inline samplableNow path and the worker fire for the same case", async () => {
    const userId = `oe-dj-nodup-${randomUUID()}`;
    const { insertFillEvent, upsertSocraticDecisionCase, getSocraticDecisionCase } = await import("../src/lib/db");
    const { matureSocraticDecisionOutcomes, drainDueIntradaySampleJobs } = await import("../src/lib/outcome-engine");

    upsertSocraticDecisionCase({
      id: "prop-nodup",
      userId,
      runId: "run-nodup",
      proposalId: "prop-nodup",
      accountNumber: "acct",
      symbol: "AAPL",
      side: "buy",
      status: "placed",
      authority: "decide",
      thesis: "Momentum",
      rationale: "Breakout with volume.",
      action: "BUY AAPL $1000",
      thesisTag: "Momentum",
      regime: "Risk-On"
    });
    insertFillEvent({
      userId,
      proposalId: "prop-nodup",
      runId: "run-nodup",
      accountNumber: "acct",
      source: "paper",
      symbol: "AAPL",
      side: "buy",
      quantity: 10,
      price: 100,
      notional: 1000,
      status: "filled",
      filledAt: "2026-06-10T14:30:00.000Z"
    });

    const fillMs = Date.parse("2026-06-10T14:30:00.000Z");
    // The INLINE path samples the 15m horizon successfully at fill+16m (samplableNow window open).
    await matureSocraticDecisionOutcomes(userId, {
      now: fillMs + 16 * 60_000,
      fetchOHLC: makeFetchOHLC({}),
      fetchQuote: async () => 110
    });
    const afterInline = getSocraticDecisionCase("prop-nodup", userId);
    const inlineRow = afterInline?.outcome?.outcomes.find((r) => r.horizon === "15m");
    expect(inlineRow?.resolution).toBe("ok");
    expect(inlineRow?.returnPct).toBe(10);

    // The WORKER now drains the same due-job (enqueued when the basis was first established) with a
    // DIFFERENT mocked quote. It must see the inline row already resolved and skip it — never
    // overwrite with a conflicting return.
    const result = await drainDueIntradaySampleJobs(fillMs + 17 * 60_000, { fetchQuote: async () => 999 });
    expect(result.completed + result.unresolvable).toBeGreaterThanOrEqual(1);

    const afterDrain = getSocraticDecisionCase("prop-nodup", userId);
    const rows15m = afterDrain?.outcome?.outcomes.filter((r) => r.horizon === "15m") ?? [];
    expect(rows15m).toHaveLength(1); // exactly one row for this horizon — no duplicate
    expect(rows15m[0].returnPct).toBe(10); // the inline path's value wins, untouched by the worker
  });
});
