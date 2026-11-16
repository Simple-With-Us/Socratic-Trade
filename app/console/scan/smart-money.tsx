"use client";

/** Smart Money — the full scraped congressional-trade and insider (Form 4)
 *  datasets from the snapshot (`snapshot.smartMoney`), with feed metadata from
 *  `snapshot.webSources`. The scan table's Congress column only shows symbols
 *  overlapping the scan; this shows everything recently disclosed. Source
 *  labels are derived from the feeds' own recorded source keys — never
 *  hardcoded. */

import type { DashboardSnapshot } from "../../dashboard-types";
import { formatSourceList } from "@/lib/dashboard-ui";
import { Ago, Card, Chip, Empty } from "../ui/primitives";
import { SymbolButton } from "../ui/symbol-drilldown";

type SmartMoney = NonNullable<DashboardSnapshot["smartMoney"]>;
type CongressTrade = SmartMoney["congress"][number];
type InsiderFiling = SmartMoney["insider"][number];
type FeedMeta = NonNullable<DashboardSnapshot["webSources"]>["congress"];

const compactUsd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 0
});

// Owner copy rule (docs/FLEET-UI-COPY.md "Money"): compact suffixes are
// lowercase ($1.2m, not $1.2M) — Intl always emits uppercase K/M/B/T.
function fmtCompactUsd(v: number): string {
  return compactUsd.format(v).toLowerCase();
}

/** Congressional disclosures report a size BAND, not an exact amount. */
function amountBand(low?: number, high?: number): string | undefined {
  const hasLow = typeof low === "number" && Number.isFinite(low);
  const hasHigh = typeof high === "number" && Number.isFinite(high);
  if (hasLow && hasHigh) return low === high ? fmtCompactUsd(low!) : `${fmtCompactUsd(low!)}–${fmtCompactUsd(high!)}`;
  if (hasLow) return `${fmtCompactUsd(low!)}+`;
  if (hasHigh) return `up to ${fmtCompactUsd(high!)}`;
  return undefined;
}

/** Disclosure dates are usually date-only ISO strings; format them in UTC so
 *  US timezones don't render the previous day. */
function fmtDiscDate(iso: string): string {
  const dateOnly = iso.length <= 10;
  const t = new Date(dateOnly ? `${iso}T00:00:00Z` : iso);
  if (!Number.isFinite(t.getTime())) return iso;
  return t.toLocaleDateString("en-US", {
    ...(dateOnly ? { timeZone: "UTC" as const } : {}),
    month: "short",
    day: "numeric",
    year: "numeric"
  });
}

/** Counts + pretty source list derived from the feed's own recorded source
 *  keys. The snapshot deliberately caps these lists (newest first) while
 *  `recordCount` reports the FULL cached feed — when they differ, say so
 *  honestly ("latest 12 of 47 on file") instead of silently truncating. */
function feedSubtitle(meta: FeedMeta | undefined, shownCount: number, fallback: string): string {
  if (!meta) return fallback;
  const sources = formatSourceList(meta.sources.join("+"));
  const counts =
    shownCount > 0 && meta.recordCount > shownCount
      ? `latest ${shownCount} of ${meta.recordCount} on file`
      : `${meta.recordCount} on file`;
  return `${counts}${sources ? ` · ${sources}` : ""}`;
}

function FeedFreshness({ meta }: { meta: FeedMeta | undefined }) {
  if (!meta) return null;
  return (
    <span
      className="whitespace-nowrap text-[length:var(--con-fs-xs)] font-normal normal-case tracking-normal text-[color:var(--con-faint)]"
      title="When this feed was last refreshed from its sources.  It updates automatically in the background."
    >
      updated <Ago iso={meta.fetchedAt} />
    </span>
  );
}

