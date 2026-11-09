// Small complete storeDocument calls for the processed operational index.
// Never truncate a full-body commit — producers pass a capped signal slice.

import type { VectorStoreLeaseGuard } from "../vector-db";
import { chunkDocument, type ChunkInput, type DocumentChunk } from "./chunk";
import {
  groupChunksByItemCode,
  sectionDocumentKey,
  selectSignalChunks
} from "./pinecone-write-class";

export interface ProcessedSignalWriteInput {
  ticker: string;
  accession: string;
  form: string;
  title?: string;
  publishedAt: string;
  acceptanceDatetime?: string;
  source?: string;
  url?: string;
  chunks: readonly DocumentChunk[];
  userId?: string;
  leaseGuard?: VectorStoreLeaseGuard;
}

export interface ProcessedSignalWriteResult {
  attempted: number;
  indexed: number;
  documents: number;
  documentKeys: string[];
  errors: string[];
}

export function buildSignalSectionDocuments(
  input: ProcessedSignalWriteInput
): Array<ChunkInput & { symbol?: string; documentKey: string }> {
  const form = input.form;
  const selected = selectSignalChunks(input.chunks, form);
  if (selected.length === 0) return [];
  const ticker = input.ticker.toUpperCase();
  const source = input.source ?? "sec-edgar";
  const docs: Array<ChunkInput & { symbol?: string; documentKey: string }> = [];
  for (const [itemCode, group] of groupChunksByItemCode(selected)) {
    const documentKey = sectionDocumentKey({
      ticker,
      accession: input.accession,
      form,
      itemCode
    });
    const sections = group.map((chunk) => ({
      itemCode,
      itemTitle: chunk.section || itemCode,
      text: chunk.text
    }));
    const text = group.map((chunk) => chunk.text).join("\n\n");
    docs.push({
      text,
      sections,
      doc_id: documentKey,
      ticker,
      symbol: ticker,
      title: input.title ?? `${ticker} ${form} Item ${itemCode}`,
      doc_type: form.toLowerCase(),
      published_at: input.publishedAt,
      acceptance_datetime: input.acceptanceDatetime ?? input.publishedAt,
      source,
      url: input.url ?? "",
      documentKey
    });
  }
  return docs;
}

export async function storeSignalSectionDocuments(
  input: ProcessedSignalWriteInput,
  storeDocument: (
    doc: ChunkInput & { symbol?: string },
    userId?: string,
    options?: {
      documentKey?: string;
      parserRevision?: string;
      leaseGuard?: VectorStoreLeaseGuard;
    }
  ) => Promise<{ attempted: number; indexed: number; error?: string; documentComplete?: boolean }>
): Promise<ProcessedSignalWriteResult> {
  const docs = buildSignalSectionDocuments(input);
  const result: ProcessedSignalWriteResult = {
    attempted: 0,
    indexed: 0,
    documents: 0,
    documentKeys: [],
    errors: []
  };
  for (const doc of docs) {
    const stored = await storeDocument(doc, input.userId ?? "local", {
      documentKey: doc.documentKey,
      parserRevision: "sec-signal-section-v1",
      ...(input.leaseGuard ? { leaseGuard: input.leaseGuard } : {})
    });
    result.documents += 1;
    result.documentKeys.push(doc.documentKey);
    result.attempted += stored.attempted;
    result.indexed += stored.indexed;
    if (stored.error) result.errors.push(stored.error);
  }
  return result;
}

export function chunkDocumentForLocalComplete(doc: ChunkInput): DocumentChunk[] {
  return chunkDocument(doc, {});
}
