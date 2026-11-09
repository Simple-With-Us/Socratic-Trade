# Multi-agent coordination — independent review & residual-gaps analysis (2026-06-21)

> Produced by a 4-agent design workflow (protocol + tooling + adversarial review → Opus synthesis).
> It independently reproduced the coordination protocol **already implemented on `main`**
> (`scripts/githooks/pre-push`, `scripts/land.sh`, `core.hooksPath` wired in
> `setup-agent-previews.sh`, the AGENTS.md "Multi-agent landing protocol" section) — validating
> that design — and adds the honest residual-gaps / limits analysis below (its highest value).


```markdown
# Multi-Agent Git Coordination — Implementation-Ready Deliverable

This is the canonical fix for the 2026-06 push races + worktree collisions. It assumes the on-disk reality verified this session: hooks live at `scripts/githooks/`, `setup-agent-previews.sh` already sets `core.hooksPath scripts/githooks` per-worktree, and the override env var is `HOOKS_ALLOW_MAIN_PUSH=1`. Do NOT introduce a second `scripts/hooks/` path or a separate `install-hooks.sh` — that diverges from what's already wired.

The honest core insight (from the red-team): **PR-based landing does not serialize integration by itself.** The actual serializer is "agents create PRs but never merge them; only the human integrator merges, one at a time, in the `main` worktree, with a gate that runs there." Everything below is built around that.

---

## 1. AGENTS.md — new "Multi-agent landing protocol" section

### Where it goes
Paste the block below **immediately after the "A running port is NOT a work lock" paragraph** at the end of the "Hosting & dev servers" section, and **before** "Cross-file consistency traps".

### Existing lines to adjust first
In the **"How each agent works"** sub-section, replace this bullet:

> **Land work via git:** commit on your `agent/<name>` branch, then merge to `main` (in the integration worktree; ff or PR). `git merge origin/main` into your branch to stay current.

with:

> - **Land work via `scripts/land.sh`:** commit on your `agent/<name>` branch, then run `bash scripts/land.sh` from your worktree. It fetches, merges `origin/main`, runs the verify gate, pushes your branch, and opens a PR. **Agents NEVER merge to `main` themselves** — the human integrator merges PRs one at a time in `~/Code/Agentic Trading`. See "Multi-agent landing protocol" below. The "ff or PR" / self-merge path is closed.
> - **Stay current:** `git fetch origin && git merge origin/main` into your branch before every push; re-run the gate after every merge. `land.sh` does this for you.

In the **"Before you start"** section, append one bullet:

> - Confirm hooks are active: `git config core.hooksPath` should print `scripts/githooks`. If it's empty, you are in a worktree that wasn't bootstrapped — run `bash scripts/setup-agent-previews.sh` (or `git config core.hooksPath scripts/githooks` for just this worktree) before any git push.

### The block to paste

```markdown
## Multi-agent landing protocol

> Root cause of every push race and the Q0 worktree collision logged in 2026-06.
> Read this before touching `main`, pushing, or editing files. With several agents
> (including multiple concurrent Claude sessions) on `main` at once, conventions
> alone failed — this section pairs them with local git hooks. The hooks catch the
> *confused-agent* case; they cannot stop a *deliberate* bypass (see "honest limits"
> at the end). The agents here are assumed confused, not adversarial.

### Cardinal rules

1. **NEVER push directly to `main`.** `main` is merge-only. The `pre-push` hook
   (`scripts/githooks/pre-push`) blocks any push whose remote ref is
   `refs/heads/main`, in every form (`git push origin main`,
   `git push origin HEAD:main`, `git push origin agent/claude:main`).

2. **Agents create PRs; agents do NOT merge them.** Merging to `main` is exclusively
   the human integrator's action, performed in `~/Code/Agentic Trading`, **one PR at a
   time**. This — not "use a PR" — is what serializes integration and ends the push
   race. `land.sh` stops at `gh pr create`; it must NEVER call `gh pr merge`,
   `gh pr merge --auto`, or `git push origin main`. Auto-merge re-creates the race at
   the merge button, so it is banned.

3. **NEVER edit, build, `npm install`, `git checkout`/`switch`/`stash`, or run a dev
   server in `~/Code/Agentic Trading` (the `main` integration worktree).** It is
   read + merge only. The Q0 collision was an agent leaving broken WIP there, which
   failed every other agent's `tsc`/`build`. The `pre-push` hook blocks pushes *from*
   that worktree, but it CANNOT stop file writes — so this is a hard convention. If you
   ever find yourself `cd`'d there, `cd` back to your own worktree before doing anything.

