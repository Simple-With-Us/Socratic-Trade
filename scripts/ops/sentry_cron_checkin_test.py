#!/usr/bin/env python3
"""Unittests for sentry-cron-checkin.py (stdlib only; stub Sentry on 127.0.0.1).

Run: python3 -m unittest scripts/ops/sentry_cron_checkin_test.py
"""
from __future__ import annotations

import os
import re
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import ClassVar

HERE = Path(__file__).resolve().parent
WRAP = HERE / "sentry-cron-checkin.py"
DSN_VARS = ("SENTRY_CRONS_DSN", "SENTRY_FLEET_DSN", "SENTRY_CRONS_DISABLED")


class _Stub(BaseHTTPRequestHandler):
    bodies: ClassVar[list[bytes]] = []

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        _Stub.bodies.append(self.rfile.read(length))
        self.send_response(202)
        self.end_headers()

    def log_message(self, *_args) -> None:
        return


def statuses() -> list[str]:
    out: list[str] = []
    for body in list(_Stub.bodies):
        out += re.findall(r'"status"\s*:\s*"(in_progress|ok|error)"', body.decode("utf-8", "replace"))
    return out


class WrapTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.httpd = HTTPServer(("127.0.0.1", 0), _Stub)
        cls.dsn = f"http://publickey@127.0.0.1:{cls.httpd.server_address[1]}/1"
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def setUp(self) -> None:
        _Stub.bodies.clear()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def env(self, **extra: str) -> dict[str, str]:
        env = {k: v for k, v in os.environ.items() if k not in DSN_VARS}
        # Never read the real host file: a DSN there would mask missing-DSN cases.
        env["ST_HOST_CRON_SENTRY_ENV_FILE"] = str(Path(self.tmp.name) / "no-such-default.env")
        env.update(extra)
        return env

    def argv(self, cmd: list[str], *, pre: list[str] = (), post: list[str] = ()) -> list[str]:
        return [
            sys.executable, str(WRAP), *pre, "wrap", *post,
            "--monitor-slug", "st-host-unittest", "--schedule", "2,17,32,47 * * * *",
            "--http-timeout", "3", "--", *cmd,
        ]

    def run_wrap(self, cmd: list[str], env: dict[str, str], **kw) -> subprocess.CompletedProcess:
        return subprocess.run(self.argv(cmd, **kw), check=False, env=env, capture_output=True, text=True, timeout=30)

    # Item 2: missing DSN is a configuration error, not an opt-out.
    def test_missing_dsn_exits_78_without_running_job(self) -> None:
        marker = Path(self.tmp.name) / "ran"
        r = self.run_wrap(["touch", str(marker)], self.env())
        self.assertEqual(r.returncode, 78, r.stderr)
        self.assertFalse(marker.exists(), "job must not run without a DSN")
        self.assertIn("SENTRY_CRONS_DSN", r.stderr)
        self.assertIn("SENTRY_FLEET_DSN", r.stderr)
        self.assertEqual(_Stub.bodies, [])

    def test_malformed_dsn_exits_78(self) -> None:
        r = self.run_wrap(["true"], self.env(SENTRY_CRONS_DSN="not-a-dsn"))
        self.assertEqual(r.returncode, 78, r.stderr)

    # Item 6: explicit bypass still runs the job and warns.
    def test_disabled_runs_job_and_warns(self) -> None:
        r = self.run_wrap(["sh", "-c", "exit 3"], self.env(SENTRY_CRONS_DISABLED="1"))
        self.assertEqual(r.returncode, 3)
        self.assertIn("paused or deleted", r.stderr)
        self.assertEqual(_Stub.bodies, [])

    def write_env(self, name: str, text: str) -> str:
        path = Path(self.tmp.name) / name
        path.write_text(text, encoding="utf-8")
        return str(path)

    def check(self, *env_files: str, env: dict[str, str] | None = None) -> int:
        argv = [sys.executable, str(WRAP)]
        for f in env_files:
            argv += ["--env-file", f]
        argv.append("check")
        return subprocess.run(argv, check=False, env=env or self.env(), capture_output=True).returncode

    def test_check_mode(self) -> None:
        empty = self.write_env("empty.env", "# nothing\n")
        self.assertEqual(self.check(empty), 78)
        self.assertEqual(self.check(self.write_env("dsn.env", f"SENTRY_FLEET_DSN={self.dsn}\n")), 0)
        self.assertEqual(self.check(self.write_env("off.env", "SENTRY_CRONS_DISABLED=1\n")), 0)

    # Preflight uses only the unit's env files, never the operator's shell.
    def test_check_ignores_ambient_dsn_and_disable(self) -> None:
        empty = self.write_env("empty.env", "")
        self.assertEqual(self.check(empty, env=self.env(SENTRY_CRONS_DSN=self.dsn)), 78)
        self.assertEqual(self.check(empty, env=self.env(SENTRY_FLEET_DSN=self.dsn)), 78)
        self.assertEqual(self.check(empty, env=self.env(SENTRY_CRONS_DISABLED="1")), 78)

    def test_check_later_env_file_wins_like_systemd(self) -> None:
        first = self.write_env("first.env", f"SENTRY_CRONS_DSN={self.dsn}\n")
        second = self.write_env("second.env", "SENTRY_CRONS_DSN=not-a-dsn\n")
        self.assertEqual(self.check(first, second), 78)
        self.assertEqual(self.check(second, first), 0)

    # Default host env file is overridable and skipped when --env-file is given.
    def test_default_env_file_override_and_skip(self) -> None:
        default = self.write_env("default.env", f"SENTRY_CRONS_DSN={self.dsn}\n")
        env = self.env(ST_HOST_CRON_SENTRY_ENV_FILE=default)
        self.assertEqual(self.check(env=env), 0)
        self.assertEqual(self.check(self.write_env("empty.env", ""), env=env), 78)
        marker = Path(self.tmp.name) / "ran"
        r = self.run_wrap(["touch", str(marker)], env, post=["--env-file", self.write_env("e2.env", "")])
        self.assertEqual(r.returncode, 78, r.stderr)
        self.assertFalse(marker.exists())

    # Item 3: --env-file works after the subcommand as well as before it.
    def test_env_file_after_wrap(self) -> None:
        envf = Path(self.tmp.name) / "cron.env"
        envf.write_text(f"SENTRY_CRONS_DSN={self.dsn}\n", encoding="utf-8")
        r = self.run_wrap(["true"], self.env(), post=["--env-file", str(envf)])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(statuses(), ["in_progress", "ok"])

    def test_env_file_before_and_after_wrap_both_load(self) -> None:
        a = Path(self.tmp.name) / "a.env"
        b = Path(self.tmp.name) / "b.env"
        a.write_text(f"SENTRY_CRONS_DSN={self.dsn}\n", encoding="utf-8")
        b.write_text("ST_UNITTEST_MARK=from-b\n", encoding="utf-8")
        r = self.run_wrap(
            ["sh", "-c", 'test "$ST_UNITTEST_MARK" = from-b'],
            self.env(),
            pre=["--env-file", str(a)],
            post=["--env-file", str(b)],
        )
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(statuses(), ["in_progress", "ok"])

    # Item 4: spawn failure closes the check-in and exits 127.
    def test_spawn_oserror_sends_error_and_exits_127(self) -> None:
        r = self.run_wrap(["/nonexistent/st-unittest-cmd"], self.env(SENTRY_CRONS_DSN=self.dsn))
        self.assertEqual(r.returncode, 127, r.stderr)
        self.assertNotIn("Traceback", r.stderr)
        self.assertEqual(statuses(), ["in_progress", "error"])

    # Item 5: SIGTERM to the wrapper is forwarded and still closes the check-in.
    def test_sigterm_forwarded_and_error_checkin_sent(self) -> None:
        pidfile = Path(self.tmp.name) / "child.pid"
        proc = subprocess.Popen(
            self.argv(["sh", "-c", f'echo $$ > {pidfile}; exec sleep 30']),
            env=self.env(SENTRY_CRONS_DSN=self.dsn),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
        )
        deadline = time.monotonic() + 10
        while not (pidfile.exists() and pidfile.read_text().strip()) and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertEqual(statuses(), ["in_progress"])
        proc.send_signal(signal.SIGTERM)
        rc = proc.wait(timeout=15)
        proc.stderr.close()
        self.assertEqual(rc, 128 + signal.SIGTERM)
        self.assertEqual(statuses(), ["in_progress", "error"])
        child = int(pidfile.read_text().strip())
        with self.assertRaises(ProcessLookupError):
            os.kill(child, 0)

    # Item 7: signal death maps to 128+N, not 256-N.
    def test_child_signal_death_exits_128_plus_n(self) -> None:
        r = self.run_wrap(["sh", "-c", "kill -TERM $$"], self.env(SENTRY_CRONS_DSN=self.dsn))
        self.assertEqual(r.returncode, 128 + signal.SIGTERM)
        self.assertEqual(statuses(), ["in_progress", "error"])

    # Item 9: exit 2 (incident found) is never reported as ok.
    def test_exit_2_reports_error_and_flag_is_gone(self) -> None:
        r = self.run_wrap(["sh", "-c", "exit 2"], self.env(SENTRY_CRONS_DSN=self.dsn))
        self.assertEqual(r.returncode, 2)
        self.assertEqual(statuses(), ["in_progress", "error"])
        _Stub.bodies.clear()
        r = self.run_wrap(["true"], self.env(SENTRY_CRONS_DSN=self.dsn), post=["--treat-exit-2-as-ok"])
        self.assertEqual(r.returncode, 2, "argparse must reject the removed flag")
        self.assertEqual(_Stub.bodies, [])
        for unit in HERE.glob("*.service"):
            self.assertNotIn("--treat-exit-2-as-ok", unit.read_text(encoding="utf-8"), unit.name)


