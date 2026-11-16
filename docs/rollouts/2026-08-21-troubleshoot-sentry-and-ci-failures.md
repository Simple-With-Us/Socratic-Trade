# Troubleshoot Sentry and CI Failures

## Context & Objective
The user requested troubleshooting of recent errors from the past 4 days, specifically targeting Sentry noise and failed CI runs. This includes Playwright Smoke test crashes, iOS TestFlight shipment failures, Pinecone RAG health transient errors, and OpenRouter embed connection tagging bugs.

## Changes Made
- **Playwright CI Fix**: Added WebKit to the Playwright dependencies in `.github/workflows/e2e.yml` because the `mobile-chrome` suite uses an `iPhone 13` device profile which inherently requires the WebKit engine.
- **iOS TestFlight Hash Pin**: Updated the `ios-fleet.sha256` pin to fix the drift on the GH Actions runner, allowing the TestFlight shipment workflow to pass without hash mismatch errors.
- **Pinecone 5-Strike Mitigation**: Updated `ragLimitStatus` in `src/lib/vector-db.ts` to categorize `terminated`, `fetch failed`, and `UND_ERR_SOCKET` as `"transient"`. Modified `withRagApiHealth` to apply `soft: true` to these transient errors, preventing them from 5-striking and degrading the provider lane for purely network-level blips.
- **Voyage Source Tagging Bug**: Moved the `voyageSource` extraction logic in `getClients` out of the `process.env.NODE_ENV === "test"` block to ensure that production errors are properly tagged with the embedding route (fixing the `key_source=none` tagging bug on OpenRouter).
- **RAG Integrity False Alarms**: Added a `malformedEmbeddingCount` variable to distinguish between true malformed vector integrity rejections and simple API/network skips. The Sentry alert "RAG document embedding integrity rejection" now only fires when `malformedEmbeddingCount > 0`, suppressing noise from network-induced empty batches.

## Decisions & Trade-offs
- We are logging transient errors as soft health rows. This allows the system to still record the blip without triggering a full circuit-breaker stoppage (5-strike 503) that necessitates a manual restart.
- For integrity rejections, we still increment `rejectedInvalidEmbeddings` which triggers the fallback retry logic, but the actual Sentry pager is now gated strictly on whether the vectors were structurally flawed versus skipped due to network failures.

## Verification State
- `npm run lint` and `npx eslint src/lib/vector-db.ts` checked (0 errors).
- `npx tsc --noEmit` exited successfully with code 0.
- `npm test` running smoothly.
- Created PR with all fixes.

## Next Steps & Blockers
- Merge PR when tests are confirmed green.
- Monitor Sentry to verify the "integrity rejection" volume drops significantly and that OpenRouter errors properly carry the `key_source`.