4. **One agent per worktree; one session per worktree at a time.** A spawned/second
   Claude session MUST confirm it is in `~/apps/trading-claude` (`git rev-parse
   --show-toplevel`) before writing any file. If it can't confirm its own worktree, it
   exits and asks the user.

   | Agent | Worktree | Branch |
   |-------|----------|--------|
   | Claude Code | `~/apps/trading-claude` | `agent/claude` |
   | Codex | `~/apps/trading-codex` | `agent/codex` |
   | Antigravity/Gemini | `~/apps/trading-antigravity` | `agent/antigravity` |
   | Human / Cursor | `~/Code/Agentic Trading` | `main` (merge only) |

5. **`--no-verify` is never permitted on a push.** It bypasses the gate. If a hook
   blocks you, the hook is correct — fix the cause, don't bypass it.

### The landing flow (every time you ship)

```bash
# From YOUR agent worktree, on YOUR agent/<name> branch:
bash scripts/land.sh
```

`land.sh` runs, in order, aborting on the first failure:
1. **Worktree/branch guard** — refuses to run in the `main` worktree or on branch `main`.
2. `git fetch origin` then `git merge --no-edit origin/main` — abort + recipe on conflict.
3. **Verify gate** — `npx tsc --noEmit` → `npm test -- --run` → `npm run build`. A red
   test or type error stops the land. This catches the "red test reached `main`" class.
4. **Workflow-scope guard** — refuses if the diff touches `.github/workflows/` (token
   lacks `workflow` scope; stage those in `ci-pending/` instead — see below).
5. **Push branch + `gh pr create --base main`** (or surface the existing PR URL).
6. Prints the PR URL. **Then notify the human integrator. Do not merge it yourself.**

### Signal shared-file PRs in STATUS.md

Before opening a PR that touches core shared files
(`types.ts`, `db.ts`, `policy.ts`, `performance.ts`, `market.ts`, `data-providers.ts`,
`strategy.ts`, `red-team.ts`), add a line to `STATUS.md`:

```
[PENDING PR] agent/claude: <title> — touches: <files> — <PR url>
```

Other agents hold same-file PRs until yours clears. Keep PRs small and single-purpose —
a PR touching four core files is a conflict magnet; split it.

### CI workflow files are blocked (no `workflow` scope)

Pushing `.github/workflows/*` is rejected (token lacks `workflow` scope).
**Agents must NOT push workflow files.** Leave them staged in `ci-pending/`. Activation
is a one-time human step:

```bash
gh auth refresh -s workflow            # browser OAuth, human runs once
mkdir -p .github/workflows
git mv ci-pending/*.yml .github/workflows/
git commit -m "ci: activate workflows (workflow scope granted)"
bash scripts/land.sh                   # lands via PR like anything else
```

### If hooks aren't installed

Hooks are wired by `scripts/setup-agent-previews.sh` (sets `core.hooksPath
scripts/githooks` in every worktree, including `main`). If `git config
core.hooksPath` is empty in your worktree, re-run that script, or for this worktree
only: `git config core.hooksPath scripts/githooks`.

### Emergency override (human integrator only)

The human integrator, working in `~/Code/Agentic Trading`, may push to `main`
deliberately with `HOOKS_ALLOW_MAIN_PUSH=1 git push origin main`. The bypass is
intentionally noisy and named so it's a conscious act, never a default. Agents do not
use it.
```

---

## 2. scripts/land.sh

Create at `/Users/jay/apps/trading-claude/scripts/land.sh`, then `chmod +x`.

```bash
#!/usr/bin/env bash
# land.sh — the ONE command an agent runs to ship work.
#
#   bash scripts/land.sh
#
# Run from YOUR agent worktree on YOUR agent/<name> branch. In order:
#   1. guard: refuse the main integration worktree / branch main
#   2. fetch origin + merge origin/main (abort with recipe on conflict)
#   3. verify gate: tsc -> vitest -> next build
#   4. guard: refuse if diff touches .github/workflows/ (no workflow scope)
#   5. push branch + open a PR (never merges; never pushes to main)
#
# It NEVER calls `gh pr merge` or `git push origin main` — merging is the human
# integrator's job, one PR at a time, in ~/Code/Agentic Trading. Auto-merge would
# re-create the push race, so it is deliberately absent.
#
# Escapes (flagged in the PR body when used):
#   LAND_SKIP_VERIFY=1   skip the verify gate (use only when intentionally
#                        landing a known-red state with human sign-off)
#   LAND_FORCE=1         skip the worktree/branch guard (almost never correct)
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
REPO_ROOT="$(cd "$REPO_ROOT" && pwd -P)"
MAIN_WT="$(cd "$HOME/Code/Agentic Trading" 2>/dev/null && pwd -P || true)"
BRANCH="$(git symbolic-ref --short HEAD 2>/dev/null || echo HEAD)"