class InstallerHostCheckTest(unittest.TestCase):
    """Installers refuse a host other than the expected one before touching anything."""

    INSTALLERS = ("install-litestream-l1-trim.sh", "install-st-container-restart-monitor.sh")

    def setUp(self) -> None:
        if os.geteuid() == 0:
            self.skipTest("installer tests must not run as root; they would mutate the host")

    def _env(self, bindir: Path | None = None) -> dict[str, str]:
        env = {k: v for k, v in os.environ.items() if k not in DSN_VARS}
        if bindir is not None:
            env["PATH"] = f"{bindir}{os.pathsep}{env.get('PATH', '')}"
        return env

    def _stub_hostname(self, directory: Path, name: str) -> None:
        # `hostname` prints NAME; `hostname -s` prints the short form (before the first dot).
        stub = directory / "hostname"
        stub.write_text(
            "#!/bin/sh\n"
            f"FULL='{name}'\n"
            "SHORT=${FULL%%.*}\n"
            'if [ "$1" = "-s" ]; then printf "%s\n" "$SHORT"; else printf "%s\n" "$FULL"; fi\n',
            encoding="utf-8",
        )
        stub.chmod(0o755)

    def _assert_hostname_stub(self, bindir: Path, env: dict[str, str], full: str) -> None:
        short = full.split(".", 1)[0]
        stub = str(bindir / "hostname")
        got_full = subprocess.run(
            [stub], check=True, env=env, capture_output=True, text=True, timeout=5
        )
        got_short = subprocess.run(
            [stub, "-s"], check=True, env=env, capture_output=True, text=True, timeout=5
        )
        self.assertEqual(got_full.stdout.strip(), full)
        self.assertEqual(got_short.stdout.strip(), short)
        # Also via PATH, the way the installers invoke it.
        via_path = subprocess.run(
            ["hostname"], check=True, env=env, capture_output=True, text=True, timeout=5
        )
        self.assertEqual(via_path.stdout.strip(), full)

    def _run(self, name: str, env: dict[str, str], *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["bash", str(HERE / name), *args],
            check=False,
            env=env,
            capture_output=True,
            text=True,
            timeout=30,
        )

    def test_installers_refuse_unexpected_host(self) -> None:
        env = self._env()
        env["ST_INSTALL_EXPECTED_HOST"] = "st-unittest-no-such-host"
        for name in self.INSTALLERS:
            r = self._run(name, env)
            self.assertEqual(r.returncode, 1, name)
            self.assertIn("refusing to install on host", r.stderr, name)
            self.assertIn("st-unittest-no-such-host", r.stderr, name)
            r = self._run(name, env, "--bogus")
            self.assertEqual(r.returncode, 2, name)

    def test_installers_accept_fqdn_expected_host_when_hostname_is_short(self) -> None:
        """An FQDN expected host must match when `hostname` returns the short name."""
        short = "st-unittest-host"
        fqdn = "st-unittest-host.example.ts.net"
        other = "other-host.example.ts.net"
        with tempfile.TemporaryDirectory() as td:
            bindir = Path(td)
            self._stub_hostname(bindir, short)
            env = self._env(bindir)
            self._assert_hostname_stub(bindir, env, short)
            for name in self.INSTALLERS:
                r = self._run(name, env, "--expected-host", fqdn)
                self.assertNotIn("refusing to install on host", r.stderr, name)
                self.assertIn("must run as root", r.stderr, name)
                self.assertEqual(r.returncode, 1, name)

                env_var = dict(env)
                env_var["ST_INSTALL_EXPECTED_HOST"] = fqdn
                r = self._run(name, env_var)
                self.assertNotIn("refusing to install on host", r.stderr, name)
                self.assertIn("must run as root", r.stderr, name)
                self.assertEqual(r.returncode, 1, name)

                r = self._run(name, env, "--expected-host", short)
                self.assertNotIn("refusing to install on host", r.stderr, name)
                self.assertIn("must run as root", r.stderr, name)

                r = self._run(name, env, "--expected-host", other)
                self.assertEqual(r.returncode, 1, name)
                self.assertIn("refusing to install on host", r.stderr, name)
                self.assertIn(other, r.stderr, name)

    def test_installers_accept_short_expected_host_when_hostname_is_fqdn(self) -> None:
        short = "st-unittest-host"
        fqdn = "st-unittest-host.example.ts.net"
        other = "other-host.example.ts.net"
        with tempfile.TemporaryDirectory() as td:
            bindir = Path(td)
            self._stub_hostname(bindir, fqdn)
            env = self._env(bindir)
            self._assert_hostname_stub(bindir, env, fqdn)
            for name in self.INSTALLERS:
                r = self._run(name, env, "--expected-host", short)
                self.assertNotIn("refusing to install on host", r.stderr, name)
                self.assertIn("must run as root", r.stderr, name)
                self.assertEqual(r.returncode, 1, name)

                r = self._run(name, env, "--expected-host", fqdn)
                self.assertNotIn("refusing to install on host", r.stderr, name)
                self.assertIn("must run as root", r.stderr, name)
                self.assertEqual(r.returncode, 1, name)

                r = self._run(name, env, "--expected-host", other)
                self.assertEqual(r.returncode, 1, name)
                self.assertIn("refusing to install on host", r.stderr, name)
                self.assertIn(other, r.stderr, name)


