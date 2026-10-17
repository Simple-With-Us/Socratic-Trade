/**
 * ST-4541 — regression tests for Seer review threads on PR #4736.
 *
 *   * 17915833/0 — the pre-embed near-duplicate gate could shrink `documentsToStore` under a managed
 *     commit, so `storeDocumentImpl`'s exact-cardinality checks never passed and the document was
 *     never promoted (persistReceipts/markCommitted) — a silent, permanent commit failure whenever
 *     the RAG_NEAR_DUP_SKIP env flag was enabled.
 *   * 17915833/1 — dedup lookups were not scoped by tenant or embedding space, so a chunk could be
 *     skipped against ANOTHER tenant's signature. A skip means "never write a vector", so the chunk
 *     would never exist in the skipping tenant's isolated namespace: silently unretrievable.
 *   * 17915833/2 — `dedupComplete: true` was returned even when every chunk was skipped as a NEAR
 *     (non-identical) duplicate, telling producers the batch was "already indexed" when no vector
 *     was ever written under that document's own metadata.
 *
 * Two properties make these tests meaningful rather than vacuous:
 *
 *  1. DIFFERENTIAL — each test first drives a path that MUST skip, proving the seeded signature is
 *     really discoverable in that scope and really is a match, and only then asserts on the path
 *     under test. Without the control half, a scope/seed mistake would make every assertion pass.
 *  2. ISOLATED CORPORA — every test mints its own `corpus(tag)` text. These tests share one SQLite
 *     file, and the normalized-hash lookup is scope-wide, so reusing one body across tests would let
 *     an embed from an earlier test become an EXACT reference for a later one and mask the bug.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL = `file:${join(tmpdir(), `socratic-near-dup-reviews-${randomUUID()}.db`)}`;

const mocks = vi.hoisted(() => {
  const upsert = vi.fn(async (_input: unknown) => undefined);
  const namespacedIndex = {
    upsert,
    query: vi.fn(async () => ({ matches: [] })),
    listPaginated: vi.fn(async () => ({ vectors: [] })),
    fetch: vi.fn(async () => ({ vectors: [] })),
    update: vi.fn(async () => undefined),
    deleteMany: vi.fn(async () => undefined)
  };
  const index = vi.fn(() => ({ ...namespacedIndex, namespace: vi.fn(() => namespacedIndex) }));
  return {
    upsert,
    index,
    // Echo one well-formed vector per input so the integrity guard is satisfied for any batch size.
    embed: vi.fn(async (args: { input: string[] }) => ({
      data: args.input.map((_text, i) => ({ embedding: [0.1, 0.2], index: i }))
    })),
    listIndexes: vi.fn(async () => ({ indexes: [{ name: "socratic-trade" }] })),
    createIndex: vi.fn(async () => undefined),
    describeIndex: vi.fn(async () => ({ dimension: 1024, metric: "cosine" }))
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

/**
 * `storeContextsImpl` prepends `[Published: <date>]` to the stored text BEFORE the near-duplicate
 * hash is computed, so a seeded signature built from the bare body would be compared against a
 * different string. Seeds therefore carry the same prefix, and every document carries the timestamp
 * that prefix is derived from.
 */
const PUBLISHED = "2026-04-21T01:00:00.000Z";
const PUBLISHED_PREFIX = "[Published: 2026-04-21] ";

/**
 * Mint a body plus the three variants each test needs. `near` adds only a short trailing sentence:
 * measured against `base` it scores ~0.94 exact Jaccard / ~0.94 MinHash — comfortably over the 0.9
 * default threshold — while normalizing to a DIFFERENT hash, so it classifies as `near` and not
 * `exact`. `reflowed` normalizes identically to `seed`, so it classifies as `exact`.
 */
function corpus(tag: string) {
  const base = `${tag} Acme Corporation reported net revenue of 412 million dollars for the third quarter, an increase of 8 percent over the prior year period. Gross margin expanded to 61 percent as the company continued to shift its mix toward higher margin software subscriptions. Operating expenses grew 4 percent year over year, below the pace of revenue growth, reflecting the benefits of the restructuring program completed in the prior fiscal year.`;
  return {
    /** What the seed row is built from — already carries the `[Published:]` prefix. */
    seed: `${PUBLISHED_PREFIX}${base}`,
    /** Input text for a `near` classification (the prefix is prepended by the code under test). */
    near: `${base} Reported figures are unaudited.`,
    /** Input text for an `exact` classification. Deliberately has NO prefix, so the code adds it. */
    reflowed: `  ${base.toUpperCase().replace(/\.\s/g, ".\n\n")}\n`
  };
}

