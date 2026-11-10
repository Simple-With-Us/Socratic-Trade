import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveMaxActiveCommit } from "../app/console/strategy/overlays-panel";

/**
 * console-ia-forms-blotters (keystroke-PATCH slice, docs/reviews/2026-08-18-full-app-expert-review.md):
 * Strategy > Overlays "Max Active" PATCHed the server on every keystroke via a plain
 * `<TextInput type="number" onChange={...}>` — the only overlays field that didn't follow the
 * blur-commit pattern every sibling numeric field in the console uses. Worse, its onChange did
 * `Math.max(1, Number(event.target.value) || 2)`: `Number("")` is `0`, which is falsy, so
 * clearing the field to retype a new value wrote the literal fallback `2` to the server as a
 * real strategyOverlaysEnabled/maxActiveOverlays setting on the very next keystroke.
 *
 * resolveMaxActiveCommit is the pure decision the blur handler now uses: it must never turn
 * blank/unparseable text into a fallback write of 2 (or anything else).
 */
describe("Overlays > Max Active: blur-commit, no fallback-2 on empty", () => {
  it("blank text commits nothing — it must NOT write the old fallback of 2", () => {
    const result = resolveMaxActiveCommit("", 4);
    expect(result).toBeNull();
    expect(result).not.toBe(2);
  });

  it("clearing a field that was already 2 still commits nothing (blank is blank, not a no-op false positive)", () => {
    expect(resolveMaxActiveCommit("", 2)).toBeNull();
  });

  it("whitespace-only text commits nothing", () => {
    expect(resolveMaxActiveCommit("   ", 3)).toBeNull();
  });

  it("unparseable text commits nothing", () => {
    expect(resolveMaxActiveCommit("abc", 3)).toBeNull();
    expect(resolveMaxActiveCommit("-", 3)).toBeNull();
  });

  it("a value equal to what's already saved is a no-op (no redundant PATCH)", () => {
    expect(resolveMaxActiveCommit("4", 4)).toBeNull();
  });

  it("a real, changed, parseable value commits the parsed number", () => {
    expect(resolveMaxActiveCommit("5", 2)).toBe(5);
  });

  it("still floors at 1 for a real (non-empty) out-of-range value, matching the old validation intent", () => {
    expect(resolveMaxActiveCommit("0", 3)).toBe(1);
    expect(resolveMaxActiveCommit("-5", 3)).toBe(1);
  });
});

describe("Overlays > Max Active: commit happens on blur, not on every keystroke", () => {
  const src = readFileSync(new URL("../app/console/strategy/overlays-panel.tsx", import.meta.url), "utf8");

  it("the field is a RawNumInput (commit-on-blur primitive), not a plain onChange-driven TextInput", () => {
    const fieldMatch = src.match(/id="overlay-max"[\s\S]*?\/>/);
    expect(fieldMatch, "expected to find the overlay-max input").toBeTruthy();
    expect(fieldMatch![0]).toMatch(/onValueChange=\{[^}]*setMaxActiveDraft[^}]*\}/);
    expect(fieldMatch![0]).not.toContain("patchTuning");
  });

  it("onBlur wires to the commit path (the only place that can PATCH)", () => {
    expect(src).toMatch(/onBlur=\{\(\)\s*=>\s*void commitMaxActive\(\)\}/);
  });

  it("commitMaxActive — the sole caller of patchTuning for typed text — routes through the no-fallback decision function", () => {
    const fnMatch = src.match(/async function commitMaxActive\(\) \{([\s\S]*?)\n  \}/);
    expect(fnMatch, "expected to find the commitMaxActive function body").toBeTruthy();
    expect(fnMatch![1]).toContain("resolveMaxActiveCommit");
    expect(fnMatch![1]).toContain("patchTuning({ maxActiveOverlays: next })");
  });
});
