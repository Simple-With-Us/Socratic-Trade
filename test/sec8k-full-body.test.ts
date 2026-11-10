// Item 3 (2026-07-01 RAG workstream): confirm the paid-Voyage full-body ingest path actually runs
// end-to-end when its flags are enabled. WEB_SOURCE_SEC8K_FULL_BODY defaults OFF (config/cost
// decision — see docs/prod-config-voyage.md); this test proves the enablement path itself works,
// without flipping the default or making any live EDGAR/Voyage/Pinecone calls.

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-sec8k-full-body-${randomUUID()}.db`)}`;
});

const mocks = vi.hoisted(() => ({
  politeFetchText: vi.fn(),
  hasIngestTextBudget: vi.fn().mockReturnValue(true),
  hasPineconeWriteBudget: vi.fn().mockReturnValue(true),
  insertSecArtifact: vi.fn(),
  storeDocument: vi.fn().mockResolvedValue({
    attempted: 1,
    indexed: 1,
    documentComplete: true,
    managedCommitProof: { commitId: "test:sec8k", attemptToken: "test:sec8k" }
  })
}));

vi.mock("../src/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/db")>();
  return { managedVectorLedgerAuthority: vi.fn(),
    ...actual,
    insertSecArtifact: mocks.insertSecArtifact,
    runWithActiveVectorCommitProof: <T>(_proof: unknown, work: () => T) => work()
  };
});

vi.mock("../src/lib/db-vector-commits", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/db-vector-commits")>();
  return { managedVectorLedgerAuthority: vi.fn(),
    ...actual,
    runWithActiveVectorCommitProof: <T>(_proof: unknown, work: () => T) => work()
  };
});

vi.mock("../src/lib/web-sources/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/web-sources/http")>();
  return { ...actual, politeFetchText: mocks.politeFetchText };
});

vi.mock("../src/lib/vector-db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/vector-db")>();
  return {
    ...actual,
    managedVectorLedgerAuthority: vi.fn(),
    hasIngestTextBudget: mocks.hasIngestTextBudget,
    hasPineconeWriteBudget: mocks.hasPineconeWriteBudget,
    storeDocument: async (...args: Parameters<typeof actual.storeDocument>) => {
      const result = await mocks.storeDocument(...args);
      return result?.documentComplete === true
        ? { ...result, managedCommitProof: result.managedCommitProof ?? { commitId: "test:sec8k", attemptToken: "test:sec8k" } }
        : result;
    }
  };
});

import { hasIngestedAccession } from "../src/lib/db";
import {
  eightKBodyCycleShouldStop,
  eightKFullBodyBudgetMs,
  eightKFullBodyEnabled,
  eightKFullBodyLimit,
  ingestEightKBody,
  ingestEightKBodies,
  type EightKEvent
} from "../src/lib/web-sources/sec8k";

const SAMPLE_HTML = `<html><body><div>${"Material event details. ".repeat(30)}</div></body></html>`;

const EVENT: EightKEvent = {
  symbol: "AAPL",
  filedAt: "2026-06-30",
  accession: "0000320193-26-000099",
  filingUrl: "https://www.sec.gov/Archives/edgar/data/320193/000032019326000099/example-index.htm",
  items: ["Item 2.02 Results of Operations and Financial Condition"]
};

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.WEB_SOURCE_SEC8K_FULL_BODY;
  mocks.politeFetchText.mockResolvedValue(SAMPLE_HTML);
  mocks.hasIngestTextBudget.mockReturnValue(true);
  mocks.hasPineconeWriteBudget.mockReturnValue(true);
  mocks.insertSecArtifact.mockImplementation(() => undefined);
  mocks.storeDocument.mockResolvedValue({
    attempted: 1,
    indexed: 1,
    documentComplete: true,
    managedCommitProof: { commitId: "test:sec8k", attemptToken: "test:sec8k" }
  });
});

describe("eightKFullBodyEnabled (default-off corpus-enablement flag)", () => {
  it("is off by default", () => {
    delete process.env.WEB_SOURCE_SEC8K_FULL_BODY;
    expect(eightKFullBodyEnabled()).toBe(false);
  });
  it("turns on with WEB_SOURCE_SEC8K_FULL_BODY=on", () => {
    process.env.WEB_SOURCE_SEC8K_FULL_BODY = "on";
    expect(eightKFullBodyEnabled()).toBe(true);
  });
});

