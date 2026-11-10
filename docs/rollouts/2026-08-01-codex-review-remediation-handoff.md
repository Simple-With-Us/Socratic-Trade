# 2026-08-01 — HANDOFF: Codex external-review remediation (MONET) — PAUSED BY OWNER

Branch `monet/codex-review-remediation` · worktree `~/apps/trading-monet` · base `origin/main` at
`88e614d7` (origin/main has since advanced to `ad1c1d5c`).

**Status: paused mid-flight at owner instruction. Wave 1 is committed. Wave 2 is on disk,
uncommitted and completely unreviewed. Nothing has been pushed. No PR exists.**

Companion note (wave 1 detail): `docs/rollouts/2026-08-01-codex-review-remediation.md`.

## 1. Context & Objective

The owner supplied a 30-finding external review from Codex and asked for those issues resolved
plus anything else worth fixing. The review was written against `6c179a3f`; `main` had moved on,
so step one was separating what is still true from what was already fixed or never right.

## 2. What exists right now

### Wave 1 — COMMITTED as `e7a1b65c` (local only, not pushed)

Findings 25, 4, 29 (code half), 19, 18, 30. Detail in the companion note. Gates at commit time:
`tsc --noEmit` clean, 28/28 targeted tests, `ci.yml` job graph asserted by parsing the YAML.

### Wave 2 — UNCOMMITTED, UNREVIEWED, ON DISK

Six implementation agents were running in parallel over disjoint file slices when the owner
paused the session. **All six were stopped mid-flight; none of them reported back, and the
adversarial review phase never ran.** Their edits are on disk. Treat every line as a draft by an
author who never got to say "done".

