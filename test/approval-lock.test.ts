/**
 * Regression tests for the TOCTOU run-lock on executeProposal.
 *
 * Bug: the daily/hourly notional cap check reads trade_proposals BEFORE
 * inserting the new row. Without mutual exclusion, a concurrent autonomous
 * run (which holds acquireStrategyLock) and a manual Approve can each read
 * the same pre-cap totals and both place — jointly exceeding the caps.
 *
 * Fix: executeProposal now acquires acquireStrategyLock(userId) before the
 * broker-review + cap-read + placement sequence, and releases it in a
 * try/finally so every return path frees the lock.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import {
  acquireStrategyLock,
  getProposal,
  insertProposal,
  releaseStrategyLock,
  setActiveConnectedAccount,
  setPolicy,
  upsertConnectedAccount
} from "../src/lib/db";
import { executeProposal } from "../src/lib/strategy";

vi.mock("../src/lib/vector-db", () => ({
  findRelevantExperiences: async () => [],
  upsertExperiences: async () => {},
  retrieveContext: async () => [],
  storeContext: async () => {},
  storeContexts: async () => {}
}));

// Same rationale as test/order-confirmation-status.test.ts: executeProposal's market scan is
// incidental here (this file verifies the run-lock), but unmocked it makes REAL Nasdaq/Yahoo
// fetches — the root cause of this file's recurring full-suite timeout flake (the 2026-06-21
// "fix" only padded the timeouts). Stub scanMarket; keep every other market.ts export real.
vi.mock("../src/lib/market", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/market")>();
  return {
    ...actual,
    scanMarket: async (): Promise<import("../src/lib/types").MarketScan> => {
      const asOf = new Date().toISOString();
      const aapl: import("../src/lib/types").MarketQuote = {
        symbol: "AAPL",
        price: 200,
        bid: 199,
        ask: 200,
        volume: 1_000_000,
        intradayChangePct: 0,
        positionMarketValue: 0,
        score: 1,
        provider: "test-scan",
        asOf
      };
      return {
        source: "test-scan",
        generatedAt: asOf,
        scannedSymbols: 1,
        returnedQuotes: 1,
        topCandidates: [aapl],
        sectorBySymbol: {},
        quotesBySymbol: { AAPL: aapl },
        warnings: []
      };
    }
  };
});

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-approval-lock-${randomUUID()}.db`)}`;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ACCOUNT = "ACC-LOCK-TEST";

function makeProposalId(userId: string): string {
  const proposalId = randomUUID();
  insertProposal({
    id: proposalId,
    runId: randomUUID(),
    accountNumber: ACCOUNT,
    userId,
    proposal: {
      symbol: "AAPL",
      side: "buy",
      type: "market",
      dollarAmount: 500,
      timeInForce: "gfd",
      marketHours: "regular_hours",
      rationale: "lock test",
      tradeThesisTag: "Momentum-Breakout",
      entryMarketRegime: "Neutral (Normal Volatility)"
    },
    decision: { approved: true, reasons: [] },
    status: "proposed"
  });
  return proposalId;
}

// An account is an account: executeProposal now refuses to run without a connected broker
// account (no local-simulation fallback), so every test needs a real connected TEST-BROKER
// account (test infrastructure — TestBrokerGateway) wired up before calling it. Returns the
// connected account's id so callers can scope acquireStrategyLock/releaseStrategyLock the same
// way executeProposal does internally (via policy.connectedAccountId).
function setPaperPolicy(userId: string): string {
  const accountId = randomUUID();
  upsertConnectedAccount({
    id: accountId,
    userId,
    broker: "test",
    environment: "paper",
    accountNumber: ACCOUNT,
    label: "Lock Test Account",
    isActive: true
  });
  setActiveConnectedAccount(accountId, userId);
  setPolicy(
    { ...DEFAULT_POLICY, accountNumber: ACCOUNT, systemState: "active" },
    userId
  );
  return accountId;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("executeProposal run-lock (TOCTOU guard)", () => {
  it("returns { status: 'busy' } immediately when the strategy run lock is held", async () => {
    const userId = `lock-busy-${randomUUID()}`;
    const accountId = setPaperPolicy(userId);
    const proposalId = makeProposalId(userId);

    // Simulate an autonomous run holding the lock. executeProposal acquires it scoped to
    // policy.connectedAccountId internally, so the outer simulated hold must match that scope.
    expect(acquireStrategyLock(userId, accountId)).toBe(true);

    try {
      const result = await executeProposal(proposalId, userId);
      expect(result.status).toBe("busy");
      expect(result.reasons).toBeDefined();
      expect(result.reasons![0]).toMatch(/strategy run is in progress/i);
    } finally {
      releaseStrategyLock(userId, accountId);
    }
  });

  it("leaves the proposal status as 'proposed' (no placement) when busy", async () => {
    const userId = `lock-noplacement-${randomUUID()}`;
    const accountId = setPaperPolicy(userId);
    const proposalId = makeProposalId(userId);

    expect(acquireStrategyLock(userId, accountId)).toBe(true);
    try {
      await executeProposal(proposalId, userId);
    } finally {
      releaseStrategyLock(userId, accountId);
    }

    // The proposal must still be 'proposed' — nothing was placed or mutated.
    const row = getProposal(proposalId, userId);
    expect(row?.status).toBe("proposed");
  });

  it("releases the lock after executeProposal runs (lock is free for the next caller)", async () => {
    const userId = `lock-release-${randomUUID()}`;
    const accountId = setPaperPolicy(userId);
    const proposalId = makeProposalId(userId);

    // Let executeProposal run to completion (or throw — doesn't matter).
    // The critical assertion is that the lock is released on any exit path.
    try {
      await executeProposal(proposalId, userId);
    } catch {
      // Best-effort: the connected account is a real (test-broker) gateway now, but market-scan
      // or broker-review data may still cause a throw in this minimal test setup. We only care
      // about lock release either way.
    }

    // After the function exits, the lock must be free for the next caller.
    expect(acquireStrategyLock(userId, accountId)).toBe(true);
    releaseStrategyLock(userId, accountId);
  }, 20000); // executeProposal may exhaust broker-review retries — allow margin over the 5s default

  it("does not interfere with a different user's lock", async () => {
    const userA = `lock-usera-${randomUUID()}`;
    const userB = `lock-userb-${randomUUID()}`;
    setPaperPolicy(userA);
    const accountIdB = setPaperPolicy(userB);

    const proposalA = makeProposalId(userA);

    // userB holds their own lock — should NOT block userA's executeProposal.
    expect(acquireStrategyLock(userB, accountIdB)).toBe(true);

    let resultA: Awaited<ReturnType<typeof executeProposal>> | undefined;
    try {
      resultA = await executeProposal(proposalA, userA);
    } catch {
      // userA may throw for unrelated reasons, but must NOT return "busy".
    } finally {
      releaseStrategyLock(userB, accountIdB);
    }

    // If we got a result, it must not be "busy" — userB's lock does not block userA.
    if (resultA !== undefined) {
      expect(resultA.status).not.toBe("busy");
    }
  }, 20000); // executeProposal exhausts broker-review retries with no broker — allow margin over the 5s default
});
