"""Retry decisions for scripts/sync-effort-issues.py.

Run: python3 -m unittest scripts/sync_effort_issues_retry_test.py
"""

from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path


def _load():
    path = Path(__file__).with_name("sync-effort-issues.py")
    spec = importlib.util.spec_from_file_location("sync_effort_issues", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


sync = _load()


class RetryDecisionTest(unittest.TestCase):
    def test_patch_500_empty_body_retries(self) -> None:
        self.assertTrue(sync._should_retry_response("PATCH", 500, {}, {}))

    def test_get_500_retries(self) -> None:
        self.assertTrue(sync._should_retry_response("GET", 500, {}, {}))

    def test_post_500_is_not_replayed(self) -> None:
        self.assertFalse(sync._should_retry_response("POST", 500, {}, {}))

    def test_patch_404_is_final(self) -> None:
        self.assertFalse(
            sync._should_retry_response("PATCH", 404, {"message": "Not Found"}, {})
        )

    def test_patch_422_is_final(self) -> None:
        self.assertFalse(sync._should_retry_response("PATCH", 422, {"message": "Validation Failed"}, {}))

    def test_patch_502_still_retries(self) -> None:
        self.assertTrue(sync._should_retry_response("PATCH", 502, {}, {}))

    def test_post_502_keeps_the_gateway_retry(self) -> None:
        self.assertTrue(sync._should_retry_response("POST", 502, {}, {}))

    def test_patch_bare_429_retries(self) -> None:
        self.assertTrue(sync._should_retry_response("PATCH", 429, {}, {}))

    def test_post_bare_429_is_not_a_new_replay(self) -> None:
        self.assertFalse(sync._should_retry_response("POST", 429, {}, {}))

    def test_post_429_with_rate_limit_message_still_retries(self) -> None:
        self.assertTrue(
            sync._should_retry_response(
                "POST", 429, {"message": "You have exceeded a secondary rate limit"}, {}
            )
        )


if __name__ == "__main__":
    unittest.main()
