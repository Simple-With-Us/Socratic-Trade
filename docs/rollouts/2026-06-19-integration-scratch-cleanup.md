# 2026-06-19 - Integration Scratch Cleanup

## Summary

Added root-only ignore rules for disposable manual-debug artifacts that had
accumulated in the `main` integration checkout: screenshot PNGs, one-off UI probe
scripts, and an accidental SQL-named shell output file.

## Why

The integration checkout should stay clean enough for review and fast-forward
merges. These files were local verification byproducts, not source, tests, docs, or
assets the app needs.

## Files

- `.gitignore`
- `PLAN.md`
- `STATUS.md`
- `docs/rollouts/2026-06-19-integration-scratch-cleanup.md`

## Verification

- `git status --short --branch --untracked-files=all` in
  `/Users/jay/Code/Agentic Trading` showed only the disposable
  scratch artifacts before the ignore rule.
- `ls -l "SELECT value FROM store WHERE key = \"policy_jay\"" screenshot*.png
  test-run.ts test-ui.cjs test-ui.js` classified the files and sizes.
- `file "SELECT value FROM store WHERE key = \"policy_jay\"" screenshot*.png
  test-run.ts test-ui.cjs test-ui.js` confirmed the file types.
- `sed -n '1,160p' test-run.ts`, `sed -n '1,160p' test-ui.cjs`, and
  `sed -n '1,180p' test-ui.js` confirmed the scripts were one-off local probes.
- `git diff --check` - passed.
- `npx tsc --noEmit` - passed.
- `npm test` - passed, 231 tests across 30 files.
- `pm2 stop trading-codex` - stopped the Codex dev preview before build checks.
- `npm run build` - initially failed during page-data collection with missing
  stale generated route artifacts under `.next/server/app/api/...`.
- `rm -rf .next && npm run build` - passed from a clean generated artifact tree.
- `pm2 restart trading-codex` - restarted the Codex dev preview.
- `curl -sS -I --max-time 30 http://127.0.0.1:4101/` - returned `HTTP/1.1 200 OK`.
- `curl -sS -I --max-time 30 http://127.0.0.1:4101/api/health` - returned
  `HTTP/1.1 200 OK`.
- After merging current `origin/main` into `agent/codex`, resolved the `STATUS.md`
  Active Focus conflict by preserving both agents' entries.
- Post-merge `npx tsc --noEmit` - passed.
- Post-merge `npm test` - passed, 233 tests across 30 files.
- Post-merge `pm2 stop trading-codex && rm -rf .next && npm run build` - passed.

## Follow-ups

- Keep generated screenshots and local probe scripts under `scratch/` when they
  are worth retaining temporarily.
- If a screenshot or browser probe should become durable evidence, place it under
  a deliberate docs or test fixture path and do not rely on root-level scratch
  names.
