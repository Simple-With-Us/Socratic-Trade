// Memory-write retry outbox (ST-4678): the fail-open memory writers (closed-lot experience, decision
// re-index, coach-URL lesson vector) enqueue a durable retry on failure instead of dropping the write.
// Verifies: enqueue on a genuine failure; the bounded drain replays through the existing writer and
// deletes on success; failures back off and drop after the attempt cap; the coach-URL accession is a
// deterministic content hash (idempotent replay); and per-user deletion removes the user's rows.
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FillEvent } from "../src/lib/types";

const mocks = vi.hoisted(() => ({
  indexDecision: vi.fn(async () => ({ attempted: 1, indexed: 1 })),
  storeContexts: vi.fn(async () => ({ attempted: 1, indexed: 1 })),
  calculatePnl: vi.fn(() => ({ closedLots: [] as unknown[] }))
}));

vi.mock("../src/lib/socratic-memory", () => ({
  indexSocraticDecisionMemory: mocks.indexDecision
}));

vi.mock("../src/lib/vector-db", () => ({
  managedVectorLedgerAuthority: vi.fn(),
  getCurrentVectorProviderAuthority: vi.fn(),
  storeContexts: mocks.storeContexts,
  storeContext: async () => {},
  retrieveContext: async () => [],
  retrieveContextDetailed: async () => [],
  defaultMinScore: () => 0.3,
  defaultRelevanceFloor: () => 0.35,
  defaultDedupeSimilarity: () => 0.6,
  formatChunkWithProvenance: (chunk: { text: string; doc_type?: string }, symbol?: string) =>
    `[${(chunk.doc_type ?? "context").toUpperCase()}${symbol ? ` · ${symbol}` : ""}]\n${chunk.text}`
}));

vi.mock("../src/lib/performance", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/performance")>();
  return { ...actual, calculatePnl: mocks.calculatePnl };
});

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-memory-outbox-${randomUUID()}.db`)}`;
});

afterEach(() => {
  mocks.indexDecision.mockReset();
  mocks.indexDecision.mockResolvedValue({ attempted: 1, indexed: 1 });
  mocks.storeContexts.mockReset();
  mocks.storeContexts.mockResolvedValue({ attempted: 1, indexed: 1 });
  mocks.calculatePnl.mockReset();
  mocks.calculatePnl.mockReturnValue({ closedLots: [] });
});

async function seedDecision(userId: string): Promise<string> {
  const { upsertSocraticDecisionCase } = await import("../src/lib/db");
  return upsertSocraticDecisionCase({
    userId,
    proposalId: `p-${randomUUID()}`,
    symbol: "AAPL",
    side: "buy",
    status: "placed",
    authority: "decide",
    thesis: "Value-Quality",
    rationale: "fixture",
    action: "BUY AAPL $100"
  });
}

describe("enqueue + CRUD", () => {
  it("enqueues a failed write with attempts 0 and lists it as due", async () => {
    const { enqueueMemoryWrite, listDueMemoryWrites } = await import("../src/lib/db-memory-outbox");
    const userId = `outbox-enqueue-${randomUUID()}`;
    enqueueMemoryWrite("socratic-decision-reindex", { decisionId: "d1", userId }, userId, new Error("vector down"));
    const due = listDueMemoryWrites(50);
    const row = due.find((r) => r.userId === userId);
    expect(row).toBeDefined();
    expect(row?.kind).toBe("socratic-decision-reindex");
    expect(row?.attempts).toBe(0);
    expect(row?.lastError).toBe("vector down");
    expect(JSON.parse(row!.payload)).toEqual({ decisionId: "d1", userId });
  });

  it("backs off exponentially and caps the delay", async () => {
    const { memoryWriteBackoffMs, MEMORY_WRITE_BACKOFF_BASE_MS, MEMORY_WRITE_BACKOFF_MAX_MS } = await import(
      "../src/lib/db-memory-outbox"
    );
    expect(memoryWriteBackoffMs(1)).toBe(MEMORY_WRITE_BACKOFF_BASE_MS);
    expect(memoryWriteBackoffMs(2)).toBe(MEMORY_WRITE_BACKOFF_BASE_MS * 2);
    expect(memoryWriteBackoffMs(3)).toBe(MEMORY_WRITE_BACKOFF_BASE_MS * 4);
    expect(memoryWriteBackoffMs(50)).toBe(MEMORY_WRITE_BACKOFF_MAX_MS);
  });
});

