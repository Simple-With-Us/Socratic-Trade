// Structure-aware document chunking for the zero-dep KB. Tables are kept atomic,
// headings set section metadata, and the embedding input is contextualized with a
// short, deterministic header.

import { randomUUID } from 'node:crypto';
import { canonicalTicker, nowIso } from '../../../../packages/shared/types.mjs';
import { tokenizeForEmbedding } from './embeddings.mjs';

const DEFAULT_MAX_TOKENS = 480;
const DEFAULT_OVERLAP_RATIO = 0.12;

function normalizeTickerList(ticker) {
  const raw = Array.isArray(ticker) ? ticker : String(ticker ?? '').split(',');
  return raw.map((t) => canonicalTicker(t)).filter(Boolean);
}

function normalizeDate(value, fallback) {
  if (!value) return fallback;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? fallback : d.toISOString();
}

function countTokens(text) {
  return tokenizeForEmbedding(text).length;
}

function tailOverlap(text, count) {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  return words.slice(Math.max(0, words.length - count)).join(' ');
}

function splitLongProse(text, maxTokens, overlapTokens) {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  const step = Math.max(1, maxTokens - overlapTokens);
  const segments = [];
  for (let i = 0; i < words.length; i += step) {
    segments.push(words.slice(i, i + maxTokens).join(' '));
    if (i + maxTokens >= words.length) break;
  }
  return segments;
}

function isHeading(line) {
  return /^(#{1,6}\s+.+|item\s+\d+[a-z]?[.\s-].+|risk factors|management'?s discussion|financial statements)$/i.test(line.trim());
}

function headingText(line) {
  return line.replace(/^#{1,6}\s+/, '').trim();
}

function isTableLine(line) {
  return /^\s*\|.+\|\s*$/.test(line);
}

function blockDocument(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let paragraph = [];

  const flushParagraph = () => {
    const text = paragraph.join(' ').trim();
    if (text) blocks.push({ type: 'paragraph', text });
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isTableLine(line)) {
      flushParagraph();
      const table = [];
      while (i < lines.length && isTableLine(lines[i])) table.push(lines[i++]);
      i--;
      blocks.push({ type: 'table', text: table.join('\n') });
      continue;
    }
    if (!line.trim()) { flushParagraph(); continue; }
    if (isHeading(line)) {
      flushParagraph();
      blocks.push({ type: 'heading', text: headingText(line) });
      continue;
    }
    paragraph.push(line.trim());
  }
  flushParagraph();
  return blocks;
}

function makeHeader({ ticker, doc_type, section, source, acceptance_datetime, title }) {
  const entity = ticker.length ? ticker.join(',') : title;
  return [
    `Document: ${entity}${doc_type ? ` ${doc_type}` : ''}.`,
    `Section: ${section || 'General'}.`,
    source ? `Source: ${source}.` : '',
    acceptance_datetime ? `Accepted: ${acceptance_datetime}.` : '',
  ].filter(Boolean).join(' ');
}

export function chunkDocument(doc, { maxTokens = DEFAULT_MAX_TOKENS, overlapRatio = DEFAULT_OVERLAP_RATIO } = {}) {
  if (!doc?.text || typeof doc.text !== 'string') throw new Error('doc.text required');
  const doc_id = doc.doc_id || randomUUID();
  const title = doc.title || doc_id;
  const ticker = normalizeTickerList(doc.ticker);
  const published_at = normalizeDate(doc.published_at, nowIso());
  const acceptance_datetime = normalizeDate(doc.acceptance_datetime, published_at);
  const doc_type = doc.doc_type || 'note';
  const source = doc.source || 'user';
  const url = doc.url || '';
  const overlapTokens = Math.max(0, Math.floor(maxTokens * overlapRatio));

  let section = title;
  let pending = [];
  const chunks = [];

  const pushText = (text, { isTable = false } = {}) => {
    const clean = String(text).trim();
    if (!clean) return;
    const n = chunks.length + 1;
    const context_header = makeHeader({ ticker, doc_type, section, source, acceptance_datetime, title });
    chunks.push({
      doc_id,
      chunk_id: `${doc_id}#c${String(n).padStart(3, '0')}`,
      title,
      text: clean,
      context_header,
      ticker,
      doc_type,
      section,
      published_at,
      acceptance_datetime,
      source,
      url,
      is_table: isTable,
    });
  };

  const flush = ({ carryOverlap = true } = {}) => {
    const text = pending.join('\n\n').trim();
    if (!text) { pending = []; return; }
    pushText(text);
    pending = carryOverlap && overlapTokens ? [tailOverlap(text, overlapTokens)] : [];
  };

  for (const block of blockDocument(doc.text)) {
    if (block.type === 'heading') {
      flush({ carryOverlap: false });
      section = block.text;
      continue;
    }
    if (block.type === 'table') {
      flush({ carryOverlap: false });
      pushText(block.text, { isTable: true });
      pending = [];
      continue;
    }
    if (countTokens(block.text) > maxTokens) {
      flush();
      for (const segment of splitLongProse(block.text, maxTokens, overlapTokens)) pushText(segment);
      pending = [];
      continue;
    }

    const proposed = [...pending, block.text].join('\n\n');
    if (pending.length && countTokens(proposed) > maxTokens) flush();
    pending.push(block.text);
  }
  flush({ carryOverlap: false });

  return chunks;
}