class UnitScheduleTest(unittest.TestCase):
    """Item 8: every wrapped unit's UTC crontab matches a UTC-pinned OnCalendar."""

    def test_wrapped_timers_pinned_to_utc_and_match_schedule(self) -> None:
        wrapped = 0
        for service in sorted(HERE.glob("*.service")):
            m = re.search(r'sentry-cron-checkin\.py wrap .*--schedule "([^"]+)"', service.read_text("utf-8"))
            if not m:
                continue
            wrapped += 1
            timer = service.with_suffix(".timer")
            cal = re.search(r"^OnCalendar=(.+)$", timer.read_text("utf-8"), re.MULTILINE).group(1).strip()
            self.assertTrue(cal.endswith(" UTC"), f"{timer.name}: OnCalendar={cal} is host-local")
            minute, hour = m.group(1).split()[:2]
            cal_time = cal[: -len(" UTC")].split()[-1]
            parts = cal_time.split(":")
            if parts[0] == "*":
                self.assertEqual(hour, "*", timer.name)
                self.assertEqual(
                    [int(x) for x in parts[1].split(",")], [int(x) for x in minute.split(",")], timer.name
                )
            else:
                self.assertEqual(int(parts[0]), int(hour), timer.name)
                self.assertEqual(int(parts[1]), int(minute), timer.name)
        self.assertGreaterEqual(wrapped, 2)


if __name__ == "__main__":
    unittest.main()
