import { createHash } from "crypto";

/**
 * A retrieved RAG chunk as it is about to enter a prompt. `serializedText` is
 * deliberately input-only: no raw query or prompt text is returned in the
 * durable receipt/audit shape.
 */
export interface PromptRagCandidate {
  readonly chunkId?: string;
  readonly symbol: string;
  readonly source?: string;
  readonly docType?: string;
  readonly title?: string;
  readonly url?: string;
  readonly publishedAt?: string;
  readonly score?: number;
  readonly relevanceScore?: number;
  readonly text: string;
  /** Exact chunk serialization before the enclosing prompt budget is applied. */
  readonly serializedText: string;
}

export type PromptConsumptionState = "consumed" | "truncated" | "not_consumed";
export type PromptRagRetrievalOutcome = "not_attempted" | "empty" | "retrieval_failed" | "assembled";

/** Safe, stable receipt: identifiers and counts only, never raw prompt/query text. */
export interface PromptRagConsumptionReceipt {
  readonly evidenceRef: string;
  readonly chunkId?: string;
  readonly symbol: string;
  readonly docType?: string;
  readonly state: PromptConsumptionState;
  readonly serializedCharacters: number;
  readonly consumedCharacters: number;
}

export interface PromptRagConsumptionResult {
  /**
   * Text-free retrieval/assembly outcome. An `assembled` receipt can still have
   * zero consumed rows when containment or the shared evidence budget omitted
   * every candidate.
   */
  readonly outcome: PromptRagRetrievalOutcome;
  readonly retrievedCandidateCount: number;
  readonly uniqueCandidateCount: number;
  readonly duplicateCandidateCount: number;
  /** Number of upstream retrieval passes that failed; never includes raw errors. */
  readonly retrievalFailureCount: number;
  readonly consumed: readonly PromptRagConsumptionReceipt[];
  readonly retrievedButNotConsumed: readonly PromptRagConsumptionReceipt[];
}

export interface PromptRagConsumptionOptions {
  /** False means the caller skipped retrieval because no model prompt will be assembled. */
  readonly retrievalAttempted?: boolean;
  /** Aggregate only: error strings remain in the existing retrieval-status receipt. */
  readonly retrievalFailureCount?: number;
}

function stableJson(value: Record<string, string | undefined>): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(value)
        .filter(([, field]) => field)
        .sort(([left], [right]) => left.localeCompare(right))
    )
  );
}

/**
 * Stable ref for the underlying evidence, independent of query text, prompt
 * text, score ordering, or retrieval route. Prefer the real vector id; fall
 * back to immutable provenance when a legacy vector lacks one.
 */
export function stableRagEvidenceRef(candidate: Omit<PromptRagCandidate, "serializedText" | "text">): string {
  const identity = candidate.chunkId
    ? stableJson({ chunkId: candidate.chunkId })
    : stableJson({
        source: candidate.source,
        docType: candidate.docType,
        url: candidate.url,
        publishedAt: candidate.publishedAt,
        symbol: candidate.symbol
      });
  return `rag_${createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 24)}`;
}

function uniqueCandidates(candidates: readonly PromptRagCandidate[]): PromptRagCandidate[] {
  const seen = new Set<string>();
  const result: PromptRagCandidate[] = [];
  for (const candidate of candidates) {
    if (!candidate.serializedText) continue;
    const evidenceRef = stableRagEvidenceRef(candidate);
    if (seen.has(evidenceRef)) continue;
    seen.add(evidenceRef);
    result.push(candidate);
  }
  return result;
}

/**
 * Returns the longest initial part of `candidateText` that is visibly present
 * at the same logical chunk boundary in a serialized prompt. A whole match is
 * consumed; a prefix at the tail is a budget/containment truncation. The
 * candidate header makes normal chunk boundaries unique, while the tail guard
 * prevents a coincidental phrase elsewhere in the prompt from receiving credit.
 */
function consumedCharacters(candidateText: string, promptText: string): number {
  const whole = promptText.indexOf(candidateText);
  if (whole >= 0) return candidateText.length;

  // Keep the anchor short enough to recognize a useful budget-tail prefix
  // (the evidence budget can cut before 32 characters), while the end-of-prompt
  // guard below prevents an incidental phrase elsewhere from earning credit.
  const minAnchor = Math.min(16, candidateText.length);
  if (minAnchor === 0) return 0;
  const anchor = candidateText.slice(0, minAnchor);
  let from = 0;
  while (from < promptText.length) {
    const start = promptText.indexOf(anchor, from);
    if (start < 0) return 0;
    const available = promptText.slice(start, Math.min(promptText.length, start + candidateText.length));
    let matched = 0;
    while (matched < available.length && available[matched] === candidateText[matched]) matched += 1;
    // A partial match is evidence only when the serialized prompt ends inside
    // this chunk. Otherwise containment changed it and the exact consumed span
    // cannot be proven from text alone, so fail closed to not-consumed.
    if (matched > 0 && start + matched === promptText.length) return matched;
    from = start + 1;
  }
  return 0;
}

/**
 * Derive durable RAG consumption receipts from the exact strings that are
 * serialized into the model payload after containment and evidence budgeting.
 * Retrieval is not consumption: a candidate is credited only when its complete
 * text, or a prompt-tail prefix of it, is actually present.
 */
export function derivePromptRagConsumption(
  candidates: readonly PromptRagCandidate[],
  serializedPromptFields: readonly string[],
  options: PromptRagConsumptionOptions = {}
): PromptRagConsumptionResult {
  const promptText = serializedPromptFields.filter(Boolean).join("\n\n");
  const unique = uniqueCandidates(candidates);
  const retrievalFailureCount = Math.max(0, Math.floor(options.retrievalFailureCount ?? 0));
  const outcome: PromptRagRetrievalOutcome = unique.length > 0
    ? "assembled"
    : retrievalFailureCount > 0
      ? "retrieval_failed"
      : options.retrievalAttempted === false
        ? "not_attempted"
        : "empty";
  const consumed: PromptRagConsumptionReceipt[] = [];
  const retrievedButNotConsumed: PromptRagConsumptionReceipt[] = [];
  for (const candidate of unique) {
    const consumedCharactersCount = consumedCharacters(candidate.serializedText, promptText);
    const state: PromptConsumptionState = consumedCharactersCount === candidate.serializedText.length
      ? "consumed"
      : consumedCharactersCount > 0
        ? "truncated"
        : "not_consumed";
    const receipt: PromptRagConsumptionReceipt = {
      evidenceRef: stableRagEvidenceRef(candidate),
      ...(candidate.chunkId ? { chunkId: candidate.chunkId } : {}),
      symbol: candidate.symbol,
      ...(candidate.docType ? { docType: candidate.docType } : {}),
      state,
      serializedCharacters: candidate.serializedText.length,
      consumedCharacters: consumedCharactersCount
    };
    if (state === "not_consumed") retrievedButNotConsumed.push(receipt);
    else consumed.push(receipt);
  }
  return {
    outcome,
    retrievedCandidateCount: candidates.length,
    uniqueCandidateCount: unique.length,
    duplicateCandidateCount: Math.max(0, candidates.length - unique.length),
    retrievalFailureCount,
    consumed,
    retrievedButNotConsumed
  };
}
