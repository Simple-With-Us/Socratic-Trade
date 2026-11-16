/**
 * Canonical three-column LLM catalog (owner 2026-08-21).
 *
 * 1. displaySlug — persisted / UI / settings / logs / picker
 * 2. openRouterSlug — OpenRouter chat/completions `model` on live calls
 * 3. nativeSlug — direct provider APIs (not used for live traffic today)
 *
 * Parentheticals in owner copy (e.g. "gemini-pro-latest (3.1)") are version hints
 * only.  They are never stored.
 */

export type CatalogProviderId =
  | "openai"
  | "anthropic"
  | "xai"
  | "gemini"
  | "mistral"
  | "deepseek"
  | "meta"
  | "moonshot"
  | "minimax";

export type CatalogTier = "" | "$" | "$$" | "$$$";

export interface LlmCatalogEntry {
  displaySlug: string;
  openRouterSlug: string;
  nativeSlug: string;
  /** No supported direct-provider transport in this app. */
  openRouterOnly?: boolean;
  provider: CatalogProviderId;
  label: string;
  tier: CatalogTier;
  recommendedGreen?: boolean;
  recommendedRed?: boolean;
  /** Older persisted / OpenRouter / native ids that must resolve to this row. */
  aliases: readonly string[];
  /** Model CLASS identifier (e.g. "openai-sol", "anthropic-sonnet", "google-flash"). Stats only ever
   *  roll forward between models of the SAME class; terra, sol, luna and astra are four classes. */
  lineage?: string;
  /** Same-class predecessor model slugs whose stats may be shown as an ESTIMATE for this model
   *  (never added into its own counts). Must not cross classes. */
  predecessors?: readonly string[];
  /** Served ONLY through the Code CLI broker route (no OpenRouter or Model API id).  Refused on
   *  every other route, and outside rotation / implicit failover unless Code CLI is ready. */
  codeCliOnly?: boolean;
  /** Left the picker; kept only so a stored selection keeps resolving (RETIRED_LLM_MODEL_CATALOG). */
  retired?: boolean;
  /** The concrete model a `-latest` OpenRouter alias is expected to serve, when that differs from
   *  nativeSlug (the native route can deliberately lag; see the Sonnet row).  Used by the stats
   *  view's "expected" line in preference to nativeSlug. */
  expectedLatestSlug?: string;
}

