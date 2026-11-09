# Codex autofix: STATUS.md and EFFORT-LOG.md corrections

## Summary

Addressed two Codex PR review threads on PR #1468:
1. **EFFORT-LOG.md**: Moved "Native iOS App Overhaul" from "## Completed" to "## 🚧 In Progress" section (it was marked IN PROGRESS but in the wrong section). Also removed a duplicate entry under a second "## Completed" section.
2. **STATUS.md**: Corrected inaccurate claims that `AuthenticationView`, `ASWebAuthenticationSession`, and `/api/mobile/auth-redirect` existed. Replaced with honest description of what was actually implemented (`ios/` scaffold, `MobileStore`, `MobileAPIClient`, tabbed views) and noted auth pieces are still pending on `agent/antigravity`.

## Files

- `STATUS.md` — fixed iOS auth claim
- `docs/EFFORT-LOG.md` — moved iOS entry to In Progress, removed duplicate

## Verification

- `npm run lint`: 0 errors, 404 warnings (clean)
- `npx tsc --noEmit`: clean
- `npm test`: 346 files / 3846 tests passed
- `npm run build`: clean

## Decisions

- Corrected STATUS.md to match actual code in tree rather than leaving aspirational claims that don't match any branch.
- Removed duplicate iOS entry from second "## Completed" section to avoid confusion.
- Did not change the STATUS.md header or other section contents — only the specific line flagged by Codex.

## Follow-up

- Pre-existing 404 lint warnings untouched (grandfathered backlog).
