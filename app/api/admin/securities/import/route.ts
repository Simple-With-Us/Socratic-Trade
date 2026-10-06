import { NextResponse } from "next/server";
import type { PriceClose, PriceSeries, SecurityRefInput } from "@jaywedgeworth22/congress-trading-shared";
import { audit } from "@/lib/db";
import {
  getImportedCacheCounts,
  persistSecuritiesImport,
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
// DIRECTIONAL ASYMMETRY (why only 3 of the 7 shared SharePayload slots are persisted here — by design;
// see docs/congress-trade-consume.md §4 and docs/congress-trade-share.md):
//   - refs / prices / spx  -> PERSISTED (imported_securities_ref / imported_price_eod / imported_spx_eod).
//     These are App A -> App B gap-fills that warm App B's local EOD cache.
//   - insider / shortVolume -> App B is the AUTHORITATIVE source (it computes these from SEC/FINRA and
//     pushes them TO App A); App A never echoes better values back, so there is nothing to store here.
//   - fundamentals / analyst -> App B reads these from App A on demand via the PULL enrichment tier
//     (CongressTradeEnrichmentProvider, 6h cache), not this import path.
// Any of the four non-persisted datasets that DO arrive are ACKNOWLEDGED in the response
// (`acceptedNotPersisted`) rather than silently dropped, so a future contract change surfaces instead
// of losing data quietly.
//
// Body (all optional): { refs?, prices?, spx?, insider?, shortVolume?, fundamentals?, analyst?, origin? }
// — the same shape as App B's outbound push (only refs/prices/spx are stored inbound).
export async function POST(req: Request) {
  if (!verifySecuritiesImportToken(req)) {
    const unauthLimited = enforceRateLimit(
      trustedCloudflareClientIp(req),
      "admin/securities/import:unauth",
      RATE_LIMITS.securitiesImportUnauth
    );
    if (unauthLimited) return unauthLimited;
    audit("securities_import_rejected", { reason: "token" });
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const limited = enforceRateLimit(
    trustedCloudflareClientIp(req),
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

  const schemaVersion = body.schemaVersion;
  if (schemaVersion !== undefined) {
    console.info(`[securities-import] inbound payload schemaVersion=${String(schemaVersion)}`);
  }

  // No-echo guard: never re-store rows we originated.
  const origin = body.origin?.trim() ? body.origin.trim() : "app-a";
  if (origin === APP_B_ORIGIN) {
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: "own-origin",
      refs: 0,
      pricedTickers: 0,
      priceRows: 0,
      spxRows: 0,
      ...(schemaVersion !== undefined ? { schemaVersion } : {})
    });
  }

  try {
    const refs = mapRefs(body.refs);
    const prices = mapPrices(body.prices);
    const spx = mapCloses(body.spx);

    const acceptedNotPersisted: Record<string, number> = {};
    for (const key of ["insider", "shortVolume", "fundamentals", "analyst"] as const) {
      const arr = body[key];
      if (arr && arr.length > 0) acceptedNotPersisted[key] = arr.length;
    }

    const result = persistSecuritiesImport({ refs, prices, spx }, origin);
    audit("securities_import", { origin, ...result, acceptedNotPersisted });
    return NextResponse.json({
      ok: true,
      origin,
      ...result,
      totals: getImportedCacheCounts(),
      ...(schemaVersion !== undefined ? { schemaVersion } : {}),
      ...(Object.keys(acceptedNotPersisted).length > 0
        ? {
            acceptedNotPersisted,
            note: "insider/shortVolume are App-B-authoritative; fundamentals/analyst are pulled on demand — not persisted on the inbound import path by design",
          }
        : {}),
    });
  } catch (error) {
    audit("securities_import_error", { error: error instanceof Error ? error.message : "unknown" });
    return NextResponse.json({ ok: false, error: "ingest failed" }, { status: 500 });
  }
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
