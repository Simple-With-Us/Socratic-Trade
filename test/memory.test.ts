import { beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../src/lib/db";
import { extractCandidates, score } from "../src/lib/memory/salience";
import { forget, ingestMessage, listMemories, retrieve } from "../src/lib/memory/store";

describe("salience-gated memory", () => {
  beforeAll(() => {
    process.env.DATABASE_URL = `file:${process.env.TMPDIR ?? "/tmp"}/memory-test-${Date.now()}.db`;
    getDb();
  });

  it("extracts hard constraints and scores them WRITE", () => {
    const cands = extractCandidates("Please, no options and no leverage ever. Max position 5%.");
    const subjects = cands.map((c) => c.subject);
    expect(subjects).toContain("no_options");
    expect(subjects).toContain("no_leverage");
    expect(subjects).toContain("max_position_pct");
    expect(score(cands.find((c) => c.subject === "no_options")!).decision).toBe("WRITE");
  });

  it("PII is a hard SKIP gate", () => {
    const r = score({
      kind: "constraint",
      subject: "x",
      value: "123-45-6789",
      source: "user_stated",
      confidence: 0.9,
      hard: true,
      specificity: 0.9,
      pii: true
    });
    expect(r.decision).toBe("SKIP");
    expect(r.score).toBe(0);
  });

  it("ingest persists constraints; retrieve surfaces hard constraints first", () => {
    ingestMessage("m1", "I want a moderate risk tolerance and a dividend, income style.");
    ingestMessage("m1", "Absolutely no options or derivatives.");
    expect(listMemories("m1").some((m) => m.subject === "no_options" && m.hard)).toBe(true);
    expect(retrieve("m1", { limit: 12 })[0]!.hard).toBe(true);
  });

  it("reconciles on write: a changed preference supersedes the prior value (no contradictions)", () => {
    ingestMessage("m2", "My risk tolerance is conservative.");
    ingestMessage("m2", "My risk tolerance is aggressive.");
    const live = listMemories("m2").filter((m) => m.subject === "risk_tolerance");
    expect(live.length).toBe(1);
    expect(live[0]!.value).toBe("aggressive");
  });

  it("forget hard-deletes a memory", () => {
    ingestMessage("m3", "no leverage please");
    const item = listMemories("m3")[0]!;
    expect(forget("m3", item.id)).toBe(true);
    expect(listMemories("m3").find((m) => m.id === item.id)).toBeUndefined();
  });
});
