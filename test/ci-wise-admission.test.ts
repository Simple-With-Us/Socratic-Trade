import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

for (const file of [".github/workflows/ci.yml", ".github/workflows/security.yml", ".github/workflows/e2e.yml", "ci-pending/e2e.yml"]) {
  describe(`${file} same-repo CI actor admission`, () => {
    const source = readFileSync(join(root, file), "utf8");
    const clause = source.match(/case "\$actor" in\n([\s\S]*?)esac/)?.[0];

    it("allows the exact verified Wise app without widening to unknown bots", () => {
      expect(clause).toBeDefined();
      const run = (actor: string) => spawnSync("bash", ["-c", `actor="$1"; ${clause}`, "test", actor]);
      expect(run("swu-wise[bot]").status).toBe(0);
      expect(run("swu-echo[bot]").status).toBe(0);
      expect(run("swu-unverified[bot]").status).not.toBe(0);
      expect(run("untrusted[bot]").status).not.toBe(0);
      expect(clause).not.toContain("swu-*");
    });

    it("preserves the same-repository and fork boundary", () => {
      expect(source).toContain('github.event.pull_request.head.repo.full_name');
      expect(source).toContain('echo "::error::Fork PRs cannot run this job."');
      expect(source).toContain('actor="${{ github.actor }}"');
    });
  });
}

it("allows the exact CODEX app for security scanning without widening to unknown bots", () => {
  const file = ".github/workflows/security.yml";
  const source = readFileSync(join(root, file), "utf8");
  const clause = source.match(/case "\$actor" in\n([\s\S]*?)esac/)?.[0];
  expect(clause).toBeDefined();
  const run = (actor: string) => spawnSync("bash", ["-c", `actor="$1"; ${clause}`, "test", actor]);
  expect(run("swu-codex[bot]").status).toBe(0);
  expect(run("swu-unverified[bot]").status).not.toBe(0);
  expect(run("untrusted[bot]").status).not.toBe(0);
  expect(clause).not.toContain("swu-*");
});

it("documents the same Wise admission as active and parked workflows", () => {
  const policy = readFileSync(join(root, "docs/CI-BOT-PR-POLICY.md"), "utf8");
  expect(policy).toContain("`swu-wise[bot]`");
});
