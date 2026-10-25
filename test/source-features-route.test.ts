import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { ApiErrorBodySchema, SourceFeaturesPatchOkSchema } from "./route-response-schemas";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-source-features-${randomUUID()}.db`)}`;
});

async function patch(body: unknown) {
  const { NextRequest } = await import("next/server");
  const { PATCH } = await import("../app/api/settings/source-features/route");
  return PATCH(
    new NextRequest("http://localhost/api/settings/source-features", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    })
  );
}

describe("PATCH /api/settings/source-features", () => {
  it("rejects a body without a settings object", async () => {
    expect((await patch({})).status).toBe(400);
    expect((await patch({ settings: "on" })).status).toBe(400);
    expect((await patch({ settings: {}, extra: true })).status).toBe(400);
  });

  it("rejects non-scalar setting values", async () => {
    expect((await patch({ settings: { RAG_EMBED_DISCLOSURES: { on: true } } })).status).toBe(400);
  });

  it("rejects the removed FMP settings as unknown", async () => {
    const res = await patch({ settings: { fmpRealTimeDataEnabled: true } });
    expect(res.status).toBe(400);
    expect(ApiErrorBodySchema.parse(await res.json()).error).toContain("Unknown setting");
  });

  it("persists a known setting", async () => {
    const res = await patch({ settings: { RAG_EMBED_DISCLOSURES: true } });
    expect(res.status).toBe(200);
    const body = SourceFeaturesPatchOkSchema.parse(await res.json());
    expect(body.overrides.RAG_EMBED_DISCLOSURES).toBe(true);
  });
});
