"use client";

/** Confirm sheet for replace-at-market: restates exactly what the server will
 *  do (cancel the working limit order → re-check the broker → submit only the
 *  remaining quantity as a market order, good-for-day, regular hours). On LIVE
 *  money it runs the server's typed-confirmation ritual — same tone and
 *  mechanics as the approval card's LiveApproveSheet: the server is the
 *  authority, its 409 reasons and expectedText render verbatim. */

import { useMemo, useState } from "react";
import { shortOrderLabel } from "@/lib/order-labels";
import type { RealityInfo } from "../lib/derive";
import { fmtQty } from "../lib/format";
import { useConsoleData } from "../lib/useConsoleData";
import { useToast } from "../ui/toast";
import { Btn, LiveTag, TextInput } from "../ui/primitives";
import { Sheet } from "../ui/sheet";
import { SymbolButton } from "../ui/symbol-drilldown";
import {
  OrdersApiError,
  ReplaceLiveConfirmationRequiredError,
  replaceOrderAtMarket
} from "./api";
import { fmtMinutes, marketReplaceText, orderTypeLabel, readableState, type OpenOrderRow } from "./lib";

const SIDE_LABEL: Record<string, string> = { buy: "BUY", sell: "SELL", short: "SHORT", cover: "COVER" };

function Fact({ label, value, title }: { label: string; value: React.ReactNode; title?: string }) {
  return (
    <div className="cursor-default" title={title}>
      <div className="con-card-title">{label}</div>
      <div className="mt-0.5 text-[color:var(--con-fg)]">{value}</div>
    </div>
  );
}

