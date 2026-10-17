/**
 * ST-4541 — near-duplicate signature/links persistence (real temp SQLite).
 *
 * Two things are asserted here that the pure-logic suite cannot cover:
 *  1. the reference lookups actually find and rank previously embedded chunks for a (symbol, source)
 *     scope, and round-trip a MinHash signature through a real BLOB column;
 *  2. the BINDING — a skipped embed writes a durable, idempotent provenance row and DELETES NOTHING.
 *     The final test asserts this at the source level too: the ST directive requires that no code
 *     in this path prunes, caps or drops stored RAG records.
 */
import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "fs";
import path from "path";
import os from "os";

const tmpDir = path.join(os.tmpdir(), `trading-test-near-dup-${Date.now()}`);
const tmpDbPath = path.join(tmpDir, "test.db");
if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });

// Point DATABASE_URL at the temp file BEFORE db.ts is imported, so the real schema (including the
// ST-4541 tables) is created against an isolated database.
process.env.DATABASE_URL = `file:${tmpDbPath}`;

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { unlinkSync(`${tmpDbPath}${suffix}`); } catch { /* best-effort */ }
  }
});

const {
  countChunkDedupLinks,
  countChunkDedupSignatures,
  findDedupReferencesByNormalizedHash,
  findRecentDedupReferences,
  insertChunkDedupLinks,
  insertChunkDedupSignatures
} = await import("../src/lib/db-near-dup");
const { getDb } = await import("../src/lib/db");
const { encodeSignature, minhashSignature, normalizedContentHash } = await import("../src/lib/rag/near-dup-embed");
const { shingleSet } = await import("../src/lib/rag/dedupe-similar");

const TEXT_A =
  "Acme Corporation reported net revenue of 412 million dollars for the third quarter, an increase of 8 percent over the prior year period. Gross margin expanded to 61 percent.";

/** Default isolation scope for this suite: one tenant, one embedding space. */
const SCOPE = { tenantScope: "shared:operator", embedModel: "voyage-finance-2", embedRevision: "1" };
/** A different tenant in the same embedding space — must never match SCOPE rows. */
const OTHER_TENANT = { tenantScope: "private:aaaa", embedModel: "voyage-finance-2", embedRevision: "1" };

function signatureRow(text: string, contentHash: string, symbol: string, source: string, chunkId: string) {
  return {
    contentHash,
    normalizedHash: normalizedContentHash(text),
    signature: encodeSignature(minhashSignature(shingleSet(text))),
    numPerm: 64,
    symbol,
    source,
    chunkId,
    tenantScope: SCOPE.tenantScope,
    embedModel: SCOPE.embedModel,
    embedRevision: SCOPE.embedRevision
  };
}

