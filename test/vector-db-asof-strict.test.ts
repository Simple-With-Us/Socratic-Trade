/**
 * R1 strict as-of mode (2026-07-01 RAG-expansion follow-on, item 2 / "adjacent, only if cheap").
 *
 * VECTOR_ASOF_STRICT is a NEW, default-OFF env flag: when set AND the caller passed
 * `options.asOf`, the retrieval pipeline DROPS chunks with no resolvable date stamp (after the
 * acceptance_datetime -> published_at -> as_of -> timestamp chain #297 already added) instead of
 * the lenient default of keeping them, and emits a drop-count `audit()` record. Behavior is
 * UNCHANGED when `asOf` is unset (the chat default) or when the flag is off — this file proves
 * both the byte-identical default and the flag's actual effect through the real
 * `retrieveContextDetailed` pipeline (full-mock Pinecone/Voyage, no live network), mirroring the
 * integration pattern in test/vector-db-rerank-floor.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const query = vi.fn();
  const index = vi.fn(() => ({ query, upsert: vi.fn() }));
  return {
    query,
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
  setInternalSetting: vi.fn()
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env.PINECONE_API_KEY = "pinecone-test";
  process.env.VOYAGE_API_KEY = "voyage-test";
  process.env.PINECONE_INDEX_READY_WAIT_MS = "0";
  process.env.VECTOR_ENABLE_RERANK = "off"; // isolate the as-of guard from rerank reordering
  delete process.env.HYBRID_RETRIEVAL;
  delete process.env.VECTOR_MIN_SCORE;
  delete process.env.VECTOR_ASOF_STRICT;

  mocks.resolveApiKey.mockImplementation((service: string) => {
    if (service === "pinecone") return process.env.PINECONE_API_KEY;
    if (service === "voyage") return process.env.VOYAGE_API_KEY;
    return undefined;
  });
  mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
  mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
});

// Golden as-of tuple: one undated chunk, one in-window dated chunk, one look-ahead dated chunk
// that must ALWAYS be excluded regardless of strict mode (that's the pre-existing, non-strict
// as-of guard, unaffected by this change).
const goldenPool = [
  { id: "undated", score: 0.9, metadata: { text: "no date stamp at all", userId: "local", scope: "shared" } },
  {
    id: "in-window",
    score: 0.85,
    metadata: { text: "dated, in window", userId: "local", scope: "shared", acceptance_datetime: "2026-05-01" }
  },
  {
    id: "look-ahead",
    score: 0.95,
    metadata: { text: "dated but after asOf", userId: "local", scope: "shared", acceptance_datetime: "2026-06-01" }
  }
];

describe("VECTOR_ASOF_STRICT golden tuple: undated-excluded-under-strict / included-without", () => {
  it("keeps the undated chunk when asOf is set and the flag is OFF (default/lenient)", async () => {
    delete process.env.VECTOR_ASOF_STRICT;
    mocks.query.mockResolvedValue({ matches: goldenPool });

    const { retrieveContextDetailed } = await import("../src/lib/vector-db");
    const chunks = await retrieveContextDetailed("q", "AAPL", 3, "local", { asOf: "2026-05-15" });

    expect(chunks.map((c) => c.id).sort()).toEqual(["in-window", "undated"]);
    expect(mocks.audit).not.toHaveBeenCalledWith("vector_asof_strict_drop", expect.anything(), expect.anything());
  });

  it("drops the undated chunk when asOf is set and VECTOR_ASOF_STRICT=on, keeping only the in-window dated chunk", async () => {
    process.env.VECTOR_ASOF_STRICT = "on";
    mocks.query.mockResolvedValue({ matches: goldenPool });

    const { retrieveContextDetailed } = await import("../src/lib/vector-db");
    const chunks = await retrieveContextDetailed("q", "AAPL", 3, "local", { asOf: "2026-05-15" });

    expect(chunks.map((c) => c.id)).toEqual(["in-window"]);
    expect(mocks.audit).toHaveBeenCalledWith(
      "vector_asof_strict_drop",
      expect.objectContaining({ droppedUndated: 1, asOf: "2026-05-15" }),
      "local"
    );
  });

  it("the look-ahead (dated but after asOf) chunk is excluded in BOTH modes — strict mode only changes undated handling", async () => {
    for (const strict of ["on", "off"]) {
      process.env.VECTOR_ASOF_STRICT = strict;
      mocks.query.mockResolvedValue({ matches: goldenPool });
      const { retrieveContextDetailed } = await import("../src/lib/vector-db");
      const chunks = await retrieveContextDetailed("q", "AAPL", 3, "local", { asOf: "2026-05-15" });
      expect(chunks.map((c) => c.id)).not.toContain("look-ahead");
      vi.resetModules();
    }
  });

  it("is a complete no-op when asOf is unset, even with VECTOR_ASOF_STRICT=on (undated chunks always kept)", async () => {
    process.env.VECTOR_ASOF_STRICT = "on";
    mocks.query.mockResolvedValue({ matches: goldenPool });

    const { retrieveContextDetailed } = await import("../src/lib/vector-db");
    const chunks = await retrieveContextDetailed("q", "AAPL", 3, "local"); // no options at all

    // No asOf constraint active at all -> nothing filtered by the as-of guard in either mode.
    expect(chunks.map((c) => c.id).sort()).toEqual(["in-window", "look-ahead", "undated"]);
    expect(mocks.audit).not.toHaveBeenCalledWith("vector_asof_strict_drop", expect.anything(), expect.anything());
  });

  it("default retrieval (VECTOR_ASOF_STRICT unset, matching production default) is byte-for-byte the pre-R1-strict lenient behavior", async () => {
    delete process.env.VECTOR_ASOF_STRICT; // production default: unset
    mocks.query.mockResolvedValue({ matches: goldenPool });

    const { retrieveContextDetailed, asOfStrictEnabled } = await import("../src/lib/vector-db");
    expect(asOfStrictEnabled()).toBe(false);

    const chunks = await retrieveContextDetailed("q", "AAPL", 3, "local", { asOf: "2026-05-15" });
    expect(chunks.map((c) => c.id).sort()).toEqual(["in-window", "undated"]);
  });
});