beforeAll(async () => {
  process.env.PINECONE_API_KEY = "pinecone-test";
  process.env.VOYAGE_API_KEY = "voyage-test";
  process.env.PINECONE_INDEX_READY_WAIT_MS = "0";
  process.env.VECTOR_EMBED_BATCH_DELAY_MS = "0";
  process.env.VECTOR_ENABLE_RERANK = "off";
  process.env.HYBRID_RETRIEVAL = "off";
  const { getDb } = await import("../src/lib/db");
  getDb();
}, 60_000);

afterAll(() => {
  for (const key of [
    "DATABASE_URL",
    "PINECONE_API_KEY",
    "VOYAGE_API_KEY",
    "PINECONE_INDEX_READY_WAIT_MS",
    "VECTOR_EMBED_BATCH_DELAY_MS",
    "VECTOR_ENABLE_RERANK",
    "HYBRID_RETRIEVAL",
    "RAG_NEAR_DUP_SKIP"
  ]) {
    delete process.env[key];
  }
});

afterEach(() => {
  delete process.env.RAG_NEAR_DUP_SKIP;
  vi.clearAllMocks();
});

/**
 * Seed a signature row as if `seedText` had already been embedded in `scope`. Written directly
 * rather than by running an ingest so the test controls the isolation scope exactly.
 */
async function seedSignature(opts: {
  scope: { tenantScope: string; embedModel: string; embedRevision: string };
  seedText: string;
  contentHash: string;
  chunkId: string;
  symbol: string;
  source: string;
}) {
  const { insertChunkDedupSignatures } = await import("../src/lib/db-near-dup");
  const { encodeSignature, minhashSignature, normalizedContentHash } = await import(
    "../src/lib/rag/near-dup-embed"
  );
  const { shingleSet } = await import("../src/lib/rag/dedupe-similar");
  insertChunkDedupSignatures([
    {
      contentHash: opts.contentHash,
      normalizedHash: normalizedContentHash(opts.seedText),
      signature: encodeSignature(minhashSignature(shingleSet(opts.seedText))),
      numPerm: 64,
      symbol: opts.symbol,
      source: opts.source,
      chunkId: opts.chunkId,
      tenantScope: opts.scope.tenantScope,
      embedModel: opts.scope.embedModel,
      embedRevision: opts.scope.embedRevision
    }
  ]);
}

/** Derive the isolation scope a given caller would use, from the same helpers production uses. */
async function scopeFor(userId: string, scope?: "shared" | "private") {
  const { vectorTenantScope, activeEmbeddingModel, currentEmbedRev } = await import("../src/lib/vector-db");
  return {
    tenantScope: vectorTenantScope(userId, scope),
    embedModel: activeEmbeddingModel(userId),
    embedRevision: String(currentEmbedRev())
  };
}

describe("ST-4541 review 17915833/0 — managed commits are exempt from the near-dup gate", () => {
  it("still embeds and promotes a document whose chunk matches a near-duplicate signature", async () => {
    process.env.RAG_NEAR_DUP_SKIP = "1";
    const { storeContexts, storeDocument } = await import("../src/lib/vector-db");
    const c = corpus("Review thread 17915833/0 managed commit");
    const shared = await scopeFor("local");

    await seedSignature({
      scope: shared,
      seedText: c.seed,
      contentHash: "seed-managed-commit",
      chunkId: "seed-chunk",
      symbol: "MGMT",
      source: "earnings-transcript"
    });

    // Control: the plain (non-managed) path DOES find the seeded reference and skips the embed.
    // This proves the seed is discoverable in this scope and really is a near match — without it the
    // managed-commit assertions below could pass simply because nothing ever matched.
    const control = await storeContexts(
      [{ text: c.near, metadata: { symbol: "MGMT", source: "earnings-transcript", timestamp: PUBLISHED } }],
      "local",
      {}
    );
    expect(control.skippedByNearDuplicate).toBe(1);
    expect(control.indexed).toBe(0);

    // The managed path must ignore the gate entirely: it embeds, upserts, and commits.
    const result = await storeDocument({
      text: c.near,
      doc_id: "FMP-EARNINGS-TRANSCRIPT:MGMT:2026:Q1",
      ticker: "MGMT",
      title: "MGMT earnings call 2026 Q1",
      doc_type: "earnings-transcript",
      source: "earnings-transcript",
      published_at: "2026-04-20T20:00:00.000Z",
      acceptance_datetime: "2026-04-21T01:00:00.000Z"
    });

    expect(result.error).toBeUndefined();
    expect(result.skippedByNearDuplicate ?? 0).toBe(0);
    expect(result.indexed).toBe(result.attempted);
    // The regression itself: a managed commit must reach the committed state, not stall unpromoted.
    expect(result.documentComplete).toBe(true);
  }, 60_000);
});

