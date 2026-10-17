/**
 * ST-4541 — pre-embed near-duplicate detection (pure logic, no DB / no provider calls).
 *
 * Covers the three classifications the ingest gate relies on (new / exact / near), the threshold
 * semantics (a value that clears at a loose threshold must NOT clear at a strict one), MinHash
 * self-similarity and round-tripping, and the batch invariant that matters for the binding rule:
 * every incoming record is accounted for as either "needs embed" or "skipped with a link" —
 * none are silently dropped.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_NEAR_DUP_NUM_PERM,
  classifyNearDuplicate,
  decodeSignature,
  encodeSignature,
  minhashSignature,
  normalizeForDedup,
  normalizedContentHash,
  partitionNearDuplicates,
  signatureSimilarity,
  toNearDupCandidate,
  type NearDupCandidate
} from "../src/lib/rag/near-dup-embed";
import { shingleSet } from "../src/lib/rag/dedupe-similar";

const BASE = `Acme Corporation reported net revenue of 412 million dollars for the third quarter, an increase of 8 percent over the prior year period. Gross margin expanded to 61 percent as the company continued to shift its mix toward higher margin software subscriptions. Operating expenses grew 4 percent year over year, below the pace of revenue growth, reflecting the benefits of the restructuring program completed in the prior fiscal year.`;

const NEAR = `${BASE} The company reaffirmed its full year guidance range of 1.6 to 1.7 billion dollars in total revenue.`;

/** Genuinely different content — must never be treated as a near duplicate. */
const DIFFERENT = `Beta Industries said its logistics segment revenue declined 12 percent in the quarter, which management attributed to the loss of two large regional contracts. The company plans to close its distribution center in Ohio by the end of the fiscal year and expects restructuring charges of approximately 18 million dollars.`;

function candidate(text: string, chunkId: string): NearDupCandidate {
  return toNearDupCandidate({ text, contentHash: `hash-${chunkId}`, chunkId, symbol: "ACME", source: "8-k" });
}

describe("ST-4541 near-duplicate embed skip — normalization + hashing", () => {
  it("collapses whitespace and case so a reflowed re-ingest hashes identically", () => {
    const reflowed = `  ${BASE.toUpperCase().replace(/\.\s/g, ".\n\n")}\n`;
    expect(normalizeForDedup(reflowed)).toBe(normalizeForDedup(BASE));
    expect(normalizedContentHash(reflowed)).toBe(normalizedContentHash(BASE));
  });

  it("gives genuinely different text a different normalized hash", () => {
    expect(normalizedContentHash(BASE)).not.toBe(normalizedContentHash(DIFFERENT));
  });
});

describe("ST-4541 near-duplicate embed skip — MinHash signatures", () => {
  it("reports ~1.0 similarity for identical shingle sets and ~0 for disjoint ones", () => {
    const a = minhashSignature(shingleSet(BASE));
    const b = minhashSignature(shingleSet(BASE));
    const c = minhashSignature(shingleSet(DIFFERENT));
    expect(signatureSimilarity(a, b)).toBe(1);
    expect(signatureSimilarity(a, c)).toBeLessThan(0.2);
  });

  it("estimates a high-but-not-1.0 similarity for an appended sentence", () => {
    const sim = signatureSimilarity(minhashSignature(shingleSet(BASE)), minhashSignature(shingleSet(NEAR)));
    expect(sim).toBeGreaterThan(0.5);
    expect(sim).toBeLessThan(1);
  });

  it("round-trips through the BLOB encoding used by chunk_dedup_signatures", () => {
    const signature = minhashSignature(shingleSet(BASE));
    const decoded = decodeSignature(encodeSignature(signature), DEFAULT_NEAR_DUP_NUM_PERM);
    expect(Array.from(decoded)).toEqual(Array.from(signature));
    expect(signatureSimilarity(signature, decoded)).toBe(1);
  });

  it("treats a length mismatch as not comparable (degrades to an extra embed, never a wrong skip)", () => {
    const short = minhashSignature(shingleSet(BASE), 8);
    const long = minhashSignature(shingleSet(BASE), 64);
    expect(signatureSimilarity(short, long)).toBe(0);
    expect(decodeSignature(null).length).toBe(DEFAULT_NEAR_DUP_NUM_PERM);
  });
});

describe("ST-4541 near-duplicate embed skip — classification", () => {
  it("classifies a whitespace/case-only repeat as EXACT, not merely near", () => {
    const stored = candidate(BASE, "canonical");
    const incoming = candidate(`  ${BASE.toUpperCase()}\n`, "incoming");
    const verdict = classifyNearDuplicate(incoming, [stored], { threshold: 0.9 });
    expect(verdict.kind).toBe("exact");
    expect(verdict.similarity).toBe(1);
    expect(verdict.canonicalHash).toBe("hash-canonical");
  });

  it("classifies an appended-sentence variant as NEAR once it clears the threshold", () => {
    const stored = candidate(BASE, "canonical");
    const incoming = candidate(NEAR, "incoming");
    const verdict = classifyNearDuplicate(incoming, [stored], { threshold: 0.5 });
    expect(verdict.kind).toBe("near");
    expect(verdict.similarity).toBeGreaterThanOrEqual(0.5);
    expect(verdict.canonicalChunkId).toBe("canonical");
  });

  it("honors the threshold: the same pair that is near at 0.5 stays NEW at 0.99", () => {
    const stored = candidate(BASE, "canonical");
    const incoming = candidate(NEAR, "incoming");
    expect(classifyNearDuplicate(incoming, [stored], { threshold: 0.5 }).kind).toBe("near");
    expect(classifyNearDuplicate(incoming, [stored], { threshold: 0.99 }).kind).toBe("new");
  });

  it("never flags unrelated content as a duplicate, even at a loose threshold", () => {
    const stored = candidate(BASE, "canonical");
    const incoming = candidate(DIFFERENT, "incoming");
    expect(classifyNearDuplicate(incoming, [stored], { threshold: 0.5 }).kind).toBe("new");
  });

  it("returns NEW for an empty reference set", () => {
    expect(classifyNearDuplicate(candidate(BASE, "a"), [], { threshold: 0.1 }).kind).toBe("new");
  });
});

