#!/usr/bin/env python3
"""Offline safety tests for the Litestream L1 delete tools.

No network, no rclone binary, no credentials. Run:

    bash scripts/test-litestream-l1-safety.sh
"""
from __future__ import annotations

import importlib.util
import io
import json
import os
import unittest
import urllib.error
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"
NOW = datetime(2026, 11, 12, 3, 0, tzinfo=timezone.utc)
WHEN = "2026-11-12 00:00:02"
BIG = 200 * 1024 * 1024
KEY_ENV = {
    "B2_KEY_ID": "kid-test-value",
    "B2_APPLICATION_KEY": "sek-test-value",
    "BACKBLAZE_MASTER_KEY_ID": "",
    "BACKBLAZE_MASTER_APPLICATION_KEY": "",
}


def load_script(filename: str, mod_name: str):
    spec = importlib.util.spec_from_file_location(mod_name, SCRIPTS / filename)
    if spec is None or spec.loader is None:
        raise RuntimeError(filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


HEAL = load_script("litestream-l1-suffix-heal.py", "litestream_l1_suffix_heal")
TRIM = load_script("litestream-l1-boundary-trim.py", "litestream_l1_boundary_trim")


def hx(value: int) -> str:
    return f"{value:016x}"


def ltx_name(prefix: str, level: str, lo: int, hi: int) -> str:
    return f"{prefix}{level}/{hx(lo)}-{hx(hi)}.ltx"


def version(prefix: str, level: str, lo: int, hi: int, file_id: str, *, action="upload", ts=1, size=8):
    return {
        "fileName": ltx_name(prefix, level, lo, hi),
        "fileId": file_id,
        "contentLength": size,
        "action": action,
        "uploadTimestamp": ts,
    }


def basename(lo: int, hi: int) -> str:
    return f"{hx(lo)}-{hx(hi)}.ltx"


def snap(lo: int, hi: int, size=BIG, when=WHEN, hidden=False):
    return {"name": basename(lo, hi), "size": size, "modtime": when, "hidden": hidden}


def l1row(lo: int, hi: int, size=1000, hidden=False):
    return {"name": basename(lo, hi), "size": size, "modtime": WHEN, "hidden": hidden}


class FakeB2:
    def __init__(self, versions_by_level, fail_delete_at=None):
        self.versions_by_level = versions_by_level
        self.fail_delete_at = fail_delete_at
        self.deleted = []
        self.methods = []
        self.bucket_ids = []

    def __call__(self, method, payload):
        self.methods.append(method)
        if method == "b2_list_buckets":
            real = HEAL.LIVE_BUCKET
            return {
                "buckets": [
                    {"bucketName": real + "-lookalike", "bucketId": "lookalikebucket"},
                    {"bucketName": real, "bucketId": "realbucket1"},
                ]
            }
        if method == "b2_list_file_versions":
            self.bucket_ids.append(payload.get("bucketId"))
            level = str(payload.get("prefix") or "")[len(HEAL.REPLICA_PREFIX):].strip("/")
            return {"files": self.versions_by_level.get(level, [])}
        if method == "b2_delete_file_version":
            if self.fail_delete_at is not None and len(self.deleted) >= self.fail_delete_at:
                raise RuntimeError("injected delete failure")
            self.deleted.append((payload["fileName"], payload["fileId"]))
            return {}
        raise AssertionError(method)


def run_heal(argv, post=None, authorize=None, env=None):
    out = io.StringIO()
    err = io.StringIO()
    keys = dict(KEY_ENV)
    if env is not None:
        keys = env
    caught = None
    with mock.patch.dict(os.environ, keys, clear=False):
        try:
            with redirect_stdout(out), redirect_stderr(err):
                HEAL.execute(argv, post=post, authorize=authorize)
        except SystemExit as exc:
            caught = exc
    text = out.getvalue() + err.getvalue()
    if "sek-test-value" in text or "kid-test-value" in text:
        raise AssertionError("credential appeared in command output")
    return text, caught


class HealPlanTests(unittest.TestCase):
    def test_import_has_no_side_effects(self):
        with mock.patch("urllib.request.urlopen", side_effect=AssertionError("network")):
            load_script("litestream-l1-suffix-heal.py", "heal_import_again")
        source = (SCRIPTS / "litestream-l1-suffix-heal.py").read_text()
        self.assertIn('if __name__ == "__main__":', source)

    def test_gap_keeps_only_the_contiguous_suffix_when_keep_exceeds_count(self):
        prefix = HEAL.REPLICA_PREFIX
        files = [
            version(prefix, "0001", 7, 8, "new"),
            version(prefix, "0001", 1, 2, "old"),
            version(prefix, "0001", 5, 6, "mid"),
        ]
        delete, keep = HEAL.plan_l1(files, 48)
        self.assertEqual([row["fileId"] for row in keep], ["mid", "new"])
        self.assertEqual([row["fileId"] for row in delete], ["old"])

    def test_printed_hole_count_collapses_twins(self):
        prefix = HEAL.REPLICA_PREFIX
        files = [
            version(prefix, "0001", 1, 99, "a"),
            version(prefix, "0001", 1, 200, "b"),
            version(prefix, "0001", 100, 200, "c"),
        ]
        self.assertEqual(HEAL.hole_and_twin_counts(files), (0, 1))

    def test_twins_do_not_split_the_suffix(self):
        prefix = HEAL.REPLICA_PREFIX
        files = [
            version(prefix, "0001", 1, 99, "a"),
            version(prefix, "0001", 100, 200, "c"),
            version(prefix, "0001", 1, 200, "b"),
        ]
        delete, keep = HEAL.plan_l1(files, 48)
        self.assertEqual(delete, [])
        self.assertEqual({row["fileId"] for row in keep}, {"a", "b", "c"})

    def test_keep_bounds(self):
        prefix = HEAL.REPLICA_PREFIX
        files = [
            version(prefix, "0001", 1, 2, "a"),
            version(prefix, "0001", 3, 4, "b"),
            version(prefix, "0001", 5, 6, "c"),
        ]
        delete0, keep0 = HEAL.plan_l1(files, 0)
        self.assertEqual(keep0, [])
        self.assertEqual({row["fileId"] for row in delete0}, {"a", "b", "c"})
        _delete1, keep1 = HEAL.plan_l1(list(reversed(files)), 1)
        self.assertEqual([row["fileId"] for row in keep1], ["c"])
        delete_all, keep_all = HEAL.plan_l1(files, 100)
        self.assertEqual(delete_all, [])
        self.assertEqual([row["fileId"] for row in keep_all], ["a", "b", "c"])

    def test_unfinished_large_file_does_not_occupy_a_keep_slot(self):
        prefix = HEAL.REPLICA_PREFIX
        files = [
            version(prefix, "0001", 1, 2, "real", ts=1),
            version(prefix, "0001", 3, 4, "start-only", action="start", ts=9),
            version(prefix, "0001", 5, 6, "upload", ts=2),
            version(prefix, "0001", 5, 6, "restart", action="start", ts=8),
        ]
        raw = {"0001": files, "0002": [], "0003": []}
        delete, keep = HEAL.planned_deletes(raw, 8)
        self.assertEqual([row["fileId"] for row in keep], ["upload"])
        deleted_ids = {row["fileId"] for row in delete}
        self.assertIn("real", deleted_ids)
        self.assertIn("start-only", deleted_ids)
        self.assertNotIn("restart", deleted_ids)
        self.assertNotIn("upload", deleted_ids)

    def test_hidden_and_duplicate_versions_follow_the_live_name(self):
        prefix = HEAL.REPLICA_PREFIX
        live = version(prefix, "0001", 1, 2, "live", ts=5)
        older = version(prefix, "0001", 1, 2, "older", ts=1)
        hidden_up = version(prefix, "0001", 3, 4, "hid-up", ts=1)
        hidden_hide = version(prefix, "0001", 3, 4, "hid-hide", action="hide", ts=9)
        raw = {"0001": [hidden_hide, older, live, hidden_up], "0002": [], "0003": []}
        delete, keep = HEAL.planned_deletes(raw, 8)
        self.assertEqual([row["fileId"] for row in keep], ["live"])
        self.assertEqual([row["fileId"] for row in delete], ["hid-up", "hid-hide"])

    def test_pagination_sends_both_cursors_and_stops(self):
        pages = [
            {"files": [{"fileName": HEAL.REPLICA_PREFIX + "0001/a", "fileId": "1"}],
             "nextFileName": "cursor-name", "nextFileId": "cursor-id"},
            {"files": [{"fileName": HEAL.REPLICA_PREFIX + "0001/b", "fileId": "2"}]},
        ]
        calls = []

        def post(method, payload):
            self.assertEqual(method, "b2_list_file_versions")
            calls.append(dict(payload))
            if "startFileName" not in payload:
                return pages[0]
            self.assertEqual(payload["startFileName"], "cursor-name")
            self.assertEqual(payload["startFileId"], "cursor-id")
            return pages[1]

        rows = HEAL.list_file_versions(post, "bucket", HEAL.REPLICA_PREFIX + "0001/")
        self.assertEqual([row["fileId"] for row in rows], ["1", "2"])
        self.assertEqual(len(calls), 2)

    def test_repeated_or_partial_cursor_fails_closed(self):
        def repeat(method, payload):
            del method, payload
            return {"files": [], "nextFileName": "same", "nextFileId": "id"}

        with self.assertRaises(SystemExit):
            HEAL.list_file_versions(repeat, "bucket", HEAL.REPLICA_PREFIX)

        def partial(method, payload):
            del method, payload
            return {"files": [], "nextFileName": "only-name"}

        with self.assertRaises(SystemExit):
            HEAL.list_file_versions(partial, "bucket", HEAL.REPLICA_PREFIX)

    def test_guards_refuse_l0_l9_traversal_and_lookalikes(self):
        prefix = HEAL.REPLICA_PREFIX
        allowed = ltx_name(prefix, "0001", 1, 2)
        self.assertIsNone(HEAL.deletion_refusal(allowed))
        refused = [
            ltx_name(prefix, "0000", 1, 2),
            ltx_name(prefix, "0009", 1, 2),
            prefix + "0001/../../0000/" + basename(1, 2),
            prefix[:-1] + "-evil/0001/" + basename(1, 2),
            "other-bucket/" + prefix + "0001/" + basename(1, 2),
            prefix + "0002/" + basename(1, 2) + "/extra",
        ]
        for name in refused:
            self.assertIsNotNone(HEAL.deletion_refusal(name), name)
        raw = {
            "0001": [
                version(prefix, "0001", 1, 2, "keep"),
                {
                    "fileName": prefix + "0001/../../" + basename(1, 2),
                    "fileId": "trav",
                    "contentLength": 1,
                    "action": "upload",
                    "uploadTimestamp": 1,
                },
            ],
            "0002": [version(prefix, "0000", 1, 2, "l0")],
            "0003": [],
        }
        delete, keep = HEAL.planned_deletes(raw, 8)
        self.assertEqual([row["fileId"] for row in keep], ["keep"])
        self.assertEqual(delete, [])


class HealExecuteTests(unittest.TestCase):
    def setUp(self):
        prefix = HEAL.REPLICA_PREFIX
        self.versions = {
            "0000": [version(prefix, "0000", 1, 2, "l0", size=20)],
            "0001": [
                version(prefix, "0001", 1, 2, "old"),
                version(prefix, "0001", 5, 6, "mid"),
                version(prefix, "0001", 7, 8, "new", ts=4),
                version(prefix, "0001", 7, 8, "new-old", ts=1),
                version(prefix, "0001", 9, 10, "hid-up", ts=1),
                version(prefix, "0001", 9, 10, "hid-hide", action="hide", ts=3),
                {
                    "fileName": prefix + "0001/../" + basename(3, 4),
                    "fileId": "trav",
                    "contentLength": 1,
                    "action": "upload",
                    "uploadTimestamp": 1,
                },
            ],
            "0002": [version(prefix, "0002", 1, 4, "l2")],
            "0003": [version(prefix, "0003", 1, 4, "l3a"), version(prefix, "0003", 1, 4, "l3b", ts=2)],
            "0009": [version(prefix, "0009", 1, 8, "l9", size=BIG)],
        }

    def test_cli_keep_below_8_deletes_nothing(self):
        def explode(*_args, **_kwargs):
            raise AssertionError("network")

        with mock.patch("urllib.request.urlopen", explode):
            for value in ("0", "1"):
                text, caught = run_heal(["--keep-l1", value], env={name: "" for name in KEY_ENV})
                self.assertIsNotNone(caught)
                self.assertEqual(caught.code, 2)
                self.assertIn("keep-l1", text)

    def test_missing_credentials_and_auth_errors_fail_closed(self):
        calls = []

        def explode(req, timeout=30):
            del timeout
            calls.append(getattr(req, "full_url", ""))
            raise AssertionError("network")

        with mock.patch("urllib.request.urlopen", explode):
            _text, caught = run_heal([], env={name: "" for name in KEY_ENV})
        self.assertIsNotNone(caught)
        self.assertEqual(calls, [])

        def unauthorized(req, timeout=30):
            del timeout
            calls.append(getattr(req, "full_url", ""))
            raise urllib.error.HTTPError(req.full_url, 401, "unauthorized", hdrs=None, fp=io.BytesIO(b""))

        calls.clear()
        with mock.patch("urllib.request.urlopen", unauthorized):
            text, caught = run_heal([])
        self.assertIsNotNone(caught)
        self.assertEqual(caught.code, 2)
        self.assertTrue(calls)
        self.assertTrue(all("b2_authorize_account" in url for url in calls))
        self.assertNotIn("b2_delete_file_version", "".join(calls))
        self.assertIn("HTTP 401", text)

        def wrong_cluster(req, timeout=30):
            del timeout
            calls.append(getattr(req, "full_url", ""))
            body = json.dumps({"s3ApiUrl": "https://s3.us-west-000.backblazeb2.com"}).encode()
            return io.BytesIO(body)

        calls.clear()
        with mock.patch("urllib.request.urlopen", wrong_cluster):
            _text, caught = run_heal([])
        self.assertIsNotNone(caught)
        self.assertTrue(all("b2_delete_file_version" not in url for url in calls))

    def test_dry_run_deletes_nothing_and_apply_deletes_the_plan(self):
        dry = FakeB2(self.versions)
        text, caught = run_heal(["--keep-l1", "8"], post=dry)
        self.assertIsNone(caught)
        self.assertNotIn("b2_delete_file_version", dry.methods)
        self.assertIn("DRY-RUN", text)
        self.assertEqual(set(dry.bucket_ids), {"realbucket1"})

        applied = FakeB2(self.versions)
        _text, caught = run_heal(["--apply", "--keep-l1", "8"], post=applied)
        self.assertIsNone(caught)
        expected, keep = HEAL.planned_deletes(self.versions, 8)
        self.assertEqual(applied.deleted, [(row["fileName"], row["fileId"]) for row in expected])
        kept_ids = {row["fileId"] for row in keep}
        deleted_ids = {file_id for _name, file_id in applied.deleted}
        self.assertTrue(kept_ids.isdisjoint(deleted_ids))
        self.assertIn("new", kept_ids)
        self.assertNotIn("new-old", deleted_ids)
        for forbidden in ("l0", "l9", "trav", "mid", "new"):
            self.assertNotIn(forbidden, deleted_ids)
        self.assertLess(
            [file_id for _name, file_id in applied.deleted].index("hid-up"),
            [file_id for _name, file_id in applied.deleted].index("hid-hide"),
        )

    def test_delete_failure_stops(self):
        fake = FakeB2(self.versions, fail_delete_at=1)
        text, caught = run_heal(["--apply", "--keep-l1", "8"], post=fake)
        self.assertIsNotNone(caught)
        self.assertEqual(caught.code, 1)
        self.assertEqual(len(fake.deleted), 1)
        self.assertIn("apply_stopped", text)
        expected, _keep = HEAL.planned_deletes(self.versions, 8)
        self.assertGreater(len(expected), 1)
        self.assertNotIn(expected[1]["fileId"], {file_id for _name, file_id in fake.deleted})


class BoundaryPlanTests(unittest.TestCase):
    def test_import_has_no_side_effects(self):
        with mock.patch("subprocess.run", side_effect=AssertionError("rclone")):
            load_script("litestream-l1-boundary-trim.py", "trim_import_again")
        source = (SCRIPTS / "litestream-l1-boundary-trim.py").read_text()
        self.assertIn('if __name__ == "__main__":', source)

    def test_contiguous_suffix_and_unsorted_input(self):
        snaps = [snap(1, 50), snap(1, 100)]
        rows = [l1row(101, 120), l1row(1, 40), l1row(41, 100)]
        plan = TRIM.plan_boundary(list(reversed(snaps)), list(reversed(rows)), now=NOW, max_age_hours=48)
        self.assertEqual(plan.code, 0)
        self.assertEqual(plan.doomed, [basename(1, 40), basename(41, 100)])
        self.assertEqual(plan.kept, [basename(101, 120)])

    def test_twins_are_not_a_gap_and_a_real_gap_deletes_nothing(self):
        snaps = [snap(1, 50)]
        twins = [l1row(1, 40), l1row(51, 99), l1row(1, 200), l1row(100, 200)]
        plan = TRIM.plan_boundary(snaps, twins, now=NOW, max_age_hours=48)
        self.assertEqual(plan.code, 0)
        self.assertEqual(plan.doomed, [basename(1, 40)])

        gapped = [l1row(1, 40), l1row(51, 60), l1row(70, 80)]
        refused = TRIM.plan_boundary(snaps, gapped, now=NOW, max_age_hours=48)
        self.assertEqual(refused.code, 5)
        self.assertEqual(refused.doomed, [])

    def test_hole_hidden_duplicate_and_crafted_names(self):
        snaps = [snap(1, 100)]
        hole = TRIM.plan_boundary(snaps, [l1row(1, 50), l1row(110, 120)], now=NOW, max_age_hours=48)
        self.assertEqual(hole.code, 4)
        self.assertEqual(hole.doomed, [])

        hidden = [
            l1row(1, 40),
            l1row(101, 110),
            l1row(111, 120),
            l1row(50, 200, hidden=True),
            {"name": "../0000/" + basename(1, 2), "size": 10, "modtime": WHEN},
            {"name": basename(1, 40), "size": 5, "modtime": WHEN},
        ]
        plan = TRIM.plan_boundary(snaps, hidden, now=NOW, max_age_hours=48)
        self.assertEqual(plan.code, 0)
        self.assertEqual(plan.doomed, [basename(1, 40)])
        self.assertNotIn("../0000/" + basename(1, 2), plan.doomed)

    def test_snapshot_guards_fail_closed(self):
        stale = TRIM.plan_boundary(
            [snap(1, 10, when="2026-11-01 00:00:02")], [l1row(1, 4)], now=NOW, max_age_hours=6)
        self.assertEqual(stale.code, 3)
        self.assertEqual(stale.doomed, [])

        tiny = TRIM.plan_boundary([snap(1, 10, size=10)], [l1row(1, 4)], now=NOW, max_age_hours=48)
        self.assertEqual(tiny.code, 3)

        zero_prev = TRIM.plan_boundary(
            [snap(1, 10, size=0), snap(1, 20, size=BIG)],
            [l1row(21, 30)],
            now=NOW,
            max_age_hours=48,
        )
        self.assertEqual(zero_prev.code, 3)
        self.assertEqual(zero_prev.doomed, [])

        shrunk = TRIM.plan_boundary(
            [snap(1, 10, size=400 * 1024 * 1024), snap(1, 20, size=100 * 1024 * 1024 + 10)],
            [l1row(21, 30)],
            now=NOW,
            max_age_hours=48,
        )
        self.assertEqual(shrunk.code, 3)

    def test_large_unmoved_boundary_and_replica_guards(self):
        rows = []
        cursor = 6
        for _ in range(201):
            rows.append(l1row(cursor, cursor + 1))
            cursor += 2
        plan = TRIM.plan_boundary([snap(1, 5)], rows, now=NOW, max_age_hours=48)
        self.assertEqual(plan.code, 6)
        self.assertEqual(plan.doomed, [])

        bucket, prefix = TRIM.APPS["socratic"]
        TRIM.validate_replica(bucket, prefix)
        with self.assertRaises(RuntimeError):
            TRIM.validate_replica(bucket + "x", prefix)
        with self.assertRaises(RuntimeError):
            TRIM.validate_replica(bucket, prefix + "/../other")
        with self.assertRaises(RuntimeError):
            TRIM.remote_level(bucket, prefix, "0000")
        target = TRIM.remote_level(bucket, prefix, "0001")
        self.assertTrue(target.endswith("/0001/"))
        self.assertNotIn("..", target)
        self.assertIn("/" + prefix + "/0001/", target)

        def explode(_args):
            raise AssertionError("rclone")

        with self.assertRaises(RuntimeError):
            TRIM.listing(bucket, prefix, "0000", explode)


class FakeRclone:
    def __init__(self, snaps, l1, *, fail_list=False, fail_delete=False):
        self.snaps = snaps
        self.l1 = l1
        self.fail_list = fail_list
        self.fail_delete = fail_delete
        self.calls = []
        self.files_from = []

    def __call__(self, args):
        self.calls.append(list(args))
        if args[0] == "lsl":
            if self.fail_list:
                raise RuntimeError("rclone lsl failed rc=1")
            if args[1].endswith("/0009/"):
                return self.snaps
            if args[1].endswith("/0001/"):
                return self.l1
            raise AssertionError(args[1])
        if args[0] == "delete":
            index = args.index("--files-from")
            names = Path(args[index + 1]).read_text().splitlines()
            self.files_from.append(names)
            if self.fail_delete:
                raise RuntimeError("rclone delete failed rc=1")
            hidden = set(names)
            kept = []
            for line in self.l1.splitlines():
                if line.split()[-1] not in hidden:
                    kept.append(line)
            self.l1 = "\n".join(kept)
            return ""
        raise AssertionError(args[0])


def lsl(name: str, size: int = 1000, when: str = WHEN) -> str:
    return f"{size} {when} {name}"


class BoundaryExecuteTests(unittest.TestCase):
    def setUp(self):
        self.snaps = "\n".join([
            lsl(basename(1, 40), BIG, "2026-11-11 00:00:02"),
            lsl(basename(1, 100), BIG, WHEN),
        ])
        self.l1 = "\n".join([
            lsl(basename(1, 30)),
            lsl(basename(31, 60)),
            lsl(basename(61, 100)),
            lsl(basename(101, 110)),
            lsl("../0000/" + basename(1, 2)),
            lsl(basename(1, 2) + "/../../x"),
        ])
        self.bucket, self.prefix = TRIM.APPS["socratic"]

    def _run(self, rclone, argv, chunk=None):
        out = io.StringIO()
        with redirect_stdout(out):
            code = TRIM.execute(argv, rclone_fn=rclone, now=NOW, chunk=chunk)
        return code, out.getvalue()

    def test_dry_run_and_apply_and_stopped_batch(self):
        dry = FakeRclone(self.snaps, self.l1)
        code, text = self._run(dry, ["--app", "socratic"])
        self.assertEqual(code, 0)
        self.assertNotIn("delete", [call[0] for call in dry.calls])
        self.assertIn("DRY-RUN", text)

        applied = FakeRclone(self.snaps, self.l1)
        code, _text = self._run(applied, ["--apply", "--app", "socratic"])
        self.assertEqual(code, 0)
        deletes = [call for call in applied.calls if call[0] == "delete"]
        self.assertEqual(len(deletes), 1)
        self.assertEqual(deletes[0][1], TRIM.remote_level(self.bucket, self.prefix, "0001"))
        self.assertEqual(applied.files_from, [[basename(1, 30), basename(31, 60), basename(61, 100)]])
        for name in applied.files_from[0]:
            self.assertTrue(TRIM.safe_l1_basename(name))

        stopped = FakeRclone(self.snaps, self.l1, fail_delete=True)
        code, text = self._run(stopped, ["--apply"], chunk=2)
        self.assertEqual(code, 1)
        self.assertEqual(sum(1 for call in stopped.calls if call[0] == "delete"), 1)
        self.assertIn("stopping", text)
        self.assertEqual(len(stopped.files_from), 1)
        self.assertEqual(len(stopped.files_from[0]), 2)

    def test_list_failure_and_restore_hole_do_not_delete(self):
        failed = FakeRclone(self.snaps, self.l1, fail_list=True)
        code, _text = self._run(failed, ["--apply"])
        self.assertEqual(code, 2)
        self.assertNotIn("delete", [call[0] for call in failed.calls])

        hole_l1 = "\n".join([lsl(basename(1, 50)), lsl(basename(110, 120))])
        hole = FakeRclone(self.snaps, hole_l1)
        code, _text = self._run(hole, ["--apply"])
        self.assertEqual(code, 4)
        self.assertNotIn("delete", [call[0] for call in hole.calls])

    def test_timer_opts_into_apply(self):
        service = (SCRIPTS / "ops" / "litestream-l1-boundary-trim.service").read_text()
        self.assertIn("Environment=LITESTREAM_L1_TRIM_APPLY=1\n", service)


if __name__ == "__main__":
    unittest.main()
