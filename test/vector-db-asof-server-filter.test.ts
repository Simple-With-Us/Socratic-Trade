/**
 * server-asof-filter (2026-07-06): server-side point-in-time (as-of) filtering in Pinecone.
 *
 * When `options.asOf` is set AND VECTOR_ASOF_SERVER_FILTER=on, the retrieval pipeline pushes the
 * date constraint INTO the Pinecone query so topK is filled with ELIGIBLE (pre-asOf) candidates,
 * instead of the pre-existing behavior where the pure-vector top-K is dominated by too-recent
 * filings that the POST-fetch `isWithinAsOf` guard then decimates (empty/small pools in backtests).
 *
 * Two semantics (owner-approved):
 *  - FAIL-OPEN (default): keep epoch'd-and-eligible OR un-epoch'd vectors server-side, so an
 *    un-backfilled corpus is NOT dropped; the post-fetch guard stays the real leakage gate.
 *  - FAIL-CLOSED (VECTOR_ASOF_STRICT on): drop un-epoch'd server-side.
 *
 * These tests drive the real `retrieveContextDetailed` pipeline with a full Pinecone/Voyage mock
 * (no network), mirroring test/vector-db-asof-strict.test.ts, and assert both the Pinecone `filter`
 * SHAPE and the end-to-end kept/dropped set. Backfill + ingest-write cases exercise the pure
 * helpers directly.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const query = vi.fn();
  const listPaginated = vi.fn();
  const fetch = vi.fn();
  const update = vi.fn();
  const index = vi.fn(() => ({ query, upsert: vi.fn(), listPaginated, fetch, update }));
  return {
    query,
    listPaginated,
    fetch,
    update,
    index,
    listIndexes: vi.fn(),
    embed: vi.fn(),
    rerank: vi.fn(),
    resolveApiKey: vi.fn(),
    audit: vi.fn()
  };
});

vi.mock("@pinecone-database/pinecone", () => ({
  Pinecone: vi.fn(function Pinecone() {
    return { listIndexes: mocks.listIndexes, createIndex: vi.fn(), Index: mocks.index };
  })
}));

vi.mock("voyageai", () => ({
  VoyageAIClient: vi.fn(function VoyageAIClient() {
    return { embed: mocks.embed, rerank: mocks.rerank };
  })
}));

vi.mock("../src/lib/db", () => ({
  resolveApiKey: mocks.resolveApiKey,
  audit: mocks.audit,
  setInternalSetting: vi.fn(),
  getDb: () => ({
    prepare: () => ({ get: () => undefined })
  })
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env.PINECONE_API_KEY = "pinecone-test";
  process.env.VOYAGE_API_KEY = "voyage-test";
  process.env.PINECONE_INDEX_READY_WAIT_MS = "0";
  process.env.VECTOR_ENABLE_RERANK = "off"; // isolate the as-of filter from rerank reordering
  delete process.env.HYBRID_RETRIEVAL;
  delete process.env.VECTOR_MIN_SCORE;
  delete process.env.VECTOR_ASOF_STRICT;
  // Explicit off so these tests stay independent of the production default ON (2026-07-24).
  process.env.VECTOR_ASOF_SERVER_FILTER = "off";

  mocks.resolveApiKey.mockImplementation((service: string) => {
    if (service === "pinecone") return process.env.PINECONE_API_KEY;
    if (service === "voyage") return process.env.VOYAGE_API_KEY;
    return undefined;
  });
  mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
  mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
});

// A pool with one un-epoch'd (undated) chunk and one epoch'd, in-window chunk. Both carry
// `acceptance_datetime` ISO strings so the POST-fetch guard resolves them, but only the second
// carries the NUMERIC `as_of_epoch_ms` a backfilled/newly-ingested vector would have.
const AS_OF = "2026-05-15";
const AS_OF_MS = Date.parse(AS_OF);
const IN_WINDOW_EPOCH = Date.parse("2026-05-01");
const AFTER_EPOCH = Date.parse("2026-06-01");

function extractQueryFilter(): Record<string, unknown> {
  const call = mocks.query.mock.calls.at(-1);
  expect(call).toBeTruthy();
  return (call![0] as { filter: Record<string, unknown> }).filter;
}

const COMMITTED_RECEIPT_CLAUSE = {
  $or: [
    { receipt_required: { $exists: false } },
    { receipt_required: { $eq: false } },
    { ingest_state: { $eq: "committed" } }
  ]
};

function unwrapCommittedFilter(filter: Record<string, unknown>): Record<string, unknown> {
  expect(Array.isArray(filter.$and)).toBe(true);
  const clauses = filter.$and as Record<string, unknown>[];
  expect(clauses).toHaveLength(2);
  expect(clauses[1]).toEqual(COMMITTED_RECEIPT_CLAUSE);
  return clauses[0]!;
}

describe("server-asof-filter: Pinecone query filter shape", () => {
  it("(a) asOf set + VECTOR_ASOF_SERVER_FILTER=on (FAIL-OPEN): filter carries $and with the $lte-or-$exists:false epoch clause", async () => {
    process.env.VECTOR_ASOF_SERVER_FILTER = "on";
    mocks.query.mockResolvedValue({ matches: [] });

    const { retrieveContextDetailed } = await import("../src/lib/vector-db");
    await retrieveContextDetailed("q", "AAPL", 3, "local", { asOf: AS_OF });

    const filter = unwrapCommittedFilter(extractQueryFilter());
    expect(Array.isArray(filter.$and)).toBe(true);
    const clauses = filter.$and as Record<string, unknown>[];
    // one clause is the base (symbol/scope-coexistence), the other is the epoch $or
    const epochClause = clauses.find((c) => Array.isArray((c as { $or?: unknown }).$or) && JSON.stringify(c).includes("as_of_epoch_ms"));
    expect(epochClause).toBeTruthy();
    expect(epochClause).toEqual({
      $or: [{ as_of_epoch_ms: { $lte: AS_OF_MS } }, { as_of_epoch_ms: { $exists: false } }]
    });
    // base scope-coexistence $or is preserved inside the $and (not clobbered by the epoch $or)
    const baseClause = clauses.find((c) => JSON.stringify(c).includes("scope"));
    expect(baseClause).toBeTruthy();
    expect((baseClause as { $or: unknown[] }).$or).toEqual([
      { scope: { $eq: "shared" } },
      {
        $and: [
          { userId: { $eq: "local" } },
          { scope: { $exists: false } }
        ]
      }
    ]);
  });

  it("(a/strict) asOf set + server filter + VECTOR_ASOF_STRICT=on (FAIL-CLOSED): epoch clause is a plain $lte with NO $exists branch", async () => {
    process.env.VECTOR_ASOF_SERVER_FILTER = "on";
    process.env.VECTOR_ASOF_STRICT = "on";
    mocks.query.mockResolvedValue({ matches: [] });

    const { retrieveContextDetailed } = await import("../src/lib/vector-db");
    await retrieveContextDetailed("q", "AAPL", 3, "local", { asOf: AS_OF });

    const filter = unwrapCommittedFilter(extractQueryFilter());
    const clauses = filter.$and as Record<string, unknown>[];
    const epochClause = clauses.find((c) => JSON.stringify(c).includes("as_of_epoch_ms"));
    expect(epochClause).toEqual({ as_of_epoch_ms: { $lte: AS_OF_MS } });
    // The point-in-time clause itself has no $exists branch. Independent scope and committed-receipt
    // compatibility guards deliberately retain theirs for legacy vectors.
    expect(JSON.stringify(epochClause)).not.toContain("$exists");
  });

  it("(d) asOf UNSET: no epoch clause, filter byte-identical to today (top-level scope $or, no $and)", async () => {
    process.env.VECTOR_ASOF_SERVER_FILTER = "on"; // even with the flag ON, an unset asOf adds nothing
    mocks.query.mockResolvedValue({ matches: [] });

    const { retrieveContextDetailed } = await import("../src/lib/vector-db");
    await retrieveContextDetailed("q", "AAPL", 3, "local", {});

    const filter = unwrapCommittedFilter(extractQueryFilter());
    expect(filter.$and).toBeUndefined();
    expect(JSON.stringify(filter)).not.toContain("as_of_epoch_ms");
    expect(filter).toEqual({
      symbol: { $eq: "AAPL" },
      $or: [
        { scope: { $eq: "shared" } },
        { $and: [{ userId: { $eq: "local" } }, { scope: { $exists: false } }] }
      ]
    });
  });

  it("(d2) asOf set but server filter FLAG OFF: no epoch clause — byte-identical to pre-enablement", async () => {
    process.env.VECTOR_ASOF_SERVER_FILTER = "off";
    mocks.query.mockResolvedValue({ matches: [] });

    const { retrieveContextDetailed } = await import("../src/lib/vector-db");
    await retrieveContextDetailed("q", "AAPL", 3, "local", { asOf: AS_OF });

    const filter = unwrapCommittedFilter(extractQueryFilter());
    expect(filter.$and).toBeUndefined();
    expect(JSON.stringify(filter)).not.toContain("as_of_epoch_ms");
    expect(filter).toEqual({
      symbol: { $eq: "AAPL" },
      $or: [
        { scope: { $eq: "shared" } },
        { $and: [{ userId: { $eq: "local" } }, { scope: { $exists: false } }] }
      ]
    });
  });
});

describe("server-asof-filter: fail-open + post-fetch backstop (defense in depth)", () => {
  it("(b) FAIL-OPEN keeps an un-epoch'd vector server-side; the post-fetch isWithinAsOf guard still drops a dated-after-asOf chunk", async () => {
    process.env.VECTOR_ASOF_SERVER_FILTER = "on";
    // The mocked server path returns everything (we assert the filter shape separately). This proves
    // the INVARIANT: server filtering never removes the post-fetch guard. The undated vector (which
    // the fail-open server clause would keep) survives; the dated-after-asOf vector is dropped by the
    // post-fetch backstop even though the fail-open server clause did not exclude it here.
    mocks.query.mockResolvedValue({
      matches: [
        { id: "undated", score: 0.9, metadata: { text: "no date at all", userId: "local", scope: "shared" } },
        {
          id: "in-window",
          score: 0.85,
          metadata: { text: "dated in window", userId: "local", scope: "shared", acceptance_datetime: "2026-05-01", as_of_epoch_ms: IN_WINDOW_EPOCH }
        },
        {
          id: "after",
          score: 0.95,
          metadata: { text: "dated after asOf", userId: "local", scope: "shared", acceptance_datetime: "2026-06-01", as_of_epoch_ms: AFTER_EPOCH }
        }
      ]
    });

    const { retrieveContextDetailed } = await import("../src/lib/vector-db");
    const chunks = await retrieveContextDetailed("q", "AAPL", 3, "local", { asOf: AS_OF });

    const ids = chunks.map((c) => c.id).sort();
    // undated kept (fail-open, lenient post-fetch); in-window kept; after DROPPED by post-fetch guard
    expect(ids).toEqual(["in-window", "undated"]);
    expect(ids).not.toContain("after");
  });
});

describe("server-asof-filter: ingest write (cleanMetadata via resolveAsOfEpochMs)", () => {
  it("(e) resolveAsOfEpochMs derives the epoch from acceptance_datetime (precedence) and is absent/NaN-safe when undated", async () => {
    const { resolveAsOfEpochMs } = await import("../src/lib/vector-db");
    // acceptance_datetime wins over the others
    expect(
      resolveAsOfEpochMs({ acceptance_datetime: "2026-05-01", published_at: "2020-01-01", timestamp: "2019-01-01" })
    ).toBe(Date.parse("2026-05-01"));
    // falls back through the precedence chain
    expect(resolveAsOfEpochMs({ published_at: "2026-05-01" })).toBe(Date.parse("2026-05-01"));
    expect(resolveAsOfEpochMs({ as_of: "2026-05-01" })).toBe(Date.parse("2026-05-01"));
    expect(resolveAsOfEpochMs({ timestamp: "2026-05-01" })).toBe(Date.parse("2026-05-01"));
    // numeric epoch passes through
    expect(resolveAsOfEpochMs({ timestamp: 1700000000000 })).toBe(1700000000000);
    // undated / unparseable -> undefined (absence is the fail-open signal, NEVER 0/NaN)
    expect(resolveAsOfEpochMs({})).toBeUndefined();
    expect(resolveAsOfEpochMs(undefined)).toBeUndefined();
    expect(resolveAsOfEpochMs({ acceptance_datetime: "not-a-date" })).toBeUndefined();
  });

  it("(e2) storeContexts upserts as_of_epoch_ms derived from acceptance_datetime, and leaves it ABSENT for an undated doc", async () => {
    const upsertSpy = vi.fn().mockResolvedValue(undefined);
    mocks.index.mockReturnValue({ query: mocks.query, upsert: upsertSpy, listPaginated: mocks.listPaginated, fetch: mocks.fetch, update: mocks.update });
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }, { embedding: [0.4, 0.5, 0.6] }] });

    const { storeContexts } = await import("../src/lib/vector-db");
    await storeContexts(
      [
        { text: "dated doc", metadata: { symbol: "AAPL", source: "sec-8k", timestamp: "2026-05-01", acceptance_datetime: "2026-05-01T12:00:00Z" } },
        { text: "undated doc", metadata: { symbol: "AAPL", source: "note", timestamp: "" } }
      ],
      "local"
    );

    expect(upsertSpy).toHaveBeenCalled();
    // Pinecone JS SDK v8 upsert takes `{ records: [...] }`, not a bare array.
    const upserted = (upsertSpy.mock.calls[0]![0] as { records: Array<{ metadata: Record<string, unknown> }> }).records;
    const textOf = (r: { metadata: Record<string, unknown> }) => String(r.metadata.text ?? "");
    const dated = upserted.find((r) => textOf(r).includes("dated doc") && !textOf(r).includes("undated doc"));
    const undated = upserted.find((r) => textOf(r).includes("undated doc"));
    expect(dated?.metadata.as_of_epoch_ms).toBe(Date.parse("2026-05-01T12:00:00Z"));
    expect(undated?.metadata).toBeTruthy();
    expect("as_of_epoch_ms" in (undated!.metadata)).toBe(false);
  });
});

describe("server-asof-filter: backfill (computeBackfillEpochUpdate + backfillAsOfEpoch)", () => {
  it("(f) computeBackfillEpochUpdate: computes epoch for un-epoch'd, is idempotent (skips already-set), NaN-safe (undated)", async () => {
    const { computeBackfillEpochUpdate } = await import("../src/lib/vector-db");
    // un-epoch'd but dated -> update
    expect(computeBackfillEpochUpdate({ acceptance_datetime: "2026-05-01" })).toEqual({
      action: "update",
      epochMs: Date.parse("2026-05-01")
    });
    // already has a finite epoch -> idempotent skip
    expect(computeBackfillEpochUpdate({ acceptance_datetime: "2026-05-01", as_of_epoch_ms: 123 })).toEqual({
      action: "skip-has-epoch"
    });
    // un-epoch'd and undated -> leave absent
    expect(computeBackfillEpochUpdate({})).toEqual({ action: "skip-undated" });
    expect(computeBackfillEpochUpdate({ acceptance_datetime: "garbage" })).toEqual({ action: "skip-undated" });
    // stray non-finite epoch treated as not-set so a re-run can correct it
    expect(computeBackfillEpochUpdate({ acceptance_datetime: "2026-05-01", as_of_epoch_ms: Number.NaN })).toEqual({
      action: "update",
      epochMs: Date.parse("2026-05-01")
    });
  });

  it("(f2) backfillAsOfEpoch: updates only un-epoch'd dated vectors, skips already-set + undated, is idempotent", async () => {
    mocks.listPaginated.mockResolvedValueOnce({
      vectors: [{ id: "v-dated" }, { id: "v-hasEpoch" }, { id: "v-undated" }],
      pagination: undefined
    });
    mocks.fetch.mockResolvedValueOnce({
      records: {
        "v-dated": { id: "v-dated", metadata: { acceptance_datetime: "2026-05-01" } },
        "v-hasEpoch": { id: "v-hasEpoch", metadata: { acceptance_datetime: "2026-05-01", as_of_epoch_ms: 999 } },
        "v-undated": { id: "v-undated", metadata: { text: "no date" } }
      }
    });
    mocks.update.mockResolvedValue(undefined);

    const { backfillAsOfEpoch } = await import("../src/lib/vector-db");
    const result = await backfillAsOfEpoch({ userId: "local" });

    expect(result.scanned).toBe(3);
    expect(result.updated).toBe(1);
    expect(result.skippedHasEpoch).toBe(1);
    expect(result.skippedUndated).toBe(1);
    expect(result.errors).toBe(0);
    // exactly one update, for the un-epoch'd dated vector, with the derived epoch
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenCalledWith({ id: "v-dated", metadata: { as_of_epoch_ms: Date.parse("2026-05-01") } });
  });

  it("(f3) backfillAsOfEpoch dryRun: counts would-be updates but issues NO Pinecone update calls", async () => {
    mocks.listPaginated.mockResolvedValueOnce({
      vectors: [{ id: "v-dated" }],
      pagination: undefined
    });
    mocks.fetch.mockResolvedValueOnce({
      records: { "v-dated": { id: "v-dated", metadata: { acceptance_datetime: "2026-05-01" } } }
    });

    const { backfillAsOfEpoch } = await import("../src/lib/vector-db");
    const result = await backfillAsOfEpoch({ userId: "local", dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.updated).toBe(1);
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
