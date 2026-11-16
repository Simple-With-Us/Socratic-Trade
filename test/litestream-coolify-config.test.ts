import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  LITESTREAM_LEVEL_PRODUCTION_INTERVAL_SECONDS,
  LITESTREAM_PRODUCT_DISABLED_TIERS,
  LITESTREAM_PRODUCT_ENABLED_TIERS
} from "../src/lib/runtime-health";

const require = createRequire(import.meta.url);
const { load: loadYaml } = require("js-yaml") as { load: (source: string) => unknown };

describe("litestream.coolify.yml product compaction", () => {
  it("disables L2/L3 by listing only L1 and stays lockstep with health constants", () => {
    const raw = readFileSync("litestream.coolify.yml", "utf8");
    const cfg = loadYaml(raw) as {
      levels?: Array<{ interval?: unknown }>;
      "verify-compaction"?: unknown;
      verifyCompaction?: unknown;
    };

    expect(cfg.levels, "0.5.12 turns L2/L3 off by omitting them from levels:").toHaveLength(1);
    expect(String(cfg.levels![0]!.interval)).toMatch(/^30s?$/);
    // Comments mention the forbidden key; the parsed document must not set it.
    expect(cfg["verify-compaction"]).toBeUndefined();
    expect(cfg.verifyCompaction).toBeUndefined();
    expect("verify-compaction" in cfg).toBe(false);

    expect([...LITESTREAM_PRODUCT_ENABLED_TIERS]).toEqual(["0", "1", "9"]);
    expect([...LITESTREAM_PRODUCT_DISABLED_TIERS]).toEqual(["2", "3"]);
    expect(LITESTREAM_LEVEL_PRODUCTION_INTERVAL_SECONDS["0"]).toBe(300);
    expect(LITESTREAM_LEVEL_PRODUCTION_INTERVAL_SECONDS["1"]).toBe(30);
    expect(LITESTREAM_LEVEL_PRODUCTION_INTERVAL_SECONDS["9"]).toBe(86400);
  });
});
