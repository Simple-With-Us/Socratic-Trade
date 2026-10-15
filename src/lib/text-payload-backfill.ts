// Lazy in-place backfill for text-payload-codec. Updates the body column only.
// Never deletes a row and never keys off age. One companyfacts blob per pass
// because those JSON documents are multi-megabyte; transcripts are small batches.
// A compare-and-swap on the exact stored text drops the write if a producer
// replaced the body between the read and the update.

import "server-only";
import { getDb } from "./db";
import { getInternalSetting, setInternalSetting } from "./db-settings";
import { yieldEventLoop } from "./slow-sync-guard";
import { encodeTextPayloadAsync, isTextPayloadMarked } from "./text-payload-codec";
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

function claimDue(now: number): boolean {
  const last = getInternalSetting<string>(LAST_AT_KEY);
  if (typeof last === "string") {
    const then = Date.parse(last);
    if (Number.isFinite(then) && now - then < TEXT_PAYLOAD_BACKFILL_INTERVAL_MS) return false;
  }
  setInternalSetting(LAST_AT_KEY, new Date(now).toISOString());
  return true;
}

async function backfillTranscripts(limit: number): Promise<{ written: number; skipped: number }> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT symbol, fiscal_year, fiscal_quarter, content
       FROM earningscalls_transcripts
       WHERE content IS NOT NULL
         AND content NOT GLOB 'gz1:*'
         AND content NOT GLOB 'raw1:*'
       LIMIT ?`
    )
    .all(limit) as Array<{ symbol: string; fiscal_year: number; fiscal_quarter: number; content: string }>;
  const update = db.prepare(
    `UPDATE earningscalls_transcripts
     SET content = ?
     WHERE symbol = ? AND fiscal_year = ? AND fiscal_quarter = ? AND content = ?`
  );
  let written = 0;
  let skipped = 0;
  for (const row of rows) {
    if (isTextPayloadMarked(row.content)) {
      skipped += 1;
      continue;
    }
    const encoded = await encodeTextPayloadAsync(row.content);
    const changes = update.run(encoded, row.symbol, row.fiscal_year, row.fiscal_quarter, row.content).changes;
    if (changes === 1) written += 1;
    else skipped += 1;
    await yieldEventLoop();
  }
  return { written, skipped };
}

async function backfillCompanyFacts(limit: number): Promise<{ written: number; skipped: number }> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, segment
       FROM sec_facts
       WHERE concept = ? AND segment IS NOT NULL
         AND segment NOT GLOB 'gz1:*'
         AND segment NOT GLOB 'raw1:*'
       LIMIT ?`
    )
    .all(SEC_COMPANYFACTS_CACHE_CONCEPT, limit) as Array<{ id: string; segment: string }>;
  const update = db.prepare(`UPDATE sec_facts SET segment = ? WHERE id = ? AND segment = ?`);
  let written = 0;
  let skipped = 0;
  for (const row of rows) {
    const encoded = await encodeTextPayloadAsync(row.segment);
    const changes = update.run(encoded, row.id, row.segment).changes;
    if (changes === 1) written += 1;
    else skipped += 1;
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

/** Scheduler entry. Returns null when the 10-minute watermark has not elapsed. */
export async function backfillCompressedTextPayloadsIfDue(
  now: number = Date.now()
): Promise<TextPayloadBackfillResult | null> {
  if (!claimDue(now)) return null;
  return backfillCompressedTextPayloads();
}
