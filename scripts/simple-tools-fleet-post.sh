#!/usr/bin/env bash
# Retired compatibility path for the unchanged CI syntax check.
# Manual coordination uses shared simple-chat under a verified identity.
# Automated deploy alerts use the existing Sentry CI reporting pipeline.
printf '%s\n' '[fleet-post retired] No message was sent; use shared simple-chat for manual coordination; automated deploy alerts use Sentry CI reporting.' >&2
exit 2
