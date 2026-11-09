import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../scripts/github-actions-infisical-zulip-ops.sh"
);

describe("github-actions-infisical-zulip-ops.sh", () => {
  const src = readFileSync(SCRIPT, "utf8");

  it("loads Zulip keys only through infisical-secrets-safe.sh get (rule 49)", () => {
    expect(src).toContain('INFISICAL_SAFE="${SCRIPT_DIR}/infisical-secrets-safe.sh"');
    expect(src).toMatch(/"\$INFISICAL_SAFE"\s+get/);
    expect(src).not.toMatch(/infisical\s+secrets\s+get/);
  });
});
