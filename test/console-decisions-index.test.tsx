import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SocraticDecisionCase } from "../src/lib/types";
import DecisionsIndexPage from "../app/console/decisions/page";
import { DecisionsList } from "../app/console/decisions/decisions-list";
import { SymbolDrawerProvider } from "../app/console/ui/symbol-drawer";

/** Smoke coverage for the /console/decisions index (#2556): the console Home
 *  "All Decisions" link 404'd because this route had no page. The default export
 *  must render (initial loading state — effects don't run under static render),
 *  and the pure list body must show symbol, side, thesis tag, status, and age,
 *  each row linking into /console/decisions/[id]. */

// Relative to now: timeAgo() renders "<N>d ago" only under 30 days and switches to
// an absolute date (no "ago") past that, so a fixed calendar date rots the age
// assertion the day it turns 30 (bit CI on 2026-08-31 with "2026-08-01T12:00:00.000Z").
const RECENT_ISO = new Date(Date.now() - 60 * 60 * 1000).toISOString();

function decisionCase(overrides: Partial<SocraticDecisionCase> = {}): SocraticDecisionCase {
  return {
    id: "dec-1",
    userId: "local",
    createdAt: RECENT_ISO,
    updatedAt: RECENT_ISO,
    symbol: "NVDA",
    side: "buy",
    status: "placed",
    authority: "propose",
    thesis: "Momentum with improving breadth",
    rationale: "r",
    action: "BUY NVDA",
    thesisTag: "quality_momentum",
    evidence: [],
    ragAttributions: [],
    dissent: [],
    lessons: [],
    coachNotes: [],
    ...overrides
  };
}

describe("console decisions index (#2556)", () => {
  it("the route's default export renders (no more 404 target from Home's All Decisions link)", () => {
    const html = renderToStaticMarkup(<DecisionsIndexPage />);
    expect(html).toContain("Decisions");
    expect(html).toContain("Loading decisions");
  });

  it("lists symbol, side, thesis tag, status, and age, linking each row to its trace", () => {
    // The symbol renders as a SymbolButton (opens the company drawer), which needs
    // a SymbolDrawerProvider ancestor — see app/console/ui/symbol-drawer.tsx.
    const html = renderToStaticMarkup(
      <SymbolDrawerProvider>
        <DecisionsList decisions={[decisionCase(), decisionCase({ id: "dec 2", symbol: undefined, side: undefined, status: "rejected", thesisTag: undefined })]} />
      </SymbolDrawerProvider>
    );
    expect(html).toContain("NVDA");
    expect(html).toContain("BUY");
    expect(html).toContain("Quality Momentum"); // thesisTagLabel de-underscores + title-cases
    expect(html).toContain("Momentum with improving breadth");
    expect(html).toContain('href="/console/decisions/dec-1"');
    // Ids are URL-encoded into the href — a raw space would break the deep link.
    expect(html).toContain('href="/console/decisions/dec%202"');
    // A portfolio-level case (no symbol) renders honestly, not as a blank row.
    expect(html).toContain("Portfolio");
    // Status labels come from the shared decisionStatusLabel vocabulary.
    expect(html.toLowerCase()).toContain("placed");
    expect(html.toLowerCase()).toContain("rejected");
    // Age renders as relative time with the exact timestamp on the title attribute.
    expect(html).toContain("ago");
  });

  it("shows an honest empty state when no decision traces exist", () => {
    const html = renderToStaticMarkup(<DecisionsList decisions={[]} />);
    expect(html).toContain("No decision traces yet.");
  });
});

/** per-account-visibility (pages-04): this index deliberately interleaves every connected
 *  account's decisions with no per-row label -- misattributing a real-money BUY/SELL trace to
 *  the wrong account was the exact risk the finding raised. Proves two connected accounts with
 *  distinguishable decisions land under the right label, not silently merged. */
describe("DecisionsList account labels (per-account-visibility, pages-04)", () => {
  it("labels each row with its own account when more than one connected account is passed", () => {
    const html = renderToStaticMarkup(
      <SymbolDrawerProvider>
        <DecisionsList
          decisions={[
            decisionCase({ id: "dec-live", symbol: "NVDA", connectedAccountId: "acct-live" }),
            decisionCase({ id: "dec-paper", symbol: "AAPL", connectedAccountId: "acct-paper" })
          ]}
          accountLabelById={{ "acct-live": "Roth IRA Live", "acct-paper": "Paper Sandbox" }}
        />
      </SymbolDrawerProvider>
    );
    expect(html).toContain("Roth IRA Live");
    expect(html).toContain("Paper Sandbox");
  });

  it("stays unlabeled with only one connected account (no clutter for the common case)", () => {
    const html = renderToStaticMarkup(
      <SymbolDrawerProvider>
        <DecisionsList
          decisions={[decisionCase({ connectedAccountId: "acct-only" })]}
          accountLabelById={{ "acct-only": "Only Account" }}
        />
      </SymbolDrawerProvider>
    );
    expect(html).not.toContain("Only Account");
  });

  it("stays unlabeled when no account map is passed at all (existing single-account callers unaffected)", () => {
    const html = renderToStaticMarkup(
      <SymbolDrawerProvider>
        <DecisionsList decisions={[decisionCase()]} />
      </SymbolDrawerProvider>
    );
    expect(html).not.toContain("Unknown account");
  });

  it("labels a case with no connectedAccountId honestly as unknown, never silently as one specific account", () => {
    const html = renderToStaticMarkup(
      <SymbolDrawerProvider>
        <DecisionsList
          decisions={[
            decisionCase({ id: "dec-untagged", connectedAccountId: undefined }),
            decisionCase({ id: "dec-tagged", connectedAccountId: "acct-a" })
          ]}
          accountLabelById={{ "acct-a": "Account A", "acct-b": "Account B" }}
        />
      </SymbolDrawerProvider>
    );
    expect(html).toContain("Unknown account");
    expect(html).toContain("Account A");
  });
});
