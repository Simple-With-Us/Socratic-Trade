import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../scripts/simple-tools-fleet-post.sh"
);

describe("simple-tools-fleet-post.sh", () => {
  const src = readFileSync(SCRIPT, "utf8");

  it("does not typo the ~/.local/bin/simple-chat path", () => {
    expect(src).not.toContain('.local/bin/simple-chat}"');
    expect(src).toContain('${HOME}/.local/bin/simple-chat"');
  });

  it("uses documented simple-chat post flags (--topic, --as, --no-tag, optional --channel)", () => {
    expect(src).toMatch(/post_args=\(post --topic/);
    expect(src).toContain("--no-tag");
    expect(src).toContain('--channel "$CHANNEL"');
  });

  it("reads the FLEET_POST_* env family, not the retired one", () => {
    expect(src).toContain("FLEET_POST_REPO");
    expect(src).toContain("FLEET_POST_SEAT");
    expect(src).toContain("FLEET_POST_TOPIC");
    expect(src).toContain("FLEET_POST_CHANNEL");
    expect(src).toContain("FLEET_POST_BIN");
  });

  it("guards HOME under set -u so the no-op path cannot crash", () => {
    expect(src).toContain('[ -n "${HOME:-}" ]');
  });
});