export const LLM_MODEL_CATALOG: readonly LlmCatalogEntry[] = [
  // OpenAI has four model classes (owner 2026-11-04): Astra, Sol, Terra, Luna.  gpt-6-astra-pro
  // left the picker: it is gpt-6-astra served with reasoning.mode=pro, not a separate model.
  // RETIRED_LLM_MODEL_CATALOG below keeps a stored selection of it (and of gpt-5.6-sol/luna)
  // resolving exactly as before.
  {
    displaySlug: "gpt-6-astra",
    openRouterSlug: "openai/gpt-6-astra",
    nativeSlug: "gpt-6-astra",
    provider: "openai",
    label: "gpt-6-astra — frontier OpenAI reasoning",
    tier: "$$$",
    aliases: ["openai/gpt-6-astra"],
    lineage: "openai-astra",
    predecessors: []
  },
  {
    displaySlug: "gpt-6.1-sol",
    openRouterSlug: "openai/gpt-6.1-sol",
    nativeSlug: "gpt-6.1-sol",
    provider: "openai",
    label: "gpt-6.1-sol — frontier professional reasoning",
    tier: "$$$",
    // Both recommendation chips moved here from gpt-5.6-sol (2026-11-04): same class, newer
    // generation, $2/$10 on OpenRouter (gpt-5.6-sol now lists $4/$20).
    recommendedGreen: true,
    recommendedRed: true,
    aliases: ["gpt-sol-latest", "openai/gpt-6.1-sol"],
    lineage: "openai-sol",
    predecessors: ["gpt-5.6-sol", "gpt-5.5", "gpt-5.6"]
  },
  {
    displaySlug: "gpt-6.1-terra",
    openRouterSlug: "openai/gpt-6.1-terra",
    nativeSlug: "gpt-6.1-terra",
    provider: "openai",
    label: "gpt-6.1-terra — mid-cost OpenAI reasoning",
    tier: "$$",
    aliases: ["gpt-terra-latest", "openai/gpt-6.1-terra"],
    lineage: "openai-terra",
    predecessors: ["gpt-5.6-terra"]
  },
  {
    displaySlug: "gpt-6-luna",
    openRouterSlug: "openai/gpt-6-luna",
    nativeSlug: "gpt-6-luna",
    provider: "openai",
    label: "gpt-6-luna — current cost-sensitive tier",
    tier: "$",
    aliases: ["gpt-luna-latest", "openai/gpt-6-luna"],
    lineage: "openai-luna",
    predecessors: ["gpt-5.6-luna", "gpt-5.4", "gpt-4o-mini"]
  },
  {
    displaySlug: "claude-haiku-latest",
    openRouterSlug: "~anthropic/claude-haiku-latest",
    nativeSlug: "claude-haiku-5-5",
    provider: "anthropic",
    label: "claude-haiku-latest (5.5) — fast low-cost Claude",
    tier: "$",
    recommendedGreen: true,
    aliases: [
      "claude-haiku-5-5",
      "claude-haiku-5.5",
      "anthropic/claude-haiku-5.5",
      "claude-haiku-4-5-20251001",
      "claude-haiku-4.5",
      "claude-haiku-4-5",
      "claude-haiku",
      "anthropic/claude-haiku-latest",
      "anthropic/claude-haiku-4.5"
    ],
    lineage: "anthropic-haiku",
    predecessors: ["claude-haiku-4-5-20251001", "claude-haiku-4.5", "claude-haiku-4-5", "claude-haiku"]
  },
  {
    displaySlug: "claude-sonnet-latest",
    openRouterSlug: "~anthropic/claude-sonnet-latest",
    // Native stays on claude-sonnet-5 on purpose: Sonnet 5.5 rejects forced tool use (400 on
    // every request, Anthropic thinking docs), and the native Anthropic body in llm-call.ts forces
    // a single tool for structured JSON.  Moving the native path to structured outputs is a
    // tracked follow-up.  The OpenRouter alias serves Sonnet 5.5 (expectedLatestSlug below), and
    // claude-sonnet-5-5 stays an alias so served ids still canonicalise to this row.
    nativeSlug: "claude-sonnet-5",
    expectedLatestSlug: "claude-sonnet-5-5",
    provider: "anthropic",
    label: "claude-sonnet-latest (5.5) — balanced Claude analysis",
    tier: "$$",
    recommendedRed: true,
    aliases: [
      "claude-sonnet-5-5",
      "claude-sonnet-5.5",
      "anthropic/claude-sonnet-5.5",
      "claude-sonnet-5",
      "claude-sonnet-4-6",
      "claude-sonnet-4.6",
      "claude-sonnet",
      "anthropic/claude-sonnet-latest",
      "anthropic/claude-sonnet-5"
    ],
    lineage: "anthropic-sonnet",
    predecessors: ["claude-sonnet-5", "claude-sonnet-4-6", "claude-sonnet-4.6", "claude-3-5-sonnet"]
  },
  {
    displaySlug: "claude-opus-latest",
    openRouterSlug: "~anthropic/claude-opus-latest",
    nativeSlug: "claude-opus-5-5",
    provider: "anthropic",
    label: "claude-opus-latest (5.5) — premium Claude reasoning",
    tier: "$$$",
    aliases: [
      "claude-opus-5-5",
      "claude-opus-5.5",
      "anthropic/claude-opus-5-5",
      "anthropic/claude-opus-5.5",
      "claude-opus-5",
      // Opus 5.5 base price is $4/$20 per million input/output tokens, verified
      // 2026-11-13 against Anthropic's model overview and OpenRouter's model list.
      // See src/lib/llm-usage.ts for the matching estimate. Historical pinned
      // generations keep their own price-table entries.
      "claude-opus-4-8",
      "claude-opus-4.8",
      "claude-opus",
      "anthropic/claude-opus-latest",
      "anthropic/claude-opus-5",
      "anthropic/claude-opus-5.5"
    ],
    lineage: "anthropic-opus",
    predecessors: ["claude-opus-5", "claude-opus-4-8", "claude-opus-4.8"]
  },
  {
    displaySlug: "claude-fable-latest",
    openRouterSlug: "~anthropic/claude-fable-latest",
    nativeSlug: "claude-fable-5-1",
    provider: "anthropic",
    label: "claude-fable-latest (5.1) — most capable Claude",
    tier: "$$$",
    aliases: ["claude-fable-5-1", "claude-fable-5.1", "anthropic/claude-fable-5.1", "claude-fable-5", "claude-fable", "anthropic/claude-fable-latest", "anthropic/claude-fable-5"],
    lineage: "anthropic-fable",
    predecessors: ["claude-fable-5-1", "claude-fable-5"]
  },
  {
    displaySlug: "grok-latest",
    openRouterSlug: "~x-ai/grok-latest",
    nativeSlug: "grok-4.7",
    provider: "xai",
    label: "grok-latest (4.7) — default Grok analysis",
    tier: "$$",
    aliases: ["grok-4.7", "x-ai/grok-4.7", "grok-4.6", "x-ai/grok-4.6", "grok-4.5", "grok-4.3", "grok", "x-ai/grok-latest", "x-ai/grok-4.5", "xai/grok-latest"],
    lineage: "xai-grok",
    predecessors: ["grok-4.6", "grok-4.5", "grok-4.3", "grok-build-0.1"]
  },
  {
    displaySlug: "gemini-flash-lite-latest",
    openRouterSlug: "google/gemini-3.5-flash-lite",
    nativeSlug: "gemini-flash-lite-latest",
    provider: "gemini",
    label: "gemini-flash-lite-latest (3.5) — low-cost Gemini",
    tier: "$",
    aliases: [
      "gemini-3.5-flash-lite",
      "gemini-3.1-flash-lite",
      "gemini-2.5-flash-lite",
      "google/gemini-3.5-flash-lite",
      "google/gemini-flash-lite-latest"
    ],
    lineage: "google-flash-lite",
    predecessors: ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-2.5-flash-lite"]
  },
  {
    displaySlug: "gemini-flash-latest",
    openRouterSlug: "~google/gemini-flash-latest",
    nativeSlug: "gemini-flash-latest",
    provider: "gemini",
    label: "gemini-flash-latest (3.8) — current flagship Flash",
    tier: "$$",
    recommendedGreen: true,
    aliases: [
      "gemini-3.8-flash",
      "google/gemini-3.8-flash",
      "gemini-3.7-flash",
      "gemini-3.6-flash",
      "gemini-3.5-flash",
      "gemini-2.5-flash",
      "gemini-flash",
      "google/gemini-flash-latest",
      "google/gemini-3.7-flash",
      "google/gemini-3.6-flash"
    ],
    lineage: "google-flash",
    predecessors: ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash", "gemini-2.5-flash"]
  },
  {
    displaySlug: "gemini-pro-latest",
    openRouterSlug: "~google/gemini-pro-latest",
    nativeSlug: "gemini-pro-latest",
    provider: "gemini",
    // OpenRouter's ~google/gemini-pro-latest alias now targets google/gemini-4-argon
    // (verified against the public model list 2026-11-04).
    label: "gemini-pro-latest (4 Argon) — deepest Gemini reasoning",
    tier: "$$$",
    recommendedRed: true,
    aliases: [
      "gemini-4-argon",
      "google/gemini-4-argon",
      "gemini-3.1-pro-preview",
      "gemini-2.5-pro",
      "gemini-pro",
      "google/gemini-pro-latest",
      "google/gemini-3.1-pro-preview"
    ],
    lineage: "google-pro",
    predecessors: ["gemini-3.1-pro-preview", "gemini-2.5-pro", "gemini-pro"]
  },
  {
    displaySlug: "mistral-small-latest",
    openRouterSlug: "mistralai/mistral-small-2603",
    nativeSlug: "mistral-small-latest",
    provider: "mistral",
    label: "mistral-small-latest — low-cost Mistral Small",
    tier: "$",
    aliases: [
      "mistral-small-2603",
      "mistral-small-2506",
      "mistralai/mistral-small-2603",
      "mistralai/mistral-small-latest"
    ],
    lineage: "mistral-small",
    predecessors: ["mistral-small-2603", "mistral-small-2506"]
  },
  {
    displaySlug: "mistral-medium-latest",
    openRouterSlug: "mistralai/mistral-medium-3-5",
    nativeSlug: "mistral-medium-latest",
    provider: "mistral",
    // "Frontier" was Mistral's marketing language, not a price/capability rank: this is the
    // COSTLIEST Mistral row (1.50/7.50 vs Large's 0.70/2.10) — see the tier fix below and
    // docs/rollouts/2026-09-18-model-catalog-cleanup.md.
    // Mistral Medium 3.5 is deprecated upstream with no successor and retires 2027-04-30.  The row
    // stays until then; drop it (and its aliases) before that date.
    label: "mistral-medium-latest — priciest Mistral tier",
    tier: "$$$",
    aliases: [
      "mistral-medium-3.5",
      "mistral-medium-3-5",
      "mistralai/mistral-medium-3.5",
      "mistralai/mistral-medium-3-5",
      "mistralai/mistral-medium-latest"
    ],
    lineage: "mistral-medium",
    predecessors: ["mistral-medium-3.5", "mistral-medium-3-5"]
  },
  {
    displaySlug: "mistral-large-latest",
    // 2026-11-04: Mistral Large 3 (mistralai/mistral-large-2512) was deprecated upstream on
    // 2026-10-31.  Mistral Large 4 is listed on the public OpenRouter model list as
    // mistralai/mistral-large-4-0 ($0.70/$2.10), and Mistral's reasoning guide
    // (docs.mistral.ai/capabilities/reasoning) names the native id mistral-large-4-0.  Large 4
    // reasons by default, so llm-reasoning.ts gives it a "high"-only effort capability (the
    // only value both OpenRouter and Mistral document) and the strategy timeout widens for it.
    openRouterSlug: "mistralai/mistral-large-4-0",
    nativeSlug: "mistral-large-4-0",
    provider: "mistral",
    label: "mistral-large-latest (4) — Mistral Large",
    // Middle of the three Mistral rows (0.70/2.10): above Small, below Medium.
    tier: "$$",
    aliases: [
      "mistral-large-4",
      "mistral-large-4-0",
      "mistralai/mistral-large-4-0",
      "mistral-large",
      "mistral-large-2512",
      "mistralai/mistral-large-2512",
      "mistralai/mistral-large",
      "mistralai/mistral-large-latest"
    ],
    lineage: "mistral-large",
    predecessors: ["mistral-large-2512", "mistral-large-2407"]
  },
  {
    displaySlug: "kimi-latest",
    // ~moonshotai/kimi-latest still targets Kimi K3 on OpenRouter (2026-11-04), so the row pins
    // the newer K3.1 Pro id directly.
    openRouterSlug: "moonshotai/kimi-k3.1-pro",
    nativeSlug: "kimi-k3.1-pro",
    provider: "moonshot",
    label: "kimi-latest (k3.1 Pro) — Kimi frontier model",
    tier: "$$",
    aliases: ["kimi-k3.1-pro", "moonshotai/kimi-k3.1-pro", "kimi-k3", "kimi", "moonshot", "moonshot-latest", "moonshotai/kimi-latest", "~moonshotai/kimi-latest"],
    lineage: "moonshot-kimi",
    predecessors: ["kimi-k3", "moonshot-latest"]
  },
  {
    displaySlug: "deepseek-flash-latest",
    // 2026-11-04: the dated V4 0731 snapshot is retired upstream.  OpenRouter's family alias
    // ~deepseek/deepseek-flash-latest targets deepseek/deepseek-v4.1-flash-1017 today; nothing in
    // docs/rollouts/2026-07-20-openrouter-latest-alias.md required DeepSeek to stay on dated ids.
    openRouterSlug: "~deepseek/deepseek-flash-latest",
    nativeSlug: "deepseek-flash",
    provider: "deepseek",
    label: "deepseek-flash-latest (v4.1) — fast DeepSeek Flash",
    tier: "$",
    aliases: [
      "deepseek-flash",
      "deepseek-v4.1-flash-1017",
      "deepseek/deepseek-v4.1-flash-1017",
      "deepseek-v4.1-flash",
      "deepseek/deepseek-v4.1-flash",
      "deepseek-v4-flash-0731",
      "deepseek/deepseek-v4-flash-0731",
      "deepseek-v4-flash",
      "deepseek-chat",
      "deepseek/deepseek-v4-flash",
      "deepseek/deepseek-flash-latest"
    ],
    lineage: "deepseek-flash",
    predecessors: ["deepseek-v4-flash-0731", "deepseek-chat"]
  },
  {
    displaySlug: "deepseek-pro-latest",
    openRouterSlug: "deepseek/deepseek-v4-pro-0813",
    nativeSlug: "deepseek-v4-pro",
    provider: "deepseek",
    label: "deepseek-pro-latest (v4) — stronger DeepSeek Pro",
    tier: "$$",
    aliases: ["deepseek-v4-pro-0813", "deepseek/deepseek-v4-pro-0813", "deepseek-v4-pro", "deepseek/deepseek-v4-pro", "deepseek/deepseek-pro-latest"],
    lineage: "deepseek-pro",
    predecessors: ["deepseek-v4-pro-0813", "deepseek-r1"]
  },
  // MiniMax: M3.1 Flash is the only offered row (owner 2026-11-05); minimax-m3 is retired below.
  {
    displaySlug: "minimax-m3.1-flash",
    openRouterSlug: "minimax/minimax-m3.1-flash",
    nativeSlug: "MiniMax-M3.1-Flash",
    provider: "minimax",
    label: "minimax-m3.1-flash — fast low-cost MiniMax reasoning",
    tier: "$",
    aliases: ["minimax/minimax-m3.1-flash"],
    lineage: "minimax-flash",
    predecessors: []
  },
  // Meta Muse: exactly the three contributor models are offered (owner 2026-11-05).  Spark 1.3,
  // Wonder 1.0 and Glimmer 30B are retired below.  A contributor row takes no predecessor from its
  // retired base model: same class, but not an older generation.
  {
    // Contributor tier: Meta discounts the price in exchange for permission to train on prompts
    // and completions.  Do not use it for anything the user would not want Meta to keep.
    displaySlug: "muse-spark-1.3-contributor",
    openRouterSlug: "meta/muse-spark-1.3-contributor",
    nativeSlug: "muse-spark-1.3-contributor",
    provider: "meta",
    label: "muse-spark-1.3-contributor — cheapest Muse tier, Meta trains on your prompts",
    tier: "$",
    aliases: ["meta/muse-spark-1.3-contributor"],
    lineage: "meta-spark",
    predecessors: []
  },
  // Muse Code contributor ids (owner 2026-11-04).  They exist only behind the Code CLI broker
  // route: neither OpenRouter nor Meta's Model API (api.meta.ai) serves them, so the OpenRouter
  // column is empty and resolveLlmEndpoint refuses them on any other route.  Price unknown: Code
  // CLI usage is recorded with keyRef "code-cli" and an unknown (not zero) cost.
  {
    displaySlug: "muse-wonder-1.0-contributor",
    openRouterSlug: "",
    nativeSlug: "muse-wonder-1.0-contributor",
    codeCliOnly: true,
    provider: "meta",
    label: "muse-wonder-1.0-contributor — Muse Wonder contributor tier, Meta trains on your prompts (Code CLI only)",
    tier: "$",
    aliases: [],
    lineage: "meta-wonder",
    predecessors: []
  },
  {
    displaySlug: "muse-wonder-full-1.0-contributor",
    openRouterSlug: "",
    nativeSlug: "muse-wonder-full-1.0-contributor",
    codeCliOnly: true,
    provider: "meta",
    label: "muse-wonder-full-1.0-contributor — full Muse Wonder contributor tier, Meta trains on your prompts (Code CLI only)",
    tier: "$",
    aliases: [],
    lineage: "meta-wonder-full",
    predecessors: []
  }
];

