import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../scripts/ag***-s**c-fleet-post.sh"
);

describe("ag***-s**c-fleet-post.sh", () => {
  const src = readFileSync(SCRIPT, "utf8");

  it("does not typo the ~/.local/bin/ag***-s**c path", () => {
    expect(src).not.toContain('.local/bin/ag***-s**c}"');
    expect(src).toContain('${HOME}/.local/bin/ag***-s**c"');
  });

  it("uses documented ag***-s**c post flags (--topic, --as, --no-tag, optional --channel)", () => {
    expect(src).toMatch(/post_args=\(post --topic/);
    expect(src).toContain("--no-tag");
    expect(src).toContain('--channel "$CHANNEL"');
  });
});
