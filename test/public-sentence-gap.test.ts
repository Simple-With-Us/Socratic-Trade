/**
 * The public pages' sentence gap — proven at the render level.
 *
 * The owner's rule is two spaces between sentences, but HTML collapses runs of
 * plain ASCII whitespace to one, so the SOURCE looking compliant is not
 * enough: the only construct that survives rendering is NBSP + space. The
 * repo's own scanner (`scripts/copy-rules-lint.mjs`) polices the source; this
 * file proves the rendered output.
 *
 * Both public surfaces are covered:
 *   - /welcome is server-rendered, so its markup can be rendered here and
 *     checked for the real NBSP character.
 *   - /framework serves its prose as JSON to a client renderer, so its gap is
 *     checked in the content module that produces the payload.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { findSentenceGapViolations } from "../scripts/copy-rules-lint.mjs";
import { FRAMEWORK_CONTENT } from "../app/framework/content";
import WelcomePage from "../app/welcome/page";

/** The browser's default `white-space: normal` collapse: runs of ASCII
 *  space/tab/newline become ONE space. U+00A0 is not in that collapsible set,
 *  so it always renders as its own character. */
function renderCollapse(text: string): string {
  return text.replace(/[ \t\n]+/g, " ");
}

/** Every string inside a JSON-shaped value. */
function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out);
  else if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) collectStrings(item, out);
  }
  return out;
}

const NBSP = "\u00A0";

describe("public copy — the sentence gap survives the browser's whitespace collapse", () => {
  it("the welcome page's server-rendered markup carries a real NBSP + space", () => {
    const html = renderToStaticMarkup(createElement(WelcomePage));

    // The hero's first sentence ends here, and the second must be separated
    // from it by the two-character gap. A literal "&nbsp;" in the JSX
    // compiles to the actual U+00A0 character, so the markup must contain it.
    expect(html).toContain(`together.${NBSP} Review the available evidence`);

    // And that gap must still be there after the browser collapses whitespace.
    const collapsed = renderCollapse(html);
    expect(collapsed).toContain(`together.${NBSP} Review the available evidence`);
  });

  it("the welcome page's disclosures keep their gaps too", () => {
    const html = renderToStaticMarkup(createElement(WelcomePage));
    expect(html).toContain(`of loss.${NBSP} Simulated or`);
    expect(html).toContain(`own investment decisions.${NBSP} Consult a`);
  });

  it("the framework content stores its gaps as NBSP + space, not ASCII spaces", () => {
    // The repo's own scanner is the authority on where a sentence boundary
    // is; every one of them must already carry the rendered gap.
    for (const text of collectStrings(FRAMEWORK_CONTENT)) {
      expect(
        findSentenceGapViolations(text),
        `ASCII-space gap in: ${text.slice(0, 90)}`
      ).toHaveLength(0);
    }
  });

  it("the framework content's gaps are present and survive the collapse", () => {
    const strings = collectStrings(FRAMEWORK_CONTENT);
    const gapsBefore = strings.reduce((n, s) => n + s.split(`${NBSP} `).length - 1, 0);
    const gapsAfter = strings.reduce(
      (n, s) => n + renderCollapse(s).split(`${NBSP} `).length - 1,
      0
    );
    expect(gapsBefore).toBeGreaterThan(0);
    // NBSP is not collapsible, so the gap count cannot change in the browser.
    expect(gapsAfter).toBe(gapsBefore);
  });
});
