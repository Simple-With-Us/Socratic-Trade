import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  decodeTextPayload,
  decodeTextPayloadAsync,
  encodeTextPayload,
  encodeTextPayloadAsync,
  TEXT_PAYLOAD_GZIP_PREFIX,
  TEXT_PAYLOAD_RAW_PREFIX
} from "../src/lib/text-payload-codec";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-text-payload-${randomUUID()}.db`)}`;
});

describe("text payload codec", () => {
  it("passes legacy plaintext through", () => {
    expect(decodeTextPayload("Operator remarks about margins.")).toBe("Operator remarks about margins.");
  });

  it("gzip-marks repetitive JSON and round-trips it", () => {
    const json = JSON.stringify(
      Array.from({ length: 400 }, (_, i) => ({
        concept: "Revenues",
        unit: "USD",
        end: "2024-12-31",
        form: "10-K",
        accn: "0000320193-24-000123",
        val: 1000 + i,
        fy: 2024,
        fp: "FY"
      }))
    );
    const encoded = encodeTextPayload(json);
    expect(encoded.startsWith(TEXT_PAYLOAD_GZIP_PREFIX)).toBe(true);
    expect(encoded.length).toBeLessThan(json.length / 3);
    expect(decodeTextPayload(encoded)).toBe(json);
  });

  it("marks incompressible short text raw1 so a backfill can finish", () => {
    const encoded = encodeTextPayload("hi");
    expect(encoded).toBe(`${TEXT_PAYLOAD_RAW_PREFIX}2:hi`);
    expect(decodeTextPayload(encoded)).toBe("hi");
    expect(encodeTextPayload(encoded)).toBe(encoded);
  });

  it("round-trips plaintext that starts with a codec marker", () => {
    for (const plain of ["raw1:hello", "gz1:not-gzip", `${TEXT_PAYLOAD_RAW_PREFIX}2:hi but not a frame`]) {
      const encoded = encodeTextPayload(plain);
      expect(decodeTextPayload(encoded)).toBe(plain);
      expect(encodeTextPayload(encoded)).toBe(encoded);
    }
    expect(decodeTextPayload(`${TEXT_PAYLOAD_RAW_PREFIX}hi`)).toBe("hi");
  });

  it("refuses to treat a broken gz1 payload as text", () => {
    expect(() => decodeTextPayload(`${TEXT_PAYLOAD_GZIP_PREFIX}!!!!`)).toThrow();
  });

  it("passes the empty string through every encode and decode path", async () => {
    expect(encodeTextPayload("")).toBe("");
    expect(decodeTextPayload("")).toBe("");
    expect(await encodeTextPayloadAsync("")).toBe("");
    expect(await decodeTextPayloadAsync("")).toBe("");
    // The async encoder must match the sync one so both forms stay interchangeable.
    expect(await encodeTextPayloadAsync("")).toBe(encodeTextPayload(""));
  });
});

