/**
 * Interactive `/api/scan` route — account scoping.
 *
 * The route must run the scan against the OPERATING account so the
 * full-universe enrichment binds to that account's tape (Alpaca PAPER
 * `delayed_sip`) and its account-scoped cache identity — the same binding
 * `strategy-gather.ts` and the market-scan freshness lane use.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MarketScan } from "../src/lib/types";

const scanMarketMock = vi.fn();
vi.mock("../src/lib/market", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/market")>();
  return {
    ...actual,
    scanMarket: (...args: unknown[]) => scanMarketMock(...args)
  };
});

// The route resolves the broker gateway from the connected account; the test
// account carries no broker credentials, so the gateway is stubbed.  The
// assertion under test is the ACCOUNT SCOPE handed to scanMarket, not the
// broker.
vi.mock("../src/lib/broker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/broker")>();
  return {
    ...actual,
    getBrokerGateway: () => ({
      getEquityPositions: async () => [],
      getEquityQuotes: async () => ({})
    })
  };
});

import { getPolicy, resetDbForTesting, setPolicy, upsertConnectedAccount } from "../src/lib/db";
import { AUTHENTICATED_EMAIL_HEADER, resolveRequestUserFromEmail } from "../src/lib/request-user";
import { GET as scanGet } from "../app/api/scan/route";

function emptyScan(): MarketScan {
  return {
    source: "test",
    generatedAt: new Date().toISOString(),
    scannedSymbols: 1,
    returnedQuotes: 0,
    topCandidates: [],
    sectorBySymbol: {},
    quotesBySymbol: {},
    warnings: []
  } as MarketScan;
}

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-scan-route-scope-${randomUUID()}.db`)}`;
  resetDbForTesting();
});

beforeEach(() => {
  scanMarketMock.mockReset();
  scanMarketMock.mockResolvedValue(emptyScan());
});

describe("GET /api/scan — connected account scope", () => {
  it("calls scanMarket with the operating account's connectedAccountId", async () => {
    const email = "scan-route-scope@example.com";
    const { userId } = resolveRequestUserFromEmail(email);
    const accountId = `scan-route-acct-${userId}`;
    upsertConnectedAccount({
      id: accountId,
      userId,
      broker: "test",
      environment: "paper",
      accountNumber: "PAPERACCT",
      label: "Scan route scope",
      isActive: true
    });
    const policy = getPolicy(userId);
    setPolicy(
      {
        ...policy,
        includedIndices: [],
        additionalSymbols: ["AAPL"],
        blocklist: []
      },
      userId
    );

    const res = await scanGet(
      new Request("https://trading.example.com/api/scan", {
        headers: { [AUTHENTICATED_EMAIL_HEADER]: email }
      })
    );
    expect(res.status).toBe(200);

    expect(getPolicy(userId).connectedAccountId).toBe(accountId);
    expect(scanMarketMock).toHaveBeenCalledTimes(1);
    const options = scanMarketMock.mock.calls[0][5] as { connectedAccountId?: string };
    expect(options.connectedAccountId).toBe(accountId);
  });
});
