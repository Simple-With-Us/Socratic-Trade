"use client";

import { useMemo } from "react";
import type { FillEvent } from "@/lib/types";
import { realityForMode } from "../lib/derive";
import { fmtMoney, fmtQty } from "../lib/format";
import { feedStatusLabel } from "../lib/labels";
import { Ago, Chip } from "../ui/primitives";
import { SymbolButton } from "../ui/symbol-drilldown";
import { DayGroups } from "./day-groups";
import { activityStatusTone } from "./status-tone";

const SIDE_LABEL: Record<string, string> = { buy: "BUY", sell: "SELL", short: "SHORT", cover: "COVER" };

function fillSentence(f: FillEvent): string {
  const qty = fmtQty(f.quantity);
  const price = fmtMoney(f.price);
  switch (f.side) {
    case "sell":
      return `Sold ${qty} shares at ${price}.`;
    case "short":
      return `Shorted ${qty} shares at ${price}.`;
    case "cover":
      return `Covered ${qty} shares at ${price}.`;
    default:
      return `Bought ${qty} shares at ${price}.`;
  }
}

export function OrderFillsList({ fills }: { fills: FillEvent[] }) {
  const sorted = useMemo(
    () => [...fills].sort((a, b) => new Date(b.filledAt).getTime() - new Date(a.filledAt).getTime()).slice(0, 100),
    [fills]
  );
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[length:var(--con-fs-sm)] leading-relaxed text-[color:var(--con-muted)]">
        Most recent executions.
      </p>
    <DayGroups
      items={sorted}
      timestamp={(f) => f.filledAt}
      emptyText="No order fills yet."
      renderItem={(f) => {
        const r = realityForMode(f.executionMode ?? (f.source === "live" ? "broker/live" : undefined));
        return (
          <div
            key={f.id}
            className="con-card flex flex-col gap-2 px-4 py-3 text-[length:var(--con-fs-sm)] sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-3 sm:gap-y-1"
          >
            <span className="font-bold">
              {SIDE_LABEL[f.side] ?? f.side} <SymbolButton symbol={f.symbol} />
            </span>
            <span className="con-num text-[color:var(--con-muted)]">
              {fmtQty(f.quantity)} @ {fmtMoney(f.price)} = {fmtMoney(f.notional)}
            </span>
            <Chip tone={r.tone} title={r.clarification}>
              {r.word}
            </Chip>
            {f.status !== "filled" && (
              <Chip
                tone={activityStatusTone(f.status)}
                title="Recorded intent awaiting broker-truth reconciliation — it cannot double-place."
              >
                {feedStatusLabel(f.status)}
              </Chip>
            )}
            <p className="w-full text-[length:var(--con-fs-xs)] leading-relaxed text-[color:var(--con-muted)] sm:w-auto sm:flex-1">
              {fillSentence(f)}
            </p>
            <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)] sm:ml-auto">
              <Ago iso={f.filledAt} />
            </span>
          </div>
        );
      }}
    />
    </div>
  );
}