describe("shared readers", () => {
  it("stores transcript and companyfacts bodies compressed and reads them back as text", async () => {
    const { applyVersionedMigrations, getDb } = await import("../src/lib/db");
    applyVersionedMigrations(getDb());
    const { upsertEarningsCallsTranscript, getEarningsCallsTranscript, insertDocumentChunkFts } = await import(
      "../src/lib/db"
    );
    const { upsertCompanyFactsCache, readCompanyFactsCache, SEC_COMPANYFACTS_CACHE_CONCEPT } = await import(
      "../src/lib/web-sources/sec-facts"
    );
    const { backfillCompressedTextPayloads, backfillCompressedTextPayloadsIfDue } = await import(
      "../src/lib/text-payload-backfill"
    );
    const { hasLocalFilingCopy } = await import("../src/lib/rag/persist-local-complete");

    const transcript = `Operator remarks. The prepared remarks follow. ${"Revenue grew in the cloud segment. ".repeat(80)}`;
    upsertEarningsCallsTranscript({
      symbol: "CODEC",
      fiscalYear: 2026,
      fiscalQuarter: 2,
      content: transcript,
      fetchedAt: "2026-10-15T00:00:00.000Z"
    });
    expect(getEarningsCallsTranscript("CODEC", 2026, 2)?.content).toBe(transcript);
    const stored = getDb()
      .prepare("SELECT content FROM earningscalls_transcripts WHERE symbol = ?")
      .get("CODEC") as { content: string };
    expect(stored.content.startsWith(TEXT_PAYLOAD_GZIP_PREFIX)).toBe(true);

    insertDocumentChunkFts("codechashcodechashcodechashco", "CODEC", "earningscalls", "CODEC:2026:Q2", transcript);
    const fts = getDb()
      .prepare("SELECT text FROM document_chunks_fts WHERE content_hash = ?")
      .get("codechashcodechashcodechashco") as { text: string };
    expect(fts.text).toBe(transcript);
    expect(fts.text.startsWith(TEXT_PAYLOAD_GZIP_PREFIX)).toBe(false);

    const facts = JSON.stringify({
      cik: "0000320193",
      facts: {
        "us-gaap": {
          Revenues: {
            units: {
              USD: Array.from({ length: 200 }, (_, i) => ({
                end: "2024-09-28",
                val: 391035000000 + i,
                accn: "0000320193-24-000123",
                fy: 2024,
                fp: "FY",
                form: "10-K",
                filed: "2024-11-01"
              }))
            }
          }
        }
      }
    });
    upsertCompanyFactsCache("320193", facts, "2026-10-15T00:00:00.000Z");
    expect(readCompanyFactsCache("320193")).toEqual({ json: facts, fetchedAt: "2026-10-15T00:00:00.000Z" });
    const segment = getDb()
      .prepare("SELECT segment FROM sec_facts WHERE concept = ?")
      .get(SEC_COMPANYFACTS_CACHE_CONCEPT) as { segment: string };
    expect(segment.segment.startsWith(TEXT_PAYLOAD_GZIP_PREFIX)).toBe(true);

    getDb()
      .prepare(
        `INSERT INTO earningscalls_transcripts
           (symbol, fiscal_year, fiscal_quarter, content, fetched_at)
         VALUES ('LEGACY', 2025, 4, ?, '2025-11-01T00:00:00.000Z')`
      )
      .run(`Legacy plaintext transcript. ${"Question and answer. ".repeat(30)}`);
    const result = await backfillCompressedTextPayloads({ transcriptBatch: 10, secBatch: 1 });
    expect(result.transcripts).toBeGreaterThanOrEqual(1);
    const legacy = getEarningsCallsTranscript("LEGACY", 2025, 4);
    expect(legacy?.content).toContain("Legacy plaintext transcript.");
    const legacyStored = getDb()
      .prepare("SELECT content FROM earningscalls_transcripts WHERE symbol = 'LEGACY'")
      .get() as { content: string };
    expect(legacyStored.content.startsWith(TEXT_PAYLOAD_GZIP_PREFIX)).toBe(true);
    const stamped = getDb()
      .prepare("SELECT text_codec, plaintext_length FROM earningscalls_transcripts WHERE symbol = 'LEGACY'")
      .get() as { text_codec: string; plaintext_length: number };
    expect(stamped.text_codec).toBe("gz1");
    expect(stamped.plaintext_length).toBeGreaterThan(80);

    expect(hasLocalFilingCopy("LEGACY")).toBe(true);
    for (let quarter = 1; quarter <= 9; quarter += 1) {
      upsertEarningsCallsTranscript({
        symbol: "SHORT",
        fiscalYear: 2020,
        fiscalQuarter: quarter,
        content: "hi",
        fetchedAt: "2026-10-15T00:00:00.000Z"
      });
    }
    upsertEarningsCallsTranscript({
      symbol: "SHORT",
      fiscalYear: 2010,
      fiscalQuarter: 1,
      content: transcript,
      fetchedAt: "2026-10-15T00:00:00.000Z"
    });
    expect(hasLocalFilingCopy("SHORT")).toBe(true);

    const first = await backfillCompressedTextPayloadsIfDue(1_000);
    expect(first).not.toBeNull();
    expect(await backfillCompressedTextPayloadsIfDue(1_000 + 60_000)).toBeNull();
  });
});
