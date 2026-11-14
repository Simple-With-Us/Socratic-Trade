"use client";

import { useId, useState } from "react";
import type { MarketQuote } from "@/lib/types";
import { Sheet } from "../ui/sheet";
import type { ScanColumn } from "./columns";

/** Keep the cell's own provenance and timestamp. Only add the scan receipt when
 * the column did not already record one. Shared with native hover descriptions. */
export function cellTitleWithReceived(column: ScanColumn, quote: MarketQuote, received: string): string | undefined {
  const own = column.cellTitle?.(quote);
  return [own, own?.includes("Received ") ? undefined : received].filter(Boolean).join("\n") || undefined;
}

/** One keyboard entry point for every scan value, including virtualized rows.
 * No extra cell tab stops, tooltip instances or closed overlay DOM. */
export function ScanValueDetails({ rows, columns, received }: {
  rows: MarketQuote[];
  columns: ScanColumn[];
  received: string;
}) {
  const valueColumns = columns.filter((column) => column.id !== "symbol");
  if (rows.length === 0 || valueColumns.length === 0) {
    return <button type="button" className="con-btn con-btn-secondary" aria-haspopup="dialog" aria-expanded={false} disabled>Value details</button>;
  }
  return <ValueDetailsControl rows={rows} columns={valueColumns} received={received} />;
}

function ValueDetailsControl({ rows, columns, received }: {
  rows: MarketQuote[];
  columns: ScanColumn[];
  received: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="con-btn con-btn-secondary"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        Value details
      </button>
      {open && (
        <ValueDetailsSheet rows={rows} columns={columns} received={received} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

function ValueDetailsSheet({ rows, columns, received, onClose }: {
  rows: MarketQuote[];
  columns: ScanColumn[];
  received: string;
  onClose: () => void;
}) {
  const [symbol, setSymbol] = useState(rows[0].symbol);
  const [columnId, setColumnId] = useState(columns[0].id);
  const symbolId = useId();
  const columnSelectId = useId();
  // A refreshed scan or column change can remove the selection. Always show a
  // real current row/column, never retained values from a previous scan.
  const quote = rows.find((row) => row.symbol === symbol) ?? rows[0];
  const column = columns.find((item) => item.id === columnId) ?? columns[0];
  return (
    <Sheet open onClose={onClose} title="Scan value details">
      <p className="mb-4 text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
        Choose a symbol and visible column to read its value, meaning and recorded source. This does not place a trade or change your watchlist.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <label htmlFor={symbolId} className="flex min-w-0 flex-col gap-1 text-[length:var(--con-fs-sm)]">
          Symbol
          <select id={symbolId} value={quote.symbol} onChange={(event) => setSymbol(event.target.value)} className="con-input w-full">
            {rows.map((row) => <option key={row.symbol} value={row.symbol}>{row.symbol}</option>)}
          </select>
        </label>
        <label htmlFor={columnSelectId} className="flex min-w-0 flex-col gap-1 text-[length:var(--con-fs-sm)]">
          Column
          <select id={columnSelectId} value={column.id} onChange={(event) => setColumnId(event.target.value)} className="con-input w-full">
            {columns.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </label>
      </div>
      <section aria-live="polite" aria-atomic="true" className="mt-4 space-y-3 text-[length:var(--con-fs-sm)]">
        <h3 className="font-semibold">{quote.symbol} · {column.label}</h3>
        <div className="text-[length:var(--con-fs-lg)]">{column.render(quote)}</div>
        <p className="whitespace-pre-line text-[color:var(--con-muted)]">{column.headerTitle}</p>
        <p className="whitespace-pre-line">{cellTitleWithReceived(column, quote, received) ?? "No source or received time was recorded for this value."}</p>
      </section>
    </Sheet>
  );
}
