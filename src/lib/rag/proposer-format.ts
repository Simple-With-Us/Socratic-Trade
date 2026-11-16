/** Compact extractive abstracts — put these first in the Green/Red dossier. */
export function isCompactRagSummaryDocType(docType: string | undefined): boolean {
  const t = (docType ?? "").toLowerCase();
  return t === "document-summary" || t === "earnings-summary" || t.endsWith("-summary") || t.endsWith("-brief");
}

/** Summaries first, then remaining chunks by relevance so proposers see catalysts before raw 10-K pages. */
export function orderChunksForProposer<T extends { doc_type?: string; relevanceScore?: number; score?: number }>(
  chunks: T[]
): T[] {
  return [...chunks].sort((a, b) => {
    const aSum = isCompactRagSummaryDocType(a.doc_type) ? 0 : 1;
    const bSum = isCompactRagSummaryDocType(b.doc_type) ? 0 : 1;
    if (aSum !== bSum) return aSum - bSum;
    return (b.relevanceScore ?? b.score ?? 0) - (a.relevanceScore ?? a.score ?? 0);
  });
}