function CongressRow({ t }: { t: CongressTrade }) {
  const band = amountBand(t.amountLow, t.amountHigh);
  const buy = t.side === "buy";
  return (
    <div className="con-row flex items-center gap-2 rounded-control px-2 py-1.5 text-[length:var(--con-fs-sm)]">
      <Chip tone={buy ? "pos" : "neg"} title={`A disclosed ${buy ? "purchase" : "sale"} by a member of Congress.`}>
        {buy ? "BUY" : "SELL"}
      </Chip>
      <SymbolButton symbol={t.symbol} />
      <span className="min-w-0 truncate text-[color:var(--con-muted)]" title={`${t.member} (${t.chamber})`}>
        {t.member}
      </span>
      {band && (
        <span
          className="con-num hidden whitespace-nowrap text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)] sm:inline"
          title="Disclosed transaction size band — Congress reports ranges, not exact amounts."
        >
          {band}
        </span>
      )}
      <span
        className="ml-auto cursor-default whitespace-nowrap text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]"
        title={`Traded ${fmtDiscDate(t.tradedAt)}${t.disclosedAt ? ` · disclosed ${fmtDiscDate(t.disclosedAt)}` : ""}`}
      >
        {fmtDiscDate(t.tradedAt)}
      </span>
    </div>
  );
}

function InsiderRow({ f }: { f: InsiderFiling }) {
  const net = f.buyTx - f.sellTx;
  const tone = net > 0 ? "pos" : net < 0 ? "neg" : "muted";
  const word = net > 0 ? "BUY" : net < 0 ? "SELL" : "MIXED";
  return (
    <div className="con-row flex items-center gap-2 rounded-control px-2 py-1.5 text-[length:var(--con-fs-sm)]">
      <Chip tone={tone} title={`Net open-market direction across this insider's recent Form 4 filings: ${f.buyTx} buy / ${f.sellTx} sell transactions.`}>
        {word}
      </Chip>
      <SymbolButton symbol={f.symbol} />
      <span className="min-w-0 truncate text-[color:var(--con-muted)]" title={f.owner}>
        {f.owner}
      </span>
      <span
        className="con-num hidden whitespace-nowrap text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)] sm:inline"
        title={`${f.buyTx} open-market buy transaction${f.buyTx === 1 ? "" : "s"} and ${f.sellTx} sell${f.sellTx === 1 ? "" : "s"} reported.`}
      >
        {f.buyTx}B / {f.sellTx}S
      </span>
      <span
        className="ml-auto cursor-default whitespace-nowrap text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]"
        title={`Form 4 filed ${fmtDiscDate(f.filedAt)}`}
      >
        {fmtDiscDate(f.filedAt)}
      </span>
    </div>
  );
}

