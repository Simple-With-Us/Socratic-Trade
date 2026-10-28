# 2026-10-28 - ST-4585 The App Store Connect credential handoff after PR #4914

## Summary

- Two of the review findings that were still open on the merged pull request #4914 were real defects in `main`, and both are fixed here: a refusal that named a remedy the operator cannot reach, and an owner handoff that could never run.
- A third finding, the missing masked preview on a refused credential, was only half fixed in `main`: the ambient `ASC_KEY_P8` refusal and the client refusals carried one, and the refusal that comes out of the `/asc` key-file write did not.

## Why

- Pull request #4914 (AFC-459) merged on Oct 21, 2026.  Six of its review threads had no reply from this seat, and an audit of the merged tree found that three of them were still defects in `main`.
- The missing-identifier refusal named "add ASC_KEY_ID, ASC_ISSUER_ID and ASC_KEY_P8 to Infisical /asc" as the remedy.  The ambient `ASC_KEY_P8` is resolved BEFORE Infisical `/asc` is read, so a complete `/asc` credential is never reached while the ambient key is set: the code that would read it is never reached, so the instruction cannot work.  Running the real code on this Mac showed the refusal firing with 0 `/asc` lookups made.
- The upload path was dead code.  `load_secrets required` sat at line 1632 and died with exit 1 before the `if [[ "$AUTH_MODE" != "api_key" ]]` block at line 1633, and `AUTH_MODE` is only ever "none" or "api_key", so the branch had no other route in.  The operator never learned where the built package was.
- The refused `/asc` `.p8` carried no masked preview, while the ambient value and the client refusals both carried one, so a value that failed could not be identified without its body reaching an output stream.

## Files

- `scripts/ios-fleet/ship-testflight.sh` — three changes.
  - The tier-2 `ASC_KEY_ID` and `ASC_ISSUER_ID` refusals, in both the fatal and the reporting form, now offer the remedy that can work: unset the ambient `ASC_KEY_P8`, which lets the complete Infisical `/asc` credential be selected.  A comment says why the `/asc` remedy cannot work in that state.
  - The refused `/asc` `.p8` now carries `; preview: $(key_preview "$key_pem")`, so this refusal carries the same masked identifier as the other two.
  - The upload path calls `load_secrets` instead of `load_secrets required`.  A comment says why: a REJECTED credential is still fatal inside `load_secrets` in both modes, and only an ABSENT one is reported, so the package path, the `Upload blocked` line, the owner handoff steps and the exit 3 are reachable.
- `scripts/ios-fleet/test-asc-credentials.sh` — three new cases.
  - **2c-quater** — a `.p8` that comes from Infisical `/asc` and is not a PEM is refused with the masked preview and is never printed.
  - **2d-bis** — the refusal names `unset ASC_KEY_P8`, does NOT name the `/asc` remedy it never reads, and the fake Infisical log proves `/asc` was never consulted.
  - **2m** — the upload path is extracted with awk, run with no credential reader at all, and must exit 3 while logging `Package ready at:`, `Upload blocked` and `Owner handoff:`.  The exit code is read as `rc=0; out="$(...)" || rc=$?` so `set -euo pipefail` does not abort the suite.

## Decisions and trade-offs

- "Absent" and "rejected" are different failures, and the handoff distinguishes them.  A rejected credential is still fatal inside `load_secrets` in both modes, because a value that is not a key must not be signed with and must not be handed on as if it were.  Only an absent credential is reported and handed off, and the upload still does not happen, because the handoff ends the run with a nonzero exit.
- The refusal does not silently substitute a credential.  The ambient key keeps precedence over `/asc`, and the refusal tells the operator how to SELECT `/asc` rather than quietly signing with a different key.  Swapping the sources on its own would be a bigger change than the finding asked for and would change which key signs a request without the operator asking.
- A remedy the operator cannot act on is itself the defect.  The finding was about an unreachable instruction, not about a missing feature, so the fix is the instruction and not a new source of credentials.
- The upload path is still not an upload.  The handoff ends the run with exit 3, which is what the path already intended.

## Verification

- `bash scripts/ios-fleet/test-asc-credentials.sh` — `ok: ASC credential resolution`, exit 0.
- Three independent mutation runs against the pre-change script, one per change, and each named its own defect:
  - the masked preview reverted — `FAIL: the refused /asc .p8 carried no masked preview`
  - the remedy reverted — `FAIL: the refusal did not name the reachable remedy (unset ASC_KEY_P8)`
  - the upload path reverted — `FAIL: the upload path did not hand off with exit 3 (rc=1): error: ASC_KEY_ID is missing: set ASC_KEY_ID in the environment, or add ASC_KEY_ID to Infisical /asc`
- `scripts/ios-fleet/test-asc-credentials.sh:333` asserts only the substring `ASC_KEY_ID is missing`, so the remedy-text change breaks no existing assertion, and nothing in the suite asserts on `Upload blocked` or on `Package ready at:`.
- The lane needed `npm ci` before the suite would run, because `node_modules` was absent in the lane.
- `origin/main` moved under this branch and touched the same three files, so `scripts/land.sh` refused the landing and required a deliberate merge.  The merge was clean, and every change was re-verified in the merged tree:  the remedy text is at lines 355 to 365, the masked preview on the refused `/asc` `.p8` is at line 438, and the upload path calls `load_secrets` without `required` at line 1758.  The three mutation controls were run again against the merged code and each one still bites, so the suite did not lose its teeth when main's changes landed.  Main also added `load_secrets` call sites of its own to the version helpers, and those are on a different path from the upload path this change touches.

## Follow-ups

- The other fleet copies of this ship script carry the same two defects, because they are the same port of the same credential layer.  The shape used here is the one to port: a refusal names the remedy that can work, and an absent credential hands off instead of dying in silence.
- The `start` key of the housekeeper lock protocol, which is an AFC concern and not this repository's, is recorded in the AFC rows and not here.

## Blockers

- None for this change.  The upload itself stays blocked until an operator provides the credential, which is the point of the handoff.
