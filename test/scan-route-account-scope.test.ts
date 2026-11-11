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
import { registerScanRecovery, resetScanRecoveriesForTests } from "../src/lib/scan-seed-preview";

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
    const options = scanMarketMock.mock.calls[0][5] as {
      connectedAccountId?: string;
      previewSeedBeforeLiveRecovery?: boolean;
      allowWholeSetYahooFallback?: boolean;
    };
    expect(options.connectedAccountId).toBe(accountId);
    expect(options.previewSeedBeforeLiveRecovery).toBe(true);
    expect(options.allowWholeSetYahooFallback).toBeUndefined();
  });

  it("returns a pending seed preview as-is, then the live recovery for the same user", async () => {
    const email = `scan-route-preview-${randomUUID()}@example.com`;
    const { userId } = resolveRequestUserFromEmail(email);
    const otherEmail = `other-${email}`;
    resolveRequestUserFromEmail(otherEmail);
    const pricesAsOf = "2026-11-11T20:14:00.000Z";
    const recoveryId = "22222222-2222-4222-8222-222222222222";
    scanMarketMock.mockResolvedValueOnce({
      ...emptyScan(),
      generatedAt: pricesAsOf,
      cached: true,
      returnedQuotes: 1,
      pricesAsOf,
      refreshPending: true,
      recoveryId
    });

    const preview = await scanGet(
      new Request("https://trading.example.com/api/scan", {
        headers: { [AUTHENTICATED_EMAIL_HEADER]: email }
      })
    );
    expect(preview.status).toBe(200);
    const previewBody = await preview.json();
    expect(previewBody.pricesAsOf).toBe(pricesAsOf);
    expect(previewBody.refreshPending).toBe(true);
    expect(previewBody.recoveryId).toBe(recoveryId);

    const live = {
      ...emptyScan(),
      source: "yahoo-finance",
      generatedAt: "2026-11-11T20:40:00.000Z",
      returnedQuotes: 1
    };
    registerScanRecovery(recoveryId, userId, Promise.resolve(live));
    const replaced = await scanGet(
      new Request(`https://trading.example.com/api/scan?recovery=${recoveryId}`, {
        headers: { [AUTHENTICATED_EMAIL_HEADER]: email }
      })
    );
    expect(replaced.status).toBe(200);
    const replacedBody = await replaced.json();
    expect(replacedBody.source).toBe("yahoo-finance");
    expect(replacedBody.refreshPending).toBeUndefined();

    const keptId = "33333333-3333-4333-8333-333333333333";
    registerScanRecovery(keptId, userId, Promise.resolve({
      keptSnapshot: true,
      pricesAsOf,
      refreshPending: false
    }));
    const kept = await scanGet(
      new Request(`https://trading.example.com/api/scan?recovery=${keptId}`, {
        headers: { [AUTHENTICATED_EMAIL_HEADER]: email }
      })
    );
    expect(kept.status).toBe(200);
    const keptBody = await kept.json();
    expect(keptBody.keptSnapshot).toBe(true);
    expect(keptBody.pricesAsOf).toBe(pricesAsOf);

    const other = await scanGet(
      new Request(`https://trading.example.com/api/scan?recovery=${keptId}`, {
        headers: { [AUTHENTICATED_EMAIL_HEADER]: otherEmail }
      })
    );
    expect(other.status).toBe(404);
    resetScanRecoveriesForTests();
  });
});