describe("ST-4541 near-duplicate embed skip — batch partition", () => {
  it("embeds everything when there are no stored references", () => {
    const docs = [candidate(BASE, "a"), candidate(DIFFERENT, "b")];
    const result = partitionNearDuplicates(docs, [], { threshold: 0.9 });
    expect(result.toEmbed).toHaveLength(2);
    expect(result.skipped).toHaveLength(0);
    expect(result.links).toHaveLength(0);
  });

  it("skips an in-batch duplicate and links it to the chunk that was actually embedded", () => {
    const docs = [candidate(BASE, "first"), candidate(BASE.toUpperCase(), "second")];
    const result = partitionNearDuplicates(docs, [], { threshold: 0.9 });
    expect(result.toEmbed.map((d) => d.chunkId)).toEqual(["first"]);
    expect(result.skipped.map((d) => d.chunkId)).toEqual(["second"]);
    expect(result.links).toHaveLength(1);
    expect(result.links[0]).toMatchObject({
      contentHash: "hash-second",
      canonicalHash: "hash-first",
      canonicalChunkId: "first",
      kind: "exact"
    });
  });

  it("chains a duplicate-of-a-duplicate back to the ORIGINAL canonical", () => {
    const stored = candidate(BASE, "stored-canonical");
    const docs = [
      candidate(BASE.toUpperCase(), "dup-of-stored"),
      candidate(`  ${BASE.toLowerCase()}\n`, "dup-of-dup")
    ];
    const result = partitionNearDuplicates(docs, [stored], { threshold: 0.9 });
    expect(result.toEmbed).toHaveLength(0);
    expect(result.skipped).toHaveLength(2);
    // Both links must resolve to the stored canonical, not to the intermediate duplicate.
    expect(result.links.map((l) => l.canonicalHash)).toEqual(["hash-stored-canonical", "hash-stored-canonical"]);
    expect(result.links.map((l) => l.canonicalChunkId)).toEqual(["stored-canonical", "stored-canonical"]);
  });

  it("accounts for every input document — nothing is dropped (binding: records are kept)", () => {
    const docs = [
      candidate(BASE, "a"),
      candidate(BASE, "b"),
      candidate(NEAR, "c"),
      candidate(DIFFERENT, "d")
    ];
    const result = partitionNearDuplicates(docs, [], { threshold: 0.75 });
    expect(result.toEmbed.length + result.skipped.length).toBe(docs.length);
    expect(result.links.length).toBe(result.skipped.length);
    // Every skipped document keeps its own identity and is represented by a link row.
    expect(result.links.map((l) => l.contentHash).sort()).toEqual(
      result.skipped.map((d) => d.contentHash).sort()
    );
  });

  it("keeps distinct documents distinct when the threshold is loose enough to be dangerous", () => {
    const docs = [candidate(BASE, "a"), candidate(DIFFERENT, "b")];
    const result = partitionNearDuplicates(docs, [], { threshold: 0.9 });
    expect(result.toEmbed).toHaveLength(2);
    expect(result.links).toHaveLength(0);
  });

  it("names the canonical VECTOR on every link, for stored and in-batch canonicals alike", () => {
    // Kody review on PR #4736: canonical_vector_id was always '' because no reference carried one.
    const stored = { ...candidate(DIFFERENT, "stored"), vectorId: "vec-stored" };
    const first = { ...candidate(BASE, "first"), vectorId: "vec-first" };
    const docs = [
      first,
      candidate(BASE.toUpperCase(), "dup-of-first"),
      candidate(`  ${DIFFERENT.toLowerCase()}\n`, "dup-of-stored")
    ];
    const result = partitionNearDuplicates(docs, [stored], { threshold: 0.9 });
    expect(result.toEmbed.map((d) => d.chunkId)).toEqual(["first"]);
    expect(result.links.map((l) => [l.contentHash, l.canonicalVectorId])).toEqual([
      ["hash-dup-of-first", "vec-first"],
      ["hash-dup-of-stored", "vec-stored"]
    ]);
  });

  it("matches the per-document rebuild: an exact stored match outranks an earlier in-batch embed", () => {
    // The partition keeps ONE running reference list (stored first, then in-batch embeds). The exact
    // index must keep the FIRST holder of a normalized hash, like the `find` it replaces.
    const storedA = { ...candidate(BASE, "stored-a"), vectorId: "vec-stored-a" };
    const storedB = { ...candidate(BASE.toUpperCase(), "stored-b"), vectorId: "vec-stored-b" };
    const result = partitionNearDuplicates([candidate(`${BASE} `, "incoming")], [storedA, storedB], {
      threshold: 0.9
    });
    expect(result.links[0]).toMatchObject({ canonicalChunkId: "stored-a", canonicalVectorId: "vec-stored-a" });
    expect(classifyNearDuplicate(candidate(`${BASE} `, "incoming"), [storedA, storedB], { threshold: 0.9 }))
      .toMatchObject({ kind: "exact", canonicalChunkId: "stored-a" });
  });
});