/**
 * Rows that LEFT the picker but must keep resolving for a policy that already stores them
 * (owner 2026-11-04).  They keep their own OpenRouter / native slugs, price and model class, so a
 * stored selection is served exactly as before and its stats stay its own (they feed the newer
 * same-class row only as a labelled predecessor estimate).  They are NOT in LLM_MODEL_CATALOG, so
 * they never appear in picker groups, the rotation pool, stats seeding or the recommendation
 * chips.  Stored selections are not migrated automatically.
 */
export const RETIRED_LLM_MODEL_CATALOG: readonly LlmCatalogEntry[] = [
  {
    displaySlug: "gpt-6-astra-pro",
    openRouterSlug: "openai/gpt-6-astra-pro",
    nativeSlug: "gpt-6-astra-pro",
    // OpenAI's native API has no gpt-6-astra-pro model id ("pro" is a request parameter there),
    // so this stays OpenRouter-only exactly as it was while it was offered.
    openRouterOnly: true,
    provider: "openai",
    label: "gpt-6-astra-pro — retired: the same model as gpt-6-astra in pro reasoning mode",
    tier: "$$$",
    aliases: ["openai/gpt-6-astra-pro"],
    lineage: "openai-astra",
    predecessors: ["gpt-6-astra"],
    retired: true
  },
  {
    displaySlug: "gpt-5.6-sol",
    openRouterSlug: "openai/gpt-5.6-sol",
    nativeSlug: "gpt-5.6-sol",
    provider: "openai",
    label: "gpt-5.6-sol — retired: replaced by gpt-6.1-sol",
    tier: "$$$",
    aliases: ["openai/gpt-5.6-sol", "gpt-5.6"],
    lineage: "openai-sol",
    predecessors: ["gpt-5.5", "gpt-5.6"],
    retired: true
  },
  {
    displaySlug: "gpt-5.6-luna",
    openRouterSlug: "openai/gpt-5.6-luna",
    nativeSlug: "gpt-5.6-luna",
    provider: "openai",
    label: "gpt-5.6-luna — retired: replaced by gpt-6-luna",
    tier: "$$",
    aliases: ["openai/gpt-5.6-luna"],
    lineage: "openai-luna",
    predecessors: ["gpt-5.4", "gpt-4o-mini"],
    retired: true
  },
  // Owner 2026-11-05: "no I don't want minimax-m3 and for muse I said only the 3 contributor
  // models".  Same slugs, price, class and effort handling as when they were offered.
  {
    displaySlug: "minimax-m3",
    openRouterSlug: "minimax/minimax-m3",
    nativeSlug: "MiniMax-M3",
    provider: "minimax",
    label: "minimax-m3 — retired: use minimax-m3.1-flash",
    tier: "$",
    aliases: ["minimax/minimax-m3"],
    lineage: "minimax",
    predecessors: ["minimax-m2.7"],
    retired: true
  },
  {
    displaySlug: "muse-wonder-1.0",
    openRouterSlug: "meta/muse-wonder",
    nativeSlug: "muse-wonder-1.0",
    provider: "meta",
    label: "muse-wonder-1.0 — retired: only the Muse contributor models are offered",
    tier: "$$$",
    aliases: ["meta/muse-wonder", "meta/muse-wonder-1.0"],
    lineage: "meta-wonder",
    predecessors: [],
    retired: true
  },
  {
    displaySlug: "muse-spark-1.3",
    openRouterSlug: "meta/muse-spark-1.3",
    nativeSlug: "muse-spark-1.3",
    provider: "meta",
    label: "muse-spark-1.3 — retired: only the Muse contributor models are offered",
    tier: "$$",
    aliases: ["meta/muse-spark-1.3"],
    lineage: "meta-spark",
    predecessors: [],
    retired: true
  },
  {
    displaySlug: "muse-glimmer-30b",
    openRouterSlug: "meta/muse-glimmer-30b",
    nativeSlug: "muse-glimmer-30b",
    provider: "meta",
    label: "muse-glimmer-30b — retired: only the Muse contributor models are offered",
    tier: "$",
    aliases: ["meta/muse-glimmer-30b"],
    lineage: "meta-glimmer",
    predecessors: [],
    retired: true
  }
];

