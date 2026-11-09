# Rollout: UX PR-A3 first-run readiness checklist hero

## Context & Objective

Wave A P0 from `docs/design/ux-improvement-program.md` §PR-A3: empty Thesis still
felt like broken cards, not a path. Goal: one honest checklist derived only from real
snapshot fields, with one CTA per unfinished step. (Companion short note also at
`docs/rollouts/2026-08-04-ux-a3-checklist.md` from the feature commit.)

## Changes Made

- Exported `deriveReadinessChecklist` (+ `ReadinessStep` / `ReadinessChecklist`
  types) from `app/console/lib/derive.ts` with five canonical steps and flat
  `flags` for tests / future iOS PR-D2 parity.
- New `app/console/components/readiness-checklist.tsx` (pattern:
  `needs-attention.tsx`): incomplete → dominant "Get ready to trade" hero;
  complete → collapsed non-dominant "You're set" (dismissible).
- Wired hero at the top of Thesis (`app/console/page.tsx`).
- Unit tests: `test/console-readiness-checklist.test.ts` (7 cases — no false
  ready when broker/universe/LLM incomplete).

### Touched files

- `app/console/lib/derive.ts`
- `app/console/components/readiness-checklist.tsx` (new)
- `app/console/page.tsx`
- `test/console-readiness-checklist.test.ts` (new)
- `docs/rollouts/2026-08-04-ux-a3-checklist.md`
- `docs/rollouts/2026-08-04-ux-a3-first-run-checklist.md` (this file)
- `docs/EFFORT-LOG.md`, `STATUS.md`

## Readiness field map (snapshot → step)

| Step id | Complete when | Primary snapshot fields | Incomplete CTA |
|---------|---------------|-------------------------|----------------|
| `connect-broker` | ≥1 connected account | `connectedAccounts.length` | `/console/connections#brokers` |
| `active-account` | active row or policy selection | `connectedAccounts[].isActive`, `policy.connectedAccountId`, `policy.accountNumber` | `/console/connections#brokers` |
| `universe` | index and/or extras | `policy.includedIndices`, `policy.additionalSymbols` | `/console/guardrails` (Universe advanced group) |
| `llm` | key present **and** Green model set | `llmConfigured !== false`, `policy.llmModel` (trim non-empty) | keys → `/console/connections#api-keys`; model → `/console/strategy#models` |
| `run-once` | any run/proposal on record | `latestStrategyRun`, `strategyRuns`, `pendingProposals`, `recentProposals` | `/console/approvals` (Proposals) |

`ready === true` only when all five steps complete. `llmConfigured` omitted
(legacy payloads) does **not** count as missing key — only explicit `false`.

## Decisions & Trade-offs

- Universe lives under Guardrails Advanced (not Strategy) — CTA matches the
  real editor surface.
- "Green model" = Green **team** model (`policy.llmModel`), not a traffic-light
  health color.
- Ready state collapses to "You're set" rather than hard-hiding; dismiss is
  session-local React state only.
- Did not change `deriveAttention` setup items (still useful inbox noise);
  checklist is the Thesis-dominant path.

## Verification State

```bash
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
./node_modules/.bin/eslint app/console/lib/derive.ts app/console/page.tsx \
  app/console/components/readiness-checklist.tsx \
  test/console-readiness-checklist.test.ts
# → 0 errors (pre-existing warnings only)
./node_modules/.bin/vitest run test/console-readiness-checklist.test.ts
# → 7/7 passed
# Full tsc deferred to CI verify (host load averages 40–120 with fleet agents)
```

## Next Steps & Blockers

- PR #2417 auto-merge when `verify-hosted` green.
- iOS Home checklist (PR-D2) can re-use `flags` semantics from this derivation.
