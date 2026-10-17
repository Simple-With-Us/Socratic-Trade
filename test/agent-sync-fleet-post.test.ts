import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../scripts/agent-sync-fleet-post.sh"
);

describe("agent-sync-fleet-post.sh", () => {
  const src = readFileSync(SCRIPT, "utf8");

  it("does not typo the ~/.local/bin/agent-sync path", () => {
    expect(src).not.toContain('.local/bin/agent-sync}"');
    expect(src).toContain('${HOME}/.local/bin/agent-sync"');
  });

  it("uses documented agent-sync post flags (--topic, --as, --no-tag, optional --channel)", () => {
    expect(src).toMatch(/post_args=\(post --topic/);
    expect(src).toContain("--no-tag");
    expect(src).toContain('--channel "$CHANNEL"');
  });
});
