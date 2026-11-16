import { describe, expect, it } from "vitest";
import {
  applyOperationalIndexPrune,
  classifyOperationalVector,
  looksLikeRawHtml,
  planOperationalIndexPrune,
  PRUNE_CONFIRM_TOKEN,
  type OperationalVectorRow
} from "../src/lib/rag/operational-index-prune";

function row(partial: Partial<OperationalVectorRow> & { id: string }): OperationalVectorRow {
  return {
    id: partial.id,
    text: partial.text,
    metadata: partial.metadata ?? {}
  };
}

describe("looksLikeRawHtml", () => {
  it("detects raw HTML and XBRL, not parsed MD&A", () => {
    expect(looksLikeRawHtml("<!DOCTYPE html><html><body><div>x</div></body></html>")).toBe(true);
    const xbrl = `${" <ix:nonNumeric name=\"dei:Entity\">x</ix:nonNumeric>".repeat(12)} xmlns:ix="http://www.xbrl.org"`;
    expect(looksLikeRawHtml(xbrl)).toBe(true);
    expect(looksLikeRawHtml("Revenue grew 12 percent and we raised guidance on data-center demand.")).toBe(false);
  });
});

describe("planOperationalIndexPrune", () => {
  it("deletes HTML, junk, dupes, and low-value when a local copy exists", () => {
    const rows = [
      row({
        id: "html-1",
        text: "<html><div class='x'>".repeat(20) + "</div></html>",
        metadata: { doc_type: "10-k", accession: "0001045810-26-000123", section: "1. Business" }
      }),
      row({
        id: "junk-1",
        text: "Page 3 of 200",
        metadata: { doc_type: "10-k", accession: "0001045810-26-000123", section: "1. Business" }
      }),
      row({
        id: "exhibit-1",
        text: "Exhibit 31.1 Certification of Chief Executive Officer under Section 302.",
        metadata: { doc_type: "10-k", accession: "0001045810-26-000123", section: "15. Exhibits and Financial Statement Schedules" }
      }),
      row({
        id: "body-1",
        text: "We raised guidance after a going-concern review of the revolver footnote.",
        metadata: { doc_type: "10-k", accession: "0001045810-26-000123", section: "7. Management's Discussion and Analysis", content_hash: "aaa" }
      }),
      row({
        id: "body-dupe",
        text: "We raised guidance after a going-concern review of the revolver footnote.",
        metadata: { doc_type: "10-k", accession: "0001045810-26-000123", section: "7. Management's Discussion and Analysis", content_hash: "aaa" }
      }),
      row({
        id: "summary-1",
        text: "Highlights: guidance raised; liquidity risk disclosed.",
        metadata: { doc_type: "document-summary", accession: "0001045810-26-000123" }
      }),
      row({
        id: "lesson-1",
        text: "Owner coaching: do not fade the breakout.",
        metadata: { doc_type: "lesson" }
      })
    ];
    const plan = planOperationalIndexPrune(rows, () => true);
    expect(plan.deleteIds).toEqual(expect.arrayContaining(["html-1", "junk-1", "exhibit-1", "body-dupe"]));
    expect(plan.deleteIds).not.toContain("body-1");
    expect(plan.deleteIds).not.toContain("summary-1");
    expect(plan.deleteIds).not.toContain("lesson-1");
    expect(plan.counts["raw-html"]).toBeGreaterThanOrEqual(1);
    expect(plan.counts.duplicate).toBeGreaterThanOrEqual(1);
    expect(plan.counts["keep-do-not-touch"]).toBe(1);
    expect(plan.counts["keep-processed"]).toBe(1);
    expect(plan.counts["keep-useful-body"]).toBeGreaterThanOrEqual(1);
  });

  it("keeps a useful full-body vector that is the only copy", () => {
    const only = row({
      id: "only-body",
      text: "The revolver covenant tightens if leverage exceeds 3.5x EBITDA.",
      metadata: { doc_type: "10-k", accession: "0000320193-26-000001", section: "7. Management's Discussion and Analysis" }
    });
    const lowOnly = row({
      id: "only-exhibit",
      text: "Exhibit 32.1 Certification furnished pursuant to 18 U.S.C. Section 1350.",
      metadata: { doc_type: "10-k", accession: "0000320193-26-000002", section: "15. Exhibits" }
    });
    const plan = planOperationalIndexPrune([only, lowOnly], () => false);
    expect(plan.deleteIds).not.toContain("only-body");
    expect(plan.deleteIds).not.toContain("only-exhibit");
    expect(plan.decisions.find((d) => d.id === "only-body")?.reason).toBe("keep-useful-body");
    expect(plan.decisions.find((d) => d.id === "only-exhibit")?.reason).toBe("keep-only-copy");
  });

  it("still deletes raw HTML even when it is the only vector", () => {
    const html = row({
      id: "only-html",
      text: "<!DOCTYPE html><html><body>" + "<div>x</div>".repeat(20) + "</body></html>",
      metadata: { doc_type: "10-k", accession: "0000320193-26-000003", section: "1. Business" }
    });
    const plan = planOperationalIndexPrune([html], () => false);
    expect(plan.deleteIds).toContain("only-html");
  });

  it("refuses a live apply without the confirm token", async () => {
    await expect(applyOperationalIndexPrune({
      dryRun: false,
      confirm: "nope",
      rows: [row({
        id: "html-2",
        text: "<!DOCTYPE html><html><body>" + "<span>y</span>".repeat(20) + "</body></html>",
        metadata: { doc_type: "10-k", accession: "0001045810-26-000123" }
      })],
      deleteIds: async () => 1
    })).rejects.toThrow(PRUNE_CONFIRM_TOKEN);
  });
});

describe("classifyOperationalVector", () => {
  it("keeps signal-section keys", () => {
    const classified = classifyOperationalVector(row({
      id: "sig",
      text: "Risk factors include a going-concern paragraph.",
      metadata: {
        doc_type: "10-k",
        doc_id: "NVDA:0001045810-26-000123:10-K:section:1A",
        section: "1A. Risk Factors"
      }
    }));
    expect(classified).toEqual({ action: "keep", reason: "keep-signal" });
  });
});