note=""   # appended to the PR body to flag any escape used

# --- 1. worktree / branch guard ------------------------------------------------
if [[ "${LAND_FORCE:-0}" != "1" ]]; then
  if [[ -n "$MAIN_WT" && "$REPO_ROOT" == "$MAIN_WT" ]]; then
    echo "ERROR: refusing to land from the main integration worktree ($REPO_ROOT)."
    echo "       Work in your agent worktree (e.g. ~/apps/trading-claude)."
    exit 1
  fi
  if [[ "$BRANCH" == "main" || "$BRANCH" == "HEAD" ]]; then
    echo "ERROR: on branch '$BRANCH'. Land from your agent/<name> branch."
    exit 1
  fi
else
  note+="- LAND_FORCE=1 used (worktree/branch guard skipped)\n"
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "ERROR: working tree is dirty. Commit or stash before landing."
  git status --short
  exit 1
fi

# --- 2. fetch + merge origin/main ---------------------------------------------
echo "--- land: fetching origin ---"
git fetch origin --quiet
echo "--- land: merging origin/main into $BRANCH ---"
if ! git merge --no-edit origin/main; then
  echo ""
  echo "ERROR: merge conflict with origin/main. Resolve, then re-run land.sh:"
  echo "    1) fix conflicted files"
  echo "    2) git add -A && git commit --no-edit"
  echo "    3) bash scripts/land.sh"
  echo "  (to abandon this merge: git merge --abort)"
  exit 1
fi

# --- 3. verify gate -----------------------------------------------------------
if [[ "${LAND_SKIP_VERIFY:-0}" == "1" ]]; then
  echo "--- land: WARNING verify gate skipped (LAND_SKIP_VERIFY=1) ---"
  note+="- LAND_SKIP_VERIFY=1 used (tsc/test/build NOT run — needs human sign-off)\n"
else
  echo "--- land: tsc --noEmit ---"
  if ! npx tsc --noEmit; then
    echo "ERROR: TypeScript errors. Fix before landing."; exit 1
  fi
  echo "--- land: npm test ---"
  if ! npm test -- --run; then
    echo "ERROR: tests failed. A red test must NOT reach main. Fix it,"
    echo "       or document a known skip in the PR body and get human sign-off."
    exit 1
  fi
  echo "--- land: npm run build ---"
  if ! npm run build; then
    echo "ERROR: next build failed. Fix before landing."; exit 1
  fi
  echo "--- land: verify gate passed ---"
fi

# --- 4. workflow-scope guard --------------------------------------------------
if git diff --name-only origin/main...HEAD -- .github/workflows/ | grep -q .; then
  echo "ERROR: this branch changes .github/workflows/* but the token lacks the"
  echo "       'workflow' scope — the push will be rejected by GitHub."
  echo "       Stage workflow files in ci-pending/ instead. Activation is a"
  echo "       one-time human step: gh auth refresh -s workflow."
  exit 1
fi

# --- 5. push branch + open PR (never merge) -----------------------------------
echo "--- land: pushing $BRANCH ---"
git push --set-upstream origin "$BRANCH"

if existing="$(gh pr view "$BRANCH" --json url --jq .url 2>/dev/null)" && [[ -n "$existing" ]]; then
  echo ""
  echo "PR already open for $BRANCH: $existing"
  echo "Branch updated. Notify the human integrator to review/merge. DO NOT self-merge."
  exit 0
fi

