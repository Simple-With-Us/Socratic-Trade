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
- `scripts/ios-fleet/ship-testflight.sh` — `load_secrets` resolves an ambient `ASC_KEY_P8` first, then Infisical, writes the mode-600 staging file for `altool` and Xcode, exports the key to the client in the environment, and logs that a named `ASC_KEY_PATH` was ignored.  The file header, the upload-only refusal and the owner handoff line name the environment instead of a path.
- `scripts/ios-fleet/test-asc-key.test.mjs` (new) — the module tests, plus the client driven against a loopback server.  The request is verified against the environment key and against the key in the named file, so "the environment wins over a named file" is proven rather than asserted.
- `scripts/ios-fleet/test-asc-credentials.sh` (new) — the credential-precedence test.  Every comparison answers through the exit code of a node helper, so a credential is never expanded into the shell, and a scanner proves the ship script never captures the key material into a variable.
- `scripts/ios-fleet/asc-api.credentials.test.mjs` — updated for the new source order instead of the removed file branch.
- `scripts/ios-fleet.sha256`, `scripts/ios-fleet-pin.sh` — the new module joins the pinned runtime set, and the pin is refreshed in the same change.
- `scripts/ios-fleet/check-drift.sh` — the new file joins the runtime install set.
- `scripts/ios-fleet/README.md` — the documented credential order matches the code.
- `.github/workflows/ci.yml` — the two new offline suites run in the iOS ship-gate job, so they are real gates.
- `STATUS.md`, `PLAN.md` — the handoff notes.

## Decisions and trade-offs

- The hosted workflow was left alone.  It publishes only `ASC_KEY_PATH`, which the shell layer now ignores, so the two CI steps that call the client need the key in their environment.  The credential has to cross the step boundary in the environment, and this repository's workflow deliberately keeps the multiline PEM out of `GITHUB_ENV`, so that handoff is a decision for the fleet rather than for this port.  CodeCaps PR #271 owns the answer for its own repository, and one shape across the nine copies is worth more than nine answers.  The need is posted in the AFC-459 fleet topic.
- The reference `test-asc-key.test.mjs` still covered revision 1 (it imported `readPrivateKeyFile` and drove the `read` and `exec` subcommands), so the suite here was written for revision 2 rather than copied.  It asserts the module's four exports, asserts that the module text contains no file read and no `read` or `exec` subcommand, and drives the real client.
- The client had no `APPLE_API_*` support, so the first tier was added with the reference's semantics.
- `readFileSync` and `existsSync` had no other use in the client, so the import is gone.
- `clientEnvironment` is exported but unused here:  it is part of the shared module contract, and the fleet shell layer hands the key over with an explicit export.

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

- The hosted CI handoff:  `scripts/ios-install-appstore-profiles.sh` and the ship step itself need the key in their environment.  Until that lands, the hosted TestFlight ship stops at the sequence floor with `asc=UNVERIFIED` the next time an iOS change lands.  The local Mac path is fine, because `fleet-secrets` is there and the client reaches Infisical itself.
- The runtime install at `/Users/jay/apps/ios-fleet/` has no `asc-key.mjs`.  The in-repo copy is preferred by `scripts/ios-ship-testflight.sh`, so the repository path is unaffected, and `check-drift.sh` reports the gap.
- The rest of the fleet copies of this client are the same port:  nine upstream copies still resolve the key by reading a file named by `ASC_KEY_PATH`.

## Blockers

- None for the port itself.  The hosted CI handoff is the open fleet-wide item above.
