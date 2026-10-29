import importlib.util
import json
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "wise_relay", Path(__file__).with_name("wise-relay-exec.py")
)
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)


class AdapterTests(unittest.TestCase):
    def config(self, permissions=None):
        perms = permissions if permissions is not None else w.MERGE_PERMISSIONS
        return {
            "WISE_GIT_RELAY_BEARER": "sbt_fake",
            "WISE_GIT_RELAY_URL": "https://relay.example.test",
            "WISE_GIT_RELAY_REPOSITORY": w.REPO,
            "WISE_GIT_RELAY_EXPECTED_ACTOR": w.ACTOR,
            "WISE_GIT_RELAY_PERMISSIONS": json.dumps(perms),
        }

    def test_config_map(self):
        self.assertEqual(
            w.configuration(self.config(), w.MERGE_PERMISSIONS), self.config()
        )

    def test_config_list(self):
        self.assertEqual(
            w.configuration(
                [{"key": k, "value": v} for k, v in self.config().items()],
                w.MERGE_PERMISSIONS,
            ),
            self.config(),
        )

    def test_readonly_permissions(self):
        cfg = self.config(w.READONLY_PERMISSIONS)
        self.assertEqual(
            w.configuration(cfg, w.READONLY_PERMISSIONS),
            cfg,
        )

    def test_duplicate(self):
        with self.assertRaises(w.Refused):
            w.configuration(
                [{"key": "x", "value": "a"}, {"key": "x", "value": "b"}],
                w.MERGE_PERMISSIONS,
            )

    def test_config_requires_exact_keys(self):
        for extra in [True, False]:
            c = self.config()
            if extra:
                c["X"] = "x"
            else:
                c.pop("WISE_GIT_RELAY_BEARER")
            with self.assertRaises(w.Refused):
                w.configuration(c, w.MERGE_PERMISSIONS)

    def test_repo_actor_perms(self):
        for k, v in [
            ("WISE_GIT_RELAY_REPOSITORY", "other/Repo"),
            ("WISE_GIT_RELAY_EXPECTED_ACTOR", "jaywedgeworth22"),
            ("WISE_GIT_RELAY_PERMISSIONS", "{}"),
        ]:
            c = self.config()
            c[k] = v
            with self.assertRaises(w.Refused):
                w.configuration(c, w.MERGE_PERMISSIONS)

    def test_relay_origin(self):
        for u in [
            "http://relay.test",
            "https://x@y.test",
            "https://y.test/other",
            "https://y.test/?token=secret",
        ]:
            c = self.config()
            c["WISE_GIT_RELAY_URL"] = u
            with self.assertRaises(w.Refused):
                w.configuration(c, w.MERGE_PERMISSIONS)

    def run_mint(
        self,
        login=w.ACTOR,
        ttl=3590,
        slug="swu-wise",
        token="ghs_fake",
        granted=None,
    ):
        calls = []

        def request(url, headers, body):
            calls.append((url, headers, body))
            if len(calls) == 1:
                payload = {
                    "app_slug": slug,
                    "token": token,
                    "expires_in_seconds": ttl,
                }
                if granted is not None:
                    payload["permissions"] = granted
                elif body and body.get("permissions") == w.MERGE_PERMISSIONS:
                    payload["permissions"] = w.MERGE_PERMISSIONS
                return payload
            return {"data": {"viewer": {"login": login}}}

        return w.mint_verified(self.config(), w.MERGE_PERMISSIONS, request), calls

    def test_mint_verified(self):
        token, calls = self.run_mint()
        self.assertEqual(token, "ghs_fake")
        self.assertEqual(len(calls), 2)
        self.assertEqual(
            calls[0][2], {"repo": w.REPO, "permissions": w.MERGE_PERMISSIONS}
        )
        self.assertEqual(calls[1][0], "https://api.github.com/graphql")
        self.assertNotIn("sbt_fake", str(calls[1]))

    def test_no_personal_or_echo_principal(self):
        for name in ["jaywedgeworth22", "swu-echo[bot]", "github-actions[bot]", None]:
            with self.assertRaises(w.Refused):
                self.run_mint(login=name)

    def test_token_bounds(self):
        for kwargs in [
            {"ttl": 1},
            {"ttl": 3601},
            {"ttl": True},
            {"slug": "swu-echo"},
            {"token": "ghp_fake"},
        ]:
            with self.assertRaises(w.Refused):
                self.run_mint(**kwargs)

    def test_null_and_malformed_viewer_refused(self):
        for response in [None, {}, {"data": None}, {"data": []},
                         {"data": {"viewer": None}}, {"data": {"viewer": []}},
                         {"errors": ["denied"]}]:
            calls = []
            def request(url, headers, body):
                calls.append(url)
                if len(calls) == 1:
                    return {
                        "app_slug": "swu-wise",
                        "token": "ghs_fake",
                        "expires_in_seconds": 3590,
                        "permissions": w.MERGE_PERMISSIONS,
                    }
                return response
            with self.assertRaises(w.Refused):
                w.mint_verified(self.config(), w.MERGE_PERMISSIONS, request)

    def test_source_keeps_secret_in_memory(self):
        source = Path(w.__file__).read_text()
        self.assertNotIn("GITHUB_ENV", source)
        self.assertNotIn("--github-env", source)
        self.assertNotIn("--projectId", source)
        self.assertNotIn("8dae6d03", source)

    def test_readonly_mint_uses_read_scopes(self):
        calls = []

        def request(url, headers, body):
            calls.append((url, headers, body))
            if len(calls) == 1:
                return {
                    "app_slug": "swu-wise",
                    "token": "ghs_fake",
                    "expires_in_seconds": 3590,
                    "permissions": w.READONLY_PERMISSIONS,
                }
            return {"data": {"viewer": {"login": w.ACTOR}}}

        w.mint_verified(self.config(w.READONLY_PERMISSIONS), w.READONLY_PERMISSIONS, request)
        self.assertEqual(
            calls[0][2], {"repo": w.REPO, "permissions": w.READONLY_PERMISSIONS}
        )

    def test_readonly_mode_skips_merge_env_exports(self):
        source = Path(w.__file__).read_text()
        self.assertIn("if read_only:", source)
        self.assertIn('env.pop("SHEPHERD_HAS_PAT", None)', source)
        self.assertIn('READONLY_FOLDER', source)
        self.assertNotIn("EXPECTED_MERGE_ACTOR", source)
        self.assertNotIn("SHEPHERD_EXPECTED_ACTOR", source)

    def test_argv_for_child_injects_merge_shepherd_actor(self):
        actor = "swu-wise[bot]"
        self.assertEqual(
            w.argv_for_child(["bash", "scripts/merge-shepherd.sh"], actor),
            ["bash", "scripts/merge-shepherd.sh", "--expected-actor", actor],
        )
        self.assertEqual(
            w.argv_for_child(["scripts/merge-shepherd.sh"], actor),
            ["scripts/merge-shepherd.sh", "--expected-actor", actor],
        )
        self.assertEqual(
            w.argv_for_child(["/repo/scripts/merge-shepherd.sh", "--dry"], actor),
            ["/repo/scripts/merge-shepherd.sh", "--expected-actor", actor, "--dry"],
        )
        self.assertEqual(
            w.argv_for_child(["bash", "-c", "echo hi"], actor),
            ["bash", "-c", "echo hi"],
        )

    def test_argv_for_child_refuses_caller_supplied_actor(self):
        actor = "swu-wise[bot]"
        for command in (
            ["bash", "scripts/merge-shepherd.sh", "--expected-actor", "mallory"],
            ["scripts/merge-shepherd.sh", "--expected-actor=mallory"],
        ):
            with self.assertRaisesRegex(w.Refused, "may not supply --expected-actor"):
                w.argv_for_child(command, actor)

    def test_readonly_and_merge_modes_both_inject_actor(self):
        source = Path(w.__file__).read_text()
        main_src = source.split("def main():", 1)[1]
        inject = main_src.index("argv_for_child(")
        self.assertLess(inject, main_src.index("if read_only:\n        env.pop"))

    def test_admin_and_unknown_levels_count_as_over_grant(self):
        self.assertTrue(w.permission_exceeds("admin", "write"))
        self.assertTrue(w.permission_exceeds("admin", "read"))
        self.assertTrue(w.permission_exceeds("maintain", "read"))
        self.assertTrue(w.permission_exceeds(None, "read"))
        self.assertFalse(w.permission_exceeds("read", "write"))
        self.assertFalse(w.permission_exceeds("none", "read"))
        granted = dict(w.READONLY_PERMISSIONS, contents="admin")

        def request(url, headers, body):
            return {
                "app_slug": "swu-wise",
                "token": "ghs_fake",
                "expires_in_seconds": 3590,
                "permissions": granted,
            }

        with self.assertRaisesRegex(w.Refused, "relay granted scopes exceed"):
            w.mint_verified(
                self.config(w.READONLY_PERMISSIONS),
                w.READONLY_PERMISSIONS,
                request,
            )

    def test_relay_granted_scopes_must_match_readonly(self):
        def request(url, headers, body):
            return {
                "app_slug": "swu-wise",
                "token": "ghs_fake",
                "expires_in_seconds": 3590,
                "permissions": w.MERGE_PERMISSIONS,
            }

        with self.assertRaisesRegex(w.Refused, "relay granted scopes exceed"):
            w.mint_verified(
                self.config(w.READONLY_PERMISSIONS),
                w.READONLY_PERMISSIONS,
                request,
            )

    def test_readonly_mint_requires_granted_scope_echo(self):
        def request(url, headers, body):
            return {
                "app_slug": "swu-wise",
                "token": "ghs_fake",
                "expires_in_seconds": 3590,
            }

        with self.assertRaisesRegex(w.Refused, "did not report the granted scopes"):
            w.mint_verified(
                self.config(w.READONLY_PERMISSIONS),
                w.READONLY_PERMISSIONS,
                request,
            )

    def test_readonly_mint_reports_fewer_scopes(self):
        narrow = dict(w.READONLY_PERMISSIONS)
        narrow.pop("actions")

        def request(url, headers, body):
            return {
                "app_slug": "swu-wise",
                "token": "ghs_fake",
                "expires_in_seconds": 3590,
                "permissions": narrow,
            }

        with self.assertRaisesRegex(w.Refused, "fewer scopes than requested"):
            w.mint_verified(
                self.config(w.READONLY_PERMISSIONS),
                w.READONLY_PERMISSIONS,
                request,
            )

    def test_exec_token_is_masked_in_actions(self):
        source = Path(w.__file__).read_text()
        self.assertIn('print("::add-mask::" + token, flush=True)', source)
        self.assertIn('os.environ.get("GITHUB_ACTIONS") == "true"', source)


if __name__ == "__main__":
    unittest.main()