title="$(git log -1 --pretty=%s)"
body="$(printf 'Landed via scripts/land.sh from %s (%s).\n\n%b' "$BRANCH" "$REPO_ROOT" "$note")"
echo "--- land: opening PR ---"
url="$(gh pr create --base main --head "$BRANCH" --title "$title" --body "$body" | tail -n1)"
echo ""
echo "PR opened: $url"
echo "Notify the human integrator to review/merge in ~/Code/Agentic Trading."
echo "DO NOT merge it yourself. Merges are serialized by the integrator, one at a time."
```

---

## 3. scripts/githooks/pre-push

Create at `/Users/jay/apps/trading-claude/scripts/githooks/pre-push`, then `chmod +x`. The hook is shared across all worktrees via `core.hooksPath`, so a single file covers every agent and the integration worktree.

```bash
#!/usr/bin/env bash
# pre-push hook — last-line guard against the failures land.sh is meant to prevent,
# for pushes that bypass land.sh (raw `git push`).
#
# Installed via: git config core.hooksPath scripts/githooks  (set per-worktree by
# scripts/setup-agent-previews.sh). Shared by every worktree.
#
# Guard A: block any push from the ~/Code/Agentic Trading integration worktree.
# Guard B: block any push whose REMOTE ref is refs/heads/main (all push forms).
#
# Human-integrator escape (deliberate, named, noisy):
#   HOOKS_ALLOW_MAIN_PUSH=1 git push origin main
#
# Note: a determined caller can still pass `git push --no-verify` to skip this
# hook entirely — see AGENTS.md "honest limits". This stops confused agents, not
# deliberate bypass. It does NOT and cannot prevent file edits in a worktree.
set -euo pipefail

if [[ "${HOOKS_ALLOW_MAIN_PUSH:-0}" == "1" ]]; then
  echo "pre-push: HOOKS_ALLOW_MAIN_PUSH=1 — bypassing guards (human integrator override)."
  exit 0
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
REPO_ROOT="$(cd "$REPO_ROOT" && pwd -P)"
MAIN_WT="$(cd "$HOME/Code/Agentic Trading" 2>/dev/null && pwd -P || true)"

# --- Guard A: pushes from the integration worktree ----------------------------
if [[ -n "$MAIN_WT" && "$REPO_ROOT" == "$MAIN_WT" ]]; then
  echo ""
  echo "ERROR (pre-push): pushing from the main integration worktree is blocked."
  echo "  $REPO_ROOT is read + merge only. Agents work in ~/apps/trading-<name>."
  echo "  Human integrator deliberate push: HOOKS_ALLOW_MAIN_PUSH=1 git push ..."
  echo ""
  exit 1
fi

# --- Guard B: any push targeting refs/heads/main on the remote -----------------
# stdin lines: <local-ref> <local-sha> <remote-ref> <remote-sha>
while read -r local_ref local_sha remote_ref remote_sha; do
  if [[ "$remote_ref" == "refs/heads/main" ]]; then
    echo ""
    echo "ERROR (pre-push): direct push to 'main' is blocked."
    echo "  main is merge-only. Land via: bash scripts/land.sh  (opens a PR)."
    echo "  Agents create PRs; the human integrator merges, one at a time,"
    echo "  in ~/Code/Agentic Trading. See AGENTS.md 'Multi-agent landing protocol'."
    echo ""
    exit 1
  fi
done

exit 0
```

### Install commands (one-time, idempotent)

```bash
# Per worktree (relative path is correct because the hooks live in the repo):
git -C ~/apps/trading-claude       config core.hooksPath scripts/githooks
git -C ~/apps/trading-codex        config core.hooksPath scripts/githooks
git -C ~/apps/trading-antigravity  config core.hooksPath scripts/githooks
git -C ~/Code/"Agentic Trading"    config core.hooksPath scripts/githooks

# Make the hook executable (do this in the worktree that will commit the file):
chmod +x ~/apps/trading-claude/scripts/githooks/pre-push ~/apps/trading-claude/scripts/land.sh

# Or just re-run the bootstrap, which now does the per-worktree config for you:
bash ~/apps/trading-claude/scripts/setup-agent-previews.sh
```

### Lines to add to scripts/setup-agent-previews.sh

The `core.hooksPath` wiring is **already present** in the current `setup-agent-previews.sh` (lines 43–48 in the agent loop, lines 58–62 for the integration worktree) — no change needed there. Add only an executable-bit guarantee so a freshly checked-out worktree has runnable hooks. Insert immediately **before** the `for i in "${!NAMES[@]}"; do` loop (after line 23, `git -C "$REPO" fetch ...`):

```bash
# Ensure shared hooks + land.sh are executable (git preserves the bit once set,
# but a fresh checkout or a hand-edit may clear it).
chmod +x "$REPO/scripts/githooks/"* "$REPO/scripts/land.sh" 2>/dev/null || true
```

---

## 4. Q0 resolution

In `/Users/jay/apps/trading-claude/docs/open-questions-for-jay.md`, replace the entire `### Q0` block (lines 12–24) with the strike-through resolution below. Keep it in place (don't delete) so the paper trail survives.

