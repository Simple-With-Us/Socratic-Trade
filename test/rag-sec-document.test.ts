import { describe, expect, it } from "vitest";
import {
  buildSecDocument,
  joinSecSectionText,
  looksLikeMarkup,
  normalizeSecSections
} from "../src/lib/rag/sec-document";

const HTML = `<html><head><script>alert(1)</script></head><body>
<h1>Item 1. Business</h1>
<p>AAPL makes iPhones and lots of other consumer electronics that people buy all over the world.</p>
</body></html>`;

describe("buildSecDocument", () => {
  it("joins parsed section text and never embeds raw HTML", () => {
    const doc = buildSecDocument({
      rawContent: HTML,
      sections: [{ itemCode: "1", itemTitle: "Business", text: "AAPL makes iPhones and lots of other consumer electronics." }],
      documentName: "aapl-10k.htm",
      ticker: "AAPL",
      docId: "AAPL:acc:10-K",
      title: "AAPL 10-K",
      docType: "10-K",
      publishedAt: "2026-07-15",
      acceptanceDateTime: "2026-07-15T21:37:12.000Z"
    });
    expect(doc.text).toContain("AAPL makes iPhones");
    expect(doc.text).not.toMatch(/<html|<script|<body/i);
    expect(doc.acceptance_datetime).toBe("2026-07-15T21:37:12.000Z");
    expect(doc.sections?.[0]?.itemTitle).toBe("Business");
  });

  it("re-parses HTML when sections are missing so the fallback is still plain text", () => {
    const doc = buildSecDocument({
      rawContent: HTML,
      sections: [],
      documentName: "aapl-10k.htm",
      ticker: "AAPL",
      docId: "AAPL:acc:10-K",
      title: "AAPL 10-K",
      docType: "10-K",
      publishedAt: "2026-07-15"
    });
    expect(doc.text.length).toBeGreaterThan(20);
    expect(looksLikeMarkup(doc.text)).toBe(false);
    expect(doc.text).not.toMatch(/<script/i);
  });

  it("keeps XML ownership bodies as a single section", () => {
    const xml = "<XML><owner>Jane Doe</owner></XML>";
    const doc = buildSecDocument({
      rawContent: xml,
      sections: [{ itemCode: "0", itemTitle: "XML Document", text: xml }],
      documentName: "form4.xml",
      ticker: "AAPL",
      docId: "acc:1:form4.xml",
      title: "AAPL Form 4",
      docType: "4",
      publishedAt: "2026-07-15"
    });
    expect(doc.text).toContain("Jane Doe");
    expect(doc.sections?.[0]?.itemTitle).toBe("XML Document");
  });

  it("normalizeSecSections drops empty rows", () => {
    expect(normalizeSecSections([{ itemCode: "1", itemTitle: "X", text: "  " }, { text: "kept" }])).toEqual([
      { itemCode: "", itemTitle: "", text: "kept" }
    ]);
    expect(joinSecSectionText([{ itemCode: "1", itemTitle: "A", text: "one" }, { itemCode: "2", itemTitle: "B", text: "two" }])).toBe(
      "one\n\ntwo"
    );
  });
});
