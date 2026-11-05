import os from "os";
import path from "path";
import { beforeAll, describe, expect, it } from "vitest";

process.env.DATABASE_URL = `file:${path.join(os.tmpdir(), `llm-catalog-test-${Date.now()}.db`)}`;

// 26 offered rows as of 2026-11-04 (ST-4589: four OpenAI classes, latest variants, MiniMax M3.1
// Flash, Muse Wonder and the two Code CLI-only Wonder contributor rows).  See
// docs/rollouts/2026-09-18-model-catalog-cleanup.md for the earlier removals.
const OWNER_ROWS: Array<[string, string, string]> = [
  ["gpt-6-astra", "openai/gpt-6-astra", "gpt-6-astra"],
  ["gpt-6.1-sol", "openai/gpt-6.1-sol", "gpt-6.1-sol"],
  ["gpt-6.1-terra", "openai/gpt-6.1-terra", "gpt-6.1-terra"],
  ["gpt-6-luna", "openai/gpt-6-luna", "gpt-6-luna"],
  ["minimax-m3", "minimax/minimax-m3", "MiniMax-M3"],
  ["minimax-m3.1-flash", "minimax/minimax-m3.1-flash", "MiniMax-M3.1-Flash"],
  ["muse-wonder-1.0", "meta/muse-wonder", "muse-wonder-1.0"],
  ["muse-spark-1.3", "meta/muse-spark-1.3", "muse-spark-1.3"],
  ["muse-spark-1.3-contributor", "meta/muse-spark-1.3-contributor", "muse-spark-1.3-contributor"],
  ["muse-glimmer-30b", "meta/muse-glimmer-30b", "muse-glimmer-30b"],
  ["claude-sonnet-latest", "~anthropic/claude-sonnet-latest", "claude-sonnet-5"],
  ["claude-haiku-latest", "~anthropic/claude-haiku-latest", "claude-haiku-5-5"],
  ["claude-opus-latest", "~anthropic/claude-opus-latest", "claude-opus-5-5"],
  ["claude-fable-latest", "~anthropic/claude-fable-latest", "claude-fable-5-1"],
  ["grok-latest", "~x-ai/grok-latest", "grok-4.7"],
  ["gemini-flash-lite-latest", "google/gemini-3.5-flash-lite", "gemini-flash-lite-latest"],
  ["gemini-flash-latest", "~google/gemini-flash-latest", "gemini-flash-latest"],
  ["gemini-pro-latest", "~google/gemini-pro-latest", "gemini-pro-latest"],
  ["mistral-large-latest", "mistralai/mistral-large-4-0", "mistral-large-4-0"],
  ["mistral-medium-latest", "mistralai/mistral-medium-3-5", "mistral-medium-latest"],
  ["mistral-small-latest", "mistralai/mistral-small-2603", "mistral-small-latest"],
  ["kimi-latest", "moonshotai/kimi-k3.1-pro", "kimi-k3.1-pro"],
  ["deepseek-flash-latest", "~deepseek/deepseek-flash-latest", "deepseek-flash"],
  ["deepseek-pro-latest", "deepseek/deepseek-v4-pro-0813", "deepseek-v4-pro"]
];

/** Code CLI-only rows: no OpenRouter id at all (column 2 is empty). */
const CODE_CLI_ONLY_ROWS: Array<[string, string]> = [
  ["muse-wonder-1.0-contributor", "muse-wonder-1.0-contributor"],
  ["muse-wonder-full-1.0-contributor", "muse-wonder-full-1.0-contributor"]
];

/** Retired rows: out of the picker, still resolving for stored selections (own slug + class). */
const RETIRED_ROWS: Array<[string, string, string, string]> = [
  ["gpt-6-astra-pro", "openai/gpt-6-astra-pro", "gpt-6-astra-pro", "openai-astra"],
  ["gpt-5.6-sol", "openai/gpt-5.6-sol", "gpt-5.6-sol", "openai-sol"],
  ["gpt-5.6-luna", "openai/gpt-5.6-luna", "gpt-5.6-luna", "openai-luna"]
];

