#!/usr/bin/env bash
# Hermetic selftest for sentry-cron-checkin.py (stub HTTP server in Python),
# then the sentry_cron_checkin_test.py unittests.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WRAP="${SCRIPT_DIR}/sentry-cron-checkin.py"

python3 - "$WRAP" <<'PY'
import json
import os
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

wrap_script = Path(sys.argv[1])
bodies: list[bytes] = []


class Handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        bodies.append(self.rfile.read(length))
        self.send_response(202)
        self.end_headers()

    def log_message(self, *_args) -> None:
        return


def statuses_from_bodies() -> list[str]:
    out: list[str] = []
    import re

    for body in bodies:
        text = body.decode("utf-8", errors="replace")
        for line in text.splitlines():
            m = re.search(r'"status"\s*:\s*"(in_progress|ok|error)"', line)
            if m:
                out.append(m.group(1))
    return out


def run_wrap(port: int, extra_env: dict[str, str], cmd: list[str]) -> int:
    bodies.clear()
    env = {**os.environ, **extra_env, "SENTRY_CRONS_DSN": f"http://publickey@127.0.0.1:{port}/1"}
    return subprocess.call(
        [
            sys.executable,
            str(wrap_script),
            "wrap",
            "--monitor-slug",
            "st-host-test-unit",
            "--schedule",
            "2,17,32,47 * * * *",
            "--checkin-margin",
            "20",
            "--max-runtime",
            "15",
            "--http-timeout",
            "3",
            "--",
            *cmd,
        ],
        env=env,
    )


def main() -> int:
    import time

    os.environ.pop("SENTRY_CRONS_DISABLED", None)
    os.environ.pop("SENTRY_CRONS_DSN", None)
    os.environ.pop("SENTRY_FLEET_DSN", None)

    httpd = HTTPServer(("127.0.0.1", 0), Handler)
    port = httpd.server_address[1]
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    time.sleep(0.05)

    failures = 0

    rc = run_wrap(port, {}, ["true"])
    st = statuses_from_bodies()
    if rc != 0 or st != ["in_progress", "ok"]:
        print(f"FAIL ok path rc={rc} statuses={st}", file=sys.stderr)
        failures += 1
    else:
        print("PASS ok path")

    rc = run_wrap(port, {}, ["false"])
    st = statuses_from_bodies()
    if rc != 1 or st != ["in_progress", "error"]:
        print(f"FAIL error path rc={rc} statuses={st}", file=sys.stderr)
        failures += 1
    else:
        print("PASS error path")

    rc = run_wrap(1, {}, ["false"])
    if rc != 1:
        print(f"FAIL sentry down rc={rc}", file=sys.stderr)
        failures += 1
    else:
        print("PASS sentry down preserves exit code")

    bodies.clear()
    rc = run_wrap(port, {"SENTRY_CRONS_DISABLED": "1"}, ["true"])
    if rc != 0 or len(bodies) != 0:
        print(f"FAIL disabled rc={rc} bodies={len(bodies)}", file=sys.stderr)
        failures += 1
    else:
        print("PASS disabled skips check-ins")

    httpd.shutdown()
    return 1 if failures else 0


raise SystemExit(main())
PY

# Unittests: missing DSN, --env-file after wrap, spawn failure, SIGTERM,
# signal exit codes, exit 2, timer UTC pin.
PYTHONDONTWRITEBYTECODE=1 python3 "${SCRIPT_DIR}/sentry_cron_checkin_test.py"
