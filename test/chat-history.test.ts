import { beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../src/lib/db";
import { appendTurn, clearTurns, listTurns, sanitizeTranscriptText, MAX_TURNS } from "../src/lib/chat-history";

describe("chat transcript history + redact-on-write", () => {
  beforeAll(() => {
    process.env.DATABASE_URL = `file:${process.env.TMPDIR ?? "/tmp"}/chat-history-test-${Date.now()}.db`;
    getDb();
  });

  it("redacts secrets/PII on write and flags the turn", () => {
    const r = sanitizeTranscriptText("ssn 123-45-6789, api_key = sk-ant-abc123XYZ_def, Bearer abcdef123456");
    expect(r.redacted).toBe(true);
    expect(r.text).not.toContain("123-45-6789");
    expect(r.text).not.toContain("sk-ant-abc123XYZ_def");
    expect(r.text).not.toContain("abcdef123456");
    expect(r.text).toContain("[redacted]");
  });

  it("does not flag clean text", () => {
    expect(sanitizeTranscriptText("buy AAPL when it dips").redacted).toBe(false);
  });

  it("appends + lists turns, validates role, keeps citations, persists redaction flag", () => {
    const t = appendTurn("c1", { role: "assistant", text: "hi", citations: ["doc#1", "doc#2"], intent: "greet" });
    expect(t.role).toBe("assistant");
    expect(t.citations).toEqual(["doc#1", "doc#2"]);
    appendTurn("c1", { role: "user", text: "my token = sk-ant-secretvalue123" });
    const turns = listTurns("c1");
    expect(turns.length).toBe(2);
    expect(turns[0]!.text).toBe("hi");
    expect(turns[1]!.redacted).toBe(true);
    expect(() => appendTurn("c1", { role: "system" as unknown as "user", text: "x" })).toThrow();
  });

  it("caps history at MAX_TURNS (FIFO)", () => {
    for (let i = 0; i < MAX_TURNS + 25; i++) appendTurn("c2", { role: "user", text: `m${i}` });
    const turns = listTurns("c2", MAX_TURNS);
    expect(turns.length).toBe(MAX_TURNS);
    expect(turns[0]!.text).toBe("m25");
    expect(turns[turns.length - 1]!.text).toBe(`m${MAX_TURNS + 24}`);
  });

  it("clearTurns removes all turns for a user", () => {
    appendTurn("c3", { role: "user", text: "x" });
    expect(listTurns("c3").length).toBeGreaterThan(0);
    expect(clearTurns("c3")).toBeGreaterThan(0);
    expect(listTurns("c3").length).toBe(0);
  });
});
