/**
 * §7 slice 3 PR-2 — the AUTONOMOUS strategy-loop money-path window (runStrategyOnce) actually
 * contends on the per-account broker-mutation lease. Sibling to test/account-mutation-pr2.test.ts
 * (which covers only the APPROVAL lane, executeProposal) — kept in its own file because this
 * fixture needs its own mocks (../src/lib/broker routed unconditionally to the deterministic
 * TestBrokerGateway, plus a stubbed LLM fetch) that would otherwise leak into and change behavior
 * for the approval-lane suite's real-broker.ts-pipeline tests.
 *
 * Mirrors the verified-working fixture in test/e2e-money-path.test.ts (vector-db mock, broker
 * mock routing to getTestGateway, stubbed Bull/Bear/Red-Team LLM fetch responses, "decide"
 * authority so the loop auto-places). Adversarial review flagged that Change 3's busy branch
 * (runStrategyOnce's withAccountMutation wrap) shipped with zero coverage — this file closes
 * that gap.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import {
  listRecentProposals,
  setActiveConnectedAccount,
  setPolicy,
  upsertConnectedAccount,
  upsertUserApiKey
} from "../src/lib/db";
import { listFillEventsByProposalId } from "../src/lib/db-fills";
import { LANE_WAITS, withAccountMutation } from "../src/lib/account-mutation";

vi.mock("../src/lib/vector-db", () => ({
  managedVectorLedgerAuthority: vi.fn(),
  getCurrentVectorProviderAuthority: vi.fn(),
  findRelevantExperiences: async () => [],
  upsertExperiences: async () => {},
  retrieveContext: async () => [],
  storeContext: async () => {},
  storeContexts: async () => {}
}));

// Same as test/e2e-money-path.test.ts: route every gateway resolution to the deterministic
// TestBrokerGateway (synchronous fills, no network) regardless of policy.activeBroker.
vi.mock("../src/lib/broker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/broker")>();
  const { getTestGateway } = await import("../src/lib/robinhood");
  return { ...actual, getBrokerGateway: (_policy: unknown, userId: string = "local") => getTestGateway(userId) };
});

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-acctmut-pr2-strategy-${randomUUID()}.db`)}`;
});

beforeEach(async () => {
  const { getDb } = await import("../src/lib/db");
  getDb().exec("DELETE FROM trade_proposals;");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// Must be "TEST": TestBrokerGateway.getAccounts() hardcodes accountNumber "TEST" (robinhood.ts),
// and checkBrokerHealth (strategy.ts's broker-health gate) skips the run before it can even reach
// the placement span if policy.accountNumber doesn't match a broker-reported account.
const ACCOUNT = "TEST";

const BULL_PROPOSAL = {
  symbol: "AAPL",
  side: "buy",
  type: "market",
  dollarAmount: 1000,
  timeInForce: "gfd",
  marketHours: "regular_hours",
  rationale: "Bull thesis for AAPL — PR-2 strategy-loop lease test",
  tradeThesisTag: "Momentum-Breakout",
  confidenceScore: 85
};

function nasdaqResponse(): Response {
  return new Response(
    JSON.stringify({
      data: {
        asof: "2026-06-15",
        table: {
          rows: [
            {
              symbol: "AAPL",
              lastsale: "$200",
              pctchange: "1%",
              volume: "1000000",
              marketCap: "3000000000000",
              sector: "Technology",
              industry: "Consumer Electronics"
            }
          ]
        }
      }
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function bullOk(): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify({ proposals: [BULL_PROPOSAL] }) } }] }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function bearOk(): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify({ proposals: [BULL_PROPOSAL] }) } }] }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function redTeamOk(): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ verdict: "approve", reason: "PR-2 strategy-loop fixture looks fine." }) } }]
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function stubFetchStrategyLoop(): void {
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    if (href.includes("openrouter.ai") || href.includes("api.openai.com")) {
      const body = String(init?.body ?? "");
      const isRedTeam = body.includes("Red Team Risk Agent") || body.includes("rigorously critique");
      const isBear = body.includes("Bear Agent") || body.includes("bear_proposals");
      if (isRedTeam) return redTeamOk();
      if (isBear) return bearOk();
      return bullOk();
    }
    if (href.includes("nasdaq.com")) return nasdaqResponse();
    return new Response("not found", { status: 404 });
  });
}

async function setupAutonomousDecidePolicy(userId: string): Promise<string> {
  upsertUserApiKey(userId, "openrouter", "test-openai-key", "PR-2 strategy-loop fixture");
  const accountId = randomUUID();
  upsertConnectedAccount({
    id: accountId,
    userId,
    broker: "test",
    environment: "paper",
    accountNumber: ACCOUNT,
    label: "PR-2 Strategy Loop Test Account",
    isActive: true
  });
  setActiveConnectedAccount(accountId, userId);
  setPolicy(
    {
      ...DEFAULT_POLICY,
      connectedAccountId: accountId,
      accountNumber: ACCOUNT,
      activeBroker: "test",
      systemState: "active",
      strategyAuthority: "decide",
      includedIndices: [],
      additionalSymbols: ["AAPL"],
      llmModel: "openai/gpt-4.1-mini",
      redTeamLlmModel: "openai/gpt-4.1-mini",
      maxOrderPctOfNav: 100,
      maxDailyNotional: 400_000,
      maxDailyPctOfNav: 0,
      maxSymbolExposurePct: 100,
      maxGrossExposurePct: 1000,
      maxNetExposurePct: 1000
    },
    userId,
    accountId
  );
  return accountId;
}

/** Same holdLease pattern as test/account-mutation-pr2.test.ts, parameterized for this file's own
 *  account. Resolves only once the lease is actually held, so callers can rely on it being held
 *  the instant this resolves. */
