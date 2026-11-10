/**
 * DeepInfra/bge-m3 sums the whole embed `input[]` against 8192.  Live VECTOR_EMBED_BATCH_SIZE=32
 * sent 8193 tokens in one POST and 400'd rag-embed.  Pack-at-embed only: do not invent a second
 * filing chunker, do not mint extra table vectors, do not change managed-commit cardinality.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  EMBED_MODEL_CONTEXT_TOKENS,
  EMBED_REQUEST_TOKEN_BUDGET,
  chunkEmbedText,
  embedBudgetUnits,
  embedRequestFits,
  embedTextTokenEstimate,
  packInWindowTexts,
  prefixCountWithinEmbedUnits,
  truncateEmbedText
} from "../src/lib/rag/embed-request-pack";
import { approxTokens } from "../src/lib/rag-metering";

const mocks = vi.hoisted(() => {
  const upsert = vi.fn();
  const query = vi.fn();
  const index = vi.fn(() => ({ upsert, query }));
  return {
    upsert,
    query,
    index,
    listIndexes: vi.fn(),
    createIndex: vi.fn(),
    describeIndex: vi.fn(),
    embed: vi.fn(),
    resolveApiKey: vi.fn(),
    audit: vi.fn()
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

vi.mock("../src/lib/db", () => ({
  resolveApiKey: mocks.resolveApiKey,
  audit: mocks.audit,
  setInternalSetting: vi.fn()
}));

const LIVE_400_BODY =
  "Embedding API failed (isOpenRouter=true): 400 This model's maximum context length is 8192 tokens. However, you requested 0 output tokens and your prompt contains at least 8193 input tokens, for a total of at least 8193 tokens. Please reduce the length of the input prompt or the number of requested output tokens. (parameter=input_tokens, value=8193)";

function textOfTokens(tokens: number, char = "A"): string {
  return char.repeat(tokens * 4);
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env.PINECONE_API_KEY = "pinecone-test";
  process.env.VOYAGE_API_KEY = "voyage-test";
  process.env.PINECONE_INDEX_READY_WAIT_MS = "0";
  process.env.VECTOR_EMBED_BATCH_DELAY_MS = "0";
  process.env.VECTOR_EMBED_BATCH_SIZE = "32";
  delete process.env.VECTOR_CONTEXT_MAX_CHARS;

  mocks.resolveApiKey.mockImplementation((service: string) => {
    if (service === "pinecone") return process.env.PINECONE_API_KEY;
    if (service === "voyage") return process.env.VOYAGE_API_KEY;
    return undefined;
  });
  mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
  mocks.describeIndex.mockResolvedValue({ metric: "cosine" });
  mocks.embed.mockImplementation(async ({ input }: { input: string[] }) => {
    const tokens = approxTokens(input);
    // Live failure mode: DeepInfra sums a multi-text POST.  A singleton keeps its
    // original string (tables stay whole; no second chunker).
    if (input.length > 1 && (tokens >= EMBED_MODEL_CONTEXT_TOKENS || !embedRequestFits(input))) {
      throw new Error(LIVE_400_BODY);
    }
    return {
      data: input.map((_, i) => ({ embedding: [0.1 + i * 0.001, 0.2, 0.3] }))
    };
  });
});

describe("embed request packer (pure)", () => {
  it("estimates prose above bytes/4 and digits at one token each", () => {
    const sample = textOfTokens(256);
    expect(approxTokens([sample])).toBe(256);
    expect(embedTextTokenEstimate(sample)).toBe(293);
    const digits = "9".repeat(20_000);
    expect(approxTokens([digits])).toBe(5_000);
    expect(embedTextTokenEstimate(digits)).toBe(20_000);
  });

  it("keeps an empty string as one piece and rejects a non-string", () => {
    expect(chunkEmbedText("")).toEqual([""]);
    expect(truncateEmbedText("")).toBe("");
    expect(embedBudgetUnits("")).toBe(1);
    expect(embedTextTokenEstimate("")).toBe(1);
    expect(() => embedTextTokenEstimate(undefined as unknown as string)).toThrow(TypeError);
  });

  it("chunks a digit run that bytes/4 would send whole", () => {
    const digits = "9".repeat(20_000);
    const parts = chunkEmbedText(digits);
    expect(parts.length).toBeGreaterThan(1);
    expect(embedBudgetUnits(digits)).toBe(parts.length);
    for (const part of parts) {
      expect(embedRequestFits([part])).toBe(true);
      expect(part.includes("[truncated]")).toBe(false);
    }
    expect(prefixCountWithinEmbedUnits([digits, "short filing"], 1)).toBe(0);
    expect(prefixCountWithinEmbedUnits(["short filing", "another"], 1)).toBe(1);
  });

  it("prefix walk honors precomputed units and falls back for texts missing from the map", () => {
    const big = "9".repeat(20_000);
    const texts = [big, "short filing", "another"];
    // Built the way vector-db builds it: one embedBudgetUnits call per distinct text.
    const precomputed = new Map<string, number>();
    for (const text of texts) precomputed.set(text, embedBudgetUnits(text));
    expect(prefixCountWithinEmbedUnits(texts, 1, undefined, precomputed)).toBe(
      prefixCountWithinEmbedUnits(texts, 1)
    );
    // A partial map must still compute the texts it does not carry.
    const partial = new Map([[big, precomputed.get(big)!]]);
    expect(prefixCountWithinEmbedUnits(texts, 1, undefined, partial)).toBe(
      prefixCountWithinEmbedUnits(texts, 1)
    );
  });

  it("packs a 32-text batch that summed to 8192 so no request reaches 8193", () => {
    const items = Array.from({ length: 32 }, (_, sourceIndex) => ({
      text: textOfTokens(256),
      sourceIndex
    }));
    expect(approxTokens(items.map((item) => item.text))).toBe(8192);

    const groups = packInWindowTexts(items, { maxCount: 32 });
    expect(groups.length).toBeGreaterThan(1);
    expect(groups.some((group) => group.length === 32)).toBe(false);

    let covered = 0;
    for (const group of groups) {
      const texts = group.map((item) => item.text);
      expect(approxTokens(texts)).toBeLessThanOrEqual(EMBED_REQUEST_TOKEN_BUDGET);
      expect(embedRequestFits(texts)).toBe(true);
      covered += group.length;
    }
    expect(covered).toBe(32);
  });

  it("does not treat VECTOR_EMBED_BATCH_SIZE=32 as the send size when tokens would overflow", () => {
    const items = Array.from({ length: 32 }, (_, sourceIndex) => ({
      text: textOfTokens(256),
      sourceIndex
    }));
    const groups = packInWindowTexts(items, { maxCount: 32 });
    for (const group of groups) {
      expect(group.length).toBeLessThan(32);
      expect(approxTokens(group.map((item) => item.text))).toBeLessThan(EMBED_MODEL_CONTEXT_TOKENS);
    }
  });

  it("isolates a single over-budget text without splitting it", () => {
    const giant = textOfTokens(6000, "B");
    const small = textOfTokens(256, "C");
    const groups = packInWindowTexts([
      { text: giant, sourceIndex: 0 },
      { text: small, sourceIndex: 1 }
    ], { maxCount: 32 });
    const giantGroup = groups.find((group) => group.some((item) => item.sourceIndex === 0));
    expect(giantGroup).toEqual([{ text: giant, sourceIndex: 0 }]);
    expect(giantGroup?.[0]?.text).toBe(giant);
  });
});

describe("storeContexts embed window (ingest)", () => {
  it("embeds a 32-count batch as in-window POSTs, not one 8193-token 400", async () => {
    const { storeContexts } = await import("../src/lib/vector-db");
    const documents = Array.from({ length: 32 }, (_, i) => ({
      text: textOfTokens(256, "C"),
      metadata: { symbol: "AAPL", source: "sec-8k", timestamp: "2026-08-18", accession: `batch-${i}` }
    }));

    const result = await storeContexts(documents);

    expect(result.indexed).toBe(32);
    expect(result.rejectedInvalidEmbeddings ?? 0).toBe(0);
    expect(mocks.embed.mock.calls.length).toBeGreaterThan(1);
    expect(mocks.upsert.mock.calls.reduce((sum, call) => sum + call[0].records.length, 0)).toBe(32);
    for (const call of mocks.embed.mock.calls) {
      const input = call[0].input as string[];
      expect(input.length).toBeLessThan(32);
      expect(approxTokens(input)).toBeLessThanOrEqual(EMBED_REQUEST_TOKEN_BUDGET);
      expect(approxTokens(input)).toBeLessThan(EMBED_MODEL_CONTEXT_TOKENS);
      expect(embedRequestFits(input)).toBe(true);
    }
    const thrown400 = mocks.embed.mock.results.some((entry) => (
      entry.type === "throw" && String(entry.value).includes("value=8193")
    ));
    expect(thrown400).toBe(false);
  });

  it("isolates one large table POST so companions still embed; table stays one whole vector", async () => {
    const { storeContexts } = await import("../src/lib/vector-db");
    const giant = textOfTokens(5000, "D");
    const result = await storeContexts([
      {
        text: giant,
        metadata: {
          symbol: "AAPL",
          source: "sec-10k",
          timestamp: "2026-08-18",
          accession: "giant-table",
          is_table: true
        }
      },
      {
        text: "small companion filing",
        metadata: { symbol: "AAPL", source: "sec-8k", timestamp: "2026-08-18", accession: "small" }
      }
    ]);

    expect(result.indexed).toBe(2);
    expect(result.rejectedInvalidEmbeddings ?? 0).toBe(0);
    expect(mocks.upsert.mock.calls.reduce((sum, call) => sum + call[0].records.length, 0)).toBe(2);
    const tableInputs = mocks.embed.mock.calls
      .flatMap((call) => call[0].input as string[])
      .filter((text) => text.includes("D".repeat(40)));
    expect(tableInputs.length).toBeGreaterThan(0);
    const posted = mocks.embed.mock.calls.flatMap((call) => call[0].input as string[]);
    expect(posted.some((text) => text.includes("[Published: 2026-08-18]"))).toBe(true);
    for (const text of posted) expect(embedRequestFits([text])).toBe(true);
    const thrown400 = mocks.embed.mock.results.some((entry) => (
      entry.type === "throw" && String(entry.value).includes("input_tokens")
    ));
    expect(thrown400).toBe(false);
  });

  it("does not fail the whole 32-batch when one over-limit condensed text 400s", async () => {
    mocks.embed.mockImplementation(async ({ input }: { input: string[] }) => {
      const tokens = approxTokens(input);
      if (tokens >= EMBED_MODEL_CONTEXT_TOKENS || (input.length > 1 && !embedRequestFits(input))) {
        throw new Error(LIVE_400_BODY);
      }
      return {
        data: input.map((_, i) => ({ embedding: [0.1 + i * 0.001, 0.2, 0.3] }))
      };
    });

    const { storeContexts } = await import("../src/lib/vector-db");
    const giant = textOfTokens(9000, "E");
    const documents = [
      {
        text: giant,
        metadata: {
          symbol: "AAPL",
          source: "sec-10k",
          timestamp: "2026-08-18",
          accession: "over-limit-table",
          is_table: true
        }
      },
      ...Array.from({ length: 31 }, (_, i) => ({
        text: textOfTokens(256, "F"),
        metadata: {
          symbol: "AAPL",
          source: "sec-8k",
          timestamp: "2026-08-18",
          accession: `companion-${i}`
        }
      }))
    ];

    const result = await storeContexts(documents);

    expect(result.indexed).toBe(32);
    expect(result.rejectedInvalidEmbeddings ?? 0).toBe(0);
    expect(mocks.upsert.mock.calls.reduce((sum, call) => sum + call[0].records.length, 0)).toBe(32);
    const giantPosts = mocks.embed.mock.calls.filter((call) => {
      const input = call[0].input as string[];
      return input.some((text) => text.includes("E".repeat(40)));
    });
    expect(giantPosts.length).toBeGreaterThan(0);
    for (const call of mocks.embed.mock.calls) {
      const input = call[0].input as string[];
      expect(embedRequestFits(input)).toBe(true);
      expect(approxTokens(input)).toBeLessThan(EMBED_MODEL_CONTEXT_TOKENS);
    }
    const thrown400 = mocks.embed.mock.results.some((entry) => (
      entry.type === "throw" && String(entry.value).includes("value=8193")
    ));
    expect(thrown400).toBe(false);
  });
});

describe("context-length shrink", () => {
  it("splits a multi-text group that 400s instead of posting the same batch again", async () => {
    const multiThrows: string[][] = [];
    mocks.embed.mockImplementation(async ({ input }: { input: string[] }) => {
      if (input.length > 1) {
        multiThrows.push(input);
        throw new Error(LIVE_400_BODY);
      }
      return { data: input.map(() => ({ embedding: [0.11, 0.22, 0.33] })) };
    });

    const { storeContexts } = await import("../src/lib/vector-db");
    const result = await storeContexts([
      {
        text: "first short filing paragraph",
        metadata: { symbol: "AAPL", source: "sec-8k", timestamp: "2026-08-18", accession: "split-a" }
      },
      {
        text: "second short filing paragraph",
        metadata: { symbol: "AAPL", source: "sec-8k", timestamp: "2026-08-18", accession: "split-b" }
      }
    ]);

    expect(result.indexed).toBe(2);
    expect(result.rejectedInvalidEmbeddings ?? 0).toBe(0);
    expect(multiThrows).toHaveLength(1);
    expect(multiThrows[0]).toHaveLength(2);
    const singletonPosts = mocks.embed.mock.calls.filter((call) => (call[0].input as string[]).length === 1);
    expect(singletonPosts.length).toBe(2);
    expect(mocks.upsert.mock.calls.reduce((sum, call) => sum + call[0].records.length, 0)).toBe(2);
  });

  it("truncates a singleton once when the provider still reports context length", async () => {
    const posted: string[][] = [];
    mocks.embed.mockImplementation(async ({ input }: { input: string[] }) => {
      posted.push(input);
      if (posted.length === 1) throw new Error(LIVE_400_BODY);
      return { data: input.map(() => ({ embedding: [0.11, 0.22, 0.33] })) };
    });

    process.env.VECTOR_CONTEXT_MAX_CHARS = "16000";
    const { storeContexts } = await import("../src/lib/vector-db");
    // Over the half-budget byte cap (9375) and under the full cap (18750), so the
    // singleton retry has to shorten the string.  The default 2400 char cap would
    // already sit under that half budget and make the retry a no-op.
    const original = textOfTokens(2500, "G");
    const result = await storeContexts([
      {
        text: original,
        metadata: {
          symbol: "AAPL",
          source: "sec-8k",
          timestamp: "2026-08-18",
          accession: "shrink-one",
          is_table: true
        }
      }
    ]);

    expect(result.indexed).toBe(1);
    expect(posted).toHaveLength(2);
    expect(posted[1]![0]!.length).toBeLessThan(posted[0]![0]!.length);
    expect(embedRequestFits(posted[1]!)).toBe(true);
  });
});

describe("query embed window", () => {
  it("uses the same packer path and does not 400 a normal query", async () => {
    mocks.query.mockResolvedValue({
      matches: [{ id: "a", score: 0.9, metadata: { text: "hello", userId: "local", scope: "shared" } }]
    });
    const { retrieveContextDetailed } = await import("../src/lib/vector-db");
    const chunks = await retrieveContextDetailed("AAPL risk factors this quarter", "AAPL", 3, "local");
    expect(chunks.map((chunk) => chunk.id)).toEqual(["a"]);
    expect(mocks.embed).toHaveBeenCalled();
    for (const call of mocks.embed.mock.calls) {
      const input = call[0].input as string[];
      expect(approxTokens(input)).toBeLessThan(EMBED_MODEL_CONTEXT_TOKENS);
      expect(embedRequestFits(input)).toBe(true);
    }
    const thrown400 = mocks.embed.mock.results.some((entry) => (
      entry.type === "throw" && String(entry.value).includes("value=8193")
    ));
    expect(thrown400).toBe(false);
  });
});
