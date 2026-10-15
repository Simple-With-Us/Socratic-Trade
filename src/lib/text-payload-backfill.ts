// Lazy in-place backfill for text-payload-codec. Updates the body column only.
// Never deletes a row and never keys off age. One companyfacts blob per pass
// because those JSON documents are multi-megabyte; transcripts are small batches.
// A compare-and-swap on the exact stored text drops the write if a producer
// replaced the body between the read and the update.
//
// The scheduler probe selects text_codec / segment_codec IS NULL. Those columns
// are indexed, so a finished corpus does not scan blob text. Each pass then
// reads one body at a time and yields the event loop.

import "server-only";
import { getDb } from "./db";
import { getInternalSetting, setInternalSetting } from "./db-settings";
import { yieldEventLoop } from "./slow-sync-guard";
import {
  decodeTextPayloadAsync,
  encodeTextPayloadAsync,
  isTextPayloadMarked,
  textPayloadCodecTag
} from "./text-payload-codec";
import { SEC_COMPANYFACTS_CACHE_CONCEPT } from "./web-sources/sec-facts";

export const TEXT_PAYLOAD_BACKFILL_INTERVAL_MS = 10 * 60 * 1000;
export const TEXT_PAYLOAD_TRANSCRIPT_BATCH = 16;
export const TEXT_PAYLOAD_SEC_BATCH = 1;

const LAST_AT_KEY = "text-payload-backfill:lastAt";

export interface TextPayloadBackfillResult {
  transcripts: number;
  secFacts: number;
  transcriptsSkipped: number;
  secFactsSkipped: number;
}

function isCorruptTextPayload(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /incorrect header check|unexpected end|invalid distance|gunzip|gzip|base64|gz1 payload/i.test(message);
}

function isDue(now: number): boolean {
  const last = getInternalSetting<string>(LAST_AT_KEY);
  if (typeof last !== "string") return true;
  const then = Date.parse(last);
  if (!Number.isFinite(then)) return true;
  return now - then >= TEXT_PAYLOAD_BACKFILL_INTERVAL_MS;
}

async function stampTranscript(row: {
  symbol: string;
  fiscal_year: number;
  fiscal_quarter: number;
  content: string;
}): Promise<"written" | "skipped"> {
  const db = getDb();
  let stored = row.content;
  let plainLength = row.content.length;
  if (!isTextPayloadMarked(row.content)) {
    stored = await encodeTextPayloadAsync(row.content);
  } else {
    const plain = await decodeTextPayloadAsync(row.content);
    plainLength = plain.length;
  }
  const tag = textPayloadCodecTag(stored);
  const changes = db
    .prepare(
      `UPDATE earningscalls_transcripts
       SET content = ?, text_codec = ?, plaintext_length = ?
       WHERE symbol = ? AND fiscal_year = ? AND fiscal_quarter = ? AND content = ?`
    )
    .run(stored, tag, plainLength, row.symbol, row.fiscal_year, row.fiscal_quarter, row.content).changes;
  return changes === 1 ? "written" : "skipped";
}

async function backfillTranscripts(limit: number): Promise<{ written: number; skipped: number }> {
  const db = getDb();
  const keys = db
    .prepare(
      `SELECT symbol, fiscal_year, fiscal_quarter
       FROM earningscalls_transcripts
       WHERE content IS NOT NULL AND text_codec IS NULL
       LIMIT ?`
    )
    .all(limit) as Array<{ symbol: string; fiscal_year: number; fiscal_quarter: number }>;
  const read = db.prepare(
    `SELECT content FROM earningscalls_transcripts
     WHERE symbol = ? AND fiscal_year = ? AND fiscal_quarter = ?`
  );
  let written = 0;
  let skipped = 0;
  for (const key of keys) {
    const row = read.get(key.symbol, key.fiscal_year, key.fiscal_quarter) as { content: string | null } | undefined;
    if (!row?.content) {
      skipped += 1;
    } else {
      try {
        const outcome = await stampTranscript({ ...key, content: row.content });
        if (outcome === "written") written += 1;
        else skipped += 1;
      } catch (err) {
        if (!isCorruptTextPayload(err)) throw err;
        console.warn(
          "[text-payload-backfill] transcript stamp failed",
          key.symbol,
          err instanceof Error ? err.message : String(err)
        );
        db.prepare(
          `UPDATE earningscalls_transcripts
           SET text_codec = 'err'
           WHERE symbol = ? AND fiscal_year = ? AND fiscal_quarter = ? AND content = ? AND text_codec IS NULL`
        ).run(key.symbol, key.fiscal_year, key.fiscal_quarter, row.content);
        skipped += 1;
      }
    }
    await yieldEventLoop();
  }
  return { written, skipped };
}

async function backfillCompanyFacts(limit: number): Promise<{ written: number; skipped: number }> {
  const db = getDb();
  const keys = db
    .prepare(
      `SELECT id
       FROM sec_facts
       WHERE concept = ? AND segment IS NOT NULL AND segment_codec IS NULL
       LIMIT ?`
    )
    .all(SEC_COMPANYFACTS_CACHE_CONCEPT, limit) as Array<{ id: string }>;
  const read = db.prepare(`SELECT segment FROM sec_facts WHERE id = ?`);
  const update = db.prepare(
    `UPDATE sec_facts SET segment = ?, segment_codec = ? WHERE id = ? AND segment = ?`
  );
  const markErr = db.prepare(
    `UPDATE sec_facts SET segment_codec = 'err' WHERE id = ? AND segment = ? AND segment_codec IS NULL`
  );
  let written = 0;
  let skipped = 0;
  for (const key of keys) {
    const row = read.get(key.id) as { segment: string | null } | undefined;
    if (!row?.segment) {
      skipped += 1;
    } else {
      try {
        const stored = isTextPayloadMarked(row.segment)
          ? row.segment
          : await encodeTextPayloadAsync(row.segment);
        const changes = update.run(stored, textPayloadCodecTag(stored), key.id, row.segment).changes;
        if (changes === 1) written += 1;
        else skipped += 1;
      } catch (err) {
        if (!isCorruptTextPayload(err)) throw err;
        console.warn(
          "[text-payload-backfill] companyfacts stamp failed",
          key.id,
          err instanceof Error ? err.message : String(err)
        );
        markErr.run(key.id, row.segment);
        skipped += 1;
      }
    }
    await yieldEventLoop();
  }
  return { written, skipped };
}

export async function backfillCompressedTextPayloads(opts?: {
  transcriptBatch?: number;
  secBatch?: number;
}): Promise<TextPayloadBackfillResult> {
  const transcriptBatch = opts?.transcriptBatch ?? TEXT_PAYLOAD_TRANSCRIPT_BATCH;
  const secBatch = opts?.secBatch ?? TEXT_PAYLOAD_SEC_BATCH;
  const transcripts = await backfillTranscripts(transcriptBatch);
  const secFacts = await backfillCompanyFacts(secBatch);
  return {
    transcripts: transcripts.written,
    secFacts: secFacts.written,
    transcriptsSkipped: transcripts.skipped,
    secFactsSkipped: secFacts.skipped
  };
}

/**
 * Scheduler entry. Returns null when the 10-minute watermark has not elapsed.
 * The watermark is written only after a pass returns, so a thrown pass retries
 * on the next tick instead of waiting out the interval.
 */
export async function backfillCompressedTextPayloadsIfDue(
  now: number = Date.now()
): Promise<TextPayloadBackfillResult | null> {
  if (!isDue(now)) return null;
  const result = await backfillCompressedTextPayloads();
  setInternalSetting(LAST_AT_KEY, new Date(now).toISOString());
  return result;
}
