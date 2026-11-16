// Token-budget packing for embed POSTs.  Pack AFTER hybrid condense — not a second filing chunker.
//
// OpenRouter `baai/bge-m3` (DeepInfra) sums EVERY string in `input: string[]` against the
// model's 8192-token context.  A count-only batch at the limit 400s with
// "maximum context length is 8192 tokens".  Bytes/4 under-counts digit and pipe runs
// (tables, filings), so a request that looks under 8192 still 400s.  This module estimates
// tokens with that denser floor, truncates or chunks each input to the budget, then packs
// the pieces so no POST can sum past it.

import { approxTokens } from "../rag-metering";

/** DeepInfra/bge-m3 context.  A multi-text request at this size 400s. */
export const EMBED_MODEL_CONTEXT_TOKENS = 8192;

/**
 * Per-request token headroom.  Do not aim at 8192 — live receipts failed at 8193.
 * Every ingest text window uses this same ceiling (SOCRATIC-TRADE-2E counts windows of it).
 */
export const EMBED_REQUEST_TOKEN_BUDGET = 7500;

/**
 * Extra byte cap so a `VECTOR_CONTEXT_MAX_CHARS=2400` batch cannot sneak past
 * 8192 if the provider tokenizes denser than the character floor.  2.5 bytes/token * 7500.
 */
export const EMBED_REQUEST_BYTE_BUDGET = 18_750;

/** Prose chars per token.  Digit and pipe characters count as one token each. */
const EMBED_PROSE_CHARS_PER_TOKEN = 3.5;

export interface EmbedTextRef {
  text: string;
  sourceIndex: number;
}

export function embedTextByteLength(text: string): number {
  if (typeof text !== "string") {
    throw new TypeError("embed text must be a string");
  }
  return Buffer.byteLength(text, "utf8");
}

function isDenseEmbedChar(code: number): boolean {
  return (code >= 48 && code <= 57) || code === 124 || code === 36;
}

/**
 * Conservative token estimate for one embed string.  Takes the max of UTF-8 bytes/4
 * and a mixed floor (digits, `$`, and `|` at 1 token each; the rest at 3.5 chars/token)
 * so a table the byte estimator calls "safe" is still split before the POST.
 */
export function embedTokenEstimate(text: string): number {
  if (typeof text !== "string") {
    throw new TypeError("embed text must be a string");
  }
  if (!text) return 1;
  const byteTokens = Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 4));
  let dense = 0;
  for (let i = 0; i < text.length; i++) {
    if (isDenseEmbedChar(text.charCodeAt(i))) dense += 1;
  }
  const mixed = Math.max(1, Math.ceil(dense + (text.length - dense) / EMBED_PROSE_CHARS_PER_TOKEN));
  return Math.max(byteTokens, mixed);
}

export function embedTextTokenEstimate(text: string): number {
  return embedTokenEstimate(text);
}

export function isEmbedContextLengthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /maximum context length|input_tokens|too many tokens|context length/i.test(message);
}

function pieceFits(
  text: string,
  tokenBudget: number,
  byteBudget: number
): boolean {
  return embedRequestFits([text], tokenBudget, byteBudget);
}

/** Shorten one string until the conservative estimate fits the token and byte budgets.  Word boundary when it keeps most of the prefix. */
export function truncateEmbedText(
  text: string,
  tokenBudget: number = EMBED_REQUEST_TOKEN_BUDGET,
  byteBudget: number = EMBED_REQUEST_BYTE_BUDGET
): string {
  if (tokenBudget < 1 || byteBudget < 1) return "";
  if (pieceFits(text, tokenBudget, byteBudget)) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (pieceFits(text.slice(0, mid), tokenBudget, byteBudget)) lo = mid;
    else hi = mid - 1;
  }
  const sliced = text.slice(0, Math.max(0, lo));
  const breakAt = sliced.lastIndexOf(" ");
  if (breakAt > sliced.length * 0.8) return sliced.slice(0, breakAt);
  return sliced;
}

/**
 * Split one over-budget string into pieces that each fit the token and byte budgets.
 * A string that already fits is returned unchanged (one piece, not a copy of the chars).
 */