describe("ST-4541 review 17915833/1 — dedup references are scoped to tenant + embedding space", () => {
  it("never lets one tenant's signature suppress another tenant's embed", async () => {
    process.env.RAG_NEAR_DUP_SKIP = "1";
    const { storeContexts } = await import("../src/lib/vector-db");
    const { getDb } = await import("../src/lib/db");
    const { findDedupReferencesByNormalizedHash, findRecentDedupReferences } = await import(
      "../src/lib/db-near-dup"
    );
    const { normalizedContentHash } = await import("../src/lib/rag/near-dup-embed");

    const c = corpus("Review thread 17915833/1 tenant isolation");
    const tenantA = await scopeFor("user-a", "private");
    const tenantB = await scopeFor("user-b", "private");
    expect(tenantA.tenantScope).not.toBe(tenantB.tenantScope);

    await seedSignature({
      scope: tenantA,
      seedText: c.seed,
      contentHash: "seed-tenant-a",
      chunkId: "seed-chunk-a",
      symbol: "TNTA",
      source: "earnings-transcript"
    });

    // Lookups are tenant-filtered: A finds its own row, B finds nothing.
    expect(findRecentDedupReferences(tenantA, "TNTA", "earnings-transcript").map((r) => r.contentHash)).toEqual([
      "seed-tenant-a"
    ]);
    expect(findRecentDedupReferences(tenantB, "TNTA", "earnings-transcript")).toHaveLength(0);
    expect(findDedupReferencesByNormalizedHash(tenantA, normalizedContentHash(c.seed))).toHaveLength(1);
    expect(findDedupReferencesByNormalizedHash(tenantB, normalizedContentHash(c.seed))).toHaveLength(0);

    // Control: tenant A re-ingesting the same text DOES skip — the seed is a live match.
    const tenantAResult = await storeContexts(
      [{ text: c.near, metadata: { symbol: "TNTA", source: "earnings-transcript", timestamp: PUBLISHED } }],
      "user-a",
      { scope: "private" }
    );
    expect(tenantAResult.skippedByNearDuplicate).toBe(1);
    expect(tenantAResult.indexed).toBe(0);

    // The actual fix: tenant B's identical text must still get its OWN vector in its own namespace.
    // Before the fix B skipped against A's signature and this chunk became unretrievable for B.
    const tenantBResult = await storeContexts(
      [{ text: c.near, metadata: { symbol: "TNTA", source: "earnings-transcript", timestamp: PUBLISHED } }],
      "user-b",
      { scope: "private" }
    );
    expect(tenantBResult.skippedByNearDuplicate ?? 0).toBe(0);
    expect(tenantBResult.indexed).toBe(tenantBResult.attempted);
    // B's embed is durably recorded under B's own scope, so B is a first-class dedup participant.
    const bRows = getDb()
      .prepare("SELECT COUNT(*) AS c FROM chunk_dedup_signatures WHERE tenant_scope = ?")
      .get(tenantB.tenantScope) as { c: number };
    expect(bRows.c).toBe(1);
  }, 60_000);

  it("never lets one embedding space's signature suppress another space's embed", async () => {
    process.env.RAG_NEAR_DUP_SKIP = "1";
    const { storeContexts } = await import("../src/lib/vector-db");
    const c = corpus("Review thread 17915833/1 embedding space isolation");
    const base = await scopeFor("local");
    const otherSpace = { ...base, embedRevision: `${base.embedRevision}-other` };

    await seedSignature({
      scope: otherSpace,
      seedText: c.seed,
      contentHash: "seed-other-rev",
      chunkId: "seed-chunk-rev",
      symbol: "SPACE",
      source: "earnings-transcript"
    });

    // A vector embedded in another space is not a valid substitute for this caller's space.
    const result = await storeContexts(
      [{ text: c.near, metadata: { symbol: "SPACE", source: "earnings-transcript", timestamp: PUBLISHED } }],
      "local",
      {}
    );
    expect(result.skippedByNearDuplicate ?? 0).toBe(0);
    expect(result.indexed).toBe(result.attempted);
  }, 60_000);
});

