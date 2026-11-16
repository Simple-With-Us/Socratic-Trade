# Deterministic ORDER BY tiebreaker for socratic-db readers (CI flake fix)

## Summary
`test/socratic-db.test.ts > "persists decision cases, coach notes, and framework proposal status"`
failed intermittently (~2 of 3 runs) with a UUID mismatch on a `listSocraticFrameworkProposals(...)[0]`
assertion. Root cause: three readers in `src/lib/db-socratic.ts` ordered by `created_at` alone. When
two rows are inserted within the same millisecond (routine in a fast test), SQLite returns
equal-`created_at` rows in an unspecified order, so `[0]` (and any `LIMIT`-bounded slice) flipped
nondeterministically. Fixed by adding `rowid` as a deterministic, insertion-ordered tiebreaker to all
three queries. Behavior is unchanged for distinct timestamps; only the previously-undefined
equal-timestamp order is now stable (later-inserted first for DESC, earlier-inserted first for ASC).

## Why
This is a required-`verify`-check flake that intermittently blocks merge on **every** open PR in the
repo, not just changes near this code — a fleet-wide coordination tax. A total-order sort key removes
the nondeterminism at the source rather than papering over it in the test.

## Files
- `src/lib/db-socratic.ts`
  - `listSocraticDecisionCases` — `ORDER BY created_at DESC` → `ORDER BY created_at DESC, rowid DESC`
  - `listSocraticDecisionCasesNeedingOutcome` — `ORDER BY created_at ASC` → `ORDER BY created_at ASC, rowid ASC`
  - `listSocraticFrameworkProposals` — `ORDER BY created_at DESC` → `ORDER BY created_at DESC, rowid DESC`
- `docs/rollouts/2026-07-06-socratic-db-ordering-flake.md` (this note)

## Verification
- `npx vitest run test/socratic-db.test.ts` run **12×** consecutively → 12/12 pass (was ~1/3 before).
- `npx tsc --noEmit` clean.
- `npm run lint` → 0 errors (pre-existing warnings only).
- `npm test -- --run` (full suite) → 2673/2673 pass, run twice, both green.

## Follow-ups
- Other readers in the codebase that `ORDER BY created_at`/timestamp without a tiebreaker may carry the
  same latent nondeterminism; not swept here to keep this fix minimal and focused. A repo-wide audit for
  tiebreaker-less `ORDER BY` on timestamp columns would be a reasonable ops follow-up.