const ALIASES: Array<[string, string]> = [
  ["claude-sonnet-5", "claude-sonnet-latest"],
  ["claude-sonnet-5-5", "claude-sonnet-latest"],
  ["claude-haiku-4.5", "claude-haiku-latest"],
  ["claude-haiku-4-5-20251001", "claude-haiku-latest"],
  ["gpt-sol-latest", "gpt-6.1-sol"],
  ["gpt-terra-latest", "gpt-6.1-terra"],
  ["gpt-luna-latest", "gpt-6-luna"],
  ["grok-4.6", "grok-latest"],
  ["gemini-4-argon", "gemini-pro-latest"],
  ["mistral-large-2512", "mistral-large-latest"],
  ["kimi-k3", "kimi-latest"],
  ["deepseek-v4-flash-0731", "deepseek-flash-latest"],
  ["deepseek/deepseek-v4.1-flash-1017", "deepseek-flash-latest"],
  ["claude-opus-5-5", "claude-opus-latest"],
  ["claude-opus-5.5", "claude-opus-latest"],
  ["claude-opus-5", "claude-opus-latest"],
  ["claude-fable-5", "claude-fable-latest"],
  ["grok-4.5", "grok-latest"],
  ["deepseek-v4-flash", "deepseek-flash-latest"],
  ["deepseek-v4-pro", "deepseek-pro-latest"],
  ["gemini-3.5-flash-lite", "gemini-flash-lite-latest"],
  ["google/gemini-3.7-flash", "gemini-flash-latest"],
  ["mistral-medium-3.5", "mistral-medium-latest"],
  ["mistral-medium-3-5", "mistral-medium-latest"]
];

