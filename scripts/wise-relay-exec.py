#!/usr/bin/env python3
"""Fetch purpose-scoped Infisical config, relay-mint, verify principal, exec.

No personal token fallback. Values stay in subprocess memory. The only
persistent bootstrap is the consuming platform's Infisical service token.
The folder's repository config is ST-specific even when relay permits more.
"""

import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

FOLDER = "/gr-front/wise-st"
REPO = "Simple-With-Us/Socratic-Trade"
ACTOR = "swu-wise[bot]"
PERMISSIONS = {
    "contents": "write",
    "pull_requests": "write",
    "issues": "write",
    "actions": "write",
    "checks": "read",
    "metadata": "read",
}
KEYS = {
    "WISE_GIT_RELAY_BEARER",
    "WISE_GIT_RELAY_URL",
    "WISE_GIT_RELAY_REPOSITORY",
    "WISE_GIT_RELAY_EXPECTED_ACTOR",
    "WISE_GIT_RELAY_PERMISSIONS",
}


class Refused(Exception):
    pass


def configuration(export):
    # Infisical CLI versions emit either a name/value map or secret records.
    if isinstance(export, list):
        values = {}
        for item in export:
            if (
                not isinstance(item, dict)
                or not isinstance(item.get("key"), str)
                or not isinstance(item.get("value"), str)
            ):
                raise Refused("malformed Infisical export")
            if item["key"] in values:
                raise Refused("duplicate Infisical key")
            values[item["key"]] = item["value"]
    elif isinstance(export, dict):
        values = export
    else:
        raise Refused("malformed Infisical export")
    if set(values) != KEYS or any(not isinstance(v, str) or not v for v in values.values()):
        raise Refused("missing, unexpected or empty dedicated-folder configuration")
    if (
        values["WISE_GIT_RELAY_REPOSITORY"] != REPO
        or values["WISE_GIT_RELAY_EXPECTED_ACTOR"] != ACTOR
    ):
        raise Refused("consumer repo or principal configuration mismatch")
    try:
        perms = json.loads(values["WISE_GIT_RELAY_PERMISSIONS"])
    except (ValueError, TypeError):
        raise Refused("invalid permission configuration") from None
    if perms != PERMISSIONS:
        raise Refused("unexpected permission configuration")
    url = urllib.parse.urlsplit(values["WISE_GIT_RELAY_URL"])
    if (
        url.scheme != "https"
        or not url.hostname
        or url.username
        or url.password
        or url.query
        or url.fragment
        or url.path not in ("", "/")
    ):
        raise Refused("relay requires a plain HTTPS origin")
    return values


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise Refused("redirect refused")


def request_json(url, headers, body=None):
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode() if body is not None else None,
        headers={
            "User-Agent": "wise-relay-exec/1.0",
            **headers,
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.build_opener(NoRedirect).open(req, timeout=30) as response:
            raw = response.read(1048577)
            if len(raw) > 1048576:
                raise Refused("response too large")
            return json.loads(raw)
    except (urllib.error.URLError, ValueError, OSError):
        # Never echo provider errors: they may contain headers or credentials.
        raise Refused("authenticated service request failed") from None


def mint_verified(config, request=request_json):
    result = request(
        config["WISE_GIT_RELAY_URL"].rstrip("/") + "/v1/mint_token",
        {"Authorization": "Bearer " + config["WISE_GIT_RELAY_BEARER"]},
        {"repo": REPO, "permissions": PERMISSIONS},
    )
    if not isinstance(result, dict) or result.get("app_slug") != "swu-wise":
        raise Refused("relay App identity mismatch")
    token = result.get("token")
    ttl = result.get("expires_in_seconds")
    if (
        not isinstance(token, str)
        or not re.fullmatch(r"ghs_[A-Za-z0-9_]+", token)
        or not isinstance(ttl, int)
        or isinstance(ttl, bool)
        or not 120 <= ttl <= 3600
    ):
        raise Refused("relay token or expiry malformed")
    viewer = request(
        "https://api.github.com/graphql",
        {"Authorization": "Bearer " + token, "Accept": "application/vnd.github+json"},
        {"query": "query { viewer { login } }"},
    )
    data = viewer.get("data") if isinstance(viewer, dict) else None
    user = data.get("viewer") if isinstance(data, dict) else None
    if (not isinstance(viewer, dict) or viewer.get("errors")
            or not isinstance(user, dict) or user.get("login") != ACTOR):
        raise Refused("GitHub principal mismatch")
    return token


def main():
    if len(sys.argv) < 3 or sys.argv[1] != "--":
        raise Refused("usage: wise-relay-exec.py -- command [args]")
    env = dict(os.environ)
    if not env.get("INFISICAL_TOKEN", "").startswith("st."):
        raise Refused("dedicated Infisical service token required")
    for key in (
        "INFISICAL_CLIENT_ID",
        "INFISICAL_CLIENT_SECRET",
        "INFISICAL_AUTOMATION_CLIENT_ID",
        "INFISICAL_AUTOMATION_CLIENT_SECRET",
        "INFISICAL_UNIVERSAL_AUTH_CLIENT_ID",
        "INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET",
        "GH_TOKEN",
        "GITHUB_TOKEN",
        "GH_ENTERPRISE_TOKEN",
        "GITHUB_ENTERPRISE_TOKEN",
    ):
        env.pop(key, None)
    try:
        run = subprocess.run(
            [
                "infisical",
                "export",
                "--env",
                "prod",
                "--path",
                FOLDER,
                "--format",
                "json",
                "--expand=false",
                "--include-imports=false",
                "--secret-overriding=false",
                "--silent",
                "--telemetry=false",
            ],
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=40,
            check=True,
        )
        if len(run.stdout) > 65536:
            raise Refused("configuration too large")
        config = configuration(json.loads(run.stdout))
    except (subprocess.SubprocessError, OSError, ValueError):
        raise Refused("Infisical dedicated-folder fetch failed") from None
    token = mint_verified(config)
    # Do not pass bearer or Infisical bootstrap to the consumer command.
    env.pop("INFISICAL_TOKEN", None)
    env["GH_TOKEN"] = token
    env["SHEPHERD_EXPECTED_ACTOR"] = ACTOR
    env["EXPECTED_MERGE_ACTOR"] = ACTOR
    env["GITHUB_REPOSITORY"] = REPO
    env["SHEPHERD_HAS_PAT"] = "1"  # App writes trigger CI; no personal credential.
    os.execvpe(sys.argv[2], sys.argv[2:], env)


if __name__ == "__main__":
    try:
        main()
    except Refused as error:
        print("wise relay refused: " + str(error), file=sys.stderr)
        sys.exit(1)
