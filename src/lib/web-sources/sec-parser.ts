import * as cheerio from "cheerio";
import { timeSync } from "../slow-sync-guard";
// Circular with sec-filings.ts (it imports parseFilingHtml from here) — safe: both modules use
// each other's exports only inside function bodies, never at module-init time.
import { extractFilingText } from "./sec-filings";

export interface ParsedBlock {
  type: "heading" | "paragraph" | "table";
  text: string;
  itemCode?: string;
  itemTitle?: string;
}

export interface ParsedFiling {
  text: string;
  sections: Array<{
    itemCode: string;
    itemTitle: string;
    text: string;
  }>;
}

const BLOCK_TAGS = new Set([
  "p",
  "div",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "blockquote",
  "pre",
  "section",
  "article",
  "header",
  "footer",
  "main"
]);

/** Inline/formatting wrappers that EDGAR sometimes uses for headings. */
const HEADING_WRAPPER_TAGS = new Set([
  "center", "font", "span", "b", "strong", "i", "em", "u", "a"
]);

/**
 * Estimates token counts using a calibrated character-level ratio.
 * For English prose, ~4.5 characters per token.
 */
export function estimateProseTokens(text: string): number {
  return Math.ceil(text.length / 4.5);
}

/**
 * Estimates token counts for Markdown tables, ~3.5 characters per token
 * (due to pipe formatting and whitespace padding).
 */
export function estimateTableTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

