#!/usr/bin/env python3
"""Post one fleet-infra Sentry error event for the ST container restart monitor.

Reads SENTRY_FLEET_DSN from the environment (same secret as scripts/sentry-ci-report.py).
Never prints the DSN.  Pure stdlib.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.request
import uuid
from urllib.parse import urlparse


def parse_dsn(dsn: str) -> tuple[str, str, str]:
    parsed = urlparse(dsn)
    if parsed.scheme not in ("http", "https"):
        raise ValueError("SENTRY_FLEET_DSN must be an http(s) URL")
    public_key = parsed.username or ""
    project_id = parsed.path.strip("/").split("/")[-1]
    host = parsed.hostname or ""
    if not public_key or not project_id or not host:
        raise ValueError("SENTRY_FLEET_DSN is malformed")
    return public_key, host, project_id


def send_event(dsn: str, reason: str, message: str) -> None:
    public_key, host, project_id = parse_dsn(dsn)
    envelope_url = f"https://{host}/api/{project_id}/envelope/"
    auth_header = (
        "Sentry sentry_version=7, sentry_client=st-container-restart-monitor/1.0, "
        f"sentry_key={public_key}"
    )
    event_id = uuid.uuid4().hex
    payload = {
        "event_id": event_id,
        "level": "error",
        "platform": "other",
        "logger": "st-container-restart-monitor",
        "message": message,
        "tags": {"app": "socratic-trade", "reason": reason},
        "fingerprint": ["st-container-restart-monitor", reason],
    }
    body = json.dumps(payload, separators=(",", ":")).encode()
    envelope = (
        json.dumps({"event_id": event_id, "sent_at": None}, separators=(",", ":")).encode()
        + b"\n"
        + json.dumps({"type": "event", "content_type": "application/json"}, separators=(",", ":")).encode()
        + b"\n"
        + body
        + b"\n"
    )
    req = urllib.request.Request(
        envelope_url,
        data=envelope,
        headers={
            "Content-Type": "application/x-sentry-envelope",
            "X-Sentry-Auth": auth_header,
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        if resp.status >= 300:
            raise RuntimeError(f"Sentry envelope HTTP {resp.status}")


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: st-container-restart-monitor-sentry.py <reason> <message>", file=sys.stderr)
        return 1
    dsn = os.environ.get("SENTRY_FLEET_DSN", "").strip()
    if not dsn:
        return 0
    reason = sys.argv[1]
    message = sys.argv[2]
    try:
        send_event(dsn, reason, message)
    except Exception as exc:
        print(f"st-container-restart-monitor-sentry: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
