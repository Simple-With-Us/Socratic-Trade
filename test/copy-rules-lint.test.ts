/**
 * Copy-rule lint for user-facing web strings — mirrors the copy-rule tests the
 * iOS suite already runs (ios/SocraticTradeTests/UserFacingCopyTests.swift's
 * `assertOrdinary` jargon check; ios/SocraticTradeTests/OrderCancelTests.swift's
 * inline two-space check) for the console + public web pages.
 *
 * Owner context (2026-08-18 full-app review, cluster `copy-consistency-rules`):
 * SENTENCE_GAP (app/console/lib/format.ts:54) was used in ~9 files against
 * ~600-900 web copy strings, and a literal "  " typed straight into JSX
 * (app/console/components/consent-gate.tsx:107) collapses to ONE rendered
 * space — the SOURCE looked compliant while the SCREEN was not. That is the
 * exact failure mode this file exists to catch: it simulates the browser's
 * white-space collapse rather than trusting what the source text looks like.
 *
 * The scanner logic lives in scripts/copy-rules-lint.mjs (also runnable
 * standalone: `node scripts/copy-rules-lint.mjs [--json] [--dir <paths>]`)
 * so a human or CI can run a full repo sweep without vitest.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectFiles,
  findCentralTimeViolations,
  findCompactMoneyViolations,
  findSentenceGapViolations,
  lintFiles,
  PEER_LOCKED_FILES
} from "../scripts/copy-rules-lint.mjs";

const REPO_ROOT = path.resolve(__dirname, "..");

/** Simulates the browser's default `white-space: normal` text collapse (CSS
 *  Text Module Level 3): runs of ASCII space/tab/newline collapse to ONE
 *  rendered space. U+00A0 (NBSP) is explicitly excluded from that
 *  collapsible set, so it always renders as its own character. This is the
 *  render-level ground truth the lint is built against — not a guess about
 *  what HTML "probably" does. */
function renderCollapse(text: string): string {
  return text.replace(/[ \t\n]+/g, " ");
}

describe("copy-rule lint — rule A: sentence-gap (owner two-space rule)", () => {
  it("flags a missing gap: single ASCII space at a sentence boundary", () => {
    expect(findSentenceGapViolations("Sentence one. Sentence two.")).toHaveLength(1);
  });

  it("flags the render-collapse trap: TWO literal ASCII spaces still renders as one", () => {
    // This is the exact bug at consent-gate.tsx:107 before the fix: the
    // source has "two spaces" and looks compliant at a glance, but HTML
    // collapses them to a single rendered space — same failure as above.
    expect(findSentenceGapViolations("Sentence one.  Sentence two.")).toHaveLength(1);
  });

  it("does NOT flag the one construct that actually survives rendering: NBSP + space", () => {
    expect(findSentenceGapViolations("Sentence one.  Sentence two.")).toHaveLength(0);
  });

  it("does not flag known non-terminal abbreviations", () => {
    expect(findSentenceGapViolations("See the U.S. Treasury desk today.")).toHaveLength(0);
    expect(findSentenceGapViolations("Confirm the amount (e.g. $500) below.")).toHaveLength(0);
    expect(findSentenceGapViolations("Contact Dr. Smith for a referral.")).toHaveLength(0);
  });

  it("does not flag a decimal point followed by more digits, or a version number", () => {
    expect(findSentenceGapViolations("The ratio was 4.5 today.")).toHaveLength(0);
    expect(findSentenceGapViolations("Running v1.2.3 now.")).toHaveLength(0);
  });

  it("PROVES THE RENDER for two representative strings, not just the source", () => {
    // String 1: app/console/components/consent-gate.tsx's error toast, as it
    // existed before this PR's fix.
    const consentGateBefore = "Your acceptance could not be saved.  The console stays locked until this is resolved — try again.";
    expect(renderCollapse(consentGateBefore)).toBe(
      "Your acceptance could not be saved. The console stays locked until this is resolved — try again."
    );
    // ^ ONE space between the sentences post-render — not the two the owner
    // requires, and not visually distinguishable from a typo that dropped
    // the gap entirely. This is what a real user's screen showed.

    // String 1, after this PR's fix (SENTENCE_GAP = NBSP + space):
    const consentGateAfter = "Your acceptance could not be saved.  The console stays locked until this is resolved — try again.";
    expect(renderCollapse(consentGateAfter)).toBe(consentGateAfter);
    expect(consentGateAfter).toMatch(/\.  The console/);
    // ^ both characters of the gap survive collapse — this is what the
    // fixed screen shows.

    // String 2: a Guardrails field hint (app/console/guardrails/field-defs.ts),
    // representative of the ~600-900 backend/tooltip strings this cluster's
    // root-cause description flagged, before and after.
    const hintBefore = "Hard dollar cap on any single order. The effective cap never exceeds current buying power/NAV.";
    expect(renderCollapse(hintBefore)).toBe(hintBefore); // single space in, single space out — never had a gap
    expect(hintBefore).not.toMatch(/\.  The/);

    const hintAfter = "Hard dollar cap on any single order.  The effective cap never exceeds current buying power/NAV.";
    expect(renderCollapse(hintAfter)).toBe(hintAfter);
    expect(hintAfter).toMatch(/\.  The/);
  });
});

