import { describe, expect, it } from "vitest";
import { selectAllRotationModels, toggleRotationModel } from "../app/console/strategy/rotation-models";
import { CURATED_LLM_MODEL_IDS } from "../app/ui/llm-model-catalog";
import { CATALOG_ROTATION_POOL, ROTATION_EXCLUDED_DISPLAY_SLUGS, isCodeCliOnlyModel } from "../src/lib/llm-model-catalog";

// ST-4589 review: "Select All" must tick exactly the default rotation pool, so "all ticked" and
// "nothing ticked" rotate over the same models.  Cost-excluded (Opus, Fable, Wonder) and Code
// CLI-only rows stay opt-in by an explicit tick.
describe("Rotation Models checklist Select All", () => {
  const optIn = CURATED_LLM_MODEL_IDS.filter((id) => ROTATION_EXCLUDED_DISPLAY_SLUGS.includes(id) || isCodeCliOnlyModel(id));

  it("ticks the default pool and never an opt-in-only model", () => {
    expect(optIn).toEqual(expect.arrayContaining(["claude-opus-latest", "claude-fable-latest", "muse-wonder-1.0-contributor", "muse-wonder-full-1.0-contributor"]));
    const all = selectAllRotationModels([]);
    expect(new Set(all)).toEqual(new Set(CATALOG_ROTATION_POOL));
    for (const model of optIn) expect(all).not.toContain(model);
    // Owner 2026-11-05: the Spark contributor is the only Muse row Select All ticks.
    expect(all.filter((id) => id.startsWith("muse-"))).toEqual(["muse-spark-1.3-contributor"]);
    expect(all.filter((id) => id.startsWith("minimax-"))).toEqual(["minimax-m3.1-flash"]);
  });

  it("keeps an already-ticked opt-in model and stored custom ids", () => {
    const current = toggleRotationModel(["my-custom/model"], "claude-opus-latest", true);
    const all = selectAllRotationModels(current);
    expect(all).toContain("claude-opus-latest");
    expect(all).not.toContain("claude-fable-latest");
    expect(all).not.toContain("muse-wonder-1.0-contributor");
    expect(all.at(-1)).toBe("my-custom/model");
    for (const model of CATALOG_ROTATION_POOL) expect(all).toContain(model);
  });
});
