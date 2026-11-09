# 2026-06-21 — vector-db userId sanitization + timestamp parsing hardening

## Summary
Hardened `src/lib/vector-db.ts` RAG ingestion/retrieval:
- `getClients()` now sanitizes the `userId` (via `sanitizeUserId`) before
  resolving Pinecone/Voyage API keys, so key lookup and Pinecone filter
  `userId` use the **same** sanitized identity. Previously `getClients` used the
  raw `userId` for key resolution while filters used the sanitized form,
  creating an inconsistency for IDs containing spaces/special chars
  (e.g. `auth0|user 1`).
- `storeContexts()` and `retrieveContext()` now pass the sanitized id through to
  `getClients` and `audit(...)` consistently.
- `[Published: YYYY-MM-DD]` prefixing in `storeContexts` now handles `string`
  (ISO), `number` (epoch ms), and `Date` object timestamps, normalizing each to
  an ISO string before extracting the leading `YYYY-MM-DD`. Prior code only
  handled string-ish timestamps via `slice(0,10)`.
- Exported `retryAfterMs` so the Voyage backoff/jitter logic is unit-testable.

## Why
Inconsistent userId handling could split key-resolution identity from the
data-isolation filter identity, a multi-tenant correctness/security risk.
Timestamp prefixing silently dropped publication dates for numeric/Date inputs.

## Files
- `src/lib/vector-db.ts` — sanitize userId in `getClients`; thread sanitized id
  through `storeContexts`/`retrieveContext`/`audit`; robust timestamp parsing;
  `export retryAfterMs`.
- `test/vector-db.test.ts` — updated key-lookup expectation to sanitized id;
  added backoff-jitter distribution test and multi-type timestamp prefix test.
- `test/milestone-4-challenger.test.ts` — new challenger test file
  (vector-db + data-providers).

## Verification
- `npx tsc --noEmit` — clean (exit 0).
- `npm test` — NOT run in this environment. The Cowork Linux sandbox cannot run
  vitest against the host's macOS-installed `node_modules` (missing
  `@rolldown/binding-linux-arm64-gnu`); installing Linux binaries would corrupt
  the host install, so it was skipped. **Run `npm test` + `npm run build`
  locally before relying on these changes.**

## Follow-ups
- Run full `npm test` and `npm run build` locally to confirm the new tests pass
  and nothing else regressed.
