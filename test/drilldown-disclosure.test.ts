import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ExposureSection, SignalSummarySection, DerivedTilesSection, FactorSection, AnalystSection, FundamentalsSection, EvidenceSection, SourcesSection } from "../app/console/ui/drilldown-sections";
import type { QuoteView, DerivedResult } from "../app/console/ui/drilldown-data";

const view = { symbol: "TEST", price: 100, score: 72, provider: "fixture", factorBreakdown: { momentum: 70, quality: 68, value: 62 }, analystScore: 75, analystRating: "Buy", evidenceBulletins: ["Synthetic fixture evidence only."] } as QuoteView;
const derived = { metrics: {} } as DerivedResult;

describe("drilldown native disclosures", () => {
  const cases = [
    ["exposure", createElement(ExposureSection, { symbol: "TEST", pending: [], orders: [] }), true],
    ["signals", createElement(SignalSummarySection, { view, derived }), true],
    ["derived", createElement(DerivedTilesSection, { view, derived }), true],
    ["factors", createElement(FactorSection, { view }), true],
    ["analysts", createElement(AnalystSection, { view }), true],
    ["fundamentals", createElement(FundamentalsSection, { view }), false],
    ["evidence", createElement(EvidenceSection, { view }), false],
    ["sources", createElement(SourcesSection, { view }), false]
  ] as const;
  for (const [name, element, initiallyOpen] of cases) {
    it(`${name}: preserves current visibility and uses a native summary with a visual cue`, () => {
      const html = renderToStaticMarkup(element);
      const details = html.match(/<details\b[^>]*>/)?.[0];
      expect(details).toBeDefined();
      expect(/\bopen=""/.test(details!)).toBe(initiallyOpen);
      expect(html).toContain("<summary");
      expect(html).toContain('aria-hidden="true" class="con-disclosure-label ml-auto shrink-0 whitespace-nowrap"');
      expect(html).toContain("<span class=\"con-card-title\">");
      expect(html).not.toContain("focus:outline-none");
    });
  }
});
