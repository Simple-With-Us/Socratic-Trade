#!/usr/bin/env python3
"""Offline cloud setup regressions; never touch the real home or credentials."""
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class CloudCoordinationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="fleet-bootstrap-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.settings_dir = self.root / "config"
        self.settings_dir.mkdir()
        self.settings = self.settings_dir / "settings.json"
        self.legacy = self.settings_dir / "slack-sync.sh"
        self.env = {**os.environ, "CLAUDE_CONFIG_DIR": str(self.settings_dir)}

    def cleanup(self):
        return subprocess.run(["bash", str(ROOT / "scripts/setup-slack-sync.sh")],
                              env=self.env, capture_output=True, text=True)

    def test_retirement_preserves_mixed_hook_groups_and_is_idempotent(self):
        old = {"type": "command", "command": 'bash "/some path/slack-sync.sh" hook 2>/dev/null || true'}
        other = {"type": "command", "command": "bash /hooks/session-start.sh"}
        data = {"permissions": {"allow": ["Read"]}, "hooks": {
            "SessionStart": [{"matcher": "startup", "hooks": [old, other]}, {"hooks": [old]}],
            "Stop": [{"hooks": [other]}]}}
        self.settings.write_text(json.dumps(data))
        self.legacy.write_text("retired script")
        self.assertEqual(self.cleanup().returncode, 0)
        saved = json.loads(self.settings.read_text())
        self.assertEqual(saved["hooks"]["SessionStart"], [{"matcher": "startup", "hooks": [other]}])
        self.assertEqual(saved["hooks"]["Stop"], data["hooks"]["Stop"])
        self.assertEqual(saved["permissions"], data["permissions"])
        self.assertFalse(self.legacy.exists())
        before = self.settings.read_bytes()
        self.assertEqual(self.cleanup().returncode, 0)
        self.assertEqual(self.settings.read_bytes(), before)

    def test_malformed_settings_are_not_replaced(self):
        self.settings.write_text("not json")
        self.legacy.write_text("retired script")
        self.assertNotEqual(self.cleanup().returncode, 0)
        self.assertEqual(self.settings.read_text(), "not json")
        self.assertTrue(self.legacy.exists())

    def test_symlinks_are_not_followed(self):
        target = self.root / "unrelated"
        target.write_text("{}")
        self.settings.symlink_to(target)
        self.assertNotEqual(self.cleanup().returncode, 0)
        self.assertEqual(target.read_text(), "{}")

    def prepare_archive(self):
        mock_bin = self.root / "mock-bin"
        mock_bin.mkdir()
        archive = self.root / "fixture.tar.gz"
        with tarfile.open(archive, "w:gz") as bundle:
            for name in ["scripts/agent-sync", "scripts/linear-board/board", "AGENT-SYNC.md",
                         "fleet-apps.json", "docs/protocols/zulip-fleet-guide.md"]:
                data = b"#!/usr/bin/env python3\nimport sys\nassert sys.argv[1:] == ['--help']\n" if name.startswith("scripts/") else b"fixture"
                item = tarfile.TarInfo("AFC-fixture/" + name)
                item.size = len(data)
                item.mode = 0o755 if name.startswith("scripts/") else 0o644
                bundle.addfile(item, io.BytesIO(data))
        for name, body in {
            "uname": "#!/bin/sh\necho Linux\n",
            "curl": "#!/bin/sh\nwhile [ $# -gt 0 ]; do\n if [ \"$1\" = -o ]; then cp \"$TEST_ARCHIVE\" \"$2\"; exit; fi\n shift\ndone\nexit 1\n",
        }.items():
            p = mock_bin / name
            p.write_text(body)
            p.chmod(0o755)
        self.env.update(PATH=str(mock_bin) + os.pathsep + os.environ["PATH"],
                        TEST_ARCHIVE=str(archive), FLEET_COORD_CACHE=str(self.root / "cache"),
                        FLEET_COORD_BIN=str(self.root / "bin"))
        return mock_bin

    def install(self):
        return subprocess.run(["bash", str(ROOT / "scripts/install-fleet-coordination.sh")],
                              env=self.env, capture_output=True, text=True)

    def test_fresh_install_fetches_protocol_and_registry_and_retires_cached_hooks(self):
        self.prepare_archive()
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        cache = Path(self.env["FLEET_COORD_CACHE"])
        for name in ["AGENT-SYNC.md", "fleet-apps.json", "docs/protocols/zulip-fleet-guide.md"]:
            self.assertTrue((cache / name).is_file())
        for name in ["board", "agent-sync"]:
            self.assertTrue((Path(self.env["FLEET_COORD_BIN"]) / name).is_file())
        self.legacy.write_text("stale copy after first install")
        self.assertEqual(self.install().returncode, 0)
        self.assertFalse(self.legacy.exists())

    def test_mac_retires_hooks_before_skipping_install(self):
        mock_bin = self.prepare_archive()
        (mock_bin / "uname").write_text("#!/bin/sh\necho Darwin\n")
        self.legacy.write_text("retired script")
        self.assertEqual(self.install().returncode, 0)
        self.assertFalse(self.legacy.exists())
        self.assertFalse(Path(self.env["FLEET_COORD_CACHE"]).exists())

    def test_new_pin_drops_removed_files(self):
        self.prepare_archive()
        self.assertEqual(self.install().returncode, 0)
        cache = Path(self.env["FLEET_COORD_CACHE"])
        stale = cache / "obsolete.py"
        stale.write_text("stale")
        self.env["AFC_SHA"] = "new-pin"
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(stale.exists())
        self.assertEqual((cache / ".pinned-sha").read_text().strip(), "new-pin")

    def test_failed_cli_import_preserves_old_cache_and_pin(self):
        self.prepare_archive()
        self.assertEqual(self.install().returncode, 0)
        cache = Path(self.env["FLEET_COORD_CACHE"])
        old_pin = (cache / ".pinned-sha").read_bytes()
        archive = Path(self.env["TEST_ARCHIVE"])
        with tarfile.open(archive, "r:gz") as source:
            entries = [(item, source.extractfile(item).read()) for item in source]
        with tarfile.open(archive, "w:gz") as target:
            for item, data in entries:
                if item.name.endswith("scripts/agent-sync"):
                    data = b"#!/bin/sh\nexit 1\n"
                    item.size = len(data)
                target.addfile(item, io.BytesIO(data))
        self.env["AFC_SHA"] = "broken-pin"
        self.assertNotEqual(self.install().returncode, 0)
        self.assertEqual((cache / ".pinned-sha").read_bytes(), old_pin)
        self.assertEqual(subprocess.run([str(cache / "scripts/agent-sync"), "--help"]).returncode, 0)
        self.assertFalse(list(cache.parent.glob("cache.stage.*")))

    def test_failed_fetch_never_reports_success_or_stamps_cache(self):
        mock_bin = self.prepare_archive()
        (mock_bin / "curl").write_text("#!/bin/sh\nexit 22\n")
        result = self.install()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((Path(self.env["FLEET_COORD_CACHE"]) / ".pinned-sha").exists())


if __name__ == "__main__":
    unittest.main()