| Finding(s) | Files (M = modified, N = new) |
|---|---|
| **3** stale `running` mobile commands | M `src/lib/mobile-api.ts`, M `src/lib/scheduler.ts`, N `test/stale-mobile-commands.test.ts` |
| **27** public `/api/health` over-share | M `app/api/health/route.ts`, M `test/trading-liveness.test.ts`, N `test/health-route-exposure.test.ts` |
| **1** deploy SHA verification | N `scripts/verify-deploy-sha.sh`, N `scripts/verify-deploy-sha.selftest.sh` |
| **17** failed-run cause in place | M `app/console/page.tsx`, N `app/console/lib/last-run.ts`, N `test/console-last-run.test.ts` |
| **20** Activity tab semantics | M `app/console/activity/page.tsx`, N `app/console/lib/tabs.ts`, N `test/console-tabs-keyboard.test.ts` |
| **24** admin transcript preview | M `app/admin/transcript/transcript-client.tsx`, M `app/admin/page.tsx`, N `app/admin/transcript/long-turn.ts`, N `test/admin-transcript-preview.test.tsx` |
| **6, 23** alerts as incidents / capped counts | M `src/lib/db-health.ts`, M `app/console/components/alert-center.tsx`, M `app/admin/connections/connections-health-client.tsx`, M `test/connection-health-routing.test.ts`, N `test/alert-center-incident-grouping.test.ts`, N `test/health-lane-cap.test.ts` |
| **14** focus trap/restore | M `app/console/ui/symbol-drawer.tsx`, M `app/console/components/consent-gate.tsx`, M `app/console/components/command-palette.tsx`, N `app/console/ui/focus-trap.ts`, N `test/console-focus-trap.test.ts` |
| **16** + `/console/usage` unblock (mine, not an agent's) | M `app/console/components/shell.tsx` |
| **30** (remainder, mine) | M `STATUS.md`, M `PLAN.md`, M `docs/EFFORT-LOG.md` |

Totals: 18 modified, 14 new, of which 9 are new test files.

## 3. Decisions & Trade-offs

- **`/api/health` finding 27 was scoped deliberately.** The endpoint is simultaneously an external
  uptime probe, an operator diagnostic, and (now) the input to deploy verification. The agent was
  instructed to keep binary liveness and `release.sha` public and move only the sensitive
  *numbers* (OpenRouter USD balance, raw storage bytes, scheduler lease owner) behind the existing
  `OPS_DIAGNOSTIC_TOKEN` / `x-ops-token` convention rather than inventing a second auth scheme.
  **Unverified — confirm the uptime probe's contract did not change.**
- **Finding 7 was deliberately NOT implemented as specified.** The proposed shell/page data split
  (new endpoint, second snapshot type, subscriber refcount, re-typing 8 chrome components) was
  rejected on adversarial review: it lands almost entirely in `useConsoleData.tsx`, whose
  abort/coalesce/deadline machinery is documented as the fix for a real production hang, and the
  benefit collapses to a single route because Connections genuinely needs the full snapshot. Took
  the surgical alternative instead: `/console/usage` (the one genuinely snapshot-free route,
  verified) renders immediately via an allowlist in `shell.tsx`. Server-side snapshot memoization
  was considered and **rejected** — a TTL cache would serve stale data to the post-mutation
  `refresh()`, which is a money-path correctness risk for a modest cost win.
- **Finding 18 was inverted on purpose.** The review asked for fail-closed; that would let one
  flaky `/api/chat/providers` response lock the user out of Coach entirely, which is the
  paternalism AGENTS.md rejects. Fixed the honesty defect instead (an empty status map was
  indistinguishable from "everything has a key").
- **`merge=union` was kept.** It is the reason the board files corrupt, but removing it resurrects
  the auto-merge-conflict storm it was added to stop. Flagged for an owner decision, not changed.
- **No provider credential was created, rotated, or inspected.** FMP 403 and the Massive history
  cap are owner decisions.
- **iOS/native untouched.** Findings 9/10/11/12/13 were refuted or owner-blocked.

## 4. Verification State

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"   # REQUIRED: default node is v26, ABI-breaks better-sqlite3
cd ~/apps/trading-monet
npx tsc --noEmit     # exit 0, zero diagnostics - run AFTER the pause, so it covers wave 2 as it stands
```

- **`tsc --noEmit`: CLEAN across the full interrupted tree.** The wave-2 work compiles.
- **`npm test`: NOT RUN against wave 2.** The 9 new test files have never been executed by me.
- **`npm run lint`: NOT RUN against wave 2.**
- **`npm run build`: NOT RUN at all this session** (the one attempt failed on an empty
  `node_modules` before deps were fixed — see the blocker below).
- **`scripts/verify-deploy-sha.sh` WAS smoke-tested by hand** and behaves correctly on both paths:
  ```
  DEPLOY_VERIFY_TIMEOUT_SECONDS=0 bash scripts/verify-deploy-sha.sh            # exit 3, correctly reports drift
  DEPLOY_VERIFY_TIMEOUT_SECONDS=0 bash scripts/verify-deploy-sha.sh d456ca58   # exit 0, PASS
  ```
  It is pure ASCII (checked) and executable. Note it requires `jq`.

**Compiling is not passing.** Nobody has reviewed wave 2, and its tests have never run.

## 5. Next Steps & Blockers

### To resume, in this order

1. `export PATH="/opt/homebrew/opt/node@24/bin:$PATH"` — non-negotiable.
2. Run the full gate on wave 2 as it stands: `npm run lint`, `npx tsc --noEmit`, `npm test`,
   `npm run build`. Expect failures; nothing here has been reviewed.
3. **Adversarially review each wave-2 slice before trusting it.** Highest scrutiny, in order:
   - **Finding 3 (`mobile-api.ts` + `scheduler.ts`) — money path.** A stranded `proposal.approve`
     may have already crossed the broker submission boundary. The failure text it writes MUST say
     the outcome is *unknown* and direct the operator to verify orders. If it says the command
     "failed", that is a lie that invites a duplicate order — treat as a blocker.
   - **Finding 27 (`/api/health`)** — confirm the external uptime probe's contract is intact and
     that the degraded/503 semantics are unchanged (a 503 here triggers a container restart loop).
   - **Findings 6/23** — confirm required-vs-optional lane classification came from the repo's own
     definitions, not the agent's opinion.
4. Merge `origin/main` (now `ad1c1d5c`, 5+ commits ahead) — **and see the union-merge trap below.**
5. Then `bash scripts/land.sh`.

### Trap that WILL bite on the merge

`.gitattributes` sets `merge=union` on `STATUS.md`, `PLAN.md`, and `docs/EFFORT-LOG.md`. This
branch **rewrote** `STATUS.md` wholesale, and two PRs already on `main` (`ad1c1d5c`, `39785370`)
also touched it and `docs/EFFORT-LOG.md`. Union-merge does not conflict — it concatenates both
sides. So merging `origin/main` will splice the old changelog back into the new snapshot and
re-duplicate effort-log rows. **After merging, re-read all three board files and clean them by
hand before pushing.** This is the exact failure mode finding 30 is about; do not let the fix
reintroduce the bug.

### Blockers

1. **PRODUCTION IS NOT DEPLOYING — owner action required.** `/api/health` reported `d456ca58` for
   over an hour while `main` advanced `88e614d7` → `ad1c1d5c`. That is 5+ merged commits not
   running. `processUptimeSeconds` was 16,673 with no restart in the window, so **no deploy ever
   started** — this is not a slow build. Likely an undelivered GitHub webhook or a zombie
   `in_progress` deployment wedging the queue; both need the owner at the Coolify dashboard.
   Agents must NOT hand-trigger a deploy (manual triggers/claims are retired protocol).
   **Until this clears, merging to `main` is not evidence that anything shipped.**
2. **`npm install` and `npm ci` both fail on npm 11.16, for every agent lane on this machine.**
   Preparing the `congress-trading-shared` git dependency fails with
   `EALLOWSCRIPTS: --allow-scripts is not allowed in project-scoped installs` — npm passes that
   flag to its own nested preparation install, and the `allowScripts` field already in
   `package.json` does not satisfy it. **The failure leaves `node_modules` empty**, which looks
   exactly like the disk janitor reaping it. Working command today:
   ```bash
   npx -y npm@10 ci --no-audit --no-fund
   ```
   CI is unaffected (`ubuntu-latest` + `actions/setup-node`). Needs a durable fix — pinning
   `packageManager` or vendoring the shared package are the candidates.
3. Owner decisions pending: FMP subscription (plan probe 403), Massive plan tier (history capped
   to ~2y), and whether `STATUS.md` should keep `merge=union` now that it is a snapshot.

## 6. Zero-Code Findings

- **Triage receipts.** All 30 findings were re-derived against current `main` by a 31-agent
  workflow (6-cluster triage, then one adversarial verifier per claim, instructed to default to
  *refuted*): **15 confirmed REAL, 9 refuted, 6 not-real.** Per-finding evidence, proposed fixes,
  and the verifier critiques are in
  `/private/tmp/claude-501/-Users-jay-Code-Socratic-Trade/1c771212-a719-4ee8-b084-d94334296f66/scratchpad/briefs/finding-*.md`
  (session-scoped — copy anything you want to keep before the scratchpad is reaped).
- **Refutations worth not re-litigating:** #2 (the run row IS persisted synchronously before the
  202; only an unused empty `runId` survives), #18 (fail-open is deliberate), #19 (only 5 of the 6
  admin probes are operator-gated, so the threshold was right), #29 docs half (already fixed
  2026-07-31 — the stale text the reviewer quoted is what the *main integration worktree* shows,
  because it is 5 commits behind `origin/main`), #10/#12/#13 (refuted on mechanism).
- **The peer claim on `ios/**` and "command terminal reconciliation" was stale.** Its worktree
  (`~/apps/socratic-mobile-first-ios`) does not exist and no such work is in this repo's history;
  the claim misattributed PR #2274, which is about broker orders in the mobile snapshot.
- **Root cause of finding 30 that the review did not name:** `.gitattributes` `merge=union`.
