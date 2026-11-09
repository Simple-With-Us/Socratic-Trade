import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "../app/admin/transcript/markdown";
import { describeLongTurn, LONG_TURN_CHARS } from "../app/admin/transcript/long-turn";

describe("admin transcript preview markdown", () => {
  it("renders the turn's markdown instead of leaking its source", () => {
    // The /admin dashboard preview card used to interpolate the raw turn text as a
    // text node, so `**bold**` and `## Heading` showed up literally.
    const html = renderToStaticMarkup(<Markdown>{"## Heading\n\n**bold** reply"}</Markdown>);

    expect(html).toContain("<strong");
    expect(html).toContain("<h2");
    expect(html).not.toContain("**");
    expect(html).not.toContain("## ");
  });

  it("escapes embedded HTML in model output (no rehype-raw)", () => {
    const html = renderToStaticMarkup(<Markdown>{'<img src=x onerror="alert(1)">'}</Markdown>);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("keeps the caller's clamp classes so the preview cannot blow out the card", () => {
    const html = renderToStaticMarkup(
      <Markdown className="max-h-[3.3em] overflow-hidden">{"line"}</Markdown>
    );
    expect(html).toContain("max-h-[3.3em]");
    expect(html).toContain("overflow-hidden");
  });
});

describe("admin transcript long-turn collapse", () => {
  it("leaves ordinary replies expanded and only collapses near-ceiling walls of text", () => {
    // Stored turns are truncated at 4000 chars, so the threshold sits near that
    // ceiling on purpose: this is an audit view, and a click per turn would be
    // worse than the scroll it replaces.
    expect(describeLongTurn("short answer").collapse).toBe(false);
    expect(describeLongTurn("x".repeat(LONG_TURN_CHARS)).collapse).toBe(false);
    expect(describeLongTurn("x".repeat(LONG_TURN_CHARS + 1)).collapse).toBe(true);
    expect(describeLongTurn("x".repeat(4000)).collapse).toBe(true);
  });

  it("labels the disclosure with a length, never a markdown excerpt", () => {
    const label = describeLongTurn(`**bold** ${"x".repeat(2500)}`).label;
    expect(label).toBe("Long reply · 2,509 characters");
    expect(label).not.toContain("**");
  });
});
