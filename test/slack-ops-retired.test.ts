import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("Slack operational senders retired", () => {
  it("no ops workflow or script invokes slack-sync.sh or the Slack Web API", () => {
    const hits = execSync(
      [
        "rg -l 'slack-sync\\.sh|slack\\.com/api' scripts .github",
        "--glob '!slack-sync.sh'",
        "--glob '!setup-slack-sync.sh'",
        "--glob '!test-cloud-coordination-bootstrap.py'",
        "--glob '!install-fleet-coordination.sh'",
        "2>/dev/null || true",
      ].join(" "),
      { encoding: "utf8", cwd: process.cwd() },
    ).trim();
    expect(hits).toBe("");
  });
});
