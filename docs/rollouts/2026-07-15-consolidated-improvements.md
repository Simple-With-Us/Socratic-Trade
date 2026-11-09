# Rollout: 2026-07-15 Consolidated Improvements & Codex Feedbacks

## Summary
Reconciled and consolidated all outstanding feature improvements and bug fixes from separate unmerged branches onto `main` under a single clean baseline. Addressed all 6 Codex P2 review comments on the FMP transcript RAG implementation, resolved the strict browser tab title requirements, and ported fixes for Red Team fallback sizing and SEC Ingest Task validation.

## Why
1. **FMP Stable APIs & Hardening**: Old `/api/v3/` and `/api/v4/` endpoints are restricted. Raw fetches also logged query keys on failure.
2. **Codex PR #1611 Review Feedback**:
   - Sanitize log outputs to keep raw transcript bodies out of system logs.
   - Set `process.exitCode = 1` on verification script failures so CI/CD processes detect errors.
   - Accept/parse `fiscalYear` and `fiscalQuarter` field aliases during transcript body parsing.
   - Map HTTP `403` to `"endpoint_not_entitled"` so the refresh job backs off instead of wasting API limits.
   - Expand `isTransientError` to recognize `"quota"`, `"reservation"`, and `"denied"` responses, avoiding caching partial rows on quota blocks.
   - Double Pinecone write budget estimates for managed commit tasks to prevent budget overruns.
3. **Browser Tab Title**: Ensure browser tabs consistently read exactly "Socratic Trade" by removing page title overrides.
4. **Strategy UI & SEC Ingest**: Pass correct scoped account IDs to save policies, fix model selection checkbox/focus race conditions, and add non-empty string validation to SEC Ingest fail tasks.

## Files Touched
- `src/lib/fmp-common.ts` [NEW]
- `src/lib/fmp-alpha.ts` [NEW]
- `src/lib/fmp-beta.ts` [NEW]
- `src/lib/fmp-delta.ts` [NEW]
- `src/lib/fmp-gamma.ts` [MODIFY]
- `scripts/test-fmp-integration.ts` [NEW]
- `src/lib/db.ts` [MODIFY]
- `src/lib/web-sources/fmp-transcripts.ts` [MODIFY]
- `src/lib/data-providers.ts` [MODIFY]
- `src/lib/vector-db.ts` [MODIFY]
- `app/console/layout.tsx` [MODIFY]
- `app/console/assistant/page.tsx` [MODIFY]
- `app/console/strategy/page.tsx` [MODIFY]
- `src/lib/red-team.ts` [MODIFY]
- `src/lib/db-rag-ingest.ts` [MODIFY]

## Verification
1. **Type Checks**: `npx tsc --noEmit` under Node 24 completed successfully with zero errors.
2. **Lint Checks**: `npm run lint` under Node 24 passed successfully with 0 errors.
3. **FMP Verification Script**: Executed `npx tsx scripts/test-fmp-integration.ts` under Node 24.
   - Verified that sample responses are correctly redacted.
   - Verified HTTP responses map to expected entitlement / transient states.
4. **Test Suite**: Run `npm test` under Node 24. Verified 4,365/4,365 tests passed successfully.
5. **Next.js Production Build**: `npm run build` completed successfully.
6. **PR Landing**: `scripts/land.sh` executed under Node 24 and successfully opened PR #1616.