export function SmartMoneySection({ snapshot }: { snapshot: DashboardSnapshot }) {
  // The snapshot caps congress rows by DISCLOSURE date (src/lib/dashboard.ts
  // sorts by disclosedAt, falling back to tradedAt, before its 12-row slice).
  // Keep this defensive client re-sort with the same key so the card's order
  // never depends on the wire order of the snapshot array.
  const congress = [...(snapshot.smartMoney?.congress ?? [])].sort((a, b) =>
    (b.disclosedAt ?? b.tradedAt ?? "").localeCompare(a.disclosedAt ?? a.tradedAt ?? "")
  );
  const insider = snapshot.smartMoney?.insider ?? [];
  const thirteenF = snapshot.smartMoney?.thirteenF ?? [];
  const ark = snapshot.smartMoney?.ark ?? [];
  const ws = snapshot.webSources;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card
        title={
          <span
            className="flex items-center gap-2"
            title="Recent stock trades disclosed by members of Congress, most recently disclosed first (trade date shown on each row)."
          >
            Congressional trades
            <FeedFreshness meta={ws?.congress} />
          </span>
        }
        action={
          <span
            className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]"
            title={
              ws?.congress
                ? `Feed sources (raw): ${ws.congress.sources.join("+") || "none recorded"}.${
                    ws.congress.recordCount > congress.length && congress.length > 0
                      ? ` The console shows the ${congress.length} most recent disclosures; the full ${ws.congress.recordCount}-record feed stays cached server-side.`
                      : ""
                  }`
                : "Feed status isn't available yet."
            }
          >
            {feedSubtitle(ws?.congress, congress.length, "Congressional trade feeds")}
          </span>
        }
        padded={false}
      >
        {congress.length === 0 ? (
          <Empty>
            No congressional disclosures cached yet.  The feed refreshes automatically in the background — check back after
            the next refresh.
          </Empty>
        ) : (
          <div className="flex flex-col px-2 pb-3 pt-1">
            {congress.map((t, i) => (
              <CongressRow key={`${t.symbol}-${t.member}-${t.tradedAt}-${i}`} t={t} />
            ))}
          </div>
        )}
      </Card>

      <Card
        title={
          <span
            className="flex items-center gap-2"
            title="Recent open-market insider buys/sells from SEC Form 4 filings, newest first."
          >
            Insider (Form 4) activity
            <FeedFreshness meta={ws?.insider} />
          </span>
        }
        action={
          <span
            className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]"
            title={
              ws?.insider
                ? `Feed sources (raw): ${ws.insider.sources.join("+") || "none recorded"}.${
                    ws.insider.recordCount > insider.length && insider.length > 0
                      ? ` The console shows the ${insider.length} most recent filings; the full ${ws.insider.recordCount}-record feed stays cached server-side.`
                      : ""
                  }`
                : "Feed status isn't available yet."
            }
          >
            {feedSubtitle(ws?.insider, insider.length, "Open-market insider filings")}
          </span>
        }
        padded={false}
      >
        {insider.length === 0 ? (
          <Empty>No insider filings cached yet.  Open-market Form 4 buys and sells accumulate here as they're filed.</Empty>
        ) : (
          <div className="flex flex-col px-2 pb-3 pt-1">
            {insider.map((f, i) => (
              <InsiderRow key={`${f.symbol}-${f.owner}-${f.filedAt}-${i}`} f={f} />
            ))}
          </div>
        )}
      </Card>

      <Card
        title={
          <span className="flex items-center gap-2" title="Latest 13F-HR holdings from a curated set of official SEC filers.  Observe only — the app does not auto-copy these books.">
            13F Superinvestors
            <FeedFreshness meta={ws?.thirteenF} />
          </span>
        }
        action={
          <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
            {feedSubtitle(ws?.thirteenF, thirteenF.length, "SEC 13F-HR holdings")}
          </span>
        }
        padded={false}
      >
        {thirteenF.length === 0 ? (
          <Empty>No 13F holdings cached yet.  The weekly SEC pull fills this after the next refresh.</Empty>
        ) : (
          <div className="flex flex-col px-2 pb-3 pt-1">
            {thirteenF.map((r, i) => (
              <div key={`${r.ticker}-${r.filerName}-${r.periodEnd}-${i}`} className="con-row flex items-center gap-2 rounded-control px-2 py-1.5 text-[length:var(--con-fs-sm)]">
                <SymbolButton symbol={r.ticker} />
                <span className="min-w-0 truncate text-[color:var(--con-muted)]">{r.filerName}</span>
                <span className="con-num hidden whitespace-nowrap text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)] sm:inline">
                  {r.shares.toLocaleString()} sh
                </span>
                <span className="ml-auto whitespace-nowrap text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">{r.periodEnd}</span>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card
        title={
          <span className="flex items-center gap-2" title="Official ARK ETF daily holdings CSVs.  Observe only.">
            ARK Holdings
            <FeedFreshness meta={ws?.ark} />
          </span>
        }
        action={
          <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
            {feedSubtitle(ws?.ark, ark.length, "ARK official CSVs")}
          </span>
        }
        padded={false}
      >
        {ark.length === 0 ? (
          <Empty>No ARK holdings cached yet.  The daily official CSV pull fills this after the next refresh.</Empty>
        ) : (
          <div className="flex flex-col px-2 pb-3 pt-1">
            {ark.map((r, i) => (
              <div key={`${r.fund}-${r.ticker}-${r.asOf}-${i}`} className="con-row flex items-center gap-2 rounded-control px-2 py-1.5 text-[length:var(--con-fs-sm)]">
                <Chip tone="info">{r.fund}</Chip>
                <SymbolButton symbol={r.ticker} />
                <span className="con-num hidden whitespace-nowrap text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)] sm:inline">
                  {r.weightPct.toFixed(2)}%
                </span>
                <span className="ml-auto whitespace-nowrap text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">{r.asOf}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