describe("ST-4541 near-dup persistence — signatures", () => {
  it("creates both new tables with the expected columns", () => {
    const db = getDb();
    const signatureCols = db.prepare("PRAGMA table_info(chunk_dedup_signatures)").all() as Array<{ name: string }>;
    const linkCols = db.prepare("PRAGMA table_info(chunk_dedup_links)").all() as Array<{ name: string }>;
    expect(signatureCols.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        "content_hash",
        "normalized_hash",
        "signature",
        "num_perm",
        "symbol",
        "source",
        "chunk_id",
        "vector_id",
        "created_at"
      ])
    );
    expect(linkCols.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        "content_hash",
        "canonical_hash",
        "canonical_chunk_id",
        "canonical_vector_id",
        "symbol",
        "source",
        "match_kind",
        "similarity",
        "threshold",
        "created_at"
      ])
    );
  });

  it("round-trips a signature through the BLOB column and returns comparable references", () => {
    insertChunkDedupSignatures([signatureRow(TEXT_A, "ca1", "ACME", "8-k", "chunk-a1")]);
    const refs = findRecentDedupReferences(SCOPE, "ACME", "8-k");
    const mine = refs.find((r) => r.contentHash === "ca1");
    expect(mine).toBeDefined();
    expect(mine!.chunkId).toBe("chunk-a1");
    expect(mine!.signature).toBeDefined();
    expect(mine!.signature!.length).toBe(64);
    // The decoded stored signature must still match a freshly-computed one for the same text.
    const fresh = minhashSignature(shingleSet(TEXT_A));
    expect(Array.from(mine!.signature!)).toEqual(Array.from(fresh));
  });

  it("round-trips the upserted vector id so a later link can name the canonical vector", () => {
    // Kody review on PR #4736: links always wrote canonical_vector_id = '' because the signature row
    // never stored the vector id and the lookups never returned one.
    const vidText = "Vector id probe disclosure text recorded with the id it was upserted under.";
    insertChunkDedupSignatures([{ ...signatureRow(vidText, "vid1", "VID", "8-k", "vid-chunk"), vectorId: "8-k:VID:0001" }]);
    expect(findRecentDedupReferences(SCOPE, "VID", "8-k").map((r) => r.vectorId)).toEqual(["8-k:VID:0001"]);
    expect(findDedupReferencesByNormalizedHash(SCOPE, normalizedContentHash(vidText)).map((r) => r.vectorId)).toEqual([
      "8-k:VID:0001"
    ]);
    // A row written without one reads back as null, never as a fabricated id.
    insertChunkDedupSignatures([signatureRow(`${vidText} legacy`, "vid2", "VID", "10-q", "vid-chunk-2")]);
    expect(findRecentDedupReferences(SCOPE, "VID", "10-q").map((r) => r.vectorId)).toEqual([null]);
  });

  it("scopes reference lookup to (symbol, source) and bounds it by the window", () => {
    insertChunkDedupSignatures([
      signatureRow(`${TEXT_A} one`, "sc1", "ZZZ", "10-k", "c1"),
      signatureRow(`${TEXT_A} two`, "sc2", "ZZZ", "10-k", "c2"),
      signatureRow(`${TEXT_A} three`, "sc3", "ZZZ", "10-q", "c3")
    ]);
    const scoped = findRecentDedupReferences(SCOPE, "ZZZ", "10-k");
    expect(scoped.map((r) => r.contentHash).sort()).toEqual(["sc1", "sc2"]);
    // The window bounds comparison work only — it must never remove stored rows.
    expect(findRecentDedupReferences(SCOPE, "ZZZ", "10-k", 1)).toHaveLength(1);
    expect(findRecentDedupReferences(SCOPE, "ZZZ", "10-q").map((r) => r.contentHash)).toEqual(["sc3"]);
    expect(findRecentDedupReferences(SCOPE, "NOT-A-SYMBOL", "10-k")).toHaveLength(0);
    const db = getDb();
    expect((db.prepare("SELECT COUNT(*) AS c FROM chunk_dedup_signatures WHERE symbol = 'ZZZ'").get() as { c: number }).c).toBe(3);
  });

  it("finds a normalized-hash match across scopes (a repeat re-stamped with a new accession)", () => {
    const row = signatureRow("Some recurring disclosure text that is ingested under many accessions.", "nh1", "AAA", "8-k", "c-nh");
    insertChunkDedupSignatures([row]);
    const byHash = findDedupReferencesByNormalizedHash(SCOPE, normalizedContentHash("  Some RECURRING   disclosure text that is ingested under many accessions.\n"));
    expect(byHash.map((r) => r.contentHash)).toContain("nh1");
    expect(findDedupReferencesByNormalizedHash(SCOPE, "deadbeef")).toHaveLength(0);
  });

  it("is idempotent: re-recording the same signature never duplicates or overwrites a row", () => {
    const before = countChunkDedupSignatures();
    insertChunkDedupSignatures([signatureRow(TEXT_A, "ca1", "ACME", "8-k", "chunk-a1")]);
    expect(countChunkDedupSignatures()).toBe(before);
  });

  it("ISOLATION: lookups never return another tenant's or another vector space's signatures", () => {
    // Own text: TEXT_A is already seeded by earlier tests with an identical normalized hash, and the
    // hash lookup is scope-wide, so reusing it would leak a second row into these assertions.
    const isoText = "Isolation probe disclosure text that belongs to exactly one tenant scope only.";
    insertChunkDedupSignatures([signatureRow(isoText, "iso1", "ISO", "10-k", "iso-chunk")]);

    // Same tenant + space: the row is visible.
    expect(findRecentDedupReferences(SCOPE, "ISO", "10-k").map((r) => r.contentHash)).toEqual(["iso1"]);
    expect(findDedupReferencesByNormalizedHash(SCOPE, normalizedContentHash(isoText)).map((r) => r.contentHash)).toEqual(["iso1"]);

    // A different tenant holding byte-identical content must NOT see it: skipping against another
    // tenant's signature means "never write a vector", which would leave the chunk unretrievable in
    // the skipping tenant's isolated namespace.
    expect(findRecentDedupReferences(OTHER_TENANT, "ISO", "10-k")).toHaveLength(0);
    expect(findDedupReferencesByNormalizedHash(OTHER_TENANT, normalizedContentHash(isoText))).toHaveLength(0);

    // Nor may another EMBEDDING SPACE reuse it — a vector from a different space is not a valid
    // substitute for this caller's space.
    const otherSpace = { ...SCOPE, embedRevision: "999" };
    expect(findRecentDedupReferences(otherSpace, "ISO", "10-k")).toHaveLength(0);
    expect(findDedupReferencesByNormalizedHash(otherSpace, normalizedContentHash(isoText))).toHaveLength(0);
  });

  it("ISOLATION: two tenants embedding identical text each keep their own signature row", () => {
    const twinText = "Two tenants embedding byte identical disclosure text under one content hash.";
    const otherTenantRow = {
      ...signatureRow(twinText, "twin1", "TWIN", "10-q", "twin-chunk"),
      tenantScope: OTHER_TENANT.tenantScope
    };
    // Same content_hash + same symbol/source, different tenant. Before the isolation columns were
    // part of the primary key, the second tenant's INSERT was silently swallowed by OR IGNORE and
    // that tenant could never dedup at all.
    insertChunkDedupSignatures([signatureRow(twinText, "twin1", "TWIN", "10-q", "twin-chunk"), otherTenantRow]);
    const db = getDb();
    const rows = db
      .prepare("SELECT tenant_scope FROM chunk_dedup_signatures WHERE content_hash = 'twin1' ORDER BY tenant_scope")
      .all() as Array<{ tenant_scope: string }>;
    expect(rows.map((r) => r.tenant_scope)).toEqual([OTHER_TENANT.tenantScope, SCOPE.tenantScope].sort());
  });
});

