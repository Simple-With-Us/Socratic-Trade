# 2026-10-21 - AFC-459 App Store Connect credential hardening (revision 2)

## Summary

- The App Store Connect private key is now taken only from the process environment or from Fleet-OPS prod `/asc` through `fleet-secrets`.  A path on disk is not a credential source, so the node client never reads a key file:  a named `ASC_KEY_PATH` is ignored wherever it appears.
- New `scripts/ios-fleet/asc-key.mjs`, a key module that never reads a file, and a rewritten credential block in `scripts/ios-fleet/asc-api.mjs` and `scripts/ios-fleet/ship-testflight.sh`.

## Why

- AFC-459, revision 2.  The private key is a secret, and the approved sources are the process environment, a captured `fleet-secrets get` and bootstrap-only Keychain credentials.  Revision 1 hardened a file reader, and a hardened reader is still a file read, so the CodeCaps reviewer blocked it:  a path on disk can never be an approved credential source.
- The consequence is that a stale or foreign path in an operator's shell can no longer decide which key signs a request, and App Store Connect can no longer answer 401 without the failing input being identifiable.
- The shape is the revision-2 one the CodeCaps reviewer approved, as landed in CodeCaps PR #271.  This is the Socratic-Trade copy of a fleet-wide port across the repositories that ship the same client.

## Files

- `scripts/ios-fleet/asc-key.mjs` (new) — the key module, byte-identical to the approved reference.  It exports `normalizePrivateKey`, `writePrivateKeyFile`, `CLIENT_ENV_ALLOWLIST` and `clientEnvironment`.  There is no `readPrivateKeyFile`, no `execWithKey`, no `O_NOFOLLOW` read and no `read` or `exec` subcommand.
- `scripts/ios-fleet/asc-api.mjs` — `resolveAscCredentials()` takes the first source that is present:  the `APPLE_API_*` trio, then `ASC_KEY_ID` / `ASC_ISSUER_ID` / `ASC_KEY_P8`, then Infisical `/asc` (or `/authkey-<id>-p8` for a key id that is not the `/asc` one).  The `ASC_KEY_PATH` branch and the `readFileSync` of the key path are gone, the PEM is validated with `normalizePrivateKey`, and the refusal names the three sources and says that a path in `ASC_KEY_PATH` is not a credential source.
- `scripts/ios-fleet/ship-testflight.sh` — `load_secrets` resolves an ambient `ASC_KEY_P8` first, then Infisical, writes the mode-600 staging file for `altool` and Xcode, exports the key to the client in the environment, and logs that a named `ASC_KEY_PATH` was ignored.  The file header, the upload-only refusal and the owner handoff line name the environment instead of a path.  A PEM stored with literal backslash-n separators is turned into real newlines before the module sees it, which is where the old shell layer already did it for the Infisical value.
- `.github/workflows/ios-ship.yml` — the hosted ship step fetches the key itself, through `scripts/ios-asc-key-env.sh`, and hands it to the ship script in the environment.  A path on disk is not a credential source, so the step that calls the client needs the key itself, and no key material may cross a step boundary, because the environment file is the only channel between steps and this repository's invariant is that it never holds key material (enforced by `scripts/test-ios-stage-asc-key.sh`).  The mode-600 staged file stays the materialization for the Apple tools that need a key on disk.
- `scripts/ios-asc-key-env.sh` (new) — fetches the key from Infisical prod and execs the child with `ASC_KEY_P8` in its environment.  The key never reaches stdout, argv, a log line, a file or the environment file.
- `scripts/test-ios-asc-key-env.sh` (new) — the offline test for that handoff, with a fake Infisical CLI.
- `scripts/ios-install-appstore-profiles.sh` — the credential line in the header names `ASC_KEY_P8` instead of `ASC_KEY_PATH`.
- `scripts/ios-fleet/test-asc-key.test.mjs` (new) — the module tests, plus the client driven against a loopback server.  The request is verified against the environment key and against the key in the named file, so "the environment wins over a named file" is proven rather than asserted.
- `scripts/ios-fleet/test-asc-credentials.sh` (new) — the credential-precedence test.  Every comparison answers through the exit code of a node helper, so a credential is never expanded into the shell, and a scanner proves the ship script never captures the key material into a variable.
- `scripts/ios-fleet/asc-api.credentials.test.mjs` — updated for the new source order instead of the removed file branch.
- `scripts/ios-fleet.sha256`, `scripts/ios-fleet-pin.sh` — the new module joins the pinned runtime set, and the pin is refreshed in the same change.
- `scripts/ios-fleet/check-drift.sh` — the new file joins the runtime install set.
- `scripts/ios-fleet/README.md` — the documented credential order matches the code.
- `.github/workflows/ci.yml` — the two new offline suites run in the iOS ship-gate job, so they are real gates.
- `STATUS.md`, `PLAN.md` — the handoff notes.

