# 2026-09-01 -- PR #3139 plist comment fix (actually fix it this time)

## Context & Objective

PR #3139 (`fix/plist-comment`) claimed to fix `plistlib.loads` raising
`ExpatError: not well-formed` on `scripts/com.jay.provider-knob-sync.plist` by
moving the template comment from above the `<!DOCTYPE>` line to inside
`<dict>`.  That move alone does not fix anything: XML comments cannot contain
the two-character sequence `--` anywhere in their body, in any position, per
the XML 1.0 spec (section 2.5) -- and the relocated comment still contained
literal `--apply` on two lines.  `chatgpt-codex-connector` caught this on
review (two threads, `PRRT_kwDOS7mOVM6d8fD5` and `PRRT_kwDOS7mOVM6d8fD_`) and
was right: `plistlib.load` on the PR's head commit (`7e14a7cf`) still raised
the identical `ExpatError` at the first `--apply` occurrence.  This lands the
actual fix plus the rollout-doc update `AGENTS.md` requires for script
changes, which the original PR was also missing.

## Changes Made

- Removed both literal `--apply` sequences from the XML comment in
  `scripts/com.jay.provider-knob-sync.plist` by rephrasing to "the apply
  flag" -- no `--` sequence remains anywhere in the comment body. The comment
  stays inside `<dict>` (after the DOCTYPE), which was fine as a structural
  change, it just wasn't sufficient on its own.
- The real `--apply` CLI argument (`<key>ProgramArguments</key>` ->
  `<string>--apply</string>`, line 35) is untouched -- that's a `<string>`
  element value, not comment text, so the `--` restriction never applied to
  it. Only the two comment mentions needed rewording.

Touched:

- `scripts/com.jay.provider-knob-sync.plist`
- `docs/rollouts/2026-09-01-pr-3139-plist-comment-fix.md` (this file)
- `STATUS.md`, `docs/EFFORT-LOG.md`

## Decisions & Trade-offs

- Chose "the apply flag" over `-apply` (single dash) or moving the flag
  mention to a sibling comment -- rewording without any dash-doubling is the
  least surprising fix for a human reading the template later, and it fully
  sidesteps the XML `--` rule rather than getting close to it again.
- Did not touch the real `--apply` argument in `ProgramArguments` -- that
  string is unaffected by the XML-comment restriction and changing it would
  alter the actual launchd behavior, which is out of scope for a doc-comment
  fix.

## Verification State

- `python3 -c "import plistlib; plistlib.load(open('scripts/com.jay.provider-knob-sync.plist','rb'))"`
  -- confirmed it RAISED `ExpatError: not well-formed (invalid token): line 8,
  column 54` on the PR's prior head (`7e14a7cf`, comment still containing
  `--apply`), and now parses cleanly after the rewording, using both
  `/usr/bin/python3` (Apple system) and `/opt/homebrew/bin/python3`.
- `grep -n -- '--' scripts/com.jay.provider-knob-sync.plist` -- the only
  remaining `--` sequences are the comment delimiters themselves
  (`<!--`/`-->`) and the legitimate `<string>--apply</string>` CLI-argument
  value outside any comment.
- No repo test or CI step runs `plistlib` against this file (searched
  `test/`, `.github/workflows/*.yml`, and `scripts/*.sh` for
  `provider-knob-sync` / `plistlib` -- no hits), so the manual `plistlib.load`
  check above is the applicable verification for this change. `npx tsc
  --noEmit` / `npm test` / `npm run build` are unaffected (no `.ts`/`.tsx`
  touched).

## Next Steps & Blockers

- Reply to both Codex threads citing this commit, then resolve them via
  `resolveReviewThread` now that the fix is verified.
- Do not merge from here -- hand back once both threads are resolved and CI
  is green; the owner/another agent merges.

## Zero-Code Findings

None -- both findings were real and are fixed above.