function hasBlockChildren($: any, node: any): boolean {
  if (!node.children) return false;
  for (const child of node.children) {
    if (child.type === "tag") {
      const childName = child.name.toLowerCase();
      if (BLOCK_TAGS.has(childName) || childName === "table") {
        return true;
      }
      if (hasBlockChildren($, child)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Bounded set of well-known SEC section headings that appear WITHOUT an
 * "Item N" prefix (e.g. `<h2>Risk Factors</h2>`). Patterns are anchored to the
 * FULL trimmed block text \u2014 a prose cross-reference like "See Risk Factors"
 * never matches \u2014 and the same structural guards as Item/Part headings apply
 * (heading tag, leaf block, or EDGAR heading wrapper; see collectBlocks).
 * Codes are deliberately form-agnostic slugs, NOT numeric Item codes: the same
 * title maps to different Item numbers on 10-K vs 10-Q, and guessing would
 * mislabel sections (see the form-aware standardizeTitle note below).
 */
const STANDALONE_SECTION_HEADINGS: Array<{ pattern: RegExp; code: string; title: string }> = [
  { pattern: /^risk\s+factors$/i, code: "RISK-FACTORS", title: "Risk Factors" },
  {
    pattern: /^management['\u2019]s\s+discussion(\s+and\s+analysis(\s+of\s+financial\s+condition\s+and\s+results\s+of\s+operations)?)?$/i,
    code: "MDA",
    title: "Management's Discussion and Analysis"
  },
  {
    pattern: /^(unaudited\s+)?(condensed\s+)?(consolidated\s+)?financial\s+statements(\s+and\s+supplementary\s+data)?$/i,
    code: "FINANCIAL-STATEMENTS",
    title: "Financial Statements"
  },
  { pattern: /^legal\s+proceedings$/i, code: "LEGAL-PROCEEDINGS", title: "Legal Proceedings" },
  {
    pattern: /^quantitative\s+and\s+qualitative\s+disclosures\s+about\s+market\s+risk$/i,
    code: "MARKET-RISK",
    title: "Quantitative and Qualitative Disclosures About Market Risk"
  },
  { pattern: /^controls\s+and\s+procedures$/i, code: "CONTROLS-AND-PROCEDURES", title: "Controls and Procedures" }
];

function matchStandaloneHeading(clean: string): { code: string; title: string } | null {
  for (const entry of STANDALONE_SECTION_HEADINGS) {
    if (entry.pattern.test(clean)) return { code: entry.code, title: entry.title };
  }
  return null;
}

function isHeadingBlock(text: string): boolean {
  const clean = text.trim();
  if (clean.length === 0 || clean.length > 150) return false;
  return (
    /^\s*item\s+(\d+[a-z]?)\b/i.test(clean) ||
    /^\s*part\s+(\d+|[ivx]+)\b/i.test(clean) ||
    matchStandaloneHeading(clean) !== null
  );
}

/** Form types whose canonical Item-code \u2192 title mapping below is valid (10-K family). */
function isTenKForm(formType: string | undefined): boolean {
  return typeof formType === "string" && /^10-K/i.test(formType.trim());
}

/**
 * Canonical Item titles are FORM-SPECIFIC: "Item 1" is "Business" on a 10-K but
 * "Financial Statements" on a 10-Q. The mapping below is the 10-K mapping, so it
 * is applied ONLY when the caller explicitly passed a form type proving it valid;
 * otherwise the raw title parsed from the filing text is preserved as-is.
 */
function standardizeTitle(code: string, rawTitle: string, formType?: string): string {
  if (!isTenKForm(formType)) {
    return rawTitle || `Item ${code}`;
  }
  let title = rawTitle;
  if (code === "1") title = "Business";
  else if (code === "1A") title = "Risk Factors";
  else if (code === "3") title = "Legal Proceedings";
  else if (code === "7") title = "Management's Discussion and Analysis";
  else if (code === "7A") title = "Quantitative and Qualitative Disclosures About Market Risk";
  else if (code === "8") title = "Financial Statements and Supplementary Data";
  else if (code === "9A") title = "Controls and Procedures";
  return title || rawTitle || `Item ${code}`;
}

function normalizeItemCode(text: string, formType?: string): { code: string; title: string } | null {
  const clean = text.trim();

  // Try matching "Item <number><letter>" first (most specific)
  const itemMatch = clean.match(/item\s+(\d+[a-z]?)\b/i);
  if (itemMatch) {
    const code = itemMatch[1].toUpperCase();
    const titleMatch = clean.match(/item\s+\d+[a-z]?[.\s-:\u2013\u2014]*(.*)/i);
    const rawTitle = titleMatch ? titleMatch[1].trim() : "";
    return { code, title: standardizeTitle(code, rawTitle, formType) };
  }

  // Try matching "Part <number/roman>"
  const partMatch = clean.match(/part\s+(\d+|[ivx]+)\b/i);
  if (partMatch) {
    const code = partMatch[1].toUpperCase();
    const titleMatch = clean.match(/part\s+(?:\d+|[ivx]+)[.\s-:\u2013\u2014]*(.*)/i);
    const rawTitle = titleMatch ? titleMatch[1].trim() : "";
    return { code: `PART-${code}`, title: rawTitle || `Part ${code}` };
  }

  // Well-known standalone section headings without an "Item"/"Part" prefix
  // (full-text anchored match \u2014 see STANDALONE_SECTION_HEADINGS).
  return matchStandaloneHeading(clean);
}

function splitTableRows(rows: string[][], firstRowHasHeaders: boolean = false): string[] {
  // Prevent runaway amplification on degenerate table layouts
  rows = rows.slice(0, 5000).map(r => r.slice(0, 500));
  if (rows.length <= 1) {
    return [rows.map((row) => `| ${row.join(" | ")} |`).join("\n")];
  }

  if (!firstRowHasHeaders) {
    // No real header row — keep every row as DATA (never promote the first data
    // row to a repeated header; that duplicates values across splits). GFM still
    // requires a header row before the delimiter, so synthesize a neutral
    // empty-cell header of the right width to keep each split a valid table.
    const colCount = rows[0].length;
    const emptyHeader = Array(colCount).fill("");
    const divider = Array(colCount).fill("---");
    const tables: string[] = [];
    let currentGroup: string[][] = [emptyHeader, divider];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const proposedGroup = [...currentGroup, row];
      const markdown = proposedGroup.map((r) => `| ${r.join(" | ")} |`).join("\n");

      if (estimateTableTokens(markdown) > 400 && currentGroup.length > 2) {
        tables.push(currentGroup.map((r) => `| ${r.join(" | ")} |`).join("\n"));
        currentGroup = [emptyHeader, divider, row];
      } else {
        currentGroup.push(row);
      }
    }

    if (currentGroup.length > 2) {
      tables.push(currentGroup.map((r) => `| ${r.join(" | ")} |`).join("\n"));
    }
    return tables;
  }

  // First row is a real header — repeat it across each split
  const headerRow = rows[0];
  const colCount = headerRow.length;
  const divider = Array(colCount).fill("---");

  const tables: string[] = [];
  let currentGroup: string[][] = [headerRow, divider];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    // Check if adding this row exceeds the 400-token limit
    const proposedGroup = [...currentGroup, row];
    const markdown = proposedGroup.map((r) => `| ${r.join(" | ")} |`).join("\n");

    if (estimateTableTokens(markdown) > 400 && currentGroup.length > 2) {
      tables.push(currentGroup.map((r) => `| ${r.join(" | ")} |`).join("\n"));
      currentGroup = [headerRow, divider, row];
    } else {
      currentGroup.push(row);
    }
  }

  if (currentGroup.length > 2) {
    tables.push(currentGroup.map((r) => `| ${r.join(" | ")} |`).join("\n"));
  }
  return tables;
}

/**
 * True only for styles that genuinely hide an element.
 *
 * `opacity` and `font-size` MUST be compared as parsed numbers, not matched as a `0` prefix: a
 * regex like `/opacity\s*:\s*0/` also matches the very common `opacity:0.5` and
 * `font-size:0.875rem`. Because `collectBlocks` returns immediately on a hidden node, a false
 * positive silently drops that element's ENTIRE subtree — and filings routinely wrap real prose and
 * tables in inline-styled elements, so whole sections could vanish from parsed evidence with no
 * error anywhere. Only an exact zero (`0`, `0.0`, `.0`, `0px`, …) means hidden.
 */
export function isHiddenStyle(style: string): boolean {
  if (/display\s*:\s*none/i.test(style)) return true;
  if (/visibility\s*:\s*hidden/i.test(style)) return true;
  // Capture the numeric value (with optional unit) and test it as a number.
  const zeroValued = (property: string): boolean => {
    const match = new RegExp(`${property}\\s*:\\s*(-?[0-9]*\\.?[0-9]+)\\s*[a-z%]*`, "i").exec(style);
    if (!match) return false;
    const value = Number.parseFloat(match[1]!);
    return Number.isFinite(value) && value === 0;
  };
  return zeroValued("opacity") || zeroValued("font-size");
}

function collectBlocks($: any, node: any, blocks: ParsedBlock[], formType?: string) {
  if (node.type !== "tag") return;

  const name = node.name.toLowerCase();
  if (name === "script" || name === "style" || name === "noscript" || name === "iframe" || name === "head") {
    return;
  }

  // Remove display: none or visibility: hidden elements
  const style = $(node).attr("style");
  if (style) {
    if (isHiddenStyle(style)) return;
  }

  // If table, convert and do not recurse into rows/cells
  if (name === "table") {
    // Check for heading text in small layout tables (EDGAR sometimes encodes Item
    // headings as single-cell layout tables). If detected, treat as heading.
    const cellText = $(node).text().trim();
    if (isHeadingBlock(cellText) && $(node).find("tr").length <= 1 && $(node).find("td, th").length <= 2) {
      const norm = normalizeItemCode(cellText, formType);
      if (norm) {
        blocks.push({ type: "heading", text: cellText, itemCode: norm.code, itemTitle: norm.title });
        return;
      }
    }
    const grid: string[][] = [];
    let r = 0;
    let firstRowHasHeaders = false;
    let isFirstRow = true;

    $(node).find("tr").each((_: any, tr: any) => {
      // Skip rows belonging to nested tables (they will be processed when
      // collectBlocks recurses into the nested table directly)
      if ($(tr).closest("table").get(0) !== node) return;
      if (!grid[r]) grid[r] = [];

      let c = 0;
      let hasThCells = false;
      $(tr).children("td, th").each((_: any, cell: any) => {
        // Find next empty column slot in grid row r
        while (grid[r][c] !== undefined) {
          c++;
        }

        // Process nested tables in this cell FIRST, converting them to markdown
        // directly in the cell to preserve reading order and nested structure
        $(cell).find("table").each((__: any, nestedTable: any) => {
          const nestedBlocks: ParsedBlock[] = [];
          collectBlocks($, nestedTable, nestedBlocks, formType);

          // A nested table can itself resolve to a heading block (e.g. EDGAR encodes
          // "Item 1A. Risk Factors" as a single-cell layout table inside an outer wrapper
          // cell — the `name === "table"` branch above returns exactly that as a heading
          // ParsedBlock). Folding it into inline cell prose along with everything else would
          // silently destroy the section break: parseFilingHtml only starts a new section on a
          // block with `type === "heading" && itemCode`, so every block that follows would stay
          // misattributed to the previous section (often GENERAL). Emit heading sub-blocks as
          // real section-break blocks in the enclosing stream instead, and fold only the
          // remaining (non-heading) nested content into the cell's own text.
          const proseBlocks: ParsedBlock[] = [];
          for (const nested of nestedBlocks) {
            if (nested.type === "heading" && nested.itemCode) {
              blocks.push(nested);
            } else {
              proseBlocks.push(nested);
            }
          }
          const md = proseBlocks.map((b: ParsedBlock) => b.text).join("\n\n");
          // The nested table's Markdown carries its own `|` delimiters, and this text is about to
          // become ONE cell of the outer table — whose renderer wraps it in `|` again without
          // escaping. Unescaped, a single outer cell silently splits into extra columns and the
          // row's alignment (and therefore every value's column meaning) is destroyed. GFM escapes
          // a literal pipe inside a cell as `\|`.
          $(nestedTable).replaceWith(md ? `\n\n${md.replace(/\|/g, "\\|")}\n\n` : "");
        });
        // Replace <br> with space so concatenated text nodes stay separated
        $(cell).find("br").replaceWith(" ");

        const colspan = Math.max(1, Math.min(parseInt($(cell).attr("colspan") || "1", 10) || 1, 50));
        const rowspan = Math.max(1, Math.min(parseInt($(cell).attr("rowspan") || "1", 10) || 1, 50));
        const cellText = $(cell).text().replace(/\s+/g, " ").trim();

        for (let rs = 0; rs < rowspan; rs++) {
          const targetRow = r + rs;
          if (!grid[targetRow]) grid[targetRow] = [];
          for (let cs = 0; cs < colspan; cs++) {
            grid[targetRow][c + cs] = cellText;
          }
        }

        const nodeName = cell.name?.toLowerCase() || cell.tagName?.toLowerCase() || "";
        if (nodeName === "th") {
          hasThCells = true;
        }
        c += colspan;
      });

      if (grid[r] && grid[r].some((val) => val !== undefined && val !== "")) {
        if (isFirstRow) {
          firstRowHasHeaders = hasThCells;
          isFirstRow = false;
        }
      }
      r++;
    });

    const tableRows: string[][] = [];
    const maxCols = grid.length > 0 ? Math.max(...grid.map((row) => (row ? row.length : 0))) : 0;
    for (let i = 0; i < grid.length; i++) {
      const row = grid[i] || [];
      const normalizedRow: string[] = [];
      for (let j = 0; j < maxCols; j++) {
        normalizedRow.push(row[j] ?? "");
      }
      if (normalizedRow.some((val) => val !== "")) {
        tableRows.push(normalizedRow);
      }
    }

    if (tableRows.length > 0) {
      const splitTables = splitTableRows(tableRows, firstRowHasHeaders);
      for (const tableMd of splitTables) {
        blocks.push({ type: "table", text: tableMd });
      }
    }
    return;
  }

  const text = $(node).text().trim();

  // If it's a heading tag, or matches heading pattern on a leaf block (no children),
  // or an EDGAR heading wrapper (center/font/span/bold) with heading text
  if (isHeadingBlock(text) && (name.match(/^h[1-6]$/) || (BLOCK_TAGS.has(name) && !hasBlockChildren($, node)) || (HEADING_WRAPPER_TAGS.has(name) && !hasBlockChildren($, node)))) {
    const norm = normalizeItemCode(text, formType);
    if (norm) {
      blocks.push({
        type: "heading",
        text,
        itemCode: norm.code,
        itemTitle: norm.title
      });
      return;
    }
  }

  // If it's a block container with no block children, extract text and do not recurse
  if (BLOCK_TAGS.has(name) && !hasBlockChildren($, node)) {
    // Replace <br> with space so leaf block text doesn't concatenate across line breaks
    $(node).find("br").replaceWith(" ");
    const cleanText = $(node).text().replace(/\s+/g, " ").trim();
    if (cleanText) {
      blocks.push({ type: "paragraph", text: cleanText });
    }
    return;
  }

  // Recurse into children; emit text node siblings so mixed-content containers
  // (e.g. <div>Note:<table>...</table>See below.</div>) don't lose prose.
  if (node.children) {
    for (const child of node.children) {
      if (child.type === "text") {
        const text = (child.data || "").replace(/\s+/g, " ").trim();
        if (text) {
          blocks.push({ type: "paragraph", text });
        }
      } else {
        collectBlocks($, child, blocks, formType);
      }
    }
  }
}

/**
 * Parses raw SEC filing HTML using cheerio, removing styles/scripts,
 * extracting sections based on Item headings, and converting tables to Markdown.
 *
 * `options.formType` (e.g. "10-K", "10-Q") controls form-aware Item-title
 * canonicalization: the 10-K Item-code → title map is applied ONLY when the
 * caller proves the filing is a 10-K; otherwise raw parsed titles are kept
 * (Item 1 is "Financial Statements" on a 10-Q, not "Business").
 */
/**
 * Cheerio builds a full DOM then walks every node — on inline-XBRL monsters (15-50MB HTML,
 * millions of tags) that pins the serving event loop for tens of seconds (the 2026-08-10
 * socratictrade.com Uptime Robot incidents: 11-85s freezes traced to the ingest worker's parse
 * checkpoint). Documents over this cap take the proven single-pass regex extractor instead
 * (same text path the refresh lane ships to RAG today) as one FULL section — linear, no DOM.
 */
function cheerioMaxBytes(): number {
  const configured = Number(process.env.SEC_PARSE_CHEERIO_MAX_BYTES ?? 5_000_000);
  return Number.isFinite(configured) && configured > 0 ? configured : 5_000_000;
}

export function parseFilingHtml(html: string, options?: { formType?: string }): ParsedFiling {
  return timeSync("parseFilingHtml", `${Math.round(html.length / 1024)}KB html`, () => {
    if (html.length > cheerioMaxBytes()) {
      console.warn(
        `[sec-parser] ${Math.round(html.length / 1024)}KB html exceeds cheerio cap; using regex full-text fallback`
      );
      const text = extractFilingText(html);
      return { text, sections: [{ itemCode: "FULL", itemTitle: "Full filing text", text }] };
    }
    return parseFilingHtmlImpl(html, options);
  });
}

function parseFilingHtmlImpl(html: string, options?: { formType?: string }): ParsedFiling {
  const formType = options?.formType;
  const $ = cheerio.load(html);

  // Clean inline-XBRL tags: remove ix:hidden/ix:header entirely (their content is
  // non-rendered metadata or duplicate facts), unwrap the rest keeping their content.
  $("*").each((_, el) => {
    if (el.type === "tag" && el.name && el.name.toLowerCase().startsWith("ix:")) {
      const ixName = el.name.toLowerCase();
      if (ixName === "ix:hidden" || ixName === "ix:header") {
        $(el).remove();
      } else {
        $(el).replaceWith($(el).contents());
      }
    }
  });

  // Strip scripts/styles/noscript/iframe
  $("script, style, noscript, iframe, head").remove();

  const blocks: ParsedBlock[] = [];
  const body = $("body").get(0);
  if (body) {
    collectBlocks($, body, blocks, formType);
  } else {
    // Fallback: collect blocks from root if body doesn't exist
    const root = $.root().get(0);
    if (root) collectBlocks($, root, blocks, formType);
  }

  // Group blocks by section
  const sections: Array<{ itemCode: string; itemTitle: string; text: string }> = [];
  let currentItemCode = "GENERAL";
  let currentItemTitle = "General Section";
  let currentSectionText: string[] = [];

  for (const block of blocks) {
    if (block.type === "heading" && block.itemCode) {
      // Flush current section
      const joined = currentSectionText.join("\n\n").trim();
      if (joined) {
        sections.push({
          itemCode: currentItemCode,
          itemTitle: currentItemTitle,
          text: joined
        });
      }
      currentItemCode = block.itemCode;
      currentItemTitle = block.itemTitle || `Item ${block.itemCode}`;
      currentSectionText = [];
    } else {
      currentSectionText.push(block.text);
    }
  }

  // Flush last section
  const joined = currentSectionText.join("\n\n").trim();
  if (joined) {
    sections.push({
      itemCode: currentItemCode,
      itemTitle: currentItemTitle,
      text: joined
    });
  }

  // Construct full clean plain text
  const fullText = sections.map((s) => `## Item ${s.itemCode}. ${s.itemTitle}\n\n${s.text}`).join("\n\n");

  return {
    text: fullText,
    sections
  };
}
