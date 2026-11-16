import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyCongressEvent, resetCongressEventDedupe } from "../src/lib/congress-trade-events";
import { getCongressDataset } from "../src/lib/web-sources";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-congress-parity-${randomUUID()}.db`)}`;
});

beforeEach(() => {
  resetCongressEventDedupe();
});

const recent = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
const trade = (symbol: string) => ({
  symbol,
  member: "Jane Doe",
  chamber: "house",
  side: "buy",
  tradedAt: recent(5),
  disclosedAt: recent(2),
});
const apply = (e: unknown) => applyCongressEvent(e);
const hasSymbol = (symbol: string) => (getCongressDataset()?.trades ?? []).some((t) => t.symbol === symbol);

/**
 * App A (congress.trade) sends the trade event in several shapes across its
 * channels and rollout window; App B must ingest all of them. Regression guard
 * for the silent-drop bug where a `trade.new` / bare-tx / webhook shape returned
 * unknown-type (SSE) or invalid-event → HTTP 400 (webhook, causing App A retries
 * then dead-letter).
 */
describe("applyCongressEvent — App A wire-shape parity", () => {
  it("accepts the legacy webhook shape { event: 'trade.new', transaction }", () => {
    const res = apply({ event: "trade.new", transaction: trade("PARITYA"), deliveredAt: recent(1) });
    expect(res).toMatchObject({ ok: true, type: "congress.trade" });
    expect(res.applied).toBeGreaterThanOrEqual(1);
    expect(hasSymbol("PARITYA")).toBe(true);
  });

  it("aliases the legacy `trade.new` type to canonical `congress.trade`", () => {
    const res = apply({ type: "trade.new", id: `evt-${randomUUID()}`, data: { trades: [trade("PARITYB")] } });
    expect(res).toMatchObject({ ok: true, type: "congress.trade" });
    expect(res.applied).toBeGreaterThanOrEqual(1);
  });

  it("accepts a flattened SSE frame with top-level trades", () => {
    const res = apply({ type: "congress.trade", id: `evt-${randomUUID()}`, trades: [trade("PARITYC")] });
    expect(res.applied).toBeGreaterThanOrEqual(1);
    expect(hasSymbol("PARITYC")).toBe(true);
  });

  it("still accepts the canonical { type, data: { trades } } envelope", () => {
    const res = apply({ type: "congress.trade", id: `evt-${randomUUID()}`, data: { trades: [trade("PARITYD")] } });
    expect(res.applied).toBeGreaterThanOrEqual(1);
    expect(hasSymbol("PARITYD")).toBe(true);
  });

  it("accepts a bare-tx SSE frame whose envelope `type` was stamped by applySseMessage", () => {
    // Legacy bare-tx SSE: the `data:` line is one App A transaction (txType-keyed), and
    // applySseMessage copies the SSE event name into `env.type`. Because coerceCongressTrade reads
    // `type` BEFORE `txType` for the side, the stamped envelope `type` must be stripped before the
    // envelope is coerced as a bare trade — otherwise the valid P/S row is dropped as no-trades.
    const res = apply({
      type: "congress.trade",
      id: `evt-${randomUUID()}`,
      ticker: "PARITYE",
      txType: "P",
      txDate: recent(5),
      memberName: "Jane Doe",
      chamber: "house",
    });
    expect(res).toMatchObject({ ok: true, type: "congress.trade" });
    expect(res.applied).toBeGreaterThanOrEqual(1);
    expect(hasSymbol("PARITYE")).toBe(true);
  });

  it("uses the legacy event name when a bare transaction keeps `type` as the trade side", () => {
    const res = apply({
      event: "trade.new",
      type: "purchase",
      ticker: "PARITYF",
      txDate: recent(5),
      memberName: "Jane Doe",
      chamber: "house",
    });
    expect(res).toMatchObject({ ok: true, type: "congress.trade" });
    expect(res.applied).toBeGreaterThanOrEqual(1);
    expect(hasSymbol("PARITYF")).toBe(true);
  });

  it("rejects a payload with no resolvable type", () => {
    expect(apply({ foo: "bar" })).toMatchObject({ ok: false, applied: 0, reason: "invalid-event" });
  });
});