describe("copy-rule lint — rule B: compact-money (lowercase suffixes)", () => {
  it("flags a compact Intl.NumberFormat with no .toLowerCase() anywhere after it", () => {
    const content = 'const compact = new Intl.NumberFormat("en-US", { notation: "compact" });\nexport const fmt = (v) => compact.format(v);\n';
    expect(findCompactMoneyViolations(content)).toHaveLength(1);
  });

  it("does not flag one whose result is lowercased", () => {
    const content = 'const compact = new Intl.NumberFormat("en-US", { notation: "compact" });\nexport const fmt = (v) => compact.format(v).toLowerCase();\n';
    expect(findCompactMoneyViolations(content)).toHaveLength(0);
  });
});

describe("copy-rule lint — rule C: Central-time timestamps", () => {
  it("flags a Date .toLocaleString() with no timeZone", () => {
    expect(findCentralTimeViolations("new Date(x).toLocaleString()")).toHaveLength(1);
  });

  it("flags .toLocaleDateString()/.toLocaleTimeString() unconditionally when timeZone is missing (Date-only methods)", () => {
    expect(findCentralTimeViolations("d.toLocaleDateString()")).toHaveLength(1);
    expect(findCentralTimeViolations("d.toLocaleTimeString()")).toHaveLength(1);
  });

  it("does not flag a Date call that already passes timeZone", () => {
    expect(findCentralTimeViolations('d.toLocaleString(undefined, { timeZone: "America/Chicago" })')).toHaveLength(0);
  });

  it("does NOT flag Number.prototype.toLocaleString() (thousands separators, not a date)", () => {
    // Verified false-positive class: count.toLocaleString(), shares.toLocaleString(),
    // vectors.toLocaleString() are all plain numbers in this codebase and need
    // no timeZone at all.
    expect(findCentralTimeViolations("earningsStatus.ingestedCount.toLocaleString()")).toHaveLength(0);
    expect(findCentralTimeViolations("r.shares.toLocaleString()")).toHaveLength(0);
    expect(findCentralTimeViolations("Math.round(v).toLocaleString()")).toHaveLength(0);
  });

  it("DOES flag a bare .toLocaleString() when the receiver clearly names a date/timestamp", () => {
    expect(findCentralTimeViolations("new Date(legal.acceptedAt).toLocaleString()")).toHaveLength(1);
  });
});

describe("copy-rule lint — repo sweep (console + public web pages)", () => {
  const { results, totals } = lintFiles(collectFiles(["app"]));

  it("has ZERO sentence-gap violations outside the peer-locked files", () => {
    // chrome.tsx, primitives.tsx, nav.tsx, guardrails/page.tsx, admin/page.tsx
    // are owned by peer PRs #2795/#2793/#2828 right now (see CLAUDE.md scope
    // note in this PR's rollout doc) — this test enforces the fix pass
    // everywhere else in app/**, and will start failing the moment a new
    // un-gapped sentence lands anywhere this PR touched.
    const offenders = results.filter((r) => r.sentenceGap.length > 0 && !PEER_LOCKED_FILES.has(r.file));
    if (offenders.length > 0) {
      const detail = offenders.map((o) => `  ${path.relative(REPO_ROOT, o.file)}: ${o.sentenceGap.length}`).join("\n");
      throw new Error(`Sentence-gap violations found outside the peer-locked files:\n${detail}`);
    }
    expect(offenders).toHaveLength(0);
  });

  it("tracks the peer-locked backlog honestly and never lets it grow", () => {
    // 46 violations across 3 of the 5 peer-locked files (chrome.tsx,
    // guardrails/page.tsx, admin/page.tsx — nav.tsx and primitives.tsx
    // currently carry none), as of this PR. This is not a silent pass: the
    // count is real, reported here, and in this PR's report to the caller.
    const lockedTotal = results.filter((r) => PEER_LOCKED_FILES.has(r.file)).reduce((n, r) => n + r.sentenceGap.length, 0);
    const filesWithViolations = results.filter((r) => r.sentenceGap.length > 0);
    expect(filesWithViolations.every((r) => PEER_LOCKED_FILES.has(r.file))).toBe(true);
    expect(lockedTotal).toBeLessThanOrEqual(46);
  });

  it("has zero compact-money violations repo-wide (lowercase-suffix rule)", () => {
    expect(totals.compactMoney).toBe(0);
  });

  it("has zero Central-time violations repo-wide", () => {
    expect(totals.centralTime).toBe(0);
  });
});
