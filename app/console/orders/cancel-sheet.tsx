"use client";

/** Confirm sheet for cancelling a working order (POST /api/orders/cancel).
 *  Cancelling is risk-reducing: the server requires no typed confirmation even
 *  on brokerage accounts (mirroring the broker gateway's unguarded cancelEquityOrder),
 *  and it stays available while the system is Stopped. The sheet still states
 *  plainly what happens — fills that already happened stand. */

import { useState } from "react";
import type { RealityInfo } from "../lib/derive";
import { fmtQty } from "../lib/format";
import { useConsoleData } from "../lib/useConsoleData";
import { useToast } from "../ui/toast";
import { Btn, Chip } from "../ui/primitives";
import { Sheet } from "../ui/sheet";
import { SymbolButton } from "../ui/symbol-drilldown";
import { cancelOrder, OrdersApiError } from "./api";
import { orderTypeLabel, readableState, type OpenOrderRow } from "./lib";

const SIDE_LABEL: Record<string, string> = { buy: "BUY", sell: "SELL", short: "SHORT", cover: "COVER" };

export function CancelOrderSheet({
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
  const { refresh } = useConsoleData();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [dustWarning, setDustWarning] = useState<string | null>(null);

  const order = row.order;
  const live = reality.tone === "live";
  const sideWord = SIDE_LABEL[order.side] ?? String(order.side).toUpperCase();
  const filled = order.filledQuantity ?? 0;

  const close = () => {
    setDustWarning(null);
    onClose();
  };

  const submit = async () => {
    setBusy(true);
    try {
      const result = await cancelOrder(order.id);
      await refresh();
      toast.push(
        "pos",
        `Cancel request sent for ${order.symbol}`,
        result.state
          ? `Broker state: ${readableState(result.state)}.  The broker confirms the cancellation on its side.`
          : "The broker confirms the cancellation on its side."
      );
      if (result.dustWarning) {
        // ADVISORY ONLY — the cancel above already went through either way. Keep the sheet open
        // so the owner actually sees this rather than closing straight into a toast they can miss.
        setDustWarning(result.dustWarning);
      } else {
        close();
      }
    } catch (error) {
      toast.push("neg", "Cancel failed", error instanceof OrdersApiError ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={close} title="Cancel working order" tone={live ? "live" : undefined}>
      <div className="flex flex-wrap items-center gap-2 text-[length:var(--con-fs-md)] font-bold">
        {sideWord} <SymbolButton symbol={order.symbol} className="text-inherit" />
        <span className="text-[length:var(--con-fs-sm)] font-normal text-[color:var(--con-muted)]">
          {orderTypeLabel(order.type)} · {readableState(order.state)}
        </span>
        <Chip tone={reality.tone} title={reality.clarification}>
          {reality.word} · {reality.phrase}
        </Chip>
      </div>

      <p className="mt-3 text-[length:var(--con-fs-sm)] leading-relaxed text-[color:var(--con-muted)]">
        This asks the broker to cancel the order. No new order is placed — the {fmtQty(row.remaining)} unfilled shares
        simply stop working.
        {filled > 0
          ? ` The ${fmtQty(filled)} shares that already filled stand; cancelling never undoes a fill.`
          : ""}
        {live ? " Cancelling is risk-reducing — it prevents an execution rather than causing one." : ""}
      </p>
      <p className="mt-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
        Cancellation is not instant: the broker may report Pending Cancel briefly, and an order can still fill in the
        moment before the cancel lands.
      </p>

      {dustWarning && (
        <p className="mt-3 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">{dustWarning}</p>
      )}

      <div className="mt-4 flex justify-end gap-2">
        {dustWarning ? (
          <Btn variant="ghost" onClick={close} title="Close this sheet.">
            Done
          </Btn>
        ) : (
          <>
            <Btn variant="ghost" onClick={close} disabled={busy} title="Close and leave the order working.">
              Keep it working
            </Btn>
            <Btn
              variant="danger"
              disabled={busy}
              onClick={() => void submit()}
              title="Send the cancel request to the broker now."
            >
              {busy ? "Cancelling…" : "Cancel this order"}
            </Btn>
          </>
        )}
      </div>
    </Sheet>
  );
}
