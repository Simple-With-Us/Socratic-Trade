import { describe, expect, it } from "vitest";
import {
  compareGreenRedParity,
  createEvidencePack,
  createEvidenceRef,
  serializeEvidencePack,
  type EvidenceRef,
  type EvidenceSourceFamily
} from "../src/lib/evidence-pack";
import { applyEvidenceBudget, estimateEvidenceTokens } from "../src/lib/evidence-budget";

function ref(
  family: EvidenceSourceFamily = "market",
  overrides: Partial<Pick<EvidenceRef, "kind" | "subject" | "content">> = {}
): EvidenceRef {
  return createEvidenceRef({
    kind: "quote",
    subject: "NVDA",
    source: {
      family,
      name: "primary-feed",
      status: "success",
      observedAt: "2026-07-13T14:00:00.000Z",
      asOf: "2026-07-13T14:00:00.000Z",
      retrievedAt: "2026-07-13T14:00:03.000Z",
      provenance: {
        provider: "provider-a",
        locator: "quote/NVDA",
        upstreamHash: null,
        lineage: ["provider-a", "exchange"]
      }
    },
    content: { price: 123.45, nested: { beta: 1.2 }, flags: ["real-time", true] },
    ...overrides
  });
}

describe("immutable evidence contract", () => {
  it("assigns stable ids and content hashes across object-key order", () => {
    const first = ref("market", { content: { a: 1, nested: { y: 2, x: 1 } } });
    const second = ref("market", { content: { nested: { x: 1, y: 2 }, a: 1 } });
    expect(first.id).toBe(second.id);
    expect(first.contentHash).toBe(second.contentHash);
    expect(first.id).toMatch(/^ev_[a-f0-9]{64}$/);
  });

  it("binds identity to full source metadata, including freshness state and provenance", () => {
    const fresh = ref();
    const stale = createEvidenceRef({
      ...fresh,
      source: { ...fresh.source, status: "stale", retrievedAt: "2026-07-13T14:10:03.000Z" }
    });
    expect(stale.id).not.toBe(fresh.id);
    expect(stale.contentHash).toBe(fresh.contentHash);
  });

  it("deeply freezes ref source, provenance, and content rather than retaining caller-owned values", () => {
    const callerContent = { price: 100, nested: { spread: 2 } } as const;
    const evidence = ref("market", { content: callerContent });
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.source.provenance.lineage)).toBe(true);
    expect(Object.isFrozen(evidence.content)).toBe(true);
    expect(Object.isFrozen((evidence.content as { nested: object }).nested)).toBe(true);
    expect(evidence.content).toEqual(callerContent);
  });

  it("rejects malformed source state, timestamps, and non-finite JSON data", () => {
    expect(() => createEvidenceRef({ ...ref(), source: { ...ref().source, observedAt: "not-a-date" } })).toThrow("observedAt");
    expect(() => createEvidenceRef({ ...ref(), source: { ...ref().source, status: "not-ready" as "success" } })).toThrow("source.status");
    expect(() => ref("market", { content: { price: Number.NaN } })).toThrow("non-finite");
  });

  it("canonically sorts immutable packs and produces a complete parity hash", () => {
    const market = ref("market");
    const filing = ref("filings", { kind: "sec-filing", subject: "NVDA:10-Q" });
    const first = createEvidencePack({ decisionKey: "run-42", evidence: [market, filing] });
    const second = createEvidencePack({ decisionKey: "run-42", evidence: [filing, market] });
    expect(first.packHash).toBe(second.packHash);
    expect(first.greenRedParityHash).toBe(second.greenRedParityHash);
    expect(first.evidence.map((entry) => entry.id)).toEqual([...first.evidence.map((entry) => entry.id)].sort());
    expect(Object.isFrozen(first.evidence)).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
    expect(serializeEvidencePack(first)).toBe(serializeEvidencePack(second));
  });

  it("detects any Green/Red manifest mismatch and refuses duplicate refs", () => {
    const market = ref("market");
    const red = createEvidencePack({ decisionKey: "run-42", evidence: [market] });
    const green = createEvidencePack({ decisionKey: "run-42", evidence: [market, ref("macro", { subject: "US10Y" })] });
    expect(compareGreenRedParity(green, red)).toMatchObject({ matches: false, expectedParityHash: green.greenRedParityHash });
    expect(() => createEvidencePack({ decisionKey: "run-42", evidence: [market, market] })).toThrow("duplicate");
  });
});

describe("evidence budget", () => {
  it("uses Unicode-aware deterministic token estimates", () => {
    expect(estimateEvidenceTokens("abcd")).toBe(1);
    expect(estimateEvidenceTokens("abcde")).toBe(2);
    expect(estimateEvidenceTokens("😀😀😀😀")).toBe(1);
  });

  it("applies priority then ref id, family quotas, and explicit truncation/omission receipts", () => {
    const market = ref("market", { subject: "AAPL" });
    const filing = ref("filings", { kind: "filing", subject: "AAPL:10-Q" });
    const macro = ref("macro", { kind: "macro", subject: "CPI" });
    const result = applyEvidenceBudget(
      [
        { ref: macro, text: "012345", priority: 1 },
        { ref: filing, text: "abcdef", priority: 10 },
        { ref: market, text: "uvwxyz", priority: 10 }
      ],
      { maxCharacters: 8, maxTokenEstimate: 2, charactersPerToken: 4, familyQuotas: { filings: { maxCharacters: 3 } } }
    );
    expect(result.usedCharacters).toBe(7); // token quota leaves only one four-character allocation after the filing quota
    expect(result.usedTokenEstimate).toBe(2);
    const filingReceipt = result.receipts.find((receipt) => receipt.evidenceId === filing.id)!;
    const marketReceipt = result.receipts.find((receipt) => receipt.evidenceId === market.id)!;
    const macroReceipt = result.receipts.find((receipt) => receipt.evidenceId === macro.id)!;
    expect(filingReceipt).toMatchObject({ action: "truncated", includedCharacters: 3, constraints: ["family_character_quota"] });
    expect(marketReceipt.action).toBe("truncated");
    expect(macroReceipt).toMatchObject({ action: "omitted", includedCharacters: 0 });
    expect(macroReceipt.constraints).toContain("global_character_quota");
    expect(macroReceipt.constraints).toContain("global_token_quota");
    expect(result.included.map((entry) => entry.evidenceId)).toEqual([filing.id, market.id]);
  });

  it("is input-order invariant and rejects duplicate item refs", () => {
    const alpha = ref("news", { kind: "news", subject: "NVDA:a" });
    const beta = ref("news", { kind: "news", subject: "NVDA:b" });
    const budget = { maxCharacters: 6, maxTokenEstimate: 2 };
    const first = applyEvidenceBudget([{ ref: alpha, text: "aaa" }, { ref: beta, text: "bbb" }], budget);
    const second = applyEvidenceBudget([{ ref: beta, text: "bbb" }, { ref: alpha, text: "aaa" }], budget);
    expect(first).toEqual(second);
    expect(() => applyEvidenceBudget([{ ref: alpha, text: "a" }, { ref: alpha, text: "b" }], budget)).toThrow("duplicate");
  });
});
