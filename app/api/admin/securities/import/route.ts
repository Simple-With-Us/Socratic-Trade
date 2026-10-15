import { NextResponse } from "next/server";
import type { PriceClose, PriceSeries, SecurityRefInput } from "@jaywedgeworth22/congress-trading-shared";
import { audit } from "@/lib/db";
import { alertPeerPushReceiptGap, logApiHealth } from "@/lib/db-health";
import {
  getImportedCacheCounts,
  importedPushIsReadable,
  getPeerPushReceipt,
  persistSecuritiesImport,
  savePeerPushReceipt,
  type ImportedCloseInput,
  type ImportedPriceInput,
  type ImportedRefInput
} from "@/lib/db-securities-import";
import { verifySecuritiesImportToken } from "@/lib/securities-import-auth";
import { APP_B_ORIGIN } from "@/lib/congress-share";
import {
  PayloadTooLargeError,
  readJsonWithLimit,
  SECURITIES_IMPORT_MAX_BYTES
} from "@/lib/bounded-body";
import { enforceRateLimit, RATE_LIMITS, trustedCloudflareClientIp } from "@/lib/rate-limit";
import { SecuritiesImportPayloadSchema } from "@/lib/securities-import-schema";
import {
  PEER_PUSH_ID_HEADER,
  peerPushHealth,
  resolvePeerPushId,
  type PeerPushAck,
  type PeerPushHealth
} from "@/lib/peer-push-receipt";

export const dynamic = "force-dynamic";

// Inbound securities-import receiver for the congress.trade (App A) return-path (App B side).
//
// App A independently fetches price/spx/ref data; this endpoint lets it push those gap-fills back to
// us so they warm App B's local EOD cache and displace a re-fetch (see the optional cache-aside tier
// in fetchDailyOHLC). Symmetric with the body App B already POSTs to App A's import endpoint.
//
// Auth: bearer APP_B_INGEST_TOKEN, constant-time. DEFAULT-CLOSED — with no token configured every
// write is rejected. No-echo guard: a payload tagged with App B's own origin is acked but NOT stored
// (so a round-trip of our own outbound push is a no-op).
//
// Receipt: the caller sends `x-push-id`.  A first delivery persists the cache and stores
// delivered + consumed acks under that id.  A retry of an ok receipt returns that body
// and does not write again.  A non-ok receipt is not sticky: the same id is processed
// again and can replace it.  `health` is `ok` only when the id and both acks are
// present.  A missing id or ack is audited, written to the congress-inbound-push
// health lane, and paged immediately (the lane's 5-streak alerter is not the page).
//
// DIRECTIONAL ASYMMETRY (why only 3 of the 7 shared SharePayload slots are persisted here — by design;
// see docs/congress-trade-consume.md §4 and docs/congress-trade-share.md):
//   - refs / prices / spx  -> PERSISTED (imported_securities_ref / imported_price_eod / imported_spx_eod).
//     These are App A -> App B gap-fills that warm App B's local EOD cache.
//   - insider / shortVolume -> App B is the AUTHORITATIVE source (it computes these from SEC/FINRA and
//     pushes them TO App A); App A never echoes better values back, so there is nothing to store here.
//   - fundamentals / analyst -> App B reads these from App A on demand via the PULL enrichment tier
//     (CongressTradeEnrichmentProvider, 6h cache), not this import path.
//   - trades -> congressional events.  This cache is market data, so trades are acknowledged and not stored.
// Any of the non-persisted datasets that DO arrive are ACKNOWLEDGED in the response
// (`acceptedNotPersisted`) rather than silently dropped, so a future contract change surfaces instead
// of losing data quietly.
//
// Body (all optional): { pushId?, refs?, prices?, spx?, insider?, shortVolume?, fundamentals?, analyst?, trades?, origin? }
export async function POST(req: Request) {
  const clientIp = trustedCloudflareClientIp(req);
  if (!clientIp) {
    return NextResponse.json({ ok: false, error: "missing or invalid client ip" }, { status: 400 });
  }

  if (!verifySecuritiesImportToken(req)) {
    const unauthLimited = enforceRateLimit(
      clientIp,
      "admin/securities/import:unauth",
      RATE_LIMITS.securitiesImportUnauth
    );
    if (unauthLimited) return unauthLimited;
    audit("securities_import_rejected", { reason: "token" });
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const limited = enforceRateLimit(
    clientIp,
    "admin/securities/import",
    RATE_LIMITS.securitiesImport
  );
  if (limited) return limited;

  let rawBody: unknown;
  try {
    rawBody = await readJsonWithLimit(req, SECURITIES_IMPORT_MAX_BYTES);
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      return NextResponse.json({ ok: false, error: "payload too large" }, { status: 413 });
    }
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }

  const parsed = SecuritiesImportPayloadSchema.safeParse(rawBody);
  if (!parsed.success) {
    audit("securities_import_rejected", { reason: "invalid_payload" });
    return NextResponse.json({ ok: false, error: "invalid payload" }, { status: 400 });
  }
  const body = parsed.data;
  const pushId = resolvePeerPushId(req.headers.get(PEER_PUSH_ID_HEADER), body.pushId);

  if (pushId) {
    const prior = getPeerPushReceipt(pushId);
    // Only a complete receipt is idempotent.  A missing ack or a stored 500 must
    // be processed again so a transient miss can become ok.  The push id is the
    // idempotency key: a different body under an ok id returns the first receipt.
    if (prior?.health === "ok") {
      return NextResponse.json({ ...prior.body, replayed: true });
    }
  }

  const schemaVersion = body.schemaVersion;
  if (schemaVersion !== undefined) {
    console.info(`[securities-import] inbound payload schemaVersion=${String(schemaVersion)}`);
  }

  const at = new Date().toISOString();
  const delivered: PeerPushAck = { at, ok: true };

  // No-echo guard: never re-store rows we originated.  The skip is a complete
  // receipt: delivered and consumed, with nothing written.
  const origin = body.origin?.trim() ? body.origin.trim() : "app-a";
  if (origin === APP_B_ORIGIN) {
    return finishPeerPush({
      pushId,
      at,
      delivered,
      consumed: { at, ok: true, reason: "own-origin" },
      status: 200,
      store: true,
      body: {
        ok: true,
        skipped: true,
        reason: "own-origin",
        refs: 0,
        pricedTickers: 0,
        priceRows: 0,
        spxRows: 0,
        ...(schemaVersion !== undefined ? { schemaVersion } : {})
      }
    });
  }

  try {
    const refs = mapRefs(body.refs);
    const prices = mapPrices(body.prices);
    const spx = mapCloses(body.spx);

    const acceptedNotPersisted: Record<string, number> = {};
    for (const key of ["insider", "shortVolume", "fundamentals", "analyst", "trades"] as const) {
      const arr = body[key];
      if (arr && arr.length > 0) acceptedNotPersisted[key] = arr.length;
    }

    const result = persistSecuritiesImport({ refs, prices, spx }, origin);
    const persistableCount = (refs?.length ?? 0) + (prices?.length ?? 0) + (spx?.length ?? 0);
    const readable = importedPushIsReadable({ refs, prices, spx });
    let consumedReason: string | undefined;
    if (persistableCount === 0) {
      consumedReason = Object.keys(acceptedNotPersisted).length > 0 ? "accepted-not-persisted" : "empty";
    }
    const consumed: PeerPushAck | null = readable
      ? { at, ok: true, ...(consumedReason ? { reason: consumedReason } : {}) }
      : null;
    audit("securities_import", { origin, ...result, acceptedNotPersisted, pushId });
    return finishPeerPush({
      pushId,
      at,
      delivered,
      consumed,
      status: 200,
      store: true,
      body: {
        ok: true,
        origin,
        ...result,
        totals: getImportedCacheCounts(),
        ...(schemaVersion !== undefined ? { schemaVersion } : {}),
        ...(Object.keys(acceptedNotPersisted).length > 0
          ? {
              acceptedNotPersisted,
              note: "insider/shortVolume are App-B-authoritative; fundamentals/analyst are pulled on demand; trades are not a market-data cache — not persisted on the inbound import path by design",
            }
          : {}),
      }
    });
  } catch (error) {
    audit("securities_import_error", { error: error instanceof Error ? error.message : "unknown", pushId });
    return finishPeerPush({
      pushId,
      at,
      delivered: null,
      consumed: null,
      status: 500,
      // Store the failure so the ops snapshot shows it, but do not treat it as
      // an ok receipt.  savePeerPushReceipt replaces a non-ok row on retry.
      store: true,
      body: { ok: false, error: "ingest failed" }
    });
  }
}