```markdown
### Q0 — ⚠️ ~~Worktree collision: where should I keep working?~~ (RESOLVED 2026-06-21)
**Resolution — option (a) + (b), now enforced locally:** One agent per worktree;
**Claude works only in `~/apps/trading-claude` (branch `agent/claude`)** and never
edits, builds, or switches branches in the `main` integration worktree
(`~/Code/Agentic Trading`) — that worktree is read + merge only, owned by the human
integrator (Cursor). Work lands **via PR only**: run `bash scripts/land.sh` (fetch →
merge `origin/main` → tsc/test/build gate → push branch → open PR). **Agents never
merge to `main`; the human integrator merges PRs one at a time.** A `pre-push` hook
(`scripts/githooks/pre-push`, wired by `setup-agent-previews.sh`) blocks direct pushes
to `main` and pushes from the integration worktree. See AGENTS.md "Multi-agent landing
protocol".

~~**Context:** This session works in the `main` integration worktree, but a concurrent
agent is actively editing core files here (`strategy.ts`, `db.ts`, `policy.ts`,
`types.ts`, `red-team.ts` + a new `risk-breaker.ts`) — currently in a broken
intermediate state. That blocks my verify gate. Options: (a) move to my own worktree
and land via merge · (b) enforce one-agent-per-worktree · (c) pause until their WIP
lands.~~

**Honest limit:** local hooks stop *pushes*, not *file writes*. Nothing in git can
prevent an agent from editing files in the `main` worktree — that part is convention
(rule 3) plus, optionally, filesystem write-protection (see AGENTS.md "honest limits").
```

---

## 5. Residual gaps & honest limits

What convention + local hooks genuinely fix vs. what they cannot — be honest in the rollout note and STATUS.md rather than claiming the problem is "solved server-side."

**What this actually stops (confused agents, hooks installed, no `--no-verify`):**
- Accidental `git push origin main` (and every aliased form `HEAD:main`, `agent/x:main`) — Guard B.
- Any push originating from the `~/Code/Agentic Trading` worktree — Guard A.
- A red test / type error reaching `main` *through the land.sh path* — the gate runs before the PR.
- The "ff or PR self-merge" race — `land.sh` has no merge step and the protocol bans `gh pr merge`/`--auto`.

**What it CANNOT enforce, and why:**

1. **No server-side branch protection.** The repo is private on a plan without it (GitHub returns 403 "Upgrade to Pro"). So "require PR, no direct push, require up-to-date, merge queue" cannot be enforced on the server. A truly determined or buggy agent with push rights can still reach `origin/main`. Closing this needs **GitHub Pro/Team** (branch protection + a merge queue, which is the real serializer) — that single upgrade subsumes most of this scaffolding.

2. **`--no-verify` bypasses every local hook.** `git push --no-verify` skips `pre-push` entirely; there is no local way to forbid it. Mitigation is structural, not technical: agents only ever push their *own* `agent/<name>` branch, so a bypassed gate only pollutes that branch — the load-bearing gate is the human integrator merging deliberately in the `main` worktree. Rule 5 in AGENTS.md bans `--no-verify`; that's convention, not enforcement.

3. **`core.hooksPath` is per-worktree and not inherited.** A worktree created outside `setup-agent-previews.sh` (or a fresh re-bootstrap before the config line runs) starts with **no hooks at all** — bypass needs nothing, the hook simply isn't there. Mitigation: the bootstrap sets it idempotently, and "Before you start" tells agents to verify `git config core.hooksPath` prints `scripts/githooks`.

4. **Hooks fire on push, not on file write — so they cannot prevent Q0's actual damage.** The Q0 failure was *broken files in the `main` worktree*, which breaks others' `tsc`/`build` long before any push. No git mechanism prevents filesystem writes. Convention (rule 3) is the primary control. The only hard enforcement available is **filesystem-level**: either `chmod -R a-w ~/Code/"Agentic Trading"/src` (any write fails loudly; `git merge` still works via plumbing into tracked paths, and a human can `chmod +w` to integrate), or a per-tool deny rule (e.g. Claude Code `.claude/settings.json` / Cursor rules denying Edit/Write/Bash on that path). Both are aggressive; flag them as Jay's call, not something to enable silently.

5. **Branch-switching the `main` worktree is uncaught.** `git checkout`/`switch` fires no `pre-push` hook. Same filesystem-write-protection would block it; a `post-checkout` hook can only emit a loud warning, not prevent it.

