# Local JSON Healing for Strategy & Red Team

_(Rewritten 2026-07-17 by CLAUDE during the PR #1696 cap-reset pickup — the original note listed
`src/lib/response-healing.ts` / `test/response-healing.test.ts` / `healMalformedJson`, which no
longer exist in the committed tree; per AGENTS.md, rollout notes must record exact touched paths
and commands actually run. See also
`docs/rollouts/2026-07-17-jsonrepair-fail-closed-boundaries.md` for the fail-closed redesign.)_

**Summary:**
Replaced LLM-based response healing with purely local, deterministic repair using the
`jsonrepair` package, implemented inside `extractJsonPayload` (`src/lib/llm-call.ts`) as an
OPT-IN per call site (`extractJsonPayload(text, { repair: true })`, default strict).

**Why:**
The previous attempt used an unprompted, hardcoded fallback LLM call (`gemini-2.5-flash`) to
repair malformed JSON, violating the owner's preference that fallback models strictly follow
user settings and never be invoked silently for syntax repair deterministic code can do. A
first cut applied jsonrepair globally to every parse site; Codex review showed that converts
fail-closed safety gates into fail-open (a truncated `{"verdict":"approve"` repairs into a
valid approval), so repair became opt-in: the Bull proposal path opts in behind a
schema-completeness gate (`filterRepairedProposals`, `src/lib/strategy.ts`); Red Team,
proposal-revalidation, and tuning parse strictly and stay fail-closed.

**Files Changed:**
- `package.json`, `package-lock.json`: added the `jsonrepair` dependency.
- `src/lib/llm-call.ts`: `extractJsonPayload` gained the opt-in `repair` option (local
  jsonrepair; never fabricates on unrepairable input).
- `src/lib/strategy.ts`: Bull parse site — strict first, repair retry gated by
  `filterRepairedProposals` (key presence + identity/enum/judgment/numeric-null type checks,
  shared `BULL_PROPOSAL_REQUIRED_KEYS` with the schema literal).
- `src/lib/red-team.ts`: strict parse (no repair) + multiple-verdict ambiguity guard with
  \uXXXX escape normalization.
- `src/lib/proposal-revalidation.ts`, `src/lib/strategy-tuning.ts`: strict parse, intent
  documented at the call sites.
- `test/llm-call-json-payload.test.ts`, `test/red-team.test.ts`,
  `test/strategy-hardening.test.ts`: regression coverage for all of the above.

**Verification (commands actually run):**
- `npx tsc --noEmit` — clean.
- `npx vitest run test/llm-call-json-payload.test.ts test/red-team.test.ts test/redteam-failure-routing.test.ts` — green.
- `npx vitest run test/strategy-hardening.test.ts` — green.
- Full `npm test`, `npm run build`, `npm run lint` — green before each push.

**Follow-ups:**
- Monitor `strategy_bull_repaired_partial_dropped` audit rows in production to see how often
  repair recovers usable proposals vs. drops truncation artifacts.
