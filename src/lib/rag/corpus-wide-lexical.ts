/**
 * Corpus-wide lexical candidates backed by the persisted FTS5 filing text.
 *
 * This module deliberately stops before retrieval orchestration: it performs no Pinecone query,
 * no embedding, no reranking, and no RRF. A later integration layer can run it beside dense
 * recall and fuse the two independently-ranked candidate lists. Keeping this read-only adapter
 * separate makes its point-in-time and query-safety contract directly testable.
 */
import { getDb } from "../db";
import { canonicalTicker } from "./chunk";

const MAX_QUERY_CHARS = 8_192;
const MAX_QUERY_TERMS = 32;
const MAX_QUERY_TERM_CHARS = 128;
const MAX_LIMIT = 100;
const RAW_RESULT_MULTIPLIER = 8;
const MAX_RAW_RESULTS = 800;

export interface CorpusWideLexicalSearchOptions {
  /** Issuer ticker. An empty/invalid ticker never broadens to a corpus-wide search. */
  symbol: string;
  /** Untrusted operator/model query text. It is tokenized before being passed to FTS5. */
  query: string;
  /** Returned occurrence candidates, after deterministic de-duplication. Default 20. */
  limit?: number;
  /** Point-in-time cutoff. An invalid cutoff fails closed and returns no candidates. */
  asOf?: string | number | Date;
  /**
   * With an as-of cutoff, reject missing or malformed occurrence `accepted_at` values. Defaults
   * to true because a financial backtest must not silently treat unknown availability as eligible.
   */
  strictUndated?: boolean;
  /**
   * Authoritative tenant scopes visible to the requesting user. The shared filing scope is the
   * only default; callers must opt in to the requester's hashed private scope explicitly.
  */
  visibleTenantScopes?: readonly string[];
  /** Apply retrieval metadata filters before the FTS result cap is consumed. */
  docTypes?: readonly string[];
  source?: string;
  section?: string;
}

/**
 * The lexical analogue of `RetrievedChunk`. `score` intentionally remains 0 because FTS5 BM25 is
 * not comparable to Pinecone cosine. Consumers must use `lexicalScore` or RRF, never a cosine
 * floor, to rank these candidates.
 */
export interface CorpusWideLexicalCandidate {
  /** Stable managed vector/occurrence identity from `chunk_occurrences`. */
  id: string;
  text: string;
  /** Never fabricate cosine similarity for an independently recalled lexical candidate. */
  score: 0;
  lexicalScore: number;
  source: string;
  symbol: string;
  accession: string;
  as_of?: string;
  doc_type?: string;
  section?: string;
  acceptedAt?: string;
  retrievalSources: readonly ["lexical"];
  metadata: Record<string, unknown>;
}

type LexicalRow = {
  vector_id: string;
  content_hash: string;
  symbol: string;
  source: string;
  accession: string;
  text: string;
  section: string;
  accepted_at: string | null;
  doc_type: string | null;
  tenant_scope: string;
  user_id: string | null;
  lexical_score: number;
};

function normalizedLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return 20;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(value!)));
}

