# Rollout: Architecture Blueprint Realignment (2026-06-20)

## Summary
Updated the Unified Architectural Blueprint at `docs/architecture-blueprint.md` to incorporate the resolutions for edge cases, vulnerabilities, and code-blueprint discrepancies identified during system design reviews. The blueprint is explicitly marked as a target architecture, not a claim that the runtime already implements every control.

## Why
To ensure the architectural blueprint accurately documents proposed work for:
1. Tri-State Execution Model security gates, high-friction UI toggles, and safe fallback states.
2. Synthetic trailing stop-loss edge-case protections (corporate actions, outlier quotes, proximity polling, stale rows, and policy gates).
3. Taxation policy alignments (wash-sale lockouts on cross-account taxable/IRA boundaries) and DB column mappings.
4. SEC 8-K RAG ingestion safety controls (metadata sanitization, key routing, and exponential backoff).
5. Prompt compaction and caching structures (surcharges, static vs. dynamic splits, and abbreviations glossary).

## Files
- `.gitignore`
- `PLAN.md`
- `STATUS.md`
- `docs/architecture-blueprint.md`
- `docs/rollouts/2026-06-20-blueprint-realignment.md`

## Verification
Executed the project verification suite successfully:
1. TypeScript compile check:
   ```bash
   npx tsc --noEmit
   ```
   *Result*: Passed with no errors.
2. Focused Vitest unit tests:
   ```bash
   npm test
   ```
   *Result*: Passed all 252 tests.
3. Next.js production build:
   ```bash
   npm run build
   ```
   *Result*: Passed cleanly.

## Follow-ups
- Implement the blueprint incrementally. Highest-priority runtime slices are
  tri-state execution-mode derivation, live-action confirmation gates,
  synthetic trailing-stop persistence/loop, account tax type handling,
  multi-tenant RAG filters/backoff, and explicit LLM output/sampling caps.
- Keep `.agents/` local orchestration output untracked; durable findings belong
  in rollout notes and review docs.
