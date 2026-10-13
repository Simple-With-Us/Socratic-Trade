#!/usr/bin/env bash
# Retired Slack bootstrap compatibility path.  Fail closed for old cloud setup calls.
# Fleet coordination now uses the pinned AFC clients via install-fleet-coordination.sh.
printf '%s\n' 'agent-sync-bootstrap.sh is retired.  Use scripts/install-fleet-coordination.sh and the current AGENT-SYNC protocol.' >&2
exit 1
