#!/usr/bin/env python3
"""Post one fleet-infra Sentry error event for the ST Litestream restore drill.

Thin alias of st-container-restart-monitor-sentry.py with a distinct logger tag.
Reads SENTRY_FLEET_DSN from the environment.  Never prints the DSN.  Pure stdlib.
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_SIBLING = _HERE / "st-container-restart-monitor-sentry.py"


def main() -> int:
    if len(sys.argv) < 3:
        print(
            "usage: st-litestream-restore-drill-sentry.py <reason> <message>",
            file=sys.stderr,
        )
        return 1
    if not _SIBLING.is_file():
        print(f"st-litestream-restore-drill-sentry: missing {_SIBLING}", file=sys.stderr)
        return 1
    spec = importlib.util.spec_from_file_location("st_restart_sentry", _SIBLING)
    if spec is None or spec.loader is None:
        print("st-litestream-restore-drill-sentry: cannot load sentry helper", file=sys.stderr)
        return 1
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return int(mod.main())


if __name__ == "__main__":
    raise SystemExit(main())
