"use client";

/** Orders — working orders at the broker for the active account, with
 *  stale-limit detection (the SERVER's rule, mirrored exactly: a limit or
 *  stop-limit order still working with an unfilled remainder after the
 *  policy's stale threshold), a replace-at-market flow against
 *  POST /api/orders/replace-market, cancel against POST /api/orders/cancel,
 *  and a short history of finished orders. Everything renders only what the
 *  snapshot actually has — missing data is "—", never invented. */

import { useEffect, useMemo, useState } from "react";
import type { EquityOrder } from "@/lib/types";
import { deriveReality } from "../lib/derive";
import { fmtExact, fmtMoney, fmtPct, fmtQty, EM_DASH } from "../lib/format";
import { useConsoleData } from "../lib/useConsoleData";
import { Ago, Btn, Card, Chip, Dash, Empty, InfoTip, Tooltip, TooltipText, type ChipTone } from "../ui/primitives";
import { SymbolButton } from "../ui/symbol-drilldown";
import { CancelOrderSheet } from "./cancel-sheet";
import { ReplaceMarketSheet } from "./replace-market-sheet";
import {
  deriveOpenOrders,
  fmtMinutes,
  isReplaceableType,
  lastScanPrice,
  orderTypeLabel,
  readableState,
  staleThresholdMinutes,
  terminalOrders,
  type OpenOrderRow
} from "./lib";

const SIDE_LABEL: Record<string, string> = { buy: "BUY", sell: "SELL", short: "SHORT", cover: "COVER" };

const SIDE_TITLE: Record<string, string> = {
  buy: "Buy — opens or adds to a long position.",
  sell: "Sell — closes some or all of a long position.",
  short: "Short — sells borrowed shares to open a short position.",
  cover: "Cover — buys back borrowed shares to close a short position."
};

const TYPE_TITLE: Record<string, string> = {
  market: "Market — executes at whatever price the market gives; no price cap.",
  limit: "Limit — executes only at the limit price or better; may sit unfilled if the market moves away.",
  stop_market: "Stop — becomes a market order once the stop price trades.",
  stop_limit: "Stop-limit — becomes a limit order once the stop price trades; may sit unfilled after triggering."
};

const TIF_TITLE: Record<string, string> = {
  gtc: "Good-til-cancelled — rests until it fills or is cancelled.",
  gfd: "Good-for-day — expires at the end of the trading day if unfilled.",
  day: "Day order — expires at the end of the trading day if unfilled.",
  ioc: "Immediate-or-cancel — fills what it can immediately, cancels the rest.",
  fok: "Fill-or-kill — fills completely and immediately, or cancels.",
  opg: "At-the-open — executes in the opening auction only.",
  cls: "At-the-close — executes in the closing auction only."
};

function tifLabel(timeInForce: string | undefined): string | null {
  const tif = String(timeInForce ?? "").trim();
  return tif ? tif.toUpperCase() : null;
}

function tifTitle(timeInForce: string | undefined): string {
  return TIF_TITLE[String(timeInForce ?? "").trim().toLowerCase()] ?? "Time-in-force reported by the broker.";
}

function finiteNum(v: number | undefined): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

const STATE_TONE: Record<string, ChipTone> = {
  filled: "pos",
  partially_filled: "accent",
  new: "accent",
  open: "accent",
  accepted: "accent",
  confirmed: "accent",
  queued: "accent",
  submitted: "accent",
  unconfirmed: "accent",
  pending_new: "accent",
  held: "warn",
  suspended: "warn",
  pending_cancel: "warn",
  pending_replace: "warn",
  done_for_day: "warn",
  stopped: "warn",
  calculated: "warn",
  cancelled: "muted",
  canceled: "muted",
  expired: "muted",
  replaced: "muted",
  rejected: "neg",
  failed: "neg"
};

function stateTone(state: string | undefined): ChipTone {
  return STATE_TONE[String(state ?? "").trim().toLowerCase()] ?? "muted";
}

