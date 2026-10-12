# Kody MiniMax Rollout

## Context & Objective

Jay requested that the Muse-backed autofix use MiniMax.  CTS-330 tracks the fleet rollout.

## Changes Made

- `.github/workflows/kody-fleet-autofix.yml`: select `MiniMax-M3` and update the displayed workflow name.
- `.github/workflows/sentry-ci-report.yml`: match the renamed workflow in the observer and its inventory comment.
- `AGENTS.md`: align the coordination instructions with Linear and archive the retired effort-log and Slack mechanisms.
- `scripts/claude-hooks/board-check.sh`: retain the installed hook path as a no-op so the retired effort-log gate cannot block pushes.
- `scripts/cloud-setup.sh`, `scripts/cursor-cloud-start.sh`, and `scripts/cursor-cloud-install.sh`: stop installing the retired Slack coordination hook in cloud sessions.
- `STATUS.md`: record verification and landing status.
- `PLAN.md`: record the model-selection approach and unchanged product roadmap.
- `docs/rollouts/2026-10-11-kody-minimax.md`: preserve this change and verification record.

## Decisions & Trade-offs

Use `https://api.minimax.io/v1` with the organization `MINIMAX_API_KEY`, and advance the reusable-workflow pin to the reviewed direct-provider implementation.  Preserve the enabled profile, budget, attempt cap, path restrictions, and shared per-PR concurrency group.  The change selects a model; it does not widen autofix access.

## Verification State

- `npm run lint` -> n/a — shell/workflow/docs-only changes; no linted app source changed.
- `npx tsc --noEmit` -> n/a — no TypeScript changed.
- `npm test` -> n/a — app tests do not cover these shell and documentation paths; focused shell/contract checks are listed below.
- `npm run build` -> n/a — no app source or build configuration changed.

Focused verification:

- `git diff --check`: passed.
- `bash -n scripts/claude-hooks/board-check.sh scripts/cloud-setup.sh scripts/cursor-cloud-start.sh scripts/cursor-cloud-install.sh`: passed.
- Retired-hook push probe with synthetic hook input: allowed with no denial output.
- Cloud-bootstrap source scan: none of the three setup scripts installs `setup-slack-sync.sh`.
- `actionlint -shellcheck= -pyflakes= .github/workflows/kody-fleet-autofix.yml .github/workflows/sentry-ci-report.yml`: passed.
- `npx --yes --package vitest@5.0.1 -- vitest run test/sentry-ci-report-workflows.test.ts --config <temporary-node-only-config>`: 3 tests passed.  The temporary config contains `export default { test: { environment: 'node' } };` and avoids requiring the app dependency tree for this workflow-only test.
- Shared helper synthetic canary: a live MiniMax M3 response from the direct OpenAI-compatible endpoint parsed into an edit and applied successfully.  This proves API compatibility, not a production Kody fix.
- Hosted CI and current-head Codex review remain required before merge.

## Next Steps & Blockers

Land PR #4523 after review and required checks clear.  Preserve existing tracking for autofix execution issues; this provider change alone does not prove every bot is healthy.

## Zero-Code Findings

Renaming a workflow requires updating Sentry's `workflow_run.workflows` filter because it matches display names.

## Reproduce The Direct-Endpoint Canary

Native M3 uses the documented non-thinking mode to avoid upstream MiniMax-M3 issue 28 answer truncation.  The final native-response helper is `b1503884e547a8fb5d1449a94e03cae8c496da4c` in `Simple-With-Us/congress-trading-shared`.  Export only that helper into a scratch directory (not a Git checkout), install its locked dependencies, then submit a synthetic addition-function finding.  This sends no repository source and publishes nothing.  The command reads the existing key without printing it; the script prints only a pass/fail record.

