# 2026-07-17 — Consolidate model-ID canonicalizers into one shared helper (MONET)

## Summary

Merged the two duplicated model-ID canonicalization functions now on main into a single shared
`src/lib/model-identity.ts` (`canonicalModelId`). Behavior-preserving.

## Why

The OpenRouter model-identity work landed two copies of the same logic:
- `cleanModelId` in `src/lib/model-stats.ts` (AG, via #1703) — canonicalizes the benchmark/perf
  rollup keys.
- `canonicalModelId` in `app/admin/llm-usage/model-merge.ts` (via #1716) — canonicalizes the
  Usage cost-page "By model" merge.

Two definitions of the same concept invite drift — a Codex reviewer flagged the semantics on one
of them. This was the deferred follow-up noted in
`docs/rollouts/2026-07-17-usage-canonical-model-merge.md`, done now (owner-directed, while AG was
capped).

## What

- New `src/lib/model-identity.ts` exporting `canonicalModelId` — **AG's verified `cleanModelId`
  logic verbatim** (last `/` segment, case-preserving, `""` for null), so nothing about the
  benchmark stats changes.
- `src/lib/model-stats.ts`: deleted its local `cleanModelId`, added
  `import { canonicalModelId as cleanModelId } from "./model-identity"` — all call sites
  unchanged, zero behavior delta (`model-stats`/`performance` tests pass untouched).
- `app/admin/llm-usage/model-merge.ts`: imports `canonicalModelId` from the shared module,
  re-exports it, and `displayModelName = canonicalModelId` (same bare-name derivation). Dropped
  its local `stripRoutingPrefix`/`canonicalModelId`/`displayModelName`. The cost page's null
  bucket key moved from `"unknown"` to `""` accordingly (`llm-usage-client.tsx`).
- The catalog vendor-uniqueness assumption (and the future hardening — strip only known vendor
  prefixes if a cross-vendor bare-name collision ever appears) is documented in the shared module.

## Files

New: `src/lib/model-identity.ts`. Modified: `src/lib/model-stats.ts`,
`app/admin/llm-usage/model-merge.ts`, `app/admin/llm-usage/llm-usage-client.tsx`,
`test/usage-model-merge.test.ts`.

## Verification

`tsc --noEmit` clean; `model-stats` + `performance` + `usage-model-merge` = 67 tests pass
(benchmark behavior unchanged — the model-stats copy is an alias to identical logic); full
suite + `npm run build` via `scripts/land.sh`.

## 2026-07-18 CODEX review cleanup

- Merged latest `origin/main` into PR #1736 with no conflicts.
- Verified the author-identity review thread is stale: the current PR commit author email is
  `12656028+jaywedgeworth22@users.noreply.github.com`.
- Restored case-insensitive aggregation by using a lowercase internal merge key while preserving
  the first case-preserved canonical/display ID for the UI.
- Added a regression test for case-only model rows.

Verification: `npm test -- test/usage-model-merge.test.ts` (9/9 pass).
