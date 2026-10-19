/**
 * Tests for the shared LLM request builder/extractor (llm-call.ts) — the layer that lets Claude be a
 * first-class Green/Red Team model alongside the OpenAI-compatible providers. All offline; no network.
 */

import { describe, expect, it, vi } from "vitest";
import { buildLlmRequestBody, llmAuthHeaders, extractLlmText, shouldRequireOpenRouterParameters, toGeminiJsonSchema } from "../src/lib/llm-call";

const SCHEMA = {
  name: "trade_proposals",
  description: "proposals",
  schema: { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } }
};

/**
 * Replicates the shape of the real Bull trade-proposal schema built inline in
 * `runStrategyOnce` (src/lib/strategy.ts, ~lines 4040-4108) — same six `type:["number","null"]`
 * fields (quantity/dollarAmount/limitPrice/stopPrice/bracketStopLoss/bracketTakeProfit) plus the
 * `autonomyOverride` anyOf-with-{type:"null"} wrapper — so the Gemini transform is exercised against
 * the actual construct that made every Roth IRA Bull call fail 400 INVALID_ARGUMENT (the bug this
 * fix addresses), not a synthetic stand-in.
 */
const AUTONOMY_OVERRIDE_SCHEMA = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["requested", "thesis", "preferenceConflicts", "invalidation", "cashDeploymentPct"],
      properties: {
        requested: { type: "boolean" },
        thesis: { type: "string" },
        preferenceConflicts: { type: "array", items: { type: "string" } },
        invalidation: { type: ["string", "null"] },
        cashDeploymentPct: { type: ["number", "null"] }
      }
    },
    { type: "null" }
  ]
};

const BULL_PROPOSAL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["proposals"],
  properties: {
    proposals: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "symbol",
          "side",
          "type",
          "quantity",
          "dollarAmount",
          "limitPrice",
          "stopPrice",
          "timeInForce",
          "marketHours",
          "rationale",
          "tradeThesisTag",
          "confidenceScore",
          "autonomyOverride",
          "bracketStopLoss",
          "bracketTakeProfit"
        ],
        properties: {
          symbol: { type: "string" },
          side: { enum: ["buy", "sell"] },
          type: { enum: ["market", "limit", "stop_market", "stop_limit"] },
          quantity: { type: ["number", "null"] },
          dollarAmount: { type: ["number", "null"] },
          limitPrice: { type: ["number", "null"] },
          stopPrice: { type: ["number", "null"] },
          timeInForce: { enum: ["gfd", "gtc"] },
          marketHours: { enum: ["regular_hours", "extended_hours", "all_day_hours"] },
          rationale: { type: "string" },
          tradeThesisTag: { enum: ["momentum", "mean_reversion"] },
          confidenceScore: { type: "number", minimum: 1, maximum: 100 },
          autonomyOverride: AUTONOMY_OVERRIDE_SCHEMA,
          bracketStopLoss: { type: ["number", "null"] },
          bracketTakeProfit: { type: ["number", "null"] }
        }
      }
    }
  }
};