async function holdLease(
  userId: string,
  accountId: string
): Promise<{ release: () => void; done: ReturnType<typeof withAccountMutation<void>> }> {
  let release!: () => void;
  let acquiredResolve!: () => void;
  const acquired = new Promise<void>((resolve) => {
    acquiredResolve = resolve;
  });
  const done = withAccountMutation(
    { userId, accountNumber: ACCOUNT, connectedAccountId: accountId, lane: "account-drain", waitMs: 0 },
    async () => {
      acquiredResolve();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
  );
  await acquired;
  return { release, done };
}

describe("PR-2 money-path windows — autonomous strategy loop", () => {
  const originalStrategyPlacementWait = LANE_WAITS.strategyPlacement;

  afterEach(() => {
    // LANE_WAITS is an exported mutable table (mirrors ttlMs/heartbeatMs test overrides) — restore
    // it so a shrunk wait never leaks into another test/file.
    LANE_WAITS.strategyPlacement = originalStrategyPlacementWait;
  });

  it(
    "books not_placed without placing when the strategy lane's lease is already held, then places normally on retry",
    async () => {
      const userId = `mutation-pr2-strategy-${randomUUID()}`;
      vi.stubEnv("OPENROUTER_API_KEY", "test-openai-key");
      // Keys for both LLM families present so Red Team credential resolution never fails-closed —
      // the fetch stub actually serves the Red Team through the OpenAI-family endpoint.
      vi.stubEnv("GEMINI_API_KEY", "test-gemini-key");
      // Deterministic trading day: runStrategyOnce() skips non-manual runs when isTradingDay() is
      // false, so force the VITEST-only seam on to keep this test off the calendar. A MANUAL run
      // can't be used instead — runStrategyOnce forces strategyAuthority to "propose" for manual
      // runs, which would never reach the placement span this test exists to exercise.
      vi.stubEnv("AGENTIC_TEST_FORCE_TRADING_DAY", "1");
      stubFetchStrategyLoop();
      const accountId = await setupAutonomousDecidePolicy(userId);
      const { runStrategyOnce } = await import("../src/lib/strategy");

      // Shrink the bounded wait so the busy path resolves quickly instead of waiting the real 15s.
      LANE_WAITS.strategyPlacement = 50;

      const holder = await holdLease(userId, accountId);
      let busyRunResult: Awaited<ReturnType<typeof runStrategyOnce>>;
      try {
        busyRunResult = await runStrategyOnce(userId, { manual: false, connectedAccountId: accountId });
      } finally {
        holder.release();
        await holder.done;
      }

      expect(busyRunResult.status).toBe("completed");
      const busyProposalResult = busyRunResult.proposals.find((p) => p.proposal.symbol === "AAPL");
      expect(busyProposalResult).toBeDefined();
      // Doctrine-sensitive: busy must book as this exact status/reason, never regress into
      // placing_failed or order_placement_uncertain's "uncertain" framing.
      expect(busyProposalResult?.status).toBe("error");
      expect(busyProposalResult?.reasons?.[0]).toMatch(/Account mutation lease busy/i);

      const busyRows = listRecentProposals(ACCOUNT, 100, userId);
      expect(busyRows).toHaveLength(1);
      expect(busyRows[0].status).toBe("not_placed");
      // No order reached the broker: no fill receipt exists for the busy-run's proposal.
      expect(listFillEventsByProposalId(busyRows[0].id, userId)).toEqual([]);

      // Retry once the lease is free: a fresh run now places/fills normally.
      const retryResult = await runStrategyOnce(userId, { manual: false, connectedAccountId: accountId });
      expect(retryResult.status).toBe("completed");
      const retryProposalResult = retryResult.proposals.find((p) => p.proposal.symbol === "AAPL");
      expect(retryProposalResult).toBeDefined();
      expect(["placed", "filled"]).toContain(retryProposalResult?.status);

      const rowsAfterRetry = listRecentProposals(ACCOUNT, 100, userId);
      const placedRow = rowsAfterRetry.find((r) => r.status === "placed" || r.status === "filled");
      expect(placedRow).toBeDefined();
      expect(listFillEventsByProposalId(placedRow!.id, userId)).toHaveLength(1);
    },
    60_000
  );
});
