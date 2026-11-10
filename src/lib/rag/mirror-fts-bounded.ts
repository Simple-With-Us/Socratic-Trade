import { insertDocumentChunkFtsBatch, ftsMirrorResumeOffset } from "../db-learning";
import { hasInFlightStrategyWork } from "../db-execution";
import { yieldEventLoop } from "../slow-sync-guard";
import { planFtsMirrorSlice } from "./fts-mirror-bound";

export type FtsMirrorRow = {
  contentHash: string;
  symbol: string;
  source: string;
  accession: string;
  text: string;
};

export type MirrorFtsChunksResult = {
  offset: number;
  complete: boolean;
  abortedByStrategy: boolean;
};

/**
 * Mirror FTS rows with the same per-tick slice/yield/strategy gate as sec-ingest-worker.
 * Resumes from `ftsMirrorResumeOffset` when `startOffset` is omitted — the first row whose
 * content hash is not yet indexed.  Resuming on a COUNT instead made the offset stall on any
 * document containing duplicate chunk text, re-mirroring the same slice forever (2026-09-09).
 */
export async function mirrorFtsChunksBounded(
  rows: readonly FtsMirrorRow[],
  options: {
    startOffset?: number;
    gateStrategyWork?: boolean;
    resumeKey?: { symbol: string; source: string; accession: string };
  } = {}
): Promise<MirrorFtsChunksResult> {
  const gateStrategyWork = options.gateStrategyWork ?? true;
  let offset =
    options.startOffset ??
    (options.resumeKey ? ftsMirrorResumeOffset(rows, options.resumeKey) : 0);

  while (offset < rows.length) {
    if (gateStrategyWork && hasInFlightStrategyWork()) {
      return { offset, complete: false, abortedByStrategy: true };
    }

    const tickStartedAt = Date.now();
    const tickStartOffset = offset;
    while (offset < rows.length) {
      if (gateStrategyWork && hasInFlightStrategyWork()) {
        return { offset, complete: false, abortedByStrategy: true };
      }
      const plan = planFtsMirrorSlice({
        totalChunks: rows.length,
        offset,
        chunksDoneThisTick: offset - tickStartOffset,
        elapsedMs: Date.now() - tickStartedAt
      });
      if (plan.chunkCount <= 0) break;
      await insertDocumentChunkFtsBatch(rows.slice(plan.offset, plan.end));
      offset = plan.end;
      if (offset < rows.length) await yieldEventLoop();
    }

    if (offset >= rows.length) {
      return { offset, complete: true, abortedByStrategy: false };
    }
    await yieldEventLoop();
  }

  return { offset, complete: offset >= rows.length, abortedByStrategy: false };
}
