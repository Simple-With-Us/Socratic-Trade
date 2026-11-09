# 2026-06-25 — Harden `gcp-secrets-run.mjs` to fail open on any credential error

## Summary

The `*:gcp` wrapper's "fails open" promise was incomplete: a Secret Manager
credential error could crash the wrapper (uncaught, exit 1) instead of logging
and running the command with the existing environment. Confirmed for three real
failure modes on the prior (post-#154) script — all exited 1 with an uncaught
stack:

- missing/invalid `GOOGLE_APPLICATION_CREDENTIALS` *file path* (sync `realpathSync` throw),
- no ADC at all (`_getCredentials` / `createStub` rejection),
- malformed JSON key file.

Added a process-level fail-open guard: `process.on("uncaughtException")` and
`process.on("unhandledRejection")` both funnel to a `failOpen()` that logs and
runs the command with the existing env. The command now runs via a single
idempotent `runCommand()` (a `started` flag prevents any double-spawn), and a
`child.on("error")` handler turns command-not-found into a clean exit 1 instead
of an uncaught throw. The wrapper always propagates the child's exit code.

Builds on the #154 premature-exit fix and resolves the "(Exception …)" caveat
that #154 added to `docs/deployment.md`.

## Why

Surfaced during #154 review/testing. The docs claimed the wrapper "fails open,"
but common misconfigurations crashed it — so a production restart via
`start:gcp` could fail outright on a creds problem rather than degrading to the
existing environment. Low blast radius today (prod deploys use plain
`npm run build` + `pm2 restart trading`, not the `*:gcp` variants), but the
wrapper's whole contract is "inject if possible, otherwise run anyway."

## Files

- `scripts/gcp-secrets-run.mjs` — process-level `uncaughtException` /
  `unhandledRejection` fail-open guard; idempotent single `runCommand()` with a
  `started` flag; `child.on("error")` for command-not-found; header comment now
  documents the fail-open contract.
- `docs/deployment.md` — "Fails open" bullet updated (removed the
  missing-creds-path exception; notes the process-level guard).
- `STATUS.md`, `PLAN.md`, this rollout note — handoff trail.

## Verification

Direct runtime tests (each runs a child that prints a marker and exits a known
code; asserted the exit code and the absence of any `Node.js vNN` / stack-frame
crash output):

```
T1 no-project, child exit 7              → exit 7, clean         (premature-exit fix intact)
T2 missing GOOGLE_APPLICATION_CREDENTIALS path, child exit 5
                                          → exit 5, clean         (was: exit 1 CRASH)
T3 no ADC at all, child exit 0           → exit 0, clean         (was: exit 1 CRASH)
T4 malformed JSON key file, child exit 0 → exit 0, clean         (was: exit 1 CRASH)
T5 command not found                     → exit 1, clean handled  (no uncaught stack)
```

Trio (latest `main` + change): `npm ci` ✓, `npm run build` ✓, `npx tsc --noEmit`
✓ clean, `npm test` → **1198/1198 all pass**. (Standalone `.mjs`, not imported by the app,
so the trio is structurally unaffected; run for regression against current
`main`.)

## Follow-ups

- None outstanding for this script. The `*:gcp` wrappers remain optional and are
  not yet wired into the production deploy path (`deploy.yml` uses plain
  `npm run build` + `pm2 restart trading`).
