/**
 * The framework deep-link target.
 *
 * The /framework page renders its sections only after an async content fetch, so
 * the browser's own fragment handling at load finds no target and the page
 * sits at the top. The viewer re-scrolls once the content is ready.
 *
 * The id lookup is the part that can be wrong in a way a reader would notice, so
 * it is a pure function with its own tests here. The scroll itself needs a DOM,
 * so that part is pinned by a source-level guard in the same style the repo
 * already uses for the public shell's invariants.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hashTargetId } from "../app/framework/hash-target";

const REPO_ROOT = join(__dirname, "..");

describe("framework deep links — the hash target", () => {
  it("names the section a hash points at", () => {
    expect(hashTargetId("#questions")).toBe("questions");
    expect(hashTargetId("#plain-loop")).toBe("plain-loop");
    expect(hashTargetId("#outcome-review")).toBe("outcome-review");
  });

  it("decodes a percent-encoded id", () => {
    expect(hashTargetId("#a%20b")).toBe("a b");
  });

  it("returns null when the hash names nothing", () => {
    expect(hashTargetId("")).toBeNull();
    expect(hashTargetId("#")).toBeNull();
  });

  it("falls back to the raw text when the id does not decode", () => {
    // A malformed escape is not a usable id, but it must not throw — a broken
    // deep link should leave the reader at the top of the page, not on an
    // error screen.
    expect(hashTargetId("#100%")).toBe("100%");
    expect(hashTargetId("#%E0%A4%A")).toBe("%E0%A4%A");
  });

  it("the viewer scrolls to the hash target once the content is ready", () => {
    const src = readFileSync(join(REPO_ROOT, "app/framework/framework-viewer.tsx"), "utf8");
    // The scroll must wait for the content: the section ids do not exist in the
    // document until the async fetch has rendered them.
    expect(src).toContain('state.phase !== "ready"');
    expect(src).toContain("hashTargetId(window.location.hash)");
    expect(src).toContain("scrollIntoView");
  });

  it("every section the table of contents links to has a section to land on", () => {
    // A link to a missing id is a dead deep link. The viewer's section ids and
    // its table of contents are two lists in one file, so this keeps them honest.
    const src = readFileSync(join(REPO_ROOT, "app/framework/framework-viewer.tsx"), "utf8");
    const listed = [...src.matchAll(/\{ id: "([^"]+)", label:/g)].map((m) => m[1]);
    expect(listed.length).toBeGreaterThan(0);
    for (const id of listed) {
      expect(src, `section id "${id}" is linked but never rendered`).toContain(`id="${id}"`);
    }
  });
});
