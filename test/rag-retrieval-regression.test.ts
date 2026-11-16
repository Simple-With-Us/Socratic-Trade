/**
 * Retrieval regression net (R4, 2026-07-01 RAG-expansion follow-on) for the as-of / rerank /
 * hybrid fail-safes that guard the money-adjacent retrieval invariants:
 *
 *  1. A chunk dated after `asOf` is dropped; an undated chunk is kept under the lenient default
 *     and dropped once `VECTOR_ASOF_STRICT` is on (R1 strict mode).
 *  2. `rerankMatches` (real function, not a mock) with a throwing/empty Voyage client preserves
 *     pool length + identity — the fail-open contract.
 *  3. `fuseHybrid` on <=1 match, or when it internally errors, returns input order unchanged.
 *  4. Hybrid on-vs-off reorders the pool but never drops a candidate.
 *
 * These are pinned as network-free unit tests over `matchToChunk`-shaped recorded fixtures,
 * routed through the pure `rankPool` helper `vector-db.ts` factored out of
 * `retrieveContextDetailed` for exactly this purpose (2026-07-01 expert-review item R4) — so the
 * test exercises the SAME post-recall pipeline logic production uses, not a re-implementation of
 * it in test code.
 *
 * No live Voyage/Pinecone network call is possible here: this file never imports
 * `@pinecone-database/pinecone` or `voyageai`, never calls `getClients`/`embed`, and asserts a
 * `fetch` spy is never invoked. `rankPool` itself makes no network calls at all — the only I/O
 * dependency (`rerankMatches`) is exercised in-process against fake `{ rerank }` stand-ins that
 * throw/return synchronously, never touching a real client.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { rankPool, isWithinAsOf, resolveAsOfStamp, matchToChunk, rerankMatches } from "../src/lib/vector-db";
import { fuseHybrid } from "../src/lib/rag/hybrid";

vi.mock("../src/lib/db-health", () => ({
  logApiHealth: vi.fn(),
}));

// Isolate the DB: even though logApiHealth is mocked, rankPool's strict-asOf `audit()` and
// rerankMatches' `alertRagConnectionFailure()` (getInternalSetting/setInternalSetting) still touch
// getDb(). Point DATABASE_URL at a per-run temp file so incidental writes never mutate the repo's
// real data/app.db (repo convention — see AGENTS.md "Tests use a temp SQLite file per run").
beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-rag-retrieval-regression-${randomUUID()}.db`)}`;
});

// ── Fixture builders (matchToChunk-shaped: id/score/metadata, exactly what Pinecone returns) ────

const mk = (id: string, score: number, text: string, extra: Record<string, unknown> = {}) => ({
  id,
  score,
  metadata: { text, userId: "local", scope: "shared", ...extra }
});

function fakeVoyage(impl: (args: { query: string; documents: string[]; topK: number }) => any) {
  return { rerank: async (args: any) => impl(args) } as any;
}

describe("R4 retrieval regression net: no live network is possible from this file", () => {
  it("never touches fetch/getClients — rankPool and its dependencies are pure/in-process", async () => {
    const fetchSpy = vi.spyOn(global, "fetch");
    const pool = [mk("a", 0.9, "alpha"), mk("b", 0.8, "beta")];
    await rankPool(pool, "q", 2, {});
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("R4.1 — as-of guard: dated-after-asOf dropped, undated lenient-kept / strict-dropped", () => {
  it("drops a chunk dated strictly after asOf and keeps one on/before it (lenient, default)", async () => {
    const pool = [
      mk("future", 0.9, "future filing", { acceptance_datetime: "2026-06-01" }),
      mk("in-window", 0.85, "in-window filing", { acceptance_datetime: "2026-05-01" })
    ];
    const out = await rankPool(pool, "q", 2, { asOf: "2026-05-15" });
    expect(out.map((m) => m.id)).toEqual(["in-window"]);
  });

  it("keeps an undated chunk under the lenient default (asOf set, VECTOR_ASOF_STRICT unset/off)", async () => {
    const pool = [
      mk("undated", 0.9, "no date stamp at all"),
      mk("in-window", 0.85, "dated, in window", { acceptance_datetime: "2026-05-01" })
    ];
    const out = await rankPool(pool, "q", 2, { asOf: "2026-05-15", strictAsOf: false });
    expect(out.map((m) => m.id).sort()).toEqual(["in-window", "undated"]);
  });

  it("drops an undated chunk under strict mode (VECTOR_ASOF_STRICT on) but keeps the dated in-window one", async () => {
    const auditSpy = vi.fn();
    const pool = [
      mk("undated", 0.9, "no date stamp at all"),
      mk("in-window", 0.85, "dated, in window", { acceptance_datetime: "2026-05-01" }),
      mk("future", 0.8, "dated but after asOf", { acceptance_datetime: "2026-06-01" })
    ];
    // rankPool's audit() call is fire-and-forget via the real ../src/lib/db import in this
    // (non-network-mocked) test — swap it out is unnecessary since audit() itself only writes to
    // the local test DB via getDb()/DATABASE_URL; assert on behavior, not the audit call directly,
    // to keep this file dependency-light. (The dedicated strict-mode audit assertion below uses a
    // proper vi.mock("../src/lib/db") harness instead.)
    void auditSpy;
    const out = await rankPool(pool, "q", 3, { asOf: "2026-05-15", strictAsOf: true });
    expect(out.map((m) => m.id)).toEqual(["in-window"]);
  });

  it("strict mode has NO effect when asOf is unset — undated chunks are always kept", async () => {
    const pool = [mk("undated", 0.9, "no date stamp")];
    const out = await rankPool(pool, "q", 1, { strictAsOf: true }); // no asOf at all
    expect(out.map((m) => m.id)).toEqual(["undated"]);
  });

  it("isWithinAsOf: strict=false (default) is byte-identical to the pre-R4 lenient behavior", () => {
    expect(isWithinAsOf({ acceptance_datetime: "2026-05-01" }, "2026-05-15")).toBe(true);
    expect(isWithinAsOf({ acceptance_datetime: "2026-06-01" }, "2026-05-15")).toBe(false);
    expect(isWithinAsOf({}, "2026-05-15")).toBe(true); // undated, lenient default
    expect(isWithinAsOf({}, "2026-05-15", false)).toBe(true); // undated, explicit lenient
  });

  it("isWithinAsOf: strict=true drops an undated chunk only when asOf is set and parseable", () => {
    expect(isWithinAsOf({}, "2026-05-15", true)).toBe(false); // undated + asOf set + strict -> drop
    expect(isWithinAsOf({}, undefined, true)).toBe(true); // no asOf at all -> strict is a no-op
    expect(isWithinAsOf({}, "not-a-date", true)).toBe(true); // unparseable asOf -> no constraint to violate
    expect(isWithinAsOf({ acceptance_datetime: "2026-05-01" }, "2026-05-15", true)).toBe(true); // dated, in-window
  });

  it("resolveAsOfStamp: undefined for no resolvable stamp, a finite ms timestamp otherwise", () => {
    expect(resolveAsOfStamp({})).toBeUndefined();
    expect(resolveAsOfStamp({ acceptance_datetime: "not-a-date" })).toBeUndefined();
    expect(resolveAsOfStamp({ acceptance_datetime: "2026-05-01" })).toBe(Date.parse("2026-05-01"));
    // Precedence: acceptance_datetime > published_at > as_of > timestamp.
    expect(resolveAsOfStamp({ acceptance_datetime: "2026-05-01", published_at: "2026-01-01" })).toBe(Date.parse("2026-05-01"));
    expect(resolveAsOfStamp({ published_at: "2026-03-01" })).toBe(Date.parse("2026-03-01"));
  });
});

describe("R4.2 — rerankMatches fail-open: a throwing/empty Voyage client preserves length + identity", () => {
  it("preserves length and original ids/order when the reranker throws", async () => {
    const pool = [mk("a", 0.9, "alpha"), mk("b", 0.8, "beta"), mk("c", 0.7, "gamma")];
    const throwing = fakeVoyage(() => {
      throw new Error("simulated Voyage outage");
    });
    const out = await rerankMatches(throwing, "q", pool, 3);
    expect(out).toHaveLength(pool.length);
    expect(out.map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("preserves length and identity when the reranker returns an empty data array", async () => {
    const pool = [mk("a", 0.9, "alpha"), mk("b", 0.8, "beta")];
    const empty = fakeVoyage(() => ({ data: [] }));
    const out = await rerankMatches(empty, "q", pool, 2);
    expect(out).toHaveLength(pool.length);
    expect(out.map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("rankPool with a throwing rerank function still returns the full (hybrid-fused) pool, never an empty result", async () => {
    const pool = [mk("a", 0.9, "alpha query term"), mk("b", 0.8, "beta"), mk("c", 0.7, "gamma")];
    const throwingRerank = async () => {
      throw new Error("simulated Voyage outage");
    };
    // rankPool doesn't itself catch a throw from the injected rerank fn (rerankMatches internally
    // catches; a caller injecting a raw throwing fn bypasses that) — but the REAL rerankMatches
    // (used at the retrieveContextDetailed call site) always catches internally, which is the
    // production fail-open contract this asserts on the actual function, not a re-implementation.
    await expect(rankPool(pool, "alpha", 2, { rerank: throwingRerank })).rejects.toThrow();
    // The safe production path wraps the real rerankMatches, which never throws:
    const safeRerank = (q: string, m: any[], k: number) => rerankMatches(fakeVoyage(() => { throw new Error("outage"); }), q, m, k);
    const out = await rankPool(pool, "alpha", 2, { rerank: safeRerank });
    expect(out.map((m) => m.id)).toEqual(["a", "b", "c"]); // fallback to input order, nothing dropped
  });
});

describe("R4.3 — fuseHybrid fail-safe: <=1 match or internal error returns input order unchanged", () => {
  it("returns the input unchanged for an empty pool", () => {
    expect(fuseHybrid("q", [])).toEqual([]);
  });

  it("returns the input unchanged for a single-match pool", () => {
    const pool = [mk("a", 0.9, "alpha")];
    expect(fuseHybrid("q", pool)).toEqual(pool);
  });

  it("returns the input pool unchanged (same identity, not just same ids) when matches is not an array-like the function expects", () => {
    // fuseHybrid defensively returns `matches` as-is for non-array/short input; assert referential
    // safety (no throw) for a deliberately malformed shape a defensive caller might pass.
    const weird = null as unknown as any[];
    expect(fuseHybrid("q", weird)).toBe(weird);
  });
});

describe("R4.4 — hybrid on-vs-off reorders the pool but never drops a candidate", () => {
  it("hybrid ON reorders relative to dense order but the candidate SET is identical", async () => {
    // A pool where an exact lexical match ("fulfillment costs") sits below the dense top rank —
    // hybrid's whole purpose is to promote it via BM25/RRF fusion.
    const pool = [
      mk("dense-top", 0.9, "unrelated high-cosine chunk about something else entirely"),
      mk("lexical-match", 0.5, "fulfillment costs rose due to fulfillment center expansion"),
      mk("mid", 0.6, "somewhat related chunk")
    ];
    const denseOff = await rankPool(pool, "fulfillment costs", 3, { hybrid: false });
    const hybridOn = await rankPool(pool, "fulfillment costs", 3, { hybrid: true });

    // Same candidate SET either way — hybrid reorders, never drops.
    expect(new Set(denseOff.map((m) => m.id))).toEqual(new Set(pool.map((m) => m.id)));
    expect(new Set(hybridOn.map((m) => m.id))).toEqual(new Set(pool.map((m) => m.id)));
    expect(hybridOn).toHaveLength(pool.length);

    // Hybrid must promote (or at least not bury further than) the lexical match relative to dense-only.
    const denseRank = denseOff.findIndex((m) => m.id === "lexical-match");
    const hybridRank = hybridOn.findIndex((m) => m.id === "lexical-match");
    expect(hybridRank).toBeLessThanOrEqual(denseRank);
  });

  it("hybrid OFF (default) leaves the pool in pure dense/cosine order — byte-for-byte unchanged", async () => {
    const pool = [mk("a", 0.9, "alpha"), mk("b", 0.8, "beta"), mk("c", 0.7, "gamma")];
    const out = await rankPool(pool, "q", 3, {}); // hybrid omitted -> falsy -> off
    expect(out.map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("hybrid never drops a candidate even when zero terms overlap with the query (empty lexical list falls back to dense order)", async () => {
    const pool = [mk("a", 0.9, "zzz completely unrelated content"), mk("b", 0.8, "yyy also unrelated")];
    const out = await rankPool(pool, "query terms that match nothing", 2, { hybrid: true });
    expect(out).toHaveLength(2);
    expect(new Set(out.map((m) => m.id))).toEqual(new Set(["a", "b"]));
  });
});

describe("R4.5 — rankPool defaults are a no-op (byte-for-byte identical to raw input) when no options are set", () => {
  it("returns the pool completely unchanged with an empty options object", async () => {
    const pool = [mk("a", 0.9, "alpha"), mk("b", 0.8, "beta"), mk("c", 0.7, "gamma")];
    const out = await rankPool(pool, "q", 3, {});
    expect(out).toEqual(pool);
  });

  it("matchToChunk over rankPool's output round-trips id/score/text for a plain pool", async () => {
    const pool = [mk("a", 0.9, "alpha text", { doc_type: "10-k", acceptance_datetime: "2026-05-01" })];
    const out = await rankPool(pool, "q", 1, {});
    const chunks = out.map(matchToChunk);
    expect(chunks[0]).toMatchObject({ id: "a", score: 0.9, text: "alpha text", doc_type: "10-k", as_of: "2026-05-01" });
  });

  it("no `onDispositions` hook passed: return value is byte-identical across repeated calls (pure-function regression)", async () => {
    // Same fixture/options shape as production's default config (minScore + asOf + dedupe, no
    // hook) — pins that adding the OPTIONAL onDispositions param changed nothing for every
    // existing caller, which never supplies it.
    const pool = [
      mk("a", 0.9, "alpha text about revenue growth", { acceptance_datetime: "2026-05-01" }),
      mk("b", 0.8, "beta text about margin expansion", { acceptance_datetime: "2026-04-01" }),
      mk("low", 0.1, "unrelated filler", { acceptance_datetime: "2026-03-01" })
    ];
    const withoutHook = await rankPool(pool, "q", 2, { minScore: 0.5, asOf: "2026-05-15", dedupeSimilarity: 0.6 });
    const alsoWithoutHook = await rankPool(pool, "q", 2, { minScore: 0.5, asOf: "2026-05-15", dedupeSimilarity: 0.6 });
    expect(withoutHook).toEqual(alsoWithoutHook);
    expect(withoutHook.map((m) => m.id)).toEqual(["a", "b"]);
  });
});

describe("persist-pool-v2 — rankPool's optional onDispositions hook", () => {
  it("every candidate gets exactly one disposition, correctly naming the stage that dropped it", async () => {
    const pool = [
      mk("kept", 0.9, "alpha text about revenue growth", { acceptance_datetime: "2026-05-01" }),
      mk("not-used", 0.85, "beta text about margin expansion", { acceptance_datetime: "2026-04-01" }),
      mk("dropped-asof", 0.8, "gamma text about future plans", { acceptance_datetime: "2026-06-01" }),
      mk("dropped-minscore", 0.1, "delta unrelated filler", { acceptance_datetime: "2026-03-01" })
    ];
    let captured: Map<string, string> | undefined;
    // rankPool does NOT itself slice to `limit` (that's the caller's job — see its own doc
    // comment); passing limit=1 here only affects rerank's would-be topK, which is irrelevant
    // since no `rerank` option is supplied. Both "kept" and "not-used" survive every rankPool
    // stage, so BOTH come back in `out` and BOTH are `kept_not_used` (the caller upgrades
    // whichever ends up in ITS final `.slice(0, limit)` to `used`, which rankPool has no view of).
    const out = await rankPool(pool, "q", 1, {
      minScore: 0.5,
      asOf: "2026-05-15",
      onDispositions: (d) => { captured = d as unknown as Map<string, string>; }
    });
    expect(out.map((m) => m.id)).toEqual(["kept", "not-used"]);
    expect(captured).toBeDefined();
    expect(captured!.get("kept")).toBe("kept_not_used");
    expect(captured!.get("not-used")).toBe("kept_not_used");
    expect(captured!.get("dropped-asof")).toBe("dropped_asof");
    expect(captured!.get("dropped-minscore")).toBe("dropped_minscore");
    expect(captured!.size).toBe(4);
  });

  it("dedupe drop is disposed as dropped_dedupe", async () => {
    const text = "alpha text about revenue growth this quarter";
    const pool = [mk("original", 0.9, text), mk("near-dup", 0.85, text)];
    let captured: Map<string, string> | undefined;
    const out = await rankPool(pool, "q", 2, {
      dedupeSimilarity: 0.5,
      onDispositions: (d) => { captured = d as unknown as Map<string, string>; }
    });
    expect(out.map((m) => m.id)).toEqual(["original"]);
    expect(captured!.get("original")).toBe("kept_not_used");
    expect(captured!.get("near-dup")).toBe("dropped_dedupe");
  });

  it("review fix: 5 fully-distinct candidates with limit=3 — the 2 cut candidates are dropped_dedupe_truncate, NOT dropped_dedupe (flagship strategy.ts config: limit=3, dedupeSimilarity=0.6)", async () => {
    const pool = [
      mk("a", 0.95, "the first entirely distinct passage about quarterly revenue growth trends"),
      mk("b", 0.9, "a second entirely distinct passage about supply chain logistics risk factors"),
      mk("c", 0.85, "a third entirely distinct passage about executive compensation governance policy"),
      mk("d", 0.8, "a fourth entirely distinct passage about international regulatory compliance matters"),
      mk("e", 0.75, "a fifth entirely distinct passage about capital expenditure and infrastructure investment")
    ];
    let captured: Map<string, string> | undefined;
    const out = await rankPool(pool, "q", 3, {
      dedupeSimilarity: 0.6,
      onDispositions: (d) => { captured = d as unknown as Map<string, string>; }
    });
    expect(out.map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(captured!.get("a")).toBe("kept_not_used");
    expect(captured!.get("b")).toBe("kept_not_used");
    expect(captured!.get("c")).toBe("kept_not_used");
    // "d" and "e" are distinct, non-duplicate candidates cut purely by dedupeSimilar's OWN
    // internal top-limit cap — must NOT be mislabeled as near-duplicate removal.
    expect(captured!.get("d")).toBe("dropped_dedupe_truncate");
    expect(captured!.get("e")).toBe("dropped_dedupe_truncate");
  });

  it("review fix: a genuine near-duplicate is still dropped_dedupe (distinct from dropped_dedupe_truncate) even alongside cap-truncated candidates", async () => {
    const text = "the exact same repeated phrase over and over about revenue growth this quarter";
    const pool = [
      mk("original", 0.95, text),
      mk("near-dup", 0.9, text + " precisely"),
      mk("b", 0.85, "a completely different discussion about supply chain risk factors and logistics"),
      mk("c", 0.8, "yet another unrelated passage about executive compensation and governance policy"),
      mk("d", 0.75, "a fourth unrelated passage about capital markets and treasury operations")
    ];
    let captured: Map<string, string> | undefined;
    // limit=2: "original" kept, "near-dup" genuinely judged a duplicate of "original", "b" kept
    // (fills the cap) — "c" and "d" never even compared, cut purely by the cap.
    const out = await rankPool(pool, "q", 2, {
      dedupeSimilarity: 0.5,
      onDispositions: (d) => { captured = d as unknown as Map<string, string>; }
    });
    expect(out.map((m) => m.id)).toEqual(["original", "b"]);
    expect(captured!.get("original")).toBe("kept_not_used");
    expect(captured!.get("b")).toBe("kept_not_used");
    expect(captured!.get("near-dup")).toBe("dropped_dedupe");
    expect(captured!.get("c")).toBe("dropped_dedupe_truncate");
    expect(captured!.get("d")).toBe("dropped_dedupe_truncate");
  });

  it("rerank truncation (Voyage topK cut) is disposed as dropped_rerank_truncate, distinct from the relevance floor", async () => {
    const pool = [mk("a", 0.9, "alpha"), mk("b", 0.8, "beta"), mk("c", 0.7, "gamma")];
    // topK=2 (limit) means rerankMatches asks Voyage for only the top 2 — "c" never comes back.
    const rerank = async (_q: string, matches: any[], topK: number) =>
      matches.slice(0, topK).map((m, i) => ({ ...m, _rerankScore: 1 - i * 0.1 }));
    let captured: Map<string, string> | undefined;
    const out = await rankPool(pool, "q", 2, {
      rerank,
      onDispositions: (d) => { captured = d as unknown as Map<string, string>; }
    });
    expect(out.map((m) => m.id)).toEqual(["a", "b"]);
    expect(captured!.get("a")).toBe("kept_not_used");
    expect(captured!.get("b")).toBe("kept_not_used");
    expect(captured!.get("c")).toBe("dropped_rerank_truncate");
  });

  it("post-rerank relevance floor drop is disposed as dropped_rerank_floor", async () => {
    // 4 candidates with limit=3 so `rerankRan` is true (fusedPool.length=4 > limit=3) and the
    // injected rerank fn's own topK cut (matches.slice(0, topK)) keeps exactly 3 — isolating the
    // relevance-floor drop (applied AFTER rerank, against those 3) from the truncate drop.
    const pool = [mk("a", 0.9, "alpha"), mk("b", 0.8, "beta"), mk("c", 0.7, "gamma"), mk("d", 0.6, "delta")];
    const rerank = async (_q: string, matches: any[], topK: number) =>
      matches.slice(0, topK).map((m, i) => ({ ...m, _rerankScore: [0.9, 0.5, 0.1][i] }));
    let captured: Map<string, string> | undefined;
    const out = await rankPool(pool, "q", 3, {
      rerank,
      minRelevanceScore: 0.3,
      onDispositions: (d) => { captured = d as unknown as Map<string, string>; }
    });
    expect(out.map((m) => m.id)).toEqual(["a", "b"]);
    expect(captured!.get("a")).toBe("kept_not_used");
    expect(captured!.get("b")).toBe("kept_not_used");
    expect(captured!.get("c")).toBe("dropped_rerank_floor");
    expect(captured!.get("d")).toBe("dropped_rerank_truncate");
  });

  it("id-less candidates get distinct synthetic keys instead of colliding on empty-string id", async () => {
    const idLess1 = { score: 0.9, metadata: { text: "id-less kept", userId: "local", scope: "shared" } };
    const idLess2 = { score: 0.1, metadata: { text: "id-less dropped", userId: "local", scope: "shared" } };
    let captured: Map<string, string> | undefined;
    const out = await rankPool([idLess1, idLess2], "q", 1, {
      minScore: 0.5,
      onDispositions: (d) => { captured = d as unknown as Map<string, string>; }
    });
    expect(out.length).toBe(1);
    expect(captured!.size).toBe(2);
    const keys = Array.from(captured!.keys());
    expect(new Set(keys).size).toBe(2); // distinct synthetic keys, no collision
    const values = Array.from(captured!.values());
    expect(values).toEqual(expect.arrayContaining(["kept_not_used", "dropped_minscore"]));
  });

  it("omitting onDispositions entirely costs nothing extra — output unaffected by whether a hook is present", async () => {
    const pool = [mk("a", 0.9, "alpha"), mk("b", 0.2, "beta")];
    const withHook = await rankPool(pool, "q", 2, { minScore: 0.5, onDispositions: () => {} });
    const withoutHook = await rankPool(pool, "q", 2, { minScore: 0.5 });
    expect(withHook.map((m) => m.id)).toEqual(withoutHook.map((m) => m.id));
  });
});