export const CATALOG_DISPLAY_SLUGS: readonly string[] = LLM_MODEL_CATALOG.map((row) => row.displaySlug);

const LOOKUP = new Map<string, LlmCatalogEntry>();

function indexKey(raw: string): string {
  return raw.trim().replace(/^~/, "").replace(/^openrouter\//i, "").replace(/:batch$/i, "").toLowerCase();
}

function indexEntry(entry: LlmCatalogEntry, overwrite: boolean): void {
  for (const raw of [entry.displaySlug, entry.openRouterSlug, entry.nativeSlug, ...entry.aliases]) {
    const key = indexKey(raw);
    if (!key) continue; // Code CLI-only rows have no OpenRouter slug.
    if (overwrite || !LOOKUP.has(key)) LOOKUP.set(key, entry);
  }
}

for (const entry of LLM_MODEL_CATALOG) indexEntry(entry, true);
// Offered rows win every key; a retired row only answers for ids no offered row claims.
for (const entry of RETIRED_LLM_MODEL_CATALOG) indexEntry(entry, false);

/** True when the id resolves to a retired row (kept for stored selections, not offered). */
export function isRetiredCatalogModel(model: string | null | undefined): boolean {
  return catalogEntryFor(model)?.retired === true;
}

/** True when the id is a catalog model served only through the Code CLI broker route. */
export function isCodeCliOnlyModel(model: string | null | undefined): boolean {
  return catalogEntryFor(model)?.codeCliOnly === true;
}

export function catalogEntryFor(model: string | null | undefined): LlmCatalogEntry | undefined {
  if (!model) return undefined;
  const trimmed = model.trim();
  if (!trimmed) return undefined;
  const direct = LOOKUP.get(indexKey(trimmed));
  if (direct) return direct;
  const leaf = trimmed.includes("/") ? trimmed.split("/").pop() || trimmed : trimmed;
  return LOOKUP.get(indexKey(leaf));
}

/** Persist / UI / stats identity.  Empty string for null/blank. */
export function displaySlugFor(model: string | null | undefined): string {
  if (!model) return "";
  const trimmed = model.trim();
  if (!trimmed) return "";
  return catalogEntryFor(trimmed)?.displaySlug ?? "";
}

/** OpenRouter chat/completions `model`.  Unknown ids keep a vendor-prefixed fallback. */
export function openRouterSlugFor(model: string | null | undefined): string {
  const trimmed = (model ?? "").trim();
  if (!trimmed) return "";
  const batch = /:batch$/i.test(trimmed);
  const entry = catalogEntryFor(trimmed);
  if (entry) {
    // The Flash-latest alias has no :batch sibling. Pin offline/eval to 3.8 batch.
    if (batch && entry.displaySlug === "gemini-flash-latest") {
      return "google/gemini-3.8-flash:batch";
    }
    if (!entry.openRouterSlug) return ""; // Code CLI-only: no OpenRouter id exists.
    return batch && !entry.openRouterSlug.endsWith(":batch") ? `${entry.openRouterSlug}:batch` : entry.openRouterSlug;
  }
  return "";
}

/**
 * Direct-provider slug.  Never returns an OpenRouter vendor path
 * (`anthropic/…`, `openai/…`) so a future native client cannot send column 2 by accident.
 */
export function nativeSlugFor(model: string | null | undefined): string {
  const trimmed = (model ?? "").trim();
  if (!trimmed) return "";
  const entry = catalogEntryFor(trimmed);
  if (entry) return entry.nativeSlug;
  const bare = trimmed.replace(/^~/, "").replace(/^openrouter\//i, "").replace(/:batch$/i, "");
  return bare.includes("/") ? bare.split("/").pop() || bare : bare;
}

// Keep expensive models available for explicit owner selection, but out of automatic rotation
// so a daily run batch stays within the owner's $4/day OpenRouter key cap.
// (gpt-6-astra-pro and muse-wonder-1.0 are retired rows now, so neither needs listing here.)
export const ROTATION_EXCLUDED_DISPLAY_SLUGS: readonly string[] = [
  "claude-opus-latest",
  "claude-fable-latest"
];

/**
 * Rows that rotate ONLY when the owner ticks them in the Rotation Models checklist: the cost
 * exclusions above plus every Code CLI-only row (those additionally need a ready Code CLI route,
 * which eligibleRotationPool checks).  Keeping both out of the default pool means "nothing ticked"
 * and "Select All" name the same pool.
 */
export function isRotationOptInOnly(displaySlug: string): boolean {
  return ROTATION_EXCLUDED_DISPLAY_SLUGS.includes(displaySlug) || isCodeCliOnlyModel(displaySlug);
}

export const CATALOG_ROTATION_POOL: readonly string[] = CATALOG_DISPLAY_SLUGS.filter(
  (id) => !isRotationOptInOnly(id)
);

/**
 * Return all configured predecessor model slugs for a model (or empty array if none).
 * Enables rolling forward historical cost, latency, token, and performance stats into
 * newly adopted or bumped model versions before they establish their own sample size.
 */
export function getPredecessorModelIds(model: string | null | undefined): string[] {
  if (!model) return [];
  const entry = catalogEntryFor(model);
  return entry?.predecessors ? [...entry.predecessors] : [];
}

/** Model class (catalog `lineage`) for a model id, or undefined when the id is not a catalog row. */
export function modelClassFor(model: string | null | undefined): string | undefined {
  return catalogEntryFor(model)?.lineage;
}

/** Short human label for a model class: drop the provider prefix and Title Case the rest
 *  ("openai-astra" -> "Astra", "google-flash-lite" -> "Flash Lite"). Falls back to the raw string. */
export function modelClassLabel(modelClass: string | null | undefined): string {
  const raw = (modelClass ?? "").trim();
  if (!raw) return "";
  const parts = raw.split("-").filter(Boolean);
  const rest = parts.length > 1 ? parts.slice(1) : parts;
  if (rest.length === 0) return raw;
  return rest.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" ");
}
