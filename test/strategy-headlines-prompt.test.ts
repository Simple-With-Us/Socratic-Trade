/**
 * Handoff 3.6 — raw headlines in the strategist prompt.
 *
 * Two groups:
 *   1. Pure unit tests of compactHeadlinesForPrompt (src/lib/prompt-headlines.ts):
 *      bounded count, markup stripping, near-duplicate dedupe, whole-headline fidelity
 *      (never truncated mid-claim), empty result when nothing usable survives.
 *   2. compactCandidateForPrompt wiring (modeled on
 *      test/strategy-prompt-wiring-counterfactuals.test.ts): the `news` field carries the
 *      compacted sample (max HEADLINES_PER_CANDIDATE) and is ABSENT when a candidate has
 *      no headlines — never an empty scaffold.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { compactHeadlinesForPrompt, HEADLINES_PER_CANDIDATE } from "../src/lib/prompt-headlines";
import type { MarketScan } from "../src/lib/types";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-headlines-prompt-${randomUUID()}.db`)}`;
});

describe("compactHeadlinesForPrompt (handoff 3.6)", () => {
  it("caps the sample at HEADLINES_PER_CANDIDATE, keeping provider (newest-first) order", () => {
    const headlines = Array.from({ length: 9 }, (_, i) => `Distinct market headline number ${i + 1} about a company`);
    const out = compactHeadlinesForPrompt(headlines);
    expect(out).toHaveLength(HEADLINES_PER_CANDIDATE);
    expect(out[0]).toBe(headlines[0]);
    expect(out[HEADLINES_PER_CANDIDATE - 1]).toBe(headlines[HEADLINES_PER_CANDIDATE - 1]);
  });

  it("strips HTML markup/entities and collapses whitespace, keeping the claim whole", () => {
    const out = compactHeadlinesForPrompt(["<b>Apple &amp; suppliers</b> beat\n\n estimates &#39;again&#39;"]);
    expect(out).toEqual(["Apple & suppliers beat estimates 'again'"]);
  });

  it("dedupes exact and near-identical (case/punctuation) duplicates", () => {
    const out = compactHeadlinesForPrompt([
      "NVIDIA announces next-generation chip architecture.",
      "NVIDIA Announces Next-Generation Chip Architecture",
      "nvidia announces next generation chip architecture",
      "NVIDIA data-center revenue tops estimates."
    ]);
    expect(out).toEqual([
      "NVIDIA announces next-generation chip architecture.",
      "NVIDIA data-center revenue tops estimates."
    ]);
  });

  it("dedupes a long prefix-contained near-duplicate but never a short shared prefix", () => {
    const out = compactHeadlinesForPrompt([
      "Apple beats third-quarter earnings estimates on strong services growth",
      // Long normalized prefix of the first -> near-duplicate, dropped.
      "Apple beats third-quarter earnings estimates",
      // Short strings only dedupe on exact equality — "Apple" must not swallow other headlines.
      "Apple",
      "Apple warns on next-quarter guidance"
    ]);
    expect(out).toEqual([
      "Apple beats third-quarter earnings estimates on strong services growth",
      "Apple",
      "Apple warns on next-quarter guidance"
    ]);
  });

  it("never truncates a headline mid-claim — kept whole or not at all", () => {
    const long = "Apple beats estimates but warns that next-quarter guidance will come in well below consensus expectations";
    const out = compactHeadlinesForPrompt([long]);
    expect(out).toEqual([long]);
  });

  it("returns [] for undefined, empty, or nothing-usable input", () => {
    expect(compactHeadlinesForPrompt(undefined)).toEqual([]);
    expect(compactHeadlinesForPrompt([])).toEqual([]);
    expect(compactHeadlinesForPrompt(["", "   ", "<br/>"])).toEqual([]);
  });
});

type Candidate = MarketScan["topCandidates"][number];

function candidate(overrides: Partial<Candidate>): Candidate {
  return {
    symbol: "TEST",
    price: 100,
    asOf: "2026-07-15T14:30:00.000Z",
    ...overrides
  } as Candidate;
}

describe("compactCandidateForPrompt news wiring (handoff 3.6)", () => {
  it("injects the bounded, deduped headline sample as `news` (max HEADLINES_PER_CANDIDATE)", async () => {
    const { compactCandidateForPrompt } = await import("../src/lib/strategy");
    const headlines = [
      "Distinct headline one about the company and its products",
      "Distinct headline one about the company and its products", // exact duplicate
      "Distinct headline two about quarterly results",
      "Distinct headline three about a new product line",
      "Distinct headline four about analyst upgrades",
      "Distinct headline five about sector rotation",
      "Distinct headline six that exceeds the cap"
    ];
    const compact = compactCandidateForPrompt(candidate({ headlines }), 0);
    const news = compact.news as string[];
    expect(news).toHaveLength(HEADLINES_PER_CANDIDATE);
    expect(new Set(news).size).toBe(news.length); // no dupes
    expect(news[0]).toBe(headlines[0]);
  });

  it("omits `news` entirely when the candidate has no headlines — never an empty scaffold", async () => {
    const { compactCandidateForPrompt } = await import("../src/lib/strategy");
    expect("news" in compactCandidateForPrompt(candidate({}), 0)).toBe(false);
    expect("news" in compactCandidateForPrompt(candidate({ headlines: [] }), 0)).toBe(false);
    // Nothing usable survives compaction -> empty array -> dropped by compactPromptObject.
    expect("news" in compactCandidateForPrompt(candidate({ headlines: ["", "  "] }), 0)).toBe(false);
  });
});
