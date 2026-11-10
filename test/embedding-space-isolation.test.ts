import { describe, it, expect, beforeAll } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { embeddingSpaceRevisionForModel, embedSpaceFilterForModel } from "../src/lib/vector-db";

beforeAll(() => {
  // The helpers under test are pure, but keep the DB pointed at a temp file like every other
  // suite in case a transitive import lazily opens it.
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-embed-space-${randomUUID()}.db`)}`;
});

describe("Embedding-space isolation (PR #1669 P1)", () => {
  it("keeps the historical bare revision tag and NO query filter for the legacy Voyage model", () => {
    // The entire existing corpus was written as `v1` — the Voyage space must stay byte-stable
    // (ids/receipts) and its queries must stay unfiltered so pre-embed_model vectors remain
    // retrievable.
    expect(embeddingSpaceRevisionForModel("voyage-finance-2")).toBe("v1");
    expect(embedSpaceFilterForModel("voyage-finance-2")).toEqual({});
  });

  it("gives alternative models a suffixed revision so ids can never collide with Voyage rows", () => {
    const openrouterRev = embeddingSpaceRevisionForModel("baai/bge-m3");
    const siliconflowRev = embeddingSpaceRevisionForModel("BAAI/bge-m3");
    expect(openrouterRev).toBe("v1-baai-bge-m3");
    // Both BGE spellings are the same model/space — same revision lineage.
    expect(siliconflowRev).toBe(openrouterRev);
    expect(openrouterRev).not.toBe("v1");
  });

  it("restricts queries to the active non-Voyage embedding space (both BGE stamps accepted)", () => {
    const filter = embedSpaceFilterForModel("baai/bge-m3") as { embed_model: { $in: string[] } };
    expect(filter.embed_model.$in.sort()).toEqual(["BAAI/bge-m3", "baai/bge-m3"]);
  });
});
