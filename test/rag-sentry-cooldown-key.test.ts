import { describe, expect, it } from "vitest";
import { ragSentryCooldownKey } from "../src/lib/vector-db";

// PR #4971 review (Kody 4433485730): the RAG Sentry flood guard keys on the Sentry issue the
// event lands in (fingerprint ["rag", lane ?? provider]), never on the drifting display title.
describe("ragSentryCooldownKey", () => {
  it("keys title variants on the same lane to one cooldown", () => {
    const a = ragSentryCooldownKey("warning", "Voyage connection failed", { lane: "rag-embed", provider: "voyage" });
    const b = ragSentryCooldownKey("warning", "voyage embed connection failed", { lane: "rag-embed", provider: "Voyage" });
    expect(a).toBe(b);
  });

  it("keeps different lanes and levels independent", () => {
    const embed = ragSentryCooldownKey("warning", "x", { lane: "rag-embed" });
    expect(ragSentryCooldownKey("warning", "x", { lane: "rag-rerank" })).not.toBe(embed);
    expect(ragSentryCooldownKey("error", "x", { lane: "rag-embed" })).not.toBe(embed);
  });

  it("falls back to provider, then to the message (Sentry's own grouping) when no lane", () => {
    expect(ragSentryCooldownKey("warning", "a", { provider: "pinecone" })).toBe(ragSentryCooldownKey("warning", "b", { provider: "pinecone" }));
    expect(ragSentryCooldownKey("warning", "a", { operation: "query" })).not.toBe(ragSentryCooldownKey("warning", "b", { operation: "query" }));
  });
});
