#!/usr/bin/env python3
"""
Reusable Sentry Crons check-ins for host systemd oneshots (stdlib only).

Wrap a timer-fired command: in_progress at start, ok or error at end, with an
upserted monitor_config so a timer that stops firing pages via missed check-in.

DSN: SENTRY_CRONS_DSN, else SENTRY_FLEET_DSN (never printed).  A missing or
malformed DSN is a configuration error: the wrapper exits 78 (EX_CONFIG) before
starting the job, so a lost secret cannot pass for an opt-out.  The only bypass is
SENTRY_CRONS_DISABLED=1, which runs the job without check-ins; pause or delete the
matching Sentry monitors first or Sentry pages on missed check-ins.

Sentry HTTP failures never change the wrapped command's exit code.  A child killed
by signal N exits 128+N.  SIGTERM/SIGINT are forwarded to the child and still
send the terminal error check-in.  A command that cannot be spawned exits 127.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import signal
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
DEFAULT_ENV_FILE = "/etc/default/st-host-cron-sentry"
EXIT_CONFIG = 78  # sysexits EX_CONFIG
EXIT_SPAWN_FAILED = 127
FORWARDED_SIGNALS = (signal.SIGTERM, signal.SIGINT)


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
    """Return the Crons DSN or raise KeyError naming both supported variables."""
    for key in (ENV_DSN_PRIMARY, ENV_DSN_FALLBACK):
        value = os.environ.get(key, "").strip()
        if value:
            return value
    raise KeyError(
        f"neither {ENV_DSN_PRIMARY} nor {ENV_DSN_FALLBACK} is set; set one in "
        f"{DEFAULT_ENV_FILE}, or set {ENV_DISABLE}=1 after pausing "
        "the Sentry monitors"
    )


def check_config() -> int:
    """0 when check-ins are configured or explicitly disabled, else EXIT_CONFIG."""
    if crons_disabled():
        warn_disabled()
        return 0
    try:
        parse_dsn(resolve_dsn())
    except KeyError as exc:
        print(f"sentry-cron-checkin: {exc.args[0]}", file=sys.stderr)
        return EXIT_CONFIG
    except ValueError as exc:
        print(f"sentry-cron-checkin: {exc}", file=sys.stderr)
        return EXIT_CONFIG
    return 0


def warn_disabled() -> None:
    print(
        f"sentry-cron-checkin: WARNING {ENV_DISABLE}=1, no check-ins sent; the Sentry "
        "monitor must be paused or deleted or it pages on missed check-ins",
        file=sys.stderr,
    )


def normalize_exit(rc: int) -> int:
    """Map a Popen signal death (-N) to the shell convention 128+N."""
    return 128 - rc if rc < 0 else rc


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


def terminal_status_for_exit(rc: int) -> str:
    return "ok" if rc == 0 else "error"


class StopSignals:
    """Forward SIGTERM/SIGINT to the child while the wrapper is running.

    Installed before the in_progress check-in so a systemd stop that lands at
    any point still reaches the terminal error check-in.  SIGKILL and hard
    reboots still rely on the monitor's max_runtime.
    """

    def __init__(self) -> None:
        self.received: list[int] = []
        self.proc: subprocess.Popen | None = None
        self._previous: dict = {}

    def _forward(self, signum: int, _frame: object) -> None:
        self.received.append(signum)
        self._send(signum)

    def _send(self, signum: int) -> None:
        if self.proc is not None and self.proc.poll() is None:
            try:
                self.proc.send_signal(signum)
            except OSError:
                pass

    def __enter__(self) -> StopSignals:
        self._previous = {sig: signal.signal(sig, self._forward) for sig in FORWARDED_SIGNALS}
        return self

    def __exit__(self, *_exc: object) -> None:
        for sig, handler in self._previous.items():
            signal.signal(sig, handler)

    def run(self, command: Sequence[str]) -> int:
        """Run command and return its exit (128+N for signal N, 127 if unspawnable)."""
        if self.received:
            # Stop requested before the spawn: do not start the job.
            return 128 + self.received[0]
        try:
            self.proc = subprocess.Popen(list(command))
        except OSError as exc:
            print(
                f"sentry-cron-checkin: cannot start {command[0]}: {type(exc).__name__}",
                file=sys.stderr,
            )
            return EXIT_SPAWN_FAILED
        if self.received:
            # A stop request landed between the check above and the spawn.
            self._send(self.received[0])
        rc = normalize_exit(self.proc.wait())
        if self.received and rc == 0:
            rc = 128 + self.received[0]
        return rc


def wrap_command(
    command: Sequence[str],
    *,
    monitor_slug: str,
    schedule: str,
    checkin_margin: int,
    max_runtime: int,
    timeout_sec: float,
) -> int:
    if not command:
        print("sentry-cron-checkin: wrap requires a command", file=sys.stderr)
        return 2

    if crons_disabled():
        warn_disabled()
        with StopSignals() as stop:
            return stop.run(command)

    if check_config() != 0:
        return EXIT_CONFIG
    envelope_url, auth_header = envelope_url_for_dsn(resolve_dsn())

    monitor_config = build_monitor_config(schedule, checkin_margin, max_runtime)
    check_in_id = uuid.uuid4().hex
    with StopSignals() as stop:
        send_checkin(
            envelope_url,
            auth_header,
            monitor_slug=monitor_slug,
            status="in_progress",
            check_in_id=check_in_id,
            monitor_config=monitor_config,
            timeout_sec=timeout_sec,
        )

        rc = stop.run(command)

        terminal = "error" if stop.received else terminal_status_for_exit(rc)
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
    env_help = "Optional env file (KEY=VALUE); may be repeated; does not override existing env"
    parser = argparse.ArgumentParser(description="Sentry Crons wrapper for host systemd jobs")
    parser.add_argument("--env-file", action="append", default=[], help=env_help)
    sub = parser.add_subparsers(dest="mode", required=True)

    # Separate dest: a subparser default would otherwise overwrite env files
    # given before the subcommand.
    sub_env = argparse.ArgumentParser(add_help=False)
    sub_env.add_argument("--env-file", dest="sub_env_file", action="append", default=[], help=env_help)

    sub.add_parser(
        "check",
        parents=[sub_env],
        help="Exit 0 if a DSN is set or check-ins are disabled, else 78 (installer preflight)",
    )
    wrap = sub.add_parser(
        "wrap",
        parents=[sub_env],
        help="Run COMMAND with in_progress and terminal check-ins",
    )
    wrap.add_argument("--monitor-slug", required=True)
    wrap.add_argument("--schedule", required=True, help="Crontab expression (UTC), e.g. '4 0 * * *'")
    wrap.add_argument("--checkin-margin", type=int, default=15)
    wrap.add_argument("--max-runtime", type=int, default=60)
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
    for path in [*args.env_file, *getattr(args, "sub_env_file", [])]:
        load_env_file(path)
    # Also honor default host path when not passed (installer).
    load_env_file(DEFAULT_ENV_FILE)

    if args.mode == "check":
        return check_config()

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
            timeout_sec=args.http_timeout,
        )

    print(f"sentry-cron-checkin: unknown mode {args.mode}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
