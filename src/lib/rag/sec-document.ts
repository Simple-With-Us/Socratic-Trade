// One SEC filing document builder for incremental EDGAR ingest and SecIngestWorker.
// Both paths must embed parsed plain text, never raw HTML.

import { parseFilingHtml } from "../web-sources/sec-parser";
import type { ChunkInput } from "./chunk";

export type SecFilingSection = {
  itemCode: string;
  itemTitle: string;
  text: string;
};

export type BuildSecDocumentInput = {
  rawContent: string;
  sections?: unknown;
  documentName?: string;
  ticker: string;
  docId: string;
  title: string;
  docType: string;
  source?: string;
  publishedAt: string;
  acceptanceDateTime?: string;
  url?: string;
};

export function normalizeSecSections(raw: unknown): SecFilingSection[] {
  if (!Array.isArray(raw)) return [];
  const out: SecFilingSection[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const text = typeof (row as { text?: unknown }).text === "string" ? (row as { text: string }).text : "";
    if (!text.trim()) continue;
    out.push({
      itemCode: String((row as { itemCode?: unknown }).itemCode ?? ""),
      itemTitle: String((row as { itemTitle?: unknown }).itemTitle ?? ""),
      text
    });
  }
  return out;
}

export function joinSecSectionText(sections: SecFilingSection[]): string {
  return sections
    .map((section) => section.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

/** Cheap markup detector for the first 4k of a filing body. */
export function looksLikeMarkup(text: string): boolean {
  const head = text.slice(0, 4000);
  return /<(?:html|body|script|style|ix:|div|p|span|table)\b/i.test(head) || /<\/[a-zA-Z][\s\S]*?>/.test(head);
}

function stripResidualTags(text: string): string {
  return text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Build the ChunkInput both SEC writers pass to chunkDocument / storeDocument.
 * HTML filings always get parsed/joined section text.  XML ownership docs keep
 * their existing single-section body (not HTML).
 */
export function buildSecDocument(input: BuildSecDocumentInput): ChunkInput {
  const documentName = input.documentName ?? "";
  const isXml = documentName.toLowerCase().endsWith(".xml");
  let sections = normalizeSecSections(input.sections);
  let text = joinSecSectionText(sections);

  if (!isXml && (!text || looksLikeMarkup(text))) {
    const parsed = parseFilingHtml(input.rawContent, { formType: input.docType });
    if (parsed.sections.length > 0) sections = parsed.sections;
    text = parsed.text.trim() || joinSecSectionText(sections);
  }

  if (!text && isXml) {
    text = input.rawContent.trim();
    if (sections.length === 0 && text) {
      sections = [{ itemCode: "0", itemTitle: "XML Document", text }];
    }
  }

  if (text && looksLikeMarkup(text) && !isXml) {
    text = stripResidualTags(text);
  }

  if (!text) {
    throw new Error("SEC document has no extractable plain text");
  }

  return {
    text,
    ...(sections.length > 0 ? { sections } : {}),
    doc_id: input.docId,
    ticker: input.ticker,
    title: input.title,
    doc_type: input.docType,
    source: input.source ?? "sec-edgar",
    published_at: input.publishedAt,
    ...(input.acceptanceDateTime ? { acceptance_datetime: input.acceptanceDateTime } : {}),
    ...(input.url ? { url: input.url } : {})
  };
}
