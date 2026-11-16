import { describe, expect, it } from "vitest";

// The public explainer moved /strategy → /how-it-works → /framework. Both old
// paths are now permanent redirects to the single canonical page: /framework
// absorbed the how-it-works content (the plain-language decision loop, the
// decision case file, the authority controls, and the outcome review lenses)
// on 2026-10-19, and /welcome's "Framework" button links there.
describe("public explainer redirects", () => {
  it("/how-it-works permanently redirects to /framework", async () => {
    const HowItWorks = (await import("../app/how-it-works/page")).default;
    let digest = "";
    try {
      HowItWorks();
    } catch (err) {
      digest = String((err as { digest?: string })?.digest ?? err);
    }
    expect(digest).toContain("NEXT_REDIRECT");
    expect(digest).toContain("/framework");
    // 308, not 307: the page is retired, and a permanent redirect is what keeps
    // an inbound link from a search result on the content.
    expect(digest).toContain("308");
  });

  it("/strategy permanently redirects straight to /framework (one hop, not two)", async () => {
    const StrategyRedirect = (await import("../app/strategy/page")).default;
    let digest = "";
    try {
      StrategyRedirect();
    } catch (err) {
      digest = String((err as { digest?: string })?.digest ?? err);
    }
    expect(digest).toContain("NEXT_REDIRECT");
    expect(digest).toContain("/framework");
    expect(digest).toContain("308");
  });

  it("/framework is still a live page", async () => {
    const FrameworkPage = (await import("../app/framework/page")).default;
    // force-dynamic + a UA gate, so this renders through next/headers; the
    // assertion is that the module still exports a page component at all.
    expect(typeof FrameworkPage).toBe("function");
  });
});
