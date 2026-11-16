import { rrfFuse } from "./hybrid";
import type { CorpusWideLexicalCandidate } from "./corpus-wide-lexical";

export interface RecallFusionResult {
  matches: any[];
  denseCandidates: number;
  lexicalCandidates: number;
  overlapCandidates: number;
}

function sourcesFor(match: any): string[] {
  const raw = match?.metadata?.retrieval_sources;
  return Array.isArray(raw) ? raw.filter((value): value is string => typeof value === "string") : [];
}

function withSources(match: any, sources: string[]): any {
  return {
    ...match,
    metadata: {
      ...(match?.metadata ?? {}),
      retrieval_sources: Array.from(new Set([...sourcesFor(match), ...sources]))
    }
  };
}

/** Convert an FTS occurrence to the Pinecone-shaped contract consumed by rankPool. */
export function lexicalCandidateToMatch(candidate: CorpusWideLexicalCandidate): any {
  return withSources({
    id: candidate.id,
    score: 0,
    metadata: {
      ...candidate.metadata,
      text: candidate.text,
      source: candidate.source,
      symbol: candidate.symbol,
      accession: candidate.accession,
      ...(candidate.as_of ? { acceptance_datetime: candidate.as_of } : {}),
      ...(candidate.doc_type ? { doc_type: candidate.doc_type } : {}),
      ...(candidate.section ? { section: candidate.section } : {})
    }
  }, ["lexical"]);
}

/** True when a candidate was independently recalled by the corpus-wide lexical source. */
export function hasLexicalRecall(match: any): boolean {
  return sourcesFor(match).includes("lexical");
}

/**
 * Fuse independently-ranked dense and corpus-wide lexical recall with RRF, then de-duplicate by
 * stable occurrence id. A dense copy remains authoritative for cosine score/provider metadata;
 * lexical metadata fills absent fields and records dual provenance on overlaps.
 */
export function fuseDenseAndLexicalRecall(
  denseMatches: any[],
  lexicalCandidates: CorpusWideLexicalCandidate[],
  maxCandidates: number
): RecallFusionResult {
  const dense = denseMatches.map((match) => withSources(match, ["dense"]));
  const lexical = lexicalCandidates.map(lexicalCandidateToMatch);
  if (lexical.length === 0) {
    return {
      matches: dense.slice(0, Math.max(0, maxCandidates)),
      denseCandidates: dense.length,
      lexicalCandidates: 0,
      overlapCandidates: 0
    };
  }

  const denseIds = dense.map((match, index) => (
    typeof match?.id === "string" && match.id.length > 0 ? match.id : `__dense_${index}__`
  ));
  const lexicalIds = lexical.map((match, index) => (
    typeof match?.id === "string" && match.id.length > 0 ? match.id : `__lexical_${index}__`
  ));
  const byId = new Map<string, any>();
  dense.forEach((match, index) => byId.set(denseIds[index]!, match));

  let overlapCandidates = 0;
  lexical.forEach((match, index) => {
    const id = lexicalIds[index]!;
    const denseMatch = byId.get(id);
    if (!denseMatch) {
      byId.set(id, match);
      return;
    }
    overlapCandidates++;
    byId.set(id, {
      ...match,
      ...denseMatch,
      metadata: {
        ...(match.metadata ?? {}),
        ...(denseMatch.metadata ?? {}),
        retrieval_sources: ["dense", "lexical"]
      }
    });
  });

  const cap = Math.max(0, Math.floor(maxCandidates));
  const fusedIds = rrfFuse([denseIds, lexicalIds]);
  return {
    matches: fusedIds.slice(0, cap).map((id) => byId.get(id)).filter((match) => match !== undefined),
    denseCandidates: dense.length,
    lexicalCandidates: lexical.length,
    overlapCandidates
  };
}
