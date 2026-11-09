# 2026-07-08 — Inline-Bear bare-array recovery + silent-veto fix (MONET)

## Summary
Applies PR #1091's DeepSeek bare-array recovery to the SECOND Bear parser it did not
cover: the inline Bear in `strategy.ts` (the per-tick reviewer). Found via the model
benchmark sweep (deepseek Red = 0% schema-valid against the inline contract).

## Why
The inline parse (`parsedBear.proposals ?? []`) had a worse failure mode than the one
#1091 fixed in `debateProposal`: a bare array — or ANY object missing the `proposals`
key — parsed as valid JSON and silently became `[]`, i.e. "the Bear deliberately vetoed
every proposal", with no error, no fallback, no audit. Exposure was latent (the live
Bear, gemini-3.5-flash, emits proper objects) but real for anyone switching the Bear to
DeepSeek. The single-adversary consolidation will delete this code path entirely; this
closes the hole until then (their delete supersedes this cleanly).

## Changes
- `src/lib/strategy.ts`: new exported pure helper `parseBearSurvivors(text)` used at the
  inline parse site. Semantics (mirrors #1091: tolerant of shape drift, fail-safe on
  substance): bare array containing proposal-shaped objects → recovered as survivors;
  `{proposals: []}` stays a REAL deliberate full veto; bare empty array / garbage array /
  object missing `proposals` / non-object JSON / unparseable → `fallbackToBull`
  (malformed → routed per the existing Bear-unavailable policy) instead of silent veto.
- `test/inline-bear-parse.test.ts`: 7 cases pinning recovery + every fail-safe branch.

## Verification
`npx tsc --noEmit` 0 errors; new test 7/7 + red-team suite green; full gate via land.sh.

## Follow-ups
- Single-adversary lane deletes the inline Bear — resolve any conflict by TAKING THE
  DELETION (this fix dies with the code it guards).
- Benchmark harness re-scores DeepSeek Red against the verdict contract with #1091
  unwrap tolerance post-consolidation.