function isExit(side: string): boolean {
  return side === "sell" || side === "cover";
}

/** "10 sh" / "~$500" / "—" — whichever the broker order actually carries. */
function sizeText(order: EquityOrder): string {
  if (typeof order.quantity === "number" && Number.isFinite(order.quantity)) return `${fmtQty(order.quantity)} sh`;
  if (typeof order.dollarAmount === "number" && Number.isFinite(order.dollarAmount))
    return `~${fmtMoney(order.dollarAmount)}`;
  return EM_DASH;
}

function HeaderLabel({ label, tip }: { label: string; tip: string }) {
  return (
    <span className="inline-flex items-center gap-1 align-middle">
      <span>{label}</span>
      <InfoTip label={label} content={tip} />
    </span>
  );
}

export default function OrdersPage() {
  const { snapshot, refresh } = useConsoleData();
  const [replaceRow, setReplaceRow] = useState<OpenOrderRow | null>(null);
  const [cancelRow, setCancelRow] = useState<OpenOrderRow | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Ages advance between the 15s snapshot polls.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(interval);
  }, []);

  const rows = useMemo(
    () => (snapshot ? deriveOpenOrders(snapshot.orders ?? [], snapshot.policy, new Date(nowMs)) : []),
    [snapshot, nowMs]
  );
  const history = useMemo(() => (snapshot ? terminalOrders(snapshot.orders ?? [], 20) : []), [snapshot]);

  if (!snapshot) return null;

  const reality = deriveReality(snapshot);
  const noAccount = reality.tone === "none";
  const live = reality.tone === "live";
  const halted = snapshot.policy.systemState === "halted";
  const thresholdMinutes = staleThresholdMinutes(snapshot.policy);
  const staleCount = rows.filter((r) => r.stale).length;
  const quotes = snapshot.latestStrategyRun?.marketScan?.quotesBySymbol;
  const multiAccount = snapshot.connectedAccounts.length > 1;
  const accountLabel =
    reality.account?.label ||
    (snapshot.policy.accountNumber ? `Account ·· ${snapshot.policy.accountNumber.slice(-4)}` : null);

  const doRefresh = async () => {
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-[length:var(--con-fs-lg)] font-bold">Orders</h1>
        <Tooltip content={reality.clarification}>
          <Chip tone={reality.tone}>
            {reality.word} · {reality.phrase}
          </Chip>
        </Tooltip>
        {accountLabel && (
          <Tooltip content="Orders are read from the broker for the active account only.">
            <Chip tone="muted">{accountLabel}</Chip>
          </Tooltip>
        )}
        <div className="flex-1" />
        <Tooltip content="Fetch the latest orders from the broker now. The console also refreshes automatically every 15 seconds.">
          <Btn size="sm" onClick={() => void doRefresh()} disabled={refreshing}>
            {refreshing ? "Refreshing…" : "Refresh"}
          </Btn>
        </Tooltip>
      </div>

      {multiAccount && (
        <p className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
          Showing the active account only — switch the account scope (top bar) to see another account&apos;s orders.
        </p>
      )}

      {staleCount > 0 && (
        <div className="rounded-lg border border-[color:var(--con-warn-border)] bg-[color:var(--con-warn-soft)] px-3 py-2 text-[length:var(--con-fs-sm)]">
          <span className="font-semibold text-[color:var(--con-warn)]">
            {staleCount} limit order{staleCount === 1 ? "" : "s"} working longer than {thresholdMinutes} minutes without
            filling.
          </span>{" "}
          <span className="text-[color:var(--con-muted)]">
            The market may have moved away from the limit price. Review each: keep waiting, cancel, or replace the
            remainder at market.
          </span>
          <InfoTip
            label="stale limit orders"
            content={`Your policy's stale threshold is ${thresholdMinutes} minutes (Settings -> "Stale limit alert").`}
            className="ml-2 align-middle"
          />
        </div>
      )}

      <Card title={`Open orders (${rows.length})`} padded={false}>
        {rows.length === 0 ? (
          <Empty>
            {noAccount
              ? "No working orders — connect a broker Paper or Live account first. Working orders appear once an account is active."
              : "No working orders at the broker. When you or the strategy place a limit or stop order, it appears here until it fills, expires, or is cancelled."}
          </Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="con-table">
              <thead>
                <tr>
                  <th><HeaderLabel label="Symbol" tip="Ticker — click a symbol to open its price history and details." /></th>
                  <th><HeaderLabel label="Side" tip="Order direction: buy, sell, short, or cover." /></th>
                  <th><HeaderLabel label="Type" tip="Order type. Limit and stop-limit orders can sit unfilled and go stale; market orders execute immediately." /></th>
                  <th className="num"><HeaderLabel label="Size" tip="Order size as the broker holds it: share quantity, or an approximate dollar amount for notional orders. Partial fills show how much already executed." /></th>
                  <th className="num"><HeaderLabel label="Limit / Stop" tip="Resting limit price and/or stop trigger price the broker holds for this order. '—' when the broker reported neither (e.g. a market order)." /></th>
                  <th className="num"><HeaderLabel label="Last price" tip="Latest price this app has for the symbol — from the most recent market scan, so it can be minutes old. '—' when the last scan didn't cover it. Where the order has a limit price, the gap between this price and the limit is shown underneath." /></th>
                  <th><HeaderLabel label="TIF" tip="Time-in-force: how long the order stays working. DAY/GFD expires at market close; GTC rests until cancelled." /></th>
                  <th><HeaderLabel label="Age" tip={thresholdMinutes > 0 ? `How long the order has been working. Limit/stop-limit orders older than your ${thresholdMinutes}-minute policy threshold with an unfilled remainder are flagged stale.` : "How long the order has been working. Stale-limit detection is disabled (policy stale threshold is 0)."} /></th>
                  <th><HeaderLabel label="Status" tip="The order's state as last reported by the broker." /></th>
                  <th>
                    <InfoTip label="Actions" content="Actions: replace a stale limit order's remainder at market, or cancel the order." />
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <OpenOrderTr
                    key={row.order.id}
                    row={row}
                    quotes={quotes}
                    companyName={snapshot.symbolMetaBySymbol?.[row.order.symbol]?.companyName}
                    halted={halted}
                    noAccount={noAccount}
                    live={live}
                    onReplace={() => setReplaceRow(row)}
                    onCancel={() => setCancelRow(row)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Recent finished orders" padded={false}>
        {history.length === 0 ? (
          <Empty>
            {noAccount
              ? "No broker order history — connect a broker account to see finished orders."
              : "No finished orders reported by the broker yet."}
          </Empty>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="con-table">
                <thead>
                  <tr>
                    <th><HeaderLabel label="Symbol" tip="Ticker — click a symbol to open its price history and details." /></th>
                    <th><HeaderLabel label="Side" tip="Order direction: buy, sell, short, or cover." /></th>
                    <th><HeaderLabel label="Type" tip="Order type as placed." /></th>
                    <th><HeaderLabel label="TIF" tip="Time-in-force as placed. DAY/GFD expires at market close; GTC rests until cancelled." /></th>
                    <th className="num"><HeaderLabel label="Size" tip="Order size: share quantity or approximate dollar amount." /></th>
                    <th className="num"><HeaderLabel label="Avg fill" tip="Average price the broker reports for the executed part; '—' when nothing executed." /></th>
                    <th><HeaderLabel label="Status" tip="Final state the broker reported." /></th>
                    <th><HeaderLabel label="Updated" tip="When the broker last updated the order." /></th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((order) => (
                    <tr key={order.id}>
                      <td>
                        <SymbolButton symbol={order.symbol} />
                      </td>
                      <td className={isExit(order.side) ? "font-semibold text-[color:var(--con-warn)]" : "font-semibold"}>
                        <TooltipText content={SIDE_TITLE[order.side] ?? "Order direction."}>
                          {SIDE_LABEL[order.side] ?? String(order.side).toUpperCase()}
                        </TooltipText>
                      </td>
                      <td><TooltipText content={TYPE_TITLE[String(order.type)] ?? "Order type."}>{orderTypeLabel(order.type)}</TooltipText></td>
                      <td><TooltipText content={tifTitle(order.timeInForce)}>{tifLabel(order.timeInForce) ?? <Dash />}</TooltipText></td>
                      <td className="num con-num"><TooltipText content="Order size as placed.">{sizeText(order)}</TooltipText></td>
                      <td className="num con-num"><TooltipText content="Average executed price reported by the broker.">
                        {typeof order.averagePrice === "number" && Number.isFinite(order.averagePrice) ? (
                          fmtMoney(order.averagePrice)
                        ) : (
                          <Dash />
                        )}
                      </TooltipText></td>
                      <td>
                        <Tooltip content="Final state the broker reported for this order.">
                          <Chip tone={stateTone(order.state)}>{readableState(order.state)}</Chip>
                        </Tooltip>
                      </td>
                      <td className="whitespace-nowrap text-[color:var(--con-faint)]">
                        <Ago iso={order.updatedAt ?? order.createdAt} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="px-4 py-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
              Latest {history.length} finished orders, straight from the broker&apos;s order list. The full story —
              fills, runs, and alerts — lives on the Activity screen.
            </p>
          </>
        )}
      </Card>

      {replaceRow && (
        <ReplaceMarketSheet row={replaceRow} reality={reality} open onClose={() => setReplaceRow(null)} />
      )}
      {cancelRow && <CancelOrderSheet row={cancelRow} reality={reality} open onClose={() => setCancelRow(null)} />}
    </div>
  );
}

function OpenOrderTr({
  row,
  quotes,
  companyName,
  halted,
  noAccount,
  live,
  onReplace,
  onCancel
}: {
  row: OpenOrderRow;
  quotes: Parameters<typeof lastScanPrice>[0];
  companyName?: string;
  halted: boolean;
  noAccount: boolean;
  live: boolean;
  onReplace: () => void;
  onCancel: () => void;
}) {
  const order = row.order;
  const scan = lastScanPrice(quotes, order.symbol);
  const limit = finiteNum(order.limitPrice);
  const stop = finiteNum(order.stopPrice);
  // Gap between the latest scan price and the resting limit — how far the market
  // sits from the order. Positive = market above the limit.
  const limitGapPct = limit !== undefined && limit > 0 && scan ? ((scan.price - limit) / limit) * 100 : undefined;
  const tif = tifLabel(order.timeInForce);
  const filled = order.filledQuantity ?? 0;
  const showReplace = isReplaceableType(order.type) && row.remaining > 0;
  const replaceEnabled = row.stale && !halted && !noAccount;
  const replaceTitle = !row.stale
    ? row.thresholdMinutes > 0
      ? `Becomes available once the order has been working ${row.thresholdMinutes} minutes without filling (your policy's stale threshold) — currently ${fmtMinutes(row.ageMinutes)}.`
      : "Stale-limit detection is disabled (policy stale threshold is 0), so the server refuses market replacements."
    : halted
      ? "Start the system first — replacing places a NEW order, which the server refuses while everything is stopped. Cancelling stays available."
      : noAccount
        ? "Market replacement needs a broker-backed Paper or Live account; no account is connected."
        : `Cancel this stale ${orderTypeLabel(order.type)} order and submit the remaining ${fmtQty(row.remaining)} shares as a market order${live ? " — typed broker confirmation required" : ""}.`;

  return (
    <tr className={row.stale ? "bg-[color:var(--con-warn-soft)]" : undefined}>
      <td>
        <SymbolButton symbol={order.symbol} />
        {companyName && (
          <span className="block max-w-44 truncate pl-[26px] text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
            {companyName}
          </span>
        )}
      </td>
      <td className={isExit(order.side) ? "font-semibold text-[color:var(--con-warn)]" : "font-semibold"}>
        <TooltipText content={SIDE_TITLE[order.side] ?? "Order direction."}>{SIDE_LABEL[order.side] ?? String(order.side).toUpperCase()}</TooltipText>
      </td>
      <td><TooltipText content={TYPE_TITLE[String(order.type)] ?? "Order type."}>{orderTypeLabel(order.type)}</TooltipText></td>
      <td className="num con-num">
        <TooltipText content="Order size as the broker holds it; partial fills shown underneath." block className="justify-between">
          <span>{sizeText(order)}</span>
          {filled > 0 && row.remaining > 0 && (
            <span className="block text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
              {fmtQty(filled)} filled · {fmtQty(row.remaining)} left
            </span>
          )}
        </TooltipText>
      </td>
      <td className="num con-num">
        <TooltipText
          block
          content={
          limit !== undefined && stop !== undefined
            ? `Stop-limit: triggers at the ${fmtMoney(stop)} stop, then rests as a ${fmtMoney(limit)} limit.`
            : limit !== undefined
              ? "The limit price this order rests at, as the broker holds it."
              : stop !== undefined
                ? "The stop trigger price, as the broker holds it."
                : "The broker reported no limit or stop price for this order."
          }
          className="justify-between"
        >
        {limit === undefined && stop === undefined ? (
          <Dash />
        ) : (
          <>
            {fmtMoney(limit ?? stop)}
            {limit !== undefined && stop !== undefined && (
              <span className="block text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                stop {fmtMoney(stop)}
              </span>
            )}
          </>
        )}
        </TooltipText>
      </td>
      <td className="num con-num">
        <TooltipText
          block
          content={
          scan
            ? `From the latest market scan${scan.provider ? ` (${scan.provider})` : ""}${scan.asOf ? `, as of ${fmtExact(scan.asOf)}` : ""} — not a live broker quote.`
            : "The latest market scan didn't cover this symbol, so no recent price is available here."
          }
          className="justify-between"
        >
        {scan ? fmtMoney(scan.price) : <Dash />}
        {limitGapPct !== undefined && (
          <span className="block text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
            {fmtPct(limitGapPct, 1, true)} vs limit
          </span>
        )}
        </TooltipText>
      </td>
      <td><TooltipText content={tifTitle(order.timeInForce)}>{tif ?? <Dash />}</TooltipText></td>
      <td className="whitespace-nowrap">
        <Ago iso={order.createdAt} />
        {row.stale && (
          <Tooltip content={`Working ${fmtMinutes(row.ageMinutes)} without filling — past your ${row.thresholdMinutes}-minute stale threshold. Heuristic, not an error: the market has likely moved away from the limit price, so it may never fill. You can keep waiting, cancel, or replace the remainder at market.`}>
            <Chip tone="warn" className="ml-1.5">
              stale {fmtMinutes(row.ageMinutes)}
            </Chip>
          </Tooltip>
        )}
      </td>
      <td>
        <Tooltip content="The order's state as last reported by the broker.">
          <Chip tone={stateTone(order.state)}>{readableState(order.state)}</Chip>
        </Tooltip>
      </td>
      <td>
        <div className="flex justify-end gap-1.5 whitespace-nowrap">
          {showReplace && (
            <Tooltip content={replaceTitle}>
              <Btn size="sm" variant="outline" disabled={!replaceEnabled} onClick={onReplace}>
                Replace at market
              </Btn>
            </Tooltip>
          )}
          <Tooltip content="Ask the broker to cancel this order. Risk-reducing — allowed even while the system is stopped; fills that already happened stand.">
            <Btn size="sm" variant="dangerOutline" onClick={onCancel}>
              Cancel
            </Btn>
          </Tooltip>
        </div>
      </td>
    </tr>
  );
}
