import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-ops-scan-summary-${randomUUID()}.db`)}`;
});

describe("opsMarketScanRecordSummary", () => {
  it("reads generatedAt via json_extract without parsing the full scan payload", async () => {
    const db = await import("../src/lib/db");
    const userId = `scan-user-${randomUUID()}`;
    const generatedAt = "2026-10-14T12:00:00.000Z";
    db.audit(
      "market_scan",
      {
        scan: {
          source: "yahoo-finance",
          generatedAt,
          scannedSymbols: 10,
          returnedQuotes: 10,
          topCandidates: [],
          sectorBySymbol: {},
          quotesBySymbol: {},
          warnings: []
        }
      },
      userId
    );

    const { opsMarketScanRecordSummary } = await import("../src/lib/market-scan-freshness");
    const summary = opsMarketScanRecordSummary(userId, Date.parse("2026-10-14T13:00:00.000Z"));
    expect(summary.sourceKind).toBe("market_scan");
    expect(summary.generatedAt).toBe(generatedAt);
    expect(summary.persistedAt).toBeTruthy();
    expect(summary.stale).toBe(false);
  });
});
