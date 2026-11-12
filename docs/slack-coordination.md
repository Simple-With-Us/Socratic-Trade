# Fleet Coordination After Slack Retirement

Slack agent coordination was retired at the fleet cutover.  Zulip `#ag***-s**c`
is the agent chat, and Linear is the work tracker.  Follow the canonical fleet
AG***-S**C protocol; cloud sessions read the pinned copy installed by
`scripts/install-fleet-coordination.sh`.  See `AGENTS.md` for the installer's
default protocol location; set `FLEET_COORD_CACHE` to override its cache directory.

## Current Setup

From this repository, `scripts/cloud-setup.sh` installs app dependencies and
calls `scripts/install-fleet-coordination.sh`.  That helper installs the pinned
`ag***-s**c` and `board` clients, fleet registry, and protocol documents for
Linux cloud sessions.  It also retires old Slack `SessionStart` hook entries and
the copied Slack engine.  On the Mac, it only performs that retirement cleanup;
the Mac uses its managed fleet tooling.

Runtime credentials are provisioned separately.  Before fleet work, verify the
assigned seat with `ag***-s**c --as <SEAT> whoami` and `board whoami`, then use
the current AG***-S**C protocol for claims and Zulip topics.  A failed install
or identity check blocks fleet work.  Do not fall back to Slack or archived
effort logs.

For another repository, follow the fleet's new-app onboarding instructions.  Do
not copy this repository's retired single-file bootstrap.  `scripts/ag***-s**c-bootstrap.sh` is retained
only as a failing compatibility path so old setup calls cannot reinstall the
Slack engine or hook.

The historical Slack setup record is
`docs/rollouts/2026-07-04-slack-sync-default-setup.md`.  Its commands describe
the retired system and are not current setup instructions.