describe("ST-4541 near-dup persistence — provenance links (binding: nothing is dropped)", () => {
  it("records the skipped chunk's own identity alongside the canonical it points at", () => {
    const before = countChunkDedupLinks();
    insertChunkDedupLinks([
      {
        contentHash: "dup1",
        canonicalHash: "ca1",
        canonicalChunkId: "chunk-a1",
        canonicalVectorId: "vec-a1",
        symbol: "ACME",
        source: "8-k",
        kind: "near",
        similarity: 0.93,
        threshold: 0.9,
        tenantScope: SCOPE.tenantScope,
        embedModel: SCOPE.embedModel,
        embedRevision: SCOPE.embedRevision
      }
    ]);
    expect(countChunkDedupLinks()).toBe(before + 1);
    const row = getDb()
      .prepare("SELECT * FROM chunk_dedup_links WHERE content_hash = 'dup1'")
      .get() as Record<string, unknown>;
    // The DUPLICATE keeps its own content_hash — it was not overwritten by or merged into the canonical.
    expect(row.content_hash).toBe("dup1");
    expect(row.canonical_hash).toBe("ca1");
    expect(row.canonical_vector_id).toBe("vec-a1");
    expect(row.match_kind).toBe("near");
    expect(row.similarity).toBeCloseTo(0.93, 5);
    expect(row.threshold).toBeCloseTo(0.9, 5);
  });

  it("keeps EVERY canonical a duplicate matched, and stays idempotent on re-run", () => {
    insertChunkDedupLinks([
      { contentHash: "dup2", canonicalHash: "ca1", canonicalChunkId: "c1", symbol: "ACME", source: "8-k", kind: "near", similarity: 0.91, threshold: 0.9, tenantScope: SCOPE.tenantScope, embedModel: SCOPE.embedModel, embedRevision: SCOPE.embedRevision },
      { contentHash: "dup2", canonicalHash: "ca2", canonicalChunkId: "c2", symbol: "ACME", source: "8-k", kind: "near", similarity: 0.92, threshold: 0.9, tenantScope: SCOPE.tenantScope, embedModel: SCOPE.embedModel, embedRevision: SCOPE.embedRevision }
    ]);
    const links = getDb().prepare("SELECT canonical_hash FROM chunk_dedup_links WHERE content_hash = 'dup2' ORDER BY canonical_hash").all() as Array<{ canonical_hash: string }>;
    expect(links.map((l) => l.canonical_hash)).toEqual(["ca1", "ca2"]);

    const count = countChunkDedupLinks();
    insertChunkDedupLinks([
      { contentHash: "dup2", canonicalHash: "ca1", canonicalChunkId: "c1", symbol: "ACME", source: "8-k", kind: "near", similarity: 0.91, threshold: 0.9, tenantScope: SCOPE.tenantScope, embedModel: SCOPE.embedModel, embedRevision: SCOPE.embedRevision }
    ]);
    expect(countChunkDedupLinks()).toBe(count);
  });

  it("rejects an unknown match_kind at the schema level", () => {
    expect(() =>
      getDb()
        .prepare(
          `INSERT INTO chunk_dedup_links
             (content_hash, canonical_hash, canonical_chunk_id, symbol, source, match_kind, similarity, threshold, created_at)
           VALUES ('x','y','z','ACME','8-k','bogus',0.5,0.9,'now')`
        )
        .run()
    ).toThrow();
  });

  it("BINDING: this path contains no DELETE/UPDATE — a skipped embed never removes stored records", () => {
    const source = readFileSync(path.join(process.cwd(), "src/lib/db-near-dup.ts"), "utf8");
    const code = source.replace(/^\s*\*.*$/gm, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/DELETE\s+FROM/i);
    expect(code).not.toMatch(/UPDATE\s+\w+\s+SET/i);
    expect(code).not.toMatch(/DROP\s+TABLE/i);
    // Writes are INSERT OR IGNORE (idempotent re-run), never a destructive REPLACE.
    expect(code).not.toMatch(/INSERT\s+OR\s+REPLACE/i);
  });

  it("BINDING: the new tables are not registered as prunable with storage hygiene", () => {
    const hygiene = readFileSync(path.join(process.cwd(), "src/lib/sqlite-storage-hygiene.ts"), "utf8");
    // PRUNABLE_TABLES / CATEGORY_BY_TABLE drive retention. Neither may mention the ST-4541 tables,
    // otherwise audit-prune.ts could expire provenance rows that must be kept forever.
    expect(hygiene).not.toMatch(/chunk_dedup_signatures/);
    expect(hygiene).not.toMatch(/chunk_dedup_links/);
  });
});