# Kody MiniMax Rollout

## Context & Objective

Jay requested that the Muse-backed autofix use MiniMax.  CTS-330 tracks the fleet rollout.

## Changes Made

- `.github/workflows/kody-fleet-autofix.yml`: select `MiniMax-M3` and update the displayed workflow name.
- `.github/workflows/sentry-ci-report.yml`: match the renamed workflow in the observer and its inventory comment.
- `AGENTS.md`: align the coordination instructions with Linear and archive the retired effort-log and Slack mechanisms.
- `STATUS.md`: record verification and landing status.
- `PLAN.md`: record the model-selection approach and unchanged product roadmap.
- `docs/rollouts/2026-10-11-kody-minimax.md`: preserve this change and verification record.

## Decisions & Trade-offs

Use `https://api.minimax.io/v1` with the organization `MINIMAX_API_KEY`, and advance the reusable-workflow pin to the reviewed direct-provider implementation.  Preserve the enabled profile, budget, attempt cap, path restrictions, and shared per-PR concurrency group.  The change selects a model; it does not widen autofix access.

## Verification State

- `git diff --check`: passed.
- `actionlint -shellcheck= -pyflakes= .github/workflows/kody-fleet-autofix.yml .github/workflows/sentry-ci-report.yml`: passed.
- `npx --yes --package vitest@5.0.1 -- vitest run test/sentry-ci-report-workflows.test.ts --config <temporary-node-only-config>`: 3 tests passed.  The temporary config contains `export default { test: { environment: 'node' } };` and avoids requiring the app dependency tree for this workflow-only test.
- Shared helper synthetic canary: a live MiniMax M3 response from the direct OpenAI-compatible endpoint parsed into an edit and applied successfully.  This proves API compatibility, not a production Kody fix.
- Hosted CI and current-head Codex review remain required before merge.

## Next Steps & Blockers

Land PR #4523 after review and required checks clear.  Preserve existing tracking for autofix execution issues; this provider change alone does not prove every bot is healthy.

## Zero-Code Findings

Renaming a workflow requires updating Sentry's `workflow_run.workflows` filter because it matches display names.

## Reproduce The Direct-Endpoint Canary

The final native-response helper is `59ae449dc93f691877f0fe8b58b43f6ca48e751d` in `Simple-With-Us/congress-trading-shared`.  Export only that helper into a scratch directory (not a Git checkout), install its locked dependencies, then submit a synthetic addition-function finding.  This sends no repository source and publishes nothing.  The command reads the existing key without printing it; the script prints only a pass/fail record.

```bash
CANARY_DIR="$(mktemp -d)"
export CANARY_DIR
git -C /Users/jay/apps/lanes/congress-trading-shared/codex-cts-330-kody-minimax archive 59ae449dc93f691877f0fe8b58b43f6ca48e751d .github/kody-autofix | tar -x -C "$CANARY_DIR"
npm ci --ignore-scripts --prefix "$CANARY_DIR/.github/kody-autofix"
MODEL_API_KEY="$(grep -m1 '^MINIMAX_API_KEY=' /Users/jay/.secrets/global-api-keys | cut -d= -f2- | tr -d '"')" node --input-type=module <<'JS'
import assert from 'node:assert/strict';
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
JS
```
