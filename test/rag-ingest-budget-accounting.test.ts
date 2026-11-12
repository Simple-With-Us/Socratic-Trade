import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { selectIngestBudgetTexts } from "../src/lib/rag/ingest-budget";

// ST-4609: already-paid texts and retrieval embeds must not spend RAG_INGEST_MAX_TEXTS_PER_DAY,
// duplicate strings in one batch are one window, and the audit names embed windows.

const mocks = vi.hoisted(() => {
  const upsert = vi.fn();
  const index = vi.fn(() => ({ upsert }));
  return {
    upsert,
    index,
    listIndexes: vi.fn(),
    createIndex: vi.fn(),
    describeIndex: vi.fn(),
    embed: vi.fn()
  };
});

vi.mock("@pinecone-database/pinecone", () => ({
  Pinecone: vi.fn(function Pinecone() {
    return {
      listIndexes: mocks.listIndexes,
      createIndex: mocks.createIndex,
      describeIndex: mocks.describeIndex,
      Index: mocks.index
    };
  })
}));

vi.mock("voyageai", () => ({
  VoyageAIClient: vi.fn(function VoyageAIClient() {
    return { embed: mocks.embed };
  })
}));

vi.mock("../src/lib/notifications", () => ({ sendNotification: vi.fn(async () => ({})) }));

vi.mock("@sentry/nextjs", () => ({
  captureMessage: vi.fn(),
  withScope: (callback: (scope: {
    setLevel: (level: unknown) => void;
    setTag: (key: string, value: unknown) => void;
    setFingerprint: (fp: unknown) => void;
    setContext: (name: string, ctx: unknown) => void;
  }) => void) => {
    callback({
      setLevel: () => undefined,
      setTag: () => undefined,
      setFingerprint: () => undefined,
      setContext: () => undefined
    });
  }
}));

