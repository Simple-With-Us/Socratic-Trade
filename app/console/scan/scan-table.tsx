"use client";

/** Sortable Market Scan table. Row hover/focus highlight comes free from
 *  `.con-table`; the symbol column is sticky so the table can scroll
 *  horizontally on small screens without losing the identity column (the
 *  sticky cell repaints the row-hover wash itself via group-hover, since its
 *  opaque background sits above the row's). Every header and cell carries a
 *  tooltip; cell tooltips get the scan-level "Received …" stamp when the
 *  field's own tooltip doesn't already carry one. */

import { useMemo, useState } from "react";
import type { MarketScan } from "@/lib/types";
import { receivedLabel } from "@/lib/dashboard-ui";
import { cx } from "../lib/format";
import { InfoTip, TooltipText } from "../ui/primitives";
import { SCAN_COLUMNS } from "./columns";

type SortDir = "asc" | "desc";

/** Missing values (undefined/null/NaN) sort last in BOTH directions so the
 *  interesting rows stay on top whichever way the user flips a column. */
function compareValues(a: unknown, b: unknown, dir: SortDir): number {
  const aMissing = a === undefined || a === null || (typeof a === "number" && !Number.isFinite(a));
  const bMissing = b === undefined || b === null || (typeof b === "number" && !Number.isFinite(b));
  if (aMissing && bMissing) return 0;
  if (aMissing) return 1;
  if (bMissing) return -1;
  const base = typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b));
  return dir === "asc" ? base : -base;
}

// The sticky symbol cell needs its own opaque background (the row's hover wash
// is painted on the <tr>, underneath it). group-hover/focus-within re-derive
// the same 6% fg wash composited onto the surface so hover looks identical
// across the whole row in both themes.
const STICKY_CELL = "sticky left-0 z-[1] bg-[color:var(--con-surface)]";
const STICKY_CELL_HOVER =
  "group-hover:bg-[color:color-mix(in_oklab,var(--con-fg)_6%,var(--con-surface))] group-focus-within:bg-[color:color-mix(in_oklab,var(--con-fg)_6%,var(--con-surface))]";

export function ScanTable({ scan }: { scan: MarketScan }) {
  const [sort, setSort] = useState<{ col: string; dir: SortDir }>({ col: "score", dir: "desc" });

  const rows = useMemo(() => {
    // Shape defense (not data hiding): a candidate without a symbol can't be
    // keyed or drilled into — old/compact run captures may carry such rows.
    const candidates = scan.topCandidates.filter((q) => typeof q?.symbol === "string" && q.symbol.length > 0);
    const col = SCAN_COLUMNS.find((c) => c.id === sort.col);
    if (!col) return candidates;
    return [...candidates].sort((a, b) => compareValues(col.sortValue(a), col.sortValue(b), sort.dir));
  }, [scan, sort]);

  // The quote-level `asOf` can be a display sentence rather than a timestamp;
  // the scan's ISO generatedAt is the authoritative "received" time here.
  const received = receivedLabel(scan.generatedAt);

  return (
    <div className="overflow-x-auto">
      <table className="con-table w-full min-w-max">
        <thead>
          <tr>
            {SCAN_COLUMNS.map((c, i) => {
              const active = sort.col === c.id;
              return (
                <th
                  key={c.id}
                  scope="col"
                  aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
                  className={cx(c.num && "num", i === 0 && STICKY_CELL)}
                >
                  <span className="inline-flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() =>
                        setSort((s) => ({ col: c.id, dir: s.col === c.id && s.dir === "desc" ? "asc" : "desc" }))
                      }
                      className={cx(
                        "inline-flex cursor-pointer select-none items-center gap-1 font-semibold uppercase tracking-[0.07em] transition-colors",
                        active ? "text-[color:var(--con-fg)]" : "hover:text-[color:var(--con-fg)]"
                      )}
                    >
                      {c.label}
                      <span aria-hidden className={cx("text-[9px]", !active && "opacity-0")}>
                        {active && sort.dir === "asc" ? "▲" : "▼"}
                      </span>
                    </button>
                    <InfoTip
                      label={c.label}
                      content={`${c.headerTitle}\nClick to sort by ${c.label.toLowerCase()}${active ? ` (currently ${sort.dir === "asc" ? "ascending" : "descending"})` : ""}.`}
                    />
                  </span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((q) => (
            <tr key={q.symbol} className="group">
              {SCAN_COLUMNS.map((c, i) => {
                const own = c.cellTitle?.(q);
                // Stamp the scan-level "Received …" only when the cell's own
                // tooltip doesn't already carry a received line — no duplicates.
                const title =
                  [own, own?.includes("Received ") ? undefined : received].filter(Boolean).join("\n") || undefined;
                return (
                  <td key={c.id} className={cx("whitespace-nowrap", c.num && "num con-num", i === 0 && cx(STICKY_CELL, STICKY_CELL_HOVER))}>
                    {i === 0 ? c.render(q) : <TooltipText content={title} block className="cursor-default whitespace-nowrap">{c.render(q)}</TooltipText>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
