import { describe, it, expect, beforeEach } from "vitest";
import {
  insertDocumentAbstract,
  getDocumentAbstractsForTicker,
  getDocumentAbstractByAccession,
  DocumentAbstract
} from "../src/lib/db-document-abstracts";
import {
  DOCUMENT_HIGHLIGHT_MODEL,
  generateAndStoreDocumentAbstract,
  splitTextBySecItems,
  tradeHighlightChunksFromText
} from "../src/lib/rag/document-summarizer";
import { hashContent } from "../src/lib/rag/chunk";
import { getDb } from "../src/lib/db";

describe("Document Abstracts & Summarizer", () => {
  beforeEach(() => {
    const db = getDb();
    db.prepare("DELETE FROM document_abstracts").run();
  });

  it("tradeHighlightChunksFromText prefers guidance/revenue paragraphs and caps count", () => {
    const text = [
      "Boilerplate intro about the company history and founders with little market signal content here.",
      "",
      "We raised full-year guidance and now expect revenue growth of 12% with expanded operating margins.",
      "",
      "The cafeteria menu was updated for the summer picnic season and employee wellness programs.",
      "",
      "Management discussed EPS beats, backlog strength, and demand recovery in the core segment."
    ].join("\n");
    const chunks = tradeHighlightChunksFromText(text, { maxChunks: 2 });
    expect(chunks.length).toBe(2);
    expect(chunks[0].text.toLowerCase()).toMatch(/guidance|revenue|eps|backlog|demand/);
    expect(chunks.every((c) => c.id.startsWith("hl:"))).toBe(true);
  });

  it("tradeHighlightChunksFromText returns empty for blank input", () => {
    expect(tradeHighlightChunksFromText("   ")).toEqual([]);
  });

  it("section-aware scoring prefers Item 7 MD&A over low-signal exhibits", () => {
    const chunks = tradeHighlightChunksFromText("ignored flat text", {
      maxChunks: 3,
      formHint: "10-K",
      sections: [
        {
          itemCode: "9A",
          itemTitle: "Controls and Procedures",
          text:
            "Management has evaluated disclosure controls and procedures and concluded they are effective for the reporting period under review."
        },
        {
          itemCode: "7",
          itemTitle: "Management's Discussion and Analysis",
          text:
            "We raised full-year revenue guidance to 12% growth and expanded operating margins by 180 basis points year-over-year."
        },
        {
          itemCode: "1A",
          itemTitle: "Risk Factors",
          text:
            "We face material litigation risk from an ongoing investigation that could result in substantial impairment charges."
        }
      ]
    });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const joined = chunks.map((c) => c.text).join(" ").toLowerCase();
    expect(joined).toMatch(/guidance|revenue|margin/);
    expect(joined).toMatch(/litigation|investigation|impairment|risk/);
    // At least one highlight is tagged with a section label
    expect(chunks.some((c) => c.text.startsWith("["))).toBe(true);
    expect(chunks.every((c) => !c.id.startsWith("hl:"))).toBe(true);
  });

  it("uses sourceChunks content_hash instead of synthetic hl: ids when known", () => {
    const mdna =
      "We raised full-year revenue guidance to 12% growth and expanded operating margins by 180 basis points year-over-year.";
    const hash = hashContent(mdna);
    const chunks = tradeHighlightChunksFromText("ignored", {
      maxChunks: 1,
      formHint: "10-K",
      sections: [
        {
          itemCode: "7",
          itemTitle: "Management's Discussion and Analysis",
          text: mdna
        }
      ],
      sourceChunks: [{ content_hash: hash, text: mdna, itemCode: "7", section: "7. Management's Discussion and Analysis" }]
    });
    expect(chunks[0]?.id).toBe(hash);
  });

  it("splitTextBySecItems finds 8-K item boundaries", () => {
    const body = [
      "Item 2.02 Results of Operations and Financial Condition",
      "",
      "The Company reported revenue of $1.2 billion and EPS of $1.05.",
      "",
      "Item 9.01 Financial Statements and Exhibits",
      "",
      "See Exhibit 99.1 furnished herewith."
    ].join("\n");
    const sections = splitTextBySecItems(body);
    expect(sections.length).toBeGreaterThanOrEqual(2);
    expect(sections[0].itemCode).toBe("2.02");
    const chunks = tradeHighlightChunksFromText(body, {
      maxChunks: 2,
      formHint: "8-K",
      materialItems: ["2.02"]
    });
    expect(chunks[0].text.toLowerCase()).toMatch(/revenue|eps|2\.02/);
  });

  it("materialItems accepts full EDGAR Item strings like event.items", () => {
    const body = [
      "Item 2.02 Results of Operations and Financial Condition",
      "",
      "The Company reported revenue of $1.2 billion and expanded operating margins.",
      "",
      "Item 9.01 Financial Statements and Exhibits",
      "",
      "See Exhibit 99.1 furnished herewith for additional boilerplate."
    ].join("\n");
    const chunks = tradeHighlightChunksFromText(body, {
      maxChunks: 1,
      formHint: "8-K",
      materialItems: ["Item 2.02 Results of Operations and Financial Condition"]
    });
    expect(chunks[0].text.toLowerCase()).toMatch(/revenue|margin|2\.02/);
  });

  it("does not wipe an existing abstract when upgrade summary is too short", async () => {
    const accession = "0000789019-24-000088";
    await generateAndStoreDocumentAbstract({
      ticker: "MSFT",
      accessionOrEventId: accession,
      sourceType: "earnings-summary",
      headline: "MSFT keep-me",
      chunks: [
        { id: "c1", text: "Azure cloud growth accelerated to 31% YoY with strong enterprise demand." },
        { id: "c2", text: "Capital expenditure increased for AI infrastructure worldwide." }
      ]
    });
    getDb()
      .prepare("UPDATE document_abstracts SET model_used = ? WHERE accession_or_event_id = ?")
      .run("document-synthesizer-v1", accession);

    const bad = await generateAndStoreDocumentAbstract({
      ticker: "MSFT",
      accessionOrEventId: accession,
      sourceType: "earnings-summary",
      headline: "MSFT short",
      chunks: [{ id: "c1", text: "too short" }]
    });
    expect(bad.skipped).toBe(true);
    expect(bad.error).toBe("summary_too_short");
    const row = getDocumentAbstractByAccession(accession);
    expect(row?.summaryText).toContain("Azure cloud growth");
    expect(row?.modelUsed).toBe("document-synthesizer-v1");
  });

  it("diversity suppresses near-duplicate paragraphs", () => {
    const text = [
      "We raised full-year guidance and expect revenue growth of 12% with expanded operating margins this year.",
      "",
      "We raised full-year guidance and expect revenue growth of 12% with expanded operating margins this fiscal year.",
      "",
      "A separate catalyst: the company announced a $2 billion share repurchase and higher dividend."
    ].join("\n");
    const chunks = tradeHighlightChunksFromText(text, {
      maxChunks: 2,
      diversityJaccard: 0.5
    });
    expect(chunks.length).toBe(2);
    const joined = chunks.map((c) => c.text.toLowerCase()).join(" || ");
    expect(joined).toMatch(/repurchase|dividend|buyback|guidance/);
  });

  it("inserts and retrieves document abstracts by ticker and accession", () => {
    const item: DocumentAbstract = {
      id: "abstract:10k-delta:AAPL:0000320193-24-000106",
      sourceType: "10k-delta",
      ticker: "AAPL",
      accessionOrEventId: "0000320193-24-000106",
      headline: "Apple Inc 10-K Delta Summary",
      summaryText: "Revenue grew 5% YoY driven by iPhone sales and Services expansion.",
      sourceChunkIds: ["chunk-1", "chunk-2"],
      createdAt: new Date().toISOString(),
      modelUsed: "test-model"
    };

    insertDocumentAbstract(item);

    const forTicker = getDocumentAbstractsForTicker("AAPL");
    expect(forTicker.length).toBe(1);
    expect(forTicker[0].headline).toBe("Apple Inc 10-K Delta Summary");
    expect(forTicker[0].sourceChunkIds).toEqual(["chunk-1", "chunk-2"]);

    const byAccession = getDocumentAbstractByAccession("0000320193-24-000106");
    expect(byAccession).toBeDefined();
    expect(byAccession?.ticker).toBe("AAPL");
  });

  it("generates and stores abstracts through the summarizer engine and skips duplicates", async () => {
    const result1 = await generateAndStoreDocumentAbstract({
      ticker: "MSFT",
      accessionOrEventId: "0000789019-24-000020",
      sourceType: "earnings-summary",
      headline: "MSFT Q4 Earnings Call Summary",
      chunks: [
        { id: "c1", text: "Azure cloud growth accelerated to 31% YoY." },
        { id: "c2", text: "Capital expenditure increased for AI infrastructure." }
      ]
    });

    expect(result1.skipped).toBe(false);
    expect(result1.abstractId).toBe("abstract:earnings-summary:MSFT:0000789019-24-000020");

    const fetched = getDocumentAbstractByAccession("0000789019-24-000020");
    expect(fetched).toBeDefined();
    expect(fetched?.summaryText).toContain("Azure cloud growth accelerated");
    expect(fetched?.modelUsed).toBe(DOCUMENT_HIGHLIGHT_MODEL);

    // Second call for same accession & sourceType should skip
    const result2 = await generateAndStoreDocumentAbstract({
      ticker: "MSFT",
      accessionOrEventId: "0000789019-24-000020",
      sourceType: "earnings-summary",
      headline: "MSFT Q4 Earnings Call Summary",
      chunks: [{ id: "c1", text: "Azure cloud growth accelerated." }]
    });

    expect(result2.skipped).toBe(true);
  });

  it("refreshes abstracts stamped with an older model_used", async () => {
    const accession = "0000789019-24-000099";
    await generateAndStoreDocumentAbstract({
      ticker: "MSFT",
      accessionOrEventId: accession,
      sourceType: "earnings-summary",
      headline: "MSFT old",
      chunks: [
        { id: "c1", text: "Azure cloud growth accelerated to 31% YoY with strong demand." },
        { id: "c2", text: "Capital expenditure increased for AI infrastructure buildout." }
      ]
    });
    // Downgrade stamp to simulate v1 row still in the DB
    getDb()
      .prepare(
        "UPDATE document_abstracts SET model_used = ? WHERE accession_or_event_id = ?"
      )
      .run("document-synthesizer-v1", accession);

    const refreshed = await generateAndStoreDocumentAbstract({
      ticker: "MSFT",
      accessionOrEventId: accession,
      sourceType: "earnings-summary",
      headline: "MSFT new",
      chunks: [
        { id: "c1", text: "Azure cloud growth accelerated to 35% YoY with expanded operating margins." },
        { id: "c2", text: "Management raised full-year guidance citing backlog strength." }
      ]
    });
    expect(refreshed.skipped).toBe(false);
    expect(refreshed.refreshed).toBe(true);
    const row = getDocumentAbstractByAccession(accession);
    expect(row?.modelUsed).toBe(DOCUMENT_HIGHLIGHT_MODEL);
    expect(row?.summaryText).toMatch(/35%|guidance|backlog/i);
  });

  it("model-stamp refresh does not wipe a later filing FTS row that reused a summarizer rowid", async () => {
    const { insertDocumentChunkFts } = await import("../src/lib/db-learning");
    const accession = "0000789019-24-000088";
    const abstractId = `abstract:earnings-summary:MSFT:${accession}`;
    await generateAndStoreDocumentAbstract({
      ticker: "MSFT",
      accessionOrEventId: accession,
      sourceType: "earnings-summary",
      headline: "MSFT stamp",
      chunks: [
        { id: "c1", text: "Azure cloud growth accelerated to 31% YoY with strong demand." },
        { id: "c2", text: "Capital expenditure increased for AI infrastructure buildout." }
      ]
    });
    getDb()
      .prepare(
        "UPDATE document_abstracts SET model_used = ? WHERE accession_or_event_id = ?"
      )
      .run("document-synthesizer-v1", accession);

    insertDocumentChunkFts(
      "victim-filing-hash",
      "AAPL",
      "sec-edgar",
      "0000320193-26-000088",
      "Item 1A Risk Factors written after the abstract FTS rows."
    );

    await generateAndStoreDocumentAbstract({
      ticker: "MSFT",
      accessionOrEventId: accession,
      sourceType: "earnings-summary",
      headline: "MSFT stamp",
      chunks: [
        { id: "c1", text: "Azure cloud growth accelerated to 31% YoY with strong demand." },
        { id: "c2", text: "Capital expenditure increased for AI infrastructure buildout." }
      ]
    });

    const victim = getDb()
      .prepare("SELECT text FROM document_chunks_fts WHERE content_hash = ?")
      .get("victim-filing-hash") as { text: string } | undefined;
    expect(victim?.text).toMatch(/Risk Factors/);
    const orphanIndex = getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM document_chunks_fts_index
         WHERE source = 'document-summarizer' AND accession = ?
           AND content_hash NOT IN (
             SELECT content_hash FROM document_chunks_fts
             WHERE source = 'document-summarizer' AND accession = ?
           )`
      )
      .get(abstractId, abstractId) as { n: number };
    expect(orphanIndex.n).toBe(0);
  });
});