function doc(text: string) {
  return {
    text,
    metadata: { symbol: "AAPL", source: "sec-10k", timestamp: "2026-11-11T00:00:00.000Z" }
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `socratic-ingest-budget-accounting-${randomUUID()}.db`)}`;
  process.env.PINECONE_API_KEY = "pinecone-accounting-test";
  process.env.VOYAGE_API_KEY = "voyage-accounting-test";
  process.env.PINECONE_INDEX_READY_WAIT_MS = "0";
  process.env.VECTOR_EMBED_BATCH_DELAY_MS = "0";
  process.env.RAG_INGEST_MAX_TEXTS_PER_DAY = "100";
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.SILICONFLOW_API_KEY;
  delete process.env.SENTRY_DSN;
  mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
  mocks.createIndex.mockResolvedValue(undefined);
  mocks.describeIndex.mockResolvedValue({ metric: "cosine" });
  mocks.embed.mockImplementation(async (args?: { input?: string | string[] }) => {
    const raw = args?.input;
    const count = Array.isArray(raw) ? raw.length : 1;
    return { data: Array.from({ length: Math.max(1, count) }, () => ({ embedding: [0.1, 0.2] })) };
  });
  mocks.upsert.mockResolvedValue(undefined);
});

describe("selectIngestBudgetTexts", () => {
  it("does not charge a reusable text and charges a duplicate string once", () => {
    const selection = selectIngestBudgetTexts([
      { id: "cached", units: 1, reusable: true, chargeKey: "already-paid" },
      { id: "fresh", units: 1, reusable: false, chargeKey: "new-chunk" },
      { id: "copy", units: 1, reusable: false, chargeKey: "new-chunk" }
    ], 1);
    expect(selection.requestedUnits).toBe(1);
    expect(selection.requestedTexts).toBe(1);
    expect(selection.chargedUnits).toBe(1);
    expect(selection.keepIds).toEqual(["cached", "fresh", "copy"]);
    expect(selection.withheldPartialCommit).toBe(false);
  });

  it("withholds a managed commit that cannot finish inside the allowance", () => {
    const selection = selectIngestBudgetTexts([
      { id: "0", units: 1, reusable: false, chargeKey: "a" },
      { id: "1", units: 1, reusable: false, chargeKey: "b" }
    ], 1, { managedExpectedCount: 2 });
    expect(selection.requestedUnits).toBe(2);
    expect(selection.requestedTexts).toBe(2);
    expect(selection.chargedUnits).toBe(0);
    expect(selection.keepIds).toEqual([]);
    expect(selection.withheldPartialCommit).toBe(true);
  });

  it("keeps a managed commit whose texts are already reusable without charging", () => {
    const selection = selectIngestBudgetTexts([
      { id: "0", units: 1, reusable: true, chargeKey: "a" },
      { id: "1", units: 1, reusable: true, chargeKey: "b" }
    ], 0, { managedExpectedCount: 2 });
    expect(selection.requestedUnits).toBe(0);
    expect(selection.chargedUnits).toBe(0);
    expect(selection.keepIds).toEqual(["0", "1"]);
    expect(selection.withheldPartialCommit).toBe(false);
  });
});

describe("ingest budget ledger", () => {
  it("does not let a retrieval embed spend the ingest cap", async () => {
    process.env.RAG_INGEST_MAX_TEXTS_PER_DAY = "1";
    const { meterEmbed, usedIngestEmbedWindowsLast24h } = await import("../src/lib/rag-metering");
    const { hasIngestTextBudget } = await import("../src/lib/vector-db");
    const since = new Date(Date.now() - 24 * 60 * 60_000).toISOString();

    meterEmbed(["query for filings"], "baai/bge-m3", "local", "openrouter", undefined, 1, false);
    expect(usedIngestEmbedWindowsLast24h("local", since)).toBe(0);
    expect(hasIngestTextBudget("local")).toBe(true);

    meterEmbed(["filing chunk"], "baai/bge-m3", "local", "openrouter", undefined, 1, true);
    expect(usedIngestEmbedWindowsLast24h("local", since)).toBe(1);
    expect(hasIngestTextBudget("local")).toBe(false);
  });

  it("charges an unchanged document 0 windows on the next tick", async () => {
    const { storeContexts } = await import("../src/lib/vector-db");
    const { usedIngestEmbedWindowsLast24h } = await import("../src/lib/rag-metering");
    const since = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    const filing = doc("Revenue grew and the backlog stayed flat.");

    const first = await storeContexts([filing], "local");
    expect(first.indexed).toBe(1);
    expect(usedIngestEmbedWindowsLast24h("local", since)).toBe(1);
    expect(mocks.embed).toHaveBeenCalledTimes(1);

    const second = await storeContexts([filing], "local");
    expect(second.indexed).toBe(1);
    expect(second.budgetSkipped ?? 0).toBe(0);
    expect(usedIngestEmbedWindowsLast24h("local", since)).toBe(1);
    expect(mocks.embed).toHaveBeenCalledTimes(1);
  });

  it("charges two copies of one text as one window", async () => {
    const { storeContexts } = await import("../src/lib/vector-db");
    const { usedIngestEmbedWindowsLast24h } = await import("../src/lib/rag-metering");
    const since = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    const filing = doc("One sentence stored twice in the same batch.");

    const stored = await storeContexts([filing, filing], "local");
    expect(stored.indexed).toBe(2);
    expect(usedIngestEmbedWindowsLast24h("local", since)).toBe(1);
    expect(mocks.embed).toHaveBeenCalledTimes(1);
  });

  it("labels the audit in embed windows and records the text count", async () => {
    process.env.RAG_INGEST_MAX_TEXTS_PER_DAY = "1";
    const { storeContexts } = await import("../src/lib/vector-db");
    const { getDb } = await import("../src/lib/db");

    await storeContexts([
      doc("First distinct chunk about cash flow."),
      doc("Second distinct chunk about debt.")
    ], "local");

    const row = getDb()
      .prepare("SELECT payload FROM audit_events WHERE user_id = 'local' AND kind = 'vector_ingest_budget' ORDER BY rowid DESC LIMIT 1")
      .get() as { payload: string };
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    expect(payload.unit).toBe("embed windows");
    expect(payload.requested).toBe(2);
    expect(payload.requestedTexts).toBe(2);
    expect(payload.tokenBudgetPerText).toBe(7500);
    expect(payload.skipped).toBe(1);
  });
});
