import { describe, it, expect } from "vitest";
import { fetchIdChunks, PINECONE_FETCH_ID_URL_BUDGET } from "../src/lib/vector-db";

// Regression for the 2026-07-15 production "Pinecone connection failed / inventory fetch: unexpected
// error" incident: index.fetch({ ids }) puts every id in the GET query string, and managed
// occurrence ids (occ:v3:…) are ~150 chars each, so a count-only batch of 100 built an ~18 KB URL
// that Pinecone rejected. fetchIdChunks must cap batches by encoded URL length too.

// A realistic managed occurrence id (colons url-encode to %3A, ~3x expansion on separators).
function occId(n: number): string {
  const h = (seed: string) => seed.repeat(4).slice(0, 20);
  return `occ:v3:${h("a" + n)}:${h("b" + n)}:${h("c" + n)}:${h("d" + n)}:${"0".repeat(64)}`;
}

const encodedLen = (id: string) => encodeURIComponent(id).length + 6;

describe("fetchIdChunks — URL-length-aware batching for Pinecone fetch", () => {
  it("keeps every batch's encoded id length under the URL budget", () => {
    const ids = Array.from({ length: 500 }, (_, i) => occId(i));
    for (const batch of fetchIdChunks(ids, 100)) {
      const total = batch.reduce((sum, id) => sum + encodedLen(id), 0);
      // A batch may exceed the budget only when it is a single unavoidable id.
      if (batch.length > 1) {
        expect(total).toBeLessThanOrEqual(PINECONE_FETCH_ID_URL_BUDGET);
      }
    }
  });

  it("batches long managed ids far below the count cap (would have been 100)", () => {
    const ids = Array.from({ length: 500 }, (_, i) => occId(i));
    const batches = fetchIdChunks(ids, 100);
    // ~150-char ids → ~180 encoded → budget 3500 → ~19 ids/batch, well under the 100 count cap.
    expect(batches[0].length).toBeLessThan(100);
    expect(batches[0].length).toBeGreaterThan(0);
  });

  it("still honours the count cap for short ids that fit the budget", () => {
    const ids = Array.from({ length: 250 }, (_, i) => `v${i}`); // tiny ids
    const batches = fetchIdChunks(ids, 100);
    expect(batches[0].length).toBe(100);
    expect(batches.map((b) => b.length)).toEqual([100, 100, 50]);
  });

  it("preserves order and loses no ids", () => {
    const ids = Array.from({ length: 137 }, (_, i) => occId(i));
    const flat = fetchIdChunks(ids, 100).flat();
    expect(flat).toEqual(ids);
  });

  it("never emits an empty batch, even for a single oversized id", () => {
    const huge = "occ:v3:" + "z".repeat(PINECONE_FETCH_ID_URL_BUDGET * 2);
    const batches = fetchIdChunks([huge], 100);
    expect(batches).toEqual([[huge]]);
    expect(fetchIdChunks([], 100)).toEqual([]);
  });
});
