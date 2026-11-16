import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  politeFetchText: vi.fn(),
  secUserAgent: vi.fn(() => "test-agent")
}));

vi.mock("../src/lib/web-sources/http", () => ({
  politeFetchText: mocks.politeFetchText,
  secUserAgent: mocks.secUserAgent,
  sleep: vi.fn(() => Promise.resolve()),
  BROWSER_UA: "Mozilla/5.0 test",
  runRateLimited: async <T, R>(items: T[], _delay: number, fn: (item: T, idx: number) => Promise<R>): Promise<R[]> =>
    Promise.all(items.map((item, idx) => fn(item, idx)))
}));

// Mock loadCikMap from sec8k to avoid DB hit or real fetching
vi.mock("../src/lib/web-sources/sec8k", () => ({
  loadCikMap: vi.fn().mockResolvedValue({
    "0000320193": "AAPL",
    "0000896159": "CB"
  })
}));

import { secLimiter } from "../src/lib/web-sources/sec-limiter";
import {
  fetchRecentFilings,
  fetchFilingDirectory
} from "../src/lib/web-sources/sec-filings";

describe("SEC Backfill Phase 2 Tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("SecRateLimiter", () => {
    it("enforces rate limit pacing", async () => {
      const start = Date.now();
      // Acquire 3 tokens
      await secLimiter.acquire();
      await secLimiter.acquire();
      await secLimiter.acquire();
      const elapsed = Date.now() - start;
      // With rate limit of 4 req/sec, acquiring 3 tokens immediately is possible due to burst capacity
      expect(elapsed).toBeLessThan(150);
    });

    it("pauses on report429", async () => {
      const start = Date.now();
      secLimiter.report429("1"); // pause for 1 second
      await secLimiter.acquire();
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(950);
    });
  });

  describe("History Shards", () => {
    it("parses submissions JSON with shard files and fetches them if limit is not reached", async () => {
      const mockMainJson = {
        cik: "0000320193",
        filings: {
          recent: {
            accessionNumber: ["0000320193-23-000001"],
            form: ["10-K"],
            filingDate: ["2023-10-31"],
            acceptanceDateTime: ["2023-10-31T17:00:00Z"],
            primaryDocument: ["aapl-20231031.htm"]
          },
          files: [
            {
              name: "CIK0000320193_submissions_001.json",
              filingCount: 1,
              filingFrom: "2020-01-01",
              filingTo: "2022-12-31"
            }
          ]
        }
      };

      const mockShardJson = {
        accessionNumber: ["0000320193-22-000002"],
        form: ["10-K"],
        filingDate: ["2022-10-28"],
        acceptanceDateTime: ["2022-10-28T17:00:00Z"],
        primaryDocument: ["aapl-20221028.htm"]
      };

      mocks.politeFetchText
        .mockResolvedValueOnce(JSON.stringify(mockMainJson))
        .mockResolvedValueOnce(JSON.stringify(mockShardJson));

      // We request 2 filings, but main recent only has 1, so it should fetch the shard
      const filings = await fetchRecentFilings("0000320193", ["10-K"], 2);
      expect(filings).toHaveLength(2);
      expect(filings[0].accession).toBe("0000320193-23-000001");
      expect(filings[1].accession).toBe("0000320193-22-000002");
    });
  });

  describe("Filing Directory", () => {
    it("fetches and parses filing directory index.json", async () => {
      const mockDirectoryJson = {
        directory: {
          item: [
            { name: "index.json", type: "json", size: 100 },
            { name: "aapl-20231031.htm", type: "document", size: 204850 },
            { name: "ex99-1.htm", type: "exhibit", size: 45000 }
          ]
        }
      };

      mocks.politeFetchText.mockResolvedValueOnce(JSON.stringify(mockDirectoryJson));

      const items = await fetchFilingDirectory("0000320193", "0000320193-23-000001");
      expect(items).toHaveLength(3);
      expect(items[0].name).toBe("index.json");
      expect(items[2].name).toBe("ex99-1.htm");
      expect(items[2].type).toBe("exhibit");
      expect(items[2].size).toBe(45000);
    });
  });
});
