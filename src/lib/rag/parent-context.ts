/**
 * Bounded parent-context expansion runs only after retrieval has selected and ranked child
 * chunks. It never adds a candidate, reorders results, or changes either retrieval score.
 *
 * `parent_text` is stored on the same vector metadata as its child, so an attached parent inherits
 * the child's source, document, section, and point-in-time provenance. The caller still owns the
 * retrieval/PIT gate; this helper additionally declines an attachment that cannot itself satisfy a
 * supplied strict point-in-time boundary.
 */

export const PARENT_CONTEXT_MARKER = "[Parent context]";

export interface ParentContextCandidate {
  id: string;
  text: string;
  score: number;
  relevanceScore?: number;
  metadata?: Record<string, unknown>;
}

export interface ParentContextExpansionOptions {
  /** Explicit opt-in. Disabled leaves the input array and object identities unchanged. */
  enabled?: boolean;
  /** Maximum characters attached for one unique parent. */
  maxParentChars?: number;
  /** Maximum characters attached across the final result set. */
  maxTotalParentChars?: number;
  /** Optional point-in-time boundary copied from retrieval. */
  asOf?: string;
  /** With an active valid `asOf`, decline undated parent metadata as well as future metadata. */
  strictAsOf?: boolean;
}

export interface ParentContextExpansionReceipt {
  attachedParents: number;
  attachedCharacters: number;
  skippedDuplicateParents: number;
  skippedMissingParents: number;
  skippedPointInTimeParents: number;
  skippedBudgetParents: number;
}

export interface ParentContextExpansionResult<T extends ParentContextCandidate> {
  chunks: T[];
  receipt: ParentContextExpansionReceipt;
}

const DEFAULT_MAX_PARENT_CHARS = 6_000;
const DEFAULT_MAX_TOTAL_PARENT_CHARS = 12_000;

function finiteNonNegative(value: number | undefined, fallback: number): number {
  if (value == null || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function parentText(metadata: Record<string, unknown> | undefined): string | undefined {
  const value = metadata?.parent_text;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function provenanceKey(metadata: Record<string, unknown> | undefined, parent: string): string {
  // `content_hash` belongs to the selected CHILD, so including it makes every
  // sibling appear to have a distinct parent. Use parent-specific coordinates
  // when supplied, and always bind the key to the actual parent text. The exact
  // text avoids hash-collision ambiguity and keeps this pure helper bundle-safe.
  const document = [
    metadata?.parent_document_key ?? metadata?.document_key,
    metadata?.parent_accession ?? metadata?.accession,
    metadata?.source,
    metadata?.symbol,
    metadata?.parent_section ?? metadata?.section,
    metadata?.parent_ordinal ?? metadata?.parent_chunk_ordinal
  ]
    .filter((value): value is string | number => typeof value === "string" || typeof value === "number")
    .join("|");
  return `${document}\u0000${parent}`;
}

function parentWithinAsOf(
  metadata: Record<string, unknown> | undefined,
  asOf: string | undefined,
  strict: boolean | undefined
): boolean {
  if (!asOf) return true;
  const boundary = Date.parse(asOf);
  if (!Number.isFinite(boundary)) return true;
  const value = metadata?.acceptance_datetime ?? metadata?.published_at ?? metadata?.as_of ?? metadata?.timestamp;
  if (value == null) return !strict;
  const stamp = typeof value === "number" ? value : Date.parse(String(value));
  if (!Number.isFinite(stamp)) return !strict;
  return stamp <= boundary;
}

function truncateToChars(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}

/**
 * `parent_text` normally contains the child verbatim. Keep the selected child as the citation
 * anchor, but attach only the surrounding parent context so the model does not read the same
 * passage twice. A few legacy chunks have an inline provenance header that the parent lacks, so
 * also try the body after that header. This is deliberately exact-string only: fuzzy removal
 * could damage a filing's prose or fabricate a different source passage.
 */
function parentContextWithoutSelectedChild(parent: string, child: string): string {
  const candidates = [child];
  const headerEnd = child.indexOf("\n\n");
  if (headerEnd >= 0) candidates.push(child.slice(headerEnd + 2));

  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    const index = parent.indexOf(trimmed);
    if (index < 0) continue;
    return `${parent.slice(0, index)}${parent.slice(index + trimmed.length)}`.trim();
  }
  return parent;
}

function emptyReceipt(): ParentContextExpansionReceipt {
  return {
    attachedParents: 0,
    attachedCharacters: 0,
    skippedDuplicateParents: 0,
    skippedMissingParents: 0,
    skippedPointInTimeParents: 0,
    skippedBudgetParents: 0
  };
}

/**
 * Attach each selected parent's text at most once, in the already-ranked input order.
 *
 * A child always remains a child: its id, source metadata, cosine score, and rerank score are
 * retained verbatim. Sibling chunks sharing a parent retain their own child text but only the first
 * eligible sibling carries the parent attachment. This prevents context inflation without hiding
 * a separately-ranked sibling.
 */
export function expandPostRerankParentContext<T extends ParentContextCandidate>(
  chunks: T[],
  options: ParentContextExpansionOptions = {}
): ParentContextExpansionResult<T> {
  const receipt = emptyReceipt();
  if (!options.enabled || chunks.length === 0) return { chunks, receipt };

  const maxParentChars = finiteNonNegative(options.maxParentChars, DEFAULT_MAX_PARENT_CHARS);
  const maxTotalParentChars = finiteNonNegative(options.maxTotalParentChars, DEFAULT_MAX_TOTAL_PARENT_CHARS);
  const seenParents = new Set<string>();
  let remainingTotal = maxTotalParentChars;
  let changed = false;
  const expanded = chunks.map((chunk) => {
    const parent = parentText(chunk.metadata);
    if (!parent) {
      receipt.skippedMissingParents++;
      return chunk;
    }
    const key = provenanceKey(chunk.metadata, parent);
    if (seenParents.has(key)) {
      receipt.skippedDuplicateParents++;
      return chunk;
    }
    // Treat an already-expanded legacy result as the parent attachment for this document. This
    // preserves the final-child-only invariant without duplicating the same context on activation.
    if (chunk.text.includes(parent)) {
      seenParents.add(key);
      receipt.skippedDuplicateParents++;
      return chunk;
    }
    if (!parentWithinAsOf(chunk.metadata, options.asOf, options.strictAsOf)) {
      receipt.skippedPointInTimeParents++;
      return chunk;
    }
    const parentContext = parentContextWithoutSelectedChild(parent, chunk.text);
    if (!parentContext) {
      // The selected child was the complete parent. Attaching it would only duplicate prompt text.
      seenParents.add(key);
      receipt.skippedDuplicateParents++;
      return chunk;
    }
    const allowance = Math.min(maxParentChars, remainingTotal);
    if (allowance <= 0) {
      receipt.skippedBudgetParents++;
      return chunk;
    }
    const attached = truncateToChars(parentContext, allowance);
    if (!attached) {
      receipt.skippedBudgetParents++;
      return chunk;
    }
    seenParents.add(key);
    remainingTotal -= attached.length;
    receipt.attachedParents++;
    receipt.attachedCharacters += attached.length;
    changed = true;
    return { ...chunk, text: `${chunk.text}\n\n${PARENT_CONTEXT_MARKER}\n${attached}` };
  });

  return { chunks: changed ? expanded : chunks, receipt };
}
