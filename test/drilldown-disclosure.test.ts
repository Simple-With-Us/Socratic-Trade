import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ExitPlanSection, PeerAccountsSection, LastCallSection, ExposureSection, SignalSummarySection, DerivedTilesSection, FactorSection, AnalystSection, FundamentalsSection, EvidenceSection, SourcesSection } from "../app/console/ui/drilldown-sections";
import type { QuoteView, DerivedResult } from "../app/console/ui/drilldown-data";

const view = { symbol: "TEST", price: 100, score: 72, provider: "fixture", factorBreakdown: { momentum: 70, quality: 68, value: 62 }, analystScore: 75, analystRating: "Buy", evidenceBulletins: ["Synthetic fixture evidence only."] } as QuoteView;
const derived = { metrics: {} } as DerivedResult;

describe("drilldown native disclosures", () => {
  const cases = [
    ["exit-plan", createElement(ExitPlanSection, { symbol: "TEST", protection: { label: "No stop armed", tone: "muted", detail: "Synthetic fixture." } as ComponentProps<typeof ExitPlanSection>["protection"] }), true],
    ["peer-accounts", createElement(PeerAccountsSection, { symbol: "TEST", peers: [{ accountId: "fixture-peer", quantity: 2, direction: "long", label: "Synthetic peer" }] as ComponentProps<typeof PeerAccountsSection>["peers"] }), true],
    ["last-call", createElement(LastCallSection, { lastCall: { id: "fixture-case", status: "passed", green: "Synthetic fixture." } as ComponentProps<typeof LastCallSection>["lastCall"] }), true],
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
      expect(html).toMatch(/<summary[^>]*aria-label="[^"]+"[^>]*aria-describedby="[^"]+"/);
      const summary = html.match(/<summary[\s\S]*?<\/summary>/)?.[0] ?? "";
      expect(summary).not.toContain("tabindex");
      expect(summary).not.toContain("cursor-pointer");
      expect(summary).toContain('class="sr-only group-focus:not-sr-only');
      expect(summary).toContain('group-focus:basis-full');
      expect(summary).not.toMatch(/<(button|a|input|select)\b/);
      expect(html).toContain('aria-hidden="true" class="con-disclosure-label ml-auto shrink-0 whitespace-nowrap"');
      expect(html).toContain("<h3 class=\"con-card-title\">");
      expect(html).not.toContain("focus:outline-none");
    });
  }
});
