// Token-budget packing for embed POSTs.  Pack AFTER hybrid condense — not a second filing chunker.
//
// OpenRouter `baai/bge-m3` is served by DeepInfra, which sums EVERY string in
// `input: string[]` against the model's 8192-token context.  A count-only batch
// (`VECTOR_EMBED_BATCH_SIZE=32` in prod) of ordinary ~256-token chunks hits 8193
// and 400s the whole lane.  Pack by estimated tokens (and a conservative byte
// cap) so Infisical can keep the count at 32 without ever sending that request.
//
// `storeContexts` packs already-condensed texts into in-window groups and embeds
// each group on its own lane.  A single over-limit condensed text is isolated
// as its own POST with the original string intact (metadata/hash stay whole; no
// extra Pinecone records).  If that singleton still 400s, companions still
// upsert.  Hybrid chunking stays in `chunkDocument` (480 tokens).

import { approxTokens } from "../rag-metering";

/** DeepInfra/bge-m3 context.  A multi-text request at this size 400s. */
export const EMBED_MODEL_CONTEXT_TOKENS = 8192;

/**
 * Per-request token headroom.  Do not aim at 8192 — live receipts failed at 8193.
 * Uses the same estimator as rag_usage (`approxTokens`, UTF-8 bytes / 4).
 */
export const EMBED_REQUEST_TOKEN_BUDGET = 7500;

/**
 * Extra byte cap so a `VECTOR_CONTEXT_MAX_CHARS=2400` batch cannot sneak past
 * 8192 if DeepInfra tokenizes denser than bytes/4.  2.5 bytes/token * 7500.
 */
export const EMBED_REQUEST_BYTE_BUDGET = 18_750;

export interface EmbedTextRef {
  text: string;
  sourceIndex: number;
}

export function embedTextByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export function embedTextTokenEstimate(text: string): number {
  return approxTokens([text]);
}

export function embedRequestFits(
  texts: readonly string[],
  tokenBudget: number = EMBED_REQUEST_TOKEN_BUDGET,
  byteBudget: number = EMBED_REQUEST_BYTE_BUDGET
): boolean {
  if (texts.length === 0) return true;
  let bytes = 0;
  for (const text of texts) {
    bytes += embedTextByteLength(text);
    if (bytes > byteBudget) return false;
  }
  return approxTokens([...texts]) <= tokenBudget;
}

/**
 * Pack texts so each request stays under the token/byte budgets and under
 * `maxCount`.  `maxCount` is a ceiling (prod may be 32), not a target.
 * A single over-budget text is isolated as its own group — never split.
 */
export function packInWindowTexts(
  items: readonly EmbedTextRef[],
  options?: {
    tokenBudget?: number;
    byteBudget?: number;
    maxCount?: number;
  }
): EmbedTextRef[][] {
  const tokenBudget = options?.tokenBudget ?? EMBED_REQUEST_TOKEN_BUDGET;
  const byteBudget = options?.byteBudget ?? EMBED_REQUEST_BYTE_BUDGET;
  const maxCount = Math.max(1, options?.maxCount ?? Number.POSITIVE_INFINITY);
  const groups: EmbedTextRef[][] = [];
  let current: EmbedTextRef[] = [];

  const flush = () => {
    if (current.length > 0) groups.push(current);
    current = [];
  };

  for (const item of items) {
    if (!embedRequestFits([item.text], tokenBudget, byteBudget)) {
      flush();
      groups.push([item]);
      continue;
    }
    const next = [...current, item];
    const nextTexts = next.map((entry) => entry.text);
    if (
      current.length > 0 &&
      (next.length > maxCount || !embedRequestFits(nextTexts, tokenBudget, byteBudget))
    ) {
      flush();
    }
    current.push(item);
  }
  flush();
  return groups;
}
