import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_EMBED_DOCUMENT_CALL_TIMEOUT_MS,
  DEFAULT_EMBED_DOCUMENT_TOTAL_TIMEOUT_MS,
  embedDocumentTotalTimeoutMs
} from "../src/lib/rag/embed-resilience";

// Kody on #5470 (ST-4674): one document embedWithRetry call is capped by a whole-call budget,
// so packed groups running in sequence cannot hold an ingest worker for groups x 20s.
describe("embedDocumentTotalTimeoutMs", () => {
  const saved = {
    total: process.env.EMBED_DOCUMENT_TOTAL_TIMEOUT_MS,
    doc: process.env.EMBED_DOCUMENT_CALL_TIMEOUT_MS
  };

  afterEach(() => {
    if (saved.total === undefined) delete process.env.EMBED_DOCUMENT_TOTAL_TIMEOUT_MS;
    else process.env.EMBED_DOCUMENT_TOTAL_TIMEOUT_MS = saved.total;
    if (saved.doc === undefined) delete process.env.EMBED_DOCUMENT_CALL_TIMEOUT_MS;
    else process.env.EMBED_DOCUMENT_CALL_TIMEOUT_MS = saved.doc;
  });

  it("defaults to 60 seconds, longer than one 20-second document attempt", () => {
    delete process.env.EMBED_DOCUMENT_TOTAL_TIMEOUT_MS;
    delete process.env.EMBED_DOCUMENT_CALL_TIMEOUT_MS;
    expect(embedDocumentTotalTimeoutMs()).toBe(DEFAULT_EMBED_DOCUMENT_TOTAL_TIMEOUT_MS);
    expect(DEFAULT_EMBED_DOCUMENT_TOTAL_TIMEOUT_MS).toBeGreaterThan(DEFAULT_EMBED_DOCUMENT_CALL_TIMEOUT_MS);
  });

  it("honors EMBED_DOCUMENT_TOTAL_TIMEOUT_MS", () => {
    delete process.env.EMBED_DOCUMENT_CALL_TIMEOUT_MS;
    process.env.EMBED_DOCUMENT_TOTAL_TIMEOUT_MS = "90000";
    expect(embedDocumentTotalTimeoutMs()).toBe(90_000);
  });

  it("falls back to the default on an invalid value", () => {
    delete process.env.EMBED_DOCUMENT_CALL_TIMEOUT_MS;
    process.env.EMBED_DOCUMENT_TOTAL_TIMEOUT_MS = "nope";
    expect(embedDocumentTotalTimeoutMs()).toBe(DEFAULT_EMBED_DOCUMENT_TOTAL_TIMEOUT_MS);
  });

  it("is never shorter than one document attempt's budget", () => {
    process.env.EMBED_DOCUMENT_CALL_TIMEOUT_MS = "30000";
    process.env.EMBED_DOCUMENT_TOTAL_TIMEOUT_MS = "5000";
    expect(embedDocumentTotalTimeoutMs()).toBe(30_000);
  });
});