## Decisions and trade-offs

- The hosted workflow keeps the key out of the environment file.  Publishing `ASC_KEY_P8` there was the first attempt and it failed the repository's own invariant test (`scripts/test-ios-stage-asc-key.sh`):  the environment file is the only channel between steps, and it must never hold key material.  So the step that calls the client fetches the key itself and hands it over in its own environment, through `scripts/ios-asc-key-env.sh`.  The mode-600 staged file stays the materialization for `altool` and Xcode.
- The reference `test-asc-key.test.mjs` still covered revision 1 (it imported `readPrivateKeyFile` and drove the `read` and `exec` subcommands), so the suite here was written for revision 2 rather than copied.  It asserts the module's four exports, asserts that the module text contains no file read and no `read` or `exec` subcommand, and drives the real client.
- The client had no `APPLE_API_*` support, so the first tier was added with the reference's semantics.
- `readFileSync` and `existsSync` had no other use in the client, so the import is gone.
- `clientEnvironment` is exported but unused here:  it is part of the shared module contract, and the fleet shell layer hands the key over with an explicit export.
- A PEM stored with literal backslash-n separators is turned into real newlines in the shell layer, where the old code already did it for the Infisical value.  The module itself is kept byte-identical to the approved CodeCaps reference, and the client already normalized the separators before it called `normalizePrivateKey`.

## Verification

- `node --test scripts/ios-fleet/test-asc-key.test.mjs` — 19 tests, 19 pass, 0 fail
- `bash scripts/ios-fleet/test-asc-credentials.sh` — ok (environment first, then Infisical, a named path ignored, temp key removed)
- `node --test scripts/ios-fleet/asc-api.credentials.test.mjs` — 11 tests, 11 pass, 0 fail
- `node --test scripts/ios-fleet/*.test.mjs` — 34 tests, 34 pass, 0 fail
- `bash scripts/ios-fleet/test-ship-seq.sh` — 71 passed, 0 failed
- `bash scripts/ios-fleet/test-scheduled-ship-gate.sh` — 13 passed, 0 failed
- `bash scripts/test-ios-stage-asc-key.sh` — passed
- `bash scripts/test-ios-scheduled-ship-gate.sh` — 13 passed, 0 failed
- `npm run lint` — 0 errors, 869 pre-existing warnings, none in the changed files
- `npx tsc --noEmit` — clean (the hosted CI job runs it and it passed)
- `gitleaks detect --source . --no-git` — 2 findings, both pre-existing (`.env.example` and `docs/rollouts/2026-06-21-logo-dev-toggle.md`), nothing in the changed files
- The new shell test was also run against the pre-change `ship-testflight.sh`, and it fails there, because that script never sets `ASC_KEY_P8`.  The suite has teeth.

Every fixture key is generated at test time, and no key, `.p8` or secret value is committed.

## Follow-ups

- The fleet-wide handoff for the other eight repositories:  a workflow that publishes only `ASC_KEY_PATH` leaves the ship with no credential, and the next iOS change lands with `asc=UNVERIFIED` and no upload.  The shape used here is `scripts/ios-asc-key-env.sh`:  the step that calls the client fetches the key and hands it over in the environment, so no key material crosses a step boundary.  It is posted in the AFC-459 fleet topic, so one shape lands across the copies.
- The runtime install at `/Users/jay/apps/ios-fleet/` has no `asc-key.mjs`.  The in-repo copy is preferred by `scripts/ios-ship-testflight.sh`, so the repository path is unaffected, and `check-drift.sh` reports the gap.
- The rest of the fleet copies of this client are the same port:  nine upstream copies still resolve the key by reading a file named by `ASC_KEY_PATH`.

## Blockers

- None for the port itself.  The hosted CI handoff is the open fleet-wide item above.
