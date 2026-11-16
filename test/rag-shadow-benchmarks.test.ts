import { describe, expect, it, vi } from "vitest";
import {
  probeTursoVectorCapability,
  runPineconeAssistantShadow,
  type LocalSqliteProbe,
  type ReadOnlyAssistantClient
} from "../scripts/eval/rag-shadow-benchmarks";

describe("RAG shadow benchmarks", () => {
  it("does not construct or call an Assistant until the explicit live gate is on", async () => {
    const context = vi.fn();
    const receipt = await runPineconeAssistantShadow({
      liveEnabled: false,
      assistantName: "existing-assistant",
      apiKey: "test-key",
      cases: [{ id: "case-1", query: "raw query must not appear in the receipt" }],
      client: { context }
    });

    expect(context).not.toHaveBeenCalled();
    expect(receipt).toMatchObject({ status: "skipped", reason: "live_gate_off", executedCaseCount: 0 });
    expect(JSON.stringify(receipt)).not.toContain("raw query");
  });

  it("caps read-only Assistant context calls at 100 and emits redacted citation and usage receipts", async () => {
    const context = vi.fn(async () => ({
      snippets: [{ content: "never persist corpus text", reference: { file: { id: "provider-file-id", name: "secret-filing.txt" } } }],
      usage: { promptTokens: 12, completionTokens: 0, totalTokens: 12 }
    }));
    let clock = 1_000;
    const cases = Array.from({ length: 102 }, (_, index) => ({ id: `case-${index}`, query: `private query ${index}` }));
    const receipt = await runPineconeAssistantShadow({
      liveEnabled: true,
      assistantName: "existing-assistant",
      apiKey: "test-key",
      maxQueries: 1000,
      cases,
      client: { context },
      now: () => ++clock
    });

    expect(context).toHaveBeenCalledTimes(100);
    expect(receipt.status).toBe("completed");
    expect(receipt).toMatchObject({ hardQueryCap: 100, requestedCaseCount: 102, executedCaseCount: 100 });
    expect(receipt.cases[0]).toMatchObject({ status: "ok", citationCount: 1, usage: { totalTokens: 12 } });
    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toContain("private query");
    expect(serialized).not.toContain("never persist corpus text");
    expect(serialized).not.toContain("secret-filing.txt");
    expect(serialized).not.toContain("provider-file-id");
  });

  it("records timeouts without exposing provider error bodies or prompt text", async () => {
    let observedSignal: AbortSignal | undefined;
    const never: ReadOnlyAssistantClient = {
      context: (_options, signal) => {
        observedSignal = signal;
        return new Promise(() => {});
      }
    };
    const receipt = await runPineconeAssistantShadow({
      liveEnabled: true,
      assistantName: "existing-assistant",
      apiKey: "test-key",
      timeoutMs: 1,
      cases: [{ id: "case-timeout", query: "do not retain this query" }],
      client: never
    });

    expect(receipt.cases).toEqual([expect.objectContaining({ id: "case-timeout", status: "timeout", error: "timeout" })]);
    expect(observedSignal?.aborted).toBe(true);
    expect(JSON.stringify(receipt)).not.toContain("do not retain this query");
  });

  it("reports unavailable local Turso/libSQL vector support truthfully without a remote probe", () => {
    const calls: string[] = [];
    const probe: LocalSqliteProbe = {
      get(sql) {
        calls.push(sql);
        if (sql.includes("sqlite_version")) return { sqliteVersion: "3.46.0" };
        throw new Error("no such function");
      },
      close: vi.fn()
    };
    const receipt = probeTursoVectorCapability(() => probe);

    expect(receipt).toMatchObject({
      target: "turso-libsql-vector",
      status: "unsupported",
      networkProbed: false,
      sqliteVersion: "3.46.0",
      vector32Available: false,
      vectorDistanceCosAvailable: false
    });
    expect(calls).toHaveLength(3);
    expect(probe.close).toHaveBeenCalledOnce();
  });
});
