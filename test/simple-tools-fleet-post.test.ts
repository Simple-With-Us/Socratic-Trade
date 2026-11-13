import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "st-retired-post-"));
  temporary.push(dir);
  const marker = join(dir, "client-invoked");
  const trap = "#!/bin/sh\nprintf invoked >> '" + marker.replaceAll("'", "'\\''") + "'\nexit 99\n";
  for (const name of ["simple-chat", "curl", "wget", "ssh"]) {
    writeFileSync(join(dir, name), trap);
    chmodSync(join(dir, name), 0o700);
  }
  return { dir, marker, env: { NODE_ENV: "test" as const, HOME: dir, TMPDIR: dir, PATH: dir, FLEET_POST_BIN: join(dir, "simple-chat") } };
}

describe("retired fleet-post compatibility paths", () => {
  it.each([false, true])("refuses without any client invocation (legacy config: %s)", (configured) => {
    const f = fixture();
    const env = configured ? {
      ...f.env, FLEET_POST_SEAT: "CURSOR", FLEET_POST_TOPIC: "fleet",
      ZULIP_EMAIL: "synthetic@example.invalid", ZULIP_API_KEY: "unused",
    } : f.env;
    const result = spawnSync("/bin/bash", [join(ROOT, "scripts/simple-tools-fleet-post.sh"), "body-must-not-be-printed"], { env, encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("retired");
    expect(result.stderr).toContain("shared simple-chat");
    expect(result.stderr).not.toMatch(/CURSOR|CLAUDE|FLEET|@\*\*all|body-must-not-be-printed/);
    expect(existsSync(f.marker)).toBe(false);
  });

  it("fails the retired manual post adapter before authentication or transport", () => {
    const f = fixture();
    const result = spawnSync("/bin/bash", [join(ROOT, "scripts/slack-sync.sh"), "post", "body-must-not-be-printed"], {
      env: { ...f.env, SLACK_BOT_TOKEN: "synthetic-unused", SLACK_AGENT_NAME: "CLAUDE" }, encoding: "utf8",
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("post is retired");
    expect(result.stderr).toContain("shared simple-chat");
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toMatch(/CLAUDE|body-must-not-be-printed/);
    expect(existsSync(f.marker)).toBe(false);
  });
});

describe("provider knob journal without a fleet client", () => {
  it.each(["dry-run", "success", "failure"])("keeps the knob outcome and journal (%s)", (mode) => {
    const writeFails = mode === "failure";
    const f = fixture();
    const curl = `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then shift; out=$1; fi
  shift
done
printf '%s' '[{"provider":{"name":"fixture"},"status":"active","knobEnv":{"PROVIDER_QUOTA_TEST":2}}]' > "$out"
`;
    const ssh = `#!/bin/sh
cat >/dev/null
case "$*" in
  *PROVIDER_QUOTA_TEST=2*)
    if [ "\${FAKE_WRITE_FAILURE:-0}" = "1" ]; then
      printf 'FAIL\\tPROVIDER_QUOTA_TEST\\tfixture write failed\\n'
    else
      printf 'OK\\tPROVIDER_QUOTA_TEST\\n'
    fi ;;
  *) printf 'PROVIDER_QUOTA_TEST=1\\n' ;;
esac
`;
    for (const [name, source] of [["curl", curl], ["ssh", ssh]]) {
      writeFileSync(join(f.dir, name), source);
      chmodSync(join(f.dir, name), 0o700);
    }
    const args = [join(ROOT, "scripts/sync-provider-knobs.sh"), ...(mode === "dry-run" ? [] : ["--apply"])];
    const result = spawnSync("/bin/bash", args, {
      env: { ...f.env, PATH: f.dir + ":" + dirname(process.execPath) + ":/usr/bin:/bin",
        USAGE_READ_TOKEN: "synthetic-read", USAGE_API: "https://fixture.invalid",
        KNOB_SYNC_SSH_HOST: "fixture.invalid", KNOB_SYNC_BOX_ENV: "/fixture/unused",
        FAKE_WRITE_FAILURE: writeFails ? "1" : "0",
      }, encoding: "utf8",
    });
    expect(result.status).toBe(writeFails ? 1 : 0);
    if (mode === "dry-run") {
      expect(result.stdout).toContain("PROVIDER_QUOTA_TEST: 1 -> 2 (plan fixture active)");
      expect(result.stderr).not.toContain("applying");
    } else if (writeFails) {
      expect(result.stderr).toContain("FAILED PROVIDER_QUOTA_TEST: fixture write failed");
      expect(result.stderr).not.toContain("wrote PROVIDER_QUOTA_TEST:");
    } else {
      expect(result.stderr).toMatch(/^\[knob-sync\] wrote PROVIDER_QUOTA_TEST: 1 -> 2 \(plan fixture active\)$/m);
    }
    expect(existsSync(f.marker)).toBe(false);
  });
});