describe("ingestEightKBody (full-body ingest path when the flag is on)", () => {
  it("fetches the filing, chunks+stores it via storeDocument, and records the accession", async () => {
    const result = await ingestEightKBody(EVENT);

    expect(result.skipped).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.chunks).toBeGreaterThan(0);
    expect(mocks.politeFetchText).toHaveBeenCalledWith(
      EVENT.filingUrl,
      expect.objectContaining({ headers: expect.any(Object) })
    );
    // Full 8-K body + extractive document-summary abstract (trade highlights).
    expect(mocks.storeDocument).toHaveBeenCalledTimes(2);
    const [doc] = mocks.storeDocument.mock.calls[0]!;
    expect(doc).toMatchObject({ ticker: "AAPL", doc_type: "8-k", source: "sec-8k" });
    const abstractDoc = mocks.storeDocument.mock.calls[1]![0] as { doc_type?: string; source?: string };
    expect(abstractDoc).toMatchObject({ doc_type: "document-summary", source: "document-summarizer" });
    // Recorded in ingested_accessions so a second call for the same accession is skipped.
    expect(hasIngestedAccession(EVENT.accession, "8-K-body")).toBe(true);
  });

  it("mirrors committed 8-K body chunks into document_chunks_fts (source=sec-8k)", async () => {
    const event: EightKEvent = { ...EVENT, accession: `0000320193-26-fts-${randomUUID().slice(0, 8)}` };
    const { getDb } = await import("../src/lib/db");
    const result = await ingestEightKBody(event);
    expect(result.completed).toBe(true);
    expect(result.skipped).toBe(false);

    const rows = getDb()
      .prepare(
        `SELECT content_hash, symbol, source, accession FROM document_chunks_fts
         WHERE source = ? AND accession = ? AND symbol = ?`
      )
      .all("sec-8k", event.accession, event.symbol) as Array<{
      content_hash: string;
      symbol: string;
      source: string;
      accession: string;
    }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.source).toBe("sec-8k");
      expect(row.accession).toBe(event.accession);
      expect(row.symbol).toBe("AAPL");
      expect(row.content_hash.length).toBeGreaterThan(0);
    }
  });

  it("skips a filing whose accession was already ingested (de-dup gate)", async () => {
    await ingestEightKBody(EVENT);
    mocks.storeDocument.mockClear();
    mocks.politeFetchText.mockClear();

    const second = await ingestEightKBody(EVENT);
    expect(second.skipped).toBe(true);
    expect(second.chunks).toBe(0);
    expect(mocks.politeFetchText).not.toHaveBeenCalled();
    expect(mocks.storeDocument).not.toHaveBeenCalled();
  });

  it("surfaces (does not swallow) a fetch failure", async () => {
    mocks.politeFetchText.mockRejectedValueOnce(new Error("EDGAR 503"));
    const event: EightKEvent = { ...EVENT, accession: "0000320193-26-000100" };
    const result = await ingestEightKBody(event);
    expect(result.skipped).toBe(false);
    expect(result.chunks).toBe(0);
    expect(result.error).toMatch(/fetch failed/);
    expect(mocks.storeDocument).not.toHaveBeenCalled();
  });

  it.each([
    ["partial cardinality", { attempted: 2, indexed: 1, documentComplete: false }],
    ["text budget", { attempted: 2, indexed: 1, budgetSkipped: 1, documentComplete: false }],
    ["write-unit budget", { attempted: 2, indexed: 1, writeUnitBudgetSkipped: 1, documentComplete: false }],
    ["unconfigured provider", { attempted: 2, indexed: 0, unconfigured: true, documentComplete: false }],
    ["empty document", { attempted: 0, indexed: 0, documentComplete: false }]
  ])("leaves the accession retryable after a no-error %s result", async (_label, stored) => {
    const event = { ...EVENT, accession: `0000320193-26-${randomUUID().slice(0, 6)}` };
    mocks.storeDocument.mockResolvedValueOnce(stored);

    const result = await ingestEightKBody(event);

    expect(result).toMatchObject({ skipped: true, chunks: stored.indexed });
    expect(hasIngestedAccession(event.accession, "8-K-body")).toBe(false);
  });

  it("accepts an exact previously committed occurrence set without another provider write", async () => {
    const event = { ...EVENT, accession: `0000320193-26-${randomUUID().slice(0, 6)}` };
    mocks.storeDocument.mockResolvedValueOnce({
      attempted: 2,
      indexed: 0,
      skipped: true,
      reusedCommitted: true,
      documentComplete: true
    });

    const result = await ingestEightKBody(event);

    expect(result).toEqual({ skipped: false, chunks: 2, completed: true });
    expect(hasIngestedAccession(event.accession, "8-K-body")).toBe(true);
  });

  it("stops after the HTML fetch when the RAG lease is lost", async () => {
    const event = { ...EVENT, accession: `lease-fetch-${randomUUID()}` };
    let lost = false;
    mocks.politeFetchText.mockImplementationOnce(async () => {
      lost = true;
      return SAMPLE_HTML;
    });
    const guard = {
      assertOwnership: vi.fn(() => {
        if (lost) throw new Error("test 8-k fetch lease lost");
      })
    };

    await expect(ingestEightKBody(event, Date.now(), guard)).rejects.toThrow(
      "test 8-k fetch lease lost"
    );
    expect(mocks.insertSecArtifact).not.toHaveBeenCalled();
    expect(mocks.storeDocument).not.toHaveBeenCalled();
  });

  it("stops after the artifact insert when the RAG lease is lost", async () => {
    const event = { ...EVENT, accession: `lease-artifact-${randomUUID()}` };
    let ownershipChecks = 0;
    const guard = {
      assertOwnership: vi.fn(() => {
        ownershipChecks += 1;
        // The eighth check is immediately after insertSecArtifact; once lost, every catch-path
        // recheck must continue to fail rather than convert cancellation into a warning.
        if (ownershipChecks >= 8) throw new Error("test 8-k artifact lease lost");
      })
    };

    await expect(ingestEightKBody(event, Date.now(), guard)).rejects.toThrow(
      "test 8-k artifact lease lost"
    );
    expect(ownershipChecks).toBeGreaterThanOrEqual(8);
    expect(mocks.storeDocument).not.toHaveBeenCalled();
  });
});

