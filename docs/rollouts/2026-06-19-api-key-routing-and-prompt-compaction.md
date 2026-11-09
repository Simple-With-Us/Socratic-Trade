# 2026-06-19 - API key routing and prompt compaction

## Summary

- Added Settings -> API Keys for the default `local` user with provider status badges, docs links, masked write-only save, and clear controls.
- Expanded `/api/keys` into a source-aware provider catalog that distinguishes saved user keys, env fallback, and missing keys without returning secret values.
- Routed major provider and LLM paths through `resolveApiKey(service,userId)`.
- Tightened default-user scoping in strategy approval/audit/fill/snapshot paths where helper support already existed.
- Added first-pass Phase 10 prompt compaction by dropping neutral/empty candidate fields before sending scan candidates to the Bull/Bear prompts.

## Why

- Phase 11 needed real API-key management and provider routing instead of a hidden scaffolding table.
- Phase 10 prompt size is growing as more signals land; removing empty candidate fields is a low-risk first step before larger prompt-cache/layout work.
- The repo had concurrent Massive, MCP, and drilldown work in the worktree, so this pass stayed additive and avoided reverting or reshaping those edits.

## Files

- `app/api/keys/route.ts`
- `app/api/scan/route.ts`
- `app/api/history/route.ts`
- `app/api/market/flatfile/route.ts`
- `app/dashboard-client.tsx`
- `src/lib/db.ts`
- `src/lib/data-providers.ts`
- `src/lib/market.ts`
- `src/lib/types.ts`
- `src/lib/macro.ts`
- `src/lib/macro-history.ts`
- `src/lib/history.ts`
- `src/lib/market-signals/index.ts`
- `src/lib/market-signals/massive.ts`
- `src/lib/market-signals/massive-s3.ts`
- `src/lib/dashboard.ts`
- `src/lib/strategy.ts`
- `src/lib/strategy-tuning.ts`
- `src/lib/vector-db.ts`
- `src/lib/web-sources/http.ts`
- `src/lib/performance.ts`
- `src/lib/post-mortem.ts`
- `src/lib/red-team.ts`
- `test/persistence-notification.test.ts`
- `test/vector-db.test.ts`
- `docs/phase-10-signals-learning-ui-v2.md`
- `docs/phase-11-multi-user.md`
- `PLAN.md`
- `STATUS.md`

## Verification

- `npx tsc --noEmit` passed.
- `npx vitest run test/persistence-notification.test.ts test/vector-db.test.ts test/history.test.ts test/data-providers.test.ts test/alternative-data.test.ts` passed: 5 files, 36 tests.
- `npm test` passed: 28 files, 201 tests.
- `npm run build` passed: Next.js generated 12 static pages.

## Follow-ups

- Complete Phase 11 full user policy/data isolation, especially scorecard reads and scheduler fan-out.
- Add an end-to-end browser smoke for Settings -> API Keys after the concurrent dashboard edits settle.
- Continue Phase 10 D1/D2 with global delta-only candidate fields and a more cache-friendly stable prompt layout.
- Continue Phase 10 B3/B4 skipped-name counterfactual returns and factor-bucket learning.

## Blockers

- None.
