#!/usr/bin/env python3
"""Post one fleet-infra Sentry error event for the ST Litestream restore drill.

Reuses the DSN parser from st-container-restart-monitor-sentry.py but sends its own logger,
client tag and fingerprint so drill events never group under the container restart monitor.
Reads SENTRY_FLEET_DSN from the environment.  Never prints the DSN.  Pure stdlib.
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys
import urllib.request
import uuid
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_SIBLING = _HERE / "st-container-restart-monitor-sentry.py"
LOGGER = "st-litestream-restore-drill"


def _load_parse_dsn():
    spec = importlib.util.spec_from_file_location("st_restart_sentry", _SIBLING)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load sentry helper")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.parse_dsn


def build_payload(event_id: str, reason: str, message: str) -> dict:
    return {
        "event_id": event_id,
        "level": "error",
        "platform": "other",
        "logger": LOGGER,
        "message": message,
        "tags": {"app": "socratic-trade", "reason": reason},
        "fingerprint": [LOGGER, reason],
    }


def send_event(dsn: str, reason: str, message: str) -> None:
    public_key, host, project_path, scheme = _load_parse_dsn()(dsn)
    envelope_url = f"{scheme}://{host}/api/{project_path}/envelope/"
    auth_header = (
        f"Sentry sentry_version=7, sentry_client={LOGGER}/1.0, "
        f"sentry_key={public_key}"
    )
    event_id = uuid.uuid4().hex
    body = json.dumps(build_payload(event_id, reason, message), separators=(",", ":")).encode()
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
        print(
            "usage: st-litestream-restore-drill-sentry.py <reason> <message>",
            file=sys.stderr,
        )
        return 1
    dsn = os.environ.get("SENTRY_FLEET_DSN", "").strip()
    if not dsn:
        return 0
    if not _SIBLING.is_file():
        print(f"{LOGGER}-sentry: missing {_SIBLING}", file=sys.stderr)
        return 1
    try:
        send_event(dsn, sys.argv[1], sys.argv[2])
    except Exception as exc:
        print(f"{LOGGER}-sentry: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