describe("ST-4541 review 17915833/2 — dedupComplete is only claimed for byte-identical content", () => {
  it("reports the batch as NOT complete when every chunk was skipped as a near duplicate", async () => {
    process.env.RAG_NEAR_DUP_SKIP = "1";
    const { storeContexts } = await import("../src/lib/vector-db");
    const c = corpus("Review thread 17915833/2 near skip is not completion");
    const shared = await scopeFor("local");
    await seedSignature({
      scope: shared,
      seedText: c.seed,
      contentHash: "seed-near-only",
      chunkId: "seed-chunk-near",
      symbol: "NEAR",
      source: "8-k"
    });

    const result = await storeContexts(
      [{ text: c.near, metadata: { symbol: "NEAR", source: "8-k", timestamp: PUBLISHED } }],
      "local",
      {}
    );

    expect(result.skippedByNearDuplicate).toBe(1);
    expect(result.indexed).toBe(0);
    // The fix: producers (sec8k clears its backlog, corpus-reembed records "reused") key off
    // dedupComplete. A near match wrote no vector under this document's own metadata, so claiming
    // completion would mark an unindexed record as delivered.
    expect(result.dedupComplete).toBeUndefined();
    expect(result.documentComplete).toBeUndefined();
  }, 60_000);

  it("still reports dedupComplete when the skip was byte-identical after normalization", async () => {
    process.env.RAG_NEAR_DUP_SKIP = "1";
    const { storeContexts } = await import("../src/lib/vector-db");
    const c = corpus("Review thread 17915833/2 exact skip is completion");
    const shared = await scopeFor("local");
    await seedSignature({
      scope: shared,
      seedText: c.seed,
      contentHash: "seed-exact",
      chunkId: "seed-chunk-exact",
      symbol: "EXAC",
      source: "10-k"
    });

    const result = await storeContexts(
      [{ text: c.reflowed, metadata: { symbol: "EXAC", source: "10-k", timestamp: PUBLISHED } }],
      "local",
      {}
    );

    expect(result.skippedByNearDuplicate).toBe(1);
    // An exact match means the canonical vector provably holds this same content, which is exactly
    // what dedupComplete promises — the pre-existing contract is preserved.
    expect(result.dedupComplete).toBe(true);
  }, 60_000);
});

describe("ST-4541 binding — a skipped embed never removes a stored record", () => {
  it("keeps the skipped chunk's own identity in a durable link row", async () => {
    process.env.RAG_NEAR_DUP_SKIP = "1";
    const { storeContexts } = await import("../src/lib/vector-db");
    const { getDb } = await import("../src/lib/db");
    const c = corpus("Review thread binding provenance survives the skip");
    const shared = await scopeFor("local");
    await seedSignature({
      scope: shared,
      seedText: c.seed,
      contentHash: "seed-binding",
      chunkId: "seed-chunk-binding",
      symbol: "BIND",
      source: "8-k"
    });

    await storeContexts(
      [{ text: c.near, metadata: { symbol: "BIND", source: "8-k", timestamp: PUBLISHED } }],
      "local",
      {}
    );

    const links = getDb()
      .prepare(
        "SELECT content_hash, canonical_hash, match_kind, tenant_scope FROM chunk_dedup_links WHERE symbol = 'BIND'"
      )
      .all() as Array<{ content_hash: string; canonical_hash: string; match_kind: string; tenant_scope: string }>;
    expect(links.length).toBeGreaterThan(0);
    // The duplicate keeps its OWN hash and points at the canonical — it is not merged or overwritten.
    expect(links[0]!.canonical_hash).toBe("seed-binding");
    expect(links[0]!.content_hash).not.toBe("seed-binding");
    expect(links[0]!.match_kind).toBe("near");
    expect(links[0]!.tenant_scope).toBe(shared.tenantScope);
    // The canonical's own signature row is still present and unmodified.
    const still = getDb()
      .prepare("SELECT content_hash FROM chunk_dedup_signatures WHERE content_hash = 'seed-binding'")
      .get();
    expect(still).toBeDefined();
  }, 60_000);
});

