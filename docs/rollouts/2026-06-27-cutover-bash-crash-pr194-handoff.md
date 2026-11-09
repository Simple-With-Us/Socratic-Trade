# 2026-06-27 — HANDOFF: cutover `SHARED_PROJECT_ID?: unbound variable` crash + PR #194 state

Handoff for the next agent (Codex / Antigravity / Claude). Picks up an UNFINISHED
investigation. Read this fully before touching `scripts/infisical-prod-cutover.sh`
or PR #194 — several confident-looking conclusions in earlier notes are WRONG, and
this note says which.

## TL;DR

1. The operator still cannot complete the Infisical prod cutover. The script dies at
   `scripts/infisical-prod-cutover.sh: line 200: SHARED_PROJECT_ID?: unbound variable`.
2. **The root cause is NOT confirmed.** The earlier "macOS bash 3.2 multibyte bug"
   explanation (in PR #194's body, `STATUS.md`, `AGENTS.md`, and the
   `2026-06-26-infisical-universal-auth.md` note) is **probably wrong** — the operator
   reproduced the SAME crash under **Homebrew bash 5.3**, which a 3.2-specific bug cannot
   explain. Do not trust the "3.2" framing.
3. **The single most important un-run diagnostic** (the operator never ran it) is the
   confirm one-liner in the next section. Get its output first; it decides everything.
4. PR #194 (the ASCII-conversion fix) is **unproven against the actual crash** because
   it could not be reproduced off-box. It is harmless hygiene regardless, and is now
   un-blocked to merge (see PR section).

## THE diagnostic to run first (operator, on the box)

