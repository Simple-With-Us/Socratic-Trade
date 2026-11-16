# CI PR Merge Blocker Fix: Gitleaks & Mock Hydration (2026-07-28)

## 1. Context & Objective
- The user requested diagnosing why pull requests were not merging despite auto-merge being armed.
- Detailed inspection of GitHub Action run logs revealed two distinct root causes blocking CI checks and preventing PR merges across the repository:
  1. `gitleaks` required check was failing in `security.yml` with `Error: Destination file path /tmp/gitleaks.tmp already exists` due to stale temp files left on the self-hosted Linux CI runner.
  2. `verify-hosted` (`npm test`) timed out on `test/milestone-4-challenger.test.ts` due to `[durable-state] hydration failed: No "getDb" export is defined on the "../src/lib/db" mock`.

## 2. Changes Made
- **`.github/workflows/security.yml`**:
  - Added a pre-step `Clean stale temp gitleaks files` (`rm -rf /tmp/gitleaks.tmp /tmp/gitleaks* /tmp/gitleaks-*`) before `gitleaks-action` so self-hosted runner temp collisions cannot crash `gitleaks`.
- **`test/milestone-4-challenger.test.ts`**:
  - Added `getDb: vi.fn()` to `vi.mock("../src/lib/db")` to eliminate mock hydration errors during test execution.

## 3. Verification State
- `npm run lint` — 0 errors.
- `npx tsc --noEmit` — 0 type errors.
- `npm test` — All tests in `milestone-4-challenger.test.ts` passed cleanly without mock hydration errors.

## 4. Touched Files
- `.github/workflows/security.yml`
- `test/milestone-4-challenger.test.ts`
- `docs/rollouts/2026-07-28-ci-pr-merge-blocker-gitleaks-and-mock-hydration-fix.md`
