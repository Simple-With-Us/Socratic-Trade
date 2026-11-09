# Congress Score Eval UI Wiring

- **Summary:** Added the UI to surface the `congressScoreVerdict` in the Market Scan tab of the console dashboard. This completes the "Wire congress-score-eval go/no-go into scan/scoring" feature which was previously lacking the UI representation.
- **Why:** The backend statistical validation for the congressional trading signal (go/no-go) was implemented and actively gating the composite (when enabled), but the verdict and gating status were invisible to the user in the UI. We now explicitly display the validation status, t-stat, and whether the signal is currently gated.
- **Files:**
  - `app/dashboard-types.ts`
  - `app/console/scan/page.tsx`
- **Verification:** Ran `npm run lint`, `npx tsc --noEmit`, `npm test`, and `npm run build`. All passed successfully.
- **Follow-ups:** None.

## Review follow-up (2026-07-08, PR #971 Copilot threads)

- **Summary:** Addressed all five Copilot review threads on PR #971 and merged
  `origin/main` (branch was 48 commits behind).
- **Fixes:**
  - **Runtime bug (blocking):** `ScanPage` read `snapshot.congressScoreVerdict`,
    but the server payload nests the verdict under
    `snapshot.smartMoney.congressScoreVerdict` (`src/lib/dashboard.ts`), so the
    validation card never rendered. Now reads `snapshot.smartMoney?.congressScoreVerdict`
    and the type was moved into the `smartMoney` object in `app/dashboard-types.ts`
    (removed the mismatched root-level declaration) so type and payload agree.
  - **Typing:** `congressScoreVerdict?: any` → `CongressScoreVerdictRead | null`
    (type-only import — erased, so no server-only module is pulled into the client
    bundle). Chip tone hoisted to a typed `ChipTone` variable.
  - **INSUFFICIENT is neutral:** the verdict chip now renders `INSUFFICIENT` with a
    muted tone (was `warn`); `warn` is reserved for `FAIL_SIGNIFICANCE`, `pos` for
    `PASS` — matching `classifyCongressVerdict`.
  - **Gating label accuracy:** the label/tooltip now reflect the *effective* state
    (`Off` / `Enabled` (fail-open or stale) / `Zeroing`) instead of just echoing the
    policy flag, matching `congressGateMultiplier` (only a fresh `FAIL_SIGNIFICANCE`
    zeroes the congress term).
- **Files:** `app/console/scan/page.tsx`, `app/dashboard-types.ts`,
  `docs/EFFORT-LOG.md`, `docs/rollouts/2026-07-06-congress-score-eval-wiring.md`.
- **Verification:** Type-checked by inspection; no `node_modules` in the review
  worktree, so the `verify` CI gate (tsc → vitest → build) is authoritative.
- **Follow-ups:** None — verdict card is data-driven; when no verdict is cached the
  server sends `null` and the card is hidden.