describe("ingestEightKBodies (batch path called from refreshEightK when the flag is on)", () => {
  it("ingests multiple events sequentially and aggregates the outcome", async () => {
    const events: EightKEvent[] = [
      { ...EVENT, accession: "0000320193-26-000201" },
      { ...EVENT, accession: "0000320193-26-000202" }
    ];
    const result = await ingestEightKBodies(events);
    expect(result.attempted).toBe(2);
    expect(result.ingested).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.errors).toEqual([]);
    // 2 full bodies + 2 highlight abstracts
    expect(mocks.storeDocument).toHaveBeenCalledTimes(4);
  });

  it("stops before fetching the tail after capacity is exhausted and returns every deferred accession", async () => {
    const events: EightKEvent[] = [
      { ...EVENT, accession: `capacity-a-${randomUUID()}` },
      { ...EVENT, accession: `capacity-b-${randomUUID()}` },
      { ...EVENT, accession: `capacity-c-${randomUUID()}` }
    ];
    mocks.storeDocument.mockResolvedValueOnce({
      attempted: 2,
      indexed: 0,
      unconfigured: true,
      documentComplete: false
    });

    const result = await ingestEightKBodies(events);

    expect(result).toMatchObject({
      attempted: 1,
      ingested: 0,
      capacityExhausted: true,
      deferredAccessions: events.map((event) => event.accession)
    });
    expect(mocks.politeFetchText).toHaveBeenCalledTimes(1);
    expect(mocks.storeDocument).toHaveBeenCalledTimes(1);
  });

  it("stops the cycle when the wall-time budget is exhausted (budgetMs=0 after first)", async () => {
    const events: EightKEvent[] = [
      { ...EVENT, accession: `budget-a-${randomUUID()}` },
      { ...EVENT, accession: `budget-b-${randomUUID()}` },
      { ...EVENT, accession: `budget-c-${randomUUID()}` }
    ];
    const result = await ingestEightKBodies(events, Date.now(), undefined, { budgetMs: 0 });
    expect(result.attempted).toBe(1);
    expect(result.ingested).toBe(1);
    expect(result.budgetExhausted).toBe(true);
    expect(result.deferredAccessions).toEqual(events.slice(1).map((event) => event.accession));
    expect(mocks.politeFetchText).toHaveBeenCalledTimes(1);
  });
});

describe("8-K full-body cycle bounds", () => {
  it("defaults the per-cycle limit to 5 and the wall budget to 12s, capped at 60s", () => {
    delete process.env.WEB_SOURCE_SEC8K_FULL_BODY_LIMIT;
    delete process.env.WEB_SOURCE_SEC8K_FULL_BODY_BUDGET_MS;
    expect(eightKFullBodyLimit()).toBe(5);
    expect(eightKFullBodyBudgetMs()).toBe(12_000);

    process.env.WEB_SOURCE_SEC8K_FULL_BODY_BUDGET_MS = "120000";
    expect(eightKFullBodyBudgetMs()).toBe(60_000);
    process.env.WEB_SOURCE_SEC8K_FULL_BODY_BUDGET_MS = "0";
    expect(eightKFullBodyBudgetMs()).toBe(12_000);
    delete process.env.WEB_SOURCE_SEC8K_FULL_BODY_BUDGET_MS;
  });

  it("eightKBodyCycleShouldStop is elapsed >= budget", () => {
    expect(eightKBodyCycleShouldStop(1000, 1000, 12_000)).toBe(false);
    expect(eightKBodyCycleShouldStop(1000, 13_000, 12_000)).toBe(true);
    expect(eightKBodyCycleShouldStop(1000, 1000, 0)).toBe(true);
  });
});
