import { describe, expect, it } from "vitest";
import { modelDisplayName } from "../app/console/lib/models";
import { CHAT_MODEL_GROUPS, CURATED_LLM_MODEL_GROUPS } from "../app/ui/llm-model-catalog";
import { reasoningCapabilityForModel } from "../src/lib/llm-request";
import {
  reasoningAdviceForModel,
  recommendedReasoningEffortForModel
} from "../src/lib/model-reasoning-recommendations";

describe("curated OpenAI model choices across LLM surfaces", () => {
  const openAi = CURATED_LLM_MODEL_GROUPS.find((group) => group.provider === "openai")!;

  // 2026-09-18 catalog cleanup (cursor/model-catalog-cleanup, #3414): the curated OpenAI group
  // dropped 5 strictly-dominated rows (gpt-5.4-nano, gpt-mini-latest, gpt-5.6-terra, gpt-4o,
  // gpt-4o-mini). Only four rows remain: gpt-6-astra-pro (the pro-reasoning-mode alias of astra),
  // gpt-6-astra, gpt-5.6-luna, and gpt-5.6-sol. Green recommendation moved from terra to sol;
  // sol now carries BOTH green and red chips.
  // ST-4589 (2026-11-04): four OpenAI CLASSES — Astra, Sol, Terra, Luna — one current row each.
  // gpt-6-astra-pro (astra in pro reasoning mode) and gpt-5.6-sol / gpt-5.6-luna left the picker
  // as retired rows; both recommendation chips moved to gpt-6.1-sol.
  it("offers the four curated OpenAI class rows: Astra + Sol (Green/Red) + Terra + Luna", () => {
    expect(openAi.options.map((option) => option.value)).toEqual([
      "gpt-6-astra",
      "gpt-6.1-sol",
      "gpt-6.1-terra",
      "gpt-6-luna"
    ]);
    expect(openAi.options.find((option) => option.value === "gpt-6.1-sol")?.recommendedGreen).toBe(true);
    expect(openAi.options.find((option) => option.value === "gpt-6.1-sol")?.recommendedRed).toBe(true);
    for (const retired of ["gpt-6-astra-pro", "gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.6-terra"]) {
      expect(openAi.options.some((option) => option.value === retired), retired).toBe(false);
    }
    expect(openAi.options.some((option) => option.value === "gpt-4o" || option.value === "gpt-4o-mini")).toBe(false);
    expect(openAi.options.some((option) => option.value === "gpt-mini-latest" || option.value === "gpt-5.4-nano")).toBe(false);
  });

  it("shares the exact curated OpenAI options with Coach/chat", () => {
    expect(CHAT_MODEL_GROUPS.find((group) => group.provider === "openai")?.options).toEqual(openAi.options);
  });

  it("has a visible reasoning control and role-specific recommendation for every curated OpenAI option", () => {
    // All four remaining OpenAI rows are reasoning-capable (frontier + cost-sensitive).
    for (const option of openAi.options) {
      expect(reasoningCapabilityForModel(option.value)).toBeDefined();
      expect(recommendedReasoningEffortForModel(option.value, "green")).toBeTruthy();
      expect(recommendedReasoningEffortForModel(option.value, "red")).toBeTruthy();
      expect(recommendedReasoningEffortForModel(option.value, "chat")).toBeTruthy();
      expect(recommendedReasoningEffortForModel(option.value, "review")).toBeTruthy();
      expect(modelDisplayName(option.value)).toMatch(/^GPT/);
    }
  });


  it("pins the intended role/effort guidance for the remaining GPT-5.6 rows", () => {
    expect(recommendedReasoningEffortForModel("gpt-5.6-luna", "chat")).toBe("low");
    expect(recommendedReasoningEffortForModel("gpt-5.6-luna", "green")).toBe("medium");
    expect(recommendedReasoningEffortForModel("gpt-5.6-sol", "green")).toBe("medium");
    expect(recommendedReasoningEffortForModel("gpt-5.6-sol", "red")).toBe("high");
    expect(recommendedReasoningEffortForModel("gpt-5.6-sol", "review")).toBe("high");
  });

  it("carries the Sol and Luna guidance to the GPT-6.1 Sol / GPT-6 Luna rows, and gives each class its ladder", () => {
    expect(recommendedReasoningEffortForModel("gpt-6-luna", "chat")).toBe("low");
    expect(recommendedReasoningEffortForModel("gpt-6-luna", "green")).toBe("medium");
    expect(recommendedReasoningEffortForModel("gpt-6.1-sol", "green")).toBe("medium");
    expect(recommendedReasoningEffortForModel("gpt-6.1-sol", "red")).toBe("high");
    expect(recommendedReasoningEffortForModel("gpt-6.1-terra", "chat")).toBe("low");
    const values = (model: string) => reasoningCapabilityForModel(model)?.options.map((o) => o.value);
    // OpenAI: gpt-6.1-sol "does not support none or minimal"; OpenRouter lists low..max.
    expect(values("gpt-6.1-sol")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(values("openai/gpt-6.1-sol")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(values("gpt-6.1-terra")).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
    expect(values("gpt-6-luna")).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
    // Astra is unchanged (conservative low/medium/high).
    expect(values("gpt-6-astra")).toEqual(["low", "medium", "high"]);
  });
});