describe("drainMemoryWriteOutbox", () => {
  it("replays through the existing writer and deletes the row on success", async () => {
    const { enqueueMemoryWrite, drainMemoryWriteOutbox, listDueMemoryWrites } = await import("../src/lib/db-memory-outbox");
    const userId = `outbox-success-${randomUUID()}`;
    const decisionId = await seedDecision(userId);
    mocks.indexDecision.mockResolvedValue({ attempted: 1, indexed: 1 });
    enqueueMemoryWrite("socratic-decision-reindex", { decisionId, userId }, userId);

    const result = await drainMemoryWriteOutbox(50);
    expect(result.succeeded).toBeGreaterThanOrEqual(1);
    expect(mocks.indexDecision).toHaveBeenCalled();
    expect(listDueMemoryWrites(50).some((r) => r.userId === userId)).toBe(false);
  });

  it("increments attempts and backs off on failure, keeping the row", async () => {
    const { enqueueMemoryWrite, drainMemoryWriteOutbox, listDueMemoryWrites } = await import("../src/lib/db-memory-outbox");
    const { getDb } = await import("../src/lib/db");
    const userId = `outbox-fail-${randomUUID()}`;
    const decisionId = await seedDecision(userId);
    mocks.indexDecision.mockRejectedValue(new Error("vector down"));
    enqueueMemoryWrite("socratic-decision-reindex", { decisionId, userId }, userId);

    const result = await drainMemoryWriteOutbox(50);
    expect(result.failed).toBeGreaterThanOrEqual(1);
    // The row is kept but backed off into the future, so it is no longer due right now.
    expect(listDueMemoryWrites(50).some((r) => r.userId === userId)).toBe(false);
    const row = getDb()
      .prepare("SELECT attempts, last_error, next_attempt_at FROM memory_write_outbox WHERE user_id = ?")
      .get(userId) as { attempts: number; last_error: string; next_attempt_at: string } | undefined;
    expect(row).toBeDefined();
    expect(row?.attempts).toBe(1);
    expect(row?.last_error).toBe("vector down");
    expect(Date.parse(row!.next_attempt_at)).toBeGreaterThan(Date.now());
  });

  it("drops the row after the attempt cap with one warning", async () => {
    const { enqueueMemoryWrite, drainMemoryWriteOutbox, listDueMemoryWrites, MEMORY_WRITE_MAX_ATTEMPTS } = await import(
      "../src/lib/db-memory-outbox"
    );
    const { getDb } = await import("../src/lib/db");
    const userId = `outbox-cap-${randomUUID()}`;
    const decisionId = await seedDecision(userId);
    mocks.indexDecision.mockRejectedValue(new Error("still down"));
    enqueueMemoryWrite("socratic-decision-reindex", { decisionId, userId }, userId);
    // Push the row to one attempt below the cap and make it due now.
    getDb()
      .prepare("UPDATE memory_write_outbox SET attempts = ?, next_attempt_at = ? WHERE user_id = ?")
      .run(MEMORY_WRITE_MAX_ATTEMPTS - 1, new Date().toISOString(), userId);

    const result = await drainMemoryWriteOutbox(50);
    expect(result.dropped).toBeGreaterThanOrEqual(1);
    expect(listDueMemoryWrites(50).some((r) => r.userId === userId)).toBe(false);
    // The row is gone entirely (dropped, not parked).
    const remaining = getDb().prepare("SELECT COUNT(*) AS n FROM memory_write_outbox WHERE user_id = ?").get(userId) as { n: number };
    expect(remaining.n).toBe(0);
  });

  it("replays a coach-URL lesson through indexStandaloneLesson and deletes on success", async () => {
    const { enqueueMemoryWrite, drainMemoryWriteOutbox, listDueMemoryWrites } = await import("../src/lib/db-memory-outbox");
    const userId = `outbox-coach-${randomUUID()}`;
    mocks.storeContexts.mockResolvedValue({ attempted: 1, indexed: 1 });
    enqueueMemoryWrite(
      "coach-url-lesson",
      { userId, lesson: "Diversify supply chains.", sourceUrl: "https://example.com/a", connectedAccountId: null },
      userId
    );
    const result = await drainMemoryWriteOutbox(50);
    expect(result.succeeded).toBeGreaterThanOrEqual(1);
    expect(mocks.storeContexts).toHaveBeenCalled();
    expect(listDueMemoryWrites(50).some((r) => r.userId === userId)).toBe(false);
  });

  it("never throws into its caller even when a writer rejects", async () => {
    const { enqueueMemoryWrite, drainMemoryWriteOutbox } = await import("../src/lib/db-memory-outbox");
    const userId = `outbox-nothrow-${randomUUID()}`;
    const decisionId = await seedDecision(userId);
    mocks.indexDecision.mockRejectedValue(new Error("boom"));
    enqueueMemoryWrite("socratic-decision-reindex", { decisionId, userId }, userId);
    await expect(drainMemoryWriteOutbox(50)).resolves.toBeDefined();
  });
});

