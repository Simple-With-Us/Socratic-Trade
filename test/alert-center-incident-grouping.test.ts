import { describe, expect, it } from "vitest";
import type { NotificationEvent } from "../src/lib/types";

// The Alert Center used to map notification rows 1:1 to displayed rows, so the "Attention" pill
// counted REPEATS rather than incidents: db-health re-alerts a still-degraded provider every 6h, so
// one three-day outage of a single provider showed as ~12 separate rows and a pill reading "12".
// buildRows now collapses repeats of one condition into a single incident row; these tests pin both
// the collapsing and — more importantly — the cases that must NEVER collapse.

async function load() {
  return import("../app/console/components/alert-center");
}

function providerAlert(overrides: Partial<NotificationEvent> & { id: string; createdAt: string }): NotificationEvent {
  return {
    type: "provider_degraded",
    title: "fmp connection failed",
    status: "sent",
    payload: {},
    ...overrides
  };
}

describe("Alert Center incident grouping", () => {
  it("collapses repeat provider_degraded rows for one condition into a single incident", async () => {
    const { buildRows, matchesFilter } = await load();
    // A three-day outage: one row every 6h for the same lane.
    const events: NotificationEvent[] = Array.from({ length: 12 }, (_, i) =>
      providerAlert({ id: `evt-${i}`, createdAt: new Date(Date.UTC(2026, 6, 1, i * 6)).toISOString() })
    );

    const rows = buildRows(events, {}, []);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.repeatCount).toBe(12);
    // Representative is the NEWEST row; firstAt walks back to the oldest.
    expect(rows[0]?.event.id).toBe("evt-11");
    expect(rows[0]?.firstAt).toBe(events[0]?.createdAt);
    // Every underlying row id is carried so acknowledging the line clears the whole incident —
    // otherwise the older repeats would regroup straight back into Attention.
    expect(rows[0]?.eventIds.slice().sort()).toEqual(events.map((e) => e.id).sort());

    // The pill counts incidents, not rows.
    expect(rows.filter((row) => matchesFilter(row.event, "attention")).length).toBe(1);
  });

  it("does not merge different failing providers", async () => {
    const { buildRows } = await load();
    const rows = buildRows(
      [
        providerAlert({ id: "a", createdAt: "2026-07-01T00:00:00.000Z", title: "fmp connection failed" }),
        providerAlert({ id: "b", createdAt: "2026-07-01T01:00:00.000Z", title: "massive connection failed" }),
        // A different producer entirely (vector-db's RAG alert / provider-tier downgrade write their
        // own titles and their own unrelated payload shapes) must stay its own incident.
        providerAlert({ id: "c", createdAt: "2026-07-01T02:00:00.000Z", title: "RAG rerank degraded" })
      ],
      {},
      []
    );

    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.repeatCount === 1)).toBe(true);
  });

  it("does not merge the same condition across different connected accounts", async () => {
    const { buildRows } = await load();
    const rows = buildRows(
      [
        providerAlert({ id: "a", createdAt: "2026-07-01T00:00:00.000Z", connectedAccountId: "acct-1" }),
        providerAlert({ id: "b", createdAt: "2026-07-01T01:00:00.000Z", connectedAccountId: "acct-2" })
      ],
      {},
      []
    );

    expect(rows).toHaveLength(2);
  });

  it("does not fold an acknowledged row together with live ones", async () => {
    const { buildRows, matchesFilter } = await load();
    const rows = buildRows(
      [
        providerAlert({ id: "old", createdAt: "2026-07-01T00:00:00.000Z", acknowledgedAt: "2026-07-01T00:30:00.000Z" }),
        providerAlert({ id: "live-1", createdAt: "2026-07-01T06:00:00.000Z" }),
        providerAlert({ id: "live-2", createdAt: "2026-07-01T12:00:00.000Z" })
      ],
      {},
      []
    );

    // Two incidents: one acknowledged (still visible under "All"), one live pair in Attention.
    expect(rows).toHaveLength(2);
    const attention = rows.filter((row) => matchesFilter(row.event, "attention"));
    expect(attention).toHaveLength(1);
    expect(attention[0]?.repeatCount).toBe(2);
    expect(attention[0]?.eventIds).not.toContain("old");
  });

  it("never groups alert types whose repeats are distinct events", async () => {
    const { buildRows } = await load();
    // Two run_failed rows can share a title and still be two separate failed runs — grouping them
    // would hide a second failure behind the first.
    const rows = buildRows(
      [
        { id: "r1", createdAt: "2026-07-01T00:00:00.000Z", type: "run_failed", title: "Run failed", status: "sent", payload: {} },
        { id: "r2", createdAt: "2026-07-01T01:00:00.000Z", type: "run_failed", title: "Run failed", status: "sent", payload: {} }
      ],
      {},
      []
    );

    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.repeatCount === 1 && row.eventIds.length === 1)).toBe(true);
  });

  it("keeps rows sorted newest incident first", async () => {
    const { buildRows } = await load();
    const rows = buildRows(
      [
        providerAlert({ id: "older", createdAt: "2026-07-01T00:00:00.000Z", title: "fmp connection failed" }),
        providerAlert({ id: "newer", createdAt: "2026-07-02T00:00:00.000Z", title: "massive connection failed" })
      ],
      {},
      []
    );

    expect(rows.map((row) => row.event.id)).toEqual(["newer", "older"]);
  });

  it("collapses congress.trade:sse flaps and same-lane title variants into one row (#2550)", async () => {
    const { buildRows } = await load();
    const rows = buildRows(
      [
        providerAlert({
          id: "sse-1",
          createdAt: "2026-08-06T00:00:00.000Z",
          title: "congress.trade:sse connection failed",
          payload: { service: "congress.trade:sse" },
        }),
        providerAlert({
          id: "sse-2",
          createdAt: "2026-08-06T06:00:00.000Z",
          title: "congress.trade:sse connection failed",
          payload: { service: "congress.trade:sse" },
        }),
        providerAlert({
          id: "ct-1",
          createdAt: "2026-08-06T01:00:00.000Z",
          title: "congress.trade connection failed",
          payload: { service: "congress.trade" },
        }),
        providerAlert({
          id: "ct-2",
          createdAt: "2026-08-06T07:00:00.000Z",
          title: "congress.trade connection failed: timeout",
          payload: { service: "congress.trade" },
        }),
      ],
      {},
      []
    );

    expect(rows).toHaveLength(2);
    const sse = rows.find((row) => row.event.payload && (row.event.payload as { service?: string }).service === "congress.trade:sse");
    const ct = rows.find((row) => row.event.payload && (row.event.payload as { service?: string }).service === "congress.trade");
    expect(sse?.repeatCount).toBe(2);
    expect(ct?.repeatCount).toBe(2);
  });
});