```bash
CANARY_DIR="$(mktemp -d)"
export CANARY_DIR
git -C "${CONGRESS_TRADING_SHARED_LANE:?set the shared-repo lane path in this shell}" archive b1503884e547a8fb5d1449a94e03cae8c496da4c .github/kody-autofix | tar -x -C "$CANARY_DIR"
npm ci --ignore-scripts --prefix "$CANARY_DIR/.github/kody-autofix"
python3 - <<'PY'
import os
import shlex
import subprocess
from pathlib import Path

secret_file = Path.home() / ".secrets" / "global-api-keys"
model_api_key = None
for line in secret_file.read_text().splitlines():
    if line.startswith("MINIMAX_API_KEY="):
        values = shlex.split(line.partition("=")[2], comments=False, posix=True)
        if len(values) != 1 or not values[0]:
            raise SystemExit("MINIMAX_API_KEY entry is malformed.")
        model_api_key = values[0]
        break
if model_api_key is None:
    raise SystemExit("MINIMAX_API_KEY is missing from the secret file.")

env = os.environ.copy()
env["MODEL_API_KEY"] = model_api_key
node_script = r'''import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const {providerFrom, chatRequest, requestEdits, applyEdits} = await import(pathToFileURL(`${process.env.CANARY_DIR}/.github/kody-autofix/fleet.mjs`));
const snapshot = {profile:'web', prefixes:['src/'], findings:[{path:'src/add.ts',line:1,body:'Return a + b instead of a - b.'}], files:[{path:'src/add.ts',content:'export const add = (a, b) => a - b;\n'}]};
const provider = providerFrom({KODY_MODEL:'MiniMax-M3',KODY_MODEL_BASE_URL:'https://api.minimax.io/v1'});
try {
  const answer = await requestEdits(process.env.MODEL_API_KEY, provider, chatRequest(provider.model,snapshot));
  const changed = applyEdits(snapshot,answer);
  assert.equal(changed.length,1);
  assert.match(changed[0].content,/a\s*\+\s*b/);
  console.log(JSON.stringify({ok:true,model:provider.model,endpoint:provider.url,synthetic:true,published:false}));
} catch { console.error('Synthetic MiniMax canary failed.'); process.exitCode=1; }
'''
subprocess.run(["node", "--input-type=module", "-e", node_script], env=env, check=True)
PY
```

## Cloud Setup Review Follow-up (2026-10-12)

- `scripts/install-fleet-coordination.sh` includes `AGENT-SYNC.md`, `fleet-apps.json`, and protocol documents from the pinned AFC revision alongside both stdlib-only clients.  It checks Python 3.11 and CLI imports before marking the cache installed.
- `scripts/setup-slack-sync.sh` is now an idempotent retirement helper.  It removes only Slack entries inside SessionStart groups and the copied Slack engine; unrelated hooks and settings remain intact.  Malformed settings or symlinks fail without replacement.
- `scripts/cloud-setup.sh`, `scripts/cursor-cloud-install.sh`, and `scripts/cursor-cloud-start.sh` report coordination failure as a fleet-work blocker.  Cursor no longer probes retired relay entry points.
- `AGENTS.md` documents the Linux protocol location, PATH, runtime credential names, identity checks, and authorized Linear write switch.  Credentials are provisioned separately; no personal-owner token is allowed.
- `scripts/test-cloud-coordination-bootstrap.py` covers isolated first install, cached cleanup, mixed hooks, malformed settings, symlinks, and failed fetches.
- `STATUS.md` and `PLAN.md` record this follow-up.  The Mac on-demand helper inventory and its living Apple Note also identify these cloud-only helpers; no Mac setup or daemon was run.

Verification:

```bash
python3 scripts/test-cloud-coordination-bootstrap.py
bash -n scripts/install-fleet-coordination.sh scripts/setup-slack-sync.sh scripts/cloud-setup.sh scripts/cursor-cloud-start.sh scripts/cursor-cloud-install.sh
git diff --check
```

All five isolated tests and shell/diff checks passed.  A real pinned-source install used isolated `FLEET_COORD_CACHE`, `FLEET_COORD_BIN`, and `CLAUDE_CONFIG_DIR` directories plus a test `uname` reporting Linux.  Both installed `--help` commands and `agent_sync.identity.strict_seat("CODEX")` passed without credentials or service calls.  The archive download is the only network action in this smoke test.  Runtime authentication remains an operator prerequisite, not a claimed test result.

## Cache Review Follow-up (2026-10-12)

Preserved PR Autofix commits `a731afc26` and `26d57aef2` and merged current main.  `scripts/install-fleet-coordination.sh` retires obsolete hooks before its Mac return, extracts into a clean sibling directory, validates CLI imports before promotion, and retains the previous installation on validation failure.  Replacement uses two same-filesystem renames, not an atomic transaction.  The old directory remains recoverable until promotion succeeds.

`scripts/test-cloud-coordination-bootstrap.py` adds Mac retirement, removed-file pruning on pin advance, and failed-import preservation coverage.  `STATUS.md` and `PLAN.md` reflect this follow-up.  The on-demand Mac helper inventory is corrected to describe Mac retirement; no live Mac setup was run.

Verification: `python3 scripts/test-cloud-coordination-bootstrap.py` passes eight tests; `bash -n scripts/install-fleet-coordination.sh scripts/setup-slack-sync.sh` and `git diff --check` pass.  `npm run lint`, `npx tsc --noEmit`, `npm test`, and `npm run build` were not rerun locally for this shell-only follow-up; fresh hosted required checks remain mandatory.  Current-head Codex review is also pending, so this is not a completed rollout.
