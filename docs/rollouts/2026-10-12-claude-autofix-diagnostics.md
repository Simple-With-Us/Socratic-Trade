# Claude Autofix Diagnostics

## Context And Objective

OPS-935 found Claude Code Autofix runs exhausting the 60-turn cap without retained tool-level evidence.  This caller opts into the shared sanitized diagnostics workflow so the next eligible run can be inspected.

## Changes Made

- `.github/workflows/claude-code-autofix.yml`: pin the reusable workflow to `3bff293b56adcc0367d3a91066938b2d4d5ebbc5`.
- `STATUS.md`, `PLAN.md`, and this rollout note: record scope, dependency, and verification.

The shared helper retains fixed tool names/categories, assistant-message indexes, counts, repeat groups, categorized errors, byte lengths, and aggregate duration/turn counts.  It excludes raw prompts, commands, arguments, paths, tool IDs, results, and model text.  Retention is seven days, bounded to 500 event rows and 256 KiB.  Hard runner termination may prevent upload; per-tool elapsed timestamps are unavailable.

## Decisions And Trade-offs

Keep the 60-turn cap, MiniMax model route, permissions, concurrency, and triggers unchanged.  The caller revision and its helper must be retained as ancestors of shared main, requiring a merge commit for shared PR #365.  Linear is the system of record; archived effort logs are not edited.

## Verification State

- `actionlint .github/workflows/claude-code-autofix.yml`: passed.
- `git diff --check`: passed.
- Shared tests: 14 Node tests and 463 package tests with coverage passed; typecheck and build passed.
- [Hosted synthetic validation](https://github.com/Simple-With-Us/congress-trading-shared/actions/runs/38210165662): passed, including artifact upload after a simulated failure.  The downloaded 596-byte JSON passed independent count, result, size, and private-content sentinel assertions.
- No paid provider call or old autofix run was dispatched for this change.  Application code is unchanged; current-head required CI remains the merge gate.

### Exact Shared Validation Commands

Run from the shared repository checkout at reusable revision `3bff293b56adcc0367d3a91066938b2d4d5ebbc5`:

```sh
npm ci  # Includes the prepare script: npm run build.
npm test -- --coverage
npm run typecheck
node --test .github/actions/autofix-diagnostics/test/reduce.node-test.mjs .github/autofix-diagnostics-workflow.node-test.mjs
actionlint -color .github/workflows/autofix-diagnostics-validation.yml .github/workflows/codex-autofix-reusable.yml
git diff --check
```

The initial package checks passed before the diagnostics-only review fixes.  The final shared revision's hosted CI and diagnostic validation also passed.  Artifact inspection used the following download and assertions:

```sh
artifact_dir="$(mktemp -d)"
gh run download 38210165662 -R Simple-With-Us/congress-trading-shared --name autofix-diagnostics-smoke-38210165662-1 --dir "$artifact_dir"
python3 - "$artifact_dir/diagnostics.json" <<'PYTHON'
import json, sys
from pathlib import Path
raw = Path(sys.argv[1]).read_text()
data = json.loads(raw)
assert len(raw.encode()) <= 262144
assert not any(s in raw for s in ["SYNTHETIC_PRIVATE_VALUE_DO_NOT_RETAIN", "npm test", "local1"])
assert data["result"] == {"subtype": "error_max_turns", "is_error": True, "duration_ms": 1234, "num_turns": 61}
assert data["counts"]["tool_uses"] == data["counts"]["tool_results"] == 1
assert len(data["events"]) == 2
PYTHON
```

## Next Steps And Blockers

Merge [shared PR #365](https://github.com/Simple-With-Us/congress-trading-shared/pull/365) while preserving both pins.  Then merge this PR after current-head review and required checks pass.  OPS-935 remains open until a real eligible run provides useful diagnostics and the underlying turn exhaustion is addressed.

## Zero-Code Findings

The old logs cannot identify which tools consumed the exhausted budgets.  Diagnostics capture is not proof that the underlying autofix failure has been repaired.
