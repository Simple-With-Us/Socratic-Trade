# 2026-08-21 — Every deploy failed for ~5 hours on a top-level await, while prod served stale code

## Context & Objective
Found while acting on an owner request to run a production query.  Coolify's app diagnostics reported *"4 failed deployment(s) in last 5"* and *"Running container predates the last (failed) deployment — the app is serving stale code."*

**Every deployment from 2026-08-21T05:07Z onward failed**, so the day's merged fixes — including money-path changes — never reached production.  The running container kept serving healthy, so nothing external showed a problem.

## The failure
```
/app/scripts/assert-rth-deploy-latch.ts:27:17: ERROR: Top-level await is currently not supported
with the "cjs" output format
ERROR: process "/bin/sh -c tsx scripts/assert-rth-deploy-latch.ts" did not complete successfully
```

## Root cause: correct ordering, invisible consequence
`package.json` declares `"type": "module"` (line 5).  But the Dockerfile runs the latch at **line 53**, and copies `package.json` at **line 54** — in that order, deliberately, per the script's own comment: *"Runs BEFORE npm ci so a no-op like #2811 dies in seconds, not ~30 minutes."*

That ordering is right, and it is worth keeping.  Its cost is that at the moment `tsx` runs, **there is no `package.json` in the image**, so tsx cannot see `"type": "module"` and falls back to a **CJS** transform — where a top-level `await` is a hard error.

The script therefore runs fine locally, where `package.json` is present, and fails only inside the build.  That asymmetry is why it shipped.

## The fix
The `await` moved into an `async function main()` with an explicit `.catch()` that exits 1 (the script's documented usage-error code, so a crash can never silently *allow* a build).  This works identically under CJS and ESM.

**Deliberately not fixed by moving the `COPY package.json` earlier** — that would surrender the fast-fail ordering the script exists for, and would invalidate the build cache for the latch step on every dependency change.

The reasoning is written into the file as a comment naming the incident, so it is not "simplified" back.

## Regression test
`test/dockerfile-prepackage-scripts-cjs.test.ts` **parses the Dockerfile**, finds every `RUN tsx <script>.ts` that appears *before* the `COPY package.json` line, and transpiles each one under `--format=cjs`.

It generalizes past this one script: any future build-time script placed in that window is covered automatically.  It also asserts the discovered list is non-empty, so it cannot silently pass if the Dockerfile is restructured.

## Verification State
Failing-first proven against the **exact production error**: restoring the top-level await makes the CJS transform exit 1 with `Top-level await is currently not supported with the "cjs" output format`; the fix returns exit 0.

New test: 2 passing.  Full gate results recorded in the PR.

## Credit and scope
`scripts/assert-rth-deploy-latch.ts` and the Dockerfile ordering came from peer PR #2817.  The latch design is sound — this is a module-format trap, not a flaw in the latch idea.  Fixed here rather than handed back because it was blocking **all** deploys for every seat.

## Next Steps
Verify the next deployment succeeds and that the live sha advances past `313603752`.  `bash scripts/verify-deploy-sha.sh` asserts the live sha contains a given commit.
