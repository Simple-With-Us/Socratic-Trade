/**
 * scripts/infisical-secrets-safe.sh is prod-only (owner 2026-10-10: the Infisical
 * dev and staging environments are retired).  The infisical CLI defaults to
 * `--env dev`, so a call without --env read dev and could report a prod secret as
 * missing.  The wrapper adds `--env prod` when none is given (delete never
 * defaults) and refuses any other value.
 *
 * Every case runs against a stub `infisical` placed first on PATH that only
 * records its arguments.  Nothing here reaches the real CLI, the network, or any
 * credential.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "../scripts/infisical-secrets-safe.sh");
const HAS_JQ = spawnSync("jq", ["--version"], { encoding: "utf8" }).status === 0;

const STUB = `#!/bin/sh
# Test double for the infisical CLI: record argv, print canned output.
{ for a in "$@"; do printf '%s\\n' "$a"; done; echo '---'; } >> "$STUB_LOG"
case "$2" in
  get) echo "stub-value-not-a-secret" ;;
  --output) echo '[{"secretKey":"B_KEY"},{"secretKey":"A_KEY"}]' ;;
esac
`;

let work = "";
let stubDir = "";
let counter = 0;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "infisical-safe-test-"));
  stubDir = join(work, "bin");
  mkdirSync(stubDir, { recursive: true });
  writeFileSync(join(stubDir, "infisical"), STUB);
  chmodSync(join(stubDir, "infisical"), 0o755);
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

function run(args: string[]) {
  const log = join(work, `log-${counter++}.txt`);
  const result = spawnSync("/bin/bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      PATH: `${stubDir}:/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin`,
      HOME: work,
      STUB_LOG: log
    }
  });
  const calls = existsSync(log)
    ? readFileSync(log, "utf8")
        .split("---\n")
        .filter(Boolean)
        .map((c) => c.split("\n").filter(Boolean))
    : [];
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls };
}

function envFlags(argv: string[]): string[] {
  const out: string[] = [];
  argv.forEach((a, i) => {
    if (a === "--env") out.push(argv[i + 1]);
    else if (a.startsWith("--env=")) out.push(a.slice("--env=".length));
  });
  return out;
}

describe("infisical-secrets-safe.sh is prod-only", () => {
  it("has: adds --env prod when no --env is given", () => {
    const r = run(["has", "SOME_KEY", "--projectId", "proj"]);
    expect(r.status).toBe(0);
    expect(r.calls).toEqual([["secrets", "get", "SOME_KEY", "--plain", "--projectId", "proj", "--env", "prod"]]);
    expect(r.stderr).toMatch(/present key=SOME_KEY/);
  });

  it("has: keeps a single explicit --env prod or --env=prod", () => {
    for (const flag of [["--env", "prod"], ["--env=prod"]]) {
      const r = run(["has", "SOME_KEY", "--projectId", "proj", ...flag]);
      expect(r.status).toBe(0);
      expect(envFlags(r.calls[0])).toEqual(["prod"]);
    }
  });

  it("set: adds --env prod and never echoes the value", () => {
    const r = run(["set", "SOME_KEY=hunter2-not-real", "--projectId", "proj"]);
    expect(r.status).toBe(0);
    expect(r.calls).toEqual([["secrets", "set", "SOME_KEY=hunter2-not-real", "--projectId", "proj", "--env", "prod"]]);
    expect(r.stdout + r.stderr).not.toContain("hunter2");
  });

  it("set: still refuses LLM runtime key names", () => {
    const r = run(["set", "GEMINI_API_KEY=x", "--projectId", "proj", "--env", "prod"]);
    expect(r.status).not.toBe(0);
    expect(r.calls).toEqual([]);
  });

  it.skipIf(!HAS_JQ)("names: adds --env prod and prints sorted names only", () => {
    const r = run(["names", "--projectId", "proj"]);
    expect(r.status).toBe(0);
    expect(r.calls).toEqual([["secrets", "--output", "json", "--projectId", "proj", "--env", "prod"]]);
    expect(r.stdout).toBe("A_KEY\nB_KEY\n");
  });

  it("delete: passes with an explicit --env prod", () => {
    const r = run(["delete", "SOME_KEY", "--projectId", "proj", "--env", "prod"]);
    expect(r.status).toBe(0);
    expect(r.calls).toEqual([["secrets", "delete", "SOME_KEY", "--type", "shared", "--silent", "--projectId", "proj", "--env", "prod"]]);
  });

  it("delete: refuses a call with no --env instead of defaulting it", () => {
    const r = run(["delete", "SOME_KEY", "--projectId", "proj"]);
    expect(r.status).not.toBe(0);
    expect(r.calls).toEqual([]);
    expect(r.stderr).toMatch(/needs an explicit --env prod/);
  });

  const refusals: Array<[string, string[]]> = [
    ["--env dev", ["--env", "dev"]],
    ["--env staging", ["--env", "staging"]],
    ["--env=dev", ["--env=dev"]],
    ["--env=staging", ["--env=staging"]],
    ["--env production (not a real slug)", ["--env", "production"]],
    ["--env= (empty)", ["--env="]],
    ["trailing --env with no value", ["--env"]],
    ["prod then dev", ["--env", "prod", "--env", "dev"]],
    ["dev then prod", ["--env=dev", "--env", "prod"]]
  ];
  const bases: string[][] = [["has", "SOME_KEY"], ["set", "SOME_KEY=x"], ["names"], ["delete", "SOME_KEY"]];
  for (const [label, flags] of refusals) {
    for (const base of bases) {
      it(`${base[0]}: refuses ${label} and never calls infisical`, () => {
        const r = run([...base, "--projectId", "proj", ...flags]);
        expect(r.status).not.toBe(0);
        expect(r.calls).toEqual([]);
        expect(r.stderr).toMatch(/prod is the only Infisical environment|only prod is allowed/);
      });
    }
  }

  it("still refuses the leaky output flags", () => {
    const r = run(["names", "--projectId", "proj", "--output=json"]);
    expect(r.status).not.toBe(0);
    expect(r.calls).toEqual([]);
  });
});
