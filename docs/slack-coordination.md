# Fleet Coordination After Slack Retirement

Slack agent coordination was retired at the fleet cutover.  Zulip `#agent-sync`
is the agent chat, and Linear is the work tracker.  The canonical rules are in
`/Users/jay/apps/AGENT-SYNC.md`; cloud sessions use the pinned copy installed at
`~/.cache/ai-fleet-coordinator/AGENT-SYNC.md`.

## Current Setup

From this repository, `scripts/cloud-setup.sh` installs app dependencies and
calls `scripts/install-fleet-coordination.sh`.  That helper installs the pinned
`agent-sync` and `board` clients, fleet registry, and protocol documents for
Linux cloud sessions.  It also retires old Slack `SessionStart` hook entries and
the copied Slack engine.  On the Mac, it only performs that retirement cleanup;
the Mac uses its managed fleet tooling.

Runtime credentials are provisioned separately.  Before fleet work, verify the
assigned seat with `agent-sync --as <SEAT> whoami` and `board whoami`, then use
the current AGENT-SYNC protocol for claims and Zulip topics.  A failed install
or identity check blocks fleet work.  Do not fall back to Slack or archived
effort logs.

For another repository, use the fleet onboarding instructions in
`AI-Fleet-Coordinator/docs/ONBOARDING-NEW-APP.md`.  Do not copy this repository's
retired single-file bootstrap.  `scripts/agent-sync-bootstrap.sh` is retained
only as a failing compatibility path so old setup calls cannot reinstall the
Slack engine or hook.

The historical Slack setup record is
`docs/rollouts/2026-07-04-slack-sync-default-setup.md`.  Its commands describe
the retired system and are not current setup instructions.
