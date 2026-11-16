/**
 * ST-4589: the owner's per-seat rotation sets (`llmRotationModels` for Green,
 * `redTeamRotationModels` for Red) — validation, canonicalisation, dedupe and the max-length
 * bound in PUT /api/policy, plus the persistence round trip through getPolicy.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-policy-rotation-models-${randomUUID()}.db`)}`;
});

function put(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/policy", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("normalizeRotationModelSelection", () => {
  it("trims, canonicalises catalog spellings to display slugs, dedupes, and keeps custom ids", async () => {
    const { normalizeRotationModelSelection } = await import("../src/lib/model-rotation-selection");
    const { CATALOG_DISPLAY_SLUGS, openRouterSlugFor } = await import("../src/lib/llm-model-catalog");
    const a = CATALOG_DISPLAY_SLUGS[0]!;
    const b = CATALOG_DISPLAY_SLUGS[1]!;
    const out = normalizeRotationModelSelection("llmRotationModels", [
      `  ${a} `,
      openRouterSlugFor(a),
      `openrouter/${openRouterSlugFor(b)}`,
      "my-custom/model-id",
      "my-custom/model-id"
    ]);
    expect(out).toEqual({ ok: true, value: [a, b, "my-custom/model-id"] });
  });

  it("rejects non-arrays, non-strings, blank and over-long ids, and more than 40 entries", async () => {
    const { normalizeRotationModelSelection, ROTATION_SELECTION_MAX_ENTRIES } = await import("../src/lib/model-rotation-selection");
    expect(normalizeRotationModelSelection("llmRotationModels", "gpt")).toEqual({
      ok: false,
      error: "llmRotationModels must be an array of model-id strings."
    });
    expect(normalizeRotationModelSelection("redTeamRotationModels", [1])).toEqual({
      ok: false,
      error: "redTeamRotationModels must be an array of model-id strings."
    });
    expect(normalizeRotationModelSelection("llmRotationModels", ["  "]).ok).toBe(false);
    expect(normalizeRotationModelSelection("llmRotationModels", ["x".repeat(65)]).ok).toBe(false);
    expect(normalizeRotationModelSelection("llmRotationModels", ["x".repeat(64)]).ok).toBe(true);
    const many = Array.from({ length: ROTATION_SELECTION_MAX_ENTRIES + 1 }, (_, i) => `custom-${i}`);
    expect(normalizeRotationModelSelection("llmRotationModels", many).ok).toBe(false);
    expect(normalizeRotationModelSelection("llmRotationModels", many.slice(1)).ok).toBe(true);
    // Duplicates collapse BEFORE the bound is checked.
    expect(normalizeRotationModelSelection("llmRotationModels", [...many.slice(1), "custom-1"]).ok).toBe(true);
  });
});

describe("PUT /api/policy rotation sets", () => {
  it("persists both seats' canonicalised sets and round-trips them through getPolicy", async () => {
    const { PUT, GET } = await import("../app/api/policy/route");
    const { getPolicy } = await import("../src/lib/db");
    const { DEFAULT_REQUEST_USER_ID } = await import("../src/lib/request-user");
    const { CATALOG_DISPLAY_SLUGS, openRouterSlugFor } = await import("../src/lib/llm-model-catalog");
    const [a, b, c] = CATALOG_DISPLAY_SLUGS as string[];
    const response = await PUT(
      put({
        llmModel: "__rotate__",
        redTeamLlmModel: "__rotate__",
        llmRotationModels: [a, openRouterSlugFor(a), b],
        redTeamRotationModels: [` ${c} `]
      })
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { llmRotationModels?: string[]; redTeamRotationModels?: string[] };
    expect(body.llmRotationModels).toEqual([a, b]);
    expect(body.redTeamRotationModels).toEqual([c]);
    const saved = getPolicy(DEFAULT_REQUEST_USER_ID);
    expect(saved.llmRotationModels).toEqual([a, b]);
    expect(saved.redTeamRotationModels).toEqual([c]);

    // An unrelated save keeps the sets.
    expect((await PUT(put({ maxDailyOrders: 7 }))).status).toBe(200);
    const after = (await (await GET(new Request("http://localhost/api/policy"))).json()) as { llmRotationModels?: string[] };
    expect(after.llmRotationModels).toEqual([a, b]);

    // [] keeps an explicit empty set (= rotate all); null clears the key entirely.
    expect((await PUT(put({ llmRotationModels: [] }))).status).toBe(200);
    expect(getPolicy(DEFAULT_REQUEST_USER_ID).llmRotationModels).toEqual([]);
    expect((await PUT(put({ redTeamRotationModels: null }))).status).toBe(200);
    expect(getPolicy(DEFAULT_REQUEST_USER_ID).redTeamRotationModels).toBeUndefined();
  });

  it("rejects malformed sets with a 400 and leaves the stored policy unchanged", async () => {
    const { PUT } = await import("../app/api/policy/route");
    const { getPolicy } = await import("../src/lib/db");
    const { DEFAULT_REQUEST_USER_ID } = await import("../src/lib/request-user");
    for (const [field, value, message] of [
      ["llmRotationModels", "gpt-6-astra", "llmRotationModels must be an array of model-id strings."],
      ["redTeamRotationModels", [42], "redTeamRotationModels must be an array of model-id strings."],
      ["llmRotationModels", [""], undefined],
      ["llmRotationModels", ["y".repeat(65)], undefined],
      ["redTeamRotationModels", Array.from({ length: 41 }, (_, i) => `custom-${i}`), undefined]
    ] as const) {
      const response = await PUT(put({ [field]: value }));
      expect(response.status).toBe(400);
      if (message) expect(await response.text()).toBe(message);
    }
    const saved = getPolicy(DEFAULT_REQUEST_USER_ID);
    expect(saved.llmRotationModels).toBeUndefined();
    expect(saved.redTeamRotationModels).toBeUndefined();
  });
});
