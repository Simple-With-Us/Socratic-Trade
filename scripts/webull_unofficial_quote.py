#!/usr/bin/env python3
"""Read-only quote bridge for the unofficial tedchou12/webull package.

This intentionally does not log in, place orders, or touch paper-trading state.
The Next.js app calls it only when WEBULL_UNOFFICIAL_ENABLED is explicitly on.
"""

from __future__ import annotations

import json
import sys
from typing import Any


def main() -> int:
    symbols = [s.strip().upper() for s in sys.argv[1:] if s.strip()]
    if not symbols:
        print("{}")
        return 0

    try:
        from webull import webull  # type: ignore
    except Exception as exc:
        print(json.dumps({"_error": f"webull package unavailable: {exc}"}))
        return 0

    client = webull()
    output: dict[str, Any] = {}
    for symbol in symbols:
        try:
            quote = client.get_quote(symbol)
            output[symbol] = quote if isinstance(quote, dict) else {"_error": "unexpected response shape"}
        except Exception as exc:
            output[symbol] = {"_error": str(exc)}

    print(json.dumps(output, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
