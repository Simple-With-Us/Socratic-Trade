#!/usr/bin/env python3
"""
sentry-ci-report.py — reports CI workflow outcomes to the shared fleet-infra
Sentry project (org jays-services), via raw envelope HTTP (no sentry-sdk
dependency, no GitHub Actions marketplace action).

Invoked by .github/workflows/sentry-ci-report.yml, which listens for
`workflow_run: types: [completed]` across every other workflow in this repo
and sets the env vars this script reads. This script itself does not know
about GitHub Actions beyond reading those env vars — all the wiring lives in
the workflow file.

Two independent signals are sent per completed run:
  1. If conclusion == "failure": a Sentry error event tagged with
     {workflow, branch, actor}, carrying the run URL, fingerprinted on
     [workflow, branch] so repeated failures on the same branch/workflow
     group into one Sentry issue instead of paging separately every time.
  2. If the run was schedule-triggered (event == "schedule"): a Sentry Crons
     check-in (status "ok" on success, "error" otherwise) with an upsert
     monitor_config whose schedule mirrors that workflow's own cron
     expression (see CRON_SCHEDULES below) so a nightly/weekly job that
     silently STOPS running raises a missed-check-in alert.

Secrets: SENTRY_FLEET_DSN is read only from the environment (set by the
workflow from the repo secret) and is NEVER printed or logged in any form,
including in exception messages.
"""

from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone

# Cron expressions mirrored from each source workflow's own `schedule:` block.
# Keep in sync if those workflows' schedules ever change. Workflows not
# listed here have no `schedule:` trigger and will simply be skipped for the
# check-in step (they can still send a failure event on other trigger types).
CRON_SCHEDULES = {
    "Security": "41 10 * * 1",
    "Playwright Smoke": "17 9 * * 1",
    "Shared package pin check": "0 13 * * 1",
}


def slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    slug = re.sub(r"-+", "-", slug)
    return slug


def parse_dsn(dsn: str) -> tuple[str, str, str]:
    """Parse a Sentry DSN into (public_key, host, project_id). Raises ValueError
    without ever including the raw DSN in the message."""
    m = re.match(r"^https://([^@]+)@([^/]+)/(.+)$", dsn.strip())
    if not m:
        raise ValueError("SENTRY_FLEET_DSN is not in the expected https://<key>@<host>/<project> shape")
    return m.group(1), m.group(2), m.group(3)


def send_envelope(envelope_url: str, auth_header: str, item_type: str, item_payload: dict) -> None:
    item_body = json.dumps(item_payload).encode("utf-8")
    envelope_header = json.dumps({"sent_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}).encode("utf-8")
    item_header = json.dumps({"type": item_type, "length": len(item_body)}).encode("utf-8")
    body = envelope_header + b"\n" + item_header + b"\n" + item_body + b"\n"

    req = urllib.request.Request(
        envelope_url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/x-sentry-envelope",
            "X-Sentry-Auth": auth_header,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            print(f"Sentry envelope POST ({item_type}) -> HTTP {resp.status}")
    except urllib.error.HTTPError as exc:
        # Never fail the reporter job over a Sentry-side hiccup; print details for debugging.
        detail = exc.read().decode("utf-8", errors="replace")[:500]
        print(f"::warning::Sentry envelope POST ({item_type}) failed: HTTP {exc.code}: {detail}")
    except urllib.error.URLError as exc:
        print(f"::warning::Sentry envelope POST ({item_type}) failed: {exc.reason}")


def main() -> int:
    dsn = os.environ.get("SENTRY_FLEET_DSN", "").strip()
    workflow_name = os.environ.get("WORKFLOW_NAME", "unknown")
    conclusion = os.environ.get("WORKFLOW_CONCLUSION", "unknown")
    event = os.environ.get("WORKFLOW_EVENT", "unknown")
    branch = os.environ.get("WORKFLOW_BRANCH", "unknown")
    actor = os.environ.get("WORKFLOW_ACTOR", "unknown")
    run_url = os.environ.get("WORKFLOW_RUN_URL", "")
    run_id = os.environ.get("WORKFLOW_RUN_ID", "")

    if not dsn:
        print("::warning::SENTRY_FLEET_DSN secret is not set; skipping Sentry report for this run.")
        return 0

    try:
        public_key, host, project_id = parse_dsn(dsn)
    except ValueError as exc:
        print(f"::error::{exc}")
        return 1

    envelope_url = f"https://{host}/api/{project_id}/envelope/"
    auth_header = (
        f"Sentry sentry_version=7, sentry_client=sentry-ci-report/1.0, sentry_key={public_key}"
    )

    # ── 1. Failure event ────────────────────────────────────────────────────
    if conclusion == "failure":
        event_payload = {
            "event_id": uuid.uuid4().hex,
            "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "platform": "other",
            "level": "error",
            "environment": "fleet-ci",
            "message": f"CI workflow failed: {workflow_name} (branch {branch})",
            "tags": {"workflow": workflow_name, "branch": branch, "actor": actor},
            "extra": {"run_url": run_url, "run_id": run_id},
            "fingerprint": ["ci-failure", workflow_name, branch],
        }
        send_envelope(envelope_url, auth_header, "event", event_payload)
        print(f"Sent Sentry failure event for workflow '{workflow_name}' on branch '{branch}'.")
    else:
        print(f"Workflow '{workflow_name}' concluded '{conclusion}' (not failure); no error event sent.")

    # ── 2. Cron check-in (only for schedule-triggered runs) ─────────────────
    if event == "schedule":
        cron_expr = CRON_SCHEDULES.get(workflow_name)
        if not cron_expr:
            print(
                f"::warning::Schedule-triggered run for '{workflow_name}' has no known cron "
                "expression mapped in CRON_SCHEDULES; skipping check-in."
            )
        else:
            checkin_status = "ok" if conclusion == "success" else "error"
            monitor_slug = f"ci-{slugify(workflow_name)}"
            checkin_payload = {
                "check_in_id": uuid.uuid4().hex,
                "monitor_slug": monitor_slug,
                "status": checkin_status,
                "monitor_config": {
                    "schedule": {"type": "crontab", "value": cron_expr},
                    "checkin_margin": 15,
                    "max_runtime": 60,
                    "timezone": "UTC",
                },
            }
            send_envelope(envelope_url, auth_header, "check_in", checkin_payload)
            print(f"Sent Sentry Crons check-in '{checkin_status}' for monitor '{monitor_slug}' (workflow '{workflow_name}').")
    else:
        print(f"Workflow '{workflow_name}' was triggered by '{event}' (not schedule); no cron check-in sent.")

    return 0


if __name__ == "__main__":
    sys.exit(main())