describe("ST-4541 Kody review — link rows name the canonical vector", () => {
  it("records the upserted vector id on the signature and carries it onto a later skip's link", async () => {
    process.env.RAG_NEAR_DUP_SKIP = "1";
    const { storeContexts } = await import("../src/lib/vector-db");
    const { getDb } = await import("../src/lib/db");
    const c = corpus("Kody review canonical vector id");

    // First ingest embeds and upserts; its signature must remember the id it was written under.
    const first = await storeContexts(
      [{ text: c.near, metadata: { symbol: "VECID", source: "8-k", timestamp: PUBLISHED } }],
      "local",
      {}
    );
    expect(first.indexed).toBe(1);
    const upsertInput = mocks.upsert.mock.calls.at(-1)?.[0] as { records: Array<{ id: string }> } | undefined;
    const upsertedId = upsertInput?.records[0]?.id;
    expect(upsertedId).toBeTruthy();
    const signature = getDb()
      .prepare("SELECT vector_id FROM chunk_dedup_signatures WHERE symbol = 'VECID'")
      .get() as { vector_id: string } | undefined;
    expect(signature?.vector_id).toBe(upsertedId);

    // A reflowed repeat is skipped, and its provenance row now names that vector instead of ''.
    const repeat = await storeContexts(
      [{ text: `  ${c.near.toUpperCase()}\n`, metadata: { symbol: "VECID", source: "8-k", timestamp: PUBLISHED } }],
      "local",
      {}
    );
    expect(repeat.skippedByNearDuplicate).toBe(1);
    const link = getDb()
      .prepare("SELECT canonical_vector_id, match_kind FROM chunk_dedup_links WHERE symbol = 'VECID'")
      .get() as { canonical_vector_id: string; match_kind: string } | undefined;
    expect(link?.match_kind).toBe("exact");
    expect(link?.canonical_vector_id).toBe(upsertedId);
  }, 60_000);
});

describe("ST-4541 Kody review — a partly rejected batch still records its indexed companions", () => {
  it("persists the signature of the chunk that was upserted, and none for the rejected one", async () => {
    process.env.RAG_NEAR_DUP_SKIP = "1";
    process.env.VECTOR_EMBED_BATCH_SIZE = "1";
    const defaultEmbed = mocks.embed.getMockImplementation();
    // One embed per POST (batch size 1); the POST carrying the marker returns a malformed vector,
    // which rejects that document alone while its companion still upserts.
    mocks.embed.mockImplementation(async (args: { input: string[] }) => ({
      data: args.input.map((text, i) => ({
        embedding: text.includes("REJECTMARKER") ? [] : [0.1, 0.2],
        index: i
      }))
    }));
    try {
      const { storeContexts } = await import("../src/lib/vector-db");
      const { getDb } = await import("../src/lib/db");
      const c = corpus("Kody review partial reject companion");
      const rejectedText =
        "REJECTMARKER Beta Industries said its logistics segment revenue declined 12 percent in the quarter, which management attributed to the loss of two large regional contracts and a slower freight market.";

      const result = await storeContexts(
        [
          { text: c.near, metadata: { symbol: "PART", source: "8-k", timestamp: PUBLISHED } },
          { text: rejectedText, metadata: { symbol: "PART", source: "10-q", timestamp: PUBLISHED } }
        ],
        "local",
        {}
      );

      // Control: the batch really was partial — one indexed, one rejected.
      expect(result.indexed).toBe(1);
      expect(result.rejectedInvalidEmbeddings ?? 0).toBeGreaterThan(0);

      const rows = getDb()
        .prepare("SELECT source, vector_id FROM chunk_dedup_signatures WHERE symbol = 'PART' ORDER BY source")
        .all() as Array<{ source: string; vector_id: string }>;
      // The fix: the indexed companion is recorded (the old guard dropped it because ANY reject
      // blocked the whole write), and the rejected chunk — which has no vector — is not.
      expect(rows.map((row) => row.source)).toEqual(["8-k"]);
      expect(rows[0]!.vector_id).toBeTruthy();
    } finally {
      delete process.env.VECTOR_EMBED_BATCH_SIZE;
      if (defaultEmbed) mocks.embed.mockImplementation(defaultEmbed);
    }
  }, 60_000);
});