/**
 * R8 / C7 (2026-07-01 expert review): first-*valid*-ticker fix + stopword denylist.
 *
 * salience.ts:95 used `text.match(TICKER_RE)` — first CAPS token only, no validation — so a
 * sentence like "I always buy the dip" or "The CEO always talks up guidance" mis-bound the
 * learned fact to a fake symbol ("I"/"CEO"). This suite covers the fix: `firstValidTicker` uses
 * `matchAll` + a built-in stopword denylist (pure, no DB) and accepts an optional injected
 * validator for stricter (real known-universe) checks — salience.ts itself stays pure/DB-free.
 */
import { describe, expect, it } from "vitest";
import { extractLearnedCandidates, firstValidTicker } from "../src/lib/memory/salience";

describe("firstValidTicker (matchAll + stopword denylist, no DB)", () => {
  it("skips a leading stopword and finds the real ticker later in the sentence", () => {
    expect(firstValidTicker("I always buy the dip in NVDA after a selloff.")).toBe("NVDA");
  });

  it("skips 'CEO' and finds the real ticker", () => {
    expect(firstValidTicker("The CEO of MSFT always talks up guidance on earnings calls.")).toBe("MSFT");
  });

  it("does not mis-bind to the FIRST caps token when a later token is the real subject", () => {
    // "NVDA is the sole supplier, not AMD or INTC" — the first token (NVDA) IS valid here, so this
    // documents the non-mis-binding baseline case (first token happens to also be correct).
    expect(firstValidTicker("NVDA is the sole supplier, not AMD or INTC.")).toBe("NVDA");
  });

  it("returns null when every caps token is a stopword", () => {
    expect(firstValidTicker("I think the CEO and CFO discussed ESG and AI at the IPO.")).toBeNull();
  });

  it("returns null on a message with no caps tokens at all", () => {
    expect(firstValidTicker("just a regular lowercase sentence")).toBeNull();
  });

  it("applies an injected validator on top of the built-in denylist", () => {
    // Injected validator rejects everything except "NVDA" — proves the predicate is actually
    // consulted (both AAPL and MSFT pass the built-in denylist but must still be rejected here).
    const validator = (candidate: string) => candidate === "NVDA";
    expect(firstValidTicker("AAPL MSFT NVDA", validator)).toBe("NVDA");
    expect(firstValidTicker("AAPL MSFT GOOGL", validator)).toBeNull();
  });

  it("without an injected validator, only the built-in denylist applies (any non-stopword caps token passes)", () => {
    // No validator injected — a made-up-but-not-a-stopword token like "ZZZZZ" still passes, because
    // salience.ts intentionally stays permissive without an injected real-universe check (that
    // stricter validation is salience-llm.ts's job, via isIndexMemberSymbol).
    expect(firstValidTicker("ZZZZZ is doing something.")).toBe("ZZZZZ");
  });
});

describe("extractLearnedCandidates: symbol binding uses firstValidTicker (not the old first-match-only bug)", () => {
  it("a pattern candidate about a message starting with 'I' binds to the real ticker mentioned later", () => {
    const cands = extractLearnedCandidates("I always see NVDA drift higher for days after earnings.");
    const pattern = cands.find((c) => c.kind === "pattern");
    expect(pattern?.symbol).toBe("NVDA");
    expect(pattern?.subject).toMatch(/^pattern:NVDA:[0-9a-f]{12}$/);
  });

  it("a decision candidate mentioning 'the CEO' binds to the real ticker, not 'CEO'", () => {
    const cands = extractLearnedCandidates("The CEO confirmed MSFT is the dominant supplier in this market.");
    const decision = cands.find((c) => c.kind === "decision");
    expect(decision?.symbol).toBe("MSFT");
    expect(decision?.subject).toMatch(/^fact:MSFT:[0-9a-f]{12}$/);
  });

  it("when every caps token is a stopword, the candidate is symbol-less (not mis-bound)", () => {
    const cands = extractLearnedCandidates("The CEO and CFO always talk up guidance before earnings.");
    const pattern = cands.find((c) => c.kind === "pattern");
    expect(pattern?.symbol).toBeNull();
    expect(pattern?.subject).toMatch(/^pattern:[0-9a-f]{12}$/);
  });

  it("assigns distinct content-keyed subjects to different facts for the same ticker while keeping identical text deterministic", () => {
    const first = extractLearnedCandidates("The CEO confirmed MSFT is the dominant supplier in enterprise cloud.");
    const second = extractLearnedCandidates("The CFO noted MSFT is the sole provider of that custom silicon.");
    const firstRepeat = extractLearnedCandidates("The CEO confirmed MSFT is the dominant supplier in enterprise cloud.");
    const d1 = first.find((c) => c.kind === "decision");
    const d2 = second.find((c) => c.kind === "decision");
    const d1Repeat = firstRepeat.find((c) => c.kind === "decision");
    expect(d1?.subject).toMatch(/^fact:MSFT:[0-9a-f]{12}$/);
    expect(d2?.subject).toMatch(/^fact:MSFT:[0-9a-f]{12}$/);
    expect(d1?.subject).not.toBe(d2?.subject);
    expect(d1?.subject).toBe(d1Repeat?.subject);
  });

  it("an injected validator further restricts which real-looking tokens bind as a symbol", () => {
    // Reject everything so every candidate ends up symbol-less, proving the validator threads
    // through extractLearnedCandidates end-to-end.
    const rejectAll = () => false;
    const cands = extractLearnedCandidates("NVDA is the sole supplier of this component.", rejectAll);
    const decision = cands.find((c) => c.kind === "decision");
    expect(decision?.symbol).toBeNull();
  });
});
