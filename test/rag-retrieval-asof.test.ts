import { describe, expect, it } from "vitest";
import { resolveRetrievalAsOf } from "../src/lib/rag/retrieval-asof";

describe("resolveRetrievalAsOf", () => {
  it("prefers a parseable explicit question date", () => {
    expect(resolveRetrievalAsOf("2026-05-01T12:00:00.000Z", () => "2099-01-01T00:00:00.000Z")).toBe(
      "2026-05-01T12:00:00.000Z"
    );
  });

  it("falls back to now when as_of is missing or unparseable", () => {
    const now = () => "2026-08-20T03:00:00.000Z";
    expect(resolveRetrievalAsOf(undefined, now)).toBe("2026-08-20T03:00:00.000Z");
    expect(resolveRetrievalAsOf("   ", now)).toBe("2026-08-20T03:00:00.000Z");
    expect(resolveRetrievalAsOf("not-a-date", now)).toBe("2026-08-20T03:00:00.000Z");
  });
});
