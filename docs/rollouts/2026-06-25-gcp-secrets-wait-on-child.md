# 2026-06-25 — Fix: `gcp-secrets-run.mjs` no-project fallback waits on the child

## Summary

Fixed a real bug in `scripts/gcp-secrets-run.mjs`: when `GCP_PROJECT_ID` was
unset, the wrapper spawned the child command and then called `process.exit(0)`
**immediately** — returning success before the child finished. So
`npm run build:gcp` (and any chained `build:gcp && <restart/deploy>`) could
report success while `next build` was still running. The configured (projectId
set) path was already correct.

Restructured so the command runs exactly once at the end, in BOTH paths, and
`runCommand`'s `child.on("exit", …)` handler owns process exit (waits +
propagates the child's exit code). Also dropped an unused `spawnSync` import.

Resolves the follow-up recorded in
`docs/rollouts/2026-06-25-env-local-source-of-truth-doc.md` and the "known bug"
caveat in `docs/deployment.md` (both updated to reflect the fix).

## Why

Surfaced by Codex review on PR #150 and confirmed by direct runtime testing.
Low blast radius today — production deploys use plain `npm run build` +
`pm2 restart trading`, not the `*:gcp` variants (see
`.github/workflows/deploy.yml`) — but the wrapper is the intended GCP-secret
delivery path, so a premature-success exit is a latent foot-gun for any chained
`build:gcp`/`start:gcp` usage.

## Files

- `scripts/gcp-secrets-run.mjs` — declare `injected` once; wrap the GCP fetch in
  `else { … }`; single tail `runCommand(command, injected)` for both paths; drop
  the unused `spawnSync` import; expand the explanatory comment.
- `docs/deployment.md` — updated the "When GCP is not configured" bullet (the
  premature-exit bug is fixed; the fallback now waits) and refined the "Fails
  open" bullet to note the missing/invalid `GOOGLE_APPLICATION_CREDENTIALS`
  *file path* case (currently crashes uncaught — separate follow-up).
- `STATUS.md`, `PLAN.md`, this rollout note — handoff trail.

## Verification

Tested the runtime behavior directly (not just types):

```
node --check scripts/gcp-secrets-run.mjs                        # parses (top-level await in else block OK)
# no GCP_PROJECT_ID, child sleeps 300ms then exits 7:
  → prints the child's output, EXIT=7   ✅ (old version returned EXIT=0 before the child finished)
# no GCP_PROJECT_ID, child exits 0:      → EXIT=0  ✅
# configured + bad GOOGLE_APPLICATION_CREDENTIALS path:
  → exits 1 uncaught — confirmed PRE-EXISTING (origin/main version crashes identically), not a regression
```

Trio on the fix branch (latest `main` + this change): `npm run build` ✓,
`npx tsc --noEmit` ✓ clean, `npm test` → **1189/1189 all pass** (the previously
date-flaky `cache-provenance` test passed on this branch). The script is a
standalone `.mjs` not imported by the app, so tsc/build/test are structurally
unaffected; run for regression against current `main`.

## Follow-ups

- **Make the configured path truly fail open (or fail closed deliberately):** a
  missing/invalid `GOOGLE_APPLICATION_CREDENTIALS` file path currently throws
  uncaught (exits non-zero) rather than logging and falling back to the existing
  environment. Pre-existing; out of scope for this focused fix.
- The `*:gcp` wrappers are still not wired into the production deploy path
  (`deploy.yml` uses plain `npm run build` + `pm2 restart trading`); unchanged.
