import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { POST as importRoute } from "../app/api/admin/securities/import/route";
import { getDb } from "../src/lib/db";
import {
  clearImportedSecuritiesForTests,
  getImportedPriceCloses,
  type ImportedCloseInput,
} from "../src/lib/db-securities-import";
import { buildOpsSnapshot } from "../src/lib/ops-snapshot";
import { peerPushHealth, resolvePeerPushId } from "../src/lib/peer-push-receipt";
import { resetRateLimiter } from "../src/lib/rate-limit";
import { SecuritiesImportResponseSchema } from "../src/lib/securities-import-schema";

function securitiesImportTestToken(): string {
  const token = process.env.SECURITIES_IMPORT_TEST_TOKEN;
  if (!token) throw new Error("SECURITIES_IMPORT_TEST_TOKEN is required for securities-import tests");
  return token;
}

function seqCloses(n: number, startClose = 100): ImportedCloseInput[] {
  const base = Date.UTC(2024, 0, 1);
  const out: ImportedCloseInput[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      date: new Date(base + i * 86_400_000).toISOString().slice(0, 10),
      close: startClose + i,
      volume: 1000 + i,
    });
  }
  return out;
}

function postPush(body: unknown, pushId?: string): Request {
  return new Request("http://localhost/api/admin/securities/import", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${securitiesImportTestToken()}`,
      "cf-connecting-ip": "203.0.113.84",
      ...(pushId ? { "x-push-id": pushId } : {}),
    },
    body: JSON.stringify(body),
  });
}

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-peer-push-receipt-${randomUUID()}.db`)}`;
  process.env.APP_B_INGEST_TOKEN = securitiesImportTestToken();
});

beforeEach(() => {
  resetRateLimiter();
  clearImportedSecuritiesForTests();
  getDb().prepare("DELETE FROM audit_events WHERE kind = 'peer_push_ack_missing'").run();
  getDb().prepare("DELETE FROM api_health_log WHERE service = 'congress-inbound-push'").run();
});

describe("peer push receipt health", () => {
  it("names a missing ack before a missing push id", () => {
    expect(peerPushHealth({ pushId: null, delivered: null, consumed: null })).toBe("missing-delivered-ack");
    expect(
      peerPushHealth({
        pushId: "push-1234",
        delivered: { at: "2026-10-15T00:00:00.000Z", ok: true },
        consumed: null,
      })
    ).toBe("missing-consumed-ack");
    expect(
      peerPushHealth({
        pushId: null,
        delivered: { at: "2026-10-15T00:00:00.000Z", ok: true },
        consumed: { at: "2026-10-15T00:00:00.000Z", ok: true },
      })
    ).toBe("missing-push-id");
    expect(resolvePeerPushId("  short  ", "push-from-body")).toBe("push-from-body");
    expect(resolvePeerPushId("header-id-1", "body-id-not-used")).toBe("header-id-1");
  });
});

describe("Congress.Trade push receipt end to end", () => {
  it("stores the push, returns delivered and consumed acks, and replays the same id without writing again", async () => {
    const pushId = "ct-push-aapl-2026-10-15";
    const first = await importRoute(
      postPush(
        {
          origin: "app-a",
          refs: [{ ticker: "AAPL", companyName: "Apple" }],
          prices: [{ ticker: "AAPL", closes: seqCloses(3) }],
          spx: seqCloses(1, 5000),
        },
        pushId
      )
    );
    expect(first.status).toBe(200);
    const created = SecuritiesImportResponseSchema.parse(await first.json());
    expect(created).toMatchObject({
      ok: true,
      pushId,
      health: "ok",
      refs: 1,
      pricedTickers: 1,
      priceRows: 3,
      spxRows: 1,
      acks: {
        delivered: { ok: true },
        consumed: { ok: true },
      },
    });
    expect(created.acks?.delivered?.at).toEqual(created.acks?.consumed?.at);
    expect(getImportedPriceCloses("AAPL")).toHaveLength(3);

    const replay = await importRoute(
      postPush(
        {
          origin: "app-a",
          prices: [{ ticker: "MSFT", closes: seqCloses(2, 400) }],
        },
        pushId
      )
    );
    expect(replay.status).toBe(200);
    const again = SecuritiesImportResponseSchema.parse(await replay.json());
    expect(again).toMatchObject({
      ok: true,
      pushId,
      health: "ok",
      replayed: true,
      refs: 1,
      pricedTickers: 1,
      priceRows: 3,
    });
    expect(getImportedPriceCloses("AAPL")).toHaveLength(3);
    expect(getImportedPriceCloses("MSFT")).toHaveLength(0);

    const snapshot = buildOpsSnapshot({ runsPerUser: 1, auditPerUser: 1 });
    expect(snapshot.congressInboundPush).toMatchObject({
      pushId,
      health: "ok",
      deliveredAt: created.acks?.delivered?.at,
      consumedAt: created.acks?.consumed?.at,
    });
  });

  it("alerts when the push id is missing and still records both acks", async () => {
    const res = await importRoute(
      postPush({
        origin: "app-a",
        prices: [{ ticker: "F", closes: seqCloses(2) }],
      })
    );
    expect(res.status).toBe(200);
    const json = SecuritiesImportResponseSchema.parse(await res.json());
    expect(json.health).toBe("missing-push-id");
    expect(json.pushId).toBeNull();
    expect(json.acks?.delivered?.ok).toBe(true);
    expect(json.acks?.consumed?.ok).toBe(true);
    expect(getImportedPriceCloses("F")).toHaveLength(2);

    const audit = getDb()
      .prepare("SELECT payload FROM audit_events WHERE kind = 'peer_push_ack_missing' ORDER BY rowid DESC LIMIT 1")
      .get() as { payload: string } | undefined;
    expect(JSON.parse(audit?.payload ?? "{}")).toMatchObject({ health: "missing-push-id", pushId: null });

    const health = getDb()
      .prepare(
        "SELECT ok, error_text FROM api_health_log WHERE service = 'congress-inbound-push' ORDER BY rowid DESC LIMIT 1"
      )
      .get() as { ok: number; error_text: string | null } | undefined;
    expect(health?.ok).toBe(0);
    expect(health?.error_text).toContain("missing-push-id");

    const snapshot = buildOpsSnapshot({ runsPerUser: 1, auditPerUser: 1 });
    expect(snapshot.congressInboundPush?.health).toBe("missing-push-id");
    expect(snapshot.congressInboundPush?.pushId).toBeNull();
  });
});
