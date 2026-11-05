# 2026-08-02 — HANDOFF: MONET session stop (Codex remediation closeout + deploy-pipeline repair)

Session stopped ~05:40Z at owner instruction. **Clean stop: everything is merged or riding
an armed auto-merge; nothing is uncommitted; no watcher or background task of this session
is still running.** This note is the state map for whoever picks anything up.

## 1. Context & Objective

One session arc, three phases: (a) remediate the 2026-08-01 Codex external review
(30 findings) — completed jointly with ANTIGRAVITY, who landed the paused branch as
PR #2341 with genuine review; (b) root-cause and repair the production deploy freeze that
was masking everything (webhook HMAC mismatch); (c) root-cause the fleet-wide npm
`EALLOWSCRIPTS` install failure and forward-proof the fix for npm 12.

## 2. Final state (all verified, with receipts)

| Thread | State |
|---|---|
| 30-finding Codex remediation | **Merged (#2341) and VERIFIED LIVE in prod.** Triage record: 15 confirmed / 9 refuted / 6 not-real; refutation evidence preserved (see §6) |
| Deploy pipeline | **Repaired + proven 3x**: redelivered push → deployment → `verify-deploy-sha.sh 19dfd51b` PASS ~04:47Z; then TWO organic cutovers (`c117afb9` live ~05:35Z, uptime 716s at probe). `b7d88e42` (docs, #2348) builds next — builds serialize (~40 min each) |
| PR #2349 (npm-12-proof `allowScripts` key + record corrections) | **OPEN, auto-merge armed, branch reconciled with main** (it had gone DIRTY after #2348's squash; fixed with a plain merge, board files hand-deduped after). Lands + auto-deploys unattended when `verify` goes green |
| Plain `npm ci` | **Working** (exit 0, 575 pkgs, validated on the previously-failing Mac) |
| `/api/health` minimization (finding 27) | **Confirmed live**: unauthenticated payload 4KB → 2.2KB; USD balances + raw storage bytes gone; lease owner pid-stripped (`leaseOwnerWithoutPid`) — the earlier "residual" claim was WRONG (pre-deploy observation) and is retracted |

## 3. Decisions & Trade-offs (this session's judgment calls)

- **Webhook repair direction:** synced GitHub hook secret FROM Coolify's
  `manual_webhook_secret_github` (GitHub secrets are write-only, so Coolify's value is the
  only recoverable truth). Deleted duplicate hook 658869484 (GitHub itself proved it an
  exact duplicate by rejecting the same config twice). Redelivery used as verification —
  re-enacts the standing auto-deploy path; NOT a manual deploy trigger.
- **#2349 DIRTY fix:** plain `git merge origin/main` rather than rebase+force-push (the
  repo bans unconfirmed force-pushes). Union-merge duplicated 1 effort-log block; deduped
  by hand before pushing. 4 remaining same-title rows with differing bodies are
  pre-existing historical near-dupes on main — left alone deliberately.
- **npm root cause supersedes my own earlier record:** the stale-tag theory (recorded in
  STATUS.md by this seat, now corrected in #2349) was refuted by a 10-case isolated
  reproduction. Real triggers: `allow-scripts` in any `.npmrc`, or inherited
  `npm_config_allow_scripts` (upstream npm/cli#9783, open, unfixed through npm 12.0.2).

## 4. Verification State

```bash
# deploy chain
bash scripts/verify-deploy-sha.sh 19dfd51b   # PASS ~04:47Z (redelivered push)
# c117afb9 confirmed live ~05:35Z by direct /api/health probe (uptime 716s)
# npm (on the previously-failing Mac, node 24 PATH prefix)
npm ci --no-audit --no-fund                  # exit 0, 575 packages
npm install --no-audit --no-fund             # exit 0; git-dep coverage warning GONE post-key-change
npx tsc --noEmit                             # exit 0 on the #2349 branch
```

PR #2349 carries the full `verify` gate in CI (code-bearing change); it had not completed
at stop time — auto-merge handles it, no babysitting needed.

## 5. Next Steps & Blockers

**Nothing requires immediate agent action.** In descending priority:

1. **Owner questions (unchanged):** FMP subscription (plan probe 403); Massive plan tier;
   and the recurrence question from the webhook repair — if recreating the Coolify app
   regenerated `manual_webhook_secret_github`, the freeze recurs on the next recreate
   unless hook-secret re-sync joins the app-recreate recipe
   (`docs/rollouts/2026-08-02-deploy-webhook-secret-repair.md` §6).
2. **If #2349's verify fails** (unlikely — tsc clean, one-line package.json change +
   docs): fix on branch `monet/deploy-webhook-docs`, worktree
   `/private/tmp/monet-webhook-docs-wt` (still exists, deps installed; /private/tmp does
   not survive reboot — recreate from the remote branch if gone).
3. **Optional deploy sanity:** `bash scripts/verify-deploy-sha.sh` (defaults to
   origin/main) any time; it PASSes when live CONTAINS the expected commit. `b7d88e42`
   and later merges should flow unattended now.
4. **Before any npm 12 adoption:** cover the transitive `esbuild@0.18/0.25` install
   scripts in `allowScripts` (npm 12 hard-blocks uncovered scripts —
   `docs/rollouts/2026-08-02-npm-allowscripts-findings.md` §5).
5. **If EALLOWSCRIPTS ever returns:** `env | grep npm_config_allow_scripts` FIRST (this
   Mac had `npx`-launched processes exporting `npm_config_allow_scripts=@wasp.sh/wasp-cli`
   — any descendant shell fails every install); never add `allow-scripts` to `.npmrc`.

## 6. Pointers / cleanup notes

- **Peer lanes at stop:** the Connections-skeleton session ALSO closed out on the owner's
  stop-order — its work is parked in **draft PR #2350** (branch
  `monet/connections-route-skeleton`; impl + adversarial-review fixes done, `land.sh`
  full test+build NOT run; its own closeout gives the pickup command). `~/apps/trading-monet`
  is free again. The other MONET seat is on Congress.Trade applying the webhook-repair
  recipe there (relayed via #ag***-s**c).
- **Branches safe to delete** (both fully landed; deletion left to the owner per repo
  rule): `monet/codex-review-remediation` (landed as #2341),
  `monet/deploy-webhook-repair` (superseded by #2348/#2349).
  `monet/deploy-webhook-docs` deletes itself on #2349's merge.
- **Evidence preserved:** the 15 per-finding triage briefs (evidence + adversarial
  critiques) at `/Users/jay/apps/monet-triage-briefs-2026-08-01/`; npm reproduction cases
  in the session scratchpad (`npmrepro/case*`) — scratchpad is session-scoped, the
  findings are fully written up in the npm rollout note.
- **Session rollout notes, in order:** `2026-08-01-codex-review-remediation.md` →
  `2026-08-01-codex-review-remediation-handoff.md` (mid-session pause) →
  `2026-08-02-deploy-webhook-secret-repair.md` →
  `2026-08-02-npm-allowscripts-findings.md` → this note.
