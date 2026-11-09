import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// P2 fix (2026-09-07): shouldEmitRagIngestBudgetSentry (vector-db.ts) gates the "RAG ingest text
// budget reached" Sentry warning behind a cooldown persisted via getInternalSetting/
// setInternalSetting — synchronous SQLite calls that can throw (e.g. SQLITE_BUSY under
// contention). It is invoked from inside storeContextsImpl's budget-exceeded branch, well before
// that function's own error handling; an uncaught throw there previously escaped all the way out
// of storeContexts, turning an expected budget-skip into a rejected store operation instead of
// the caller's normal `{ budgetSkipped }` result. This suite asserts the fail-soft guard: a
// persistence failure on the cooldown key must never surface as a rejection.
process.env.DATABASE_URL = `file:${join(tmpdir(), `socratic-ingest-budget-cooldown-${randomUUID()}.db`)}`;

const mocks = vi.hoisted(() => {
  const upsert = vi.fn();
  const index = vi.fn(() => ({ upsert }));
  return {
    upsert,
    index,
    listIndexes: vi.fn(),
    createIndex: vi.fn(),
    describeIndex: vi.fn(),
    embed: vi.fn(),
    sendNotification: vi.fn(),
    logWarn: vi.fn()
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

vi.mock("../src/lib/notifications", () => ({ sendNotification: mocks.sendNotification }));

vi.mock("../src/lib/sentry-metrics", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, logWarn: mocks.logWarn };
});

// Selective throw: only the ingest-budget-alert cooldown key is affected, so unrelated settings
// reads/writes elsewhere in the same call chain (e.g. other cooldown lanes) keep hitting the real
// (temp) SQLite DB normally. This isolates the fix under test from incidentally masking or being
// masked by other code paths that share the same getInternalSetting/setInternalSetting pair.
vi.mock("../src/lib/db-settings", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    getInternalSetting: (key: string) => {
      if (key.startsWith("vectorStore:ingestBudgetAlert:")) {
        throw new Error("SQLITE_BUSY: simulated contention");
      }
      return actual.getInternalSetting(key);
    },
    setInternalSetting: (key: string, value: unknown) => {
      if (key.startsWith("vectorStore:ingestBudgetAlert:")) {
        throw new Error("SQLITE_BUSY: simulated contention");
      }
      return actual.setInternalSetting(key, value);
    }
  };
});

function context() {
  return [{
    text: "Management discussed revenue growth and customer demand.",
    metadata: { symbol: "AAPL", source: "fmp-earnings-transcript", timestamp: "2026-04-20" }
  }];
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env.PINECONE_API_KEY = "pinecone-cooldown-test";
  process.env.VOYAGE_API_KEY = "voyage-cooldown-test";
  process.env.PINECONE_INDEX_READY_WAIT_MS = "0";
  process.env.VECTOR_EMBED_BATCH_DELAY_MS = "0";
  process.env.RAG_INGEST_MAX_TEXTS_PER_DAY = "1";
  delete process.env.SENTRY_DSN;
  mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
  mocks.createIndex.mockResolvedValue(undefined);
  mocks.describeIndex.mockResolvedValue({ metric: "cosine" });
  mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] });
  mocks.upsert.mockResolvedValue(undefined);
  mocks.sendNotification.mockResolvedValue({});
});

describe("RAG ingest budget Sentry cooldown (fail-soft)", () => {
  it("does not reject storeContexts when the cooldown persistence throws", async () => {
    const { storeContexts } = await import("../src/lib/vector-db");

    // Two texts against a budget of 1 forces the budget-exceeded branch that calls
    // shouldEmitRagIngestBudgetSentry — the cooldown-persistence throw must not escape here.
    const result = await storeContexts([...context(), ...context()], "local", {});

    expect(result.budgetSkipped).toBeGreaterThan(0);
  });

  it("logs a warning (fail-soft) instead of throwing when the cooldown key cannot be read/written", async () => {
    const { storeContexts } = await import("../src/lib/vector-db");

    await storeContexts([...context(), ...context()], "local", {});

    expect(mocks.logWarn).toHaveBeenCalledWith(
      "rag.ingest_budget_cooldown_persist_failed",
      expect.objectContaining({ userId: "local" })
    );
  });
});