function canonicalAsOf(value: CorpusWideLexicalSearchOptions["asOf"]): string | undefined | null {
  if (value == null) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function canonicalAcceptedAt(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

/**
 * Compile arbitrary text to a conservative FTS5 OR query. Every user-controlled token is quoted,
 * so FTS operators (`OR`, `NEAR`, `*`, column filters, parentheses) remain literal text rather
 * than altering the query plan. This preserves recall for natural-language questions, where a
 * relevant filing may contain only its discriminative terms. `null` means no searchable token.
 */
export function compileCorpusWideLexicalQuery(query: string): string | null {
  if (typeof query !== "string" || query.length === 0 || query.length > MAX_QUERY_CHARS) return null;
  const terms: string[] = [];
  const seenTerms = new Set<string>();
  for (const rawTerm of query.match(/[\p{L}\p{N}][\p{L}\p{N}._/-]*/gu) ?? []) {
    const term = rawTerm.slice(0, MAX_QUERY_TERM_CHARS);
    const normalizedTerm = term.toLocaleLowerCase();
    if (seenTerms.has(normalizedTerm)) continue;
    seenTerms.add(normalizedTerm);
    terms.push(term);
    if (terms.length >= MAX_QUERY_TERMS) break;
  }
  if (terms.length === 0) return null;
  return terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(" OR ");
}

/**
 * Search the local filing-text corpus for exact lexical candidates.
 *
 * `chunk_occurrences.accepted_at` is the availability authority. The FTS table intentionally
 * stores occurrence text only, so the join requires all occurrence coordinates rather than a
 * content-hash-only join; identical boilerplate in two filings must remain independently eligible.
 */
export function searchCorpusWideLexicalCandidates(
  options: CorpusWideLexicalSearchOptions
): CorpusWideLexicalCandidate[] {
  const symbol = canonicalTicker(options.symbol);
  const matchQuery = compileCorpusWideLexicalQuery(options.query);
  const asOf = canonicalAsOf(options.asOf);
  if (!symbol || !matchQuery || asOf === null) return [];

  const limit = normalizedLimit(options.limit);
  const rawLimit = Math.min(MAX_RAW_RESULTS, limit * RAW_RESULT_MULTIPLIER);
  const strictUndated = options.strictUndated !== false;
  const visibleTenantScopes = Array.from(new Set(
    (options.visibleTenantScopes ?? ["shared:operator"])
      .filter((scope): scope is string => typeof scope === "string" && scope.trim().length > 0)
      .map((scope) => scope.trim())
  )).slice(0, 8);
  if (visibleTenantScopes.length === 0) return [];
  const params: unknown[] = [symbol, matchQuery, symbol, ...visibleTenantScopes];
  const metadataFilters: string[] = [];
  const metadataFilterParams: string[] = [];
  const docTypes = Array.from(new Set(
    (options.docTypes ?? [])
      .filter((docType): docType is string => typeof docType === "string" && docType.trim().length > 0)
      .map((docType) => docType.trim().toLowerCase())
  ));
  if (docTypes.length > 0) {
    // Full-body 8-K ingestion mirrors chunks into FTS without creating a sec_filings row. Treat
    // its authoritative occurrence source as the document type for filtering instead of dropping
    // every otherwise-visible 8-K row on the NULL left join.
    metadataFilters.push(`LOWER(TRIM(CASE WHEN o.source = 'sec-8k' THEN '8-k' ELSE sf.form END)) IN (${docTypes.map(() => "?").join(", ")})`);
    metadataFilterParams.push(...docTypes);
  }
  if (options.source?.trim()) {
    metadataFilters.push("o.source = ?");
    metadataFilterParams.push(options.source.trim());
  }
  if (options.section?.trim()) {
    metadataFilters.push("o.section = ?");
    metadataFilterParams.push(options.section.trim());
  }
  params.push(...metadataFilterParams);
  const tenantPlaceholders = visibleTenantScopes.map(() => "?").join(", ");
  const receiptClause = asOf
    ? `AND (
        (
          o.receipt_state = 'legacy_committed'
          AND NOT EXISTS (
            SELECT 1
            FROM vector_ingest_commits shadow_commit
            JOIN vector_document_versions shadow_version
              ON shadow_version.commit_id = shadow_commit.id
              AND shadow_version.tenant_scope = shadow_commit.tenant_scope
              AND shadow_version.source = shadow_commit.source
              AND shadow_version.document_key = shadow_commit.document_key
            WHERE shadow_commit.state = 'committed'
              AND shadow_commit.lease_expires_at IS NULL
              AND shadow_commit.source = o.source
              AND shadow_commit.document_key = o.accession
              AND shadow_commit.tenant_scope IN (${tenantPlaceholders})
              AND shadow_version.valid_from <= ?
              AND (shadow_version.valid_to IS NULL OR shadow_version.valid_to > ?)
          )
        )
        OR (
          o.receipt_state = 'committed'
          AND EXISTS (
            SELECT 1
            FROM vector_ingest_commits c
            JOIN vector_document_versions v
              ON v.commit_id = c.id
              AND v.tenant_scope = c.tenant_scope
              AND v.source = c.source
              AND v.document_key = c.document_key
            WHERE c.id = o.commit_id
              AND c.state = 'committed'
              AND c.lease_expires_at IS NULL
              AND o.tenant_scope = c.tenant_scope
              AND o.content_version = c.content_version
              AND v.valid_from <= ?
              AND (v.valid_to IS NULL OR v.valid_to > ?)
          )
        )
      )`
    : `AND (
        (
          o.receipt_state = 'legacy_committed'
          AND NOT EXISTS (
            SELECT 1
            FROM vector_ingest_commits shadow_commit
            JOIN vector_document_heads shadow_head
              ON shadow_head.commit_id = shadow_commit.id
              AND shadow_head.tenant_scope = shadow_commit.tenant_scope
              AND shadow_head.source = shadow_commit.source
              AND shadow_head.accession = shadow_commit.document_key
            WHERE shadow_commit.state = 'committed'
              AND shadow_commit.lease_expires_at IS NULL
              AND shadow_commit.source = o.source
              AND shadow_commit.document_key = o.accession
              AND shadow_commit.tenant_scope IN (${tenantPlaceholders})
          )
        )
        OR (
          o.receipt_state = 'committed'
          AND EXISTS (
            SELECT 1
            FROM vector_ingest_commits c
            JOIN vector_document_heads h
              ON h.commit_id = c.id
              AND h.tenant_scope = c.tenant_scope
              AND h.source = c.source
              AND h.accession = c.document_key
            WHERE c.id = o.commit_id
              AND c.state = 'committed'
              AND c.lease_expires_at IS NULL
              AND o.tenant_scope = c.tenant_scope
              AND o.content_version = c.content_version
          )
        )
      )`;
  params.push(...visibleTenantScopes);
  if (asOf) params.push(asOf, asOf, asOf, asOf);
  let pitClause = "";
  if (asOf) {
    if (strictUndated) {
      pitClause = `
        AND NULLIF(TRIM(o.accepted_at), '') IS NOT NULL
        AND julianday(o.accepted_at) IS NOT NULL
        AND julianday(o.accepted_at) <= julianday(?)`;
    } else {
      pitClause = `
        AND (
          NULLIF(TRIM(o.accepted_at), '') IS NULL
          OR julianday(o.accepted_at) IS NULL
          OR julianday(o.accepted_at) <= julianday(?)
        )`;
    }
    params.push(asOf);
  }
  params.push(rawLimit);

  const rows = getDb().prepare(`
    SELECT
      o.vector_id,
      document_chunks_fts.content_hash,
      document_chunks_fts.symbol,
      document_chunks_fts.source,
      document_chunks_fts.accession,
      document_chunks_fts.text,
      o.section,
      o.accepted_at,
      sf.form AS doc_type,
      o.tenant_scope,
      owner_commit.user_id,
      bm25(document_chunks_fts) AS lexical_score
    FROM document_chunks_fts
    INNER JOIN chunk_occurrences o
      ON o.content_hash = document_chunks_fts.content_hash
      AND o.symbol = document_chunks_fts.symbol
      AND o.source = document_chunks_fts.source
      AND o.accession = document_chunks_fts.accession
    LEFT JOIN sec_filings sf ON sf.accession = o.accession
    LEFT JOIN vector_ingest_commits owner_commit ON owner_commit.id = o.commit_id
    WHERE document_chunks_fts.symbol = ?
      AND document_chunks_fts.text MATCH ?
      AND o.symbol = ?
      AND (
        o.tenant_scope IN (${visibleTenantScopes.map(() => "?").join(", ")})
        OR (
          o.tenant_scope = 'legacy'
          AND o.receipt_state = 'legacy_committed'
        )
      )
      -- This index is a filing-text recall source. Licensed transcript and user-authored sources
      -- require additional rights/ownership metadata that document_chunks_fts does not store.
      AND o.source IN ('sec-edgar', 'sec-8k')
      ${metadataFilters.length > 0 ? `AND ${metadataFilters.join(" AND ")}` : ""}
      ${receiptClause}
      ${pitClause}
    ORDER BY
      lexical_score ASC,
      CASE WHEN julianday(o.accepted_at) IS NULL THEN 1 ELSE 0 END ASC,
      julianday(o.accepted_at) DESC,
      o.vector_id ASC
    LIMIT ?
  `).all(...params) as LexicalRow[];

  const candidates: CorpusWideLexicalCandidate[] = [];
  const seenOccurrenceIds = new Set<string>();
  for (const row of rows) {
    if (!row.vector_id || seenOccurrenceIds.has(row.vector_id)) continue;
    seenOccurrenceIds.add(row.vector_id);
    const acceptedAt = canonicalAcceptedAt(row.accepted_at);
    const docType = row.doc_type?.trim().toLowerCase() || undefined;
    candidates.push({
      id: row.vector_id,
      text: row.text,
      score: 0,
      lexicalScore: Number(row.lexical_score),
      source: row.source,
      symbol: row.symbol,
      accession: row.accession,
      ...(acceptedAt ? { as_of: acceptedAt, acceptedAt } : {}),
      ...(docType ? { doc_type: docType } : {}),
      ...(row.section?.trim() ? { section: row.section } : {}),
      retrievalSources: ["lexical"],
      metadata: {
        content_hash: row.content_hash,
        symbol: row.symbol,
        source: row.source,
        accession: row.accession,
        accepted_at: acceptedAt ?? null,
        section: row.section,
        tenant_scope: row.tenant_scope === "legacy" ? "shared:operator" : row.tenant_scope,
        scope: row.tenant_scope.startsWith("private:") ? "private" : "shared",
        userId: row.user_id ?? "local",
        ...(docType ? { doc_type: docType } : {}),
        lexical_score: Number(row.lexical_score),
        retrieval_sources: ["lexical"],
        availability: acceptedAt ? "accepted_at" : "undated"
      }
    });
    if (candidates.length >= limit) break;
  }
  return candidates;
}
