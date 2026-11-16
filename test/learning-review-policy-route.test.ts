/**
 * /api/policy — learning-review field validation (PR #1278 review fixes).
 *
 * A blank learningReviewModel used to be silently DELETED before setPolicy; with the explicit
 * claude-fable-5 default in DEFAULT_POLICY, mergePolicy would refill it — turning a "clear" into
 * a silent revert-to-default. The route now lets a blank fall through to validatePolicy's
 * non-empty rule (mirroring the Green/Red model precedent), so the save 400s and the stored
 * selection is untouched. Also covers the trigger-knob bounds (learningReviewMinNewLessons /
 * learningReviewMaxWaitDays).
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-lr-policy-route-${randomUUID()}.db`)}`;
});

function putPolicy(body: Record<string, unknown>) {
  return new Request("http://localhost/api/policy", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("/api/policy — learningReviewModel blank handling", () => {
  it("rejects a blank model with a 400 instead of silently reverting to the default", async () => {
    const { PUT } = await import("../app/api/policy/route");
    const { getPolicy } = await import("../src/lib/db");
    const { DEFAULT_REQUEST_USER_ID } = await import("../src/lib/request-user");

    // Pick a non-default model first so a silent revert would be observable.
    expect((await PUT(putPolicy({ learningReviewModel: "openai/gpt-5.5" }))).status).toBe(200);

    for (const blank of ["", "   "]) {
      const response = await PUT(putPolicy({ learningReviewModel: blank }));
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("learningReviewModel must be a non-empty model id.");
    }
    // The stored selection is untouched by the rejected saves.
    expect(getPolicy(DEFAULT_REQUEST_USER_ID).learningReviewModel).toBe("openai/gpt-5.5");
  });

  it("rejects a null model clear too, not just a blank string (#4)", async () => {
    // Regression: a cleared optional field serializes to `null`, which stripNullsDeep deleted BEFORE
    // validatePolicy's non-empty check ran — so a null slipped past the blank-string guard and
    // setPolicy merged the claude-fable-5 default back (a hidden clear->default the owner banned).
    const { PUT } = await import("../app/api/policy/route");
    const { getPolicy } = await import("../src/lib/db");
    const { DEFAULT_REQUEST_USER_ID } = await import("../src/lib/request-user");

    expect((await PUT(putPolicy({ learningReviewModel: "openai/gpt-5.5" }))).status).toBe(200);
    const response = await PUT(putPolicy({ learningReviewModel: null }));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("learningReviewModel must be a non-empty model id.");
    // Not silently reverted to the default — the explicit selection stands.
    expect(getPolicy(DEFAULT_REQUEST_USER_ID).learningReviewModel).toBe("openai/gpt-5.5");
  });

  it("still accepts a real model change", async () => {
    const { PUT } = await import("../app/api/policy/route");
    const response = await PUT(putPolicy({ learningReviewModel: "anthropic/claude-opus-4-8" }));
    expect(response.status).toBe(200);
    expect((await response.json()).learningReviewModel).toBe("anthropic/claude-opus-4-8");
  });
});

describe("/api/policy — learning-review trigger knobs", () => {
  it("persists a supported learning-review reasoning effort and rejects unknown values", async () => {
    const { PUT } = await import("../app/api/policy/route");
    const ok = await PUT(putPolicy({ learningReviewModel: "gpt-5.6-sol", learningReviewReasoningEffort: "high" }));
    expect(ok.status).toBe(200);
    expect((await ok.json()).learningReviewReasoningEffort).toBe("high");

    const bad = await PUT(putPolicy({ learningReviewReasoningEffort: "extreme" }));
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("learningReviewReasoningEffort must be none, minimal, low, medium, high, xhigh, or max.");
  });

  it("bounds learningReviewMinNewLessons and learningReviewMaxWaitDays", async () => {
    const { PUT } = await import("../app/api/policy/route");
    for (const bad of [{ learningReviewMinNewLessons: 0 }, { learningReviewMinNewLessons: 1.5 }, { learningReviewMinNewLessons: "five" }]) {
      const response = await PUT(putPolicy(bad));
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("learningReviewMinNewLessons must be an integer between 1 and 1000.");
    }
    for (const bad of [{ learningReviewMaxWaitDays: 0 }, { learningReviewMaxWaitDays: 2.5 }, { learningReviewMaxWaitDays: 9999 }]) {
      const response = await PUT(putPolicy(bad));
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("learningReviewMaxWaitDays must be an integer between 1 and 365.");
    }
    const ok = await PUT(putPolicy({ learningReviewMinNewLessons: 3, learningReviewMaxWaitDays: 10 }));
    expect(ok.status).toBe(200);
    const saved = await ok.json();
    expect(saved.learningReviewMinNewLessons).toBe(3);
    expect(saved.learningReviewMaxWaitDays).toBe(10);
  });
});
