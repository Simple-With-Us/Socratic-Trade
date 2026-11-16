// Thin Red filings pack: only proposed-symbol dossier slices, already budgeted.
// Does not re-send the 24k Green hose per opening.

import { normalizeSymbol } from "../money";

export const REVIEWER_FILINGS_PACK_CHARS = 8_000;
export const REVIEWER_PER_SYMBOL_CHARS = 4_000;

const DOSSIER_HEAD = /^### RAG Dossier for ([A-Za-z0-9.-]+)/i;
const FILING_BLOCK =
  /\bItem\s*1A\b|\bItem\s*7A?\b|\bMD&A\b|Risk Factors|Management.?s Discussion|\b8-K\b|\b10-K\b|\b10-Q\b|accession/i;
const CARD_BLOCK = /^\[(SEC |ARK |13F )/i;

/** Put 1A / MD&A / 8-K chunks ahead of facts/Form 4/13F/ARK cards so the 4k cap cannot hide them. */
export function prioritizeFilingBlocks(section: string, perSymbolMax: number): string {
  const trimmed = section.trim();
  const newline = trimmed.indexOf("\n");
  const header = newline >= 0 ? trimmed.slice(0, newline) : trimmed;
  const rest = newline >= 0 ? trimmed.slice(newline + 1).trim() : "";
  if (!rest) return trimmed.length > perSymbolMax ? trimmed.slice(0, perSymbolMax) : trimmed;
  const blocks = rest.split(/\n\n+/);
  const filing: string[] = [];
  const other: string[] = [];
  for (const block of blocks) {
    const piece = block.trim();
    if (!piece) continue;
    if (CARD_BLOCK.test(piece) && !FILING_BLOCK.test(piece)) other.push(piece);
    else if (FILING_BLOCK.test(piece)) filing.push(piece);
    else other.push(piece);
  }
  const ordered = [header, ...filing, ...other].filter(Boolean).join("\n\n");
  return ordered.length > perSymbolMax ? ordered.slice(0, perSymbolMax) : ordered;
}

export function sliceRagDossierForSymbols(
  ragContext: string,
  symbols: readonly string[],
  opts?: { totalMax?: number; perSymbolMax?: number }
): string {
  const text = String(ragContext ?? "").trim();
  if (!text) return "";
  const wanted = new Set(
    symbols.map((symbol) => normalizeSymbol(symbol)).filter((symbol) => symbol.length > 0)
  );
  if (wanted.size === 0) return "";

  const totalMax = opts?.totalMax ?? REVIEWER_FILINGS_PACK_CHARS;
  const perSymbolMax = opts?.perSymbolMax ?? REVIEWER_PER_SYMBOL_CHARS;
  const sections = text.split(/\n\n---\n\n/);
  const picked: string[] = [];
  let used = 0;

  for (const section of sections) {
    const trimmed = section.trim();
    const match = DOSSIER_HEAD.exec(trimmed);
    if (!match) continue;
    const symbol = normalizeSymbol(match[1] ?? "");
    if (!wanted.has(symbol)) continue;
    let body = prioritizeFilingBlocks(trimmed, perSymbolMax);
    const remaining = totalMax - used;
    if (remaining < 80) break;
    if (body.length > remaining) body = body.slice(0, remaining);
    picked.push(body);
    used += body.length + 8;
    if (used >= totalMax) break;
  }
  return picked.join("\n\n---\n\n");
}