export function ReplaceMarketSheet({
  row,
  reality,
  open,
  onClose
}: {
  row: OpenOrderRow;
  reality: RealityInfo;
  open: boolean;
  onClose: () => void;
}) {
  const { snapshot, refresh } = useConsoleData();
  const toast = useToast();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [serverReasons, setServerReasons] = useState<string[]>([]);
  const [serverExpected, setServerExpected] = useState<string | null>(null);

  const order = row.order;
  const live = reality.tone === "live";
  // Owner preference: with typed confirmation off, a live replace is one-click (the server honors the
  // same flag via assertMarketReplaceConfirmation).
  const needsTyped = live && snapshot?.policy.requireTypedConfirmation !== false;
  const sideWord = SIDE_LABEL[order.side] ?? String(order.side).toUpperCase();
  const kind = orderTypeLabel(order.type);
  const remaining = fmtQty(row.remaining);
  const alreadyFilled = (order.filledQuantity ?? 0) > 0;

  const expectedText = useMemo(
    () => serverExpected ?? marketReplaceText(order.symbol),
    [serverExpected, order.symbol]
  );
  const matches = typed.trim().toUpperCase() === expectedText;

  const submit = async () => {
    setBusy(true);
    try {
      const result = await replaceOrderAtMarket(
        order.id,
        live
          ? {
              orderId: order.id,
              accountNumber: snapshot?.policy.accountNumber ?? null,
              executionMode: "broker/live",
              remainingQuantity: row.remaining,
              typedText: typed.trim().toUpperCase()
            }
          : undefined
      );
      await refresh();
      onClose();
      setTyped("");
      setServerReasons([]);
      if (result.status === "already_filled") {
        toast.push(
          "info",
          `${order.symbol} was already filled`,
          "Nothing remained after the cancel check, so no market replacement was placed."
        );
      } else {
        toast.push(
          "pos",
          `Market replacement submitted for ${order.symbol}`,
          [
            result.replacementOrderId ? `Order ${shortOrderLabel(result.replacementOrderId)}.` : undefined,
            result.brokerState ? `Broker state: ${readableState(result.brokerState)}.` : undefined
          ]
            .filter(Boolean)
            .join(" ") || undefined
        );
      }
    } catch (error) {
      if (error instanceof ReplaceLiveConfirmationRequiredError) {
        // The server is the authority: show its reasons and its expected text.
        setServerReasons(error.reasons);
        setServerExpected(error.expectedText);
        setTyped("");
      } else {
        // Sheet stays open so the facts remain visible; the toast carries the
        // server's message (e.g. "not an active stale limit order — refresh").
        toast.push(
          "neg",
          "Market replacement failed",
          error instanceof OrdersApiError ? error.message : String(error)
        );
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="Replace stale limit order" tone={live ? "live" : undefined}>
      <div className="grid grid-cols-2 gap-3 rounded-control border border-[color:var(--con-line)] p-3 text-[length:var(--con-fs-sm)]">
        <Fact
          label="Order"
          value={
            <>
              {sideWord} <SymbolButton symbol={order.symbol} className="text-inherit" /> {kind}
            </>
          }
          title="The working order that would be cancelled."
        />
        <Fact
          label="Broker state"
          value={readableState(order.state)}
          title="The order's current state as last reported by the broker."
        />
        <Fact
          label="Remaining"
          value={`${remaining} sh`}
          title="The unfilled share quantity — exactly what the market replacement would submit."
        />
        <Fact
          label="Working for"
          value={`${fmtMinutes(row.ageMinutes)} (stale after ${row.thresholdMinutes}m)`}
          title="How long the order has been working, against your policy's stale-limit threshold."
        />
      </div>

      <p className="mt-3 text-[length:var(--con-fs-sm)] leading-relaxed text-[color:var(--con-muted)]">
        This cancels the working {kind} order at the broker, waits for the cancellation to settle, then submits{" "}
        <strong className="text-[color:var(--con-fg)]">only the remaining {remaining} shares</strong> as a{" "}
        <strong className="text-[color:var(--con-fg)]">market order</strong> (good for the day, regular hours).  A market
        order fills at whatever price the market gives — there is no price cap.  If everything fills during the cancel,
        nothing new is placed.
      </p>
      {alreadyFilled && (
        <p className="mt-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
          {fmtQty(order.filledQuantity)} of {fmtQty(order.quantity)} shares already filled — those fills stand either
          way.
        </p>
      )}

      {live ? (
        <>
          <div className="mt-3 rounded-control border border-[color:var(--con-line)] bg-[color:var(--con-surface-2)] p-3 text-[length:var(--con-fs-sm)]">
            <div className="font-bold">Brokerage account</div>
            <p className="con-num mt-1">
              The replacement {sideWord} of {remaining} {order.symbol} goes to the broker at the current market price
              {snapshot?.policy.accountNumber ? ` from account ·· ${snapshot.policy.accountNumber.slice(-4)}` : ""}.
            </p>
            <p className="mt-1 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
              The server re-checks the order at this moment — it must still be a working, stale limit order with an
              unfilled remainder.  If not, nothing is cancelled and nothing is placed.
            </p>
          </div>

          {serverReasons.length > 0 && (
            <div className="mt-3 rounded-control border border-[color:var(--con-warn-border)] p-3 text-[length:var(--con-fs-xs)]">
              <div className="font-semibold text-[color:var(--con-warn)]">The server refused the confirmation:</div>
              <ul className="mt-1 list-disc pl-4 text-[color:var(--con-muted)]">
                {serverReasons.map((reason, i) => (
                  <li key={i}>{reason}</li>
                ))}
              </ul>
            </div>
          )}

          {needsTyped && (
            <div className="mt-3">
              <label className="con-label" htmlFor={`replace-typed-${order.id}`}>
                Type exactly: <span className="con-mono text-[color:var(--con-fg)]">{expectedText}</span>
              </label>
              <TextInput
                id={`replace-typed-${order.id}`}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="characters"
                spellCheck={false}
                onPaste={(e) => e.preventDefault()}
                placeholder={expectedText}
                className="con-mono"
              />
              <p className="mt-1 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                Paste is disabled on purpose — the words are the consent.
              </p>
            </div>
          )}
        </>
      ) : (
        <p className="mt-3 rounded-control border border-[color:var(--con-line)] p-3 text-[length:var(--con-fs-xs)] leading-relaxed text-[color:var(--con-muted)]">
          {reality.word} · {reality.phrase} — no real dollars move. The replacement uses the broker&apos;s paper
          execution and stays Working until the broker reports a fill.
        </p>
      )}

      <div className="mt-4 flex justify-end gap-2">
        <Btn variant="ghost" onClick={onClose} disabled={busy} title="Close without changing the order.">
          Keep the limit order
        </Btn>
        <Btn
          variant="primary"
          disabled={busy || (needsTyped && !matches)}
          onClick={() => void submit()}
          title={
            needsTyped && !matches
              ? "Type the confirmation phrase first."
              : "Cancel the limit order and submit the remainder as a market order."
          }
        >
          {busy ? "Replacing…" : live ? (
            <>
              Replace at market <LiveTag />
            </>
          ) : (
            "Replace at market"
          )}
        </Btn>
      </div>
    </Sheet>
  );
}
