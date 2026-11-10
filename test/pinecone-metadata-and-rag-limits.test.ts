import { describe, expect, it } from "vitest";
import {
  PINECONE_METADATA_HARD_LIMIT_BYTES,
  PINECONE_METADATA_SOFT_LIMIT_BYTES,
  classifyEmbedFailure,
  enforcePineconeMetadataLimit,
  ragLimitStatus
} from "../src/lib/vector-db";

describe("enforcePineconeMetadataLimit", () => {
  it("leaves small metadata unchanged", () => {
    const meta = {
      text: "AAPL 8-K excerpt",
      symbol: "AAPL",
      source: "sec-8k",
      timestamp: "2026-08-13"
    };
    expect(enforcePineconeMetadataLimit(meta)).toEqual(meta);
  });

  it("truncates text so a 40962-byte payload stays under Pinecone's 40960 cap", () => {
    const prefix = {
      symbol: "AAPL",
      source: "sec-10k",
      timestamp: "2026-08-13T00:00:00.000Z",
      userId: "local",
      scope: "shared",
      tenant_scope: "shared:operator",
      provider_authority: "a".repeat(64),
      embed_model: "baai/bge-m3",
      embed_rev: 2,
      ingest_state: "committed",
      receipt_required: false
    };
    const overhead = Buffer.byteLength(JSON.stringify({ ...prefix, text: "" }), "utf8");
    const text = "x".repeat(PINECONE_METADATA_HARD_LIMIT_BYTES - overhead + 8);
    const capped = enforcePineconeMetadataLimit({ ...prefix, text });
    const bytes = Buffer.byteLength(JSON.stringify(capped), "utf8");
    expect(bytes).toBeLessThanOrEqual(PINECONE_METADATA_SOFT_LIMIT_BYTES);
    expect(bytes).toBeLessThanOrEqual(PINECONE_METADATA_HARD_LIMIT_BYTES);
    expect(String(capped.text).length).toBeLessThan(text.length);
    expect(capped.symbol).toBe("AAPL");
    expect(capped.source).toBe("sec-10k");
  });
});

describe("ragLimitStatus", () => {
  it("treats OpenRouter engine-overloaded 429s as transient, not a usage limit", () => {
    const message =
      'embed documents: Embedding API failed (isOpenRouter=true): 429 {"error":{"message":"HTTP 429: {\\"error\\":{\\"message\\":\\"The engine is currently overloaded. Please try again later.\\"}}"}}';
    expect(ragLimitStatus(message)).toBe("transient");
  });

  it("still classifies a plain 429 as rate_limited", () => {
    expect(ragLimitStatus("PineconeError: HTTP 429 Too Many Requests")).toBe("rate_limited");
  });

  it("does not soft-classify fetch failed / UND_ERR_SOCKET as ragLimitStatus transient", () => {
    // Those shapes escalate via isTransientNetworkErrorText — not this soft arm (Codex P1 #3195).
    expect(ragLimitStatus("TypeError: fetch failed")).toBeUndefined();
    expect(ragLimitStatus("UND_ERR_SOCKET: other side closed")).toBeUndefined();
    expect(ragLimitStatus("embed documents: fetch failed")).toBeUndefined();
  });
});

// P0 fix (2026-08-23): the SEC ingest worker used to collapse EVERY non-complete storeDocument
// result — a permanent HTTP 400, a 429, a bare connection failure, anything — into one generic
// "Ingestion budget or capacity exceeded mid-task" message, then unconditionally retried it
// forever (dead-lettered ~1k filings this way). classifyEmbedFailure is the piece that lets the
// worker fail loudly with the REAL reason instead: a 400 is a rejected request that retrying can
// never fix (permanent, dead-letter immediately); a 429/5xx/connection failure is worth a
// bounded retry (transient).
describe("classifyEmbedFailure", () => {
  it("classifies a plain HTTP 400 as permanent", () => {
    expect(classifyEmbedFailure("Embedding API failed (isOpenRouter=false): 400 {\"error\":\"bad request\"}")).toBe(
      "permanent"
    );
  });

  it("classifies other 4xx statuses (401/404/422) as permanent", () => {
    expect(classifyEmbedFailure("Embedding API failed (isOpenRouter=true): 401 unauthorized")).toBe("permanent");
    expect(classifyEmbedFailure("Embedding API failed (isOpenRouter=true): 404 not found")).toBe("permanent");
    expect(classifyEmbedFailure("Embedding API failed (isOpenRouter=true): 422 unprocessable")).toBe("permanent");
  });

  it("classifies a 429 as transient, not permanent, even though it is a 4xx", () => {
    expect(classifyEmbedFailure("Embedding API failed (isOpenRouter=false): 429 rate limited")).toBe("transient");
  });

  // P2 fix (2026-09-07): a 408 means the provider never actually evaluated the request, so a
  // retry is not "byte-identical content that can never succeed" the way a genuine 400 rejection
  // is. The blanket `/\b4\d\d\b/` permanent match previously misclassified this as permanent and
  // dead-lettered a filing that could have succeeded on retry.
  it("classifies a 408 (request timeout) as transient, not permanent", () => {
    expect(classifyEmbedFailure("Embedding API failed (isOpenRouter=false): 408 Request Timeout")).toBe("transient");
  });

  it("classifies a bare connection failure (no HTTP status at all) as transient", () => {
    expect(classifyEmbedFailure("fetch failed")).toBe("transient");
    expect(classifyEmbedFailure("UND_ERR_SOCKET: other side closed")).toBe("transient");
  });

  it("classifies a 5xx as transient", () => {
    expect(classifyEmbedFailure("Embedding API failed (isOpenRouter=false): 503 Service Unavailable")).toBe(
      "transient"
    );
  });

  it("defaults an unrecognized message to transient (never guesses permanent)", () => {
    expect(classifyEmbedFailure("storeDocument returned an incomplete result with no error detail")).toBe(
      "transient"
    );
  });
});