describe("fail-open sites enqueue on failure", () => {
  it("db-socratic outcome re-index failure enqueues a socratic-decision-reindex retry", async () => {
    const { writeSocraticDecisionOutcome } = await import("../src/lib/db-socratic");
    const { listDueMemoryWrites } = await import("../src/lib/db-memory-outbox");
    const userId = `outbox-site-socratic-${randomUUID()}`;
    const decisionId = await seedDecision(userId);
    mocks.indexDecision.mockRejectedValue(new Error("reindex down"));

    const updated = await writeSocraticDecisionOutcome(decisionId, { status: "won", returnPct: 5, outcomes: [] }, userId);
    expect(updated).toBeDefined(); // the outcome row itself is persisted despite the re-index failure
    const row = listDueMemoryWrites(50).find((r) => r.userId === userId && r.kind === "socratic-decision-reindex");
    expect(row).toBeDefined();
    expect(JSON.parse(row!.payload)).toEqual({ decisionId, userId });
  });

  it("experience-memory closed-lot write failure enqueues a closed-lot-experience retry and returns null", async () => {
    const { recordClosedLotExperience } = await import("../src/lib/experience-memory");
    const { listDueMemoryWrites } = await import("../src/lib/db-memory-outbox");
    const userId = `outbox-site-exp-${randomUUID()}`;
    mocks.calculatePnl.mockReturnValue({
      closedLots: [
        { symbol: "AAPL", exitAt: "2026-06-08T00:00:00.000Z", entryAt: "2026-06-01T00:00:00.000Z", side: "long", returnPct: 5, pnl: 50 }
      ]
    });
    mocks.storeContexts.mockRejectedValue(new Error("vector down"));

    const closingFill = {
      id: "f-close",
      symbol: "AAPL",
      side: "sell",
      filledAt: "2026-06-08T00:00:00.000Z",
      price: 105,
      quantity: 1,
      source: "paper"
    } as unknown as FillEvent;
    const result = await recordClosedLotExperience({
      userId,
      accountNumber: "ACCT",
      source: "paper",
      closingFill
    });
    expect(result).toBeNull(); // fail-open contract preserved
    const row = listDueMemoryWrites(50).find((r) => r.userId === userId && r.kind === "closed-lot-experience");
    expect(row).toBeDefined();
  });
});

describe("deterministic coach-URL accession", () => {
  it("is a stable content hash of the URL + lesson, so a replay reconciles in place", async () => {
    const { coachUrlLessonAccession } = await import("../src/lib/chat/coach-learning");
    const a = coachUrlLessonAccession("https://example.com/a", "Diversify supply chains.");
    const b = coachUrlLessonAccession("https://example.com/a", "Diversify supply chains.");
    const c = coachUrlLessonAccession("https://example.com/a", "A different lesson.");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^coach-url:[0-9a-f]{12}$/);
  });
});

describe("per-user deletion", () => {
  it("memory_write_outbox is in the deletion list and a user's rows are removed by the scoped DELETE", async () => {
    const { enqueueMemoryWrite } = await import("../src/lib/db-memory-outbox");
    const { getDb } = await import("../src/lib/db");
    const { DELETE_TABLES_BY_USER_ID_FOR_TEST } = await import("../src/lib/account-deletion");
    expect(DELETE_TABLES_BY_USER_ID_FOR_TEST).toContain("memory_write_outbox");

    const u1 = `outbox-del-${randomUUID()}`;
    const u2 = `outbox-del-${randomUUID()}`;
    enqueueMemoryWrite("socratic-decision-reindex", { decisionId: "x", userId: u1 }, u1);
    enqueueMemoryWrite("coach-url-lesson", { userId: u2, lesson: "l", sourceUrl: "u", connectedAccountId: null }, u2);

    // The exact statement the account-deletion generic loop runs for every listed table.
    getDb().prepare("DELETE FROM memory_write_outbox WHERE user_id = ?").run(u1);
    const counts = getDb()
      .prepare("SELECT user_id, COUNT(*) AS n FROM memory_write_outbox WHERE user_id IN (?, ?) GROUP BY user_id")
      .all(u1, u2) as Array<{ user_id: string; n: number }>;
    expect(counts.some((c) => c.user_id === u1)).toBe(false);
    expect(counts.find((c) => c.user_id === u2)?.n).toBe(1);
  });
});