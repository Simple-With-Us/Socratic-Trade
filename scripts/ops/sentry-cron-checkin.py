#!/usr/bin/env python3
"""
Reusable Sentry Crons check-ins for host systemd oneshots (stdlib only).

Wrap a timer-fired command: in_progress at start, ok or error at end, with an
upserted monitor_config so a timer that stops firing pages via missed check-in.

DSN: SENTRY_CRONS_DSN, else SENTRY_FLEET_DSN (never printed).  Opt-out:
SENTRY_CRONS_DISABLED=1.  Sentry failures never change the wrapped command's exit
code.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Sequence
from urllib import error as urllib_error
from urllib import request as urllib_request

DEFAULT_HTTP_TIMEOUT_SEC = 15
CLIENT_NAME = "st-host-cron-checkin/1.0"
ENV_DSN_PRIMARY = "SENTRY_CRONS_DSN"
ENV_DSN_FALLBACK = "SENTRY_FLEET_DSN"
ENV_DISABLE = "SENTRY_CRONS_DISABLED"


def load_env_file(path: str | Path) -> None:
    """Load KEY=VALUE lines into os.environ without logging values."""
    p = Path(path)
    if not p.is_file():
        return
    try:
        text = p.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].strip()
        if "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        if not key or not re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", key):
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        os.environ.setdefault(key, value)


def crons_disabled() -> bool:
    flag = os.environ.get(ENV_DISABLE, "").strip().lower()
    return flag in ("1", "true", "yes", "on")


def resolve_dsn() -> str:
    for key in (ENV_DSN_PRIMARY, ENV_DSN_FALLBACK):
        value = os.environ.get(key, "").strip()
        if value:
            return value
    return ""


def parse_dsn(dsn: str) -> tuple[str, str, str]:
    """Return (public_key, host, project_id). Never includes raw dsn in errors."""
    m = re.match(r"^https?://([^@]+)@([^/]+)/(.+)$", dsn.strip())
    if not m:
        raise ValueError("cron DSN is not in the expected https://<key>@<host>/<project> shape")
    return m.group(1), m.group(2), m.group(3)


def envelope_url_for_dsn(dsn: str) -> tuple[str, str]:
    public_key, host, project_id = parse_dsn(dsn)
    scheme = "https" if dsn.strip().startswith("https://") else "http"
    envelope_url = f"{scheme}://{host}/api/{project_id}/envelope/"
    auth_header = f"Sentry sentry_version=7, sentry_client={CLIENT_NAME}, sentry_key={public_key}"
    return envelope_url, auth_header


def build_monitor_config(schedule: str, checkin_margin: int, max_runtime: int) -> dict:
    return {
        "schedule": {"type": "crontab", "value": schedule},
        "checkin_margin": checkin_margin,
        "max_runtime": max_runtime,
        "timezone": "UTC",
    }


def send_envelope(
    envelope_url: str,
    auth_header: str,
    item_type: str,
    item_payload: dict,
    *,
    timeout_sec: float = DEFAULT_HTTP_TIMEOUT_SEC,
) -> bool:
    """POST one envelope item. Returns True on HTTP success, False on any failure."""
    item_body = json.dumps(item_payload).encode("utf-8")
    envelope_header = json.dumps(
        {"sent_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    ).encode("utf-8")
    item_header = json.dumps({"type": item_type, "length": len(item_body)}).encode("utf-8")
    body = envelope_header + b"\n" + item_header + b"\n" + item_body + b"\n"

    req = urllib_request.Request(
        envelope_url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/x-sentry-envelope",
            "X-Sentry-Auth": auth_header,
        },
    )
    try:
        with urllib_request.urlopen(req, timeout=timeout_sec) as resp:
            return 200 <= resp.status < 300
    except urllib_error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:200]
        print(
            f"sentry-cron-checkin: envelope HTTP {exc.code} ({item_type}): {detail}",
            file=sys.stderr,
        )
    except Exception as exc:  # noqa: BLE001 — fail open
        print(f"sentry-cron-checkin: envelope failed ({item_type}): {type(exc).__name__}", file=sys.stderr)
    return False


def send_checkin(
    envelope_url: str,
    auth_header: str,
    *,
    monitor_slug: str,
    status: str,
    check_in_id: str,
    monitor_config: dict | None,
    timeout_sec: float,
) -> None:
    payload: dict = {
        "check_in_id": check_in_id,
        "monitor_slug": monitor_slug,
        "status": status,
    }
    if monitor_config is not None:
        payload["monitor_config"] = monitor_config
    send_envelope(envelope_url, auth_header, "check_in", payload, timeout_sec=timeout_sec)


def terminal_status_for_exit(rc: int, *, treat_exit_2_as_ok: bool) -> str:
    if rc == 0:
        return "ok"
    if treat_exit_2_as_ok and rc == 2:
        return "ok"
    return "error"


def wrap_command(
    command: Sequence[str],
    *,
    monitor_slug: str,
    schedule: str,
    checkin_margin: int,
    max_runtime: int,
    treat_exit_2_as_ok: bool,
    timeout_sec: float,
) -> int:
    if not command:
        print("sentry-cron-checkin: wrap requires a command", file=sys.stderr)
        return 2

    dsn = resolve_dsn()
    if crons_disabled() or not dsn:
        return subprocess.call(command)

    try:
        envelope_url, auth_header = envelope_url_for_dsn(dsn)
    except ValueError as exc:
        print(f"sentry-cron-checkin: {exc}", file=sys.stderr)
        return subprocess.call(command)

    monitor_config = build_monitor_config(schedule, checkin_margin, max_runtime)
    check_in_id = uuid.uuid4().hex
    send_checkin(
        envelope_url,
        auth_header,
        monitor_slug=monitor_slug,
        status="in_progress",
        check_in_id=check_in_id,
        monitor_config=monitor_config,
        timeout_sec=timeout_sec,
    )

    rc = subprocess.call(command)

    terminal = terminal_status_for_exit(rc, treat_exit_2_as_ok=treat_exit_2_as_ok)
    send_checkin(
        envelope_url,
        auth_header,
        monitor_slug=monitor_slug,
        status=terminal,
        check_in_id=check_in_id,
        monitor_config=monitor_config,
        timeout_sec=timeout_sec,
    )
    return rc


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Sentry Crons wrapper for host systemd jobs")
    parser.add_argument(
        "--env-file",
        action="append",
        default=[],
        help="Optional env file (KEY=VALUE); may be repeated; does not override existing env",
    )
    sub = parser.add_subparsers(dest="mode", required=True)

    wrap = sub.add_parser("wrap", help="Run COMMAND with in_progress and terminal check-ins")
    wrap.add_argument("--monitor-slug", required=True)
    wrap.add_argument("--schedule", required=True, help="Crontab expression (UTC), e.g. '4 0 * * *'")
    wrap.add_argument("--checkin-margin", type=int, default=15)
    wrap.add_argument("--max-runtime", type=int, default=60)
    wrap.add_argument(
        "--treat-exit-2-as-ok",
        action="store_true",
        help="Map wrapped exit 2 to Crons ok (st-container-restart-monitor alert path)",
    )
    wrap.add_argument(
        "--http-timeout",
        type=float,
        default=DEFAULT_HTTP_TIMEOUT_SEC,
        help="Sentry HTTP timeout seconds",
    )
    wrap.add_argument("argv", nargs=argparse.REMAINDER, help="Command after --")

    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    for path in getattr(args, "env_file", []) or []:
        load_env_file(path)
    # Also honor default host path when not passed (installer).
    load_env_file("/etc/default/st-host-cron-sentry")

    if args.mode == "wrap":
        cmd = list(args.argv)
        if cmd and cmd[0] == "--":
            cmd = cmd[1:]
        if not cmd:
            print("sentry-cron-checkin: wrap requires a command after --", file=sys.stderr)
            return 2
        return wrap_command(
            cmd,
            monitor_slug=args.monitor_slug,
            schedule=args.schedule,
            checkin_margin=args.checkin_margin,
            max_runtime=args.max_runtime,
            treat_exit_2_as_ok=args.treat_exit_2_as_ok,
            timeout_sec=args.http_timeout,
        )

    print(f"sentry-cron-checkin: unknown mode {args.mode}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