```bash
B="$(brew --prefix)/bin/bash"; "$B" --version | head -1
"$B" -c 'set -u; v=hello; printf "%s\n" "proj $v…end"'   # $v immediately followed by the … (U+2026)
```
- Errors `v…: unbound variable` (or `v?: …`) → the box's bash mis-parses `$VAR` immediately
  followed by a multibyte byte, swallowing it into the identifier. THEN the ASCII fix (PR #194)
  is correct, and the bug is this bash build's parser (NOT specifically 3.2). Correct the docs
  to say "this bash build", not "3.2".
- Prints `proj hello…end` → the parser is innocent; `SHARED_PROJECT_ID` is genuinely unset at
  line 200 for some other reason. PR #194 will NOT fix it. Re-open the investigation: get
  `sed -n '40,44p;198,201p' scripts/infisical-prod-cutover.sh | od -c` from the box and a
  `bash -x` trace of the real run between line 43 and line 200.

## What is established (don't re-derive)

- The box is a **Mac** (`cat -A` failed with "illegal option" = BSD cat; the Infisical CLI's
  "Linux package" deprecation notice is a generic red herring).
- The box's file is **clean** — `git status` empty, byte-for-byte equal to `origin/main`
  (`git diff` empty; verified at box commits `d103766` and later `4e77b40`). It is NOT
  hand-edited and NOT stale.
- Committed **line 43 always binds** the variable:
  `SHARED_PROJECT_ID="${INFISICAL_SHARED_PROJECT_ID:-18f563a3-…}"` — present in every commit
  back to the first overlay commit `d8fa8a3`. So `set -u` should never see it unset at line 200.
- **Line 200 is the only line in the script with a non-ASCII char (`…`, U+2026 = `e2 80 a6`)
  directly adjacent to a `$VAR`** (`"...$SHARED_PROJECT_ID…"`). Lines 161/188/194 also have `…`
  but not adjacent to a variable, and they print fine first — matching the operator's output
  (it dies only at 200).
- **Local repro does NOT reproduce the crash.** Running the real committed bytes of line 43 +
  line 200 under sandbox **bash 5.2** in UTF-8 and C locales: bound → prints fine; unset →
  a CLEAN `SHARED_PROJECT_ID:` name (no `?`). So the `?` in the operator's error comes from the
  box's bash/parse, not from any committed `?`. The discriminator between sandbox (works) and box
  (crashes) is unknown — bash 5.3 vs 5.2, or the box's locale, or something not yet seen.

## Misdiagnoses made this session (DO NOT REPEAT)

1. "macOS bash **3.2** multibyte bug." Falsified by the operator's bash-5.3 crash. The ASCII fix
   may still be right, but the *reason* is unconfirmed.
2. "Agent **pushes don't trigger CI** (token suppression)." WRONG. The 4 required checks
   (`gitleaks`, `smoke`, `verify`, `verify`) were showing "Expected — **awaiting conflict
   resolution**" — GitHub holds required checks while a PR has a merge conflict. The blocker was
   a `STATUS.md` conflict, not the token. (GitHub's PR-UI conflict detector does NOT honor
   `.gitattributes merge=union`, so `STATUS.md` shows "conflict" even though `git merge` resolves
   it cleanly. The escape is to `git merge origin/main` into the branch so it becomes a descendant
   of main — then GitHub sees no conflict.)

## PR #194 state (branch `claude/practical-mendel-cqtduf`)

- Content: converts `scripts/infisical-prod-cutover.sh` to pure ASCII (`…`→`...`, `—`/`─`→`-`,
  `→`→`->`), 33 char-swap lines, zero logic change; plus `AGENTS.md` trap bullet and an appended
  section to the `2026-06-26-infisical-universal-auth.md` note. Net diff vs main = 4 files.
- It was stuck on the `STATUS.md` "awaiting conflict resolution" hold. Fixed by merging
  `origin/main` into the branch (commit `6476919`) so the branch contains main's tip and the PR
  is conflict-free. Auto-merge (squash) is armed; the 4 required checks should run after the push.
- **Caveat before celebrating a merge+deploy:** the deploy only lands the *fixed script* on the
  box; it does NOT run the cutover, and the ASCII change is UNPROVEN against the real crash (see
  the confirm test). If the box still crashes after deploy, the cause was never the `…`.
- **Fast-moving main races this PR.** `STATUS.md` is touched by nearly every PR; if main advances
  and the PR shows a conflict again, re-merge `origin/main` into the branch (or drop the PR's
  `STATUS.md` edit so it can't overlap). Do not interpret a re-appearing conflict as a CI/token
  problem.

## Operator (box-only) steps still outstanding

Agents cannot reach the prod Mac / Infisical CLI / live secrets — these are operator-only:

1. Run the confirm one-liner above; report output.
2. Get the ASCII script on the box: either let PR #194 merge+deploy (`deploy.yml` does
   `git reset --hard origin/main`), or as an immediate unblock strip it by hand:
   ```bash
   cd ~/apps/trading-live
   perl -i -pe 's/\xE2\x80\xA6/.../g; s/\xE2\x80\x94/-/g; s/\xE2\x94\x80/-/g; s/\xE2\x86\x92/->/g' scripts/infisical-prod-cutover.sh
   ```
3. Run the cutover with BOTH scoped identities (overlay on, app wins overlaps):
   - app = agentic-trading, Client ID `fedc540e-…`
   - shared = shared-at-ct, Client ID `e00e7a66-…`
   ```bash
   INFISICAL_CLIENT_ID=fedc540e-… INFISICAL_CLIENT_SECRET=<app-secret> \
   INFISICAL_SHARED_CLIENT_ID=e00e7a66-… INFISICAL_SHARED_CLIENT_SECRET=<shared-secret> \
     bash scripts/infisical-prod-cutover.sh --no-restart      # verify + write deploy.env + import
   bash scripts/infisical-prod-cutover.sh                     # flip PM2 to start:secrets + health-check
   ```
4. **Rotate the two Client Secrets** that were pasted into chat in an earlier session — treat them
   as COMPROMISED. Cleanest order: rotate first, then run the cutover with the new secrets so the
   compromised ones are never written to `deploy.env`.
5. Do **not** `--scrub .env.local` until the app boots healthy with the shared keys present.

## Files touched this session

- `scripts/infisical-prod-cutover.sh` (ASCII conversion — the fix under test)
- `STATUS.md`, `AGENTS.md`, `docs/rollouts/2026-06-26-infisical-universal-auth.md` (carry the
  not-yet-corrected "bash 3.2" narrative — fix once the confirm test settles the real cause)
- this note

## Verification actually run

- `bash -n scripts/infisical-prod-cutover.sh` ✓; `grep -cP '[^\x00-\x7F]'` → 0 (script is ASCII).
- Faithful local repro of lines 43+200 (bash 5.2, UTF-8 + C): printed fine — did NOT reproduce
  the box crash. **The crash is unreproduced off-box.**
- `npx tsc` / `npm test` / `npm run build` NOT run this session (change is one `.sh` + `.md`s; no
  TS touched). The required CI (`verify`) will cover them on the PR.
