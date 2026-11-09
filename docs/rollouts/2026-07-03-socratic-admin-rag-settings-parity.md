# 2026-07-03 - Socratic admin/RAG/settings parity pass

## Summary

This Codex branch broadens the Socratic Trade console parity pass after the
owner's production-domain, Pinecone/RAG, model-control, settings, ticker-drawer,
and old-vs-new audit feedback.

Implemented so far:

- Created and documented the branch-neutral effort board at
  `/Users/jay/apps/TRADING-EFFORT-LOG.md`; `docs/EFFORT-LOG.md` remains the
  tracked mirror.
- Pointed the app's default Pinecone index to `socratic-trade` and added RAG
  ingest brakes for Voyage/Pinecone writes.
- Added source-aware Pinecone/Voyage/Voyage-rerank health logging and surfaced
  vector-store config/errors/last-ingest state on admin RAG coverage.
- Expanded admin connection-health lanes to include missing backend dependencies.
- Added user-scoped `/api/llm-usage` and `/console/usage`; admin usage remains
  all-user/operator scoped.
- Added `/old` legacy-dashboard route and routed `/` to `/console`.
- Corrected Robinhood callback routing to `/console/settings`.
- Canonicalized stale `trading.jays.services` Auth.js env values to
  `https://socratictrade.com` before Google/GitHub redirects are built.
- Restored ticker drilldowns as a shared right-side drawer and wired many ticker
  surfaces to open it.
- Reframed the Home live thesis as a market thesis with ticker-specific actions
  treated as the current expression.
- Reframed Coach away from a generic assistant entry point toward thesis
  critique, refocus, memory, evidence, framework improvement, and draft-to-
  Approvals prompts.
- Replaced raw Strategy Green/Red model text boxes with curated dropdowns.
- Added provider-specific reasoning/thinking controls for OpenAI, Anthropic,
  Gemini, xAI, and Mistral, including runtime request shaping and AI Review
  temporary model controls.
- Replaced confusing visible loose/tight wording with lock/unlock authority
  language and converted the first cap pairs to absolute-vs-percent mode
  switches.
- Added `docs/reviews/2026-07-03-console-parity-open-items.md` as the durable
  list of fixed, incomplete, and still-needed console parity items.

## Why

The owner wants Socratic Trade to feel like a professional autonomous market
reasoning console, not a renamed copy of the old dashboard. The new UI also
needs operational transparency: provider failures, RAG quota issues, model
control differences, and user-vs-admin cost views should be visible in the right
place instead of buried in activity logs.

## Files touched

Major areas:

- `.env.example`
- `AGENTS.md`
- `STATUS.md`
- `PLAN.md`
- `app/page.tsx`
- `app/old/page.tsx`
- `app/api/auth/robinhood/callback/route.ts`
- `app/api/admin/connections-health/route.ts`
- `app/api/admin/rag-coverage/route.ts`
- `app/api/llm-usage/route.ts`
- `app/api/policy/route.ts`
- `app/api/strategy/tune/route.ts`
- `app/admin/llm-usage/llm-usage-client.tsx`
- `app/admin/rag-coverage/rag-coverage-client.tsx`
- `app/console/**`
- `docs/EFFORT-LOG.md`
- `docs/prod-config-voyage.md`
- `docs/reviews/2026-07-03-console-parity-open-items.md`
- `src/lib/auth/auth.ts`
- `src/lib/llm-call.ts`
- `src/lib/llm-request.ts`
- `src/lib/llm-usage.ts`
- `src/lib/public-origin.ts`
- `src/lib/types.ts`
- `src/lib/vector-db.ts`
- `src/lib/web-sources/disclosure-rag.ts`
- `src/lib/web-sources/sec-filings.ts`
- `src/lib/web-sources/sec8k.ts`
- `test/auth-url-canonicalization.test.ts`
- `test/llm-call.test.ts`
- `test/llm-request.test.ts`
- vector/RAG tests updated for new index/default budget behavior.

Outside this worktree:

- `/Users/jay/apps/TRADING-EFFORT-LOG.md`
- `/Users/jay/apps/README.md`
- `/Users/jay/Code/Agentic Trading/AGENTS.md`
- `/Users/jay/Code/Agentic Trading/docs/EFFORT-LOG.md`

## Verification so far

- `npx vitest run test/vector-db.test.ts test/vector-db-scope.test.ts test/vector-db-backlog-c-integration.test.ts test/vector-db-embedding-integrity.test.ts test/vector-db-chunk-cap.test.ts test/query-embedding-cache.test.ts` - passed.
- `npx vitest run test/rag-retrieval-eval.test.ts test/milestone-4-challenger.test.ts test/sec-filings.test.ts test/disclosure-rag.test.ts test/vector-db-hybrid.test.ts test/vector-db-asof-strict.test.ts test/vector-db-rerank-floor.test.ts` - passed.
- `npx vitest run test/console-policy-diff.test.ts test/guardrails-essentials.test.ts test/policy-normalization.test.ts` - passed.
- `npx vitest run test/llm-request.test.ts test/llm-call.test.ts test/policy-notification-events.test.ts test/strategy-tuning.test.ts test/red-team.test.ts` - passed.
- `npx vitest run test/auth-url-canonicalization.test.ts test/logout-route.test.ts test/mcp-oauth.test.ts` - passed.
- `npx tsc --noEmit` - passed after the provider-control, auth, Home, and Coach updates.
- `npm run lint` - passed with 0 errors and the existing warn-only backlog.
- First `npm test` run failed on stale `describeUsageKey` wording expectations
  (`operator`/`operator env`), after the branch intentionally relabeled those as
  `primary user`/`server failover`; assertions were updated.
- `npm test` - passed after updating those expected labels: 244 files, 2369 tests.
- `npx tsc --noEmit && npm run build` - passed.
- `pm2 restart trading-codex --update-env` - passed after build regenerated
  `.next`.
- Route probes on `http://localhost:4101`:
  - unauthenticated `/console`, `/old`, `/console/strategy`, `/console/assistant`,
    and `/console/usage` redirect to `/login`.
  - with `cf-access-authenticated-user-email: mail@jays.services`, `/console`,
    `/old`, and `/console/strategy` return 200.
- GitHub PR smoke initially failed because `test/e2e/dashboard-smoke.spec.ts`
  still asserted the old Home text `Market Scan`; the Socratic Home now labels
  that panel `Evidence and RAG contribution`. Updated the assertion.
- `npm run test:e2e` - passed locally after that assertion update.

## Follow-ups / remaining risk

- `admin.socratictrade.com` is not implemented yet.
- Universal tooltips are not proven complete.
- Remaining absolute-vs-percent pairs need the same mode-switch treatment.
- Scan column customization parity remains open.
- Provider failure emails/user notifications need failure-injection verification.
- Production must be observed after switching to `socratic-trade` to confirm RAG
  ingest budgets and dedupe behavior under real scheduler cadence.
- See `docs/reviews/2026-07-03-console-parity-open-items.md` for the full open
  list.
