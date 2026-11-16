import { existsSync, mkdirSync, unlinkSync } from "fs";
import os from "os";
import path from "path";
import { afterAll, describe, expect, it } from "vitest";

// Isolated temp SQLite so the real llm_usage migration runs.
const tmpDir = path.join(os.tmpdir(), `trading-test-served-model-${Date.now()}`);
const tmpDbPath = path.join(tmpDir, "test.db");
if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
process.env.DATABASE_URL = `file:${tmpDbPath}`;

const { recordLlmUsage } = await import("../src/lib/llm-usage");
const { attachServedModels, getLatestServedModels } = await import("../src/lib/llm-served-model");

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${tmpDbPath}${suffix}`);
    } catch {
      /* best-effort */
    }
  }
});

function record(model: string, servedModel: string | undefined, createdAtOverride: string, userId = "local") {
  recordLlmUsage({
    userId,
    provider: "openrouter",
    model,
    context: "strategy",
    keySource: "user",
    promptTokens: 10,
    completionTokens: 5,
    servedModel,
    createdAtOverride
  } as never);
}

describe("getLatestServedModels", () => {
  it("returns the most recent non-empty served model per display slug, canonicalising the stored model", () => {
    record("claude-opus-latest", "claude-opus-5-5-20261001", "2026-10-01T00:00:00.000Z");
    record("anthropic/claude-opus-latest", "claude-opus-5-5-20261020", "2026-10-20T00:00:00.000Z");
    // A newer call without a served model must not erase the recorded one.
    record("claude-opus-latest", undefined, "2026-10-25T00:00:00.000Z");
    record("claude-sonnet-latest", "claude-sonnet-5-0", "2026-10-02T00:00:00.000Z", "other-user");

    const other = getLatestServedModels({ userId: "other-user" });
    expect(other.get("claude-sonnet-latest")).toBe("claude-sonnet-5-0");
    expect(other.has("claude-opus-latest")).toBe(false);
    // Scope is explicit: a blank userId reads nothing instead of every user's rows.
    expect(getLatestServedModels({ userId: "" }).size).toBe(0);
    expect(getLatestServedModels({ userId: "   " }).size).toBe(0);

    const mine = getLatestServedModels({ userId: "local" });
    expect(mine.get("claude-opus-latest")).toBe("claude-opus-5-5-20261020");
    expect(mine.has("claude-sonnet-latest")).toBe(false);
  });
});

describe("attachServedModels", () => {
  const rows = [
    { model: "claude-opus-latest" },
    { model: "claude-sonnet-latest" },
    { model: "gpt-6-astra" },
    { model: "grok-latest" }
  ];

  it("attaches servedModel when it differs, expectedModel for unrecorded -latest aliases, nothing for concrete rows", () => {
    const out = attachServedModels(rows, new Map([["claude-opus-latest", "claude-opus-5-5-20261020"]]));
    const by = (m: string) => out.find((r) => r.model === m)!;
    expect(by("claude-opus-latest")).toEqual({ model: "claude-opus-latest", servedModel: "claude-opus-5-5-20261020" });
    expect(by("claude-sonnet-latest")).toEqual({ model: "claude-sonnet-latest", expectedModel: "claude-sonnet-5-5" });
    expect(by("grok-latest")).toEqual({ model: "grok-latest", expectedModel: "grok-4.7" });
    expect(by("gpt-6-astra")).toEqual({ model: "gpt-6-astra" });
  });

  it("prefers the catalog's expectedLatestSlug over a deliberately lagging nativeSlug (Sonnet row)", async () => {
    const { catalogEntryFor } = await import("../src/lib/llm-model-catalog");
    const sonnet = catalogEntryFor("claude-sonnet-latest")!;
    expect(sonnet.nativeSlug).toBe("claude-sonnet-5");
    expect(sonnet.expectedLatestSlug).toBe("claude-sonnet-5-5");
    const out = attachServedModels([{ model: "claude-sonnet-latest" }, { model: "claude-haiku-latest" }], new Map());
    expect(out[0]).toEqual({ model: "claude-sonnet-latest", expectedModel: "claude-sonnet-5-5" });
    // No expectedLatestSlug: the nativeSlug is still the expected target.
    expect(out[1]).toEqual({ model: "claude-haiku-latest", expectedModel: "claude-haiku-5-5" });
  });

  it("omits servedModel when the recorded value equals the display slug", () => {
    const out = attachServedModels([{ model: "gpt-6-astra" }], new Map([["gpt-6-astra", "gpt-6-astra"]]));
    expect(out[0]).toEqual({ model: "gpt-6-astra" });
  });
});