export function chunkEmbedText(
  text: string,
  tokenBudget: number = EMBED_REQUEST_TOKEN_BUDGET,
  byteBudget: number = EMBED_REQUEST_BYTE_BUDGET
): string[] {
  if (pieceFits(text, tokenBudget, byteBudget)) return [text];
  const parts: string[] = [];
  let current = "";
  const push = (piece: string) => {
    const trimmed = piece.trim();
    if (trimmed) parts.push(trimmed);
  };
  for (const word of text.split(/\s+/)) {
    if (!word) continue;
    if (!pieceFits(word, tokenBudget, byteBudget)) {
      push(current);
      current = "";
      let rest = word;
      while (rest) {
        const slice = truncateEmbedText(rest, tokenBudget, byteBudget);
        if (!slice) break;
        parts.push(slice);
        if (slice.length >= rest.length) break;
        rest = rest.slice(slice.length);
      }
      continue;
    }
    const next = current ? `${current} ${word}` : word;
    if (current && !pieceFits(next, tokenBudget, byteBudget)) {
      push(current);
      current = word;
    } else {
      current = next;
    }
  }
  push(current);
  return parts.length > 0 ? parts : [truncateEmbedText(text, tokenBudget, byteBudget)];
}

/** How many embed-budget windows this text will consume.  One window == `EMBED_REQUEST_TOKEN_BUDGET`. */
export function embedBudgetUnits(
  text: string,
  tokenBudget: number = EMBED_REQUEST_TOKEN_BUDGET,
  byteBudget: number = EMBED_REQUEST_BYTE_BUDGET
): number {
  return Math.max(1, chunkEmbedText(text, tokenBudget, byteBudget).length);
}

/**
 * Queries keep one string (truncated).  Documents may become several pieces.
 * Callers mean-pool document pieces back to one vector so Pinecone cardinality stays put.
 */
export function prepareEmbedInputPieces(
  input: readonly string[],
  inputType: "document" | "query"
): EmbedTextRef[] {
  const pieces: EmbedTextRef[] = [];
  for (let sourceIndex = 0; sourceIndex < input.length; sourceIndex++) {
    const raw = input[sourceIndex] ?? "";
    const parts = inputType === "query" ? [truncateEmbedText(raw)] : chunkEmbedText(raw);
    for (const text of parts) pieces.push({ text, sourceIndex });
  }
  return pieces;
}

/**
 * How many leading texts fit in `allowedUnits` windows.  A text that itself needs more
 * windows than remain stops the prefix (same shape as the old text-count slice).
 *
 * `precomputedUnits` lets a caller that already summed `embedBudgetUnits` over the same
 * texts (the ingest-budget reduce) hand the results back instead of paying a second
 * char-walk + binary-search truncation per text.  It is keyed by the exact text and must
 * only carry values computed with the same `tokenBudget`; anything absent is computed here.
 */
export function prefixCountWithinEmbedUnits(
  texts: readonly string[],
  allowedUnits: number,
  tokenBudget: number = EMBED_REQUEST_TOKEN_BUDGET,
  precomputedUnits?: ReadonlyMap<string, number>
): number {
  if (allowedUnits <= 0) return 0;
  let used = 0;
  let count = 0;
  for (const text of texts) {
    const cost = precomputedUnits?.get(text) ?? embedBudgetUnits(text, tokenBudget);
    if (used + cost > allowedUnits) break;
    used += cost;
    count += 1;
  }
  return count;
}

export function embedRequestFits(
  texts: readonly string[],
  tokenBudget: number = EMBED_REQUEST_TOKEN_BUDGET,
  byteBudget: number = EMBED_REQUEST_BYTE_BUDGET
): boolean {
  if (texts.length === 0) return true;
  let bytes = 0;
  let tokens = 0;
  for (const text of texts) {
    bytes += embedTextByteLength(text);
    tokens += embedTokenEstimate(text);
    if (bytes > byteBudget || tokens > tokenBudget) return false;
  }
  return true;
}

/**
 * Pack texts so each request stays under the token/byte budgets and under
 * `maxCount`.  `maxCount` is a ceiling (prod may be 32), not a target.
 * A single over-budget text is isolated as its own group — the embed caller
 * chunks or truncates that group before the POST.  This function does not split it.
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

/** Kept so metering tests can still see the bytes/4 estimator next to the conservative one. */
export function embedByteTokenEstimate(texts: readonly string[]): number {
  return approxTokens([...texts]);
}
