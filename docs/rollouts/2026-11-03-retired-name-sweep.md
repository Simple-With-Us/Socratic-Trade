# 2026-11-03 - retired-name-sweep

## Summary

- Removed the retired two-part fleet name from this repository under the owner's fleet-wide directive (2026-11-03).  Functional carriers got real renames to the current fleet names; historical prose is masked (`ag***-s**c` style).
- The fleet post helper is renamed `scripts/ag***-s**c-fleet-post.sh` → `scripts/simple-tools-fleet-post.sh`.  It posts through `simple-chat` (PATH, then `~/.local/bin/simple-chat`), defaults to the `work-in-progress` channel, and reads the `FLEET_POST_*` env family (`FLEET_POST_REPO`, `FLEET_POST_SEAT`, `FLEET_POST_TOPIC`, `FLEET_POST_CHANNEL`, `FLEET_POST_BIN`) in place of the retired family.
- `scripts/install-fleet-coordination.sh` now installs `simple-chat` and `simple-board` plus `FLEET-PROTOCOL.md` from the fleet's current-tool-names AFC pin (`c74fb6fcd1c1462b69a18e9baa5240044768cf99`, the AFC tool-names branch head; advance the pin to that change's merge commit when it lands).  The archive layout at the pin was verified directly, and both CLIs pass `--help` installed through symlinks.
- No trading logic, order paths, or risk surfaces were touched; every change is ops tooling, CI config, or documentation.

## Why

- The retired name misleads agents reading the code: scripts, env names, and docs pointed at a coordination system that no longer exists under that name.  The owner directed removal everywhere, with real renames for functional carriers rather than cosmetic edits.

## Files

- Renamed: `scripts/ag***-s**c-fleet-post.sh` → `scripts/simple-tools-fleet-post.sh`; `test/agent-sync-fleet-post.test.ts` → `test/simple-tools-fleet-post.test.ts`; `docs/rollouts/2026-07-04-ag***-s**c-protocol-docs.md` → `docs/rollouts/2026-07-04-fleet-protocol-docs.md` (inbound link in `docs/reports/README.md` updated).
- Fleet post callers updated in the same change: `.github/workflows/ci.yml`, `.github/workflows/deploy-freshness.yml`, `scripts/alert-deploy-freshness.sh`, `scripts/sync-provider-knobs.sh`, `scripts/slack-sync.sh`, `scripts/com.jay.provider-knob-sync.plist`.
- Coordination naming: `scripts/install-fleet-coordination.sh`, `scripts/test-cloud-coordination-bootstrap.py`, `scripts/cloud-setup.sh`, `scripts/cursor-cloud-install.sh`, `scripts/cursor-cloud-start.sh`, `scripts/codex-coordination.sh`, `scripts/verify-deploy-sha.sh`, `scripts/github-actions-infisical-zulip-ops.sh`, `.claude/skills/pickup-seat/SKILL.md`, `docs/slack-coordination.md`, `docs/deployment.md`, `src/lib/simfin-provider.ts` (comment now names `FLEET-PROTOCOL.md`).
- Masked historical prose: `STATUS.md` (historical entries), `docs/EFFORT-LOG.md`, and the remaining `docs/` records (audits, design, handoffs, reports, reviews, rollouts).  `docs/EFFORT-LOG.md` is archived and normally not edited; the owner's blanket directive postdates that rule, so its occurrences are masked too and the choice is recorded here.

## Verification

- `python3 scripts/test-cloud-coordination-bootstrap.py` — 9 tests, OK (fresh install, pin change, failed-CLI preservation, Mac hook retirement, fail-closed stub).
- `bash -n` passes on every edited shell script; the launchd plist still parses as XML.
- Real AFC archive at the new pin contains `scripts/simple-chat`, `scripts/simple-board`, `FLEET-PROTOCOL.md`, `fleet-apps.json`, and `docs/protocols/zulip-fleet-guide.md`; both CLIs exit 0 on `--help`, directly and through symlinks.
- Post-change scan (`git grep -inE 'agent[-_ ]sync|agentsync'`) over tracked files returns only the documented exceptions below.
- Repo gate (`npm run lint`, `npx tsc --noEmit`, `npm test`, `npm run build`) and the hosted `verify` check gate the merge.

## Follow-ups

- Advance the AFC pin in `scripts/install-fleet-coordination.sh` to the tool-names change's merge commit once it lands on AFC main.
- Central stitch, sequenced after all consumers land: rename the shared project's token pair to the canonical names and convert the Congress.Trade registry entry.  ST's labels already carry the new names; nothing in ST code references the pair.

## Blockers

- Documented exceptions, not oversights.  (1) `scripts/ag***-s**c-bootstrap.sh` keeps its filename and its reference in `docs/slack-coordination.md` and `scripts/test-cloud-coordination-bootstrap.py`: it is a fail-closed compatibility stub whose job is to be found by old setup calls and refuse; only its message text was scrubbed.  This is the same exception class as a deny-list guard string.  (2) The shared Infisical token pair (live in the shared-at-ct project's prod environment, consumed by Congress.Trade and the shared library) is renamed centrally, not from this repo.  Its canonical new names are set fleet-wide — `FLEET_SYNC_TOKEN` and `FLEET_SYNC_POST_TOKEN` — and the three ST doc labels that referenced the pair (`AGENTS.md`, `.env.example`, `docs/secrets.md`) now carry those new names, ahead of the sequenced stitch that renames the keys inside the shared project and converts the Congress.Trade registry entry.  Until that stitch lands, the live keys still answer to the old (masked) names.  ST has no code consumer of the pair — the references were doc labels only — so no read-fallback code is needed in this repo.  Socratic-Trade's own prod project holds no keys in the retired family (verified by key listing, names only).
- The fleet post env rename is repo-internal: no Infisical project carries the old or new the retired env family/`FLEET_POST_*` posting variables for this app (the deploy-freshness workflow sets them inline; the plist supplies them on the Mac).