describe("buildLlmRequestBody", () => {
  it("MiniMax native chat uses documented bounds without unsupported response_format", () => {
    const body = buildLlmRequestBody(
      { provider: "minimax", transport: "chat-completions" },
      { model: "MiniMax-M2.7", systemPrompt: "Return JSON.", userContent: "{}", maxOutputTokens: 1500, schema: SCHEMA }
    );
    expect(body.max_completion_tokens).toBe(9_500);
    expect(body.temperature).toBe(1);
    expect(body.reasoning_split).toBe(true);
    expect(body.response_format).toBeUndefined();
    expect((body.messages as Array<{ content: string }>)[0].content).toContain(JSON.stringify(SCHEMA.schema));
  });

  it("OpenAI chat-completions: strict json_schema + max_completion_tokens (reasoning model)", () => {
    const body = buildLlmRequestBody(
      { provider: "openai", transport: "chat-completions" },
      { model: "gpt-5.4-mini", systemPrompt: "sys", userContent: "{}", schema: SCHEMA, maxOutputTokens: 1500 }
    ) as Record<string, any>;
    expect(body.model).toBe("gpt-5.4-mini");
    expect(body.messages[0]).toEqual({ role: "system", content: "sys" });
    expect(body.response_format).toEqual({ type: "json_schema", json_schema: { name: "trade_proposals", strict: true, schema: SCHEMA.schema } });
    expect(body.max_completion_tokens).toBeGreaterThanOrEqual(1500);
    // No top-level Anthropic-only fields leak in.
    expect(body.system).toBeUndefined();
    expect(body.max_tokens).toBeUndefined();
  });

  it("DeepSeek chat-completions: downgrades a schema to bare json_object", () => {
    const body = buildLlmRequestBody(
      { provider: "deepseek", transport: "chat-completions" },
      { model: "deepseek-v4-flash", systemPrompt: "sys", userContent: "{}", schema: SCHEMA, maxOutputTokens: 1500 }
    ) as Record<string, any>;
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("OpenAI responses: STRICT json_schema under text.format", () => {
    const body = buildLlmRequestBody(
      { provider: "openai", transport: "responses" },
      { model: "gpt-5.4-mini", systemPrompt: "sys", userContent: "{}", schema: SCHEMA, maxOutputTokens: 1500 }
    ) as Record<string, any>;
    expect(body.input[0]).toEqual({ role: "system", content: "sys" });
    // strict:true — without it the Responses API treats the schema as advisory (Codex review, PR #301).
    expect(body.text).toEqual({ format: { type: "json_schema", name: "trade_proposals", strict: true, schema: SCHEMA.schema } });
  });

  it("GPT-5.6 preserves the exact tier and reasoning effort on the OpenAI Responses transport", () => {
    const body = buildLlmRequestBody(
      { provider: "openai", transport: "responses" },
      {
        model: "gpt-5.6-terra",
        systemPrompt: "sys",
        userContent: "{}",
        schema: SCHEMA,
        maxOutputTokens: 1500,
        reasoningEffort: "high"
      }
    ) as Record<string, any>;

    expect(body.model).toBe("gpt-5.6-terra");
    expect(body.reasoning).toEqual({ effort: "high" });
    expect(body.max_output_tokens).toBeGreaterThanOrEqual(1500);
    expect(body.text).toEqual({ format: { type: "json_schema", name: "trade_proposals", strict: true, schema: SCHEMA.schema } });
    expect(body.messages).toBeUndefined();
    expect(body.max_completion_tokens).toBeUndefined();
  });

  it("Anthropic: system field + forced tool-use for the schema, max_tokens set, no response_format", () => {
    const body = buildLlmRequestBody(
      { provider: "anthropic", transport: "anthropic-messages" },
      { model: "anthropic/claude-opus-4-8", systemPrompt: "sys", userContent: "{\"a\":1}", schema: SCHEMA, maxOutputTokens: 1500 }
    ) as Record<string, any>;
    expect(body.model).toBe("anthropic/claude-opus-4-8");
    // Prompt caching (Chat A item 3): system is a single ephemeral cache block, not a bare string.
    expect(body.system).toEqual([{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }]);
    expect(body.messages).toEqual([{ role: "user", content: "{\"a\":1}" }]);
    expect(body.tools).toEqual([{ name: "trade_proposals", description: "proposals", input_schema: SCHEMA.schema }]);
    expect(body.tool_choice).toEqual({ type: "tool", name: "trade_proposals" });
    expect(body.max_tokens).toBeGreaterThanOrEqual(1500);
    // OpenAI-only fields must never appear on an Anthropic body.
    expect(body.response_format).toBeUndefined();
    expect(body.max_completion_tokens).toBeUndefined();
    expect(body.max_output_tokens).toBeUndefined();
  });

  it("Anthropic adaptive-thinking models get adaptive thinking config, not temperature", () => {
    const body = buildLlmRequestBody(
      { provider: "anthropic", transport: "anthropic-messages" },
      {
        model: "anthropic/claude-opus-4-8",
        systemPrompt: "sys",
        userContent: "{}",
        schema: SCHEMA,
        maxOutputTokens: 1500,
        reasoningEffort: "xhigh"
      }
    ) as Record<string, any>;
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect(body.output_config).toEqual({ effort: "xhigh" });
    expect(body.temperature).toBeUndefined();
  });

  it("OpenAI-compatible providers get their own reasoning_effort values", () => {
    const gemini = buildLlmRequestBody(
      { provider: "gemini", transport: "chat-completions" },
      { model: "gemini-2.5-flash", systemPrompt: "sys", userContent: "{}", schema: SCHEMA, maxOutputTokens: 1500, reasoningEffort: "none" }
    ) as Record<string, any>;
    expect(gemini.reasoning_effort).toBe("none");
    expect(gemini.reasoning).toBeUndefined();

    const xai = buildLlmRequestBody(
      { provider: "xai", transport: "chat-completions" },
      { model: "xai/grok-4.3", systemPrompt: "sys", userContent: "{}", schema: SCHEMA, maxOutputTokens: 1500, reasoningEffort: "high" }
    ) as Record<string, any>;
    expect(xai.reasoning_effort).toBe("high");

    // Only mistral-medium-3-5 carries a Mistral reasoning capability (provider enforces
    // reasoning_effort high|none); an explicit xhigh request normalizes to "high", sent WITHOUT
    // prompt_mode (2026-07-10 keyed probe: medium-3-5 rejects prompt_mode:"reasoning" too).
    const mistral = buildLlmRequestBody(
      { provider: "mistral", transport: "chat-completions" },
      { model: "mistral-medium-3-5", systemPrompt: "sys", userContent: "{}", schema: SCHEMA, maxOutputTokens: 1500, reasoningEffort: "xhigh" }
    ) as Record<string, any>;
    expect(mistral.reasoning_effort).toBe("high");
    expect(mistral.prompt_mode).toBeUndefined();

    // The rest of the Mistral family (small-2603 rejects the reasoning prompt mode outright;
    // benchmark 2026-07-08) sends a plain body with no reasoning params at all.
    const mistralPlain = buildLlmRequestBody(
      { provider: "mistral", transport: "chat-completions" },
      { model: "mistral-small-latest", systemPrompt: "sys", userContent: "{}", schema: SCHEMA, maxOutputTokens: 1500, reasoningEffort: "xhigh" }
    ) as Record<string, any>;
    expect(mistralPlain.reasoning_effort).toBeUndefined();
    expect(mistralPlain.prompt_mode).toBeUndefined();
  });

  it("Anthropic auth headers include the prompt-caching beta; OpenAI-compatible unchanged (item 3)", () => {
    const anthropic = llmAuthHeaders({ provider: "anthropic", key: "sk-ant" });
    expect(anthropic["anthropic-beta"]).toBe("prompt-caching-2024-07-31");
    expect(anthropic["x-api-key"]).toBe("sk-ant");
    expect(anthropic["anthropic-version"]).toBe("2023-06-01");
    // OpenAI-compatible transport is untouched: Bearer auth, no anthropic beta header.
    const openai = llmAuthHeaders({ provider: "openai", key: "sk" });
    expect(openai["anthropic-beta"]).toBeUndefined();
    expect(openai.authorization).toBe("Bearer sk");
  });

  it("openAiJsonObject keeps OpenAI on json_object but Anthropic still uses the forced tool", () => {
    const oa = buildLlmRequestBody(
      { provider: "openai", transport: "chat-completions" },
      { model: "openai/gpt-4o-mini", systemPrompt: "s", userContent: "{}", schema: SCHEMA, openAiJsonObject: true, maxOutputTokens: 1500 }
    ) as Record<string, any>;
    expect(oa.response_format).toEqual({ type: "json_object" });

    const an = buildLlmRequestBody(
      { provider: "anthropic", transport: "anthropic-messages" },
      { model: "claude-haiku-4-5", systemPrompt: "s", userContent: "{}", schema: SCHEMA, openAiJsonObject: true, maxOutputTokens: 1500 }
    ) as Record<string, any>;
    expect(an.tool_choice).toEqual({ type: "tool", name: "trade_proposals" });
  });

  it("includes the MiniMax schema in the prompt even when OpenRouter handles structured output", () => {
    const body = buildLlmRequestBody(
      { provider: "openrouter", transport: "chat-completions" },
      { model: "minimax/minimax-m3", systemPrompt: "sys", userContent: "{}", schema: SCHEMA, maxOutputTokens: 1500 }
    ) as Record<string, any>;
    expect(body.messages[0].content).toContain(JSON.stringify(SCHEMA.schema));
    expect(body.response_format?.type).toBe("json_schema");
    expect(body.reasoning_split).toBeUndefined();
  });

  it("no schema → free-text output (no response_format / tools)", () => {
    const oa = buildLlmRequestBody(
      { provider: "openai", transport: "chat-completions" },
      { model: "openai/gpt-4o-mini", systemPrompt: "s", userContent: "hi", maxOutputTokens: 500 }
    ) as Record<string, any>;
    expect(oa.response_format).toBeUndefined();

    const an = buildLlmRequestBody(
      { provider: "anthropic", transport: "anthropic-messages" },
      { model: "claude-haiku-4-5", systemPrompt: "s", userContent: "hi", maxOutputTokens: 500 }
    ) as Record<string, any>;
    expect(an.tools).toBeUndefined();
    expect(an.tool_choice).toBeUndefined();
  });

  // Regression coverage for the Roth IRA Bull blackout: every Green Team call on gemini-3.5-flash
  // failed 400 INVALID_ARGUMENT because this schema's `type:["number","null"]` fields and
  // anyOf-with-null wrapper are constructs Gemini's OpenAI-compat endpoint rejects, while the
  // identical Bear/Red-Team schema (no nullable fields) always succeeded on the same account/model.
  it("Gemini gets the trade-proposal schema translated to nullable dialect; OpenAI/DeepSeek untouched", () => {
    const gemini = buildLlmRequestBody(
      { provider: "gemini", transport: "chat-completions" },
      { model: "gemini-3.5-flash", systemPrompt: "sys", userContent: "{}", schema: { name: "trade_proposals", schema: BULL_PROPOSAL_SCHEMA }, maxOutputTokens: 1500 }
    ) as Record<string, any>;
    const geminiSchema = gemini.response_format.json_schema.schema;
    expect(gemini.response_format.type).toBe("json_schema");
    expect(gemini.response_format.json_schema.strict).toBe(true);
    // No leftover type-union arrays or anyOf-with-null anywhere in the translated schema.
    expect(JSON.stringify(geminiSchema)).not.toMatch(/"type":\["/);
    expect(JSON.stringify(geminiSchema)).not.toContain('"anyOf"');
    const itemProps = geminiSchema.properties.proposals.items.properties;
    for (const field of ["quantity", "dollarAmount", "limitPrice", "stopPrice", "bracketStopLoss", "bracketTakeProfit"]) {
      expect(itemProps[field]).toEqual({ type: "number", nullable: true });
    }
    // autonomyOverride's anyOf-with-{type:"null"} branch collapses to the object branch + nullable:true.
    expect(itemProps.autonomyOverride.type).toBe("object");
    expect(itemProps.autonomyOverride.nullable).toBe(true);
    expect(itemProps.autonomyOverride.properties.invalidation).toEqual({ type: "string", nullable: true });
    expect(itemProps.autonomyOverride.properties.cashDeploymentPct).toEqual({ type: "number", nullable: true });
    // A field with no nullable union (enum) survives untouched.
    expect(itemProps.side).toEqual({ enum: ["buy", "sell"] });

    // OpenAI stays byte-identical strict json_schema — the exact same schema object, untransformed.
    const openai = buildLlmRequestBody(
      { provider: "openai", transport: "chat-completions" },
      { model: "gpt-5.4-mini", systemPrompt: "sys", userContent: "{}", schema: { name: "trade_proposals", schema: BULL_PROPOSAL_SCHEMA }, maxOutputTokens: 1500 }
    ) as Record<string, any>;
    expect(openai.response_format).toEqual({ type: "json_schema", json_schema: { name: "trade_proposals", strict: true, schema: BULL_PROPOSAL_SCHEMA } });

    // DeepSeek keeps its existing json_object downgrade — unaffected by the new Gemini branch.
    const deepseek = buildLlmRequestBody(
      { provider: "deepseek", transport: "chat-completions" },
      { model: "deepseek-v4-pro", systemPrompt: "sys", userContent: "{}", schema: { name: "trade_proposals", schema: BULL_PROPOSAL_SCHEMA }, maxOutputTokens: 1500 }
    ) as Record<string, any>;
    expect(deepseek.response_format).toEqual({ type: "json_object" });
  });

  it("Gemini schema translation is a pure function of provider — xAI/Mistral (also OpenAI-compatible) stay strict-unchanged", () => {
    const xai = buildLlmRequestBody(
      { provider: "xai", transport: "chat-completions" },
      { model: "xai/grok-4.3", systemPrompt: "sys", userContent: "{}", schema: { name: "trade_proposals", schema: BULL_PROPOSAL_SCHEMA }, maxOutputTokens: 1500 }
    ) as Record<string, any>;
    expect(xai.response_format).toEqual({ type: "json_schema", json_schema: { name: "trade_proposals", strict: true, schema: BULL_PROPOSAL_SCHEMA } });
  });
});

describe("toGeminiJsonSchema", () => {
  it("rewrites a type:[T,\"null\"] union to a single type + nullable:true", () => {
    const { schema, unsupported } = toGeminiJsonSchema({ type: ["number", "null"] });
    expect(schema).toEqual({ type: "number", nullable: true });
    expect(unsupported).toBe(false);
  });

  it("collapses an anyOf branch of {type:\"null\"} to the remaining branch + nullable:true", () => {
    const { schema, unsupported } = toGeminiJsonSchema(AUTONOMY_OVERRIDE_SCHEMA);
    expect(unsupported).toBe(false);
    expect((schema as any).type).toBe("object");
    expect((schema as any).nullable).toBe(true);
    expect((schema as any).anyOf).toBeUndefined();
    // Nested nullable fields inside the collapsed branch are translated too (recursion).
    expect((schema as any).properties.invalidation).toEqual({ type: "string", nullable: true });
    expect((schema as any).properties.cashDeploymentPct).toEqual({ type: "number", nullable: true });
    // Non-nullable siblings pass through unchanged.
    expect((schema as any).properties.requested).toEqual({ type: "boolean" });
    expect((schema as any).required).toEqual(["requested", "thesis", "preferenceConflicts", "invalidation", "cashDeploymentPct"]);
  });

  it("translates the full real Bull proposal schema shape with no leftover unions/anyOf", () => {
    const { schema, unsupported } = toGeminiJsonSchema(BULL_PROPOSAL_SCHEMA);
    expect(unsupported).toBe(false);
    expect(JSON.stringify(schema)).not.toMatch(/"type":\["/);
    expect(JSON.stringify(schema)).not.toContain('"anyOf"');
  });

  it("leaves a schema with no nullable constructs byte-identical (Bear/Red-Team verdict shape)", () => {
    const verdictSchema = {
      type: "object",
      additionalProperties: false,
      required: ["rejected", "reason"],
      properties: {
        rejected: { type: "boolean" },
        reason: { type: "string" }
      }
    };
    const { schema, unsupported } = toGeminiJsonSchema(verdictSchema);
    expect(schema).toEqual(verdictSchema);
    expect(unsupported).toBe(false);
  });

  it("flags unsupported when a type union has more than one non-null alternative", () => {
    const { unsupported } = toGeminiJsonSchema({ type: ["string", "number", "null"] });
    expect(unsupported).toBe(true);
  });

  it("flags unsupported when an anyOf has 2+ non-null branches (no single-type collapse possible)", () => {
    const { unsupported } = toGeminiJsonSchema({ anyOf: [{ type: "string" }, { type: "number" }] });
    expect(unsupported).toBe(true);
  });

  // ── maxItems/minItems stripping (2026-07-09 Roth Bull 400 root cause) ─────────────────────────
  // Gemini's structured-output validator expands an array's item subtree once per maxItems slot
  // against an internal complexity budget: the 15-property Bull item schema at maxItems=8
  // (maxProposalsPerRun=8) was rejected 400 INVALID_ARGUMENT in ~1s, while maxItems<=7 — or the same
  // schema minus two properties, or no maxItems at all (the Bear shape) — passed. The bound is
  // advisory-for-the-model only (sanitizeProposals truncates app-side), so the transform strips it
  // and folds the intent into the node's description.

  it("strips maxItems from an array node and folds the bound into the description", () => {
    const { schema, unsupported } = toGeminiJsonSchema({
      type: "array",
      maxItems: 8,
      items: { type: "string" }
    });
    expect(unsupported).toBe(false);
    expect((schema as any).maxItems).toBeUndefined();
    expect((schema as any).description).toBe("Return at most 8 items.");
    expect((schema as any).items).toEqual({ type: "string" });
  });

  it("appends the folded bound to an existing description instead of replacing it", () => {
    const { schema } = toGeminiJsonSchema({
      type: "array",
      maxItems: 3,
      minItems: 1,
      description: "The trade proposals.",
      items: { type: "string" }
    });
    expect((schema as any).maxItems).toBeUndefined();
    expect((schema as any).minItems).toBeUndefined();
    expect((schema as any).description).toBe("The trade proposals. Return between 1 and 3 items.");
  });

  it("strips a malformed (non-numeric) maxItems without folding prose", () => {
    const { schema } = toGeminiJsonSchema({ type: "array", maxItems: "8", items: { type: "string" } });
    expect((schema as any).maxItems).toBeUndefined();
    expect((schema as any).description).toBeUndefined();
  });

  it("removes every maxItems from the full real Bull proposal schema (the maxProposalsPerRun=8 400)", () => {
    const eightProposals = JSON.parse(JSON.stringify(BULL_PROPOSAL_SCHEMA));
    eightProposals.properties.proposals.maxItems = 8; // the Roth IRA policy value that triggered the 400
    const { schema, unsupported } = toGeminiJsonSchema(eightProposals);
    expect(unsupported).toBe(false);
    const wire = JSON.stringify(schema);
    expect(wire).not.toContain('"maxItems"');
    expect(wire).not.toContain('"minItems"');
    expect((schema as any).properties.proposals.description).toBe("Return at most 8 items.");
    // The nullable rewrites still happen alongside the strip.
    expect(wire).not.toMatch(/"type":\["/);
    expect(wire).not.toContain('"anyOf"');
  });

  it("buildLlmRequestBody(gemini) never puts maxItems on the wire but stays strict json_schema", () => {
    const eightProposals = JSON.parse(JSON.stringify(BULL_PROPOSAL_SCHEMA));
    eightProposals.properties.proposals.maxItems = 8;
    const body = buildLlmRequestBody(
      { provider: "gemini", transport: "chat-completions" },
      {
        model: "gemini-3.5-flash",
        systemPrompt: "sys",
        userContent: "{}",
        schema: { name: "trade_proposals", schema: eightProposals },
        maxOutputTokens: 1500
      }
    ) as Record<string, any>;
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(JSON.stringify(body.response_format.json_schema.schema)).not.toContain('"maxItems"');
    // Non-Gemini providers keep the bound untouched (the strip is a Gemini-dialect concern only).
    const openai = buildLlmRequestBody(
      { provider: "openai", transport: "chat-completions" },
      {
        model: "gpt-5.4-mini",
        systemPrompt: "sys",
        userContent: "{}",
        schema: { name: "trade_proposals", schema: eightProposals },
        maxOutputTokens: 1500
      }
    ) as Record<string, any>;
    expect(openai.response_format.json_schema.schema.properties.proposals.maxItems).toBe(8);
  });

  it("falls back to json_object and logs when the schema is unsupported for gemini", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const body = buildLlmRequestBody(
        { provider: "gemini", transport: "chat-completions" },
        {
          model: "gemini-3.5-flash",
          systemPrompt: "sys",
          userContent: "{}",
          schema: { name: "weird_union", schema: { type: ["string", "number", "null"] } },
          maxOutputTokens: 1500
        }
      ) as Record<string, any>;
      expect(body.response_format).toEqual({ type: "json_object" });
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain("weird_union");
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("llmAuthHeaders", () => {
  it("Anthropic uses x-api-key + anthropic-version, not Bearer", () => {
    const h = llmAuthHeaders({ provider: "anthropic", key: "sk-ant-123" });
    expect(h["x-api-key"]).toBe("sk-ant-123");
    expect(h["anthropic-version"]).toBe("2023-06-01");
    expect(h.authorization).toBeUndefined();
  });

  it("OpenAI-compatible providers use Bearer auth", () => {
    for (const provider of ["openai", "xai", "gemini", "mistral", "deepseek"] as const) {
      const h = llmAuthHeaders({ provider, key: "k" });
      expect(h.authorization).toBe("Bearer k");
      expect(h["x-api-key"]).toBeUndefined();
    }
  });
});

describe("OpenRouter provider routing", () => {
  it("requires advertised parameters so GPT-5.4 nano does not 400 on the OpenAI endpoint", () => {
    const body = buildLlmRequestBody(
      { provider: "openrouter", transport: "chat-completions" },
      {
        model: "openai/gpt-5.4-nano",
        systemPrompt: "sys",
        userContent: "{}",
        schema: SCHEMA,
        maxOutputTokens: 1500,
        reasoningEffort: "low"
      }
    ) as Record<string, any>;
    expect(body.provider).toEqual({ require_parameters: true, allow_fallbacks: true });
    expect(body.max_completion_tokens).toBeGreaterThan(0);
    expect(body.temperature).toBeUndefined();
  });

  it("does not require_parameters on today's Coolify Green 404 seats (valid public slugs)", () => {
    // Live 2026-08-18 sha cda485ff: gemini-3.7-flash 86ms 404, mistral-medium-3-5 82ms 404.
    // 7d also mistral-small-2603.  All three exist on /api/v1/models.
    const seats: Array<{ model: string; reasoningEffort: "low" | "none" }> = [
      { model: "google/gemini-3.7-flash", reasoningEffort: "low" },
      { model: "mistralai/mistral-medium-3-5", reasoningEffort: "none" },
      { model: "mistralai/mistral-small-2603", reasoningEffort: "none" }
    ];
    for (const seat of seats) {
      const body = buildLlmRequestBody(
        { provider: "openrouter", transport: "chat-completions" },
        {
          model: seat.model,
          systemPrompt: "sys",
          userContent: "{}",
          schema: SCHEMA,
          maxOutputTokens: 1500,
          reasoningEffort: seat.reasoningEffort,
          userId: "coolify-receipt",
          service: "strategy",
          feature: "strategy"
        }
      ) as Record<string, any>;
      expect(body.max_completion_tokens).toBeGreaterThan(0);
      expect(body.response_format).toBeTruthy();
      expect(body.provider?.require_parameters, seat.model).not.toBe(true);
      expect(body.provider?.allow_fallbacks).toBe(true);
      expect(shouldRequireOpenRouterParameters(body), seat.model).toBe(false);
    }

    expect(shouldRequireOpenRouterParameters({ model: "openai/gpt-5.4-nano" })).toBe(false);
  });
});

describe("extractLlmText", () => {
  it("OpenAI chat-completions content", () => {
    expect(extractLlmText({ choices: [{ message: { content: "{\"ok\":true}" } }] })).toBe("{\"ok\":true}");
  });

  it("OpenAI responses output_text", () => {
    expect(extractLlmText({ output_text: "hello" })).toBe("hello");
  });

  it("Mistral high-reasoning chat-completions content is a chunk array, not a string", () => {
    const payload = {
      choices: [
        {
          message: {
            content: [
              { type: "thinking", thinking: [{ type: "text", text: "reasoning trace, not the answer" }] },
              { type: "text", text: "{\"ok\":true}" }
            ]
          }
        }
      ]
    };
    expect(extractLlmText(payload)).toBe("{\"ok\":true}");
  });

  it("Mistral chunk array with multiple text chunks concatenates them", () => {
    const payload = { choices: [{ message: { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] } }] };
    expect(extractLlmText(payload)).toBe("ab");
  });

  it("Anthropic tool_use input is re-serialized to JSON", () => {
    const payload = { content: [{ type: "tool_use", name: "trade_proposals", input: { ok: true, n: 3 } }] };
    expect(JSON.parse(extractLlmText(payload)!)).toEqual({ ok: true, n: 3 });
  });

  it("Anthropic text blocks are concatenated when there is no tool_use", () => {
    const payload = { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] };
    expect(extractLlmText(payload)).toBe("ab");
  });

  it("returns undefined for an empty/unknown payload", () => {
    expect(extractLlmText(undefined)).toBeUndefined();
    expect(extractLlmText({})).toBeUndefined();
  });
});
