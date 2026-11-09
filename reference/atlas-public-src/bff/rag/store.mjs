// In-memory hybrid vector store. This is the documented pgvector swap point:
// keep the function signatures stable and replace the internals with DB-backed
// chunk/vector rows + filtered ANN/FTS when the corpus outgrows memory.

import { config } from '../config.mjs';
import { canonicalTicker } from '../../../../packages/shared/types.mjs';
import { getEmbeddings, tokenizeForEmbedding } from './embeddings.mjs';

const records = new Map();

function dot(a, b) {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

function tokenCounts(text) {
  const counts = new Map();
  for (const t of tokenizeForEmbedding(text)) counts.set(t, (counts.get(t) ?? 0) + 1);
  return counts;
}

function searchableText(chunk) {
  return [
    chunk.context_header, chunk.text, chunk.title, chunk.doc_type, chunk.section,
    ...(chunk.ticker ?? []),
  ].filter(Boolean).join(' ');
}

function matchesFilter(chunk, filter = {}) {
  if (filter.ticker) {
    const want = canonicalTicker(filter.ticker);
    if (!(chunk.ticker ?? []).map(canonicalTicker).includes(want)) return false;
  }
  if (filter.doc_type && String(chunk.doc_type).toLowerCase() !== String(filter.doc_type).toLowerCase()) return false;
  if (filter.as_of && chunk.acceptance_datetime) {
    const asOf = new Date(filter.as_of).getTime();
    const accepted = new Date(chunk.acceptance_datetime).getTime();
    if (!Number.isNaN(asOf) && !Number.isNaN(accepted) && accepted > asOf) return false;
  }
  return true;
}

function lexicalScores(candidates, query) {
  const queryTokens = [...new Set(tokenizeForEmbedding(query))];
  const countsById = new Map();
  const df = new Map();

  for (const r of candidates) {
    const counts = tokenCounts(searchableText(r.chunk));
    countsById.set(r.chunk.chunk_id, counts);
    for (const qt of queryTokens) if (counts.has(qt)) df.set(qt, (df.get(qt) ?? 0) + 1);
  }

  const n = Math.max(1, candidates.length);
  return candidates.map((r) => {
    const counts = countsById.get(r.chunk.chunk_id);
    let score = 0;
    for (const qt of queryTokens) {
      const tf = counts.get(qt) ?? 0;
      if (!tf) continue;
      const idf = Math.log((n + 1) / ((df.get(qt) ?? 0) + 0.5)) + 1;
      score += (1 + Math.log(tf)) * idf;
    }
    return { id: r.chunk.chunk_id, score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
}

function rrf(dense, lexical, k = 60) {
  const scores = new Map();
  const add = (items, weight) => {
    items.forEach((item, rank) => {
      scores.set(item.id, (scores.get(item.id) ?? 0) + weight * (1 / (k + rank + 1)));
    });
  };
  add(dense, 1);
  add(lexical, 1.4);
  return scores;
}

export function countChunks() {
  return records.size;
}

export async function upsertChunks(chunks, { embedder = getEmbeddings(config) } = {}) {
  const written = [];
  for (const chunk of chunks) {
    const vector = await embedder.embed(`${chunk.context_header}\n\n${chunk.text}`);
    if (vector.length !== embedder.dim) throw new Error(`embedding dim ${vector.length} != ${embedder.dim}`);
    const record = {
      chunk,
      vector,
      embedding_model: embedder.model,
      embedding_dim: embedder.dim,
    };
    records.set(chunk.chunk_id, record);
    written.push(record);
  }
  return written;
}

export function deleteDoc(doc_id) {
  let deleted = 0;
  for (const [id, record] of records.entries()) {
    if (record.chunk.doc_id === doc_id) { records.delete(id); deleted++; }
  }
  return deleted;
}

export function listDocs() {
  const docs = new Map();
  for (const { chunk } of records.values()) {
    const existing = docs.get(chunk.doc_id) ?? {
      doc_id: chunk.doc_id,
      title: chunk.title,
      ticker: chunk.ticker ?? [],
      doc_type: chunk.doc_type,
      source: chunk.source,
      url: chunk.url,
      published_at: chunk.published_at,
      acceptance_datetime: chunk.acceptance_datetime,
      chunks: 0,
    };
    existing.chunks++;
    docs.set(chunk.doc_id, existing);
  }
  return [...docs.values()].sort((a, b) => String(b.acceptance_datetime).localeCompare(String(a.acceptance_datetime)));
}

export async function search(query, { filter = {}, k = 5, embedder = getEmbeddings(config) } = {}) {
  const q = String(query ?? '').trim();
  if (!q) return [];
  const queryVector = await embedder.embed(q);
  const candidates = [...records.values()].filter((r) =>
    r.embedding_model === embedder.model &&
    r.embedding_dim === embedder.dim &&
    matchesFilter(r.chunk, filter),
  );
  if (!candidates.length) return [];

  const dense = candidates
    .map((r) => ({ id: r.chunk.chunk_id, score: dot(queryVector, r.vector) }))
    .sort((a, b) => b.score - a.score);
  const lexical = lexicalScores(candidates, q);
  const fused = rrf(dense, lexical);
  const byId = new Map(candidates.map((r) => [r.chunk.chunk_id, r]));

  return [...fused.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(1, Math.min(Number(k) || 5, 12)))
    .map(([id, score]) => {
      const r = byId.get(id);
      const denseRank = dense.findIndex((x) => x.id === id);
      const lexicalRank = lexical.findIndex((x) => x.id === id);
      return {
        ...r.chunk,
        score,
        dense_score: dense.find((x) => x.id === id)?.score ?? 0,
        dense_rank: denseRank === -1 ? null : denseRank + 1,
        lexical_rank: lexicalRank === -1 ? null : lexicalRank + 1,
        embedding_model: r.embedding_model,
        embedding_dim: r.embedding_dim,
        as_of: r.chunk.acceptance_datetime,
      };
    });
}

export function dump() {
  return { records: [...records.entries()] };
}

export function restore(state) {
  records.clear();
  for (const [id, record] of state?.records ?? []) records.set(id, record);
}

export function _reset() {
  records.clear();
}

