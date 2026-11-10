import { describe, it, expect } from "vitest";
import { parseFilingHtml, isHiddenStyle } from "../src/lib/web-sources/sec-parser";
import { chunkDocument, countTokens } from "../src/lib/rag/chunk";

describe("SEC Parser and Chunker (Phase 3)", () => {
  it("should strip script, style, and hidden elements", () => {
    const html = `
      <html>
        <head>
          <style>body { color: red; }</style>
          <script>console.log('hello');</script>
        </head>
        <body>
          <div>Visible text</div>
          <div style="display: none;">Hidden display none</div>
          <div style="visibility:hidden;">Hidden visibility hidden</div>
          <noscript>noscript text</noscript>
          <iframe>iframe text</iframe>
        </body>
      </html>
    `;
    const parsed = parseFilingHtml(html);
    expect(parsed.text).toContain("Visible text");
    expect(parsed.text).not.toContain("Hidden display none");
    expect(parsed.text).not.toContain("Hidden visibility hidden");
    expect(parsed.text).not.toContain("noscript text");
    expect(parsed.text).not.toContain("iframe text");
  });

  it("should clean inline-XBRL tags preserving their content", () => {
    const html = `
      <div>
        <ix:nonNumeric name="us-gaap:Revenue">10,000,000</ix:nonNumeric>
      </div>
    `;
    const parsed = parseFilingHtml(html);
    expect(parsed.text).toContain("10,000,000");
    expect(parsed.text).not.toContain("<ix:nonNumeric");
  });

  it("should normalize Item and Part headings", () => {
    const html = `
      <html>
        <body>
          <p>Some general information about the company.</p>
          <div>Item 1. Business</div>
          <p>This is business details.</p>
          <div>Item 1A. Risk Factors</div>
          <p>These are risk factors details.</p>
          <div>Part I. Item 2. Financial Statements</div>
          <p>Financial statements table is here.</p>
        </body>
      </html>
    `;
    const parsed = parseFilingHtml(html, { formType: "10-K" });
    expect(parsed.sections).toHaveLength(4); // GENERAL + 1 + 1A + 2

    expect(parsed.sections[1].itemCode).toBe("1");
    expect(parsed.sections[1].itemTitle).toBe("Business");
    expect(parsed.sections[1].text).toContain("This is business details.");

    expect(parsed.sections[2].itemCode).toBe("1A");
    expect(parsed.sections[2].itemTitle).toBe("Risk Factors");
    expect(parsed.sections[2].text).toContain("These are risk factors details.");

    expect(parsed.sections[3].itemCode).toBe("2");
    expect(parsed.sections[3].itemTitle).toBe("Financial Statements");
    expect(parsed.sections[3].text).toContain("Financial statements table is here.");
  });

  it("should preserve form-specific Item 1 titles (10-Q / unknown form keeps raw title)", () => {
    const html = `
      <html>
        <body>
          <div>Item 1. Financial Statements</div>
          <p>Condensed consolidated balance sheets.</p>
        </body>
      </html>
    `;

    // 10-Q: Item 1 is "Financial Statements" — the 10-K "Business" map must NOT apply.
    const tenQ = parseFilingHtml(html, { formType: "10-Q" });
    const tenQSection = tenQ.sections.find((s) => s.itemCode === "1");
    expect(tenQSection?.itemTitle).toBe("Financial Statements");

    // No form context: raw title preserved as well.
    const unknown = parseFilingHtml(html);
    const unknownSection = unknown.sections.find((s) => s.itemCode === "1");
    expect(unknownSection?.itemTitle).toBe("Financial Statements");

    // Proven 10-K: the canonical mapping applies.
    const tenK = parseFilingHtml(`<html><body><div>Item 1. Business</div><p>Details.</p></body></html>`, {
      formType: "10-K"
    });
    const tenKSection = tenK.sections.find((s) => s.itemCode === "1");
    expect(tenKSection?.itemTitle).toBe("Business");
  });

  it("should recognize standalone SEC section headings without an Item prefix", () => {
    const html = `
      <html>
        <body>
          <p>Cover page text.</p>
          <h2>Risk Factors</h2>
          <p>Standalone risk factor prose.</p>
          <h2>Management's Discussion and Analysis of Financial Condition and Results of Operations</h2>
          <p>MDA prose lives here.</p>
          <h2>Financial Statements</h2>
          <p>Statement prose lives here.</p>
          <p>For more detail, see Risk Factors above and our audited financial statements included elsewhere.</p>
        </body>
      </html>
    `;
    const parsed = parseFilingHtml(html);

    const risk = parsed.sections.find((s) => s.itemCode === "RISK-FACTORS");
    expect(risk?.itemTitle).toBe("Risk Factors");
    expect(risk?.text).toContain("Standalone risk factor prose.");

    const mda = parsed.sections.find((s) => s.itemCode === "MDA");
    expect(mda?.itemTitle).toBe("Management's Discussion and Analysis");
    expect(mda?.text).toContain("MDA prose lives here.");

    const fin = parsed.sections.find((s) => s.itemCode === "FINANCIAL-STATEMENTS");
    expect(fin?.itemTitle).toBe("Financial Statements");
    expect(fin?.text).toContain("Statement prose lives here.");

    // A prose paragraph merely REFERENCING a section name must not start a new
    // section (anchored full-text match) — it stays inside the last section.
    expect(fin?.text).toContain("see Risk Factors above");
    expect(parsed.sections.filter((s) => s.itemCode === "RISK-FACTORS")).toHaveLength(1);
  });

  it("should convert tables to pipe-delimited Markdown", () => {
    const html = `
      <table>
        <tr>
          <th>Header A</th>
          <th>Header B</th>
        </tr>
        <tr>
          <td>Value A1</td>
          <td>Value B1</td>
        </tr>
      </table>
    `;
    const parsed = parseFilingHtml(html);
    expect(parsed.text).toContain("| Header A | Header B |");
    expect(parsed.text).toContain("| --- | --- |");
    expect(parsed.text).toContain("| Value A1 | Value B1 |");
  });

  it("should split large tables exceeding the token limit", () => {
    // Generate a long table. Each row has ~100 characters.
    // 15 rows * 100 characters = 1500 characters / 3.5 = ~428 tokens
    let rowsHtml = "<tr><th>Col 1</th><th>Col 2</th></tr>";
    for (let i = 0; i < 15; i++) {
      rowsHtml += `<tr><td>Row ${i} Val 1 has a lot of text here to increase length</td><td>Row ${i} Val 2 has a lot of text too</td></tr>`;
    }
    const html = `<table>${rowsHtml}</table>`;
    const parsed = parseFilingHtml(html);

    // Should split into at least 2 tables
    const tableBlocks = parsed.text.split("\n\n").filter(b => b.startsWith("|"));
    expect(tableBlocks.length).toBeGreaterThan(1);
    
    // Each split table should contain the header row
    for (const table of tableBlocks) {
      expect(table).toContain("| Col 1 | Col 2 |");
      expect(table).toContain("| --- | --- |");
    }
  });

  it("should emit valid Markdown for td-only tables (synthesized empty header, no promoted data row)", () => {
    // td-only rows (no <th>): each emitted block must still be a valid GFM table.
    let rowsHtml = "";
    for (let i = 0; i < 15; i++) {
      rowsHtml += `<tr><td>Row ${i} Val 1 has a lot of text here to increase length</td><td>Row ${i} Val 2 has a lot of text too</td></tr>`;
    }
    const html = `<table>${rowsHtml}</table>`;
    const parsed = parseFilingHtml(html);

    const tableBlocks = parsed.text.split("\n\n").filter((b) => b.startsWith("|"));
    expect(tableBlocks.length).toBeGreaterThan(1); // still splits on the token cap

    for (const table of tableBlocks) {
      const lines = table.split("\n");
      // Valid GFM: a (neutral, empty-cell) header row precedes the delimiter row —
      // never a bare "| --- |" first line.
      expect(lines[0]).toBe("|  |  |");
      expect(lines[1]).toBe("| --- | --- |");
      expect(lines[0]).not.toContain("Row 0");
    }

    // No data row is promoted to a repeated header: every data row appears exactly once.
    for (let i = 0; i < 15; i++) {
      const occurrences = parsed.text.split(`Row ${i} Val 1`).length - 1;
      expect(occurrences).toBe(1);
    }
  });

  it("should never emit a parent block over the token cap when carrying overlap", () => {
    const maxTokens = 50;
    // partA (~39 tokens) fits a parent; partB (~46 tokens) nearly fills another. The overlap
    // tail (~10 tokens) carried after flushing partA must be dropped when tail+partB would
    // overflow the 50-token parent cap (tail + partB is ~56 tokens without the re-check).
    const sentenceA = "alpha beta gamma delta epsilon zeta eta theta iota kappa.";
    const sentenceB = "lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega.";
    const partA = Array(3).fill(sentenceA).join(" ");
    const partB = Array(3).fill(sentenceB).join(" ");

    const chunks = chunkDocument({
      text: `${partA}\n\n${partB}`,
      sections: [{ itemCode: "1A", itemTitle: "Risk Factors", text: `${partA}\n\n${partB}` }],
      doc_id: "TEST:overlap:10-K",
      ticker: "TEST",
      published_at: "2026-01-01"
    }, {
      maxTokens,
      overlapRatio: 0.2
    });

    expect(chunks.length).toBeGreaterThan(0);
    const parentTexts = [...new Set(chunks.map((c) => c.parent_text))];
    for (const parentText of parentTexts) {
      expect(countTokens(parentText, false)).toBeLessThanOrEqual(maxTokens);
    }
  });

  it("should chunk documents with section awareness and no cross-section overlap", () => {
    const html = `
      <html>
        <body>
          <div>Item 1. Business</div>
          <p>Business prose is very long and has multiple paragraphs. Business prose is very long and has multiple paragraphs.</p>
          <div>Item 1A. Risk Factors</div>
          <p>Risk prose details are here. Risk prose details are here.</p>
        </body>
      </html>
    `;
    const parsed = parseFilingHtml(html);
    const chunks = chunkDocument({
      text: parsed.text,
      sections: parsed.sections,
      doc_id: "AAPL:12345:10-K",
      ticker: "AAPL",
      published_at: "2026-01-01"
    }, {
      maxTokens: 50,
      overlapRatio: 0.1
    });

    expect(chunks.length).toBeGreaterThan(1);

    // Verify sections are correctly set in metadata
    const item1Chunks = chunks.filter(c => c.section === "1. Business");
    const item1AChunks = chunks.filter(c => c.section === "1A. Risk Factors");

    expect(item1Chunks.length).toBeGreaterThan(0);
    expect(item1AChunks.length).toBeGreaterThan(0);

    // Check that Item 1A chunks do not contain text from Item 1 (due to reset pending)
    for (const chunk of item1AChunks) {
      expect(chunk.text).not.toContain("Business prose");
    }
  });

  it("should preserve row-spanned table cells correctly", () => {
    const html = `
      <table>
        <tr>
          <th rowspan="2">Spanned Header</th>
          <th>Col B</th>
        </tr>
        <tr>
          <td>Row 1 B</td>
        </tr>
        <tr>
          <td>Row 2 A</td>
          <td>Row 2 B</td>
        </tr>
      </table>
    `;
    const parsed = parseFilingHtml(html);
    // Grid representation should repeat the spanned cell in Row 1:
    // Row 0: | Spanned Header | Col B |
    // Row 1: | Spanned Header | Row 1 B |
    // Row 2: | Row 2 A        | Row 2 B |
    expect(parsed.text).toContain("| Spanned Header | Col B |");
    expect(parsed.text).toContain("| Spanned Header | Row 1 B |");
    expect(parsed.text).toContain("| Row 2 A | Row 2 B |");
  });

  it("only treats an EXACT zero opacity/font-size as hidden (decimal styles stay visible)", () => {
    // Hidden — genuine zero in its various spellings.
    expect(isHiddenStyle("display:none")).toBe(true);
    expect(isHiddenStyle("visibility: hidden")).toBe(true);
    expect(isHiddenStyle("opacity:0")).toBe(true);
    expect(isHiddenStyle("opacity: 0.0")).toBe(true);
    expect(isHiddenStyle("font-size:0")).toBe(true);
    expect(isHiddenStyle("font-size: 0px")).toBe(true);

    // NOT hidden — these are ordinary visible styling. A `0`-prefix regex matched all of them,
    // and since collectBlocks returns on a hidden node, each false positive dropped the element's
    // entire subtree from parsed evidence.
    expect(isHiddenStyle("opacity:0.5")).toBe(false);
    expect(isHiddenStyle("opacity: 0.875")).toBe(false);
    expect(isHiddenStyle("font-size:0.875rem")).toBe(false);
    expect(isHiddenStyle("font-size: 0.9em")).toBe(false);
  });

  it("keeps content that is merely styled with a decimal opacity/font-size", () => {
    const html = `
      <html><body>
        <div style="opacity:0.5">Half opacity risk disclosure that must survive parsing.</div>
        <div style="font-size:0.875rem">Small-print revenue commentary that must survive parsing.</div>
        <div style="opacity:0">Truly invisible marker text.</div>
      </body></html>`;
    const parsed = parseFilingHtml(html);
    expect(parsed.text).toContain("Half opacity risk disclosure");
    expect(parsed.text).toContain("Small-print revenue commentary");
    expect(parsed.text).not.toContain("Truly invisible marker text");
  });

  it("escapes pipes from a nested table so the outer row keeps its column count", () => {
    // The nested table's own `|` delimiters land inside ONE outer cell; unescaped they split that
    // cell into extra columns and destroy the row's alignment.
    const html = `
      <html><body>
        <table>
          <tr><th>Outer A</th><th>Outer B</th></tr>
          <tr>
            <td>Before <table><tr><td>Inner1</td><td>Inner2</td></tr></table> After</td>
            <td>Plain</td>
          </tr>
        </table>
      </body></html>`;
    const parsed = parseFilingHtml(html);
    const dataRow = parsed.text
      .split("\n")
      .find((line) => line.includes("Before") && line.includes("Plain"));
    expect(dataRow).toBeDefined();
    // Unescaped pipes are what break the row; every pipe from the nested table must be escaped.
    expect(dataRow).not.toMatch(/(?<!\\)\|\s*Inner1/);
    expect(dataRow).toContain("Plain");
  });

  it("preserves an Item heading nested inside an outer table cell as a real section break", () => {
    // EDGAR sometimes encodes an Item heading as a single-cell layout table nested inside a
    // wrapper <table> cell. Before this fix, collectBlocks classified the nested table as a
    // heading ParsedBlock but the enclosing conversion path only folded `b.text` back into the
    // outer cell's prose — the heading never reached the block stream, so the section never
    // changed and everything stayed misattributed to the prior section (here, "1. Business").
    const html = `
      <html><body>
        <div>Item 1. Business</div>
        <p>Business overview text.</p>
        <table>
          <tr>
            <td>
              <table><tr><td>Item 1A. Risk Factors</td></tr></table>
              <p>Our principal risks include market volatility and competition.</p>
            </td>
          </tr>
        </table>
        <div>Item 2. Properties</div>
        <p>Properties details.</p>
      </body></html>`;
    const parsed = parseFilingHtml(html, { formType: "10-K" });

    const business = parsed.sections.find((s) => s.itemCode === "1");
    const riskFactors = parsed.sections.find((s) => s.itemCode === "1A");
    const properties = parsed.sections.find((s) => s.itemCode === "2");

    // The nested heading must produce its own section entry with the standard 10-K title...
    expect(riskFactors).toBeDefined();
    expect(riskFactors?.itemTitle).toBe("Risk Factors");
    // ...and the content that followed the nested heading (inside the same outer cell) must be
    // attributed to THAT section, not stay stuck under "1. Business".
    expect(riskFactors?.text).toContain("Our principal risks include market volatility and competition.");
    expect(business?.text).not.toContain("Our principal risks include market volatility and competition.");
    expect(business?.text).toContain("Business overview text.");
    // Sections after the nested-table heading must still parse normally.
    expect(properties?.text).toContain("Properties details.");
  });

  it("does not leave the nested heading's own marker text duplicated as stray table prose", () => {
    const html = `
      <html><body>
        <table>
          <tr>
            <td>
              <table><tr><td>Item 1A. Risk Factors</td></tr></table>
              <p>Risk factor commentary.</p>
            </td>
          </tr>
        </table>
      </body></html>`;
    const parsed = parseFilingHtml(html, { formType: "10-K" });
    // "Item 1A. Risk Factors" should appear exactly once, as the section header line
    // ("## Item 1A. Risk Factors"), not a second time folded into the table cell body.
    const occurrences = parsed.text.split("Item 1A. Risk Factors").length - 1;
    expect(occurrences).toBe(1);
  });

  it("routes oversize documents past cheerio to the regex full-text fallback", () => {
    // Inline-XBRL monsters (15-50MB) pinned the serving event loop 11-85s inside cheerio
    // (2026-08-10 incident). Over the cap, parseFilingHtml must return the single-pass
    // regex extraction as one FULL section — never build a DOM.
    process.env.SEC_PARSE_CHEERIO_MAX_BYTES = "1000";
    try {
      const body = `<p>Revenue grew 12% year over year.</p>`.repeat(100);
      const html = `<html><body>${body}</body></html>`;
      expect(html.length).toBeGreaterThan(1000);
      const parsed = parseFilingHtml(html, { formType: "10-K" });
      expect(parsed.sections).toHaveLength(1);
      expect(parsed.sections[0]!.itemCode).toBe("FULL");
      expect(parsed.text).toContain("Revenue grew 12% year over year.");
    } finally {
      delete process.env.SEC_PARSE_CHEERIO_MAX_BYTES;
    }
  });
});