6. **The merge race still exists at human cadence.** If the integrator merges two PRs back-to-back without re-fetching/re-gating between them, a bad interaction can still land. The control is procedural (merge one, let it settle, re-fetch) plus the optional integration-worktree gate below. A merge queue (GitHub Pro) is the only real fix.

7. **CI is inert until `workflow` scope is granted.** `.github/workflows/*` pushes are rejected (token lacks `workflow` scope); files sit in `ci-pending/`. Needs a one-time human `gh auth refresh -s workflow`. Until then there is **no server-side gate at all** — every gate is local and bypassable, which is exactly why the integration-worktree discipline matters.

**Highest-leverage addition beyond what's above (recommend to Jay):** an integration-worktree `pre-push` that runs `npm test` before any push to `origin/main`. It's the only gate that runs at the point that actually matters — right before code lands on `main`, by the actor who controls the merge — on the merged result rather than an agent's pre-merge branch. The shared `pre-push` already lives in that worktree; it currently *blocks* main pushes there. If Jay wants the integrator to push `main` directly (instead of via GitHub PR-merge), extend the `HOOKS_ALLOW_MAIN_PUSH=1` path to run the gate instead of skipping it.

---

## 6. Apply checklist

Ordered. Do this in the **`~/apps/trading-claude`** worktree (the canonical home of `scripts/`), on `agent/claude`, then land it like any other change.

1. **Create `scripts/land.sh`** (Section 2) and **`scripts/githooks/pre-push`** (Section 3). `chmod +x scripts/land.sh scripts/githooks/pre-push`.
2. **Edit `scripts/setup-agent-previews.sh`** — add the single `chmod +x` line before the worktree loop (Section 3). The `core.hooksPath` lines are already there; leave them.
3. **Edit `AGENTS.md`** (= `CLAUDE.md` symlink): adjust the two "How each agent works" bullets and the "Before you start" bullet, then paste the "Multi-agent landing protocol" section (Section 1).
4. **Resolve Q0** in `docs/open-questions-for-jay.md` (Section 4).
5. **Wire hooks into every worktree now:** `bash scripts/setup-agent-previews.sh` (idempotent; sets `core.hooksPath` for claude/codex/antigravity + the `main` worktree). Confirm: `git config core.hooksPath` prints `scripts/githooks` in each.
6. **Smoke-test the hook** without pushing anything real:
   - `git push --dry-run origin agent/claude` → allowed.
   - `git push --dry-run origin HEAD:main` → blocked by Guard B.
   - From `~/Code/Agentic Trading`: `git push --dry-run origin main` → blocked by Guard A; `HOOKS_ALLOW_MAIN_PUSH=1 git push --dry-run origin main` → allowed.
7. **Update handoff docs** per the Pre-Commit / Handoff Protocol: `STATUS.md`, a `docs/rollouts/2026-06-21-multi-agent-landing-protocol.md` note (summary, why, files, verification commands run, follow-ups = the residual gaps in Section 5), and `PLAN.md` if scope shifts.
8. **Land it:** `bash scripts/land.sh` → opens a PR. Notify Jay to merge.
9. **One-time, human, separate:** `gh auth refresh -s workflow`, then move `ci-pending/*.yml` into `.github/workflows/` and land via PR (Section 1 "CI workflow files"). Decide on the optional filesystem write-protection for the `main` worktree (Section 5, gap 4).

**How each agent picks it up:** once the PR merges to `main`, every agent gets `scripts/land.sh`, the hook, and the new AGENTS.md the next time it runs `git merge origin/main` (which `land.sh` does first, every run). Hooks become active the next time `setup-agent-previews.sh` runs in that worktree (or immediately via the per-worktree `git config core.hooksPath scripts/githooks` command). A fresh Claude session reads the updated AGENTS.md on startup; the new "Before you start" bullet makes it verify `core.hooksPath` before its first push.
```

Key files referenced (all absolute): `/Users/jay/apps/trading-claude/scripts/land.sh` (new), `/Users/jay/apps/trading-claude/scripts/githooks/pre-push` (new), `/Users/jay/apps/trading-claude/scripts/setup-agent-previews.sh` (one `chmod` line; hooksPath already wired at lines 43-48, 58-62), `/Users/jay/apps/trading-claude/AGENTS.md` (= CLAUDE.md symlink), `/Users/jay/apps/trading-claude/docs/open-questions-for-jay.md` (Q0, lines 12-24).