# Test Isolation & UI Sparkline Gradient Cleanup

## Context & Objective
Following the landing of PR #3040 for Sentry and CI troubleshooting, full test suite passes revealed a test flakiness issue where `test/api-keys-tombstone.test.ts` was not isolating its test SQLite database, causing leftover ciphertext from other test runs to trigger decryption failure warnings. In addition, SVG sparkline charts rendered in `ServerMetricsClient` shared a hardcoded linear gradient ID `chartGrad`, which caused React ID collision issues.

## Changes Made
- **Isolated SQLite DB for API Keys Tombstone Test**: Configured `process.env.DATABASE_URL` in `test/api-keys-tombstone.test.ts` with a per-file isolated temp DB path according to repo conventions (`agentic-api-keys-tombstone-${randomUUID()}.db`).
- **Environment Unstubbing Cleanup**: Added `afterAll` hook to `test/encryption-key-guard.test.ts` to ensure `vi.unstubAllEnvs()` and `vi.resetModules()` are executed on suite teardown so modified `ENCRYPTION_KEY` variables do not leak into downstream test suites.
- **Unique SVG Gradient IDs in Server Metrics Sparkline**: Replaced static `#chartGrad` with unique gradient IDs generated via `useId()` in `SparklineChart` within `app/admin/server/server-metrics-client.tsx`.

## Decisions & Trade-offs
- Standard per-file database isolation guarantees that sequential vitest runs in single-worker mode never observe credential table pollution from prior encryption tests.

## Verification State
- `npx vitest run test/encryption-key-guard.test.ts test/api-keys-tombstone.test.ts` (17 tests passed across 2 files).
- `npx eslint app/admin/server/server-metrics-client.tsx test/api-keys-tombstone.test.ts test/encryption-key-guard.test.ts` (0 errors).
- `npx tsc --noEmit` clean.

## Next Steps & Blockers
- Merge PR to main.