describe("three-column LLM catalog", () => {
  let CURATED_LLM_MODEL_IDS: string[];
  let CATALOG_DISPLAY_SLUGS: readonly string[];
  let LLM_MODEL_CATALOG: ReadonlyArray<{ displaySlug: string; openRouterSlug: string; label: string }>;
  let CURATED_LLM_MODEL_GROUPS: ReadonlyArray<{ label: string; options: ReadonlyArray<{ label: string }> }>;
  let displaySlugFor: (model: string | null | undefined) => string;
  let nativeSlugFor: (model: string | null | undefined) => string;
  let openRouterSlugFor: (model: string | null | undefined) => string;
  let nativeModelSlugForProvider: (model: string, family: "openai") => string;
  let normalizeOpenRouterModelId: (raw?: string) => string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let resolveLlmEndpoint: (...args: any[]) => { provider: string; model: string };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let upsertUserApiKey: (...args: any[]) => unknown;

  beforeAll(async () => {
    const { getDb } = await import("../src/lib/db");
    getDb();
    const dbApi = await import("../src/lib/db-api-keys");
    upsertUserApiKey = dbApi.upsertUserApiKey;
    const catalog = await import("../src/lib/llm-model-catalog");
    CATALOG_DISPLAY_SLUGS = catalog.CATALOG_DISPLAY_SLUGS;
    LLM_MODEL_CATALOG = catalog.LLM_MODEL_CATALOG;
    displaySlugFor = catalog.displaySlugFor;
    nativeSlugFor = catalog.nativeSlugFor;
    openRouterSlugFor = catalog.openRouterSlugFor;
    const ui = await import("../app/ui/llm-model-catalog");
    CURATED_LLM_MODEL_IDS = ui.CURATED_LLM_MODEL_IDS;
    CURATED_LLM_MODEL_GROUPS = ui.CURATED_LLM_MODEL_GROUPS;
    const provider = await import("../src/lib/llm-provider");
    nativeModelSlugForProvider = provider.nativeModelSlugForProvider;
    normalizeOpenRouterModelId = provider.normalizeOpenRouterModelId;
    resolveLlmEndpoint = provider.resolveLlmEndpoint;
  });

  it("contains exactly the owner display slugs", () => {
    const all = [...OWNER_ROWS.map(([display]) => display), ...CODE_CLI_ONLY_ROWS.map(([display]) => display)];
    expect([...CATALOG_DISPLAY_SLUGS].sort()).toEqual(all.sort());
    expect(new Set(CURATED_LLM_MODEL_IDS)).toEqual(new Set(CATALOG_DISPLAY_SLUGS));
    expect(new Set(LLM_MODEL_CATALOG.map((row) => row.displaySlug)).size).toBe(all.length);
    for (const [retired] of RETIRED_ROWS) expect(CATALOG_DISPLAY_SLUGS, retired).not.toContain(retired);
  });

  it("keeps retired rows resolving to their own wire slug, native slug and class (ST-4589)", async () => {
    const catalog = await import("../src/lib/llm-model-catalog");
    for (const [display, openRouter, native, modelClass] of RETIRED_ROWS) {
      expect(displaySlugFor(display), display).toBe(display);
      expect(openRouterSlugFor(display), display).toBe(openRouter);
      expect(normalizeOpenRouterModelId(display), display).toBe(openRouter);
      expect(nativeSlugFor(display), display).toBe(native);
      expect(catalog.modelClassFor(display), display).toBe(modelClass);
      expect(catalog.isRetiredCatalogModel(display), display).toBe(true);
      expect(catalog.CATALOG_ROTATION_POOL, display).not.toContain(display);
    }
    // A stored gpt-6-astra-pro is served exactly as before: OpenRouter only, same wire slug.
    expect(catalog.catalogEntryFor("gpt-6-astra-pro")?.openRouterOnly).toBe(true);
    upsertUserApiKey("catalog-retired-user", "openrouter", "sk-or-catalog-retired");
    const astraPro = resolveLlmEndpoint({ llmModel: "gpt-6-astra-pro" }, "catalog-retired-user");
    expect(astraPro.provider).toBe("openrouter");
    expect(astraPro.model).toBe("openai/gpt-6-astra-pro");
    // Retired rows never answer for an id an offered row claims.
    expect(displaySlugFor("gpt-sol-latest")).toBe("gpt-6.1-sol");
    expect(displaySlugFor("gpt-luna-latest")).toBe("gpt-6-luna");
    expect(displaySlugFor("gpt-5.6")).toBe("gpt-5.6-sol");
  });

  it("prices new rows at their OpenRouter list price; Code CLI-only cost stays unknown (ST-4589)", async () => {
    const { estimateLlmCostUsd } = await import("../src/lib/llm-usage");
    const perM = (model: string) => [estimateLlmCostUsd(model, 1_000_000, 0), estimateLlmCostUsd(model, 0, 1_000_000)];
    expect(perM("gpt-6.1-sol")).toEqual([2, 10]);
    expect(perM("openai/gpt-6.1-terra")).toEqual([1, 5]);
    expect(perM("gpt-6-luna")).toEqual([0.1, 0.5]);
    expect(perM("minimax/minimax-m3.1-flash")).toEqual([0.15, 0.6]);
    expect(perM("meta/muse-wonder")).toEqual([4, 20]);
    expect(perM("muse-wonder-1.0")).toEqual([4, 20]);
    expect(perM("mistralai/mistral-large-4-0")).toEqual([0.7, 2.1]);
    expect(perM("moonshotai/kimi-k3.1-pro")).toEqual([2, 10]);
    expect(perM("~deepseek/deepseek-flash-latest")).toEqual([0.3, 1.2]);
    // Retired rows keep a live price; the stored astra-pro price is unchanged.
    expect(perM("openai/gpt-6-astra-pro")).toEqual([10, 50]);
    expect(perM("openai/gpt-5.6-luna")).toEqual([0.2, 1.2]);
    // Never borrows Wonder's price through a prefix match.
    expect(estimateLlmCostUsd("muse-wonder-1.0-contributor", 1_000_000, 1_000_000)).toBeUndefined();
    expect(estimateLlmCostUsd("muse-wonder-full-1.0-contributor", 1_000_000, 1_000_000)).toBeUndefined();
  });

  it("gives Code CLI-only rows no OpenRouter id and labels them (Code CLI only)", async () => {
    const catalog = await import("../src/lib/llm-model-catalog");
    for (const [display, native] of CODE_CLI_ONLY_ROWS) {
      const row = catalog.catalogEntryFor(display);
      expect(row?.codeCliOnly, display).toBe(true);
      expect(row?.openRouterSlug, display).toBe("");
      expect(openRouterSlugFor(display), display).toBe("");
      expect(nativeSlugFor(display), display).toBe(native);
      expect(row?.label, display).toMatch(/\(Code CLI only\)$/);
      expect(catalog.isCodeCliOnlyModel(display), display).toBe(true);
    }
    expect(catalog.catalogEntryFor("")).toBeUndefined();
    expect(catalog.ROTATION_EXCLUDED_DISPLAY_SLUGS).toContain("muse-wonder-1.0");
    expect(catalog.ROTATION_EXCLUDED_DISPLAY_SLUGS).not.toContain("gpt-6-astra-pro");
  });

  it("resolves OpenRouter wire slugs (column 2) and native slugs (column 3)", () => {
    for (const [display, openRouter, native] of OWNER_ROWS) {
      expect(openRouterSlugFor(display), display).toBe(openRouter);
      expect(normalizeOpenRouterModelId(display), display).toBe(openRouter);
      expect(nativeSlugFor(display), display).toBe(native);
      expect(nativeModelSlugForProvider(display, "openai"), display).toBe(native);
    }
  });

  it("round-trips older persisted ids onto the new display slugs", () => {
    for (const [alias, display] of ALIASES) {
      expect(displaySlugFor(alias), alias).toBe(display);
      const row = OWNER_ROWS.find(([id]) => id === display)!;
      expect(normalizeOpenRouterModelId(alias), alias).toBe(row[1]);
      expect(nativeSlugFor(alias), alias).toBe(row[2]);
    }
  });

  it("never sends a display slug to OpenRouter when the wire slug differs", () => {
    expect(normalizeOpenRouterModelId("grok-latest")).toBe("~x-ai/grok-latest");
    expect(normalizeOpenRouterModelId("gemini-flash-lite-latest")).toBe("google/gemini-3.5-flash-lite");
    expect(normalizeOpenRouterModelId("deepseek-flash-latest")).toBe("~deepseek/deepseek-flash-latest");
    expect(normalizeOpenRouterModelId("deepseek-pro-latest")).toBe("deepseek/deepseek-v4-pro-0813");
    expect(normalizeOpenRouterModelId("mistral-small-latest")).toBe("mistralai/mistral-small-2603");
    expect(normalizeOpenRouterModelId("mistral-medium-latest")).toBe("mistralai/mistral-medium-3-5");
    expect(normalizeOpenRouterModelId("mistral-large-latest")).toBe("mistralai/mistral-large-4-0");
    expect(normalizeOpenRouterModelId("kimi-latest")).toBe("moonshotai/kimi-k3.1-pro");
    expect(nativeSlugFor("openai/gpt-5.6-sol")).toBe("gpt-5.6-sol");
    expect(nativeSlugFor("anthropic/claude-sonnet-latest")).toBe("claude-sonnet-5");
    // Sonnet 5.5 stays an alias, and is what the OpenRouter alias is expected to serve.
    expect(displaySlugFor("claude-sonnet-5-5")).toBe("claude-sonnet-latest");
  });

  it("constructs live OpenRouter calls with the wire slug", () => {
    upsertUserApiKey("catalog-or-user", "openrouter", "sk-or-catalog-test");
    const endpoint = resolveLlmEndpoint({ llmModel: "grok-latest" }, "catalog-or-user");
    expect(endpoint.provider).toBe("openrouter");
    expect(endpoint.model).toBe("~x-ai/grok-latest");
    const aliased = resolveLlmEndpoint({ llmModel: "claude-sonnet-5" }, "catalog-or-user");
    expect(aliased.model).toBe("~anthropic/claude-sonnet-latest");
  });

  it("sends OpenRouter family-latest aliases with the required ~ prefix", () => {
    const latestWire = OWNER_ROWS
      .map(([, openRouter]) => openRouter)
      .filter((slug) => /-(?:latest)$/.test(slug.replace(/^~/, "").split("/")[1] ?? ""));
    expect(latestWire.length).toBeGreaterThan(0);
    for (const slug of latestWire) {
      expect(slug.startsWith("~"), slug).toBe(true);
    }
    expect(openRouterSlugFor("gemini-flash-latest:batch")).toBe("google/gemini-3.8-flash:batch");
    expect(normalizeOpenRouterModelId("google/gemini-3.6-flash:batch")).toBe("google/gemini-3.8-flash:batch");
  });

  // Owner formatting/copy rules (2026-09-18 model-catalog cleanup) — see
  // docs/rollouts/2026-09-18-model-catalog-cleanup.md.
  it("formats every dropdown row like the stats/benchmark page (slug-first) and never mentions OpenRouter", () => {
    for (const row of LLM_MODEL_CATALOG) {
      expect(row.label.startsWith(row.displaySlug), row.displaySlug).toBe(true);
      expect(row.label, row.displaySlug).not.toMatch(/openrouter/i);
    }
    for (const group of CURATED_LLM_MODEL_GROUPS) {
      expect(group.label).not.toMatch(/openrouter/i);
      for (const option of group.options) {
        expect(option.label).not.toMatch(/openrouter/i);
      }
    }
  });

  it("keeps predecessor roll-forward inside one model class and never involves terra or llama (ST-4589)", async () => {
    const { catalogEntryFor, modelClassFor, modelClassLabel } = await import("../src/lib/llm-model-catalog");
    for (const row of LLM_MODEL_CATALOG as ReadonlyArray<{ displaySlug: string; lineage?: string; predecessors?: readonly string[] }>) {
      expect(row.lineage, `${row.displaySlug} needs a class`).toBeTruthy();
      for (const pred of row.predecessors ?? []) {
        expect(pred, `${row.displaySlug} <- ${pred}`).not.toMatch(/llama/i);
        // gpt-5.6-terra may only ever feed the Terra class's own row.
        if (row.lineage !== "openai-terra") expect(pred, `${row.displaySlug} <- ${pred}`).not.toBe("gpt-5.6-terra");
        const resolved = catalogEntryFor(pred);
        if (resolved) expect(resolved.lineage, `${row.displaySlug} <- ${pred}`).toBe(row.lineage);
      }
    }
    expect(modelClassFor("gpt-6-astra")).toBe("openai-astra");
    expect(modelClassFor("anthropic/claude-opus-latest")).toBe("anthropic-opus");
    expect(modelClassFor("gpt-5.6-terra")).toBeUndefined();
    // Four OpenAI classes; Muse split into honest classes.
    expect(modelClassFor("gpt-6.1-sol")).toBe("openai-sol");
    expect(modelClassFor("gpt-6.1-terra")).toBe("openai-terra");
    expect(modelClassFor("gpt-6-luna")).toBe("openai-luna");
    expect(modelClassFor("muse-spark-1.3")).toBe("meta-spark");
    expect(modelClassFor("muse-glimmer-30b")).toBe("meta-glimmer");
    expect(modelClassFor("muse-wonder-1.0")).toBe("meta-wonder");
    expect(modelClassFor("muse-wonder-1.0-contributor")).toBe("meta-wonder");
    expect(modelClassFor("muse-wonder-full-1.0-contributor")).toBe("meta-wonder-full");
    expect(modelClassFor("minimax-m3.1-flash")).toBe("minimax-flash");
    expect(catalogEntryFor("gpt-6.1-sol")?.predecessors?.[0]).toBe("gpt-5.6-sol");
    expect(catalogEntryFor("gpt-6-luna")?.predecessors?.[0]).toBe("gpt-5.6-luna");
    expect(catalogEntryFor("gpt-6.1-terra")?.predecessors).toEqual(["gpt-5.6-terra"]);
    expect(modelClassLabel("openai-astra")).toBe("Astra");
    expect(modelClassLabel("anthropic-opus")).toBe("Opus");
    expect(modelClassLabel("meta-muse")).toBe("Muse");
    expect(modelClassLabel("meta-wonder-full")).toBe("Wonder Full");
    expect(modelClassLabel("google-flash-lite")).toBe("Flash Lite");
    expect(modelClassLabel("minimax")).toBe("Minimax");
    expect(modelClassLabel(undefined)).toBe("");
  });

  it("never routes two rows to the same OpenRouter wire slug (Code CLI-only rows have none)", () => {
    const seen = new Map<string, string>();
    for (const row of LLM_MODEL_CATALOG) {
      if (!row.openRouterSlug) continue;
      const prior = seen.get(row.openRouterSlug);
      expect(prior, `${row.displaySlug} and ${prior} both route to ${row.openRouterSlug}`).toBeUndefined();
      seen.set(row.openRouterSlug, row.displaySlug);
    }
  });
});
