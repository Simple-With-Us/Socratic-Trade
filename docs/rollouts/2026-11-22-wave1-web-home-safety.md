# Rollout: Wave 1 Web Console Home Safety Fixes (ST-4648)

## 1. Context & Objective
Resolves critical live execution safety and cross-proposal data leakage defects on the Web Console Home dashboard (`/console`).  Prior to this change, proposal detail drawers cross-contaminated proposal evidence (falling back to Proposal #0's model attribution and Red Team critique), and live order confirmation auto-executed real-money broker orders purely on `onChange` without requiring an explicit button click.

## 2. Changes Made
- **Evidence Cross-Contamination Fix**: Passed `proposal` into `deriveEvidenceRows(snapshot, latest, decision, proposal)` in `app/console/page.tsx` and extracted pure evidence helpers into `app/console/lib/evidence-rows.ts`, preventing proposals #2..#N from erroneously inheriting proposal #0's model attribution and adversarial review verdict.
- **Typed Confirmation & Real-Money Safety**: Removed the dangerous `onChange` auto-fire execution (`if (e.target.value === liveConfirm) { handleApprove(); }`) and the permanently disabled Approve button in `ProposalRow`.  Integrated `<TypedConfirm>` with paste prevention, autocomplete suppression, explicit Submit button activation only upon matching the exact confirmation phrase, synchronous re-entrancy locking (`lock()` / `unlock()` via ref / closure) to prevent double executions on rapid double-clicking, and state reset on completion and dialog dismissal.
- **Proposal Rejection on Home**: Added a first-class `Reject` button alongside Approve in `ProposalRow`'s detail sheet, wiring it to `rejectProposal(id)` with loading state, error toasts, and cache refresh matching `approval-card.tsx`.
- **Regression Test Coverage**: Extended `test/console-evidence-rows.test.ts` to assert independent model attribution and red-team critique per proposal row.  Added `test/console-home-proposal-confirm.test.tsx` verifying paste prevention, non-auto-fire typing safety, explicit confirm execution, reject behavior, synchronous re-entrancy prevention on concurrent clicks, mock restoration safety (`afterEach` and `try/finally`), and graceful error handling.

Touched files:
- `app/console/lib/evidence-rows.ts`
- `app/console/page.tsx`
- `test/console-evidence-rows.test.ts`
- `test/console-home-proposal-confirm.test.tsx`
- `STATUS.md`
- `docs/rollouts/2026-11-22-wave1-web-home-safety.md`

## 3. Decisions & Trade-offs
- Extracted `deriveEvidenceRows` and associated quote evidence formatters into `app/console/lib/evidence-rows.ts` rather than keeping private in `page.tsx` to ensure unit testability without importing whole client page trees.
- Maintained backwards-compatible fallback to proposal #0 in `deriveEvidenceRows` when the 4th `proposal` argument is omitted.
- Used `createProposalRowHandlers` to keep `ProposalRow` action logic pure, decoupled, and directly testable under Vitest.

## 4. Verification State
Verification commands run in `<install-path>`:
- `npm run lint`: Clean (`0 errors, 905 warnings`).
- `npx tsc --noEmit`: Clean (`0 errors`).
- `npx vitest run test/console-evidence-rows.test.ts test/console-home-proposal-confirm.test.tsx test/console-approval-honesty.test.ts`: `24/24` passed across 3 files.
- `npm test`: `947` test files passed (`10,886` passed, `42` skipped; the 1 local failure in `test/cpuprofile-summary.test.ts` is the pre-existing local Node v22.22.1 vs CI Node 24 child-process `.ts` import difference).
- `npm run build`: Production Next.js build succeeds cleanly.

## 5. Next Steps & Blockers
- No blockers.  Branch `ag/wave1-web-home-safety` is ready for review and integration into the Wave 1 release train.
