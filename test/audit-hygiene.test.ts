import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auditDeduped, DEFAULT_DEDUPE_INTERVAL_MS } from "../src/lib/audit-dedupe";
import { auditBoundedStrategyRunResult, summarizeMarketScanForAudit } from "../src/lib/audit-bounded-run";
import { isAuditPruneDue, pruneAuditEvents, AUDIT_PRUNE_OBSERVABILITY_KINDS, AUDIT_PRUNE_NEVER_PRUNED_KINDS } from "../src/lib/audit-prune";
import { getDb } from "../src/lib/db";
import { setInternalSetting } from "../src/lib/db-settings";
import type { MarketScan } from "../src/lib/types";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-audithygiene-${randomUUID()}.db`)}`;
});

beforeEach(() => {
  getDb().prepare("DELETE FROM settings WHERE key LIKE 'auditdedupe:%' OR key LIKE 'auditprune:%'").run();
  getDb().prepare("DELETE FROM audit_events").run();
});

describe("auditDeduped", () => {
  it("logs the first occurrence immediately, suppresses repeats within the interval", () => {
    const calls: unknown[] = [];
    const auditImpl = ((_k: string, p: unknown) => { calls.push(p); }) as never;
    const t0 = Date.UTC(2026, 7, 1, 12);
    expect(auditDeduped("kind_a", { n: 1 }, ["SYM", "note"], { userId: "local" }, { now: t0, auditImpl })).toBe(true);
    expect(auditDeduped("kind_a", { n: 2 }, ["SYM", "note"], { userId: "local" }, { now: t0 + 60_000, auditImpl })).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("logs again after the interval, and immediately for a different signature", () => {
    const calls: unknown[] = [];
    const auditImpl = ((_k: string, p: unknown) => { calls.push(p); }) as never;
    const t0 = Date.UTC(2026, 7, 1, 12);
    auditDeduped("kind_a", { v: 1 }, ["SYM", "note"], {}, { now: t0, auditImpl });
    expect(auditDeduped("kind_a", { v: 2 }, ["SYM", "note"], {}, { now: t0 + DEFAULT_DEDUPE_INTERVAL_MS + 1, auditImpl })).toBe(true);
    expect(auditDeduped("kind_a", { v: 3 }, ["OTHER", "note"], {}, { now: t0 + 1000, auditImpl })).toBe(true);
    expect(calls).toHaveLength(3);
  });

  it("respects a custom minIntervalMs", () => {
    const calls: unknown[] = [];
    const auditImpl = ((_k: string, p: unknown) => { calls.push(p); }) as never;
    const t0 = Date.UTC(2026, 7, 1, 12);
    auditDeduped("kind_a", {}, ["X"], { minIntervalMs: 1000 }, { now: t0, auditImpl });
    expect(auditDeduped("kind_a", {}, ["X"], { minIntervalMs: 1000 }, { now: t0 + 999, auditImpl })).toBe(false);
    expect(auditDeduped("kind_a", {}, ["X"], { minIntervalMs: 1000 }, { now: t0 + 1000, auditImpl })).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("watermark survives across calls (settings KV), not just in-process", () => {
    const calls: unknown[] = [];
    const auditImpl = ((_k: string, p: unknown) => { calls.push(p); }) as never;
    const t0 = Date.UTC(2026, 7, 1, 12);
    auditDeduped("kind_a", {}, ["S"], {}, { now: t0, auditImpl });
    // New "process": fresh deps, same DB — still suppressed.
    expect(auditDeduped("kind_a", {}, ["S"], {}, { now: t0 + 60_000, auditImpl })).toBe(false);
  });
});

function fakeScan(candidateCount: number): MarketScan {
  return {
    source: "test",
    generatedAt: "2026-08-01T00:00:00Z",
    scannedSymbols: 500,
    returnedQuotes: 480,
    topCandidates: Array.from({ length: candidateCount }, (_, i) => ({ symbol: `S${i}` })),
  } as unknown as MarketScan;
}

describe("auditBoundedStrategyRunResult", () => {
  it("replaces marketScan with a bounded summary and preserves other fields", () => {
    const result = { status: "completed", summary: "ok", marketScan: fakeScan(40), proposals: [{ symbol: "AAPL" }] };
    const bounded = auditBoundedStrategyRunResult(result);
    expect(bounded.status).toBe("completed");
    expect(bounded.proposals).toHaveLength(1);
    const ms = bounded.marketScan!;
    expect(ms.omitted).toBe(true);
    expect(ms.candidateCount).toBe(40);
    expect(ms.topSymbols).toHaveLength(15); // capped
    expect(ms.topSymbols[0]).toBe("S0");
    expect(JSON.stringify(ms).length).toBeLessThan(600);
  });

  it("handles a missing scan", () => {
    expect(summarizeMarketScanForAudit(null)).toBeNull();
    expect(summarizeMarketScanForAudit(undefined)).toBeNull();
    const bounded = auditBoundedStrategyRunResult({ status: "failed", marketScan: null });
    expect(bounded.marketScan).toBeNull();
  });
});

describe("pruneAuditEvents", () => {
  function insertAudit(kind: string, createdAt: string) {
    getDb().prepare("INSERT INTO audit_events (id, user_id, connected_account_id, created_at, kind, payload) VALUES (?, 'local', NULL, ?, ?, '{}')")
      .run(randomUUID(), createdAt, kind);
  }
  const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 3600_000).toISOString();

  it("does not delete audit or provider rows by age (forever retention)", () => {
    const noise = AUDIT_PRUNE_OBSERVABILITY_KINDS[0];
    insertAudit(noise, daysAgo(20));
    insertAudit(noise, daysAgo(3));
    insertAudit("order_placed", daysAgo(100));
    insertAudit("order_placed", daysAgo(30));
    const db = getDb();
    db.prepare("INSERT INTO provider_dispatch_attempts (id, authority_id, provider, operation, credential_ref, user_id, units, status, created_at, updated_at) VALUES (?, 'auth', 'p', 'op', 'cred', 'local', 1, 'succeeded', ?, ?)")
      .run(randomUUID(), daysAgo(20), daysAgo(20));
    db.prepare("INSERT INTO provider_usage_outbox (id, attempt_id, provider, operation, credential_ref, user_id, outcome, requests, occurred_at, created_at) VALUES (?, 'att-old', 'p', 'op', 'cred', 'local', 'succeeded', 1, ?, ?)")
      .run(randomUUID(), daysAgo(20), daysAgo(20));

    const res = pruneAuditEvents(new Date());
    expect(res).toEqual({
      auditObservability: 0,
      auditDefault: 0,
      providerDispatch: 0,
      providerOutbox: 0,
      embedStageExpired: 0,
      embedStageCapPruned: 0,
      // ST-4540: the lane's only remaining work is the read-only embed_stage observer, so this
      // count is non-zero when staged paid vectors are still awaiting vector-store delivery.
      embedStageUndeliveredRetained: 0,
      portfolioSnapshotsPruned: 0
    });
    expect((db.prepare("SELECT count(*) c FROM audit_events").get() as { c: number }).c).toBe(4);
    expect((db.prepare("SELECT count(*) c FROM provider_dispatch_attempts").get() as { c: number }).c).toBe(1);
    expect((db.prepare("SELECT count(*) c FROM provider_usage_outbox").get() as { c: number }).c).toBe(1);
  });

  it("keeps Red Team veto kinds and llm_call_latency regardless of age", () => {
    for (const kind of AUDIT_PRUNE_NEVER_PRUNED_KINDS) {
      insertAudit(kind, daysAgo(400));
    }
    insertAudit("order_placed", daysAgo(400));
    pruneAuditEvents(new Date());
    const remainingKinds = (getDb().prepare("SELECT DISTINCT kind FROM audit_events ORDER BY kind").all() as Array<{ kind: string }>).map(
      (r) => r.kind
    );
    expect(remainingKinds).toEqual([...AUDIT_PRUNE_NEVER_PRUNED_KINDS, "order_placed"].sort());
  });

  it("isAuditPruneDue gates on 24h watermark", () => {
    expect(isAuditPruneDue()).toBe(true);
    setInternalSetting("auditprune:lastRunAt", new Date().toISOString());
    expect(isAuditPruneDue()).toBe(false);
  });
});