async function finishPeerPush(input: {
  pushId: string | null;
  at: string;
  delivered: PeerPushAck | null;
  consumed: PeerPushAck | null;
  status: number;
  store: boolean;
  body: Record<string, unknown>;
}): Promise<NextResponse> {
  const health: PeerPushHealth = peerPushHealth({
    pushId: input.pushId,
    delivered: input.delivered,
    consumed: input.consumed,
  });
  const receipt: Record<string, unknown> = {
    ...input.body,
    pushId: input.pushId,
    health,
    acks: { delivered: input.delivered, consumed: input.consumed },
  };
  if (input.store) {
    const key = input.pushId ?? `missing:${input.at}`;
    savePeerPushReceipt({
      pushId: key,
      receivedAt: input.at,
      health,
      deliveredAt: input.delivered?.at ?? null,
      consumedAt: input.consumed?.at ?? null,
      body: receipt,
    });
  }
  await notePeerPushHealth(health, input.pushId);
  return NextResponse.json(receipt, { status: input.status });
}

async function notePeerPushHealth(health: PeerPushHealth, pushId: string | null): Promise<void> {
  if (health === "ok") {
    logApiHealth({ service: "congress-inbound-push", ok: true, keySource: "env" });
    return;
  }
  const errorText = pushId
    ? `peer push receipt ${health} pushId=${pushId}`
    : `peer push receipt ${health}`;
  audit("peer_push_ack_missing", { health, pushId });
  logApiHealth({ service: "congress-inbound-push", ok: false, errorText, keySource: "env" });
  await alertPeerPushReceiptGap(health, pushId);
}

function nullableStr(value: string | null | undefined): string | undefined {
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed : undefined;
}

function mapRefs(rows: SecurityRefInput[] | undefined): ImportedRefInput[] | undefined {
  if (!rows?.length) return undefined;
  return rows.map((r) => ({
    ticker: r.ticker,
    companyName: nullableStr(r.companyName),
    sector: nullableStr(r.sector),
    industry: nullableStr(r.industry),
    assetClass: nullableStr(r.assetClass),
    exchange: nullableStr(r.exchange) ?? nullableStr(r.exchangeShort),
    currency: nullableStr(r.currency),
    marketCap: r.marketCap ?? undefined,
    cik: nullableStr(r.cik),
  }));
}

function mapCloses(rows: PriceClose[] | undefined): ImportedCloseInput[] | undefined {
  if (!rows?.length) return undefined;
  return rows.map((c) => ({
    date: c.date,
    close: c.close,
    volume: c.volume ?? undefined,
  }));
}

function mapPrices(rows: PriceSeries[] | undefined): ImportedPriceInput[] | undefined {
  if (!rows?.length) return undefined;
  return rows.map((p) => ({
    ticker: p.ticker,
    closes: mapCloses(p.closes) ?? [],
  }));
}
